#!/usr/bin/env node
'use strict';

/*
 * sidewrite process-manager
 *
 * Subcommands:
 *   ensure-started  - health-check the viewer daemon; if unreachable, spawn it
 *                     detached with `node --experimental-sqlite viewer-daemon.cjs`
 *                     and poll /api/health for up to ~5s.
 *   status          - print the daemon health snapshot (or "not running").
 *   stop            - read pid from daemon.json and process.kill it.
 *
 * Reads ~/.sidewrite/daemon.json for port + bearer token.
 * CommonJS, node: builtins only, no external deps.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const { spawn } = require('child_process');

const HOME = process.env.HOME || os.homedir();
const DATA_DIR = path.join(HOME, '.sidewrite');
const DAEMON_JSON = path.join(DATA_DIR, 'daemon.json');
const STATUS_JSON = path.join(DATA_DIR, 'status.json');
const DAEMON_PATH = path.join(__dirname, 'viewer-daemon.cjs');
const DAEMON_LOG = path.join(DATA_DIR, 'daemon.log');
const DAEMON_LOG_MAX_BYTES = 5 * 1024 * 1024; // rotate once past ~5MB
const DEFAULT_PORT = parseInt(process.env.SIDEWRITE_VIEWER_PORT || '1510', 10);

// The daemon already fails soft on uncaughtException/unhandledRejection (logs
// to stderr, keeps running — see viewer-daemon.cjs) instead of crashing on a
// single bad code path. But every one of those log lines, and any genuinely
// fatal exit's stack trace, was going straight to /dev/null because this
// spawn used `stdio: 'ignore'` — so a dashboard that started "reconnecting…"
// for real (not just a network blip) left no evidence of why. Open a real fd
// so future crashes/errors are actually diagnosable instead of silent.
function openDaemonLogFd() {
  try {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    try {
      if (fs.statSync(DAEMON_LOG).size > DAEMON_LOG_MAX_BYTES) {
        fs.renameSync(DAEMON_LOG, DAEMON_LOG + '.old');
      }
    } catch (_) { /* no existing log yet */ }
    return fs.openSync(DAEMON_LOG, 'a', 0o600);
  } catch (_) {
    return 'ignore'; // fail-soft: never block startup over a logging path
  }
}

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

function readDaemonInfo() {
  try {
    const raw = fs.readFileSync(DAEMON_JSON, 'utf8');
    const obj = JSON.parse(raw);
    if (obj && typeof obj.port === 'number') return obj;
  } catch (_) {
    /* missing or malformed -> null */
  }
  return null;
}

/**
 * GET /api/health against the given port/token.
 * Resolves with the parsed JSON body on 200, or null on any failure.
 */
function healthCheck(port, token, timeoutMs) {
  return new Promise((resolve) => {
    const headers = { Host: '127.0.0.1:' + port };
    if (token) headers.Authorization = 'Bearer ' + token;

    const req = http.request(
      {
        host: '127.0.0.1',
        port: port,
        path: '/api/health',
        method: 'GET',
        headers: headers,
      },
      (res) => {
        let body = '';
        res.setEncoding('utf8');
        res.on('data', (c) => {
          body += c;
          if (body.length > 1024 * 1024) req.destroy();
        });
        res.on('end', () => {
          if (res.statusCode !== 200) return resolve(null);
          try {
            resolve(JSON.parse(body));
          } catch (_) {
            resolve(null);
          }
        });
      }
    );

    req.on('error', () => resolve(null));
    req.setTimeout(timeoutMs || 1500, () => {
      req.destroy();
      resolve(null);
    });
    req.end();
  });
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

/**
 * Read ~/.sidewrite/status.json (the daemon's health mirror) if it is FRESH:
 * `now - heartbeat_ts <= ttl_seconds * 1000`. Returns the parsed snapshot, or
 * null when missing / malformed / stale. Zero HTTP, zero extra node spawn.
 */
function readFreshStatus() {
  try {
    const raw = fs.readFileSync(STATUS_JSON, 'utf8');
    const s = JSON.parse(raw);
    if (!s || typeof s !== 'object') return null;
    const hb = Number(s.heartbeat_ts);
    const ttl = Number(s.ttl_seconds);
    if (!Number.isFinite(hb) || !Number.isFinite(ttl)) return null;
    if (Date.now() - hb > ttl * 1000) return null; // stale
    return s;
  } catch (_) {
    return null;
  }
}

function printStatusSnapshot(h, pid) {
  process.stdout.write(
    'sidewrite viewer: running\n' +
      '  url:      http://127.0.0.1:' + h.port + '\n' +
      '  version:  ' + (h.version || 'unknown') + '\n' +
      '  pid:      ' + (pid != null ? pid : 'unknown') + '\n' +
      '  uptime:   ' + (h.uptime != null ? h.uptime + 's' : 'unknown') + '\n' +
      '  stage:    ' + (h.pipeline && h.pipeline.stage ? h.pipeline.stage : 'idle') + '\n' +
      '  active:   ' +
      (h.active
        ? (h.active.provider || '?') + '/' + (h.active.model || '?')
        : 'none') +
      '\n'
  );
}

function requireSqliteOrExplain() {
  // We do NOT require node:sqlite here (the daemon needs the flag, not us),
  // but we surface a clear hint if the launched node lacks it. This check runs
  // the current process which was NOT started with the flag, so we only test
  // that the module name resolves; the real gating happens in the daemon.
  try {
    // eslint-disable-next-line global-require
    require('node:sqlite');
    return true;
  } catch (_) {
    return false;
  }
}

// ---------------------------------------------------------------------------
// subcommands
// ---------------------------------------------------------------------------

async function cmdEnsureStarted() {
  let info = readDaemonInfo();

  // 1. If daemon.json exists, try a health check first.
  if (info) {
    const h = await healthCheck(info.port, info.token, 1500);
    if (h) {
      process.stdout.write(
        'sidewrite viewer already running on http://127.0.0.1:' + info.port + '\n'
      );
      return 0;
    }
  }

  // 2. Not reachable -> spawn the daemon detached with the sqlite flag.
  if (!fs.existsSync(DAEMON_PATH)) {
    process.stderr.write(
      'sidewrite: cannot start viewer daemon; not found at ' + DAEMON_PATH + '\n'
    );
    return 1;
  }

  const logFd = openDaemonLogFd();
  const child = spawn(
    process.execPath,
    ['--experimental-sqlite', DAEMON_PATH],
    {
      detached: true,
      stdio: ['ignore', logFd, logFd],
      env: process.env,
    }
  );
  if (typeof logFd === 'number') {
    try { fs.closeSync(logFd); } catch (_) {} // the child has its own fd table entry now
  }
  child.on('error', (err) => {
    process.stderr.write('sidewrite: failed to spawn viewer daemon: ' + err.message + '\n');
  });
  child.unref();

  // 3. Poll health for ~5s. The daemon writes daemon.json at boot, so re-read
  //    it on each attempt in case the port changed (EADDRINUSE increment).
  //    Check immediately after spawn, then ramp the backoff (cap 250ms) so a
  //    fast-booting daemon is detected sooner without changing the deadline.
  const deadline = Date.now() + 5000;
  const backoff = [25, 25, 50, 50, 100, 150, 250];
  let attempt = 0;
  while (Date.now() < deadline) {
    info = readDaemonInfo() || info;
    if (info) {
      const h = await healthCheck(info.port, info.token, 1000);
      if (h) {
        process.stdout.write(
          'sidewrite viewer started on http://127.0.0.1:' + info.port + '\n'
        );
        return 0;
      }
    }
    await sleep(backoff[Math.min(attempt, backoff.length - 1)]);
    attempt++;
  }

  // Give one final diagnostic. If node:sqlite is unavailable in the runtime,
  // the daemon likely aborted immediately.
  if (!requireSqliteOrExplain()) {
    process.stderr.write(
      'sidewrite: viewer daemon did not become healthy. node:sqlite is EXPERIMENTAL on\n' +
        'Node 22.x and requires the --experimental-sqlite flag. Use Node >=22.5 and ensure\n' +
        'the daemon is launched as: node --experimental-sqlite ' + DAEMON_PATH + '\n'
    );
  } else {
    process.stderr.write(
      'sidewrite: viewer daemon did not become healthy within 5s. Check ' +
        path.join(DATA_DIR, 'RUN_LOG') + '\n'
    );
  }
  return 1;
}

async function cmdStatus() {
  // Fast path: a fresh status.json means the daemon is up — print from it with
  // zero HTTP and zero extra node spawn.
  const info = readDaemonInfo();
  const fresh = readFreshStatus();
  if (fresh) {
    printStatusSnapshot(fresh, info && info.pid);
    return 0;
  }

  // Fall back to HTTP /api/health when the mirror is missing or stale.
  if (!info) {
    process.stdout.write('sidewrite viewer: not running (no daemon.json)\n');
    return 3;
  }
  const h = await healthCheck(info.port, info.token, 1500);
  if (!h) {
    process.stdout.write(
      'sidewrite viewer: not running (daemon.json present, port ' +
        info.port +
        ' unreachable)\n'
    );
    return 3;
  }
  printStatusSnapshot(h, info.pid);
  return 0;
}

async function cmdStop() {
  const info = readDaemonInfo();
  if (!info || info.pid == null) {
    process.stdout.write('sidewrite viewer: not running (no pid in daemon.json)\n');
    return 0;
  }
  const pid = info.pid;
  try {
    process.kill(pid, 'SIGTERM');
  } catch (err) {
    if (err && err.code === 'ESRCH') {
      process.stdout.write('sidewrite viewer: process ' + pid + ' already gone\n');
      return 0;
    }
    process.stderr.write('sidewrite: failed to stop pid ' + pid + ': ' + err.message + '\n');
    return 1;
  }

  // Wait briefly for it to actually exit; escalate to SIGKILL if needed.
  const deadline = Date.now() + 3000;
  while (Date.now() < deadline) {
    await sleep(150);
    try {
      process.kill(pid, 0); // probe
    } catch (_) {
      process.stdout.write('sidewrite viewer: stopped (pid ' + pid + ')\n');
      return 0;
    }
  }
  try {
    process.kill(pid, 'SIGKILL');
  } catch (_) {
    /* ignore */
  }
  process.stdout.write('sidewrite viewer: force-killed (pid ' + pid + ')\n');
  return 0;
}

// ---------------------------------------------------------------------------
// entry
// ---------------------------------------------------------------------------

async function main() {
  const cmd = process.argv[2];
  let code;
  switch (cmd) {
    case 'ensure-started':
      code = await cmdEnsureStarted();
      break;
    case 'status':
      code = await cmdStatus();
      break;
    case 'stop':
      code = await cmdStop();
      break;
    default:
      process.stderr.write(
        'usage: process-manager.cjs <ensure-started|status|stop>\n'
      );
      code = 2;
  }
  process.exit(code);
}

main().catch((err) => {
  // Never let an unexpected throw escape uglily; this manager may run from a hook.
  process.stderr.write('sidewrite process-manager error: ' + (err && err.message) + '\n');
  process.exit(1);
});
