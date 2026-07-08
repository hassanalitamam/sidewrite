#!/usr/bin/env node
'use strict';

/*
 * sidewrite hook-client
 *
 * A tiny, best-effort client invoked from Claude Code hooks and slash commands.
 * It MUST NEVER block or fail a hook: every path swallows errors, uses short
 * timeouts, and exits 0 whenever practical.
 *
 * Subcommands:
 *   print-status       - GET /api/health; print viewer URL + current stage.
 *   status-fast        - status.json fast path, falls back to in-process
 *                         HTTP GET /api/health. A single node invocation
 *                         (no shell `||`/`$()`/curl) so slash commands only
 *                         need the Bash(node:*) permission pattern.
 *   flush-idempotent   - safe no-op POST (SessionEnd); tolerates a dead daemon.
 *   event <json>       - POST an arbitrary event JSON (from argv) to /event.
 *
 * Reads ~/.sidewrite/daemon.json for port + bearer token.
 * CommonJS, node: builtins only, no external deps.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');

const HOME = process.env.HOME || os.homedir();
const DATA_DIR = path.join(HOME, '.sidewrite');
const DAEMON_JSON = path.join(DATA_DIR, 'daemon.json');
const STATUS_JSON = path.join(DATA_DIR, 'status.json');

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

function readDaemonInfo() {
  try {
    const raw = fs.readFileSync(DAEMON_JSON, 'utf8');
    const obj = JSON.parse(raw);
    if (obj && typeof obj.port === 'number') return obj;
  } catch (_) {
    /* missing or malformed */
  }
  return null;
}

/**
 * Minimal HTTP request helper. Resolves { status, body } or null on any error.
 * Always Host-guarded to 127.0.0.1:<port> and sends the bearer token.
 */
function request(info, method, routePath, jsonBody, timeoutMs) {
  return new Promise((resolve) => {
    let payload = null;
    const headers = { Host: '127.0.0.1:' + info.port };
    if (info.token) headers.Authorization = 'Bearer ' + info.token;

    if (jsonBody !== undefined && jsonBody !== null) {
      payload = Buffer.from(JSON.stringify(jsonBody), 'utf8');
      headers['Content-Type'] = 'application/json';
      headers['Content-Length'] = payload.length;
    }

    const req = http.request(
      {
        host: '127.0.0.1',
        port: info.port,
        path: routePath,
        method: method,
        headers: headers,
      },
      (res) => {
        let body = '';
        res.setEncoding('utf8');
        res.on('data', (c) => {
          body += c;
          if (body.length > 1024 * 1024) req.destroy();
        });
        res.on('end', () => resolve({ status: res.statusCode, body: body }));
      }
    );

    req.on('error', () => resolve(null));
    req.setTimeout(timeoutMs || 1500, () => {
      req.destroy();
      resolve(null);
    });

    if (payload) req.write(payload);
    req.end();
  });
}

function parseJsonSafe(str) {
  try {
    return JSON.parse(str);
  } catch (_) {
    return null;
  }
}

// ---------------------------------------------------------------------------
// subcommands
// ---------------------------------------------------------------------------

async function cmdPrintStatus() {
  const info = readDaemonInfo();
  if (!info) {
    process.stdout.write('sidewrite viewer: not running (start it with the sidewrite-viewer command)\n');
    return 0;
  }
  const res = await request(info, 'GET', '/api/health', null, 1500);
  if (!res || res.status !== 200) {
    process.stdout.write(
      'sidewrite viewer: not reachable on http://127.0.0.1:' + info.port + '\n'
    );
    return 0;
  }
  const h = parseJsonSafe(res.body) || {};
  const url = 'http://127.0.0.1:' + (h.port || info.port);
  const stage = h.pipeline && h.pipeline.stage ? h.pipeline.stage : 'idle';
  const activeProvider =
    (h.pipeline && h.pipeline.activeProvider) ||
    (h.active && h.active.provider) ||
    'none';
  process.stdout.write(
    'sidewrite viewer: ' + url + '\n' +
      '  stage:    ' + stage + '\n' +
      '  provider: ' + activeProvider + '\n' +
      '  version:  ' + (h.version || 'unknown') + '\n'
  );
  return 0;
}

function readStatusFile() {
  try {
    return JSON.parse(fs.readFileSync(STATUS_JSON, 'utf8'));
  } catch (_) {
    return null;
  }
}

function formatSnapshot(s, port) {
  const a = s.active || {};
  return (
    'sidewrite viewer: running\n' +
    '  url:     http://127.0.0.1:' + (s.port || port) + '\n' +
    '  version: ' + (s.version || 'unknown') + '\n' +
    '  mode:    ' + (s.mode || 'unknown') + '\n' +
    '  stage:   ' + ((s.pipeline && s.pipeline.stage) || 'idle') + '\n' +
    '  active:  ' + ((a.provider || '?') + '/' + (a.model || '?')) + '\n'
  );
}

async function cmdStatusFast() {
  const fileSnap = readStatusFile();
  if (fileSnap) {
    const hb = Number(fileSnap.heartbeat_ts);
    const ttl = Number(fileSnap.ttl_seconds);
    if (isFinite(hb) && isFinite(ttl) && Date.now() - hb <= ttl * 1000) {
      process.stdout.write(formatSnapshot(fileSnap));
      return 0;
    }
  }
  const info = readDaemonInfo();
  if (!info) {
    process.stdout.write('sidewrite viewer: not running\n');
    return 0;
  }
  const res = await request(info, 'GET', '/api/health', null, 2000);
  const h = res && res.status === 200 ? parseJsonSafe(res.body) : null;
  if (!h) {
    process.stdout.write(
      'sidewrite viewer: not reachable on http://127.0.0.1:' + info.port + '\n'
    );
    return 0;
  }
  process.stdout.write(formatSnapshot(h, info.port));
  return 0;
}

async function cmdFlushIdempotent() {
  const info = readDaemonInfo();
  if (!info) {
    // No daemon; nothing to flush. Silent success so SessionEnd never fails.
    return 0;
  }
  // Best-effort: POST a benign log_line marking session end. A dead daemon
  // simply yields null and we still exit 0.
  const event = {
    type: 'log_line',
    text: 'session-end flush',
    ts: Date.now(),
  };
  await request(info, 'POST', '/event', event, 1500);
  return 0;
}

async function cmdEvent(argv) {
  const info = readDaemonInfo();
  if (!info) {
    // No daemon -> silently drop; hooks must not be blocked.
    return 0;
  }

  // Accept the event JSON either as a single argv token or joined tokens.
  const raw = argv.join(' ').trim();
  if (!raw) {
    process.stderr.write('hook-client event: missing JSON argument\n');
    return 0; // do not block the hook
  }
  const obj = parseJsonSafe(raw);
  if (!obj || typeof obj !== 'object') {
    process.stderr.write('hook-client event: invalid JSON argument\n');
    return 0;
  }
  if (!obj.ts) obj.ts = Date.now();
  if (!obj.type) obj.type = 'log_line';

  await request(info, 'POST', '/event', obj, 1500);
  return 0;
}

// ---------------------------------------------------------------------------
// entry
// ---------------------------------------------------------------------------

async function main() {
  const cmd = process.argv[2];
  const rest = process.argv.slice(3);
  let code = 0;
  switch (cmd) {
    case 'print-status':
      code = await cmdPrintStatus();
      break;
    case 'status-fast':
      code = await cmdStatusFast();
      break;
    case 'flush-idempotent':
      code = await cmdFlushIdempotent();
      break;
    case 'event':
      code = await cmdEvent(rest);
      break;
    default:
      process.stderr.write(
        'usage: hook-client.cjs <print-status|flush-idempotent|event <json>>\n'
      );
      // Unknown subcommand from a hook context should still not hard-fail.
      code = 0;
  }
  process.exit(code);
}

main().catch(() => {
  // Absolute last resort: never block a hook, never emit a stack trace.
  process.exit(0);
});
