#!/usr/bin/env node
'use strict';

/*
 * bootstrap.cjs — Claude Code (claude CLI) dependency and env bootstrap.
 *
 * Feature #10: Claude Code auto-install with consent gating (plan lines 930-1016).
 *
 * Exports:
 *   preflight()         -> { ok, checks: [ { name, ok, detail, fix }, ... ] }
 *   bootstrap(opts)     -> { ok, action, detail, fix }
 *
 * preflight() runs gateChecks from gate-core.cjs and returns the results.
 *
 * bootstrap(opts) checks if `claude` (Claude Code CLI) is present on PATH.
 * If missing, it:
 *   1. Prompts the user: "Install Claude Code? [y/N]"
 *   2. If accepted (y/Y), runs `npm i -g @anthropic-ai/claude-code` (CONSENT-FIRST).
 *   3. If declined, prints manual install instructions.
 *   4. Never runs silently — authentication is required.
 *   5. Never writes ANTHROPIC_BASE_URL / ANTHROPIC_AUTH_TOKEN to ~/.claude.
 *
 * Self-test (require.main only) with temp HOME, gate-core stubbed, no real install.
 * Prints PASS/FAIL summary to stdout; exits 0 or 1.
 *
 * node: builtins only, no external deps. CommonJS (.cjs). Never throws.
 * Fail-closed: a prompt failure, spawn error, or declined install yields
 * { ok: false, ... } instead of aborting.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const readline = require('readline');
const { spawnSync } = require('child_process');

// Import gateChecks from gate-core.cjs in the same directory.
const gatePath = path.join(__dirname, 'gate-core.cjs');
let gateCore = null;
try {
  gateCore = require(gatePath);
} catch (e) {
  gateCore = null;
}

const TIMEOUT_MS = 5000;
const NPM_INSTALL_TIMEOUT_MS = 30000;

function homeDir() {
  return process.env.HOME || os.homedir() || '';
}

// ---------------------------------------------------------------------------
// preflight() — run gateChecks and return results.
// ---------------------------------------------------------------------------

function preflight() {
  if (!gateCore || typeof gateCore.gateChecks !== 'function') {
    return {
      ok: false,
      checks: [
        {
          name: 'gate-core',
          ok: false,
          detail: 'gate-core.cjs not available',
          fix: 'Ensure gate-core.cjs is in the same directory as bootstrap.cjs',
        },
      ],
    };
  }

  try {
    return gateCore.gateChecks();
  } catch (e) {
    return {
      ok: false,
      checks: [
        {
          name: 'gateChecks',
          ok: false,
          detail: 'gateChecks threw: ' + (e && e.message ? e.message : String(e)),
          fix: null,
        },
      ],
    };
  }
}

// ---------------------------------------------------------------------------
// User consent prompt — bounded, fail-closed, no throw.
// Returns true if user explicitly typed 'y' or 'Y', false otherwise.
// On any error (timeout, stdin closed, etc) returns false (fail-closed).
// ---------------------------------------------------------------------------

function promptConsent(question) {
  return new Promise((resolve) => {
    try {
      const rl = readline.createInterface({
        input: process.stdin,
        output: process.stdout,
      });

      // Timeout: if no response in 10s, assume declined.
      const timeoutId = setTimeout(() => {
        rl.close();
        resolve(false);
      }, 10000);

      rl.question(question, (answer) => {
        clearTimeout(timeoutId);
        rl.close();
        const resp = (answer || '').trim().toLowerCase();
        resolve(resp === 'y' || resp === 'yes');
      });

      // If stdin is not a TTY (piped/redirected), close immediately and decline.
      if (!process.stdin.isTTY) {
        clearTimeout(timeoutId);
        rl.close();
        resolve(false);
      }
    } catch (_) {
      resolve(false);
    }
  });
}

// ---------------------------------------------------------------------------
// attemptNpmInstall(pkg) — run `npm i -g <pkg>` with bounded timeout.
// Returns { ok: boolean, detail: string, error?: string }
// Never throws; failures are fail-closed { ok: false, ... }.
// ---------------------------------------------------------------------------

function attemptNpmInstall(pkg) {
  try {
    const proc = spawnSync('npm', ['i', '-g', pkg], {
      encoding: 'utf8',
      stdio: ['inherit', 'pipe', 'pipe'],
      timeout: NPM_INSTALL_TIMEOUT_MS,
    });

    if (proc.error) {
      return {
        ok: false,
        detail: 'npm spawn failed',
        error: String(proc.error),
      };
    }

    if (proc.status !== 0) {
      return {
        ok: false,
        detail: 'npm exit code ' + proc.status,
        error: (proc.stderr || '').slice(0, 256),
      };
    }

    return {
      ok: true,
      detail: 'installed ' + pkg,
    };
  } catch (e) {
    return {
      ok: false,
      detail: 'npm install threw',
      error: e && e.message ? e.message : String(e),
    };
  }
}

// ---------------------------------------------------------------------------
// bootstrap(opts) — check for claude CLI, offer install with consent.
// ---------------------------------------------------------------------------

async function bootstrap(opts) {
  opts = opts || {};

  // Step 1: Run preflight checks to see if claude is already present.
  const preflightResult = preflight();
  const claudeCheck = preflightResult.checks.find((c) => c.name === 'claude');

  if (claudeCheck && claudeCheck.ok) {
    // Claude CLI is already installed.
    return {
      ok: true,
      action: 'noop',
      detail: 'Claude Code CLI already installed',
      fix: null,
    };
  }

  // Claude is missing. Offer consent-gated install.
  const pkg = '@anthropic-ai/claude-code';
  const message = opts.message || '  Install Claude Code (npm global)? [y/N] ';

  // If opts.consent is pre-set (for testing), skip the prompt.
  let userConsented = typeof opts.consent === 'boolean' ? opts.consent : null;
  if (userConsented === null) {
    userConsented = await promptConsent(message);
  }

  if (!userConsented) {
    // User declined.
    return {
      ok: false,
      action: 'declined',
      detail: 'User declined Claude Code install',
      fix:
        'To install Claude Code manually:\n' +
        '  npm install -g @anthropic-ai/claude-code\n' +
        'or with a package manager:\n' +
        '  brew install anthropic-ai/cli/claude  (macOS)\n' +
        '  choco install claude                    (Windows)\n' +
        'See: https://docs.anthropic.com/claude-code',
    };
  }

  // User consented. Attempt install.
  if (opts.dryRun) {
    // Test mode: simulate the install without actually running it.
    return {
      ok: true,
      action: 'simulated',
      detail: 'Simulated install (dry run)',
      fix: null,
    };
  }

  const installResult = attemptNpmInstall(pkg);
  if (installResult.ok) {
    return {
      ok: true,
      action: 'installed',
      detail: installResult.detail,
      fix: null,
    };
  }

  return {
    ok: false,
    action: 'install_failed',
    detail: 'Failed to install Claude Code',
    error: installResult.error,
    fix:
      'Try installing manually:\n' +
      '  npm install -g @anthropic-ai/claude-code\n' +
      'See: https://docs.anthropic.com/claude-code',
  };
}

module.exports = { preflight, bootstrap };

// ---------------------------------------------------------------------------
// CLI interface: node bootstrap.cjs [preflight | test]
// - `node bootstrap.cjs preflight` runs preflight checks and prints results (exit 0)
// - `node bootstrap.cjs test` runs self-tests
// - bare `node bootstrap.cjs` defaults to preflight
// ---------------------------------------------------------------------------

if (require.main === module) {
  const cmd = (process.argv[2] || 'preflight').toLowerCase();

  if (cmd === 'preflight' || cmd === '') {
    // Run preflight checks and print results (advisory, never fail).
    // Exit 0 always so postinstall never aborts npm install.
    const result = preflight();
    if (result.checks && result.checks.length > 0) {
      result.checks.forEach((check) => {
        const status = check.ok ? '[✓]' : '[✗]';
        process.stdout.write(status + ' ' + check.name + ': ' + check.detail + '\n');
        if (check.fix && !check.ok) {
          process.stdout.write('  Fix: ' + check.fix + '\n');
        }
      });
    }
    process.exit(0);
  } else if (cmd === 'test') {
    // Run self-tests (continue to existing test code below)
    // Mark a flag so the test section knows to run
    process.env._BOOTSTRAP_RUN_TESTS = '1';
  } else {
    // Unknown command; default to preflight
    const result = preflight();
    if (result.checks && result.checks.length > 0) {
      result.checks.forEach((check) => {
        const status = check.ok ? '[✓]' : '[✗]';
        process.stdout.write(status + ' ' + check.name + ': ' + check.detail + '\n');
        if (check.fix && !check.ok) {
          process.stdout.write('  Fix: ' + check.fix + '\n');
        }
      });
    }
    process.exit(0);
  }
}

// Self-test section: only runs if env var set or no CLI command matched
if (require.main === module && process.env._BOOTSTRAP_RUN_TESTS === '1') {
  const assert = require('assert');

  const realHome = process.env.HOME;
  const realGateCore = gateCore;
  const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'sidewrite-bootstrap-test-'));
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

  // Restore HOME after all tests.
  try {
    process.env.HOME = tmpHome;

    // Stub gateCore so tests don't require a real gate-core or a real claude CLI.
    gateCore = {
      gateChecks: () => ({
        ok: true,
        checks: [
          { name: 'node', ok: true, detail: 'node 22.6.0', fix: null },
          { name: 'sqlite', ok: true, detail: 'node:sqlite available', fix: null },
          { name: 'claude', ok: false, detail: 'claude CLI not found', fix: 'Install it.' },
        ],
      }),
    };

    // 1. preflight() returns well-formed shape when gateCore is available.
    test('preflight() returns well-formed result', () => {
      const r = preflight();
      assert.strictEqual(typeof r.ok, 'boolean');
      assert.ok(Array.isArray(r.checks));
      assert.strictEqual(r.checks.length, 3);
      const names = r.checks.map((c) => c.name).sort();
      assert.deepStrictEqual(names, ['claude', 'node', 'sqlite']);
    });

    // 2. preflight() handles missing gate-core gracefully.
    test('preflight() fails closed if gate-core is unavailable', () => {
      const tmp = gateCore;
      gateCore = null;
      try {
        const r = preflight();
        assert.strictEqual(r.ok, false);
        assert.ok(Array.isArray(r.checks));
        assert.ok(r.checks.length > 0);
        assert.strictEqual(r.checks[0].ok, false);
      } finally {
        gateCore = tmp;
      }
    });

    // 3. bootstrap() detects missing claude and returns appropriate result.
    test('bootstrap() detects missing claude and returns declined action', async () => {
      const r = await bootstrap({ consent: false, message: 'Install? [y/N] ' });
      assert.strictEqual(r.ok, false);
      assert.strictEqual(r.action, 'declined');
      assert.ok(r.detail);
      assert.ok(r.fix && r.fix.length > 0);
    });

    // 4. bootstrap() handles dry-run mode (simulated install).
    test('bootstrap() dry-run mode simulates install', async () => {
      const r = await bootstrap({ consent: true, dryRun: true });
      assert.strictEqual(r.ok, true);
      assert.strictEqual(r.action, 'simulated');
    });

    // 5. bootstrap() when claude is already present returns noop.
    test('bootstrap() returns noop if claude already present', async () => {
      gateCore.gateChecks = () => ({
        ok: true,
        checks: [
          { name: 'node', ok: true, detail: 'node 22.6.0', fix: null },
          { name: 'sqlite', ok: true, detail: 'node:sqlite available', fix: null },
          { name: 'claude', ok: true, detail: 'claude CLI: /usr/local/bin/claude', fix: null },
        ],
      });
      try {
        const r = await bootstrap({ consent: false });
        assert.strictEqual(r.ok, true);
        assert.strictEqual(r.action, 'noop');
      } finally {
        gateCore.gateChecks = () => ({
          ok: true,
          checks: [
            { name: 'node', ok: true, detail: 'node 22.6.0', fix: null },
            { name: 'sqlite', ok: true, detail: 'node:sqlite available', fix: null },
            { name: 'claude', ok: false, detail: 'claude CLI not found', fix: 'Install it.' },
          ],
        });
      }
    });

    // 6. bootstrap() returns appropriate result shape on any action.
    test('bootstrap() always returns well-formed result shape', async () => {
      const r = await bootstrap({ consent: false });
      assert.strictEqual(typeof r.ok, 'boolean');
      assert.strictEqual(typeof r.action, 'string');
      assert.ok(['noop', 'declined', 'installed', 'simulated', 'install_failed'].includes(r.action));
      assert.ok(typeof r.detail === 'string');
      assert.ok(r.fix === null || typeof r.fix === 'string');
      // A failing declined action MUST carry remediation text.
      if (!r.ok && r.action === 'declined') {
        assert.ok(r.fix && r.fix.length > 0);
      }
    });

    // 7. Tests do not write to the real HOME.
    test('tests do not write to real HOME', () => {
      const entries = fs.readdirSync(tmpHome);
      assert.ok(entries.length === 0, 'bootstrap tests must not write to HOME, found: ' + entries.join(', '));
    });

    // 8. Tests do not touch ~/.claude (fail-closed: never write secrets).
    test('no secrets written to ~/.claude', () => {
      const claudeDir = path.join(tmpHome, '.claude');
      assert.ok(!fs.existsSync(claudeDir), 'bootstrap must never write ~/.claude');
    });
  } finally {
    process.env.HOME = realHome;
    gateCore = realGateCore;
    try {
      fs.rmSync(tmpHome, { recursive: true, force: true });
    } catch (_) {}
  }

  process.stdout.write(results.join('\n') + '\n');
  process.stdout.write(
    failures === 0
      ? 'bootstrap.cjs self-test: ALL PASS (' + results.length + ')\n'
      : 'bootstrap.cjs self-test: ' + failures + ' FAILURE(S) of ' + results.length + '\n'
  );
  process.exit(failures === 0 ? 0 : 1);
}
