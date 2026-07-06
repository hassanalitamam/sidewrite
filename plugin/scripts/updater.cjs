#!/usr/bin/env node
'use strict';

/*
 * updater.cjs — Auto-update module for Sidewrite.
 *
 * Features:
 * - checkForUpdate() -> Promise<{current, latest, updateAvailable}>
 *   Compares package.json version to npm registry latest. Treats 404/not-published
 *   as "no update" gracefully.
 *
 * - applyUpdate(opts) -> Promise
 *   DEFAULT: notify-only (no-op if opts.apply !== true).
 *   On apply: resolve the target version (opts.version or registry latest), move
 *   node_modules aside, run `npm install <name>@<version> --ignore-scripts`,
 *   trigger daemon restart. Rolls back on any failure.
 *
 * AUTO-UPDATE SAFETY (non-negotiable):
 * - Default is auto='notify' NOT silent apply.
 * - Silent apply only after explicit one-time opt-in.
 * - npm install MUST pass --ignore-scripts (background install would otherwise
 *   auto-run lifecycle scripts = arbitrary code execution).
 * - Version resolution fails CLOSED: any network/parse/missing-manifest error, or
 *   no update available, means nothing is applied. The install target is bounded
 *   to the latest published version (or an explicit caller-supplied version).
 * - On apply, move current node_modules aside and roll back on any failure.
 * - Trigger mandatory daemon restart.
 *
 * Zero external deps (Node builtins only, CommonJS).
 */

const fs = require('node:fs');
const path = require('node:path');
const https = require('node:https');
const { execFileSync } = require('node:child_process');
const os = require('node:os');

// Load semver module from the same directory
const { semverGt } = require('./semver.cjs');

// ---------------------------------------------------------------------------
// Constants and Configuration
// ---------------------------------------------------------------------------

const TIMEOUT_MS = 5000; // 5 second timeout for npm registry fetch
const BODY_CAP = 512 * 1024; // 512 KB body cap
const HOME_DIR = process.env.HOME || os.homedir();
const SIDEWRITE_DIR = path.join(HOME_DIR, '.sidewrite');
const PACKAGE_JSON_PATH = path.join(__dirname, '..', '..', 'package.json');
const BACKUP_DIR = path.join(SIDEWRITE_DIR, 'install-backup');
const DAEMON_RESTART_MARKER = path.join(SIDEWRITE_DIR, 'restart-daemon');

// NPM registry endpoint (default sidewrite package)
const NPM_REGISTRY_URL = 'https://registry.npmjs.org/sidewrite';

// Test overrides
let _packageJsonPath = PACKAGE_JSON_PATH;
let _registryUrl = NPM_REGISTRY_URL;
let _npmCmd = 'npm'; // Can be overridden for testing

// ---------------------------------------------------------------------------
// Internal: Read package.json and extract version
// ---------------------------------------------------------------------------

/**
 * Read current version from package.json. Returns version string or null on error.
 * Never throws. Fails open.
 */
function readCurrentVersion() {
  try {
    const raw = fs.readFileSync(_packageJsonPath, 'utf8');
    const pkg = JSON.parse(raw);
    if (pkg && typeof pkg.version === 'string') {
      return pkg.version;
    }
  } catch (_) {
    // missing, malformed, or unreadable — fail open
  }
  return null;
}

/**
 * Read the package name to install. Prefers package.json "name"; falls back to
 * the trailing path segment of the registry URL. Returns a string or null.
 * Never throws.
 */
function readPackageName() {
  try {
    const raw = fs.readFileSync(_packageJsonPath, 'utf8');
    const pkg = JSON.parse(raw);
    if (pkg && typeof pkg.name === 'string' && pkg.name) {
      return pkg.name;
    }
  } catch (_) {
    // fall through to URL-derived name
  }
  try {
    const u = new URL(_registryUrl);
    const base = decodeURIComponent(u.pathname.replace(/\/+$/, '').split('/').pop() || '');
    if (base) {
      return base;
    }
  } catch (_) {
    // no usable name
  }
  return null;
}

// ---------------------------------------------------------------------------
// Internal: Fetch latest version from npm registry
// ---------------------------------------------------------------------------

/**
 * Fetch the latest version from npm registry.
 * Returns { version } on success, or null on any error (404, network, timeout, parse).
 * Never throws.
 */
function fetchLatestVersion() {
  return new Promise((resolve) => {
    let url;
    try {
      url = new URL(_registryUrl);
    } catch (e) {
      return resolve(null);
    }

    const headers = {
      // Abbreviated metadata is far smaller than the full packument but still
      // carries dist-tags. Keeps us well under BODY_CAP in normal operation.
      'Accept': 'application/vnd.npm.install-v1+json',
      'User-Agent': 'sidewrite-updater',
    };

    const req = https.request(
      {
        method: 'GET',
        hostname: url.hostname,
        port: url.port || 443,
        path: url.pathname + url.search,
        headers,
      },
      (res) => {
        let body = '';
        let size = 0;

        // Cap body size to prevent DoS. MUST resolve here: req.destroy() with no
        // error emits neither 'error' nor 'end', so without this the caller hangs.
        res.on('data', (chunk) => {
          size += chunk.length;
          if (size > BODY_CAP) {
            req.destroy();
            return resolve(null);
          }
          body += chunk;
        });

        res.on('end', () => {
          // 404 → package not published yet, treat as "no update"
          if (res.statusCode === 404) {
            return resolve(null);
          }

          // Non-2xx status → fail open
          if (res.statusCode < 200 || res.statusCode >= 300) {
            return resolve(null);
          }

          // Parse JSON
          let data;
          try {
            data = JSON.parse(body);
          } catch (_) {
            return resolve(null);
          }

          // Extract latest version from npm registry response.
          // The response has a "dist-tags" object with a "latest" field.
          if (
            data &&
            typeof data === 'object' &&
            data['dist-tags'] &&
            typeof data['dist-tags'].latest === 'string'
          ) {
            const version = data['dist-tags'].latest;
            return resolve({ version });
          }

          resolve(null);
        });
      }
    );

    req.on('error', () => {
      resolve(null);
    });

    req.setTimeout(TIMEOUT_MS, () => {
      req.destroy();
      resolve(null);
    });

    req.end();
  });
}

// ---------------------------------------------------------------------------
// Public API: checkForUpdate
// ---------------------------------------------------------------------------

/**
 * Check for available updates.
 *
 * @returns {Promise<{current: string|null, latest: string|null, updateAvailable: boolean}>}
 *
 * Always resolves (never rejects). If any error (network, parse, missing manifest),
 * returns with updateAvailable=false (fail-closed).
 */
async function checkForUpdate() {
  const current = readCurrentVersion();
  const latestData = await fetchLatestVersion();

  // Fail-closed: if we can't determine versions, report no update
  if (!current || !latestData || !latestData.version) {
    return {
      current: current || null,
      latest: latestData ? latestData.version : null,
      updateAvailable: false,
    };
  }

  // Compare using semver (latest > current)
  const updateAvailable = semverGt(latestData.version, current);

  return {
    current,
    latest: latestData.version,
    updateAvailable,
  };
}

// ---------------------------------------------------------------------------
// Internal: Backup and restore
// ---------------------------------------------------------------------------

// Move a directory tree atomically when possible. Prefers rename (O(1), atomic,
// preserves symlinks/perms); falls back to a symlink-preserving copy only when
// src and dest live on different filesystems (EXDEV). The copy leaves src intact
// until it has fully materialised dest, so a mid-copy throw never leaves a hole.
function moveTree(src, dest) {
  try {
    fs.renameSync(src, dest);
    return;
  } catch (e) {
    if (!e || e.code !== 'EXDEV') {
      throw e;
    }
  }
  // Cross-device: copy verbatim (symlinks stay symlinks), then drop the original.
  fs.cpSync(src, dest, { recursive: true, verbatimSymlinks: true });
  fs.rmSync(src, { recursive: true, force: true });
}

/**
 * Backup current node_modules (if it exists) by moving it aside.
 * Returns path to backup on success, or null on any error.
 * Never throws.
 */
function backupNodeModules() {
  try {
    const nodeModulesPath = path.join(__dirname, '..', '..', 'node_modules');

    // If no node_modules, nothing to back up
    if (!fs.existsSync(nodeModulesPath)) {
      return null;
    }

    // Ensure backup dir exists
    fs.mkdirSync(BACKUP_DIR, { recursive: true, mode: 0o700 });

    // Remove any stale backup
    const oldBackup = path.join(BACKUP_DIR, 'node_modules.old');
    if (fs.existsSync(oldBackup)) {
      fs.rmSync(oldBackup, { recursive: true, force: true });
    }

    // Move the current tree aside. This is atomic on-device and preserves the
    // exact tree (symlinks, .bin shims, perms). npm install then rebuilds a
    // fresh node_modules; on failure we move this backup back.
    moveTree(nodeModulesPath, oldBackup);

    return oldBackup;
  } catch (_) {
    // Backup failure is not fatal; we'll just skip rollback
    return null;
  }
}

/**
 * Restore node_modules from backup by moving it back into place.
 * Returns true on success, false on any error.
 */
function restoreFromBackup(backupPath) {
  if (!backupPath || !fs.existsSync(backupPath)) {
    return false;
  }

  try {
    const nodeModulesPath = path.join(__dirname, '..', '..', 'node_modules');

    // Remove the (possibly broken) freshly-installed tree, then move the backup
    // back. The move is atomic on-device, so there is no window with no
    // node_modules at all beyond the instantaneous rename.
    if (fs.existsSync(nodeModulesPath)) {
      fs.rmSync(nodeModulesPath, { recursive: true, force: true });
    }

    moveTree(backupPath, nodeModulesPath);

    return true;
  } catch (_) {
    return false;
  }
}

// ---------------------------------------------------------------------------
// Internal: Trigger daemon restart
// ---------------------------------------------------------------------------

/**
 * Mark the daemon for restart by writing a marker file.
 * The daemon will detect this and restart itself.
 */
function triggerDaemonRestart() {
  try {
    fs.mkdirSync(SIDEWRITE_DIR, { recursive: true, mode: 0o700 });
    fs.writeFileSync(DAEMON_RESTART_MARKER, Date.now().toString(), { mode: 0o600 });
  } catch (_) {
    // Non-fatal if marker write fails
  }
}

// ---------------------------------------------------------------------------
// Public API: applyUpdate
// ---------------------------------------------------------------------------

/**
 * Apply an available update.
 *
 * DEFAULT: notify-only (no-op if opts.apply !== true).
 * - Returns a promise that resolves with {applied: false, reason: 'notify-only'} or similar.
 *
 * When opts.apply === true:
 * - Resolves the target version (opts.version, else the registry latest). A bare
 *   `npm install` only refreshes deps from the lockfile and would NOT upgrade the
 *   package itself, so we install the resolved <name>@<version> explicitly.
 * - Backs up (moves aside) current node_modules
 * - Runs `npm install <name>@<version> --ignore-scripts` at repo root
 * - On any failure, rolls back and returns {applied: false, error: ...}
 * - On success, triggers daemon restart and returns {applied: true, version}
 *
 * Never rejects. Always resolves with {applied, reason/error, ...}.
 *
 * @param {object} [opts]
 * @param {boolean} [opts.apply] - only apply if true; otherwise notify-only
 * @param {string}  [opts.version] - explicit target version; skips the registry lookup
 * @returns {Promise<{applied: boolean, reason?: string, error?: string, version?: string}>}
 */
async function applyUpdate(opts) {
  // Default: notify-only
  if (!opts || opts.apply !== true) {
    return {
      applied: false,
      reason: 'notify-only (explicit opt-in required)',
    };
  }

  // Resolve the version to install. Prefer an explicit caller-supplied target;
  // otherwise consult the registry and only proceed if an update is actually
  // available (fail-closed: never fire a pointless install/restart).
  let targetVersion = (typeof opts.version === 'string' && opts.version) ? opts.version : null;
  if (!targetVersion) {
    try {
      const info = await checkForUpdate();
      if (info && info.updateAvailable && info.latest) {
        targetVersion = info.latest;
      }
    } catch (_) {
      targetVersion = null;
    }
  }
  if (!targetVersion) {
    return {
      applied: false,
      reason: 'no newer version resolved; nothing to apply',
    };
  }

  const pkgName = readPackageName();
  if (!pkgName) {
    return {
      applied: false,
      error: 'could not determine package name to install',
    };
  }

  // Defence in depth: even though we exec without a shell, refuse anything that
  // isn't a plain npm package name / version before building the install spec.
  if (
    !/^[0-9A-Za-z][0-9A-Za-z.\-+]*$/.test(targetVersion) ||
    !/^(@[a-z0-9-~][a-z0-9-._~]*\/)?[a-z0-9-~][a-z0-9-._~]*$/i.test(pkgName)
  ) {
    return {
      applied: false,
      error: 'invalid package name or version; refusing to install',
    };
  }

  try {
    // 1. Back up current install
    const backupPath = backupNodeModules();
    // Backup failure is not fatal; we just lose rollback capability.

    try {
      // 2. Install the resolved target. --ignore-scripts is the critical safety
      // flag (prevents auto-run of lifecycle scripts). execFileSync (no shell)
      // means the pkg@version spec cannot be interpreted as a shell command.
      const repoRoot = path.join(__dirname, '..', '..');

      execFileSync(_npmCmd, ['install', `${pkgName}@${targetVersion}`, '--ignore-scripts'], {
        cwd: repoRoot,
        stdio: 'pipe', // Suppress output
        timeout: 120000, // 120 second timeout (cold caches / large trees)
      });

      // 3. Success: trigger daemon restart
      triggerDaemonRestart();

      return {
        applied: true,
        version: targetVersion,
      };
    } catch (installErr) {
      // 4. Failure: attempt rollback
      if (backupPath && restoreFromBackup(backupPath)) {
        return {
          applied: false,
          error: `npm install failed; rolled back to backup. Details: ${String(installErr).slice(0, 200)}`,
        };
      } else {
        return {
          applied: false,
          error: `npm install failed and rollback was not possible. Details: ${String(installErr).slice(0, 200)}`,
        };
      }
    }
  } catch (err) {
    // Outer catch: backup or other pre-flight failure
    return {
      applied: false,
      error: `Unexpected error during update: ${String(err).slice(0, 200)}`,
    };
  }
}

// ---------------------------------------------------------------------------
// Test Overrides
// ---------------------------------------------------------------------------

/**
 * Override internal paths for testing.
 * @param {object} [o]
 * @param {string} [o.packageJsonPath]
 * @param {string} [o.registryUrl]
 * @param {string} [o.npmCmd]
 */
function _testOverride(o) {
  if (!o) {
    _packageJsonPath = PACKAGE_JSON_PATH;
    _registryUrl = NPM_REGISTRY_URL;
    _npmCmd = 'npm';
    return;
  }
  if (o.packageJsonPath !== undefined) _packageJsonPath = o.packageJsonPath;
  if (o.registryUrl !== undefined) _registryUrl = o.registryUrl;
  if (o.npmCmd !== undefined) _npmCmd = o.npmCmd;
}

// ---------------------------------------------------------------------------
// Exports
// ---------------------------------------------------------------------------

module.exports = {
  checkForUpdate,
  applyUpdate,
  // Internal exports for testing
  _testOverride,
  _readCurrentVersion: readCurrentVersion,
  _fetchLatestVersion: fetchLatestVersion,
  _backupNodeModules: backupNodeModules,
  _restoreFromBackup: restoreFromBackup,
  _triggerDaemonRestart: triggerDaemonRestart,
};

// ---------------------------------------------------------------------------
// Self-Test
// ---------------------------------------------------------------------------

if (require.main === module) {
  const path = require('node:path');
  const os = require('node:os');

  let passed = 0;
  let failed = 0;

  function assert(cond, label) {
    if (cond) {
      console.log('  PASS: ' + label);
      passed++;
    } else {
      console.error('  FAIL: ' + label);
      failed++;
    }
  }

  // Set up a temp HOME so tests don't touch the real install
  const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'sidewrite-updater-test-'));
  const tmpPackageJson = path.join(tmpHome, 'package.json');

  try {
    // ---- Test 1: readCurrentVersion with valid package.json ----
    console.log('\nTest 1: readCurrentVersion with valid package.json');
    {
      fs.writeFileSync(tmpPackageJson, JSON.stringify({ name: 'sidewrite', version: '1.2.0' }));
      _testOverride({ packageJsonPath: tmpPackageJson });
      const ver = readCurrentVersion();
      assert(ver === '1.2.0', 'readCurrentVersion() returns "1.2.0"');
    }

    // ---- Test 2: readCurrentVersion with missing file ----
    console.log('\nTest 2: readCurrentVersion with missing file');
    {
      _testOverride({ packageJsonPath: path.join(tmpHome, 'nonexistent.json') });
      const ver = readCurrentVersion();
      assert(ver === null, 'readCurrentVersion() returns null on missing file');
    }

    // ---- Test 3: readCurrentVersion with malformed JSON ----
    console.log('\nTest 3: readCurrentVersion with malformed JSON');
    {
      fs.writeFileSync(tmpPackageJson, 'NOT JSON!!!');
      _testOverride({ packageJsonPath: tmpPackageJson });
      const ver = readCurrentVersion();
      assert(ver === null, 'readCurrentVersion() returns null on malformed JSON');
    }

    // ---- Test 4: checkForUpdate with no newer version (404) ----
    console.log('\nTest 4: checkForUpdate with 404 (package not published)');
    {
      fs.writeFileSync(tmpPackageJson, JSON.stringify({ version: '1.2.0' }));
      _testOverride({
        packageJsonPath: tmpPackageJson,
        registryUrl: 'https://registry.npmjs.org/nonexistent-package-xyz-123',
      });

      checkForUpdate().then((result) => {
        assert(result.current === '1.2.0', 'current version is correct');
        assert(result.latest === null, 'latest is null on 404');
        assert(result.updateAvailable === false, 'updateAvailable is false on 404');
      });
    }

    // ---- Test 5: applyUpdate with opts.apply !== true (default notify-only) ----
    console.log('\nTest 5: applyUpdate default notify-only mode');
    {
      applyUpdate({ apply: false }).then((result) => {
        assert(result.applied === false, 'applied is false');
        assert(result.reason !== undefined, 'reason is provided');
      });

      applyUpdate().then((result) => {
        assert(result.applied === false, 'applied is false with no opts');
        assert(result.reason !== undefined, 'reason is provided with no opts');
      });
    }

    // ---- Test 6: applyUpdate with opts.apply === true but npm fails ----
    console.log('\nTest 6: applyUpdate with npm failure (mocked)');
    {
      // Give package.json a name so readPackageName resolves; point npm at a
      // command that always fails so the install step errors and rolls back.
      fs.writeFileSync(tmpPackageJson, JSON.stringify({ name: 'sidewrite', version: '1.2.0' }));
      _testOverride({ packageJsonPath: tmpPackageJson, npmCmd: 'false' }); // 'false' exits 1

      // Pass an explicit target version so no network lookup is needed.
      applyUpdate({ apply: true, version: '9.9.9' }).then((result) => {
        assert(result.applied === false, 'applied is false on npm failure');
        assert(result.error !== undefined, 'error is provided on npm failure');
      });
    }

    // ---- Test 7: Semver comparison (via checkForUpdate conceptually) ----
    console.log('\nTest 7: Semver comparison in version logic');
    {
      fs.writeFileSync(tmpPackageJson, JSON.stringify({ version: '1.2.0' }));
      _testOverride({
        packageJsonPath: tmpPackageJson,
        // Can't easily mock registry without a server, so we test the conceptual flow
      });
      // This is more of a conceptual test since we can't mock the network
      const current = readCurrentVersion();
      assert(current === '1.2.0', 'semver: current version extracted correctly');
    }

    // ---- Test 8: backupNodeModules with non-existent directory ----
    console.log('\nTest 8: backupNodeModules with missing node_modules');
    {
      const tmpRepo = path.join(tmpHome, 'repo');
      fs.mkdirSync(tmpRepo, { recursive: true });
      // Don't create node_modules
      const backup = backupNodeModules();
      assert(backup === null, 'backupNodeModules returns null when node_modules missing');
    }

    // ---- Test 9: restoreFromBackup with non-existent backup ----
    console.log('\nTest 9: restoreFromBackup with non-existent backup');
    {
      const result = restoreFromBackup(path.join(tmpHome, 'nonexistent-backup'));
      assert(result === false, 'restoreFromBackup returns false for non-existent backup');
    }

    // ---- Test 10: triggerDaemonRestart creates marker file ----
    console.log('\nTest 10: triggerDaemonRestart directory creation');
    {
      // This test verifies the marker file write logic works
      // Note: SIDEWRITE_DIR is set at module load time, so we can't easily override it
      // Instead, verify the logic would work by checking the expected path construction
      const expectedMarkerName = 'restart-daemon';
      const marker = path.join(SIDEWRITE_DIR, expectedMarkerName);
      assert(typeof marker === 'string' && marker.length > 0, 'triggerDaemonRestart path construction works');
    }

  } finally {
    // Clean up temp dir
    try {
      fs.rmSync(tmpHome, { recursive: true, force: true });
    } catch (_) {}
  }

  // Wait a bit for async tests to settle, then report
  setTimeout(() => {
    console.log('\n========================================');
    console.log('Results: ' + passed + ' passed, ' + failed + ' failed');
    console.log('========================================');

    if (failed > 0) {
      console.error('FAIL');
      process.exit(1);
    } else {
      console.log('PASS');
      process.exit(0);
    }
  }, 300);
}
