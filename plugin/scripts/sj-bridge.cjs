#!/usr/bin/env node
'use strict';

/*
 * sj-bridge.cjs — Claude Code stream-json → sidewrite daemon bridge.
 *
 * Reads NDJSON on stdin (Claude Code `--output-format stream-json` events),
 * translates each event into an sidewrite SSE-style event and POSTs it to the
 * local viewer daemon at POST /stream-json with Bearer auth.
 *
 * Cost is computed from the provider registry prices (CCX_PRICES), NOT from
 * the model's reported total_cost_usd.
 *
 * Never throws on a bad line: a parse failure emits a `capture_gap` event.
 * All pending POSTs are flushed before exit.
 *
 * Args:  --run-id ID  --provider P  --model M
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const crypto = require('crypto');
const readline = require('readline');

// ---------------------------------------------------------------------------
// Arg parsing
// ---------------------------------------------------------------------------
function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--run-id') out.runId = argv[++i];
    else if (a === '--provider') out.provider = argv[++i];
    else if (a === '--model') out.model = argv[++i];
    else if (a === '--worker') out.worker = argv[++i];
    else if (a === '--project-id') out.projectId = argv[++i];
    else if (a === '--project-root') out.projectRoot = argv[++i];
    else if (a === '--project-name') out.projectName = argv[++i];
    else if (a === '--session-id') out.sessionId = argv[++i];
    else if (a === '--agent') out.agent = argv[++i];
  }
  return out;
}

const args = parseArgs(process.argv.slice(2));
const RUN_ID = args.runId || '';
const PROVIDER = args.provider || '';
let MODEL = args.model || '';
// Parallel-worker lane id (P5). Only set when this bridge fronts one worker of
// a file-disjoint decomposition; included in emitted events for per-worker
// dashboard lanes. Undefined for the single-worker path.
const WORKER = args.worker;

// ---------------------------------------------------------------------------
// Project attribution (#9) + analytics dimensions (#4/#11). project_id is minted
// upstream (bin/sidewrite-run = sha256(realpath.native(git-toplevel|cwd)).0,16);
// the bridge only threads it through so the daemon can stamp cost/event rows.
// Accept both flags (preferred) and the SW_PROJECT_* env the runner exports, so
// the bridge attributes correctly whether it is launched by cli or a raw pipe.
// All fail-safe to empty; a missing project is the "Unattributed" bucket, never
// an error.
const PROJECT_ID = args.projectId || process.env.SW_PROJECT_ID || '';
const PROJECT_ROOT = args.projectRoot || process.env.SW_PROJECT_ROOT || '';
const PROJECT_NAME = args.projectName || process.env.SW_PROJECT_NAME || '';
// Pipeline stage this bridge fronts (the "agent" analytics dimension). This
// bridge only ever fronts the headless implement step, so default to that.
const AGENT = args.agent || process.env.SIDEWRITE_STAGE || 'implement';
// Claude Code session id. Prefer the value carried on the stream (`system:init`
// / every event's top-level session_id); the flag is only a pre-stream fallback.
let SESSION_ID = args.sessionId || '';

// ---------------------------------------------------------------------------
// Liveness heartbeat. When SIDEWRITE_HB_FILE is set (the runner's idle
// watchdog seeds and watches it), bump its mtime on EVERY inbound stream line
// so a stalled/trickling provider — one that stops producing output — is
// detected and killed quickly, instead of running to the hard time cap.
// ---------------------------------------------------------------------------
const HB_FILE = process.env.SIDEWRITE_HB_FILE || '';
function beat() {
  if (!HB_FILE) return;
  try {
    const now = new Date();
    fs.utimesSync(HB_FILE, now, now);
  } catch (_) {
    // File may not exist yet / race — recreate it so the next stat succeeds.
    try { fs.writeFileSync(HB_FILE, ''); } catch (_) {}
  }
}

// ---------------------------------------------------------------------------
// Live progress line — printed to STDERR (throttled) so the interactive Claude
// Code session + a terminal SEE the headless delegate working: elapsed, tokens
// pulled, files touched, and the current action. Purely informational; it does
// NOT touch the stream-json stdout pipe. Set SIDEWRITE_NO_PROGRESS=1 to silence.
// ---------------------------------------------------------------------------
const PROGRESS_ON = process.env.SIDEWRITE_NO_PROGRESS !== '1';
const START_TS = Date.now();
let liveTokIn = 0, liveTokOut = 0;
let turnCount = 0; // assistant turns seen — used to flag ~0 cache reads on a multi-turn run
const filesTouched = new Set();
let editCount = 0;
let lastProgressTs = 0;
function fmtTok(n) { return n >= 1000 ? (n / 1000).toFixed(1) + 'k' : String(n || 0); }
function progress(action, force) {
  if (!PROGRESS_ON) return;
  const now = Date.now();
  if (!force && now - lastProgressTs < 1200) return; // throttle to ~1.2s
  lastProgressTs = now;
  const el = Math.round((now - START_TS) / 1000);
  const parts = [
    '▸ implement',
    el + 's',
    '↓' + fmtTok(liveTokOut) + ' tok',
    filesTouched.size + ' file' + (filesTouched.size === 1 ? '' : 's') + (editCount ? ' (' + editCount + ' edit' + (editCount === 1 ? '' : 's') + ')' : ''),
  ];
  if (action) parts.push(action);
  try { process.stderr.write('  ' + parts.join(' · ') + '\n'); } catch (_) {}
}

// ---------------------------------------------------------------------------
// Daemon connection info (port + token) from ~/.sidewrite/daemon.json
// ---------------------------------------------------------------------------
function readDaemon() {
  try {
    const p = path.join(os.homedir(), '.sidewrite', 'daemon.json');
    const raw = fs.readFileSync(p, 'utf8');
    const j = JSON.parse(raw);
    return { port: j.port, token: j.token };
  } catch (e) {
    return { port: null, token: null };
  }
}

const DAEMON = readDaemon();

// ---------------------------------------------------------------------------
// Provider registry prices (CCX_PRICES) — USD per 1M tokens.
// Read from ~/.claude-providers/<provider>.env  (shell KEY="VALUE" lines).
// ---------------------------------------------------------------------------
function readProviderPrices(provider) {
  if (!provider) return {};
  try {
    const p = path.join(os.homedir(), '.claude-providers', provider + '.env');
    const raw = fs.readFileSync(p, 'utf8');
    // Find CCX_PRICES='...json...' (single or double quoted)
    const m = raw.match(/^\s*CCX_PRICES\s*=\s*(['"])([\s\S]*?)\1\s*$/m);
    if (!m) return {};
    try {
      return JSON.parse(m[2]) || {};
    } catch (_) {
      return {};
    }
  } catch (e) {
    return {};
  }
}

const PRICES = readProviderPrices(PROVIDER);

// ---------------------------------------------------------------------------
// Live file mirror config (CONTRACT 2). When SIDEWRITE_LIVE==="1", each file
// edit applied inside the worktree is mirrored into ORIG_DIR the instant its
// tool_result lands, with a first-touch backup + manifest so `undo` can revert.
// ---------------------------------------------------------------------------
const SW_WORKTREE = process.env.SIDEWRITE_WORKTREE || '';
const SW_ORIG_DIR = process.env.SIDEWRITE_ORIG_DIR || '';
const SW_RUN_ID = process.env.SIDEWRITE_RUN_ID || RUN_ID || '';
const SW_BACKUP_DIR = process.env.SIDEWRITE_BACKUP_DIR || '';
const SW_LIVE = process.env.SIDEWRITE_LIVE || '';

// P5 parallel workers: ORIG-relative path prefixes this worker OWNS. When set
// (newline/comma-delimited), mirrorFile only mirrors files whose rel path is
// covered by one of these prefixes — this is what keeps worker A from
// clobbering worker B's disjoint files. Empty/unset => mirror everything
// (single-worker behavior, unchanged).
const SW_ALLOW = process.env.SIDEWRITE_ALLOW || '';
const ALLOW_PREFIXES = SW_ALLOW.split(/[\n,]/)
  .map((s) => s.trim())
  .filter((s) => s.length > 0)
  .map((s) => {
    let p = path.normalize(s);
    if (p.startsWith('./')) p = p.slice(2);
    return p;
  })
  .filter((p) => p.length > 0);

// Is an ORIG-relative path covered by any owned prefix? Covered means the rel
// equals the prefix, or is a descendant of it (prefix treated as a directory).
function allowCovers(rel) {
  for (const p of ALLOW_PREFIXES) {
    if (rel === p) return true;
    if (rel.startsWith(p.endsWith('/') ? p : p + '/')) return true;
    if (p.endsWith('/') && rel.startsWith(p)) return true;
  }
  return false;
}

// Map tool_use_id -> requested file_path (filled on 'assistant' tool_use,
// consumed on the matching 'user' tool_result).
const toolFileById = new Map();

// Track which relative paths we've already backed up this run (first-touch).
const backedUp = new Set();

function b64url(s) {
  return Buffer.from(s, 'utf8')
    .toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
}

function sha256File(p) {
  const buf = fs.readFileSync(p);
  return crypto.createHash('sha256').update(buf).digest('hex');
}

// Resolve a tool-reported file_path (absolute-inside-worktree OR already
// relative) to a worktree-relative path. Returns null if it escapes the
// worktree or the mirror is not configured.
function resolveRel(filePath) {
  if (!filePath || !SW_WORKTREE || !SW_ORIG_DIR) return null;
  let rel;
  if (path.isAbsolute(filePath)) {
    rel = path.relative(SW_WORKTREE, filePath);
  } else {
    rel = filePath;
  }
  rel = path.normalize(rel);
  // Reject anything that escapes the worktree.
  if (rel === '' || rel === '.' || rel.startsWith('..') || path.isAbsolute(rel)) {
    return null;
  }
  if (rel.split(path.sep).some((seg) => seg === '..')) return null;
  return rel;
}

// Mirror a single applied edit from the worktree into ORIG_DIR. Fully guarded:
// on any failure it posts nothing and never throws.
function mirrorFile(filePath) {
  try {
    if (SW_LIVE !== '1') return;
    const rel = resolveRel(filePath);
    if (!rel) return;

    // P5: in a parallel run, only mirror files this worker owns; skip silently
    // otherwise so a worker never touches another worker's disjoint slice.
    if (ALLOW_PREFIXES.length > 0 && !allowCovers(rel)) return;

    const src = path.join(SW_WORKTREE, rel);
    const dest = path.join(SW_ORIG_DIR, rel);

    // Belt-and-suspenders: ensure dest stays inside ORIG_DIR.
    const destRel = path.relative(SW_ORIG_DIR, dest);
    if (destRel.startsWith('..') || path.isAbsolute(destRel)) return;

    const destExists = fs.existsSync(dest);
    const srcExists = fs.existsSync(src);

    // First-touch backup of an EXISTING dest before we overwrite/remove it.
    if (!backedUp.has(rel)) {
      backedUp.add(rel);
      try {
        if (SW_BACKUP_DIR && destExists) {
          fs.mkdirSync(SW_BACKUP_DIR, { recursive: true });
          fs.copyFileSync(dest, path.join(SW_BACKUP_DIR, b64url(rel)));
        }
      } catch (_) {}
    }

    let action;
    let posthash = '';
    if (!srcExists) {
      // Source gone in the worktree -> treat as a delete.
      try {
        if (destExists) fs.unlinkSync(dest);
      } catch (_) {}
      action = 'delete';
    } else {
      fs.mkdirSync(path.dirname(dest), { recursive: true });
      fs.copyFileSync(src, dest);
      action = 'write';
      try {
        posthash = sha256File(dest);
      } catch (_) {
        posthash = '';
      }
    }

    // Append manifest line: rel<TAB>existed(0|1)<TAB>posthash
    try {
      const runsDir = path.join(os.homedir(), '.sidewrite', 'runs');
      fs.mkdirSync(runsDir, { recursive: true });
      const line = rel + '\t' + (destExists ? '1' : '0') + '\t' + posthash + '\n';
      fs.appendFileSync(path.join(runsDir, SW_RUN_ID + '.touched'), line);
    } catch (_) {}

    post({
      type: 'file_landed',
      run_id: SW_RUN_ID,
      provider: PROVIDER,
      path: rel,
      action,
      ...(WORKER != null ? { worker: Number(WORKER) } : {}),
    });
  } catch (_) {
    // Never crash the bridge on a mirror failure.
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
function truncate(s, n) {
  if (s == null) return '';
  s = String(s);
  return s.length > n ? s.slice(0, n) + '…' : s;
}

// Normalize a message.content field to an array of content blocks. A valid
// Anthropic/gateway shape allows `content` to be a bare STRING (a single text
// block) instead of a block array; without this, `for (const c of content)`
// iterates characters and no text/tool block is ever seen — the run looks empty
// (false model_no_response, $0 estimate, lost output). Anything non-string is
// coerced to an array (empty when absent) so callers can iterate uniformly.
function asBlocks(content) {
  if (typeof content === 'string') {
    return content.length ? [{ type: 'text', text: content }] : [];
  }
  return Array.isArray(content) ? content : [];
}

// Price-table identity stamped on every cost row (#11 price_version). Lets the
// dashboard/back-office tell which rate card produced a historical usd figure.
const PRICE_TABLE_VERSION =
  (PRICES && typeof PRICES.__version === 'string' && PRICES.__version) ||
  process.env.CCX_PRICES_VERSION ||
  'v1';

// Strip EXACTLY one trailing routing suffix the `_fast_model` shell transform
// appends (`:nitro`/`:floor`) or the registry omits (`:free`). Anchored at the
// end + case-insensitive so a model whose real name contains "free" mid-slug is
// never mangled (#11 Gap C). Only this precise set is stripped.
function normModel(m) {
  if (!m || typeof m !== 'string') return '';
  return m.replace(/:(?:nitro|floor|free)$/i, '');
}

// Resolve a per-1M rate card for a model, tolerant of the routing suffix. Tries
// the raw slug, its normalized form, then the same for the process --model.
// Returns { price, matched } — matched:false is a genuine price MISS (renders as
// `unpriced`), distinct from a matched free tier whose in-rate is 0 (#11 Gap H).
// Fail-closed sanity guard: a rate card whose input rate is non-finite or absurd
// (> 10000 USD / 1M tok — two orders past the priciest real model) is treated as
// a bad row and skipped, never silently used to bill a run.
function resolvePrice(model) {
  if (!PRICES || typeof PRICES !== 'object') return { price: null, matched: false };
  const candidates = [model, normModel(model), MODEL, normModel(MODEL)];
  const seen = new Set();
  for (const key of candidates) {
    if (!key || seen.has(key)) continue;
    seen.add(key);
    const raw = PRICES[key];
    if (!raw || typeof raw !== 'object') continue;
    // Sanity guard (retained): reject an implausible per-1M input rate. The
    // range check is fail-closed at BOTH ends — a negative rate would otherwise
    // pass `<= 10000`, match as authoritative, and clamp to a definitive $0.00.
    if (!(Number(raw.in) >= 0 && Number(raw.in) <= 10000)) continue; // rejects NaN/Infinity/negative
    return { price: raw, matched: true };
  }
  return { price: null, matched: false };
}

// Compute USD from a resolved rate card (per 1M tokens) — NOT total_cost_usd.
// Cache rates: registry-provided values always win; otherwise derive off the
// input rate — cacheRead = 0.1×in, cacheCreate = 1.25×in (#11 Gap D, was ~10×
// over-charging reads). When the provider surfaces the ephemeral 5m/1h split,
// bill 1h = 2×in and 5m = 1.25×in; the un-split remainder bills at flat 1.25×in.
function computeUsd(price, tokensIn, tokensOut, cacheRead, cacheCreate, cacheCreate5m, cacheCreate1h) {
  if (!price) return 0;
  const inRate = Number(price.in) || 0;
  const outRate = Number(price.out) || 0;
  const cacheReadRate = price.cacheRead != null ? Number(price.cacheRead) || 0 : 0.1 * inRate;
  const flatCreateRate = price.cacheCreate != null ? Number(price.cacheCreate) || 0 : 1.25 * inRate;
  const create5mRate =
    price.cacheCreate5m != null ? Number(price.cacheCreate5m) || 0
    : price.cacheCreate != null ? Number(price.cacheCreate) || 0
    : 1.25 * inRate;
  const create1hRate =
    price.cacheCreate1h != null ? Number(price.cacheCreate1h) || 0 : 2 * inRate;
  const totalCreate = Math.max(0, Number(cacheCreate) || 0);
  let c5 = Math.max(0, Number(cacheCreate5m) || 0);
  let c1 = Math.max(0, Number(cacheCreate1h) || 0);
  // The nested split (when present) is a SUBSET of cache_creation_input_tokens.
  // Clamp the split to the reported total (scaling proportionally on the
  // pathological c5+c1 > total case) so it can never over-bill beyond the total
  // cache-creation tokens the provider actually reported.
  const splitSum = c5 + c1;
  if (splitSum > totalCreate && splitSum > 0) {
    const scale = totalCreate / splitSum;
    c5 *= scale;
    c1 *= scale;
  }
  // Bill the split at its own rate and only charge the un-split remainder at the
  // flat rate so a split-reporting provider is never double-counted.
  const flatCreate = Math.max(0, totalCreate - (c5 + c1));
  const usd =
    ((Number(tokensIn) || 0) * inRate +
      (Number(tokensOut) || 0) * outRate +
      (Number(cacheRead) || 0) * cacheReadRate +
      flatCreate * flatCreateRate +
      c5 * create5mRate +
      c1 * create1hRate) /
    1e6;
  return Number.isFinite(usd) && usd > 0 ? usd : 0;
}

// ---------------------------------------------------------------------------
// Inline HTTP POST helper with Bearer auth. Returns a Promise that always
// resolves (never rejects) so a failed POST can never crash the bridge.
// ---------------------------------------------------------------------------
function postEvent(payload) {
  return new Promise((resolve) => {
    if (!DAEMON.port || !DAEMON.token) {
      resolve(false);
      return;
    }
    let body;
    try {
      body = Buffer.from(JSON.stringify(payload), 'utf8');
    } catch (e) {
      resolve(false);
      return;
    }
    const req = http.request(
      {
        host: '127.0.0.1',
        port: DAEMON.port,
        method: 'POST',
        path: '/stream-json',
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': body.length,
          Host: '127.0.0.1:' + DAEMON.port,
          Authorization: 'Bearer ' + DAEMON.token,
        },
      },
      (res) => {
        // Drain and ignore the response body.
        res.on('data', () => {});
        res.on('end', () => resolve(true));
        res.on('error', () => resolve(false));
      }
    );
    req.on('error', () => resolve(false));
    req.write(body);
    req.end();
  });
}

// Track all in-flight POSTs so we can flush before exit.
const pending = new Set();
function post(payload) {
  const p = postEvent(payload);
  pending.add(p);
  p.finally(() => pending.delete(p));
  return p;
}

async function flush() {
  // Await everything currently in flight (and anything they spawn is already
  // added synchronously before this runs).
  await Promise.all(Array.from(pending));
}

// ---------------------------------------------------------------------------
// Accurate token accounting (#11). Provider streaming usage is a per-message
// CUMULATIVE snapshot, so we key it on message.id and LAST-WRITE-WINS (overwrite,
// never add) — the final snapshot for a message is authoritative. accTotals()
// then sums across DISTINCT messages for the run total (each turn legitimately
// re-bills its input). The map is bounded: past a cap the oldest COMPLETED
// message folds into a carry accumulator so a pathologically long run can't grow
// memory without bound while staying arithmetically exact.
// ---------------------------------------------------------------------------
const USAGE_MSG_CAP = 5000;
const usageByMsg = new Map(); // message.id -> latest usage snapshot
let anonSeq = 0; // distinct synthetic key per anonymous (missing message.id) turn
const usageCarry = { tokensIn: 0, tokensOut: 0, cacheIn: 0, cacheCreate: 0, cacheCreate5m: 0, cacheCreate1h: 0 };

function usageParts(u) {
  const parts = { tokensIn: 0, tokensOut: 0, cacheIn: 0, cacheCreate: 0, cacheCreate5m: 0, cacheCreate1h: 0 };
  if (!u || typeof u !== 'object') return parts;
  parts.tokensIn = Number(u.input_tokens) || 0;
  parts.tokensOut = Number(u.output_tokens) || 0;
  parts.cacheIn = Number(u.cache_read_input_tokens) || 0;
  parts.cacheCreate = Number(u.cache_creation_input_tokens) || 0;
  const nested = u.cache_creation;
  if (nested && typeof nested === 'object') {
    parts.cacheCreate5m = Number(nested.ephemeral_5m_input_tokens) || 0;
    parts.cacheCreate1h = Number(nested.ephemeral_1h_input_tokens) || 0;
  }
  return parts;
}

function recordUsage(msgId, u) {
  if (!u || typeof u !== 'object') return;
  // When the provider/gateway omits message.id, DON'T collapse every turn onto
  // one shared sentinel (last-write-wins would drop N-1 turns' tokens — the
  // exact under-bill on the watchdog-kill path). Synthesize a distinct key per
  // anonymous turn so each turn's cumulative snapshot is summed independently.
  const id = typeof msgId === 'string' && msgId ? msgId : '__anon__' + (anonSeq++);
  if (!usageByMsg.has(id) && usageByMsg.size >= USAGE_MSG_CAP) {
    // Evict the oldest completed message into the carry (its cumulative snapshot
    // is final; it will not be updated again) to keep the map bounded.
    const oldestKey = usageByMsg.keys().next().value;
    const p = usageParts(usageByMsg.get(oldestKey));
    usageCarry.tokensIn += p.tokensIn;
    usageCarry.tokensOut += p.tokensOut;
    usageCarry.cacheIn += p.cacheIn;
    usageCarry.cacheCreate += p.cacheCreate;
    usageCarry.cacheCreate5m += p.cacheCreate5m;
    usageCarry.cacheCreate1h += p.cacheCreate1h;
    usageByMsg.delete(oldestKey);
  }
  usageByMsg.set(id, u); // last-write-wins
}

function accTotals() {
  const t = { ...usageCarry };
  for (const u of usageByMsg.values()) {
    const p = usageParts(u);
    t.tokensIn += p.tokensIn;
    t.tokensOut += p.tokensOut;
    t.cacheIn += p.cacheIn;
    t.cacheCreate += p.cacheCreate;
    t.cacheCreate5m += p.cacheCreate5m;
    t.cacheCreate1h += p.cacheCreate1h;
  }
  return t;
}

// Assistant-output signals for #2 Layer-1 + the estimated-usage fallback.
let sawAssistantText = false;     // set true on ANY assistant text — feeds the estimate
let sawAssistantActivity = false; // ANY assistant output (text OR tool_use) — no-response probe
let completionChars = 0;          // total assistant text chars — chars/3.5 output estimate

// ---------------------------------------------------------------------------
// Single idempotent finalization (#11). One cost_update per bridge, keyed on a
// per-process attempt_id so a re-delivery / failover re-POST never double-counts
// (the daemon UPSERTs ON CONFLICT(run_id, attempt_id)). Tiered source selection:
//   exact       — non-zero top-level usage on the `result` event
//   accumulated — summed per-message stream usage (survives a watchdog kill
//                 BEFORE `result`, closing Gap A+B)
//   estimated   — no usage at all but assistant text exists: ceil(chars/3.5)
// ---------------------------------------------------------------------------
const ATTEMPT_ID = crypto.randomUUID();
let emitted = false;
let finalTotals = null;

function emitFinal(source, resultObj) {
  if (emitted) return finalTotals;
  emitted = true;

  let tokensIn = 0, tokensOut = 0, cacheIn = 0, cacheCreate = 0, cacheCreate5m = 0, cacheCreate1h = 0;
  let usageSource;

  const ru = resultObj && resultObj.usage;
  const exact = usageParts(ru);
  const exactHas = exact.tokensIn || exact.tokensOut || exact.cacheIn || exact.cacheCreate;

  if (source === 'exact' && exactHas) {
    ({ tokensIn, tokensOut, cacheIn, cacheCreate, cacheCreate5m, cacheCreate1h } = exact);
    usageSource = 'exact';
  } else {
    const acc = accTotals();
    if (acc.tokensIn || acc.tokensOut || acc.cacheIn || acc.cacheCreate) {
      ({ tokensIn, tokensOut, cacheIn, cacheCreate, cacheCreate5m, cacheCreate1h } = acc);
      usageSource = 'accumulated';
    } else if (completionChars > 0) {
      tokensOut = Math.ceil(completionChars / 3.5);
      usageSource = 'estimated';
    } else {
      // Nothing observed (e.g. instant kill). Still emit a zero row so the
      // attempt is accounted for; label it accumulated (non-exact) so the run
      // is never marked as an authoritative $0.00.
      usageSource = 'accumulated';
    }
  }

  const { price, matched } = resolvePrice(MODEL);
  const usd = computeUsd(price, tokensIn, tokensOut, cacheIn, cacheCreate, cacheCreate5m, cacheCreate1h);
  const unpriced = !matched;
  const estimated = usageSource !== 'exact';
  // Cache ratio includes cacheCreate in the billed base (#11 Gap E).
  const billedIn = tokensIn + cacheIn + cacheCreate;
  const cachePct = billedIn > 0 ? Math.round((cacheIn / billedIn) * 100) : 0;

  finalTotals = { tokensIn, tokensOut, cacheIn, cacheCreate, usd, usageSource, unpriced, cachePct };

  post({
    type: 'cost_update',
    run_id: RUN_ID,
    provider: PROVIDER,
    model: MODEL,
    tokensIn,
    tokensOut,
    cacheIn,
    cacheCreate,
    ...(cacheCreate5m ? { cacheCreate5m } : {}),
    ...(cacheCreate1h ? { cacheCreate1h } : {}),
    usd,
    estimated,
    attempt_id: ATTEMPT_ID,
    usage_source: usageSource,
    price_version: PRICE_TABLE_VERSION,
    unpriced,
    ...(WORKER != null ? { worker: Number(WORKER) } : {}),
    ...(SESSION_ID ? { session_id: SESSION_ID } : {}),
    ...(AGENT ? { agent: AGENT } : {}),
    ...(PROJECT_ID ? { project_id: PROJECT_ID } : {}),
  });
  return finalTotals;
}

// #2 Layer-1 DETECT (no egress). Emit a structured `run_error` signal whenever
// the result subtype is not 'success', is_error is truthy, OR the stream closed
// with NO assistant text (model_no_response). Idempotent + additive: the bridge
// still exits 0; the run-status decision (combined with empty-diff) is made in
// bin/sidewrite-run. Bounded string scan for an HTTP status in the result text.
let errorEmitted = false;
function extractHttpStatus(resultObj) {
  if (!resultObj || typeof resultObj !== 'object') return null;
  for (const field of ['result', 'error', 'message', 'subtype']) {
    const v = resultObj[field];
    if (typeof v !== 'string' || !v) continue;
    const m = v.slice(0, 500).match(/\b([45]\d\d)\b/);
    if (m) return Number(m[1]);
  }
  return null;
}
function detectRunError(resultObj) {
  if (errorEmitted) return;
  const hasResult = !!(resultObj && typeof resultObj === 'object');
  const subtype = hasResult && typeof resultObj.subtype === 'string' ? resultObj.subtype : null;
  const isError = !!(hasResult && resultObj.is_error);
  // model_no_response fires ONLY when the model produced NO assistant output at
  // all (no text AND no tool_use) AND the run didn't report subtype 'success'.
  // A tool-only successful turn (ended on tool_use, no text) is a real response,
  // so it must not be mislabeled as no-response.
  const noResponse = !sawAssistantActivity && subtype !== 'success';
  const subtypeBad = subtype != null && subtype !== 'success';
  if (!subtypeBad && !isError && !noResponse) return;
  errorEmitted = true;

  let failure_class;
  if (subtypeBad) failure_class = subtype;
  else if (isError) failure_class = 'error_during_execution';
  else failure_class = 'model_no_response';
  const http_status = extractHttpStatus(resultObj);

  post({
    type: 'run_error',
    run_id: RUN_ID,
    provider: PROVIDER,
    signal: failure_class,
    failure_class,
    subtype: subtype || null,
    is_error: isError,
    ...(http_status != null ? { http_status } : {}),
    ...(WORKER != null ? { worker: Number(WORKER) } : {}),
    ...(SESSION_ID ? { session_id: SESSION_ID } : {}),
    ...(AGENT ? { agent: AGENT } : {}),
    ...(PROJECT_ID ? { project_id: PROJECT_ID } : {}),
  });
}

// ---------------------------------------------------------------------------
// Event translation. Reads fields from their CORRECT positions:
//   - assistant/user content:  msg.message.content[]
//   - live usage:              msg.message.usage
//   - final usage:             top-level msg.usage
// ---------------------------------------------------------------------------
function handleEvent(obj) {
  const type = obj && obj.type;

  // Capture the Claude Code session id off the stream (first non-empty wins) so
  // every emitted cost/error row carries the #4 session dimension.
  if (obj && obj.session_id && !SESSION_ID) SESSION_ID = String(obj.session_id);

  if (type === 'system' && obj.subtype === 'init') {
    if (obj.model) MODEL = obj.model;
    post({
      type: 'run_init',
      run_id: RUN_ID,
      session_id: obj.session_id || SESSION_ID || undefined,
      model: obj.model,
      // #9 project attribution: seeds the daemon's run_id->project_id map so
      // every downstream event/cost row is stamped, and upserts `projects`.
      ...(PROJECT_ID ? { project_id: PROJECT_ID } : {}),
      ...(PROJECT_ROOT ? { project_root: PROJECT_ROOT } : {}),
      ...(PROJECT_NAME ? { project_name: PROJECT_NAME } : {}),
    });
    return;
  }

  if (type === 'assistant') {
    turnCount++; // each assistant message = one billed LLM turn (cache-efficiency signal)
    const content = asBlocks(obj.message && obj.message.content);
    for (const c of content) {
      if (!c || typeof c !== 'object') continue;
      if (c.type === 'text') {
        // #2 Layer-1: any assistant text means the model DID respond.
        if (typeof c.text === 'string' && c.text.length) {
          sawAssistantText = true;
          sawAssistantActivity = true;
          completionChars += c.text.length;
        }
        post({
          type: 'log_line',
          run_id: RUN_ID,
          provider: PROVIDER,
          text: c.text,
        });
      } else if (c.type === 'tool_use') {
        // #2 Layer-1: a tool_use block is assistant activity — the model DID
        // respond even when the final turn carried no text (tool-only success).
        sawAssistantActivity = true;
        // Remember file edits so the matching tool_result can mirror them.
        // NotebookEdit reports the path under `notebook_path`, not `file_path`.
        let fp = null;
        if (
          c.id &&
          c.input &&
          (c.name === 'Write' ||
            c.name === 'Edit' ||
            c.name === 'MultiEdit' ||
            c.name === 'NotebookEdit')
        ) {
          fp =
            typeof c.input.file_path === 'string'
              ? c.input.file_path
              : typeof c.input.notebook_path === 'string'
              ? c.input.notebook_path
              : null;
          if (fp) {
            toolFileById.set(c.id, fp);
            filesTouched.add(fp);
            if (c.name === 'Edit' || c.name === 'MultiEdit') editCount++;
          }
        }
        // Surface the current action in the live progress line.
        progress(fp ? c.name + ' ' + path.basename(fp) : c.name);
        post({
          type: 'tool_use',
          run_id: RUN_ID,
          provider: PROVIDER,
          tool: c.name,
          inputPreview: truncate(JSON.stringify(c.input), 200),
          ...(WORKER != null ? { worker: Number(WORKER) } : {}),
        });
      }
    }
    // Track LIVE token usage (cumulative on each assistant message) for progress
    // AND accumulate it per message.id (last-write-wins) so a run killed BEFORE
    // the `result` event still finalizes accurate totals (#11 Gap A+B).
    const _u = obj.message && obj.message.usage;
    if (_u) {
      if (_u.output_tokens) liveTokOut = _u.output_tokens;
      if (_u.input_tokens) liveTokIn = _u.input_tokens;
      recordUsage(obj.message && obj.message.id, _u);
    }
    return;
  }

  if (type === 'user') {
    const content = asBlocks(obj.message && obj.message.content);
    for (const c of content) {
      if (!c || typeof c !== 'object') continue;
      if (c.type === 'tool_result') {
        // Live-mirror a file edit the instant its result lands (applied).
        const fp = c.tool_use_id ? toolFileById.get(c.tool_use_id) : undefined;
        if (fp !== undefined) {
          toolFileById.delete(c.tool_use_id);
          if (SW_LIVE === '1' && !c.is_error) {
            mirrorFile(fp);
          }
        }
        let summary = c.content;
        if (typeof summary !== 'string') {
          try {
            summary = JSON.stringify(summary);
          } catch (_) {
            summary = String(summary);
          }
        }
        post({
          type: 'tool_result',
          run_id: RUN_ID,
          provider: PROVIDER,
          ok: !c.is_error,
          summary: truncate(summary, 200),
          ...(WORKER != null ? { worker: Number(WORKER) } : {}),
        });
      }
    }
    return;
  }

  if (type === 'result') {
    // Single idempotent finalize from the authoritative top-level usage (#11).
    // Prefers exact; falls back to accumulated stream usage when the provider
    // zero-fills obj.usage (Gap B). Shares the result branch with #2 Layer-1.
    const totals = emitFinal('exact', obj) || {};
    const tokensIn = totals.tokensIn || 0;
    const tokensOut = totals.tokensOut || 0;
    const cacheIn = totals.cacheIn || 0;
    const cacheCreate = totals.cacheCreate || 0;
    const usd = totals.usd || 0;
    const cachePct = totals.cachePct || 0;
    // #2 Layer-1: surface a structured run_error signal (subtype != success,
    // is_error, or no assistant text). Non-fatal — the bridge still exits 0.
    detectRunError(obj);
    // Cache-hit readout (Area 1.7). cost_update already carries cacheIn
    // (cache_read_input_tokens) vs tokensIn (input_tokens), so the dashboard can
    // render the cache ratio. Additionally FLAG the failure case: on a MULTI-TURN
    // run a provider that isn't prompt-caching re-bills the full input every turn
    // (cacheIn stays ~0), which is the exact token blow-up we care about. A
    // single-turn run legitimately has no cache reads, so only warn at >=2 turns.
    if (turnCount >= 2 && cacheIn === 0) {
      post({
        type: 'log_line',
        run_id: RUN_ID,
        provider: PROVIDER,
        text:
          '⚠ no prompt-cache reads across ' + turnCount + ' turns (' + fmtTok(tokensIn) +
          ' input tok re-billed each turn); provider caching may be disabled — expect high token cost.',
      });
    }
    // Final progress summary line (tokens · cache · cost · files · elapsed) to stderr.
    if (PROGRESS_ON) {
      const el = Math.round((Date.now() - START_TS) / 1000);
      const cost = usd ? ' · $' + usd.toFixed(usd < 1 ? 4 : 2) : '';
      const cacheNote = cacheIn
        ? ' · ↺' + fmtTok(cacheIn) + ' cached (' + cachePct + '%)'
        : (turnCount >= 2 ? ' · ↺0 cache!' : '');
      try {
        process.stderr.write(
          '  ✓ done · ' + el + 's · ↑' + fmtTok(tokensIn) + ' ↓' + fmtTok(tokensOut) + ' tok' +
          cacheNote + cost + ' · ' + filesTouched.size + ' file' + (filesTouched.size === 1 ? '' : 's') + '\n'
        );
      } catch (_) {}
    }
    return;
  }

  // Unknown event types are ignored silently.
}

// ---------------------------------------------------------------------------
// Bounded, idempotent shutdown. Emits the final cost row (accumulated source if
// `result` never arrived) + any #2 signal, awaits the in-flight POSTs, then
// exits. A ~500ms hard timer guarantees exit even if the daemon POST hangs, so a
// SIGTERM can never wedge the pipeline before the shell escalates.
// ---------------------------------------------------------------------------
let exiting = false;
function finalizeAndExit(code) {
  if (exiting) return;
  exiting = true;
  try { emitFinal('accumulated', null); } catch (_) {}
  try { detectRunError(null); } catch (_) {}
  const done = () => { try { process.exit(code); } catch (_) {} };
  const timer = setTimeout(done, 500);
  if (typeof timer.unref === 'function') timer.unref();
  flush().then(() => { clearTimeout(timer); done(); }, () => { clearTimeout(timer); done(); });
}

// ---------------------------------------------------------------------------
// Main: read NDJSON stdin line-by-line. Never throw on a bad line.
// ---------------------------------------------------------------------------
function main() {
  const rl = readline.createInterface({
    input: process.stdin,
    crlfDelay: Infinity,
  });

  rl.on('line', (line) => {
    beat(); // any inbound line = the provider is alive; reset the idle timer
    const trimmed = line.trim();
    if (!trimmed) return;
    let obj;
    try {
      obj = JSON.parse(trimmed);
    } catch (e) {
      // Parse failure -> capture_gap. Never throw.
      post({
        type: 'capture_gap',
        run_id: RUN_ID,
        rawLine: truncate(line, 300),
      });
      return;
    }
    try {
      handleEvent(obj);
    } catch (e) {
      // Any handler error is a capture gap, not a crash.
      post({
        type: 'capture_gap',
        run_id: RUN_ID,
        rawLine: truncate(line, 300),
      });
    }
  });

  rl.on('close', () => finalizeAndExit(0));

  // Guard against unexpected stream errors — finalize and exit cleanly.
  process.stdin.on('error', () => finalizeAndExit(0));

  // The watchdog escalates with kill -TERM (bin/sidewrite-run) BEFORE the
  // provider emits `result`. Catch it (+ SIGINT) so an interrupted/timed-out/
  // failed-over attempt still finalizes accurate accumulated totals (#11 Gap A)
  // and its #2 signal before dying. A NULL resultObj => accumulated source.
  process.on('SIGTERM', () => finalizeAndExit(0));
  process.on('SIGINT', () => finalizeAndExit(0));
}

main();
