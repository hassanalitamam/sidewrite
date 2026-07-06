#!/usr/bin/env node
'use strict';

/*
 * semver.cjs — tiny numeric semver comparator (node builtins only, zero deps).
 *
 * Strips a leading "v", strips any pre-release/build suffix (from the first
 * "-" or "+"), splits on ".", compares segments numerically, and treats
 * missing segments as 0 (so "1.2" === "1.2.0").
 */

/**
 * @returns {{ nums: number[], pre: string|null }} normalised core segments
 * plus any pre-release identifier. NaN segments coerce to 0 (deterministic),
 * build metadata (after "+") is dropped, and a "-suffix" marks a pre-release.
 */
function parse(v) {
  const raw = String(v).replace(/^v/, '').split('+')[0]; // drop build metadata
  const dash = raw.indexOf('-');
  const core = dash === -1 ? raw : raw.slice(0, dash);
  const pre = dash === -1 ? null : raw.slice(dash + 1);
  const nums = core.split('.').map((x) => {
    const n = Number(x);
    return Number.isFinite(n) ? n : 0; // guard non-numeric segments (e.g. "1.2.x")
  });
  return { nums, pre };
}

function semverCompare(a, b) {
  const pa = parse(a), pb = parse(b);
  const len = Math.max(pa.nums.length, pb.nums.length);
  for (let i = 0; i < len; i++) {
    const na = pa.nums[i] || 0, nb = pb.nums[i] || 0;
    if (na < nb) return -1;
    if (na > nb) return 1;
  }
  // Equal numeric cores: a pre-release is LESS than the same release version
  // (1.2.0 > 1.2.0-beta). Two pre-releases are treated as equal.
  if (pa.pre && !pb.pre) return -1;
  if (!pa.pre && pb.pre) return 1;
  return 0;
}

function semverGt(a, b) {
  return semverCompare(a, b) === 1;
}

module.exports = { semverGt, semverCompare };

/* ── self-test ──────────────────────────────────────────────────────────── */
if (require.main === module) {
  let pass = 0, fail = 0;
  function assert(cond, label) {
    if (cond) { pass++; console.log('  ✓ ' + label); }
    else      { fail++; console.error('  ✗ ' + label); }
  }

  console.log('semver.cjs self-test:');
  assert(semverGt('1.2.10', '1.2.9') === true,   'semverGt("1.2.10","1.2.9") === true');
  assert(semverGt('1.2.9', '1.2.10') === false,  'semverGt("1.2.9","1.2.10") === false');
  assert(semverGt('1.2.0', '1.2.0') === false,   'semverGt("1.2.0","1.2.0") === false');
  assert(semverGt('v2.0.0', '1.9.9') === true,   'semverGt("v2.0.0","1.9.9") === true');
  assert(semverGt('1.2.0-beta', '1.2.0') === false, 'semverGt("1.2.0-beta","1.2.0") === false');
  assert(semverCompare('1.2', '1.2.0') === 0,     'semverCompare("1.2","1.2.0") === 0');

  // pre-release ordering: a release is strictly newer than its own pre-release
  assert(semverGt('1.2.0', '1.2.0-beta') === true,  'semverGt("1.2.0","1.2.0-beta") === true');
  assert(semverCompare('1.2.0', '1.2.0-beta') === 1,  'semverCompare("1.2.0","1.2.0-beta") === 1');
  assert(semverCompare('1.2.0-beta', '1.2.0') === -1, 'semverCompare("1.2.0-beta","1.2.0") === -1');
  assert(semverCompare('1.2.0-beta', '1.2.0-alpha') === 0, 'two pre-releases compare equal');
  // build metadata is ignored in precedence
  assert(semverCompare('1.2.0+build9', '1.2.0') === 0, 'build metadata ignored');
  // non-numeric segment coerces to 0 deterministically ("1.2.x" -> 1.2.0)
  assert(semverCompare('1.2.x', '1.2.0') === 0, 'non-numeric segment coerces to 0');

  console.log('\nResult: ' + (fail === 0 ? 'PASS' : 'FAIL'));
  if (fail !== 0) process.exit(1);
}
