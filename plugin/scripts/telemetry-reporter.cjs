'use strict';

const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');
const https = require('node:https');

const MAX_FILES = 100;
const MAX_BYTES = 5 * 1024 * 1024; // 5 MB
const BACKOFF_BASE_MS = 1000;
const BACKOFF_CAP_MS = 5 * 60 * 1000; // 5 min
const MAX_ATTEMPTS = 6;
const TIMEOUT_MS = 10000; // 10 s per-request timeout (mirrors remote-config.cjs)
const DROPPED_COUNT_FILE = '.dropped_count';

// ── helpers (exported for unit-test) ─────────────────────────────────────────

function computeBackoffDelayMs(attempt, jitterMs) {
  const exp = Math.min(BACKOFF_BASE_MS * Math.pow(2, attempt), BACKOFF_CAP_MS);
  return exp + Math.floor(Math.random() * (jitterMs + 1));
}

function parseRetryAfter(headerVal) {
  if (headerVal == null) return null;
  const secs = Number(headerVal);
  if (Number.isFinite(secs) && secs >= 0) return _clampRetryAfter(secs * 1000);
  const ms = Date.parse(headerVal);
  if (Number.isFinite(ms)) {
    const delta = ms - Date.now();
    return delta > 0 ? _clampRetryAfter(delta) : null;
  }
  return null;
}

// Clamp any Retry-After delay to the backoff cap. A hostile or buggy collector
// can send `Retry-After: 999999999` or a far-future HTTP-date; without this a
// single 429 would sleep flush() for days. Capping keeps the honored delay
// bounded while still respecting the server's intent to slow us down.
function _clampRetryAfter(ms) {
  return Math.min(ms, BACKOFF_CAP_MS);
}

// ── queue path ───────────────────────────────────────────────────────────────

function defaultQueueDir() {
  return path.join(os.homedir(), '.sidewrite', 'telemetry-queue');
}

// ── enqueue ──────────────────────────────────────────────────────────────────

function enqueue(safeEvent, opts) {
  const queueDir = (opts && opts.queueDir) || defaultQueueDir();
  fs.mkdirSync(queueDir, { recursive: true, mode: 0o700 });

  // enforce caps: 100 files / 5 MB  (drop oldest)
  _enforceCaps(queueDir);

  const ts = Date.now();
  const id = crypto.randomUUID();
  const file = path.join(queueDir, `${ts}-${id}.json`);
  const tmp = file + '.tmp';

  fs.writeFileSync(tmp, JSON.stringify(safeEvent), { mode: 0o600 });
  fs.renameSync(tmp, file);
}

function _enforceCaps(queueDir) {
  const droppedPath = path.join(queueDir, DROPPED_COUNT_FILE);
  let dropped = 0;
  try { dropped = Number(fs.readFileSync(droppedPath, 'utf8')) || 0; } catch (_) {}

  let files = _listQueue(queueDir);
  let totalSize = files.reduce((s, f) => s + (f.size || 0), 0);

  while ((files.length >= MAX_FILES || totalSize > MAX_BYTES) && files.length > 0) {
    const oldest = files[0];
    try { fs.unlinkSync(oldest.path); } catch (_) {}
    totalSize -= oldest.size;
    files = files.slice(1);
    dropped++;
  }

  if (dropped > 0) {
    // Atomic write (tmp+rename) so a concurrent reader never sees a torn/partial
    // counter, matching how events are written in enqueue().
    const droppedTmp = droppedPath + '.tmp';
    fs.writeFileSync(droppedTmp, String(dropped), { mode: 0o600 });
    fs.renameSync(droppedTmp, droppedPath);
  }
}

function _listQueue(queueDir) {
  let entries;
  try {
    entries = fs.readdirSync(queueDir, { withFileTypes: true });
  } catch (_) {
    return [];
  }

  return entries
    .filter(e => e.isFile() && e.name.endsWith('.json') && !e.name.startsWith('.'))
    .map(e => {
      const full = path.join(queueDir, e.name);
      let size = 0;
      try { size = fs.statSync(full).size; } catch (_) {}
      return { name: e.name, path: full, size };
    })
    .sort((a, b) => a.name.localeCompare(b.name));
}

// ── flush ────────────────────────────────────────────────────────────────────

async function flush(opts) {
  const queueDir = (opts && opts.queueDir) || defaultQueueDir();
  const endpoint = opts && opts.endpoint;
  const result = { sent: 0, failed: 0, dropped: 0 };

  if (!opts || opts.enabled !== true) return result;

  // Test seams: when omitted (the production path) these are the real https
  // POST and the real timer sleep, so default-OFF and no-egress guarantees are
  // untouched. Callers never pass these; only the self-test injects them.
  const post = (opts && opts.__post) || _post;
  const sleep = (opts && opts.__sleep) || _sleep;

  let dropped = 0;
  try { dropped = Number(fs.readFileSync(path.join(queueDir, DROPPED_COUNT_FILE), 'utf8')) || 0; } catch (_) {}
  result.dropped = dropped;

  if (!endpoint) return result;

  const files = _listQueue(queueDir);

  for (const file of files) {
    let payload;
    try { payload = fs.readFileSync(file.path, 'utf8'); } catch (_) { continue; }

    let ok = false;
    let honoredRetryAfter = false;
    for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
      // Skip the top-of-loop backoff for the iteration immediately after we
      // already slept an honored Retry-After — otherwise a 429 sleeps twice.
      if (attempt > 0 && !honoredRetryAfter) {
        const delay = computeBackoffDelayMs(attempt - 1, BACKOFF_BASE_MS);
        await sleep(delay);
      }
      honoredRetryAfter = false;

      try {
        const resp = await post(endpoint, payload);
        if (resp.statusCode < 300) { ok = true; break; }
        if (resp.statusCode === 429) {
          const ra = parseRetryAfter(resp.headers && resp.headers['retry-after']);
          if (ra != null && attempt < MAX_ATTEMPTS - 1) {
            await sleep(ra);
            honoredRetryAfter = true;
          }
          continue;
        }
        if (resp.statusCode >= 400 && resp.statusCode < 500) break;
      } catch (_) {}
    }

    if (ok) {
      // Delivery confirmed (2xx): unlink rather than rename to `.sent`. Retained
      // `.sent` files are invisible to _listQueue's `.json` filter, so they'd
      // never count toward MAX_FILES/MAX_BYTES nor ever be swept → unbounded
      // disk growth. At-least-once semantics still hold: we only remove the file
      // after a confirmed 2xx (a crash before unlink at worst re-sends once).
      try { fs.unlinkSync(file.path); } catch (_) {}
      result.sent++;
    } else {
      result.failed++;
    }
  }

  return result;
}

function _post(endpoint, body, timeoutMs) {
  return new Promise((resolve, reject) => {
    const url = new URL(endpoint);
    const req = https.request({
      hostname: url.hostname,
      port: url.port || 443,
      path: url.pathname + url.search,
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(body),
      },
    }, (res) => {
      let data = '';
      res.on('data', d => data += d);
      res.on('end', () => resolve({ statusCode: res.statusCode, headers: res.headers, body: data }));
    });
    req.on('error', reject);
    // Bound every request: a collector that accepts the socket but never
    // responds must not hang flush() forever. Destroying with an error routes
    // through the 'error' handler above so the promise rejects and the caller's
    // try/catch treats it as a failed attempt.
    req.setTimeout(timeoutMs || TIMEOUT_MS, () => req.destroy(new Error('timeout')));
    req.write(body);
    req.end();
  });
}

function _sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

// ── self-test ────────────────────────────────────────────────────────────────

if (require.main === module) {
  (async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sw-telemetry-test-'));
    const queueDir = path.join(tmpDir, 'queue');
    let passed = 0;
    let failed = 0;

    function assert(cond, label) {
      if (cond) { passed++; console.log(`  PASS: ${label}`); }
      else      { failed++; console.error(`  FAIL: ${label}`); }
    }

    // T1: enqueue creates 0600 file
    enqueue({ event: 'test1' }, { queueDir });
    const files = fs.readdirSync(queueDir).filter(f => f.endsWith('.json'));
    assert(files.length === 1, 'enqueue creates one file');
    const stat = fs.statSync(path.join(queueDir, files[0]));
    assert((stat.mode & 0o777) === 0o600, 'file is 0600');
    const content = JSON.parse(fs.readFileSync(path.join(queueDir, files[0]), 'utf8'));
    assert(content.event === 'test1', 'file contains event data');

    // T2: flush disabled (default)
    const r1 = await flush({});
    assert(r1.sent === 0 && r1.failed === 0, 'flush disabled (no opts) is no-op');
    const r1b = await flush({ enabled: false });
    assert(r1b.sent === 0 && r1b.failed === 0, 'flush enabled:false is no-op');

    // T3: flush enabled but no endpoint → no-op
    const r1c = await flush({ enabled: true });
    assert(r1c.sent === 0 && r1c.failed === 0, 'flush without endpoint sends nothing');

    // T4: backoff is monotonic and within bounds
    for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
      const d = computeBackoffDelayMs(attempt, 0);
      const expected = Math.min(BACKOFF_BASE_MS * Math.pow(2, attempt), BACKOFF_CAP_MS);
      assert(d === expected, `backoff attempt ${attempt}: ${d}ms === ${expected}ms`);
    }
    assert(computeBackoffDelayMs(100, 0) === BACKOFF_CAP_MS, 'backoff caps at 5 min');
    {
      const d = computeBackoffDelayMs(0, BACKOFF_BASE_MS);
      assert(d >= BACKOFF_BASE_MS && d <= 2 * BACKOFF_BASE_MS,
        `jittered backoff[0] in [${BACKOFF_BASE_MS}, ${2 * BACKOFF_BASE_MS}]: ${d}`);
    }

    // T5: parseRetryAfter
    assert(parseRetryAfter(null) === null, 'null retry-after → null');
    assert(parseRetryAfter('5') === 5000, '"5" → 5000ms');
    assert(parseRetryAfter('0') === 0, '"0" → 0ms');
    assert(parseRetryAfter('abc') === null, '"abc" → null');

    // T6: cap enforcement — enqueue 101, expect oldest dropped
    for (const f of fs.readdirSync(queueDir)) {
      fs.unlinkSync(path.join(queueDir, f));
    }
    for (let i = 0; i < MAX_FILES; i++) {
      fs.writeFileSync(path.join(queueDir, `2000000${String(i).padStart(6, '0')}-ev${i}.json`),
        JSON.stringify({ i }), { mode: 0o600 });
    }
    assert(fs.readdirSync(queueDir).filter(f => f.endsWith('.json')).length === 100,
      'setup: 100 files in queue');
    enqueue({ i: 100 }, { queueDir });
    const after = fs.readdirSync(queueDir).filter(f => f.endsWith('.json'));
    assert(after.length === 100, 'after 101st enqueue: still 100 files');
    assert(!after.includes('2000000000000-ev0.json'), 'oldest file was dropped');
    const droppedContent = fs.readFileSync(path.join(queueDir, DROPPED_COUNT_FILE), 'utf8');
    assert(droppedContent === '1', 'dropped_count bumped to 1');

    // T7: directory permissions (0700)
    const qStat = fs.statSync(queueDir);
    assert((qStat.mode & 0o777) === 0o700, 'queue dir is 0700');

    // T8 [HIGH]: _post enforces a request timeout so flush() cannot hang forever
    // on a collector that accepts the socket but never responds.
    assert(typeof TIMEOUT_MS === 'number' && TIMEOUT_MS > 0 && TIMEOUT_MS <= 30000,
      'TIMEOUT_MS is a sane positive constant');
    {
      const net = require('node:net');
      const server = net.createServer(() => { /* accept, never respond */ });
      await new Promise(res => server.listen(0, '127.0.0.1', res));
      const port = server.address().port;
      const start = Date.now();
      let timedOut = false;
      try {
        await _post(`https://127.0.0.1:${port}/`, '{}', 300); // short override for the test
      } catch (e) {
        timedOut = /timeout/.test((e && e.message) || '');
      }
      const elapsed = Date.now() - start;
      server.close();
      assert(timedOut, '_post rejects with a timeout error on a non-responding server');
      assert(elapsed < 3000, `_post timeout fires promptly (${elapsed}ms < 3000ms)`);
    }

    // T9 [HIGH]: an absurd Retry-After is clamped to BACKOFF_CAP_MS (no multi-day sleep).
    assert(parseRetryAfter('999999999') === BACKOFF_CAP_MS,
      'huge numeric Retry-After clamps to BACKOFF_CAP_MS');
    assert(parseRetryAfter('999999999') <= BACKOFF_CAP_MS,
      'clamped Retry-After <= BACKOFF_CAP_MS');
    {
      const farFuture = new Date(Date.now() + 1000 * 60 * 60 * 24 * 365).toUTCString();
      const ra = parseRetryAfter(farFuture);
      assert(ra != null && ra <= BACKOFF_CAP_MS,
        'far-future HTTP-date Retry-After clamps to <= BACKOFF_CAP_MS');
    }

    // T10 [MEDIUM]: a confirmed 2xx unlinks the file — `.sent` files never accumulate.
    {
      const q = path.join(tmpDir, 'queue-sent');
      fs.mkdirSync(q, { recursive: true, mode: 0o700 });
      for (let i = 0; i < 3; i++) enqueue({ i }, { queueDir: q });
      const okPost = async () => ({ statusCode: 200, headers: {}, body: '' });
      const res = await flush({
        enabled: true, endpoint: 'https://collector.invalid/x', queueDir: q, __post: okPost,
      });
      assert(res.sent === 3, 'flush reports 3 delivered');
      const remaining = fs.readdirSync(q);
      assert(!remaining.some(f => f.endsWith('.sent')), 'no .sent files created on success');
      assert(!remaining.some(f => f.endsWith('.json')), 'delivered .json files are removed');
    }

    // T11 [LOW]: after honoring Retry-After, the next iteration skips the
    // top-of-loop backoff — the 429 is not slept twice.
    {
      const q = path.join(tmpDir, 'queue-429');
      fs.mkdirSync(q, { recursive: true, mode: 0o700 });
      enqueue({ x: 1 }, { queueDir: q });
      const sleeps = [];
      const fakeSleep = async (ms) => { sleeps.push(ms); };
      let call = 0;
      const post = async () => {
        call++;
        if (call === 1) return { statusCode: 429, headers: { 'retry-after': '1' }, body: '' };
        return { statusCode: 200, headers: {}, body: '' };
      };
      const res = await flush({
        enabled: true, endpoint: 'https://collector.invalid/x', queueDir: q,
        __post: post, __sleep: fakeSleep,
      });
      assert(res.sent === 1, '429-then-200 eventually succeeds');
      assert(sleeps.length === 1,
        `exactly one sleep after honored Retry-After (got ${sleeps.length}: [${sleeps}])`);
      assert(sleeps[0] === 1000, `the single sleep is the honored Retry-After (got ${sleeps[0]}ms)`);
    }

    // T12 [LOW]: dropped_count is written atomically (tmp+rename); no torn/tmp file left behind.
    {
      const q = path.join(tmpDir, 'queue-drop');
      fs.mkdirSync(q, { recursive: true, mode: 0o700 });
      for (let i = 0; i < MAX_FILES; i++) {
        fs.writeFileSync(
          path.join(q, `3000000${String(i).padStart(6, '0')}-ev${i}.json`),
          JSON.stringify({ i }), { mode: 0o600 });
      }
      enqueue({ i: 'overflow' }, { queueDir: q });
      const dc = fs.readFileSync(path.join(q, DROPPED_COUNT_FILE), 'utf8');
      assert(dc === '1', 'dropped_count written after cap enforcement');
      assert(!fs.existsSync(path.join(q, DROPPED_COUNT_FILE + '.tmp')),
        'no leftover .dropped_count.tmp after atomic write');
    }

    console.log(`\n${failed === 0 ? 'PASS' : 'FAIL'}: ${passed} passed, ${failed} failed`);
    _cleanup(tmpDir);
    process.exit(failed === 0 ? 0 : 1);
  })();
}

function _cleanup(dir) {
  try {
    for (const f of fs.readdirSync(dir)) {
      const p = path.join(dir, f);
      if (fs.statSync(p).isDirectory()) _cleanup(p);
      else fs.unlinkSync(p);
    }
    fs.rmdirSync(dir);
  } catch (_) {}
}

// ── exports ──────────────────────────────────────────────────────────────────

module.exports = { enqueue, flush, computeBackoffDelayMs, parseRetryAfter };
