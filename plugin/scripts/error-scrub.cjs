'use strict';

const crypto = require('node:crypto');
const os = require('node:os');

// ---------------------------------------------------------------------------
// Regex patterns for secret / PII detection
// ---------------------------------------------------------------------------

const PATTERNS = {
  // API keys: sk-ant-…, sk-… (case-insensitive — vendors accept mixed case)
  apiKey: /sk-ant-[\w-]*\w|sk-[\w-]*\w/gi,
  // Bearer tokens (case-insensitive: Bearer / bearer / BEARER)
  bearer: /Bearer\s+[A-Za-z0-9\-._~+/]+=*/gi,
  // GitHub personal-access / app tokens: ghp_, gho_, ghu_, ghs_, ghr_
  github: /gh[oprsu]_[A-Za-z0-9]{16,}/gi,
  // Slack tokens: xoxb-, xoxa-, xoxp-, xoxr-, xoxs-
  slack: /xox[baprs]-[A-Za-z0-9-]+/gi,
  // AWS access key IDs
  awsKey: /AKIA[0-9A-Z]{16}/g,
  // Google API keys
  gcpKey: /AIza[0-9A-Za-z_-]{35}/g,
  // JWTs: three base64url segments joined by dots
  jwt: /eyJ[A-Za-z0-9_-]+\.eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/g,
  // Hex runs >= 32 chars
  hex: /[0-9a-fA-F]{32,}/g,
  // Generic high-entropy base64 run >= 40 chars
  base64: /[A-Za-z0-9+/]{40,}={0,2}/g,
  // Emails
  email: /[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/g,
  // IPv4
  ipv4: /\b(?:\d{1,3}\.){3}\d{1,3}\b/g,
  // IPv6 (full and compressed)
  ipv6: /(?:[0-9a-fA-F]{1,4}:){7}[0-9a-fA-F]{1,4}|(?:[0-9a-fA-F]{1,4}:){1,7}:|(?:[0-9a-fA-F]{1,4}:){1,6}:[0-9a-fA-F]{1,4}|(?:[0-9a-fA-F]{1,4}:){1,5}(?::[0-9a-fA-F]{1,4}){1,2}|(?:[0-9a-fA-F]{1,4}:){1,4}(?::[0-9a-fA-F]{1,4}){1,3}|(?:[0-9a-fA-F]{1,4}:){1,3}(?::[0-9a-fA-F]{1,4}){1,4}|(?:[0-9a-fA-F]{1,4}:){1,2}(?::[0-9a-fA-F]{1,4}){1,5}|[0-9a-fA-F]{1,4}:(?::[0-9a-fA-F]{1,4}){1,6}|:(?::[0-9a-fA-F]{1,4}){1,7}|::/g,
  // Absolute POSIX paths: any /a/b/c shape (>=2 dirs + leaf), not a fixed allowlist
  absPathPosix: /\/(?:[\w.-]+\/){2,}[\w.-]+/g,
  // Absolute Windows paths: C:\a\b\c
  absPathWin: /[A-Za-z]:\\(?:[\w.-]+\\)+[\w.-]+/g,
};

// Home directory to replace with ~
const HOME_DIR = os.homedir();

// Allowlisted safe fields
const SAFE_FIELDS = new Set([
  'kind', 'code', 'statusCode', 'provider', 'model', 'message', 'frames',
]);

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * SHA-256 hash, first 8 hex chars.
 */
function hash8(value) {
  return crypto.createHash('sha256').update(String(value)).digest('hex').slice(0, 8);
}

/**
 * Scrub a single string value: replace all sensitive patterns with placeholders.
 */
function scrubString(str) {
  if (typeof str !== 'string') return str;

  let out = str;

  // Order matters: home dir first (longest match), then keys, then paths,
  // then generic entropy runs, then emails/IPs.
  if (HOME_DIR) {
    out = out.split(HOME_DIR).join('~');
  }
  out = out.replace(PATTERNS.apiKey, '[REDACTED_KEY]');
  out = out.replace(PATTERNS.bearer, '[REDACTED_KEY]');
  out = out.replace(PATTERNS.github, '[REDACTED_KEY]');
  out = out.replace(PATTERNS.slack, '[REDACTED_KEY]');
  out = out.replace(PATTERNS.awsKey, '[REDACTED_KEY]');
  out = out.replace(PATTERNS.gcpKey, '[REDACTED_KEY]');
  out = out.replace(PATTERNS.jwt, '[jwt]');
  out = out.replace(PATTERNS.absPathWin, '[path]');
  out = out.replace(PATTERNS.absPathPosix, '[path]');
  out = out.replace(PATTERNS.hex, '[hex]');
  out = out.replace(PATTERNS.base64, '[hex]');
  out = out.replace(PATTERNS.email, '[email]');
  out = out.replace(PATTERNS.ipv6, '[ip]');
  out = out.replace(PATTERNS.ipv4, '[ip]');

  return out;
}

/**
 * Scrub a payload field: strings go through scrubString; numbers and booleans
 * are preserved as-is (never coerced to string); anything else is stringified
 * and scrubbed as a fail-safe.
 */
function scrubValue(val) {
  if (typeof val === 'string') return scrubString(val);
  if (typeof val === 'number' || typeof val === 'boolean') return val;
  return scrubString(String(val));
}

/**
 * Parse a raw stack string into an array of { fn, file } objects.
 * Each frame: `at fn (file:line:col)` or `at file:line:col` (anonymous).
 */
function parseStack(raw) {
  if (typeof raw !== 'string') return [];

  const lines = raw.split('\n');
  const frames = [];

  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed.startsWith('at ')) continue;

    const rest = trimmed.slice(3);

    // Try to match: name (file:line:col)
    const withParens = rest.match(/^(.+?) \(((?:[^\)]*?):\d+(?::\d+)?)\)\s*$/);
    if (withParens) {
      frames.push({ fn: withParens[1], file: withParens[2] });
      continue;
    }

    // Try to match: file:line:col (anonymous, no parens)
    const bareLoc = rest.match(/^((?:[^\s:]*?):\d+(?::\d+)?)\s*$/);
    if (bareLoc) {
      frames.push({ fn: null, file: bareLoc[1] });
      continue;
    }

    // Name only, no file
    frames.push({ fn: rest, file: null });
  }

  return frames;
}

// ---------------------------------------------------------------------------
// Main export
// ---------------------------------------------------------------------------

/**
 * Scrub a raw event into a safe, anonymized payload.
 *
 * @param {object} rawEvent - The raw error/event object.
 * @returns {object|null} Safe payload, or null to drop the event.
 */
function scrub(rawEvent) {
  if (!rawEvent || typeof rawEvent !== 'object') return null;

  // Build payload from allowlist only
  const payload = {};

  for (const field of SAFE_FIELDS) {
    if (field === 'frames') continue; // handled below
    const val = rawEvent[field];
    if (val !== undefined && val !== null) {
      payload[field] = scrubValue(val);
    }
  }

  // Also check rawEvent.error for nested error objects
  const errorObj = rawEvent.error;
  if (errorObj && typeof errorObj === 'object') {
    for (const field of SAFE_FIELDS) {
      if (field === 'frames') continue;
      if (payload[field] !== undefined) continue; // already set from rawEvent
      const val = errorObj[field];
      if (val !== undefined && val !== null) {
        payload[field] = scrubValue(val);
      }
    }
  }

  // Parse stack frames from rawEvent.stack or rawEvent.error.stack
  const rawStack = rawEvent.stack || (errorObj && errorObj.stack);
  if (typeof rawStack === 'string') {
    const parsed = parseStack(rawStack);
    const frames = [];

    for (const { fn, file } of parsed) {
      if (!file && !fn) continue;

      // Detect node_modules on both POSIX (/) and Windows (\) separators.
      const isNodeModules = file && /node_modules[\\/]/.test(file);

      let module = null;
      if (file) {
        const nmMatch = file.match(/node_modules[\\/]([^\\/]+)/);
        if (nmMatch) {
          module = 'node_modules/' + nmMatch[1];
        } else {
          // File basename (strip line/col), splitting on BOTH / and \
          // so a Windows path never ships its full directory + username.
          const pathPart = file.replace(/:\d+(?::\d+)?$/, '');
          const parts = pathPart.split(/[\\/]/);
          module = parts[parts.length - 1] || null;
        }
      }

      let functionName = null;
      if (fn) {
        if (isNodeModules) {
          // Keep real function name for node_modules frames
          functionName = fn;
        } else {
          // User-project frame: hash the function name for privacy
          functionName = fn ? 'fn_' + hash8(fn) : null;
        }
      }

      // Fail-closed parity with scrubString: frame fn/module were never
      // routed through the scrubber before, so run them now.
      frames.push({
        function: scrubString(functionName),
        module: scrubString(module),
      });
    }

    payload.frames = frames;
  }

  // Belt-and-suspenders: serialize and sweep for leaked secrets
  let json;
  try {
    json = JSON.stringify(payload);
  } catch (e) {
    return null;
  }

  // Final sweep: if ANY key-shaped token survives, drop the event.
  // Case-insensitive so `bearer …`, `SK-ANT-…`, `Sk-Ant-…` can never slip past.
  if (
    /sk-/i.test(json) ||
    /Bearer\s/i.test(json) ||
    /gh[oprsu]_[A-Za-z0-9]{16,}/i.test(json) ||
    /xox[baprs]-/i.test(json) ||
    /AKIA[0-9A-Z]{16}/.test(json) ||
    /AIza[0-9A-Za-z_-]{35}/.test(json) ||
    /eyJ[A-Za-z0-9_-]+\./.test(json) ||
    /[0-9a-fA-F]{32,}/.test(json) ||
    /[A-Za-z0-9+/]{40,}={0,2}/.test(json)
  ) {
    return null;
  }

  return payload;
}

// ---------------------------------------------------------------------------
// Exports
// ---------------------------------------------------------------------------

module.exports = { scrub, scrubString, parseStack, hash8 };

// ---------------------------------------------------------------------------
// Self-test
// ---------------------------------------------------------------------------

if (require.main === module) {
  let passed = 0;
  let failed = 0;

  function assert(condition, label) {
    if (condition) {
      console.log('  PASS: ' + label);
      passed++;
    } else {
      console.error('  FAIL: ' + label);
      failed++;
    }
  }

  function assertNotContains(str, pattern, label) {
    const found = typeof pattern === 'string' ? str.includes(pattern) : pattern.test(str);
    assert(!found, label);
  }

  // ---- Test 1: Message scrubbing ----
  console.log('\nTest 1: Message scrubbing');
  {
    const home = os.homedir();
    const raw = {
      message: 'Key sk-ant-api03-ABCDEF123456 failed for ' + home + '/src/app.js user@example.com eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIiwibmFtZSI6IkpvaG4gRG9lIiwiaWF0IjoxNTE2MjM5MDIyfQ.SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV_adQssw5c aabbccddeeff00112233445566778899aabbccdd',
    };
    const result = scrub(raw);

    assert(result !== null, 'scrub returns non-null');
    assert(typeof result.message === 'string', 'message is a string');
    assertNotContains(result.message, 'sk-ant-api03-ABCDEF123456', 'API key removed');
    assertNotContains(result.message, 'user@example.com', 'email replaced');
    assertNotContains(result.message, 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9', 'JWT replaced');
    assertNotContains(result.message, 'aabbccddeeff00112233445566778899aabbccdd', '40-char hex replaced');
    assert(result.message.includes('[REDACTED_KEY]'), 'has [REDACTED_KEY]');
    assert(result.message.includes('[email]'), 'has [email]');
    assert(result.message.includes('[jwt]'), 'has [jwt]');
    assert(result.message.includes('[hex]'), 'has [hex]');
    if (home !== '~') {
      assertNotContains(result.message, home, 'home dir replaced');
      assert(result.message.includes('~'), 'has ~ for home dir');
    }
  }

  // ---- Test 2: Allowlist-only fields ----
  console.log('\nTest 2: Allowlist-only fields');
  {
    const raw = {
      kind: 'api_error',
      code: 'rate_limit',
      statusCode: 429,
      provider: 'anthropic',
      model: 'claude-3-opus',
      message: 'Rate limited',
      // Secret fields that must NOT appear
      apiKey: 'sk-ant-api03-SECRET123',
      token: 'Bearer super-secret-token',
      password: 'hunter2',
      authorization: 'Bearer xyz',
      nested: { deep: { secret: 'sk-proj-DEEPSECRET' } },
      cookies: 'session=abc123',
    };
    const result = scrub(raw);

    assert(result !== null, 'scrub returns non-null');
    assert(result.kind === 'api_error', 'kind preserved');
    assert(result.code === 'rate_limit', 'code preserved');
    assert(result.statusCode === 429, 'statusCode preserved as number (not coerced to string)');
    assert(result.provider === 'anthropic', 'provider preserved');
    assert(result.model === 'claude-3-opus', 'model preserved');
    assert(result.message === 'Rate limited', 'message preserved');
    assert(result.apiKey === undefined, 'apiKey not in output');
    assert(result.token === undefined, 'token not in output');
    assert(result.password === undefined, 'password not in output');
    assert(result.authorization === undefined, 'authorization not in output');
    assert(result.nested === undefined, 'nested not in output');
    assert(result.cookies === undefined, 'cookies not in output');

    // Verify no secrets leaked in JSON
    const json = JSON.stringify(result);
    assertNotContains(json, 'SECRET123', 'no apiKey secret in JSON');
    assertNotContains(json, 'super-secret-token', 'no token secret in JSON');
    assertNotContains(json, 'hunter2', 'no password in JSON');
    assertNotContains(json, 'DEEPSECRET', 'no nested secret in JSON');
  }

  // ---- Test 3: Stack frame handling ----
  console.log('\nTest 3: Stack frame handling');
  {
    const raw = {
      message: 'Error occurred',
      stack: [
        'Error: something broke',
        '    at processRequest (/Users/test/project/src/handler.js:42:10)',
        '    at Array.map (<anonymous>)',
        '    at Object.<anonymous> (/Users/test/project/node_modules/express/lib/router.js:155:14)',
        '    at Layer.handle [as handle_request] (/Users/test/project/node_modules/express/lib/router/layer.js:95:5)',
        '    at /Users/test/project/src/server.js:10:3',
      ].join('\n'),
    };
    const result = scrub(raw);

    assert(result !== null, 'scrub returns non-null');
    assert(Array.isArray(result.frames), 'frames is an array');
    assert(result.frames.length === 5, 'has 5 frames');

    // Frame 0: user-project frame — function name must be hashed
    const f0 = result.frames[0];
    assert(f0.function !== 'processRequest', 'user frame function name is NOT the real name');
    assert(f0.function === null || f0.function.startsWith('fn_'), 'user frame function is null or hashed');
    assert(f0.module === 'handler.js', 'user frame module is basename');

    // Frame 1: <anonymous> — no file, no real name leaked
    const f1 = result.frames[1];
    assert(f1.module === null, 'anonymous frame has no module');

    // Frame 2: node_modules frame — function name preserved
    const f2 = result.frames[2];
    assert(f2.function === 'Object.<anonymous>', 'node_modules frame function name preserved');
    assert(f2.module === 'node_modules/express', 'node_modules frame module is pkg');

    // Frame 3: node_modules frame with [as ...]
    const f3 = result.frames[3];
    assert(f3.function === 'Layer.handle [as handle_request]', 'node_modules [as] frame name preserved');
    assert(f3.module === 'node_modules/express', 'node_modules [as] frame module is pkg');

    // Frame 4: user-project anonymous frame
    const f4 = result.frames[4];
    assert(f4.function === null, 'user anonymous frame has null function');
    assert(f4.module === 'server.js', 'user anonymous frame module is basename');

    // No absolute paths or line/col in any frame
    const json = JSON.stringify(result.frames);
    assertNotContains(json, '/Users/', 'no absolute paths in frames');
    assertNotContains(json, '/home/', 'no /home/ paths in frames');
    assertNotContains(json, ':42:10', 'no line:col in frames');
    assertNotContains(json, ':155:14', 'no line:col in frames (2)');
  }

  // ---- Test 4: Fail-closed sweep ----
  console.log('\nTest 4: Fail-closed sweep (force-injected secret)');
  {
    // 'sk- ' survives scrubString (the apiKey regex requires \w at the end)
    // but the final sweep catches the 'sk-' prefix in the serialized JSON
    const raw = {
      message: 'error sk- ',
    };
    const result = scrub(raw);
    assert(result === null, 'returns null when sk- survives scrubString but sweep catches it');
  }

  // ---- Test 5: Edge cases ----
  console.log('\nTest 5: Edge cases');
  {
    assert(scrub(null) === null, 'null input returns null');
    assert(scrub(undefined) === null, 'undefined input returns null');
    assert(scrub('string') === null, 'string input returns null');
    assert(scrub(42) === null, 'number input returns null');

    const empty = scrub({});
    assert(empty !== null, 'empty object returns non-null');
    assert(Object.keys(empty).length === 0, 'empty object yields empty payload');

    // Bearer token scrubbing
    const bearer = scrub({ message: 'Bearer eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.abc123def456ghi789jkl012mno345pqr678stu901' });
    assert(bearer !== null, 'Bearer event returns non-null');
    assertNotContains(bearer.message, 'Bearer eyJ', 'Bearer JWT removed');
  }

  // ---- Test 6: Adversarial-review regressions ----
  console.log('\nTest 6: Adversarial-review regressions');
  {
    // #1 Case-insensitivity: lowercase bearer must be redacted or dropped
    {
      const r = scrub({ message: 'auth failed for bearer aVeryOpaqueTokenValue12345' });
      assert(r === null || !r.message.includes('aVeryOpaqueTokenValue12345'),
        '#1 lowercase "bearer <token>" redacted/dropped (no cleartext)');
    }
    // #1 Uppercase SK-ANT- must be redacted or dropped
    {
      const r = scrub({ message: 'SK-ANT-API03-UPPERCASESECRETVALUE' });
      assert(r === null || !r.message.includes('UPPERCASESECRETVALUE'),
        '#1 uppercase SK-ANT- redacted/dropped (no cleartext)');
    }
    // #1 Mixed-case Sk-Ant- / BEARER
    {
      const r = scrub({ message: 'Sk-Ant-Api03-MixedCaseSecretXyz and BEARER TokenABC123' });
      assert(r === null || (!r.message.includes('MixedCaseSecretXyz') && !r.message.includes('TokenABC123')),
        '#1 mixed-case Sk-Ant- and BEARER redacted/dropped');
    }

    // #2 Non-allowlisted absolute POSIX paths must be scrubbed to [path]
    for (const p of ['/app/src/x.js', '/usr/local/lib/foo.js', '/workspace/company/keys.js', '/data/app/db.sqlite']) {
      const out = scrubString('crashed at ' + p);
      assert(!out.includes(p) && out.includes('[path]'), '#2 POSIX path scrubbed: ' + p);
    }
    // #2 Windows absolute path scrubbed
    {
      const out = scrubString('crashed at C:\\Users\\alice\\secret.txt');
      assert(!out.includes('alice') && out.includes('[path]'), '#2 Windows path scrubbed (no username)');
      // Homedir rule still runs first — a homedir path becomes ~, not [path]
      if (os.homedir() && os.homedir() !== '~') {
        const h = scrubString(os.homedir() + '/whatever');
        assert(h.startsWith('~'), '#2 homedir→~ rule still applies first');
      }
    }

    // #3 Windows node_modules stack frame → module is pkg, full path + username gone
    {
      const r = scrub({
        message: 'boom',
        stack: [
          'Error: boom',
          '    at foo (C:\\Users\\alice\\node_modules\\express\\lib\\layer.js:95:5)',
        ].join('\n'),
      });
      assert(r !== null, '#3 windows-frame event returns non-null');
      const fr = r.frames[0];
      assert(fr.module === 'node_modules/express', '#3 windows node_modules module is pkg');
      const fj = JSON.stringify(r.frames);
      assert(!fj.includes('alice') && !fj.includes('C:'), '#3 no username / drive path leaked in frame');
    }

    // #4 Vendor secrets: ghp_, xoxb-, AKIA…, AIza… redacted or dropped
    {
      const ghp = 'ghp_' + 'A'.repeat(36);
      const r = scrub({ message: 'token ' + ghp });
      assert(r === null || !r.message.includes(ghp), '#4 ghp_ token redacted/dropped');
    }
    {
      const aws = 'AKIA' + 'ABCDEFGHIJKLMNOP';
      const r = scrub({ message: 'key ' + aws });
      assert(r === null || !r.message.includes(aws), '#4 AKIA key redacted/dropped');
    }
    {
      const aiza = 'AIza' + 'B'.repeat(35);
      const r = scrub({ message: 'gcp ' + aiza });
      assert(r === null || !r.message.includes(aiza), '#4 AIza key redacted/dropped');
    }
    {
      const xox = 'xoxb-123456789012-abcdefABCDEF';
      const r = scrub({ message: 'slack ' + xox });
      assert(r === null || !r.message.includes(xox), '#4 xoxb- token redacted/dropped');
    }
    {
      const blob = 'Zm9vYmFyYmF6' + 'A'.repeat(40); // >=40 high-entropy base64 run
      const r = scrub({ message: 'blob ' + blob });
      assert(r === null || !r.message.includes(blob), '#4 generic base64 run redacted/dropped');
    }

    // #5 Frame function / module strings routed through scrubString
    {
      const r = scrub({
        message: 'boom',
        stack: [
          'Error: boom',
          // a node_modules frame whose function name embeds a secret
          '    at handler_sk-ant-api03-LEAKINFN (/x/y/node_modules/express/lib/z.js:1:1)',
        ].join('\n'),
      });
      // Either the secret is scrubbed out of the function string, or the event drops.
      assert(r === null || !JSON.stringify(r.frames).includes('sk-ant-api03-LEAKINFN'),
        '#5 secret in frame function name is scrubbed/dropped');
    }

    // #6 Numbers/booleans preserved as-is (not coerced to string)
    {
      const r = scrub({ statusCode: 429, message: 'x' });
      assert(r.statusCode === 429, '#6 numeric statusCode stays a number');
      assert(typeof r.statusCode === 'number', '#6 statusCode typeof number');
    }
  }

  // ---- Summary ----
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
}
