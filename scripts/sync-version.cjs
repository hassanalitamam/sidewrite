#!/usr/bin/env node
'use strict';

/*
 * sync-version.cjs — dev-only release helper.
 *
 * Writes ONE version string into all three Sidewrite manifests so they
 * can never drift.  Node builtins only, zero external deps.
 *
 * Usage:  node scripts/sync-version.cjs <version>
 *         e.g.  node scripts/sync-version.cjs 1.3.0
 */

const fs   = require('fs');
const path = require('path');

// ── Paths (relative to repo root) ──────────────────────────────────────────
const ROOT = path.resolve(__dirname, '..');
const MANIFESTS = [
  { label: 'package.json',                   file: path.join(ROOT, 'package.json') },
  { label: 'plugin/.claude-plugin/plugin.json', file: path.join(ROOT, 'plugin', '.claude-plugin', 'plugin.json') },
  { label: 'marketplace.json',               file: path.join(ROOT, 'plugin', '.claude-plugin', 'marketplace.json') },
];

// ── Pure helpers (exported for self-test) ───────────────────────────────────

/** Returns true iff `v` is a plain X.Y.Z string with non-negative integers. */
function validateVersion(v) {
  return /^\d+\.\d+\.\d+$/.test(v);
}

/**
 * Set ONLY the known version paths (never a blind recursive replace):
 *   - top-level `version`            (package.json, plugin.json, marketplace.json)
 *   - each `plugins[].version` entry (marketplace.json)
 *
 * An unrelated nested `version` key (e.g. a dependency pin) is left untouched.
 * Returns the mutated object (mutates in-place as well).
 */
function setKnownVersions(obj, version) {
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return obj;

  if ('version' in obj) obj.version = version;

  if (Array.isArray(obj.plugins)) {
    for (const entry of obj.plugins) {
      if (entry && typeof entry === 'object' && !Array.isArray(entry) && 'version' in entry) {
        entry.version = version;
      }
    }
  }
  return obj;
}

/**
 * Given the raw text of a manifest and a target version, return the updated
 * JSON string (2-space indent, trailing newline).  Pure — no file I/O.
 *
 * Returns { before, after } where `before` is the old version (or null if
 * the file had no version field) and `after` is the serialised JSON string.
 */
function processManifest(raw, version) {
  const obj = JSON.parse(raw);
  const before = obj.version || null;
  setKnownVersions(obj, version);
  const after = JSON.stringify(obj, null, 2) + '\n';
  return { before, after };
}

module.exports = {
  validateVersion,
  setKnownVersions,
  // Back-compat alias for older callers; now targets only known paths.
  setAllVersions: setKnownVersions,
  processManifest,
};

// ── Self-test (does NOT touch real manifests) ──────────────────────────────
if (require.main === module && (process.argv[2] === '--test' || process.env.SYNC_VERSION_TEST)) {
  let pass = 0, fail = 0;
  function assert(cond, label) {
    if (cond) { pass++; console.log('  ✓ ' + label); }
    else      { fail++; console.error('  ✗ ' + label); }
  }

  console.log('sync-version.cjs self-test:');

  // validateVersion
  assert(validateVersion('1.3.0') === true,   'validateVersion("1.3.0") === true');
  assert(validateVersion('v1.3.0') === false,  'validateVersion("v1.3.0") === false');
  assert(validateVersion('1.3') === false,     'validateVersion("1.3") === false');
  assert(validateVersion('1.3.0-beta') === false, 'validateVersion("1.3.0-beta") === false');

  // processManifest on in-memory samples
  const samplePkg = JSON.stringify({ name: 'sidewrite', version: '1.2.0' }, null, 2) + '\n';
  const r1 = processManifest(samplePkg, '1.3.0');
  assert(r1.before === '1.2.0', 'processManifest: before === "1.2.0"');
  assert(r1.after.includes('"version": "1.3.0"'), 'processManifest: after contains new version');
  assert(r1.after.endsWith('\n'), 'processManifest: after ends with newline');

  // idempotency
  const r2 = processManifest(r1.after, '1.3.0');
  assert(r2.after === r1.after, 'processManifest: idempotent (same input)');

  // marketplace.json with nested plugin version
  const sampleMarketplace = JSON.stringify({
    name: 'marketplace',
    version: '1.2.0',
    plugins: [{ name: 'sidewrite', version: '1.2.0' }],
  }, null, 2) + '\n';
  const r3 = processManifest(sampleMarketplace, '2.0.0');
  const parsed = JSON.parse(r3.after);
  assert(parsed.version === '2.0.0', 'marketplace: top-level version updated');
  assert(parsed.plugins[0].version === '2.0.0', 'marketplace: plugin entry version updated');

  // regression: an UNRELATED nested `version` key must be left untouched
  const sampleWithNested = JSON.stringify({
    name: 'package',
    version: '1.2.0',
    dependencies: { 'some-lib': { version: '9.9.9' } }, // must NOT be rewritten
    engines: { version: '18.0.0' },                     // must NOT be rewritten
  }, null, 2) + '\n';
  const r4 = processManifest(sampleWithNested, '3.0.0');
  const p4 = JSON.parse(r4.after);
  assert(p4.version === '3.0.0', 'nested-test: top-level version updated');
  assert(p4.dependencies['some-lib'].version === '9.9.9', 'nested-test: dependency version untouched');
  assert(p4.engines.version === '18.0.0', 'nested-test: engines.version untouched');

  console.log('\nResult: ' + (fail === 0 ? 'PASS' : 'FAIL'));
  if (fail !== 0) process.exit(1);
}

// ── CLI entry-point ────────────────────────────────────────────────────────
if (require.main === module && !process.env.SYNC_VERSION_TEST && process.argv[2] !== '--test') {
  const version = process.argv[2];

  if (!version || !validateVersion(version)) {
    console.error('Usage: node scripts/sync-version.cjs <X.Y.Z>');
    console.error('  e.g. node scripts/sync-version.cjs 1.3.0');
    process.exit(1);
  }

  // Atomic-ish: read + parse + compute EVERY manifest first. Only if all of
  // them parse cleanly do we touch the disk, so a malformed manifest can never
  // leave the three files half-updated / out of sync.
  const plan = [];
  for (const { label, file } of MANIFESTS) {
    let raw;
    try {
      raw = fs.readFileSync(file, 'utf8');
    } catch {
      console.warn('WARN: ' + label + ' not found — skipping');
      continue;
    }

    let result;
    try {
      result = processManifest(raw, version);
    } catch (e) {
      console.error('ERROR: ' + label + ' is not valid JSON — aborting, no files written.');
      console.error('  ' + e.message);
      process.exit(1);
    }
    plan.push({ label, file, raw, ...result });
  }

  // Commit phase — every manifest parsed OK, now write.
  for (const { label, file, raw, before, after } of plan) {
    if (after === raw) {
      console.log(label + ': already ' + version + ' (no change)');
    } else {
      fs.writeFileSync(file, after, 'utf8');
      console.log(label + ': ' + (before || '(none)') + ' → ' + version);
    }
  }
}
