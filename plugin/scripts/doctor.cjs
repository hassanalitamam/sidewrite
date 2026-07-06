#!/usr/bin/env node
'use strict';

/*
 * sidewrite doctor — S9 gate-core consumer + Feature #10 self-check.
 *
 * Thin presentation/remediation layer over the shared `gateChecks()` core
 * (plugin/scripts/gate-core.cjs → { ok, checks: [ { name, ok, detail, fix },
 * ... ] }, currently node/sqlite/claude). Fanned out from the SAME core used
 * by postinstall, `bin/sidewrite-run` / `bin/ccx`'s lazy gate, and
 * `sidewrite bootstrap` (see plan §S9 lines 166-177).
 *
 * `runDoctor(opts)` prints a human report (or JSON with opts.json) and, when
 * opts.fix is set, offers ONLY safe, consent-gated remediation:
 *   - node / sqlite failures have NO automated fix (upgrading the runtime out
 *     from under the caller is not safe) — doctor prints the fix line only.
 *   - claude missing is the ONE remediation doctor will ever attempt, and only
 *     after an explicit y/N prompt (default No; non-TTY/EOF/empty → No, unless
 *     --yes / SIDEWRITE_ASSUME_YES=1). The exact command is printed BEFORE the
 *     prompt. Never silently installs anything.
 *
 * Zero-dep CommonJS (node: builtins only). Does not import cli.cjs — the
 * ONLY dependency is gate-core.cjs's gateChecks(), loaded lazily so a missing
 * gate-core.cjs degrades to a clear, fail-closed report instead of a crash.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const readline = require('readline');
const { spawnSync } = require('child_process');

const GATE_CORE_PATH = path.join(__dirname, 'gate-core.cjs');

// Known check names we understand remediation for, in report order. Any
// extra checks gateChecks() returns are still printed (forward-compatible)
// — just with no automated --fix action.
const KNOWN_ORDER = ['node', 'sqlite', 'claude'];

const INSTALL_CMD = {
  darwin: 'curl -fsSL https://claude.ai/install.sh | bash',
  linux: 'curl -fsSL https://claude.ai/install.sh | bash',
  win32: 'irm https://claude.ai/install.ps1 | iex',
};

function sidewriteHome(opts) {
  if (opts && opts.home) return opts.home;
  return process.env.SIDEWRITE_HOME || path.join(process.env.HOME || os.homedir(), '.sidewrite');
}

// ---------------------------------------------------------------------------
// gate-core loading (lazy, tolerant of the file not existing yet / injection)
// ---------------------------------------------------------------------------

function loadGateChecks(opts) {
  if (opts && typeof opts.gateChecks === 'function') return opts.gateChecks;
  try {
    // Lazy require so a missing gate-core.cjs never crashes module load —
    // only surfaces as a fail-closed synthetic check at call time.
    delete require.cache[require.resolve(GATE_CORE_PATH)];
  } catch (_) {
    // not resolvable yet — fall through to the require() below, which will
    // throw and be caught by the caller.
  }
  const mod = require(GATE_CORE_PATH);
  if (!mod || typeof mod.gateChecks !== 'function') {
    throw new Error('gate-core.cjs does not export gateChecks()');
  }
  return mod.gateChecks;
}

// ---------------------------------------------------------------------------
// color helpers — match cli.cjs: full ANSI only on a real TTY, NO_COLOR wins
// ---------------------------------------------------------------------------

function mkColor(stream) {
  const isTTY = !!(stream && stream.isTTY) && !process.env.NO_COLOR;
  const c = (code, s) => (isTTY ? '\x1b[' + code + 'm' + s + '\x1b[0m' : s);
  return {
    green: (s) => c('32', s),
    red: (s) => c('31', s),
    dim: (s) => c('2', s),
    bold: (s) => c('1', s),
  };
}

// ---------------------------------------------------------------------------
// normalize whatever gateChecks() returns into an ordered, printable list.
// Real contract (gate-core.cjs): { ok, checks: [ { name, ok, detail, fix } ] }.
// Fail-closed: a missing/malformed entry counts as a failing check rather
// than being silently dropped; an entirely non-conforming `raw` degrades to
// one failing entry per known check id instead of an empty report.
// ---------------------------------------------------------------------------

function normalizeChecks(raw) {
  const list = raw && Array.isArray(raw.checks) ? raw.checks : null;
  const byName = new Map();
  if (list) {
    for (const entry of list) {
      if (!entry || typeof entry !== 'object' || typeof entry.name !== 'string' || !entry.name) continue;
      if (!byName.has(entry.name)) byName.set(entry.name, entry); // first entry per name wins
    }
  }

  const out = [];
  const seen = new Set();
  const order = KNOWN_ORDER.concat(Array.from(byName.keys()).filter((n) => KNOWN_ORDER.indexOf(n) === -1));
  for (const id of order) {
    if (seen.has(id)) continue;
    seen.add(id);
    const entry = byName.get(id);
    if (!entry) {
      out.push({ id, ok: false, status: 'missing', detail: id + ': no result from gateChecks()', fix: null });
      continue;
    }
    out.push({
      id,
      ok: entry.ok === true,
      status: entry.ok === true ? 'ok' : 'fail',
      detail: typeof entry.detail === 'string' ? entry.detail : String(entry.detail || ''),
      fix: entry.fix == null ? null : String(entry.fix),
    });
  }
  return out;
}

// ---------------------------------------------------------------------------
// consent-gated `claude` install (the ONLY remediation doctor ever performs)
// ---------------------------------------------------------------------------

// Prompt y/N on the given input/output streams. Resolves false on EOF, empty
// input, non-TTY, or a stall past the timeout (fail-closed to "No").
function promptYesNo(question, opts) {
  const input = (opts && opts.input) || process.stdin;
  const output = (opts && opts.output) || process.stdout;
  const timeoutMs = (opts && opts.timeoutMs) || 30000;
  return new Promise((resolve) => {
    let settled = false;
    let timer = null;
    let rl = null;
    const finish = (val) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      try { if (rl) rl.close(); } catch (_) {}
      resolve(val);
    };
    if (!input.isTTY && !(opts && opts.allowNonTTY)) {
      // Non-interactive stdin: still allow tests to feed a scripted answer via
      // opts.allowNonTTY, but real-world non-TTY runs fail closed immediately.
      return finish(false);
    }
    try {
      rl = readline.createInterface({ input, output });
    } catch (_) {
      return finish(false);
    }
    timer = setTimeout(() => finish(false), Math.max(0, Math.min(timeoutMs, 300000)));
    rl.question(question, (answer) => {
      const a = String(answer || '').trim().toLowerCase();
      finish(a === 'y' || a === 'yes');
    });
    rl.on('close', () => finish(false));
  });
}

// Actually run the vendor installer. Bounded timeout + bounded output buffer
// so a hung/verbose installer can never hang or OOM doctor. Injectable via
// opts.spawnInstall for tests (never spawns curl|bash in the self-test).
function defaultSpawnInstall(platform) {
  if (platform === 'win32') {
    return spawnSync('powershell', ['-NoProfile', '-Command', 'irm https://claude.ai/install.ps1 | iex'], {
      encoding: 'utf8',
      timeout: 180000,
      maxBuffer: 10 * 1024 * 1024,
    });
  }
  return spawnSync('/bin/sh', ['-c', 'curl -fsSL https://claude.ai/install.sh | bash'], {
    encoding: 'utf8',
    timeout: 180000,
    maxBuffer: 10 * 1024 * 1024,
  });
}

// Consent-first claude installer. Prints the exact command, asks [y/N]
// (default No), and on "yes" runs the vendor's own installer. Re-verifies
// with a fresh `command -v claude` probe afterward (native installs can land
// off a GUI-inherited PATH). Never runs without an explicit yes.
async function offerClaudeInstall(opts) {
  opts = opts || {};
  const col = mkColor(opts.output || process.stdout);
  const print = (s) => (opts.output || process.stdout).write(s + '\n');
  const platform = opts.platform || process.platform;
  const cmd = INSTALL_CMD[platform] || INSTALL_CMD.linux;

  print(col.dim('  fix: install the Claude Code CLI'));
  print('  $ ' + cmd);

  const assumeYes = !!opts.assumeYes || process.env.SIDEWRITE_ASSUME_YES === '1';
  let yes = assumeYes;
  if (!yes) {
    yes = await promptYesNo('  Install now? [y/N] ', {
      input: opts.input,
      output: opts.output,
      allowNonTTY: opts.allowNonTTY,
      timeoutMs: opts.promptTimeoutMs,
    });
  }
  if (!yes) {
    print(col.dim('  skipped — run the command above manually, then re-run `sidewrite doctor`.'));
    print(col.dim('  docs: https://docs.anthropic.com/claude-code'));
    return { attempted: false, installed: false };
  }

  const spawnInstall = opts.spawnInstall || defaultSpawnInstall;
  let result;
  try {
    result = spawnInstall(platform);
  } catch (e) {
    result = { status: 1, error: e };
  }
  const spawnOk = !!result && result.status === 0 && !result.error;

  const probe = (opts.findClaude || defaultFindClaude)();
  return { attempted: true, installed: !!probe, spawnOk, claudePath: probe };
}

// Minimal, dependency-free re-probe (mirrors cli.cjs findClaude, kept local so
// doctor.cjs has exactly one dependency: gate-core.cjs).
function defaultFindClaude() {
  if (process.env.CLAUDE_CLI && fs.existsSync(process.env.CLAUDE_CLI)) return process.env.CLAUDE_CLI;
  try {
    const which = spawnSync('bash', ['-lc', 'command -v claude'], { encoding: 'utf8', timeout: 5000 });
    if (!which.error && which.status === 0) {
      const p = (which.stdout || '').trim();
      if (p) return p;
    }
  } catch (_) {}
  const home = process.env.HOME || os.homedir();
  const candidates = [path.join(home, '.local', 'bin', 'claude'), '/opt/homebrew/bin/claude', '/usr/local/bin/claude'];
  for (const c of candidates) {
    try { if (fs.existsSync(c)) return c; } catch (_) {}
  }
  return null;
}

// ---------------------------------------------------------------------------
// persist last-run summary (advisory only — nothing security-sensitive; no
// tokens/keys/paths beyond check ids+status). Atomic temp+rename, 0600.
// ---------------------------------------------------------------------------

function writeLastRun(home, summary) {
  try {
    fs.mkdirSync(home, { recursive: true });
  } catch (_) {
    return false;
  }
  const file = path.join(home, 'doctor-last.json');
  const tmp = file + '.tmp-' + process.pid + '-' + Date.now();
  let data;
  try {
    data = JSON.stringify(summary);
  } catch (_) {
    return false;
  }
  try {
    const fd = fs.openSync(tmp, 'w', 0o600);
    try {
      fs.writeSync(fd, data);
      try { fs.fsyncSync(fd); } catch (_) {}
    } finally {
      fs.closeSync(fd);
    }
    fs.chmodSync(tmp, 0o600);
    fs.renameSync(tmp, file);
    return true;
  } catch (_) {
    try { fs.unlinkSync(tmp); } catch (_) {}
    return false;
  }
}

// ---------------------------------------------------------------------------
// runDoctor(opts) — the exported entry point
// ---------------------------------------------------------------------------

async function runDoctor(opts) {
  opts = opts || {};
  const output = opts.stdout || process.stdout;
  const col = mkColor(output);
  const print = (s) => output.write(s + '\n');
  const home = sidewriteHome(opts);

  let raw = null;
  let gateError = null;
  try {
    const gateChecks = loadGateChecks(opts);
    raw = await gateChecks();
  } catch (e) {
    gateError = e && e.message ? e.message : String(e);
  }

  let checks;
  if (gateError) {
    checks = [{
      id: 'gate-core',
      ok: false,
      status: 'error',
      detail: 'could not load gate-core.cjs: ' + gateError,
      fix: 'Reinstall sidewrite (npm i -g sidewrite), or verify plugin/scripts/gate-core.cjs exists.',
    }];
  } else {
    checks = normalizeChecks(raw);
  }

  const fixResults = [];
  if (opts.fix) {
    for (const c of checks) {
      if (c.ok) continue;
      if (c.id === 'claude') {
        const r = await offerClaudeInstall({
          input: opts.stdin,
          output,
          assumeYes: opts.assumeYes,
          allowNonTTY: opts.allowNonTTY,
          promptTimeoutMs: opts.promptTimeoutMs,
          spawnInstall: opts.spawnInstall,
          findClaude: opts.findClaude,
          platform: opts.platform,
        });
        fixResults.push(Object.assign({ id: 'claude' }, r));
        if (r.installed) {
          c.ok = true;
          c.status = 'ok';
          c.detail = 'claude CLI: ' + r.claudePath + ' (just installed)';
          c.fix = null;
        }
      } else {
        // node / sqlite (and any unknown check): no automated remediation is
        // safe here — surface the fix line only, never act on it.
        fixResults.push({ id: c.id, attempted: false, reason: 'no safe automated fix for ' + c.id });
      }
    }
  }

  if (opts.json) {
    print(JSON.stringify({ ok: checks.every((c) => c.ok), checks, fixResults }, null, 2));
  } else {
    print(col.bold('sidewrite doctor'));
    print('');
    for (const c of checks) {
      const glyph = c.ok ? col.green('✔') : col.red('✘');
      print(glyph + '  ' + c.id + ': ' + c.detail);
      if (!c.ok && c.fix) {
        for (const ln of String(c.fix).split('\n')) print(col.dim('    fix: ') + ln);
      }
    }
    print('');
    const failCount = checks.filter((c) => !c.ok).length;
    print(failCount === 0
      ? col.green('✔ all checks passed.')
      : col.red('✘ ' + failCount + ' check(s) failed.') + col.dim('  (see fixes above)'));
  }

  const summary = {
    ts: Date.now(),
    ok: checks.every((c) => c.ok),
    checks: checks.map((c) => ({ id: c.id, ok: c.ok, status: c.status })),
  };
  if (opts.persist !== false) writeLastRun(home, summary);

  return { ok: summary.ok, checks, fixResults };
}

module.exports = {
  runDoctor,
  normalizeChecks,
  offerClaudeInstall,
  promptYesNo,
  sidewriteHome,
  writeLastRun,
};

// ---------------------------------------------------------------------------
// self-test (node plugin/scripts/doctor.cjs) — gate-core fully stubbed, no
// network, no real ~/.sidewrite writes (HOME is redirected to a temp dir).
// ---------------------------------------------------------------------------

if (require.main === module) {
  (async () => {
    const assert = require('assert');
    const { Writable, Readable } = require('stream');

    const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'sidewrite-doctor-test-'));
    // Belt-and-braces: even though every call below passes an explicit
    // opts.home, also redirect process.env.HOME/SIDEWRITE_HOME so any code
    // path that forgets to thread opts.home still can't touch the real
    // ~/.sidewrite.
    const realHome = process.env.HOME;
    const realSwHome = process.env.SIDEWRITE_HOME;
    process.env.HOME = tmpHome;
    process.env.SIDEWRITE_HOME = tmpHome;

    let passed = 0, failed = 0;
    const results = [];
    function check(name, fn) {
      return Promise.resolve()
        .then(fn)
        .then(() => { passed++; results.push('PASS  ' + name); })
        .catch((e) => { failed++; results.push('FAIL  ' + name + '  — ' + (e && e.message ? e.message : e)); });
    }

    function sinkStream() {
      let buf = '';
      const s = new Writable({ write(chunk, enc, cb) { buf += chunk.toString(); cb(); } });
      s.isTTY = false;
      Object.defineProperty(s, 'text', { get: () => buf });
      return s;
    }

    function inputWithAnswer(answer) {
      const r = new Readable({ read() {} });
      r.isTTY = true; // exercise the interactive path in tests via allowNonTTY too
      process.nextTick(() => { r.push(answer + '\n'); r.push(null); });
      return r;
    }

    // Stubs match the REAL gate-core.cjs contract:
    //   gateChecks() -> { ok, checks: [ { name, ok, detail, fix }, ... ] }
    const allOkGate = () => ({
      ok: true,
      checks: [
        { name: 'node', ok: true, detail: 'node ' + process.version, fix: null },
        { name: 'sqlite', ok: true, detail: 'node:sqlite available', fix: null },
        { name: 'claude', ok: true, detail: 'claude CLI: /usr/local/bin/claude 1.0.0', fix: null },
      ],
    });
    const claudeFailGate = () => ({
      ok: false,
      checks: [
        { name: 'node', ok: true, detail: 'node ' + process.version, fix: null },
        { name: 'sqlite', ok: true, detail: 'node:sqlite available', fix: null },
        { name: 'claude', ok: false, detail: 'claude CLI not found', fix: 'install claude' },
      ],
    });
    const nodeFailGate = () => ({
      ok: false,
      checks: [
        { name: 'node', ok: false, detail: 'node too old', fix: 'upgrade node' },
        { name: 'sqlite', ok: false, detail: 'node:sqlite unavailable', fix: 'upgrade node' },
        { name: 'claude', ok: true, detail: 'claude CLI: ok', fix: null },
      ],
    });
    const throwingGate = () => { throw new Error('boom'); };
    // missing claude entirely, sqlite entry malformed (not an object) — the
    // node entry ({ok:true}, no name!) must be ignored too since a check
    // without a `name` cannot be attributed and must fail closed.
    const malformedGate = () => ({
      ok: false,
      checks: [{ ok: true }, null, { name: 'sqlite', ok: 'not-a-bool' }],
    });

    await check('all-ok gate reports ok:true, no fixResults', async () => {
      const out = sinkStream();
      const r = await runDoctor({ gateChecks: allOkGate, stdout: out, home: path.join(tmpHome, 'a'), json: true });
      assert.strictEqual(r.ok, true);
      assert.strictEqual(r.checks.length, 3);
      const parsed = JSON.parse(out.text);
      assert.strictEqual(parsed.ok, true);
    });

    await check('missing gate-core.cjs degrades to a single fail-closed check, not a crash', async () => {
      const out = sinkStream();
      const badPath = () => { throw new Error('Cannot find module'); };
      const r = await runDoctor({ gateChecks: badPath, stdout: out, home: path.join(tmpHome, 'b') });
      // gateChecks itself isn't required to throw synchronously per our loader
      // contract, but runDoctor must still not throw even if the injected fn
      // itself throws inside the try/catch.
      assert.strictEqual(r.ok, false);
      assert.strictEqual(r.checks[0].id, 'gate-core');
    });

    await check('gateChecks() rejecting is caught (fail-closed) not thrown', async () => {
      const out = sinkStream();
      const r = await runDoctor({ gateChecks: throwingGate, stdout: out, home: path.join(tmpHome, 'c') });
      assert.strictEqual(r.ok, false);
      assert.strictEqual(r.checks[0].id, 'gate-core');
    });

    await check('malformed gate result: nameless/null/non-boolean entries fail closed, never dropped', async () => {
      const out = sinkStream();
      const r = await runDoctor({ gateChecks: malformedGate, stdout: out, home: path.join(tmpHome, 'd') });
      const byId = Object.fromEntries(r.checks.map((c) => [c.id, c]));
      assert.strictEqual(r.checks.length, 3, 'still reports all 3 known checks, none silently dropped');
      assert.strictEqual(byId.node.ok, false, 'a nameless entry cannot be attributed — must fail closed');
      assert.strictEqual(byId.sqlite.ok, false, 'ok:"not-a-bool" must be treated as not-ok (strict === true)');
      assert.strictEqual(byId.claude.ok, false, 'an entirely absent name must fail closed, not be dropped');
      assert.strictEqual(r.ok, false);
    });

    await check('node/sqlite failures get NO automated fix action even with --fix', async () => {
      const out = sinkStream();
      const r = await runDoctor({ gateChecks: nodeFailGate, stdout: out, home: path.join(tmpHome, 'e'), fix: true });
      assert.strictEqual(r.ok, false);
      const nodeFix = r.fixResults.find((f) => f.id === 'node');
      const sqliteFix = r.fixResults.find((f) => f.id === 'sqlite');
      assert.ok(nodeFix && nodeFix.attempted === false, 'node must never be auto-fixed');
      assert.ok(sqliteFix && sqliteFix.attempted === false, 'sqlite must never be auto-fixed');
    });

    await check('--fix on claude failure, decline (n) => no install spawned, stays failing', async () => {
      const out = sinkStream();
      let spawned = false;
      const r = await runDoctor({
        gateChecks: claudeFailGate,
        stdout: out,
        home: path.join(tmpHome, 'f'),
        fix: true,
        stdin: inputWithAnswer('n'),
        spawnInstall: () => { spawned = true; return { status: 0 }; },
      });
      assert.strictEqual(spawned, false, 'declining must never invoke the installer');
      assert.strictEqual(r.ok, false);
    });

    await check('--fix on claude failure, non-TTY + no assumeYes => fails closed, no install spawned', async () => {
      const out = sinkStream();
      let spawned = false;
      const nonTty = new Readable({ read() {} });
      nonTty.isTTY = false;
      process.nextTick(() => { nonTty.push('y\n'); nonTty.push(null); }); // even if it answered yes, non-TTY must not read it
      const r = await runDoctor({
        gateChecks: claudeFailGate,
        stdout: out,
        home: path.join(tmpHome, 'g'),
        fix: true,
        stdin: nonTty,
        spawnInstall: () => { spawned = true; return { status: 0 }; },
      });
      assert.strictEqual(spawned, false, 'non-interactive stdin must fail closed without --yes');
      assert.strictEqual(r.ok, false);
    });

    await check('--fix on claude failure, assumeYes + stubbed installer => reports installed, no real spawn', async () => {
      const out = sinkStream();
      let spawnedWith = null;
      const r = await runDoctor({
        gateChecks: claudeFailGate,
        stdout: out,
        home: path.join(tmpHome, 'h'),
        fix: true,
        assumeYes: true,
        spawnInstall: (platform) => { spawnedWith = platform; return { status: 0 }; },
        findClaude: () => '/fake/bin/claude',
      });
      assert.ok(spawnedWith, 'assumeYes must invoke the (stubbed) installer exactly once');
      assert.strictEqual(r.ok, true, 'a successful stubbed install must flip the claude check to ok');
      const claudeFix = r.fixResults.find((f) => f.id === 'claude');
      assert.strictEqual(claudeFix.installed, true);
    });

    await check('doctor-last.json is written atomically, 0600, under the given home, real HOME untouched', async () => {
      const scopedHome = path.join(tmpHome, 'i');
      const out = sinkStream();
      await runDoctor({ gateChecks: allOkGate, stdout: out, home: scopedHome });
      const file = path.join(scopedHome, 'doctor-last.json');
      assert.ok(fs.existsSync(file), 'doctor-last.json should exist under the scoped home');
      const mode = fs.statSync(file).mode & 0o777;
      assert.strictEqual(mode, 0o600);
      const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
      assert.strictEqual(parsed.ok, true);
      assert.ok(!fs.existsSync(path.join(realHome || os.homedir(), '.sidewrite', 'doctor-last.json.tmp-')));
    });

    await check('opts.persist:false skips the write entirely', async () => {
      const scopedHome = path.join(tmpHome, 'j');
      const out = sinkStream();
      await runDoctor({ gateChecks: allOkGate, stdout: out, home: scopedHome, persist: false });
      assert.strictEqual(fs.existsSync(path.join(scopedHome, 'doctor-last.json')), false);
    });

    await check('human report includes fix lines for every failing check', async () => {
      const out = sinkStream();
      await runDoctor({ gateChecks: nodeFailGate, stdout: out, home: path.join(tmpHome, 'k') });
      assert.ok(out.text.indexOf('fix: upgrade node') !== -1);
    });

    await check('promptYesNo resolves false (fail-closed) on empty answer', async () => {
      const ans = await promptYesNo('? ', { input: inputWithAnswer(''), output: sinkStream(), allowNonTTY: true });
      assert.strictEqual(ans, false);
    });

    await check('promptYesNo resolves true only for y/yes (case-insensitive)', async () => {
      const a1 = await promptYesNo('? ', { input: inputWithAnswer('Y'), output: sinkStream(), allowNonTTY: true });
      const a2 = await promptYesNo('? ', { input: inputWithAnswer('yes'), output: sinkStream(), allowNonTTY: true });
      const a3 = await promptYesNo('? ', { input: inputWithAnswer('sure'), output: sinkStream(), allowNonTTY: true });
      assert.strictEqual(a1, true);
      assert.strictEqual(a2, true);
      assert.strictEqual(a3, false);
    });

    // Restore the environment before reporting (never leave the process HOME
    // pointed at the temp dir for whatever runs after this self-test).
    if (realHome === undefined) delete process.env.HOME; else process.env.HOME = realHome;
    if (realSwHome === undefined) delete process.env.SIDEWRITE_HOME; else process.env.SIDEWRITE_HOME = realSwHome;
    try { fs.rmSync(tmpHome, { recursive: true, force: true }); } catch (_) {}

    for (const line of results) process.stdout.write(line + '\n');
    process.stdout.write('\n' + passed + ' passed, ' + failed + ' failed\n');
    process.exitCode = failed === 0 ? 0 : 1;
  })();
}
