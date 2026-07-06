#!/usr/bin/env node
'use strict';

/*
 * sidewrite management CLI
 *
 * One place for the "life-cycle" verbs that are NOT the run pipeline:
 *
 *   install    - register sidewrite as a global Claude Code plugin (drives the
 *                official `claude plugin marketplace add` + `claude plugin
 *                install …@… --scope user`), symlink bin/ onto PATH, start the
 *                daemon, and open the dashboard.
 *   uninstall  - reverse install (plugin uninstall + marketplace remove +
 *                remove the PATH symlinks). Leaves ~/.sidewrite data intact.
 *   open       - ensure the daemon is up, then open the dashboard in a browser.
 *   up         - ensure the daemon is up (no browser).
 *   stop       - stop the daemon.
 *   status     - print the daemon status snapshot.
 *   url        - print the dashboard URL (nothing else).
 *   doctor     - environment diagnostics (node, claude, PATH, plugin, daemon).
 *   setup      - verify + provision (~/.sidewrite, config scaffold, 0600 providers,
 *                version-stamped sentinel). Never edits PATH/profile/~/.claude
 *                unless --write-profile.
 *   undo       - revert a run's live-mirrored file edits from its .touched manifest.
 *
 * CommonJS, node: builtins only, no external deps.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const https = require('https');
const crypto = require('node:crypto');
const { spawnSync } = require('child_process');

const HOME = process.env.HOME || os.homedir();
const DATA_DIR = path.join(HOME, '.sidewrite');
const DAEMON_JSON = path.join(DATA_DIR, 'daemon.json');
const PROVIDERS_DIR = path.join(HOME, '.claude-providers');
const RUNS_DIR = path.join(DATA_DIR, 'runs');

// Resolve our own locations from this file: .../plugin/scripts/cli.cjs
const SCRIPTS_DIR = __dirname;                             // .../plugin/scripts
const PLUGIN_DIR = path.resolve(SCRIPTS_DIR, '..');        // .../plugin  (marketplace root)
const ROOT_DIR = path.resolve(PLUGIN_DIR, '..');           // repo root
const BIN_DIR = path.join(ROOT_DIR, 'bin');
const PM_PATH = path.join(SCRIPTS_DIR, 'process-manager.cjs');
const PLUGIN_MANIFEST = path.join(PLUGIN_DIR, '.claude-plugin', 'plugin.json');
const MARKET_MANIFEST = path.join(PLUGIN_DIR, '.claude-plugin', 'marketplace.json');

// ---------------------------------------------------------------------------
// small helpers
// ---------------------------------------------------------------------------

function readJson(p) {
  try {
    return JSON.parse(fs.readFileSync(p, 'utf8'));
  } catch (_) {
    return null;
  }
}

function readDaemonInfo() {
  const obj = readJson(DAEMON_JSON);
  if (obj && typeof obj.port === 'number') return obj;
  return null;
}

// Fresh status.json (daemon writes it on every event + a heartbeat). Returns the
// snapshot only when its heartbeat is within TTL, else null. Lets status/doctor
// report the daemon reliably without an HTTP round-trip.
function readFreshStatus() {
  try {
    const s = JSON.parse(fs.readFileSync(path.join(DATA_DIR, 'status.json'), 'utf8'));
    const ttl = (s && s.ttl_seconds ? s.ttl_seconds : 30) * 1000;
    if (s && s.heartbeat_ts && Date.now() - s.heartbeat_ts <= ttl) return s;
  } catch (_) {}
  return null;
}

// Color helpers respect the terminal: full ANSI on a TTY, plain text when piped
// to a file / not a TTY / NO_COLOR set (see UICOLOR below).
function _c(code, s) { return (process.stdout.isTTY && !process.env.NO_COLOR) ? '\x1b[' + code + 'm' + s + '\x1b[0m' : s; }
function green(s) { return _c('32', s); }
function red(s) { return _c('31', s); }
function dim(s) { return _c('2', s); }
function bold(s) { return _c('1', s); }

function out(s) { process.stdout.write(s + '\n'); }

// ---------------------------------------------------------------------------
// Modern installer UI — zero-dep ANSI (256-color, progress bar, spinner).
// Degrades to plain text when stdout is not a TTY or NO_COLOR is set. No TUI
// library is used (would violate the zero-dependency invariant) — just ANSI.
// ---------------------------------------------------------------------------
const UICOLOR = !!process.stdout.isTTY && !process.env.NO_COLOR;
function paint(code, s) { return UICOLOR ? '\x1b[' + code + 'm' + s + '\x1b[0m' : s; }
function orange(s) { return paint('38;5;208', s); }
function cyan(s)   { return paint('38;5;44', s); }
function gray(s)   { return paint('38;5;245', s); }
function grn(s)    { return paint('38;5;42', s); }
const SPIN = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];
function progressBar(pct, width) {
  width = width || 22;
  pct = Math.max(0, Math.min(100, Math.round(pct)));
  const filled = Math.round((pct / 100) * width);
  return orange('█'.repeat(filled)) + gray('░'.repeat(width - filled)) + '  ' + bold(String(pct).padStart(3) + '%');
}

// A stable, non-iCloud home for the installed tool so the global CLI + plugin
// never depend on where the source lives (an iCloud-synced Desktop evicts files
// and makes `sidewrite` hang / "command not found"). This is the plugin path
// Claude Code registers against.
const APP_DIR = path.join(HOME, '.sidewrite-app');
function stageGlobalCopy() {
  if (path.resolve(ROOT_DIR) === path.resolve(APP_DIR)) return APP_DIR; // already the staged copy
  fs.mkdirSync(APP_DIR, { recursive: true });
  for (const item of ['bin', 'plugin', 'index.cjs', 'package.json']) {
    const src = path.join(ROOT_DIR, item);
    if (!fs.existsSync(src)) continue;
    const dst = path.join(APP_DIR, item);
    fs.rmSync(dst, { recursive: true, force: true });
    fs.cpSync(src, dst, { recursive: true });
  }
  return APP_DIR;
}

// Spawn `claude` async so a spinner can animate during the slow plugin steps.
function claudeAsync(claude, args) {
  return new Promise((resolve) => {
    const cp = require('child_process').spawn(claude, args, { stdio: 'ignore' });
    cp.on('error', () => resolve(1));
    cp.on('close', (code) => resolve(code == null ? 1 : code));
  });
}

// Render an animated install step: spinner + label + progress bar while running,
// then a permanent ✔/✗ line. Returns fn()'s result.
async function uiStep(pct, label, fn) {
  let frame = 0, timer = null;
  const draw = () => {
    process.stdout.write('\r\x1b[2K  ' + cyan(SPIN[frame++ % SPIN.length]) + '  ' + label + '   ' + progressBar(pct));
  };
  if (UICOLOR) { draw(); timer = setInterval(draw, 80); }
  let ok = true, res = null;
  try { res = await fn(); } catch (_) { ok = false; }
  if (timer) clearInterval(timer);
  if (UICOLOR) process.stdout.write('\r\x1b[2K');
  out('  ' + (ok ? grn('✔') : red('✗')) + '  ' + label);
  return res;
}

// Locate the Claude Code CLI. Honour an override, then PATH, then well-known spots.
function findClaude() {
  if (process.env.CLAUDE_CLI && fs.existsSync(process.env.CLAUDE_CLI)) {
    return process.env.CLAUDE_CLI;
  }
  const which = spawnSync('bash', ['-lc', 'command -v claude'], { encoding: 'utf8' });
  if (which.status === 0) {
    const p = (which.stdout || '').trim();
    if (p) return p;
  }
  const candidates = [
    path.join(HOME, '.local', 'bin', 'claude'),
    '/opt/homebrew/bin/claude',
    '/usr/local/bin/claude',
  ];
  for (const c of candidates) {
    if (fs.existsSync(c)) return c;
  }
  return null;
}

// Run `claude <args...>` inheriting stdio so the user sees progress. Returns exit code.
function runClaude(claude, args) {
  out(dim('  $ claude ' + args.join(' ')));
  const r = spawnSync(claude, args, { stdio: 'inherit', encoding: 'utf8' });
  return r.status == null ? 1 : r.status;
}

// Run `claude <args...>` capturing output (for probes we don't want to echo).
function claudeCapture(claude, args) {
  const r = spawnSync(claude, args, { encoding: 'utf8' });
  return { status: r.status == null ? 1 : r.status, stdout: r.stdout || '', stderr: r.stderr || '' };
}

function pluginName() {
  const m = readJson(PLUGIN_MANIFEST);
  return (m && m.name) || 'sidewrite';
}
function marketplaceName() {
  const m = readJson(MARKET_MANIFEST);
  return (m && m.name) || 'sidewrite-marketplace';
}

// Pick a PATH directory we can symlink our bins into.
function pickBinTarget() {
  const pathDirs = (process.env.PATH || '').split(':').filter(Boolean);
  const preferred = [
    path.join(HOME, '.local', 'bin'),
    '/opt/homebrew/bin',
    '/usr/local/bin',
  ];
  for (const d of preferred) {
    if (pathDirs.includes(d) && canWrite(d)) return d;
  }
  // Fall back to ~/.local/bin (create it) even if not yet on PATH.
  const fallback = path.join(HOME, '.local', 'bin');
  try { fs.mkdirSync(fallback, { recursive: true }); } catch (_) {}
  return fallback;
}
function canWrite(d) {
  try { fs.accessSync(d, fs.constants.W_OK); return true; } catch (_) { return false; }
}

function symlinkBins(targetDir, srcBinDir) {
  srcBinDir = srcBinDir || BIN_DIR;
  const made = [];
  for (const name of ['sidewrite', 'ccx']) {
    const src = path.join(srcBinDir, name);
    const dst = path.join(targetDir, name);
    if (!fs.existsSync(src)) continue;
    try {
      // If dst already points at our src, leave it. Otherwise replace.
      let replace = true;
      try {
        if (fs.lstatSync(dst).isSymbolicLink() && fs.realpathSync(dst) === fs.realpathSync(src)) {
          replace = false;
        }
      } catch (_) {}
      if (replace) {
        try { fs.unlinkSync(dst); } catch (_) {}
        fs.symlinkSync(src, dst);
      }
      try { fs.chmodSync(src, 0o755); } catch (_) {}
      made.push(dst);
    } catch (e) {
      out(red('  ! could not symlink ' + dst + ': ' + e.message));
    }
  }
  return made;
}

function removeBins(targetDirs) {
  const removed = [];
  for (const targetDir of targetDirs) {
    for (const name of ['sidewrite', 'ccx']) {
      const dst = path.join(targetDir, name);
      try {
        const st = fs.lstatSync(dst);
        if (st.isSymbolicLink()) {
          const real = fs.realpathSync(dst);
          if (real.startsWith(BIN_DIR)) { fs.unlinkSync(dst); removed.push(dst); }
        }
      } catch (_) {}
    }
  }
  return removed;
}

function openInBrowser(url) {
  let cmd, args;
  if (process.platform === 'darwin') { cmd = 'open'; args = [url]; }
  else if (process.platform === 'win32') { cmd = 'cmd'; args = ['/c', 'start', '', url]; }
  else { cmd = 'xdg-open'; args = [url]; }
  const r = spawnSync(cmd, args, { stdio: 'ignore' });
  return r.status === 0;
}

function ensureDaemon() {
  const r = spawnSync(process.execPath, [PM_PATH, 'ensure-started'], { stdio: 'inherit' });
  return r.status === 0;
}

function daemonHealth(info) {
  return new Promise((resolve) => {
    if (!info) return resolve(null);
    const headers = { Host: '127.0.0.1:' + info.port };
    if (info.token) headers.Authorization = 'Bearer ' + info.token;
    const req = http.request(
      { host: '127.0.0.1', port: info.port, path: '/api/health', method: 'GET', headers },
      (res) => {
        let body = '';
        res.setEncoding('utf8');
        res.on('data', (c) => (body += c));
        res.on('end', () => {
          if (res.statusCode !== 200) return resolve(null);
          try { resolve(JSON.parse(body)); } catch (_) { resolve(null); }
        });
      }
    );
    req.on('error', () => resolve(null));
    req.setTimeout(1500, () => { req.destroy(); resolve(null); });
    req.end();
  });
}

// GET/POST /api/config against a running daemon. Resolves the parsed JSON body
// on 2xx, or null on any error / non-2xx (daemon-down handled gracefully).
function daemonConfig(info, method, payload) {
  return new Promise((resolve) => {
    if (!info) return resolve(null);
    const headers = { Host: '127.0.0.1:' + info.port };
    if (info.token) headers.Authorization = 'Bearer ' + info.token;
    let data = null;
    if (payload !== undefined && payload !== null) {
      data = JSON.stringify(payload);
      headers['Content-Type'] = 'application/json';
      headers['Content-Length'] = Buffer.byteLength(data);
    }
    const req = http.request(
      { host: '127.0.0.1', port: info.port, path: '/api/config', method, headers },
      (res) => {
        let body = '';
        res.setEncoding('utf8');
        res.on('data', (c) => (body += c));
        res.on('end', () => {
          if (res.statusCode < 200 || res.statusCode >= 300) return resolve(null);
          try { resolve(JSON.parse(body)); } catch (_) { resolve(null); }
        });
      }
    );
    req.on('error', () => resolve(null));
    req.setTimeout(1500, () => { req.destroy(); resolve(null); });
    if (data) req.write(data);
    req.end();
  });
}

// ---------------------------------------------------------------------------
// commands
// ---------------------------------------------------------------------------

async function cmdInstall() {
  const V = (readJson(PLUGIN_MANIFEST) || {}).version || '1.2.0';
  const W = 58;
  const claude = findClaude();
  const pName = pluginName();
  const mName = marketplaceName();

  // ---- modern banner ------------------------------------------------------
  out('');
  const title = 's/ SIDEWRITE  installer';
  const ver = 'v' + V;
  const pad = Math.max(1, W - title.length - ver.length);
  out('  ' + bold(orange('s/')) + ' ' + bold('SIDEWRITE') + gray('  installer') + ' '.repeat(pad) + gray(ver));
  out('  ' + gray('─'.repeat(W)));
  out('');

  // 1) Stage a stable, GLOBAL, non-iCloud copy — the CLI + plugin path Claude
  //    Code registers against never depends on where the source lives.
  const app = await uiStep(15, 'Staging a stable global copy  ' + gray('~/.sidewrite-app'),
    async () => stageGlobalCopy());
  const appPlugin = path.join(app, 'plugin');
  const appBin = path.join(app, 'bin');

  // 2) Register the plugin globally (user scope) FROM the stable path.
  await uiStep(45, 'Registering the plugin  ' + gray('user scope · all projects'), async () => {
    if (!claude) return;
    await claudeAsync(claude, ['plugin', 'marketplace', 'add', appPlugin, '--scope', 'user']);
    await claudeAsync(claude, ['plugin', 'install', pName + '@' + mName, '--scope', 'user']);
  });

  // 3) Link the CLIs onto PATH (from the stable copy).
  const target = pickBinTarget();
  await uiStep(70, 'Linking `sidewrite` + `ccx`  ' + gray('→ ' + target.replace(HOME, '~')),
    async () => symlinkBins(target, appBin));

  // 4) Start the viewer daemon.
  let url = null;
  await uiStep(90, 'Starting the viewer daemon', async () => {
    ensureDaemon();
    const info = readDaemonInfo();
    url = info ? 'http://127.0.0.1:' + info.port : null;
  });

  // 5) Open the dashboard.
  await uiStep(100, 'Opening the dashboard' + (url ? gray('  ' + url) : ''),
    async () => { if (url) openInBrowser(url); });

  // ---- success panel ------------------------------------------------------
  out('');
  out('  ' + progressBar(100, 40) + '   ' + grn('done'));
  out('');
  out('  ' + grn('✔') + ' ' + bold('Sidewrite installed') + gray(' — global, available in every project.'));
  if (!claude) {
    out('  ' + red('note:') + ' the `claude` CLI was not found — add the plugin manually inside Claude Code:');
    out('    ' + bold('/plugin marketplace add ' + appPlugin));
    out('    ' + bold('/plugin install ' + pName + '@' + mName));
  }
  const onPath = (process.env.PATH || '').split(':').includes(target);
  if (!onPath) {
    out('  ' + red('note:') + ' ' + target + ' is not on your PATH. Add to your shell rc:');
    out('    ' + bold('export PATH="' + target + ':$PATH"'));
  }
  if (url) out('  ' + gray('Dashboard: ') + bold(url));
  out('');
  out('  ' + bold('Next:') + ' pick a mode in the dashboard, add a provider + model, then');
  out('        ' + gray('subscription →') + ' ' + bold('/sidewrite-delegate') + gray('   ·   standalone →') + ' ' + bold('sidewrite code'));
  out('  ' + gray('In this Claude session, run ') + bold('/reload-plugins') + gray(' to activate the commands now.'));
  return 0;
}

function cmdUninstall() {
  out(bold('sidewrite uninstall'));
  const claude = findClaude();
  const pName = pluginName();
  const mName = marketplaceName();
  if (claude) {
    runClaude(claude, ['plugin', 'uninstall', pName + '@' + mName]);
    runClaude(claude, ['plugin', 'marketplace', 'remove', mName]);
  } else {
    out(dim('  (claude CLI not found; remove the plugin from inside Claude Code with /plugin)'));
  }
  const removed = removeBins([
    path.join(HOME, '.local', 'bin'), '/opt/homebrew/bin', '/usr/local/bin',
  ]);
  for (const r of removed) out(dim('  unlinked ' + r));
  out(green('✔ sidewrite plugin removed.') + dim('  (~/.sidewrite data left intact)'));
  return 0;
}

async function cmdOpen() {
  // Fast path: a fresh status.json with a port means the daemon is already up.
  // Build the URL and open directly — skip the process-manager ensure-started
  // spawn (and its startup latency). Fall back to the slow path when stale.
  const fresh = readFreshStatus();
  if (fresh && fresh.port) {
    const url = 'http://127.0.0.1:' + fresh.port;
    const ok = openInBrowser(url);
    out((ok ? green('✔ opened ') : 'Open ') + url);
    return 0;
  }
  ensureDaemon();
  const info = readDaemonInfo();
  if (!info) { out(red('sidewrite: daemon not reachable; could not resolve a URL.')); return 1; }
  const url = 'http://127.0.0.1:' + info.port;
  const ok = openInBrowser(url);
  out((ok ? green('✔ opened ') : 'Open ') + url);
  return 0;
}

function cmdUp() {
  ensureDaemon();
  const info = readDaemonInfo();
  if (info) out(green('✔ viewer up: ') + 'http://127.0.0.1:' + info.port);
  return info ? 0 : 1;
}

function cmdStop() {
  const r = spawnSync(process.execPath, [PM_PATH, 'stop'], { stdio: 'inherit' });
  return r.status == null ? 1 : r.status;
}

function cmdStatus() {
  const r = spawnSync(process.execPath, [PM_PATH, 'status'], { stdio: 'inherit' });
  return r.status == null ? 1 : r.status;
}

function cmdUrl() {
  const info = readDaemonInfo();
  if (!info) { out(''); return 1; }
  out('http://127.0.0.1:' + info.port);
  return 0;
}

// ---------------------------------------------------------------------------
// doctor / setup — zero-dep environment diagnostics (plan §F)
// ---------------------------------------------------------------------------

// Package version (for the .provisioned sentinel and doctor header).
function pkgVersion() {
  const p = readJson(path.join(ROOT_DIR, 'package.json'));
  if (p && p.version) return p.version;
  const m = readJson(PLUGIN_MANIFEST);
  return (m && m.version) || '0.0.0';
}

// Documented minimum Node (node:sqlite landed at 22.5).
const NODE_MIN = { major: 22, minor: 5 };

// Read a SINGLE key's value from a provider .env without materializing the
// token/other secrets into memory. Handles quoting like preflight.cjs.
function readEnvValue(file, key) {
  try {
    const raw = fs.readFileSync(file, 'utf8');
    for (const line of raw.split(/\r?\n/)) {
      const t = line.trim();
      if (!t || t.startsWith('#')) continue;
      const i = t.indexOf('=');
      if (i < 0) continue;
      let k = t.slice(0, i).trim();
      if (k.startsWith('export ')) k = k.slice(7).trim();
      if (k !== key) continue;
      let v = t.slice(i + 1).trim();
      if (v.length >= 2 && v[0] === '"' && v.endsWith('"')) v = v.slice(1, -1).replace(/\\(["\\$`])/g, '$1');
      else if (v.length >= 2 && v[0] === "'" && v.endsWith("'")) v = v.slice(1, -1);
      return v;
    }
  } catch (_) {}
  return null;
}

function isLocalHost(host) {
  const h = (host || '').toLowerCase();
  return h === 'localhost' || h === '127.0.0.1' || h === '0.0.0.0' || h === '::1' || h.endsWith('.local');
}

// Probe a URL: any HTTP response (even 4xx/5xx) => reachable. Network
// error/timeout => unreachable. Never throws.
function probeUrl(urlStr, timeoutMs) {
  return new Promise((resolve) => {
    let u;
    try { u = new URL(urlStr); } catch (_) { return resolve(false); }
    const lib = u.protocol === 'https:' ? https : http;
    const req = lib.request(
      { method: 'GET', hostname: u.hostname, port: u.port || (u.protocol === 'https:' ? 443 : 80), path: u.pathname || '/' },
      (res) => { res.resume(); resolve(true); }
    );
    req.on('error', () => resolve(false));
    req.setTimeout(timeoutMs || 2000, () => { req.destroy(); resolve(false); });
    req.end();
  });
}

// The exact remediation steps for a missing/unreachable local anthropic gateway.
const GATEWAY_STEPS = [
  'A local model needs an Anthropic-wire gateway in front of it. Two options:',
  '  claude-code-router:',
  '    npm i -g @musistudio/claude-code-router',
  '    ccr start                 # serves the Anthropic API on http://127.0.0.1:3456',
  '    # then set the provider CCX_BASE_URL to http://127.0.0.1:3456',
  '  LiteLLM:',
  '    pip install "litellm[proxy]"',
  '    litellm --model ollama/<model> --port 4000   # Anthropic-compatible proxy',
  '    # then set the provider CCX_BASE_URL to http://127.0.0.1:4000',
].join('\n');

// Run all environment checks. Returns { checks, mode, isStandalone, claude }.
// Each check: { id, status: 'pass'|'fail'|'note', msg, fix }.
async function collectDoctorChecks() {
  const checks = [];
  const add = (id, status, msg, fix) => checks.push({ id, status, msg, fix: fix || null });

  // Mode (daemon GET /api/config, else the config file). Fail-closed to unknown.
  const info = readDaemonInfo();
  let modeCfg = await daemonConfig(info, 'GET');
  if (!modeCfg) modeCfg = readConfigFile();
  const mode = modeCfg && modeCfg.mode ? modeCfg.mode : 'unknown';
  const isStandalone = mode === 'standalone';
  add('mode', mode === 'unknown' ? 'note' : 'pass',
    'mode: ' + mode + (modeCfg && modeCfg.onboarded ? '' : '  (not onboarded)'),
    mode === 'unknown' ? 'sidewrite mode <subscription|standalone>' : null);

  // Node version.
  const nv = process.versions.node;
  const major = parseInt(nv.split('.')[0], 10);
  const minor = parseInt(nv.split('.')[1], 10);
  const nodeOk = major > NODE_MIN.major || (major === NODE_MIN.major && minor >= NODE_MIN.minor);
  add('node', nodeOk ? 'pass' : 'fail',
    'node ' + nv + (nodeOk ? '' : '  (need >= ' + NODE_MIN.major + '.' + NODE_MIN.minor + ' for node:sqlite)'),
    nodeOk ? null : 'Install Node >= ' + NODE_MIN.major + '.' + NODE_MIN.minor + ' (e.g. `nvm install ' + NODE_MIN.major + '` or via your package manager).');

  // node:sqlite — feature-probe by spawning a child with the experimental flag
  // (the daemon launches the same way), not just this runtime's require().
  const probe = spawnSync(process.execPath, ['--experimental-sqlite', '-e', 'require("node:sqlite")'],
    { encoding: 'utf8', stdio: ['ignore', 'ignore', 'ignore'] });
  const sqliteOk = probe.status === 0;
  add('sqlite', sqliteOk ? 'pass' : 'fail',
    'node:sqlite ' + (sqliteOk ? 'available (--experimental-sqlite)' : 'not available in this Node'),
    sqliteOk ? null : 'Upgrade Node to >= ' + NODE_MIN.major + '.' + NODE_MIN.minor + ' — the daemon needs node:sqlite.');

  // git present.
  const gitWhich = spawnSync('bash', ['-lc', 'command -v git'], { encoding: 'utf8' });
  const gitPath = (gitWhich.stdout || '').trim();
  add('git', gitPath ? 'pass' : 'fail',
    'git: ' + (gitPath || 'not found'),
    gitPath ? null : 'Install git (xcode-select --install on macOS, or your package manager).');

  // claude CLI on PATH.
  const claude = findClaude();
  if (claude) {
    const v = claudeCapture(claude, ['--version']);
    add('claude', 'pass', 'claude CLI: ' + claude + '  ' + (v.stdout || '').trim());
  } else if (isStandalone) {
    add('claude', 'note', 'claude CLI not found on PATH  (standalone mode — not required)');
  } else {
    add('claude', 'fail', 'claude CLI not found on PATH',
      'Install Claude Code and ensure `claude` is on your PATH: https://docs.anthropic.com/claude-code');
  }

  // npm global bin resolves the sidewrite / ccx CLIs.
  for (const b of ['sidewrite', 'ccx']) {
    const w = spawnSync('bash', ['-lc', 'command -v ' + b], { encoding: 'utf8' });
    const p = (w.stdout || '').trim();
    add('bin:' + b, p ? 'pass' : 'fail',
      '`' + b + '` on PATH: ' + (p || 'no'),
      p ? null : 'Run `sidewrite install` (symlinks bin/) or `npm i -g sidewrite`, then reopen your shell.');
  }

  // Claude Code plugin registration — `npm install` only runs preflight
  // checks via postinstall; registering the plugin (which is what makes the
  // slash commands + skill show up) is the separate, consent-gated
  // `sidewrite install` step and never runs automatically. This is the most
  // common "I installed it but nothing shows up in Claude Code" report.
  const settingsForPlugin = readJson(path.join(HOME, '.claude', 'settings.json'));
  const pluginKey = pluginName() + '@' + marketplaceName();
  const pluginRegistered = !!(settingsForPlugin && settingsForPlugin.enabledPlugins && settingsForPlugin.enabledPlugins[pluginKey] === true);
  add('plugin', pluginRegistered ? 'pass' : 'fail',
    'Claude Code plugin ' + (pluginRegistered ? 'registered: ' + pluginKey : 'NOT registered — commands/skill will not appear'),
    pluginRegistered ? null : 'Run `sidewrite install` to register the plugin with Claude Code.');

  // ~/.sidewrite writable.
  let swWritable = false;
  try {
    if (fs.existsSync(DATA_DIR)) swWritable = canWrite(DATA_DIR);
    else swWritable = canWrite(HOME);
  } catch (_) {}
  add('data-dir', swWritable ? 'pass' : 'fail',
    '~/.sidewrite ' + (fs.existsSync(DATA_DIR) ? 'writable' : 'not yet created') + (swWritable ? '' : '  (not writable)'),
    swWritable ? null : 'Run `sidewrite setup` (creates ~/.sidewrite) or fix its ownership/permissions.');

  // Provider registry files: each must be 0600 and NOT point at api.anthropic.com.
  let provFiles = [];
  try { provFiles = fs.readdirSync(PROVIDERS_DIR).filter((f) => f.endsWith('.env')); } catch (_) {}
  if (!provFiles.length) {
    add('providers', 'note', 'no providers registered', 'Add a provider + model from the dashboard.');
  }
  for (const f of provFiles) {
    const full = path.join(PROVIDERS_DIR, f);
    let perm = null;
    try { perm = fs.statSync(full).mode & 0o777; } catch (_) {}
    if (perm !== null && perm !== 0o600) {
      add('provider-perm:' + f, 'fail',
        'provider ' + f + ' mode ' + perm.toString(8).padStart(4, '0') + ' (expected 0600)',
        'chmod 600 ' + full);
    } else {
      add('provider-perm:' + f, 'pass', 'provider ' + f + ' is 0600');
    }
    const base = readEnvValue(full, 'CCX_BASE_URL') || '';
    if (base.indexOf('api.anthropic.com') !== -1) {
      add('provider-url:' + f, 'fail',
        'provider ' + f + ' CCX_BASE_URL points at api.anthropic.com',
        'Edit ' + full + ' — sidewrite never proxies the Anthropic API; use a third-party anthropic-compatible base URL.');
    } else if (!base) {
      add('provider-url:' + f, 'fail',
        'provider ' + f + ' has no CCX_BASE_URL',
        'Edit ' + full + ' and set CCX_BASE_URL to your provider endpoint.');
    } else {
      add('provider-url:' + f, 'pass', 'provider ' + f + ' base URL ok');
      // standalone + local model: probe the anthropic gateway in front of it.
      if (isStandalone) {
        let host = '';
        try { host = new URL(base).hostname; } catch (_) {}
        if (isLocalHost(host)) {
          const reachable = await probeUrl(base, 2000);
          add('gateway:' + f, reachable ? 'pass' : 'fail',
            'local gateway ' + base + (reachable ? ' reachable' : ' UNREACHABLE'),
            reachable ? null : GATEWAY_STEPS);
        }
      }
    }
  }

  // daemon (fresh status.json first — reliable + no HTTP; HTTP fallback).
  const h = readFreshStatus() || (await daemonHealth(info));
  add('daemon', h ? 'pass' : 'note',
    h ? 'daemon: http://127.0.0.1:' + (h.port || (info && info.port)) + '  stage=' + ((h.pipeline && h.pipeline.stage) || 'idle')
      : 'daemon: not running',
    h ? null : 'Start it with `sidewrite up`.');

  return { checks, mode, isStandalone, claude };
}

function printChecks(checks) {
  let fails = 0;
  for (const c of checks) {
    if (c.status === 'fail') fails++;
    const glyph = c.status === 'pass' ? green('✔') : c.status === 'fail' ? red('✗') : dim('•');
    out(glyph + ' ' + c.msg);
    if (c.status === 'fail' && c.fix) {
      for (const ln of String(c.fix).split('\n')) out(dim('    fix: ') + ln);
    }
  }
  return fails;
}

async function cmdDoctor() {
  const json = process.argv.slice(3).includes('--json');
  const { checks } = await collectDoctorChecks();
  const fails = checks.filter((c) => c.status === 'fail').length;
  if (json) {
    out(JSON.stringify({ ok: fails === 0, version: pkgVersion(), checks }, null, 2));
    return fails === 0 ? 0 : 1;
  }
  out(bold('sidewrite doctor') + dim(' v' + pkgVersion()));
  out('');
  printChecks(checks);
  out('');
  out(fails === 0 ? green('✔ all checks passed.') : red('✗ ' + fails + ' check(s) failed.') + dim('  (see fixes above)'));
  out(dim('paths: plugin=' + PLUGIN_DIR));
  return fails === 0 ? 0 : 1;
}

// `sidewrite setup` — verify + provision. Idempotent; never touches PATH / shell
// profile / ~/.claude unless --write-profile is passed.
async function cmdSetup() {
  const args = process.argv.slice(3);
  const json = args.includes('--json');
  const writeProfile = args.includes('--write-profile');

  const actions = [];

  // 1) ensure ~/.sidewrite (+ runs/).
  try { fs.mkdirSync(DATA_DIR, { recursive: true }); actions.push('ensured ' + DATA_DIR); } catch (e) {
    actions.push('ERROR mkdir ' + DATA_DIR + ': ' + e.message);
  }
  try { fs.mkdirSync(RUNS_DIR, { recursive: true }); } catch (_) {}

  // 2) scaffold config.json if missing (never overwrite an existing one).
  const cfgPath = path.join(DATA_DIR, 'config.json');
  if (!fs.existsSync(cfgPath)) {
    const scaffold = {
      version: 1,
      mode: null,
      onboarded: false,
      session: { provider: null },
      planner: { provider: null, model: null },
      reviewer: { provider: null, model: null },
      autoMergeOnClean: false,
    };
    try { fs.writeFileSync(cfgPath, JSON.stringify(scaffold, null, 2) + '\n', { mode: 0o600 }); actions.push('scaffolded config.json'); } catch (e) {
      actions.push('ERROR write config.json: ' + e.message);
    }
  } else {
    actions.push('config.json already present (left as-is)');
  }

  // 3) chmod every provider .env to 0600.
  try {
    for (const f of fs.readdirSync(PROVIDERS_DIR).filter((x) => x.endsWith('.env'))) {
      const full = path.join(PROVIDERS_DIR, f);
      try {
        const cur = fs.statSync(full).mode & 0o777;
        if (cur !== 0o600) { fs.chmodSync(full, 0o600); actions.push('chmod 600 ' + f); }
      } catch (_) {}
    }
  } catch (_) {}

  // 4) optional PATH profile write — ONLY under --write-profile.
  if (writeProfile) {
    const target = pickBinTarget();
    const onPath = (process.env.PATH || '').split(':').includes(target);
    if (!onPath) {
      const shell = process.env.SHELL || '';
      const rc = shell.includes('zsh') ? path.join(HOME, '.zshrc')
        : shell.includes('bash') ? path.join(HOME, '.bashrc')
          : path.join(HOME, '.profile');
      const lineToAdd = '\n# sidewrite\nexport PATH="' + target + ':$PATH"\n';
      try {
        const existing = fs.existsSync(rc) ? fs.readFileSync(rc, 'utf8') : '';
        if (existing.indexOf(target) === -1) { fs.appendFileSync(rc, lineToAdd); actions.push('added PATH export to ' + rc); }
        else actions.push(target + ' already referenced in ' + rc);
      } catch (e) { actions.push('ERROR editing ' + rc + ': ' + e.message); }
    } else {
      actions.push(target + ' already on PATH');
    }
  }

  // 5) version-stamped provisioned sentinel.
  const sentinel = path.join(DATA_DIR, '.provisioned');
  try {
    fs.writeFileSync(sentinel, JSON.stringify({ version: pkgVersion(), node: process.versions.node, ts: Date.now() }, null, 2) + '\n', { mode: 0o600 });
    actions.push('stamped .provisioned (v' + pkgVersion() + ')');
  } catch (e) { actions.push('ERROR write .provisioned: ' + e.message); }

  // 6) verify.
  const { checks } = await collectDoctorChecks();
  const fails = checks.filter((c) => c.status === 'fail').length;

  if (json) {
    out(JSON.stringify({ ok: fails === 0, version: pkgVersion(), provisioned: actions, checks }, null, 2));
    return fails === 0 ? 0 : 1;
  }

  out(bold('sidewrite setup') + dim(' v' + pkgVersion()));
  out('');
  out(bold('provisioning:'));
  for (const a of actions) out((a.startsWith('ERROR') ? red('  ✗ ') : green('  ✔ ')) + a);
  if (!writeProfile) out(dim('  (PATH / shell profile left untouched — pass --write-profile to opt in)'));
  out('');
  out(bold('verification:'));
  printChecks(checks);
  out('');
  out(fails === 0 ? green('✔ setup complete.') : red('✗ setup finished with ' + fails + ' failing check(s).') + dim('  (see fixes above)'));
  return fails === 0 ? 0 : 1;
}

// ---------------------------------------------------------------------------
// undo — revert a run's live-mirrored file edits (CONTRACT 4)
// ---------------------------------------------------------------------------

function b64url(s) {
  return Buffer.from(s, 'utf8').toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function sha256File(p) {
  try { return crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex'); } catch (_) { return null; }
}

// Newest ~/.sidewrite/runs/<id>.touched by mtime, or null.
function latestTouchedRun() {
  let best = null;
  try {
    for (const f of fs.readdirSync(RUNS_DIR)) {
      if (!f.endsWith('.touched')) continue;
      const full = path.join(RUNS_DIR, f);
      const mt = fs.statSync(full).mtimeMs;
      if (!best || mt > best.mt) best = { runId: f.slice(0, -('.touched'.length)), mt };
    }
  } catch (_) {}
  return best ? best.runId : null;
}

// `sidewrite undo [runId] [--force]` — restore/delete each mirrored file using
// the .touched manifest + .bak backups, guarded by the recorded posthash.
function cmdUndo() {
  const args = process.argv.slice(3);
  const force = args.includes('--force');
  let runId = args.find((a) => !a.startsWith('-')) || null;
  if (!runId) runId = latestTouchedRun();

  if (!runId) {
    out(red('sidewrite undo: no run to undo (no *.touched manifest found).'));
    return 1;
  }

  const manifestPath = path.join(RUNS_DIR, runId + '.touched');
  const backupDir = path.join(RUNS_DIR, runId + '.bak');
  let raw;
  try { raw = fs.readFileSync(manifestPath, 'utf8'); } catch (_) {
    out(red('sidewrite undo: manifest not found: ' + manifestPath));
    return 1;
  }

  // Collapse duplicate entries: FIRST occurrence sets `existed`, LAST sets the
  // expected posthash (the final mirrored content).
  const byRel = new Map();
  for (const line of raw.split(/\r?\n/)) {
    if (!line.trim()) continue;
    const parts = line.split('\t');
    const rel = parts[0];
    if (!rel) continue;
    const existed = parts[1] === '1';
    const posthash = parts[2] || '';
    if (!byRel.has(rel)) byRel.set(rel, { existed, posthash });
    else byRel.get(rel).posthash = posthash;
  }

  // Revert against the run's RECORDED working dir, not the current cwd — the
  // .origdir sidecar is written at run start. Fall back to cwd only when absent.
  let origDir = process.cwd();
  let recordedBase = null;
  try {
    recordedBase = fs.readFileSync(path.join(RUNS_DIR, runId + '.origdir'), 'utf8').trim();
  } catch (_) {}
  if (recordedBase) origDir = recordedBase;
  else if (!force) {
    out(red('sidewrite undo: this run did not record its working dir; refusing to guess.'));
    out(dim('  Re-run from the original project dir, or pass --force to use: ' + origDir));
    return 1;
  }
  out(bold('sidewrite undo') + dim('  run=' + runId) + dim('  base=' + origDir));
  out('');

  let restored = 0, deleted = 0, skipped = 0;
  for (const [rel, info] of byRel) {
    const dest = path.join(origDir, rel);
    // Guard against a path escaping the base dir.
    const destRel = path.relative(origDir, dest);
    if (destRel.startsWith('..') || path.isAbsolute(destRel)) {
      out(red('  ✗ ') + rel + dim('  (escapes working dir — skipped)'));
      skipped++;
      continue;
    }

    // posthash guard: the file must still be exactly what the run left behind.
    const curSha = sha256File(dest);
    const guardOk = info.posthash
      ? curSha === info.posthash              // write: current must match recorded hash
      : curSha === null;                      // delete: current must still be absent
    if (!guardOk && !force) {
      out(dim('  • ') + rel + dim('  (changed since the run — skipped; use --force)'));
      skipped++;
      continue;
    }

    if (info.existed) {
      // File pre-existed the run: restore its original bytes from the backup.
      const bak = path.join(backupDir, b64url(rel));
      try {
        const bytes = fs.readFileSync(bak);
        fs.mkdirSync(path.dirname(dest), { recursive: true });
        fs.writeFileSync(dest, bytes);
        out(green('  ✔ restored ') + rel);
        restored++;
      } catch (e) {
        out(red('  ✗ ') + rel + dim('  (backup missing: ' + e.message + ')'));
        skipped++;
      }
    } else {
      // File was created by the run: remove it.
      try {
        if (fs.existsSync(dest)) fs.unlinkSync(dest);
        out(green('  ✔ removed ') + rel);
        deleted++;
      } catch (e) {
        out(red('  ✗ ') + rel + dim('  (' + e.message + ')'));
        skipped++;
      }
    }
  }

  out('');
  out(bold('summary: ') + green(restored + ' restored') + ', ' + green(deleted + ' removed') + ', ' + dim(skipped + ' skipped'));
  if (skipped && !force) out(dim('  (re-run with --force to override the changed-since guard)'));
  return 0;
}

// Read ~/.sidewrite/config.json directly (fallback when the daemon is down).
// Fail-closed: returns { mode:null, onboarded:false, … } on any error.
function readConfigFile() {
  const cfg = readJson(path.join(DATA_DIR, 'config.json'));
  if (!cfg || typeof cfg !== 'object') {
    return { mode: null, onboarded: false, planner: {}, reviewer: {}, session: {} };
  }
  return cfg;
}

// `sidewrite mode`               -> print current mode/onboarding/roles
// `sidewrite mode subscription`  -> set mode via POST /api/config
// `sidewrite mode standalone`    -> set mode via POST /api/config
async function cmdMode() {
  const arg = process.argv[3];
  const info = readDaemonInfo();

  if (arg !== undefined) {
    if (arg !== 'subscription' && arg !== 'standalone') {
      out(red('sidewrite mode: invalid mode "' + arg + '"'));
      out(dim('  expected: subscription | standalone'));
      return 2;
    }
    const resp = await daemonConfig(info, 'POST', { mode: arg });
    if (!resp || !resp.ok) {
      out(red('sidewrite mode: could not reach the daemon to set the mode.'));
      out(dim('  start it with `sidewrite up`, then retry.'));
      return 1;
    }
    out(green('✔ mode set: ') + bold(arg));
    return 0;
  }

  // No arg: report the current mode.
  let cfg = await daemonConfig(info, 'GET');
  if (!cfg) cfg = readConfigFile();
  const mode = cfg && cfg.mode ? cfg.mode : 'unknown';
  const onboarded = !!(cfg && cfg.onboarded);
  const planner = (cfg && cfg.planner) || {};
  const reviewer = (cfg && cfg.reviewer) || {};
  out(bold('mode: ') + (mode === 'unknown' ? dim(mode) : mode));
  out('onboarded: ' + (onboarded ? green('yes') : dim('no')));
  out('planner:  ' + (planner.provider ? planner.provider + (planner.model ? ' / ' + planner.model : '') : dim('none')));
  out('reviewer: ' + (reviewer.provider ? reviewer.provider + (reviewer.model ? ' / ' + reviewer.model : '') : dim('none')));
  return 0;
}

function usage() {
  out('usage: sidewrite <install|uninstall|open|up|stop|status|url|doctor|setup|undo|mode|statusline|run>');
  out('       sidewrite mode [subscription|standalone]          (print or set the mode)');
  out('       sidewrite doctor [--json]                         (verify environment)');
  out('       sidewrite setup [--json] [--write-profile]        (verify + provision)');
  out('       sidewrite undo [runId] [--force]                  (revert a run\'s file edits)');
  out('       sidewrite statusline <install|remove|status>      (main Claude Code statusline: shows running delegate agents)');
  out('       sidewrite run [provider] [--model M] ["task…"]   (or just: sidewrite [provider] "task…")');
}

// ---------------------------------------------------------------------------
// `sidewrite statusline` — opt-in wiring of the MAIN subscription's own
// ~/.claude/settings.json statusLine to a script that shows the count of
// currently-running Sidewrite delegate agents (reads ~/.sidewrite/status.json,
// no daemon/HTTP dependency). Deliberately NOT run automatically by
// `install`/`up` — every other Sidewrite component is careful to never touch
// ~/.claude (only ~/.claude-<provider> stations); this is the first feature
// that has to, since the whole point is showing state IN the main
// subscription's own statusline. Kept opt-in and idempotent instead.
// ---------------------------------------------------------------------------
const CLAUDE_SETTINGS_PATH = path.join(HOME, '.claude', 'settings.json');
function statuslineScriptPath() {
  return path.join(APP_DIR, 'plugin', 'scripts', 'main-statusline.cjs');
}
function statuslineCommand() {
  return 'node "' + statuslineScriptPath() + '"';
}
function isOurStatusline(cmd) {
  return typeof cmd === 'string' && cmd.indexOf('main-statusline.cjs') !== -1;
}

function cmdStatusline() {
  const action = process.argv[3];
  let cfg = {};
  try { cfg = JSON.parse(fs.readFileSync(CLAUDE_SETTINGS_PATH, 'utf8')); } catch (_) {}
  const cur = cfg.statusLine && cfg.statusLine.command;

  if (action === 'remove') {
    if (!isOurStatusline(cur)) {
      out(dim('sidewrite statusline: not currently installed (nothing to remove).'));
      return 0;
    }
    delete cfg.statusLine;
    fs.mkdirSync(path.dirname(CLAUDE_SETTINGS_PATH), { recursive: true });
    fs.writeFileSync(CLAUDE_SETTINGS_PATH, JSON.stringify(cfg, null, 2) + '\n');
    out(green('✔ removed') + ' sidewrite\'s statusLine from ' + CLAUDE_SETTINGS_PATH);
    return 0;
  }

  if (action !== 'install') {
    if (cur) {
      out(isOurStatusline(cur)
        ? green('installed') + ': ' + cur
        : dim('a different statusLine is configured: ') + cur);
    } else {
      out(dim('no statusLine configured.'));
    }
    out(dim('  run `sidewrite statusline install` to enable the delegate-agent-count statusline.'));
    return 0;
  }

  if (cur && !isOurStatusline(cur)) {
    out(red('sidewrite statusline: refusing to overwrite an existing custom statusLine:'));
    out('  ' + cur);
    out(dim('  remove it from ' + CLAUDE_SETTINGS_PATH + ' yourself first, then re-run `sidewrite statusline install`.'));
    return 1;
  }

  if (!fs.existsSync(statuslineScriptPath())) {
    out(red('sidewrite statusline: ' + statuslineScriptPath() + ' not found.'));
    out(dim('  run `sidewrite install` (or `sidewrite up`) first to stage ~/.sidewrite-app.'));
    return 1;
  }

  cfg.statusLine = { type: 'command', command: statuslineCommand(), padding: 0, refreshInterval: 10 };
  fs.mkdirSync(path.dirname(CLAUDE_SETTINGS_PATH), { recursive: true });
  fs.writeFileSync(CLAUDE_SETTINGS_PATH, JSON.stringify(cfg, null, 2) + '\n');
  out(green('✔ installed') + ' — the main Claude Code statusline now shows running delegate agents.');
  out(dim('  restart Claude Code (or start a new session) to see it.'));
  out(dim('  undo with `sidewrite statusline remove`.'));
  return 0;
}

// ---------------------------------------------------------------------------
// entry
// ---------------------------------------------------------------------------

async function main() {
  const cmd = process.argv[2];
  let code = 0;
  switch (cmd) {
    case 'install': code = await cmdInstall(); break;
    case 'uninstall': code = cmdUninstall(); break;
    case 'open': code = await cmdOpen(); break;
    case 'up': case 'start': code = cmdUp(); break;
    case 'stop': code = cmdStop(); break;
    case 'status': code = cmdStatus(); break;
    case 'url': code = cmdUrl(); break;
    case 'doctor': code = await cmdDoctor(); break;
    case 'setup': code = await cmdSetup(); break;
    case 'undo': code = cmdUndo(); break;
    case 'mode': code = await cmdMode(); break;
    case 'statusline': code = cmdStatusline(); break;
    case '-h': case '--help': case undefined: usage(); code = 0; break;
    default:
      out(red('sidewrite: unknown command "' + cmd + '"'));
      usage();
      code = 2;
  }
  process.exit(code);
}

main().catch((err) => {
  process.stderr.write('sidewrite cli error: ' + (err && err.message) + '\n');
  process.exit(1);
});
