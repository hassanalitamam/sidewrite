#!/usr/bin/env node
'use strict';

/*
 * pool-limiter — proactive rpm/rpd/tpm/tpd budget gating for Free-Tier Pool
 * candidates (M3).
 *
 * Every registered candidate can declare limits.{rpm,rpd,tpm,tpd}
 * (pool-store.cjs) but until now the router only ever found out a candidate
 * was over budget REACTIVELY, from a live 429 (classifyHttpFailure ->
 * 'rate_limit' -> markCooldown). This module adds the missing pre-flight
 * half: an in-memory per-candidate ledger the router can consult BEFORE
 * dispatch, so an over-budget candidate is skipped the same way a
 * cooling-down one is, without spending an HTTP round trip (or the free-tier
 * provider's own patience) finding out the hard way.
 *
 * Two different counter shapes, chosen per limit semantics:
 *
 *   - rpm / rpd (request counts, cost = 1 per attempted dispatch): a SLIDING
 *     WINDOW LOG — one timestamp array per candidate per window. Exact (no
 *     fixed-window boundary bug where two requests at 0:59 and 1:01 both
 *     land in "different minutes" despite being 2s apart), and cheap in
 *     practice since free-tier rpm/rpd ceilings are small, so the arrays
 *     never grow large. Pruned from the FRONT only (entries are always
 *     pushed in non-decreasing Date.now() order, so the array is already
 *     sorted — no need to filter the whole thing on every check).
 *
 *   - tpm / tpd (token volume, cost = estimated at dispatch time, corrected
 *     to actual once the provider replies): a TOKEN BUCKET with continuous
 *     refill (capacity = the declared limit, refill rate = capacity/window),
 *     not a fixed-window reset — a bucket that only "topped up" once a
 *     minute on the clock would let a candidate throttled at :00 burn its
 *     entire next allotment again in one burst at the next minute boundary;
 *     continuous refill instead trickles budget back every millisecond,
 *     matching real provider-side token-bucket limiters far more closely.
 *
 * ADMIT vs RESERVE — the subtlety worth over-explaining:
 *
 * pool-router's orderedCandidates() builds a FULL fallback-ordered list for
 * a tier in one pass (sticky candidate + every other enabled, non-cooling
 * candidate) — most of that list is never actually dispatched to; it only
 * exists so the router has somewhere to go if earlier entries fail. That
 * means the predicate used to FILTER that list must be side-effect-free
 * (exactly why isCoolingDown() only ever lazily deletes an EXPIRED entry —
 * never mutates state to reflect "this candidate is now being considered").
 * If checking a candidate's budget also SPENT that budget, a single
 * incoming request would silently burn one rpm slot (and one
 * estimated-tokens tpm slot) off every fallback candidate in the tier just
 * for being enumerated — not just the one actually used. A candidate with a
 * small rpm limit would look "exhausted" after a handful of requests that
 * never even reached it.
 *
 * So this module deliberately exposes FOUR functions, not two:
 *
 *   - admit(candidate, estimatedTokens)   — PURE peek. No mutation beyond
 *     the same kind of lazy window-pruning isCoolingDown() already does.
 *     Safe to call once per candidate per incoming request, purely for
 *     filtering.
 *   - reserve(candidate, estimatedTokens) — the actual spend. Pushes one
 *     rpm/rpd timestamp and provisionally debits the tpm/tpd bucket by the
 *     estimate. Called exactly once, for exactly the ONE candidate the
 *     router is about to dispatch to (never for the rest of the fallback
 *     list).
 *   - record(candidate, estimatedTokens, actualTokens) — reconciles the
 *     tpm/tpd bucket from the ESTIMATE reserve() debited to the ACTUAL
 *     total (input+output) tokens the provider reported for this exact
 *     request (refund the estimate in full, then debit the real number).
 *     rpm/rpd need no equivalent call: their cost is a flat 1 charged at
 *     reserve() time regardless of outcome.
 *   - release(candidate, estimatedTokens) — the failure-path mirror of
 *     record(): refunds the tpm/tpd estimate in full, since a failed
 *     dispatch never produced real usage numbers to bill instead. The
 *     rpm/rpd request-slot is intentionally NOT refunded on failure — the
 *     attempt genuinely happened (and for a rate_limit-classified failure
 *     specifically, almost certainly did count against the real upstream
 *     counter), so treating it as spent is the conservative direction: it
 *     can only make this module UNDER-estimate remaining headroom, never
 *     let a candidate blow through its own declared budget.
 *
 * `limits`/`id` are read off the candidate record the caller already has in
 * hand (from store.listFreetierKeys()) rather than re-fetched here, so this
 * module never has to require('./pool-store.cjs') itself.
 *
 * node: builtins only — no npm dependencies.
 */

const WINDOW_MS = {
  rpm: 60_000,
  rpd: 24 * 60 * 60_000,
  tpm: 60_000,
  tpd: 24 * 60 * 60_000,
};

// One ledger per candidate id. Created lazily on first touch, never removed
// on its own — same "in-memory only, cleared on daemon restart" posture as
// pool-router's cooldowns/sessions maps. A stale entry for a since-deleted
// key is harmless (a few numbers + small arrays); it just sits idle, same
// tradeoff pool-router already accepts for its own cooldowns map.
const ledgers = new Map(); // id -> { rpm: number[], rpd: number[], tpm: Bucket|null, tpd: Bucket|null }

// Real (not projected) total tokens consumed today across EVERY candidate,
// for the dashboard's "tokens used today" stat. Calendar-day reset (unlike
// the rolling 24h tpd window above) since that's what "today" means to a
// human reading the number — in-memory only, same posture as `ledgers`.
let tokensToday = { day: new Date().toDateString(), tokens: 0 };
function tokensUsedToday() {
  const day = new Date().toDateString();
  if (day !== tokensToday.day) tokensToday = { day, tokens: 0 };
  return tokensToday.tokens;
}

function newBucket(capacity, now) {
  // Starts FULL — an untouched candidate should be immediately usable up to
  // its whole declared budget, not have to "warm up" from empty.
  return { tokens: capacity, lastRefillTs: now };
}

function getLedger(id) {
  let l = ledgers.get(id);
  if (!l) {
    l = { rpm: [], rpd: [], tpm: null, tpd: null };
    ledgers.set(id, l);
  }
  return l;
}

// Sliding-window log: drop everything older than the window, from the front
// only. Entries are always pushed in non-decreasing time order (Date.now()
// is monotonic within this process), so the array is always already
// sorted — this is O(expired-count), not O(n), on every check.
function pruneWindow(arr, now, windowMs) {
  let i = 0;
  while (i < arr.length && now - arr[i] >= windowMs) i++;
  if (i > 0) arr.splice(0, i);
}

// Continuous refill: tokens accrue at capacity/windowMs per millisecond
// elapsed since the last touch, capped at capacity so a long-idle candidate
// never accumulates unbounded credit. `capacity` is re-read from the
// candidate's CURRENT declared limit on every call (not fixed at bucket
// creation), so editing a limit in the dashboard takes effect on the very
// next request instead of only after the bucket happens to empty out.
function refill(bucket, capacity, windowMs, now) {
  const elapsed = now - bucket.lastRefillTs;
  if (elapsed > 0) {
    bucket.tokens = Math.min(capacity, bucket.tokens + elapsed * (capacity / windowMs));
    bucket.lastRefillTs = now;
  } else {
    bucket.tokens = Math.min(capacity, bucket.tokens);
  }
}

function getBucket(ledger, key, capacity, now) {
  if (!ledger[key]) ledger[key] = newBucket(capacity, now);
  return ledger[key];
}

// Cheap, dependency-free token estimate for the PRE-FLIGHT check only. Real
// accounting always comes from record()'s actualTokens, reported by the
// provider itself — this heuristic only has to be a reasonable, safely-high
// guess for the handful of milliseconds/seconds between "about to dispatch"
// and "provider replied with real usage".
//
// Input side: ~chars/4 across the system prompt + every message + every tool
// declaration (a common rough English tokens-per-char ratio — good enough
// for a pre-check, not for billing). `system` can be either a plain string
// or an array of cache_control-tagged content blocks (the same two shapes
// pool-adapters.cjs's anthropicRequestToOpenAI already handles at lines
// 137-141) — both are summed here so an array-shaped system prompt is never
// silently invisible to the budget check. `tools` is read too: Claude Code
// sends a tools array with input_schema on effectively every request, which
// can be several thousand tokens for a normal built-in toolset, so ignoring
// it would leave the estimate under-counting input tokens. Output side: the
// Anthropic Messages API requires `max_tokens` on every request, so that
// field IS the caller's own worst-case output-token bound — using it costs
// nothing extra to compute and never under-counts the output half of the
// budget the way ignoring it entirely would.
function estimateRequestTokens(anthropicReq) {
  let chars = 0;
  if (typeof anthropicReq.system === 'string') {
    chars += anthropicReq.system.length;
  } else if (Array.isArray(anthropicReq.system)) {
    for (const b of anthropicReq.system) chars += ((b && b.text) || '').length;
  }
  for (const m of anthropicReq.messages || []) {
    chars += typeof m.content === 'string' ? m.content.length : JSON.stringify(m.content || '').length;
  }
  for (const t of anthropicReq.tools || []) {
    if (!t) continue;
    chars += (t.name || '').length + (t.description || '').length;
    if (t.input_schema) chars += JSON.stringify(t.input_schema).length;
  }
  const inputEstimate = Math.ceil(chars / 4);
  const outputBound = Number(anthropicReq.max_tokens) || 0;
  return inputEstimate + outputBound;
}

// Pure check: would admitting this request push rpm, rpd, tpm, or tpd over
// its declared limit? A null/missing limit on any axis means "no declared
// budget on that axis" -> never excludes on that axis. No mutation beyond
// the same lazy expiry pruning isCoolingDown() already does elsewhere.
function admit(candidate, estimatedTokens) {
  const limits = candidate.limits || {};
  const now = Date.now();
  const ledger = getLedger(candidate.id);

  if (limits.rpm) {
    pruneWindow(ledger.rpm, now, WINDOW_MS.rpm);
    if (ledger.rpm.length >= limits.rpm) return false;
  }
  if (limits.rpd) {
    pruneWindow(ledger.rpd, now, WINDOW_MS.rpd);
    if (ledger.rpd.length >= limits.rpd) return false;
  }
  if (limits.tpm) {
    const bucket = getBucket(ledger, 'tpm', limits.tpm, now);
    refill(bucket, limits.tpm, WINDOW_MS.tpm, now);
    if (bucket.tokens < estimatedTokens) return false;
  }
  if (limits.tpd) {
    const bucket = getBucket(ledger, 'tpd', limits.tpd, now);
    refill(bucket, limits.tpd, WINDOW_MS.tpd, now);
    if (bucket.tokens < estimatedTokens) return false;
  }
  return true;
}

// Diagnostic twin of admit() — same checks, but returns WHY instead of just
// true/false. Used only when orderedCandidates() comes back empty, to turn
// an opaque "No candidate available" 503 into an actionable log line: was
// this key excluded by rpm/rpd/tpm/tpd headroom, or does the estimate simply
// exceed its bucket's own MAX capacity (which no amount of waiting fixes —
// a bucket never holds more than its declared limit, so a single request
// bigger than every configured candidate's tpm ceiling can never be admitted
// by ANY of them, ever, for as long as the conversation stays that size).
function explainAdmit(candidate, estimatedTokens) {
  const limits = candidate.limits || {};
  const now = Date.now();
  const ledger = getLedger(candidate.id);
  if (limits.rpm) {
    pruneWindow(ledger.rpm, now, WINDOW_MS.rpm);
    if (ledger.rpm.length >= limits.rpm) return 'rpm exhausted (' + ledger.rpm.length + '/' + limits.rpm + ')';
  }
  if (limits.rpd) {
    pruneWindow(ledger.rpd, now, WINDOW_MS.rpd);
    if (ledger.rpd.length >= limits.rpd) return 'rpd exhausted (' + ledger.rpd.length + '/' + limits.rpd + ')';
  }
  if (limits.tpm) {
    const bucket = getBucket(ledger, 'tpm', limits.tpm, now);
    refill(bucket, limits.tpm, WINDOW_MS.tpm, now);
    if (bucket.tokens < estimatedTokens) {
      return 'tpm insufficient (need ' + estimatedTokens + ', have ' + Math.floor(bucket.tokens) + '/' + limits.tpm + ')' + (estimatedTokens > limits.tpm ? ' — request EXCEEDS this key\'s own cap, can never fit' : '');
    }
  }
  if (limits.tpd) {
    const bucket = getBucket(ledger, 'tpd', limits.tpd, now);
    refill(bucket, limits.tpd, WINDOW_MS.tpd, now);
    if (bucket.tokens < estimatedTokens) return 'tpd insufficient (need ' + estimatedTokens + ', have ' + Math.floor(bucket.tokens) + '/' + limits.tpd + ')';
  }
  return 'ok';
}

// The actual spend, for the ONE candidate the router is committing to
// dispatch to right now. Always call this only after an admit() check
// selected this candidate — skipping straight to reserve() would spend
// budget on a candidate nobody verified had room.
function reserve(candidate, estimatedTokens) {
  const limits = candidate.limits || {};
  const now = Date.now();
  const ledger = getLedger(candidate.id);

  if (limits.rpm) { pruneWindow(ledger.rpm, now, WINDOW_MS.rpm); ledger.rpm.push(now); }
  if (limits.rpd) { pruneWindow(ledger.rpd, now, WINDOW_MS.rpd); ledger.rpd.push(now); }
  if (limits.tpm) {
    const bucket = getBucket(ledger, 'tpm', limits.tpm, now);
    refill(bucket, limits.tpm, WINDOW_MS.tpm, now);
    bucket.tokens -= estimatedTokens;
  }
  if (limits.tpd) {
    const bucket = getBucket(ledger, 'tpd', limits.tpd, now);
    refill(bucket, limits.tpd, WINDOW_MS.tpd, now);
    bucket.tokens -= estimatedTokens;
  }
}

// Reconciles a candidate's tpm/tpd bucket from the ESTIMATE reserve() just
// debited to the ACTUAL total (input+output) tokens the provider reported
// for this exact request. rpm/rpd need no equivalent call.
function record(candidate, estimatedTokens, actualTokens) {
  const limits = candidate.limits || {};
  const now = Date.now();
  const ledger = getLedger(candidate.id);
  const delta = estimatedTokens - actualTokens; // refund estimate, debit actual

  const day = new Date().toDateString();
  if (day !== tokensToday.day) tokensToday = { day, tokens: 0 };
  tokensToday.tokens += actualTokens;

  if (limits.tpm) {
    const bucket = getBucket(ledger, 'tpm', limits.tpm, now);
    refill(bucket, limits.tpm, WINDOW_MS.tpm, now);
    bucket.tokens = Math.min(limits.tpm, bucket.tokens + delta);
  }
  if (limits.tpd) {
    const bucket = getBucket(ledger, 'tpd', limits.tpd, now);
    refill(bucket, limits.tpd, WINDOW_MS.tpd, now);
    bucket.tokens = Math.min(limits.tpd, bucket.tokens + delta);
  }
}

// Failure-path mirror of record(): refunds the tpm/tpd estimate in full —
// a failed dispatch produced no real usage numbers to bill instead. The
// rpm/rpd request-slot deliberately stays spent (see module banner).
function release(candidate, estimatedTokens) {
  const limits = candidate.limits || {};
  const now = Date.now();
  const ledger = getLedger(candidate.id);

  if (limits.tpm) {
    const bucket = getBucket(ledger, 'tpm', limits.tpm, now);
    refill(bucket, limits.tpm, WINDOW_MS.tpm, now);
    bucket.tokens = Math.min(limits.tpm, bucket.tokens + estimatedTokens);
  }
  if (limits.tpd) {
    const bucket = getBucket(ledger, 'tpd', limits.tpd, now);
    refill(bucket, limits.tpd, WINDOW_MS.tpd, now);
    bucket.tokens = Math.min(limits.tpd, bucket.tokens + estimatedTokens);
  }
}

// Live usage snapshot for the dashboard: {rpm:{used,limit}, rpd:{...}, ...}
// per axis, only for axes the candidate declared a limit on. Read-only,
// same lazy-prune-on-read pattern as admit().
function usageSnapshot(candidate) {
  const limits = candidate.limits || {};
  const now = Date.now();
  const ledger = getLedger(candidate.id);
  const out = {};

  if (limits.rpm) {
    pruneWindow(ledger.rpm, now, WINDOW_MS.rpm);
    out.rpm = { used: ledger.rpm.length, limit: limits.rpm };
  }
  if (limits.rpd) {
    pruneWindow(ledger.rpd, now, WINDOW_MS.rpd);
    out.rpd = { used: ledger.rpd.length, limit: limits.rpd };
  }
  if (limits.tpm) {
    const bucket = getBucket(ledger, 'tpm', limits.tpm, now);
    refill(bucket, limits.tpm, WINDOW_MS.tpm, now);
    out.tpm = { used: Math.max(0, Math.round(limits.tpm - bucket.tokens)), limit: limits.tpm };
  }
  if (limits.tpd) {
    const bucket = getBucket(ledger, 'tpd', limits.tpd, now);
    refill(bucket, limits.tpd, WINDOW_MS.tpd, now);
    out.tpd = { used: Math.max(0, Math.round(limits.tpd - bucket.tokens)), limit: limits.tpd };
  }
  return out;
}

module.exports = {
  admit,
  explainAdmit,
  reserve,
  record,
  release,
  estimateRequestTokens,
  usageSnapshot,
  tokensUsedToday,
  // exported for the dashboard's live-usage view / debugging, same pattern
  // pool-router.cjs already uses for _debugCooldowns.
  _debugLedgers: ledgers,
};
