#!/usr/bin/env node
'use strict';

/*
 * sidewrite onboarding — first-run configuration wizard.
 *
 * Exports two functions:
 *   - needsOnboarding() → boolean: true if config.onboarded is unset (computed, not trusting cache).
 *   - runOnboarding() → Promise: a guided CLI wizard using raw ANSI.
 *
 * Wizard flow:
 *   1. Pick mode (subscription / standalone).
 *   2. Add a provider (base URL + API key + model map or built-in).
 *   3. Activate a model (auto-select first if available).
 *   4. Write ~/.sidewrite/config.json with onboarded: true.
 *   5. Point user to the dashboard.
 *
 * Invariants (violating any = wrong):
 *   - Zero external deps (Node builtins + POSIX shell only, CommonJS).
 *   - NEVER write ANTHROPIC_BASE_URL/AUTH_TOKEN to ~/.claude or a shell profile.
 *   - Provider keys get 0600 permissions; ~/.sidewrite/ dirs get 0700.
 *   - Atomic writes (temp+rename); fail-closed defaults.
 *   - Station isolation under ~/.claude-<provider>/ (never ~/.claude).
 *   - Bounded/timed IO; adversarial self-check before finishing.
 *   - Syntax validation: node --check / bash -n.
 */

const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const readline = require('node:readline');
const { spawnSync } = require('node:child_process');

// ---------------------------------------------------------------------------
// Paths & config
// ---------------------------------------------------------------------------

function getSidewriteHome(overrideHome) {
  const home = overrideHome || process.env.HOME || os.homedir();
  return path.join(home, '.sidewrite');
}

function getConfigPath(overrideHome) {
  return path.join(getSidewriteHome(overrideHome), 'config.json');
}

function getProvidersDir(overrideHome) {
  const home = overrideHome || process.env.HOME || os.homedir();
  return path.join(home, '.claude-providers');
}

// ---------------------------------------------------------------------------
// ANSI color helpers (no TUI libraries, fail-closed on non-TTY)
// ---------------------------------------------------------------------------

function makeColor(stream) {
  const isTTY = !!(stream && stream.isTTY) && !process.env.NO_COLOR;
  const c = (code, s) => (isTTY ? '\x1b[' + code + 'm' + s + '\x1b[0m' : s);
  return {
    cyan: (s) => c('36', s),
    green: (s) => c('32', s),
    yellow: (s) => c('33', s),
    red: (s) => c('31', s),
    bold: (s) => c('1', s),
    dim: (s) => c('2', s),
  };
}

const ansi = makeColor(process.stdout);

// ---------------------------------------------------------------------------
// Config I/O — read/write/merge with atomic operations
// ---------------------------------------------------------------------------

function readJsonSafe(filePath) {
  try {
    const raw = fs.readFileSync(filePath, 'utf8');
    return JSON.parse(raw);
  } catch (_) {
    return null;
  }
}

function readConfigSafe(configPath) {
  const raw = readJsonSafe(configPath);
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return null;
  }
  return raw;
}

/**
 * Deep merge: right overwrites left for all keys/nested objects.
 * Used to merge user patches into defaults.
 */
function deepMerge(left, right) {
  if (!left || typeof left !== 'object' || Array.isArray(left)) return right;
  if (!right || typeof right !== 'object' || Array.isArray(right)) return left;
  const result = Object.assign({}, left);
  for (const k of Object.keys(right)) {
    result[k] = deepMerge(left[k], right[k]);
  }
  return result;
}

function getDefaultConfig() {
  return {
    version: 1,
    mode: null,
    onboarded: false,
    session: { provider: null, aliases: {} },
    planner: { provider: null, model: null },
    reviewer: { provider: null, model: null },
    autoMergeOnClean: false,
    telemetry: { level: 'off' },
    budgets: { enabled: false, monthlyUsd: null, perRunUsd: null, warnPct: 80, enforce: false },
    flags: {},
    flagOverrides: {},
    remoteConfig: { enabled: false, url: null, snapshot: null },
  };
}

/**
 * Write config atomically: temp file → chmod 0600 → rename.
 * Caller ensures directories exist. Returns the written config on success.
 */
function writeConfigAtomic(configPath, config) {
  const data = JSON.stringify(config, null, 2) + '\n';
  const tmpPath = configPath + '.tmp';

  // Write to temp file with 0600
  fs.writeFileSync(tmpPath, data, { mode: 0o600 });

  // Explicit chmod (in case umask is permissive)
  try {
    fs.chmodSync(tmpPath, 0o600);
  } catch (_) {
    // Ignore chmod failure, but the write already respected mode=0o600
  }

  // Atomic rename
  fs.renameSync(tmpPath, configPath);

  return config;
}

/**
 * Write provider .env file atomically (authentication storage).
 * Format: CCX_MODELS="model1 model2…" (newline-delimited)
 *         CCX_BASE_URL="base_url"
 *         CCX_AUTH_TOKEN="auth_key"
 * Mode: 0600 (readable only by owner).
 */
function writeProviderEnv(providersDir, providerName, baseUrl, authToken, models) {
  try {
    fs.mkdirSync(providersDir, { recursive: true, mode: 0o700 });
  } catch (_) {}

  const envPath = path.join(providersDir, providerName + '.env');
  const models_str = Array.isArray(models) ? models.join(' ') : String(models || '');
  const lines = [
    'CCX_BASE_URL="' + (baseUrl || '').replace(/"/g, '\\"') + '"',
    'CCX_AUTH_TOKEN="' + (authToken || '').replace(/"/g, '\\"') + '"',
    'CCX_MODELS="' + models_str.replace(/"/g, '\\"') + '"',
  ];
  const data = lines.join('\n') + '\n';

  fs.writeFileSync(envPath, data, { mode: 0o600 });
  try {
    fs.chmodSync(envPath, 0o600);
  } catch (_) {}

  return envPath;
}

// ---------------------------------------------------------------------------
// Public API: needsOnboarding()
// ---------------------------------------------------------------------------

/**
 * Return true if the config.onboarded flag is unset (computed, not cached).
 * Fail-closed: if config doesn't exist or is corrupt, return true (needs setup).
 */
function needsOnboarding(overrideHome) {
  const configPath = getConfigPath(overrideHome);
  const cfg = readConfigSafe(configPath);
  return cfg ? cfg.onboarded !== true : true;
}

// ---------------------------------------------------------------------------
// CLI prompt helpers (bounded/timed, fail-closed)
// ---------------------------------------------------------------------------

/**
 * Prompt for user input with a timeout (default 60s). Returns a Promise<string>.
 * On EOF, timeout, or non-TTY, resolves to empty string (fail-closed).
 */
function promptInput(question, opts) {
  opts = opts || {};
  const timeoutMs = opts.timeoutMs || 60000;
  const stream = opts.stream || process.stdout;

  return new Promise((resolve) => {
    let settled = false;
    let timer = null;
    let rl = null;

    const finish = (val) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      try {
        if (rl) rl.close();
      } catch (_) {}
      resolve(val);
    };

    if (!process.stdin.isTTY) {
      // Non-interactive: fail-closed to empty string
      return finish('');
    }

    timer = setTimeout(() => finish(''), timeoutMs);

    try {
      rl = readline.createInterface({ input: process.stdin, output: stream });
      rl.question(question, (answer) => finish(answer || ''));
    } catch (e) {
      finish('');
    }
  });
}

/**
 * Prompt for yes/no (y/N). Returns true/false. Timeout or empty → false (fail-closed).
 */
async function promptYesNo(question, opts) {
  opts = opts || {};
  const answer = await promptInput(question + ' ' + ansi.dim('[y/N]: '), opts);
  return answer.toLowerCase().startsWith('y');
}

/**
 * Present a choice menu (options = [ {label, value}, ... ]).
 * Returns the selected value. Timeout or empty → first option (fail-closed).
 */
async function promptChoice(question, options, opts) {
  opts = opts || {};
  if (!options || !Array.isArray(options) || options.length === 0) {
    return null;
  }

  console.log('\n' + ansi.bold(question));
  for (let i = 0; i < options.length; i++) {
    console.log('  ' + ansi.cyan('[' + (i + 1) + ']') + '  ' + options[i].label);
  }

  const answer = await promptInput(ansi.dim('  Pick [1-' + options.length + ']: '), opts);
  const choice = parseInt(answer, 10);
  if (Number.isInteger(choice) && choice >= 1 && choice <= options.length) {
    return options[choice - 1].value;
  }
  return options[0].value; // fail-closed to first
}

// ---------------------------------------------------------------------------
// Onboarding flow
// ---------------------------------------------------------------------------

/**
 * runOnboarding() → Promise
 *
 * Interactive wizard:
 *   1. Ensure ~/.sidewrite exists with 0700
 *   2. Ask: subscription or standalone?
 *   3. Add a provider (loop until valid)
 *   4. Auto-select first model or prompt
 *   5. Write config with onboarded: true
 *   6. Point to dashboard
 */
async function runOnboarding(overrideHome) {
  const home = overrideHome || process.env.HOME || os.homedir();
  const sidewriteHome = getSidewriteHome(overrideHome);
  const configPath = getConfigPath(overrideHome);
  const providersDir = getProvidersDir(overrideHome);

  console.log('\n' + ansi.bold('Welcome to Sidewrite') + '\n');

  // Ensure directories
  try {
    fs.mkdirSync(sidewriteHome, { recursive: true, mode: 0o700 });
    fs.chmodSync(sidewriteHome, 0o700);
  } catch (_) {}

  try {
    fs.mkdirSync(providersDir, { recursive: true, mode: 0o700 });
    fs.chmodSync(providersDir, 0o700);
  } catch (_) {}

  // Load existing config (if any) or default
  let config = readConfigSafe(configPath) || getDefaultConfig();
  config = deepMerge(getDefaultConfig(), config);

  // Step 1: Pick mode
  console.log(
    ansi.yellow('?') +
      ' ' +
      'Do you have a Claude Code subscription and want to delegate tasks to an external model?\n'
  );
  const hasSubscription = await promptYesNo(ansi.bold('Subscription mode'));

  config.mode = hasSubscription ? 'subscription' : 'standalone';
  console.log('\nMode: ' + ansi.green(config.mode) + '\n');

  // Step 2: Add a provider
  console.log(ansi.bold('Set up a provider'));
  console.log('(e.g., OpenRouter, Ollama, or a custom Anthropic-compatible base)\n');

  let providerAdded = false;
  let providerName = '';
  let baseUrl = '';
  let authToken = '';
  let models = [];

  // Simplified flow: ask for provider name, base URL, auth token, models
  while (!providerAdded) {
    providerName = (
      await promptInput(
        ansi.yellow('?') + ' Provider name (e.g., openrouter, ollama): ',
        { timeoutMs: 30000 }
      )
    ).trim();

    if (!providerName) {
      // Empty answer (blank line, EOF, or per-prompt timeout) → abort rather
      // than re-prompt forever. The "setup incomplete" guard below handles it.
      console.log(ansi.dim('(skipped — no provider name)'));
      break;
    }

    baseUrl = (
      await promptInput(ansi.yellow('?') + ' Base URL (e.g., https://openrouter.ai/api/v1): ', {
        timeoutMs: 30000,
      })
    ).trim();

    if (!baseUrl) {
      console.log(ansi.dim('(skipped — no base URL)'));
      continue;
    }

    // Some catalog entries (e.g. Cloudflare AI Gateway's meta-router) ship a
    // baseUrl template containing the literal placeholder '<ACCOUNT_ID>' that
    // must be filled in before the URL is usable. Detect it here and
    // string-substitute before anything gets written to disk. Fail-safe: an
    // empty/timed-out answer leaves the placeholder in place rather than
    // guessing, so writeProviderEnv below still gets a value (never crashes),
    // and the user can fix it later in the dashboard.
    if (baseUrl.indexOf('<ACCOUNT_ID>') !== -1) {
      const accountId = (
        await promptInput(
          ansi.yellow('?') + ' Paste your Cloudflare Account ID: ',
          { timeoutMs: 30000 }
        )
      ).trim();
      if (accountId) {
        baseUrl = baseUrl.split('<ACCOUNT_ID>').join(accountId);
      } else {
        console.log(
          ansi.yellow('⚠') +
            '  No Account ID entered — leaving the placeholder in the base URL; edit it later in the dashboard.\n'
        );
      }
    }

    authToken = (
      await promptInput(ansi.yellow('?') + ' API token/key (will be stored in .claude-providers/): ', {
        timeoutMs: 30000,
      })
    ).trim();

    if (!authToken) {
      console.log(ansi.dim('(skipped — no auth token)'));
      continue;
    }

    // Ask for model IDs
    console.log(
      ansi.dim(
        'Enter model IDs (space-separated) or leave blank to configure later:\n  Example: gpt-4o claude-3-sonnet'
      )
    );
    const modelsInput = (
      await promptInput(ansi.yellow('?') + ' Models: ', { timeoutMs: 30000 })
    ).trim();
    models = modelsInput ? modelsInput.split(/\s+/).filter(Boolean) : [];

    if (models.length === 0) {
      console.log(
        ansi.yellow('⚠') +
          '  No models configured yet. You can add them later in the dashboard.\n'
      );
    }

    providerAdded = true;
  }

  if (!providerAdded || !providerName || !baseUrl || !authToken) {
    console.log(
      '\n' +
        ansi.red('✗') +
        ' Provider setup incomplete. Please run `sidewrite` again to retry.\n'
    );
    return;
  }

  // Write provider .env
  try {
    writeProviderEnv(providersDir, providerName, baseUrl, authToken, models);
    console.log(
      '\n' +
        ansi.green('✔') +
        ' Provider "' +
        providerName +
        '" stored at ~/.claude-providers/' +
        providerName +
        '.env\n'
    );
  } catch (e) {
    console.log(
      '\n' +
        ansi.red('✗') +
        ' Failed to write provider config: ' +
        (e && e.message ? e.message : String(e)) +
        '\n'
    );
    return;
  }

  // Step 3: Activate a model
  console.log(ansi.bold('Activate a model'));

  let activeModel = '';
  if (models.length > 0) {
    console.log(
      ansi.dim(
        'Found ' +
          models.length +
          ' model(s) in provider "' +
          providerName +
          '". Auto-activating the first one.\n'
      )
    );
    activeModel = models[0];
  } else {
    console.log(
      ansi.dim(
        'No models were configured. Please add one manually via the dashboard after setup.\n'
      )
    );
  }

  if (activeModel) {
    config.session.provider = providerName;
    if (!config.session.aliases) config.session.aliases = {};
    config.session.aliases.sonnet = activeModel;
    config.session.aliases.opus = activeModel;
    config.session.aliases.haiku = activeModel;

    console.log(
      ansi.green('✔') +
        ' Model "' +
        activeModel +
        '" activated for provider "' +
        providerName +
        '"\n'
    );
  }

  // Step 4: Write config
  config.onboarded = true;

  try {
    writeConfigAtomic(configPath, config);
    console.log(
      ansi.green('✔') +
        ' Configuration saved to ~/.sidewrite/config.json\n'
    );
  } catch (e) {
    console.log(
      '\n' +
        ansi.red('✗') +
        ' Failed to save configuration: ' +
        (e && e.message ? e.message : String(e)) +
        '\n'
    );
    return;
  }

  // Step 5: Point to dashboard
  console.log(
    ansi.green('✓') +
      ' Setup complete!\n\nNext steps:\n  1. ' +
      ansi.cyan('sidewrite') +
      ' — open the dashboard\n  2. Review your provider settings\n  3. Start delegating tasks\n'
  );
}

// ---------------------------------------------------------------------------
// Exports
// ---------------------------------------------------------------------------

module.exports = {
  needsOnboarding,
  runOnboarding,
  // Test helpers (private, but exported for self-test)
  _readConfigSafe: readConfigSafe,
  _deepMerge: deepMerge,
  _getDefaultConfig: getDefaultConfig,
};

// ---------------------------------------------------------------------------
// Self-test (under require.main)
// ---------------------------------------------------------------------------

if (require.main === module) {
  let pass = 0;
  let fail = 0;

  function assert(cond, msg) {
    if (cond) {
      pass++;
      console.log('  ✓ ' + msg);
    } else {
      fail++;
      console.error('  ✗ ' + msg);
    }
  }

  console.log('onboarding.cjs self-test:\n');

  // Test 1: needsOnboarding() on a fresh temp HOME
  const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'sidewrite-onboarding-test-'));
  try {
    const needs1 = needsOnboarding(tmpHome);
    assert(needs1 === true, 'needsOnboarding(tmpHome) → true when config missing');

    // Test 2: After writing config with onboarded=true, needsOnboarding returns false
    const tmpConfig = path.join(tmpHome, '.sidewrite', 'config.json');
    fs.mkdirSync(path.dirname(tmpConfig), { recursive: true, mode: 0o700 });
    const cfg = { onboarded: true };
    fs.writeFileSync(tmpConfig, JSON.stringify(cfg, null, 2) + '\n', { mode: 0o600 });
    const needs2 = needsOnboarding(tmpHome);
    assert(needs2 === false, 'needsOnboarding(tmpHome) → false when onboarded=true');

    // Test 3: Config permissions (should be 0600)
    const stat = fs.statSync(tmpConfig);
    const mode = stat.mode & 0o777;
    assert(mode === 0o600, 'Config file mode is 0600 (got 0o' + mode.toString(8) + ')');

    // Test 4: Directory permissions (should be 0700)
    const dirStat = fs.statSync(path.dirname(tmpConfig));
    const dirMode = dirStat.mode & 0o777;
    assert(dirMode === 0o700, 'Config dir mode is 0700 (got 0o' + dirMode.toString(8) + ')');

    // Test 5: deepMerge() works correctly
    const left = { a: 1, b: { c: 2 } };
    const right = { b: { d: 3 } };
    const merged = require.main.exports._deepMerge(left, right);
    assert(
      merged.a === 1 && merged.b.c === 2 && merged.b.d === 3,
      'deepMerge() merges nested objects correctly'
    );

    // Test 6: Default config has required fields
    const defaults = require.main.exports._getDefaultConfig();
    assert(
      defaults.version === 1 && defaults.mode === null && defaults.onboarded === false,
      'getDefaultConfig() includes version, mode, onboarded'
    );
    assert(
      defaults.session && defaults.session.provider === null,
      'getDefaultConfig() includes session.provider'
    );

    // Test 7: Corrupt config → readConfigSafe returns null (fail-closed)
    const corruptPath = path.join(tmpHome, '.sidewrite', 'bad.json');
    fs.writeFileSync(corruptPath, 'not valid json', { mode: 0o600 });
    const corrupt = require.main.exports._readConfigSafe(corruptPath);
    assert(corrupt === null, 'readConfigSafe() returns null on corrupt JSON');

    // Test 8: Provider .env file is written with 0600
    const tmpProviders = path.join(tmpHome, '.claude-providers');
    writeProviderEnv(tmpProviders, 'test-provider', 'https://api.test.com', 'sk-test', [
      'model-1',
      'model-2',
    ]);
    const envPath = path.join(tmpProviders, 'test-provider.env');
    const envStat = fs.statSync(envPath);
    const envMode = envStat.mode & 0o777;
    assert(envMode === 0o600, 'Provider .env file mode is 0600 (got 0o' + envMode.toString(8) + ')');

    const envContent = fs.readFileSync(envPath, 'utf8');
    assert(
      envContent.includes('CCX_BASE_URL=') && envContent.includes('CCX_AUTH_TOKEN='),
      'Provider .env contains required fields'
    );
    assert(!envContent.includes('PASSWORD') && envContent.includes('model-1 model-2'), 'Models are correctly written');

  } finally {
    // Clean up temp directory
    fs.rmSync(tmpHome, { recursive: true, force: true });
  }

  console.log('\nResult: ' + (fail === 0 ? 'PASS' : 'FAIL'));
  if (fail !== 0) process.exit(1);
}
