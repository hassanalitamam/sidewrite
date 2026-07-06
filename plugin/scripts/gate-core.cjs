#!/usr/bin/env node
'use strict';

/*
 * gate-core.cjs — the ONE dependency/env gate core (plan §S9).
 *
 *   gateChecks() -> { ok, checks: [ { name, ok, detail, fix }, ... ] }
 *
 * Verifies:
 *   - node   : this Node version is new enough to support node:sqlite
 *              (>= 22.5), feature-probed by spawning a child with
 *              --experimental-sqlite — the same way the daemon is launched
 *              (node --experimental-sqlite viewer-daemon.cjs) — not just a
 *              version-string comparison.
 *   - claude : the `claude` (Claude Code) CLI resolves on PATH.
 *
 * This is the SINGLE source of truth for the env gate. Per §S9 it is fanned
 * out to (NOT implemented in this file — this file only detects):
 *   - the package.json `postinstall` (bin/postinstall.cjs)
 *   - the lazy first-run gate in bin/sidewrite-run + bin/ccx
 *   - `sidewrite bootstrap` and `doctor --fix`
 *   - the advisory SessionStart hook (plugin/scripts/env-preflight.cjs)
 *   - GET /api/health/full (system-health panel)
 *
 * Pure detection + remediation text ONLY. Does NOT install, write files, or
 * mutate any state — callers decide what to do with a failing check.
 *
 * node: builtins only, no deps. CommonJS (.cjs). Never throws: every check
 * is individually guarded, so a check that blows up is downgraded to a
 * fail-closed `{ ok:false }` entry instead of aborting the whole gate.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

// Documented minimum Node (node:sqlite landed at 22.5) — keep in sync with
// plugin/scripts/cli.cjs's NODE_MIN.
const NODE_MIN = { major: 22, minor: 5 };

// Bounded timeouts for every child process we spawn below — a hung `claude`
// or `bash` must never hang the gate.
const SPAWN_TIMEOUT_MS = 5000;

function homeDir() {
  return process.env.HOME || os.homedir() || '';
}

// Parse a Node-style "MAJOR.MINOR.PATCH" string. Never throws; malformed
// input degrades to { major:0, minor:0 } so callers fail closed (not ok).
function parseNodeVersion(v) {
  const parts = String(v || '').split('.');
  const major = parseInt(parts[0], 10);
  const minor = parseInt(parts[1], 10);
  return {
    major: Number.isFinite(major) ? major : 0,
    minor: Number.isFinite(minor) ? minor : 0,
  };
}

function nodeAtLeast(v, min) {
  const { major, minor } = parseNodeVersion(v);
  return major > min.major || (major === min.major && minor >= min.minor);
}

// ---------------------------------------------------------------------------
// Individual checks. Each returns { name, ok, detail, fix }. `fix` is null
// when ok — it is remediation TEXT only, never auto-executed here.
// ---------------------------------------------------------------------------

function checkNode() {
  const nv = process.versions.node;
  const ok = nodeAtLeast(nv, NODE_MIN);
  return {
    name: 'node',
    ok,
    detail:
      'node ' + nv + (ok ? '' : '  (need >= ' + NODE_MIN.major + '.' + NODE_MIN.minor + ' for node:sqlite)'),
    fix: ok
      ? null
      : 'Install Node >= ' + NODE_MIN.major + '.' + NODE_MIN.minor +
        ' (e.g. `nvm install ' + NODE_MIN.major + '` or via your package manager).',
  };
}

// node:sqlite — feature-probe by spawning a child with the experimental flag
// (the daemon launches the same way), not just this runtime's require().
// Bounded timeout, no shell, ignored stdio, never throws.
function checkSqlite() {
  let ok = false;
  try {
    const probe = spawnSync(
      process.execPath,
      ['--experimental-sqlite', '-e', 'require("node:sqlite")'],
      { encoding: 'utf8', stdio: ['ignore', 'ignore', 'ignore'], timeout: SPAWN_TIMEOUT_MS }
    );
    ok = !probe.error && probe.status === 0;
  } catch (_) {
    ok = false;
  }
  return {
    name: 'sqlite',
    ok,
    detail: 'node:sqlite ' + (ok ? 'available (--experimental-sqlite)' : 'not available in this Node'),
    fix: ok
      ? null
      : 'Upgrade Node to >= ' + NODE_MIN.major + '.' + NODE_MIN.minor + ' — the daemon needs node:sqlite.',
  };
}

// Run one PATH-resolution probe and return the first line of stdout that
// points at a real file on disk. Fails closed: a nonzero exit, a spawn error
// (incl. timeout, where `error` is set), or output that does not resolve to
// an existing path all yield null. Validating with fs.existsSync is what keeps
// this from failing OPEN on a shell function/alias/builtin named `claude`
// (`command -v` prints the bare word `claude` or `alias claude='…'`, neither
// of which is a launchable binary the daemon/ccx can exec).
function probeClaudePath(cmd, args) {
  try {
    const which = spawnSync(cmd, args, {
      encoding: 'utf8',
      timeout: SPAWN_TIMEOUT_MS,
    });
    if (which.error || which.status !== 0) return null;
    // Bound: a well-formed resolver result is a single short path. Take the
    // first non-empty line (Windows `where` can print several).
    const out = (which.stdout || '').slice(0, 4096);
    for (const line of out.split(/\r?\n/)) {
      const p = line.trim();
      if (p && fs.existsSync(p)) return p;
    }
    return null;
  } catch (_) {
    return null;
  }
}

// Resolve the `claude` (Claude Code) CLI. Order: explicit CLAUDE_CLI env
// override (if it exists on disk) -> a PATH resolver (`where` on win32,
// `command -v` on a login then non-login shell elsewhere) whose output is
// validated to exist on disk -> a short list of common global-install
// locations. Never throws; bounded output; fails closed.
function findClaude() {
  try {
    const override = process.env.CLAUDE_CLI;
    if (override && fs.existsSync(override)) return override;
  } catch (_) {}

  const isWin = process.platform === 'win32';

  if (isWin) {
    const p = probeClaudePath('where', ['claude']);
    if (p) return p;
  } else {
    // Login shell first (sources the user's real PATH from their profile),
    // but a heavy profile (nvm/rvm/conda init) can blow the timeout and fail
    // closed — so retry once with a fast non-login shell before giving up.
    const p =
      probeClaudePath('bash', ['-lc', 'command -v claude']) ||
      probeClaudePath('bash', ['-c', 'command -v claude']);
    if (p) return p;
  }

  const HOME = homeDir();
  const candidates = isWin
    ? [
        path.join(process.env.APPDATA || path.join(HOME, 'AppData', 'Roaming'), 'npm', 'claude.cmd'),
        path.join(process.env.APPDATA || path.join(HOME, 'AppData', 'Roaming'), 'npm', 'claude.exe'),
        path.join(process.env.LOCALAPPDATA || path.join(HOME, 'AppData', 'Local'), 'Programs', 'claude', 'claude.exe'),
      ]
    : [
        path.join(HOME, '.local', 'bin', 'claude'),
        '/opt/homebrew/bin/claude',
        '/usr/local/bin/claude',
      ];
  for (const c of candidates) {
    try {
      if (fs.existsSync(c)) return c;
    } catch (_) {}
  }
  return null;
}

function checkClaude() {
  let claude = null;
  try {
    claude = findClaude();
  } catch (_) {
    claude = null;
  }
  const ok = !!claude;
  return {
    name: 'claude',
    ok,
    detail: ok ? 'claude CLI: ' + claude : 'claude CLI not found on PATH',
    fix: ok
      ? null
      : 'Install Claude Code and ensure `claude` is on your PATH: https://docs.anthropic.com/claude-code',
  };
}

function readJsonSafe(p) {
  try {
    return JSON.parse(fs.readFileSync(p, 'utf8'));
  } catch (_) {
    return null;
  }
}

// Root cause of the #1 "commands/skill didn't show up" report: `npm install`
// only ever runs preflight (this file) via postinstall — registering the
// plugin with Claude Code (`claude plugin marketplace add` + `plugin install`)
// is a SEPARATE, consent-gated step (`sidewrite install`, cli.cjs cmdInstall())
// that never runs automatically. A user can have a perfectly working `sidewrite`
// CLI and still see nothing in Claude Code because that step was never taken.
// This check makes that gap visible everywhere gateChecks() is surfaced
// (postinstall, `sidewrite doctor`, the SessionStart advisory hook, and
// GET /api/health/full) instead of failing silently.
function checkPluginRegistered() {
  const manifest = readJsonSafe(path.join(__dirname, '..', '.claude-plugin', 'plugin.json'));
  const market = readJsonSafe(path.join(__dirname, '..', '.claude-plugin', 'marketplace.json'));
  const pName = (manifest && manifest.name) || 'sidewrite';
  const mName = (market && market.name) || 'sidewrite-marketplace';
  const key = pName + '@' + mName;
  const settings = readJsonSafe(path.join(homeDir(), '.claude', 'settings.json'));
  const ok = !!(settings && settings.enabledPlugins && settings.enabledPlugins[key] === true);
  return {
    name: 'plugin',
    ok,
    detail: ok
      ? 'Claude Code plugin registered: ' + key
      : 'Claude Code plugin NOT registered — commands/skill will not appear in Claude Code',
    fix: ok
      ? null
      : 'Run `sidewrite install` to register the plugin with Claude Code (npm install alone does not do this).',
  };
}

// ---------------------------------------------------------------------------
// gateChecks() — the single exported entry point.
// ---------------------------------------------------------------------------

// Run every check. Individually guarded so one broken check cannot crash the
// whole gate — it fails closed instead (ok:false, no fix text we can't
// vouch for).
function gateChecks() {
  const builders = [
    { name: 'node', fn: checkNode },
    { name: 'sqlite', fn: checkSqlite },
    { name: 'claude', fn: checkClaude },
    { name: 'plugin', fn: checkPluginRegistered },
  ];
  const checks = builders.map(({ name, fn }) => {
    try {
      const r = fn();
      // Defensive shape guard in case a check ever returns something odd.
      return {
        name: r && r.name ? r.name : name,
        ok: !!(r && r.ok),
        detail: (r && r.detail) || '',
        fix: (r && r.fix) || null,
      };
    } catch (e) {
      return { name, ok: false, detail: 'check threw: ' + (e && e.message ? e.message : String(e)), fix: null };
    }
  });
  const ok = checks.every((c) => c.ok);
  return { ok, checks };
}

module.exports = { gateChecks, findClaude, nodeAtLeast, parseNodeVersion, NODE_MIN };

// ---------------------------------------------------------------------------
// Self-test (require.main only) — never touches the real ~/.sidewrite.
// Runs against a temp HOME override so any HOME-derived fallback path
// (e.g. ~/.local/bin/claude) is probed under an isolated, empty directory.
// ---------------------------------------------------------------------------
if (require.main === module) {
  const assert = require('assert');

  const realHome = process.env.HOME;
  const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'sidewrite-gate-core-test-'));
  let failures = 0;
  const results = [];

  function test(name, fn) {
    try {
      fn();
      results.push('PASS ' + name);
    } catch (e) {
      failures++;
      results.push('FAIL ' + name + ' :: ' + (e && e.message ? e.message : String(e)));
    }
  }

  process.env.HOME = tmpHome;
  try {
    // 1. Basic shape: gateChecks() never throws and returns the documented shape.
    test('gateChecks() returns well-formed shape', () => {
      const r = gateChecks();
      assert.strictEqual(typeof r.ok, 'boolean');
      assert.ok(Array.isArray(r.checks));
      assert.strictEqual(r.checks.length, 4);
      const names = r.checks.map((c) => c.name).sort();
      assert.deepStrictEqual(names, ['claude', 'node', 'plugin', 'sqlite']);
      for (const c of r.checks) {
        assert.strictEqual(typeof c.ok, 'boolean');
        assert.strictEqual(typeof c.detail, 'string');
        assert.ok(c.fix === null || typeof c.fix === 'string');
        // Every failing check must carry actionable remediation text.
        if (!c.ok) assert.ok(c.fix && c.fix.length > 0, c.name + ' failed with no fix text');
      }
      // overall ok is exactly the AND of every individual check.
      assert.strictEqual(r.ok, r.checks.every((c) => c.ok));
    });

    // 2. gateChecks() is idempotent / side-effect-free under repeated and
    //    back-to-back ("concurrent enough" for a sync function) calls.
    test('gateChecks() is stable across repeated calls', () => {
      const runs = [];
      for (let i = 0; i < 5; i++) runs.push(gateChecks());
      for (const r of runs) {
        assert.strictEqual(r.ok, runs[0].ok);
        assert.strictEqual(r.checks.length, 4);
      }
      // Never wrote anything under the temp HOME.
      const entries = fs.readdirSync(tmpHome);
      assert.strictEqual(entries.length, 0, 'gateChecks() must not write to HOME, found: ' + entries.join(','));
    });

    // 3. Node version arithmetic — the pure comparator, exercised at its edges.
    test('nodeAtLeast() boundary arithmetic', () => {
      assert.strictEqual(nodeAtLeast('22.5.0', NODE_MIN), true);
      assert.strictEqual(nodeAtLeast('22.6.1', NODE_MIN), true);
      assert.strictEqual(nodeAtLeast('23.0.0', NODE_MIN), true);
      assert.strictEqual(nodeAtLeast('22.4.9', NODE_MIN), false);
      assert.strictEqual(nodeAtLeast('21.9.0', NODE_MIN), false);
    });

    // 4. Hostile input to the version parser: empty / garbage / oversized
    //    strings must fail closed (never throw, never satisfy the floor).
    test('parseNodeVersion() fails closed on hostile input', () => {
      assert.deepStrictEqual(parseNodeVersion(''), { major: 0, minor: 0 });
      assert.deepStrictEqual(parseNodeVersion(undefined), { major: 0, minor: 0 });
      assert.deepStrictEqual(parseNodeVersion('not-a-version'), { major: 0, minor: 0 });
      const oversized = 'x'.repeat(100000) + '.999.999';
      const parsed = parseNodeVersion(oversized);
      assert.strictEqual(parsed.major, 0);
      assert.strictEqual(nodeAtLeast(oversized, NODE_MIN), false);
    });

    // 5. findClaude() honors an explicit CLAUDE_CLI override that exists on disk.
    test('findClaude() honors an existing CLAUDE_CLI override', () => {
      const fakeClaude = path.join(tmpHome, 'fake-claude');
      fs.writeFileSync(fakeClaude, '#!/bin/sh\necho fake\n', { mode: 0o755 });
      const prevOverride = process.env.CLAUDE_CLI;
      process.env.CLAUDE_CLI = fakeClaude;
      try {
        assert.strictEqual(findClaude(), fakeClaude);
      } finally {
        if (prevOverride === undefined) delete process.env.CLAUDE_CLI;
        else process.env.CLAUDE_CLI = prevOverride;
        fs.unlinkSync(fakeClaude);
      }
    });

    // 6. findClaude() ignores a CLAUDE_CLI override that does NOT exist and
    //    falls through to PATH / candidate-path detection without throwing.
    test('findClaude() ignores a nonexistent CLAUDE_CLI override', () => {
      const prevOverride = process.env.CLAUDE_CLI;
      process.env.CLAUDE_CLI = path.join(tmpHome, 'does-not-exist-claude');
      try {
        const r = findClaude();
        assert.ok(r === null || typeof r === 'string');
      } finally {
        if (prevOverride === undefined) delete process.env.CLAUDE_CLI;
        else process.env.CLAUDE_CLI = prevOverride;
      }
    });

    // 7b. findClaude() never fails OPEN: whatever it resolves to MUST exist on
    //    disk (a shell function/alias/builtin named `claude` prints a non-path
    //    from `command -v` and must NOT be returned as a launchable CLI).
    test('findClaude() only ever returns an existing path', () => {
      const prevOverride = process.env.CLAUDE_CLI;
      if (prevOverride !== undefined) delete process.env.CLAUDE_CLI;
      try {
        const r = findClaude();
        assert.ok(r === null || (typeof r === 'string' && fs.existsSync(r)),
          'findClaude() returned a non-existent path: ' + r);
      } finally {
        if (prevOverride !== undefined) process.env.CLAUDE_CLI = prevOverride;
      }
    });

    // 7. checkSqlite via gateChecks(): whatever the verdict, a failing check
    //    must always carry a concrete upgrade instruction (never a bare
    //    "no" with no remediation).
    test('sqlite check carries remediation on failure', () => {
      const r = gateChecks();
      const sqlite = r.checks.find((c) => c.name === 'sqlite');
      assert.ok(sqlite);
      if (!sqlite.ok) assert.ok(/Upgrade Node/.test(sqlite.fix));
    });
  } finally {
    if (realHome === undefined) delete process.env.HOME;
    else process.env.HOME = realHome;
    try {
      fs.rmSync(tmpHome, { recursive: true, force: true });
    } catch (_) {}
  }

  process.stdout.write(results.join('\n') + '\n');
  process.stdout.write(
    failures === 0
      ? 'gate-core.cjs self-test: ALL PASS (' + results.length + ')\n'
      : 'gate-core.cjs self-test: ' + failures + ' FAILURE(S) of ' + results.length + '\n'
  );
  process.exit(failures === 0 ? 0 : 1);
}
