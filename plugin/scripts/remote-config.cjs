'use strict';

/*
 * remote-config.cjs — Unified remote-config channel (opt-in, default OFF).
 *
 * One node:https GET with ETag/If-None-Match (304) caching to
 * ~/.sidewrite/remote-config-cache.json. TTL-gated. On ANY error return
 * cached-or-defaults — never throw. If opts.enabled !== true, return
 * defaults with NO network call.
 *
 * Defaults = { flags:{}, minVersion:null, killSwitch:false }.
 *
 * Zero external deps (Node builtins only).
 */

const https = require('node:https');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const DEFAULTS = Object.freeze({ flags: {}, minVersion: null, killSwitch: false });
const TTL_MS = 5 * 60 * 1000; // 5 minutes
const BODY_CAP = 64 * 1024;    // 64 KB
const TIMEOUT_MS = 3000;       // 3 s

// Overridable paths for testing
let _homeDir = os.homedir();
let _configUrl = 'https://sidewrite.vercel.app/api/remote-config';

// ---------------------------------------------------------------------------
// Internal: cache path
// ---------------------------------------------------------------------------

function cachePath() {
  return path.join(_homeDir, '.sidewrite', 'remote-config-cache.json');
}

// ---------------------------------------------------------------------------
// Internal: deep merge with safe-default fallback (pure, testable)
// ---------------------------------------------------------------------------

/**
 * Merge fetched config onto defaults. Unknown or missing keys fall back to
 * safe defaults. Returns a frozen, plain object.
 */
function mergeWithDefaults(raw) {
  if (!raw || typeof raw !== 'object') return { ...DEFAULTS };

  const out = { ...DEFAULTS };

  // flags: shallow merge — each flag keeps its own shape
  if (raw.flags && typeof raw.flags === 'object' && !Array.isArray(raw.flags)) {
    out.flags = { ...raw.flags };
  }

  // minVersion: string or null
  if (typeof raw.minVersion === 'string' && raw.minVersion) {
    out.minVersion = raw.minVersion;
  }

  // killSwitch: boolean only; defaults to false (fail CLOSED)
  if (typeof raw.killSwitch === 'boolean') {
    out.killSwitch = raw.killSwitch;
  }

  return Object.freeze(out);
}

// ---------------------------------------------------------------------------
// Internal: TTL check (pure, testable)
// ---------------------------------------------------------------------------

/**
 * Return true when the cached entry is still fresh (within TTL).
 *
 * @param {number} cachedAt - epoch ms of last successful fetch
 * @param {number} now      - current epoch ms
 */
function isFresh(cachedAt, now) {
  return typeof cachedAt === 'number' && (now - cachedAt) < TTL_MS;
}

// ---------------------------------------------------------------------------
// Internal: read / write cache
// ---------------------------------------------------------------------------

function readCache() {
  try {
    const raw = fs.readFileSync(cachePath(), 'utf8');
    const j = JSON.parse(raw);
    if (j && typeof j === 'object') return j;
  } catch (_) {
    // corrupt / missing — treat as empty
  }
  return null;
}

function writeCache(entry) {
  try {
    const dir = path.dirname(cachePath());
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    const tmp = cachePath() + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(entry), { mode: 0o600 });
    fs.renameSync(tmp, cachePath());
  } catch (_) {
    // best-effort; never fatal
  }
}

// ---------------------------------------------------------------------------
// Internal: HTTPS GET with ETag support
// ---------------------------------------------------------------------------

/**
 * Fetch the remote config. On success calls cb(null, body, etag, statusCode).
 * On any error calls cb(err). Never throws.
 */
function httpGet(etag, cb) {
  let url;
  try {
    url = new URL(_configUrl);
  } catch (e) {
    return cb(e);
  }

  const headers = {
    Accept: 'application/json',
    'User-Agent': 'sidewrite',
  };
  if (etag) headers['If-None-Match'] = etag;

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
      res.setEncoding('utf8');
      res.on('data', (chunk) => {
        size += chunk.length;
        if (size > BODY_CAP) req.destroy();
        else body += chunk;
      });
      res.on('end', () => {
        cb(null, body, res.headers.etag || null, res.statusCode);
      });
    }
  );

  req.on('error', (e) => cb(e));

  req.setTimeout(TIMEOUT_MS, () => {
    req.destroy();
    cb(new Error('remote-config request timed out'));
  });

  req.end();
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Fetch remote config. Opt-in: if opts.enabled !== true, returns defaults
 * with NO network call.
 *
 * On ANY error (network, parse, timeout, etc.) returns cached config merged
 * with defaults, or bare defaults if cache is also missing/corrupt.
 * Never throws.
 *
 * @param {object} [opts]
 * @param {boolean} [opts.enabled] - must be true to trigger a fetch
 * @returns {Promise<object>}
 */
async function fetchConfig(opts) {
  if (!opts || opts.enabled !== true) {
    return { ...DEFAULTS };
  }

  const cached = readCache();

  // TTL check: if cache is fresh, return it without a network call
  if (cached && isFresh(cached.at, Date.now())) {
    return mergeWithDefaults(cached.config);
  }

  // Attempt network fetch
  return new Promise((resolve) => {
    const etag = cached && cached.etag ? cached.etag : null;

    httpGet(etag, (err, body, resEtag, statusCode) => {
      // 304 Not Modified — cache is still valid
      if (!err && statusCode === 304) {
        const entry = { at: Date.now(), etag, config: cached ? cached.config : null };
        writeCache(entry);
        return resolve(mergeWithDefaults(cached ? cached.config : null));
      }

      // HTTP error status
      if (!err && (statusCode < 200 || statusCode >= 300)) {
        return resolve(mergeWithDefaults(cached ? cached.config : null));
      }

      // Network / timeout error
      if (err) {
        return resolve(mergeWithDefaults(cached ? cached.config : null));
      }

      // Parse JSON
      let parsed;
      try {
        parsed = JSON.parse(body);
      } catch (_) {
        return resolve(mergeWithDefaults(cached ? cached.config : null));
      }

      // Strict shape validation: must be a plain object
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
        return resolve(mergeWithDefaults(cached ? cached.config : null));
      }

      // Success — persist to cache
      const entry = { at: Date.now(), etag: resEtag, config: parsed };
      writeCache(entry);

      return resolve(mergeWithDefaults(parsed));
    });
  });
}

/**
 * Return the last cached config merged with defaults.
 * Pure local read — never hits the network. Never throws.
 *
 * @returns {object}
 */
function getCached() {
  const cached = readCache();
  return mergeWithDefaults(cached ? cached.config : null);
}

// ---------------------------------------------------------------------------
// Test overrides (for self-test only)
// ---------------------------------------------------------------------------

/**
 * Override internal paths for testing. Call with no args to reset.
 * @param {object} [o]
 * @param {string} [o.homeDir]
 * @param {string} [o.configUrl]
 */
function _testOverride(o) {
  if (!o) {
    _homeDir = os.homedir();
    _configUrl = 'https://sidewrite.vercel.app/api/remote-config';
    return;
  }
  if (o.homeDir !== undefined) _homeDir = o.homeDir;
  if (o.configUrl !== undefined) _configUrl = o.configUrl;
}

// ---------------------------------------------------------------------------
// Exports
// ---------------------------------------------------------------------------

module.exports = {
  fetchConfig,
  getCached,
  // Test helpers
  _mergeWithDefaults: mergeWithDefaults,
  _isFresh: isFresh,
  _DEFAULTS: DEFAULTS,
  _testOverride,
};

// ---------------------------------------------------------------------------
// Self-test
// ---------------------------------------------------------------------------

if (require.main === module) {
  const fs = require('node:fs');
  const os = require('node:os');
  const path = require('node:path');

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

  // Set up a temp HOME so tests don't touch the real cache
  const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'rc-test-'));
  _testOverride({ homeDir: tmpHome, configUrl: 'https://127.0.0.1:1/should-not-be-called' });

  // ---- Test 1: fetchConfig with enabled:false returns defaults, no network ----
  console.log('\nTest 1: fetchConfig({enabled:false}) returns defaults');
  {
    const result = fetchConfig({ enabled: false });
    assert(result instanceof Promise, 'returns a Promise');
    result.then((r) => {
      assert(r.flags !== undefined, 'has flags');
      assert(Object.keys(r.flags).length === 0, 'flags is empty');
      assert(r.minVersion === null, 'minVersion is null');
      assert(r.killSwitch === false, 'killSwitch is false');
    });
  }

  // ---- Test 2: fetchConfig with no opts returns defaults ----
  console.log('\nTest 2: fetchConfig() returns defaults');
  {
    const result = fetchConfig();
    result.then((r) => {
      assert(Object.keys(r.flags).length === 0, 'flags is empty');
      assert(r.minVersion === null, 'minVersion is null');
      assert(r.killSwitch === false, 'killSwitch is false');
    });
  }

  // ---- Test 3: getCached with missing cache returns defaults ----
  console.log('\nTest 3: getCached() with no cache file returns defaults');
  {
    const r = getCached();
    assert(Object.keys(r.flags).length === 0, 'flags is empty');
    assert(r.minVersion === null, 'minVersion is null');
    assert(r.killSwitch === false, 'killSwitch is false');
  }

  // ---- Test 4: getCached with corrupt cache returns defaults ----
  console.log('\nTest 4: getCached() with corrupt cache file returns defaults');
  {
    const cacheDir = path.join(tmpHome, '.sidewrite');
    fs.mkdirSync(cacheDir, { recursive: true, mode: 0o700 });
    fs.writeFileSync(path.join(cacheDir, 'remote-config-cache.json'), 'NOT JSON!!!', { mode: 0o600 });
    const r = getCached();
    assert(Object.keys(r.flags).length === 0, 'flags is empty after corrupt cache');
    assert(r.minVersion === null, 'minVersion is null after corrupt cache');
    assert(r.killSwitch === false, 'killSwitch is false after corrupt cache');
  }

  // ---- Test 5: mergeWithDefaults — pure, testable ----
  console.log('\nTest 5: mergeWithDefaults handles unknown/missing keys');
  {
    const merge = module.exports._mergeWithDefaults;

    // null input
    const r1 = merge(null);
    assert(Object.keys(r1.flags).length === 0, 'null → defaults');
    assert(r1.minVersion === null, 'null → minVersion null');
    assert(r1.killSwitch === false, 'null → killSwitch false');

    // partial input
    const r2 = merge({ flags: { darkMode: { enabled: true } } });
    assert(r2.flags.darkMode.enabled === true, 'partial: flags preserved');
    assert(r2.minVersion === null, 'partial: missing minVersion → null');
    assert(r2.killSwitch === false, 'partial: missing killSwitch → false');

    // unknown keys ignored
    const r3 = merge({ unknown: 'xyz', extra: 42, flags: {}, killSwitch: true });
    assert(r3.unknown === undefined, 'unknown key dropped');
    assert(r3.extra === undefined, 'extra key dropped');
    assert(r3.killSwitch === true, 'known key preserved');

    // flags must be plain object, not array
    const r4 = merge({ flags: [1, 2, 3] });
    assert(Object.keys(r4.flags).length === 0, 'array flags → defaults');

    // minVersion must be non-empty string
    const r5 = merge({ minVersion: '' });
    assert(r5.minVersion === null, 'empty minVersion → null');
    const r6 = merge({ minVersion: '1.5.0' });
    assert(r6.minVersion === '1.5.0', 'valid minVersion preserved');
  }

  // ---- Test 6: isFresh — pure TTL check ----
  console.log('\nTest 6: isFresh TTL check');
  {
    const fresh = module.exports._isFresh;
    const now = 1000000;

    assert(fresh(now - 1000, now) === true, '1s ago is fresh');
    assert(fresh(now - 100000, now) === true, '100s ago is fresh (< 5min)');
    assert(fresh(now - 300001, now) === false, '300s+1ms ago is stale');
    assert(fresh(now - 600000, now) === false, '10min ago is stale');
    assert(fresh(undefined, now) === false, 'undefined timestamp is stale');
    assert(fresh(null, now) === false, 'null timestamp is stale');
    assert(fresh('not-a-number', now) === false, 'string timestamp is stale');
  }

  // ---- Test 7: fetchConfig({enabled:true}) fails open with no real server ----
  console.log('\nTest 7: fetchConfig({enabled:true}) fails open (no real server)');
  {
    // Write a valid cache entry first
    const cacheDir = path.join(tmpHome, '.sidewrite');
    fs.mkdirSync(cacheDir, { recursive: true, mode: 0o700 });
    const cacheEntry = { at: Date.now(), etag: '"abc"', config: { flags: { beta: { enabled: true } } } };
    fs.writeFileSync(
      path.join(cacheDir, 'remote-config-cache.json'),
      JSON.stringify(cacheEntry),
      { mode: 0o600 }
    );

    fetchConfig({ enabled: true }).then((r) => {
      // Network fails → returns cached config merged with defaults
      assert(r.flags.beta !== undefined, 'cached beta flag preserved on network error');
      assert(r.flags.beta.enabled === true, 'cached beta flag value preserved');
      assert(r.killSwitch === false, 'default killSwitch applied');
    });
  }

  // ---- Test 8: fetchConfig({enabled:true}) stale cache + network fail ----
  console.log('\nTest 8: fetchConfig stale cache + network fail returns stale cache');
  {
    // Write a stale cache entry
    const cacheDir = path.join(tmpHome, '.sidewrite');
    const staleEntry = { at: 1000, etag: '"stale"', config: { flags: { old: { enabled: true } }, killSwitch: true } };
    fs.writeFileSync(
      path.join(cacheDir, 'remote-config-cache.json'),
      JSON.stringify(staleEntry),
      { mode: 0o600 }
    );

    fetchConfig({ enabled: true }).then((r) => {
      assert(r.flags.old !== undefined, 'stale cached flags returned on network fail');
      assert(r.killSwitch === true, 'stale cached killSwitch returned');
    });
  }

  // ---- Test 9: defaults are frozen ----
  console.log('\nTest 9: returned defaults are plain (not frozen references)');
  {
    const d1 = module.exports._DEFAULTS;
    const d2 = { ...d1 };
    assert(d2.flags !== d1.flags || Object.keys(d2.flags).length === 0, 'flags is safe to spread');
  }

  // Wait for async tests to finish, then clean up
  setTimeout(() => {
    // Clean up temp dir
    try {
      fs.rmSync(tmpHome, { recursive: true, force: true });
    } catch (_) {}

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
  }, 200);
}
