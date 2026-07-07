#!/usr/bin/env node
'use strict';

/*
 * pool-router — Free-Tier Pool orchestration.
 *
 * Given an incoming Anthropic Messages API request, picks a registered
 * free-tier (provider, model, key) candidate, dispatches it through the
 * matching pool-adapters.cjs adapter, and rotates to the next candidate on
 * failure. Two things are layered on top of the plain "priority order, skip
 * cooldowns" selector specifically to avoid a visible drop in output quality
 * when the pool switches providers mid-conversation — this is the pattern
 * production gateways converge on (LiteLLM's `enable_weighted_failover`
 * retries within the same model group before escalating cross-group;
 * freellmapi's "Context Handoff" injects a continuity note on a model swap):
 *
 *   1. TIER-AWARE FALLBACK — every registered key declares a `tier`
 *      ("opus" | "sonnet" | "haiku", the same vocabulary ccx's
 *      CCX_ALIAS_{OPUS,SONNET,HAIKU} already uses). The router exhausts every
 *      enabled, non-cooling-down candidate in the REQUESTED tier first, and
 *      only drops to another tier once the whole requested tier is
 *      unavailable — so a "sonnet" request never silently lands on a
 *      much-weaker "haiku" free model while a same-tier option still exists.
 *   2. STICKY SESSION + CONTEXT HANDOFF — a lightweight in-memory session map
 *      (keyed by an X-Session-Id header, or a hash of the first user message
 *      when absent — same fallback keying freellmapi documents, a generic
 *      technique, not project-specific code) prefers the candidate that
 *      served the PREVIOUS turn of the same conversation. If a swap happens
 *      anyway (the sticky candidate is down or exhausted), one compact
 *      system note is prepended to the outbound request telling the new
 *      model it is continuing an existing task — so the model doesn't act
 *      confused by a sudden context-free restart.
 *
 * ROTATION has two layers: PROACTIVE (pool-limiter.cjs's admit() check skips
 * a candidate that would exceed its own declared rpm/rpd/tpm/tpd budget,
 * before ever dispatching to it) and REACTIVE (a classified HTTP failure ->
 * cooldown -> next candidate, for whatever a declared budget didn't catch —
 * a wrong/stale limit, or a provider that just goes down).
 *
 * node: builtins only (uses global fetch, available on Node >= 18) — no npm
 * dependencies.
 */

const crypto = require('node:crypto');
const store = require('./pool-store.cjs');
const { adapterFor, streamOpenAIToAnthropic, streamGeminiToAnthropic, readWithIdleTimeout } = require('./pool-adapters.cjs');
const limiter = require('./pool-limiter.cjs');
const { applyTerseMode } = require('./prompts/terse-mode.cjs');
const { applyPoolCompact, retrieveOriginal } = require('./pool-compact.cjs');

const TIER_FALLBACK_ORDER = {
  opus: ['opus', 'sonnet', 'haiku'],
  sonnet: ['sonnet', 'opus', 'haiku'],
  haiku: ['haiku', 'sonnet', 'opus'],
};

// ---------------------------------------------------------------------------
// Cooldown state (reactive layer). In-memory only — a daemon restart clears
// it, which is fine: a fresh process should give every candidate a clean
// chance rather than remembering a cooldown across restarts.
// ---------------------------------------------------------------------------
const cooldowns = new Map(); // id -> untilTs

// Exponential-ish backoff by classified reason. Community consensus for
// production gateway circuit breakers lands around a handful of seconds up
// to roughly a minute before retrying a failed deployment; auth/no_credit
// failures get a much longer cooldown since a bad key won't fix itself.
const COOLDOWN_MS = {
  rate_limit: 60_000,
  provider_down: 15_000,
  // A candidate that just burned a full UPSTREAM_TIMEOUT_MS hang shouldn't be
  // retryable again in as little as 15s (that would pay the full timeout tax
  // again every ~35s against a demonstrably-broken upstream) — keep this at
  // roughly 2x UPSTREAM_TIMEOUT_MS.
  timeout: 20_000,
  model_unavailable: 5 * 60_000,
  auth: 30 * 60_000,
  no_credit: 30 * 60_000,
  unknown: 30_000,
};

// A hung upstream fetch defeats rotation entirely (dispatchOne/
// dispatchStreamingOne never return control to the router) — this bounds
// every single candidate attempt so "fail over as fast as possible" holds
// even against a black-holed request, not just an explicit error response.
const UPSTREAM_TIMEOUT_MS = 20_000;

// Free-tier providers' time-to-first-byte scales with prompt size (prefill
// cost on shared/eval-tier hardware) — a flat 20s budget was tuned against
// small requests and confirmed live to starve large ones: a real agentic
// coding session's request (~75-78K estimated tokens, this project's normal
// size once a few files are written) reliably timed out at exactly 20s
// against NVIDIA NIM even though the SAME candidates succeed in ~12-14s on
// smaller requests (see avgLatencyMs in /api/freetier). Scale the budget by
// estimated size instead of using one number for every request size — small
// requests still fail fast (no regression on the "stuck spinner" fix), large
// ones get proportionally more room, and a hard cap keeps the worst case
// bounded rather than reintroducing an unbounded hang.
const UPSTREAM_TIMEOUT_PER_1K_TOKENS_MS = 300;
const UPSTREAM_TIMEOUT_MAX_MS = 45_000;
function timeoutForTokens(estimatedTokens) {
  const scaled = UPSTREAM_TIMEOUT_MS + Math.round((estimatedTokens / 1000) * UPSTREAM_TIMEOUT_PER_1K_TOKENS_MS);
  return Math.min(scaled, UPSTREAM_TIMEOUT_MAX_MS);
}

// Bounds worst-case total request latency when MULTIPLE registered
// candidates are all unhealthy in a row: without a cap, N timing-out
// candidates costs N x per-attempt timeout, which can exceed typical
// client-side HTTP timeouts (60-120s) long before the router gives up.
// Sized to let at least 2 attempts run at the new size-scaled
// UPSTREAM_TIMEOUT_MAX_MS (45s each) — a request large enough to need the
// full per-attempt budget on candidate 1 must still get a real shot at
// candidate 2 rather than the deadline cutting it off after just one try.
const OVERALL_DEADLINE_MS = 2 * UPSTREAM_TIMEOUT_MAX_MS;
// Free-tier pools commonly register more than 4 keys (tier-fallback alone can
// stack several per tier); capping at 4 meant a request could exhaust its
// attempts on cooling/rate-limited candidates and give up while healthy
// candidates further down the ordered list were never reached. Real 429/5xx
// rejections come back in well under a second, so trying up to 8 stays far
// inside OVERALL_DEADLINE_MS even in the worst case.
const MAX_CANDIDATES_TRIED = 8;

// Maximum rounds of pool_retrieve tool resolution before returning a message as-is.
// Guards against a pathological/looping model that keeps calling pool_retrieve forever
// (a real bug class that has happened in similar tools, e.g., headroom's CCR retrieval
// GitHub issue #1077). With this cap, retrieval always terminates gracefully.
const MAX_RETRIEVE_ROUNDS = 3;

function isCoolingDown(id) {
  const until = cooldowns.get(id);
  if (until === undefined) return false;
  // Delete on read, not just check: a cooldowns entry for a key the user
  // later removed from the store would otherwise sit in memory for the life
  // of the daemon (add/remove-key churn is an explicitly supported dashboard
  // flow), and expired-but-unread entries just accumulate uselessly either way.
  if (Date.now() >= until) { cooldowns.delete(id); return false; }
  return true;
}

// Circuit-breaker escalation: a candidate that keeps failing gets pushed out
// further EACH TIME instead of the same fixed interval forever, so a
// chronically-bad key (dead key, wrong model id, provider outage) stops
// eating attempt/latency budget from healthy candidates every single
// request. Capped at 8x base so it still gets re-probed within a bounded
// window rather than being cooled down forever. Resets to 0 on any success.
const consecutiveFailures = new Map(); // id -> streak count
const COOLDOWN_ESCALATION_CAP = 8;

function markCooldown(id, reason) {
  const streak = consecutiveFailures.get(id) || 0;
  const factor = Math.min(2 ** streak, COOLDOWN_ESCALATION_CAP);
  cooldowns.set(id, Date.now() + (COOLDOWN_MS[reason] || COOLDOWN_MS.unknown) * factor);
  consecutiveFailures.set(id, streak + 1);
}

// ---------------------------------------------------------------------------
// Latency-aware ordering — same "latency-based routing" strategy production
// LLM gateways (e.g. LiteLLM's latency-based-routing) use: track a rolling
// average response time per candidate from real dispatches, and prefer the
// candidate that has actually been answering fastest. This lets the router
// converge on the quickest healthy model instead of relying purely on a
// static, hand-set priority number. A candidate with no samples yet gets a
// neutral prior (not best, not worst) so it gets a fair first try without
// either starving it of traffic or letting an untested candidate always
// jump the queue ahead of a proven-fast one.
// ---------------------------------------------------------------------------
const latencyEma = new Map(); // id -> EMA milliseconds
const LATENCY_EMA_ALPHA = 0.3;
const LATENCY_PRIOR_MS = 1500;
const LATENCY_TIE_THRESHOLD_MS = 50; // ignore noise below this when comparing

function recordLatency(id, ms) {
  const prev = latencyEma.get(id);
  latencyEma.set(id, prev == null ? ms : LATENCY_EMA_ALPHA * ms + (1 - LATENCY_EMA_ALPHA) * prev);
}

function latencyFor(id) {
  const v = latencyEma.get(id);
  return v == null ? LATENCY_PRIOR_MS : v;
}

// Wraps fetch() with a hard per-attempt timeout via AbortController — plain
// fetch() has no timeout of its own, so a black-holed upstream (confirmed
// live: NVIDIA NIM's z-ai/glm-5.2 hung 90+s with no response at all) would
// otherwise stall the entire client-facing request forever, since the router
// never regains control to classify a failure and rotate to the next candidate.
async function fetchWithTimeout(url, options, timeoutMs) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, Object.assign({}, options, { signal: controller.signal }));
  } catch (err) {
    if (err.name === 'AbortError') {
      const e = new Error('upstream request timed out after ' + timeoutMs + 'ms');
      e.poolReason = 'timeout';
      throw e;
    }
    const code = (err.cause && err.cause.code) || err.code;
    err.poolReason = (code === 'ECONNREFUSED' || code === 'ENOTFOUND' || code === 'EAI_AGAIN') ? 'provider_down' : 'unknown';
    throw err;
  } finally {
    clearTimeout(timer);
  }
}

// ---------------------------------------------------------------------------
// Sticky session / context-handoff state.
// ---------------------------------------------------------------------------
const SESSION_TTL_MS = 30 * 60_000;
const sessions = new Map(); // sessionKey -> { candidateId, lastAt, seq }
// Monotonic per-request sequence number. Two concurrent requests for the SAME
// session both read `sticky` before either awaits its dispatch; without this,
// whichever dispatch resolves LAST (not whichever started first) would win
// the sticky slot, causing spurious sticky-candidate flapping under
// concurrent traffic on one conversation. Benign either way (no data
// corruption), just avoids unnecessary context-handoff churn.
let seqCounter = 0;

function sessionKeyFor(req, anthropicReq) {
  const header = req.headers['x-session-id'];
  if (header) return 'h:' + String(header).slice(0, 128);
  const firstUser = (anthropicReq.messages || []).find((m) => m.role === 'user');
  const text = firstUser ? (typeof firstUser.content === 'string' ? firstUser.content : JSON.stringify(firstUser.content)) : '';
  return 's:' + crypto.createHash('sha1').update(text).digest('hex');
}

function sweepSessions() {
  const now = Date.now();
  for (const [key, val] of sessions) {
    if (now - val.lastAt > SESSION_TTL_MS) sessions.delete(key);
  }
}

function contextHandoffNote(fromId, toId) {
  return {
    role: 'user',
    content: [{
      type: 'text',
      text: 'Free-Tier Pool context handoff:\n' +
        'You are taking over an ongoing conversation from another model (' + fromId + ' -> ' + toId + ').\n' +
        "Continue the user's task using the conversation context already provided in this request. " +
        'Do not restart the task or re-ask already answered setup questions.',
    }],
  };
}

// ---------------------------------------------------------------------------
// Candidate selection
// ---------------------------------------------------------------------------

// Within a tier, user-declared priority is the primary order (an explicit,
// intentional choice — e.g. keeping a behaviorally-risky model last —
// always wins). Candidates that share a priority (the common case: every
// newly-added key defaults to priority 0 until manually reordered) break
// ties by MEASURED LATENCY first — the router self-optimizes toward
// whichever candidate has actually been answering fastest, the same
// "latency-based routing" strategy production LLM gateways use — and only
// fall back to declared context window when latency is a statistical wash
// (both unmeasured, or measured within noise of each other).
function compareCandidates(a, b) {
  const byPriority = (Number(a.priority) || 0) - (Number(b.priority) || 0);
  if (byPriority !== 0) return byPriority;
  const byLatency = latencyFor(a.id) - latencyFor(b.id);
  if (Math.abs(byLatency) > LATENCY_TIE_THRESHOLD_MS) return byLatency;
  return (Number(b.contextWindow) || 0) - (Number(a.contextWindow) || 0);
}

// Returns an ordered list of eligible candidates: sticky candidate first (if
// still eligible), then the rest of the requested tier by priority (context
// window as tie-break), then the other tiers in the TIER_FALLBACK_ORDER
// escalation order. `estimatedTokens` feeds pool-limiter's admit() check —
// a candidate that would exceed its own declared rpm/rpd/tpm/tpd budget is
// excluded here, PROACTIVELY, the same way a cooling-down one already is.
function orderedCandidates(requestedTier, sessionKey, estimatedTokens) {
  const all = store.listFreetierKeys().filter((k) =>
    k.enabled && !isCoolingDown(k.id) && limiter.admit(k, estimatedTokens)
  );
  const tierOrder = TIER_FALLBACK_ORDER[requestedTier] || TIER_FALLBACK_ORDER.sonnet;
  const byTier = tierOrder.map((t) => all.filter((k) => k.tier === t).sort(compareCandidates));
  const ordered = [].concat(...byTier);

  const sticky = sessions.get(sessionKey);
  if (sticky) {
    const idx = ordered.findIndex((k) => k.id === sticky.candidateId);
    if (idx > 0) {
      const [c] = ordered.splice(idx, 1);
      ordered.unshift(c);
    }
  }
  return ordered;
}

// ---------------------------------------------------------------------------
// HTTP failure classification — same reason vocabulary as
// plugin/scripts/classify-failure.cjs, reimplemented here against a live
// fetch Response (status + body text) rather than a log file, since that's
// the shape available at dispatch time.
// ---------------------------------------------------------------------------
function classifyHttpFailure(status, bodyText) {
  const text = String(bodyText || '').slice(0, 2000);
  if (status === 402 || /insufficient|no credit|quota|balance|billing|payment required/i.test(text)) return 'no_credit';
  if (status === 401 || status === 403 || /unauthoriz|invalid.*api.*key|forbidden/i.test(text)) return 'auth';
  if (status === 429 || /rate.?limit|too many requests|overloaded/i.test(text)) return 'rate_limit';
  if (status === 404 || /model not found|no such model|unsupported model/i.test(text)) return 'model_unavailable';
  if (status >= 500 || /bad gateway|service unavailable|upstream/i.test(text)) return 'provider_down';
  return 'unknown';
}

function joinUrl(base, suffix) {
  return String(base || '').replace(/\/+$/, '') + suffix;
}

// Gemini structurally breaks the "one fixed path, streaming toggled by a body
// flag" assumption the anthropic/openai wires share: it needs a DIFFERENT
// URL suffix for streaming vs non-streaming (:generateContent vs
// :streamGenerateContent?alt=sse), and API-key auth goes in x-goog-api-key,
// not Authorization: Bearer. `streaming` must be passed accurately by both
// call sites below or a Gemini request hits the wrong endpoint entirely.
function upstreamRequestParts(candidate, anthropicReq, requestedModel, streaming) {
  const providerCatalog = require('../data/pool-providers.json');
  const meta = providerCatalog.providers.find((p) => p.id === candidate.providerId) || { wire: 'openai' };
  const adapter = adapterFor(meta.wire);
  const upstreamModel = candidate.model || requestedModel;
  const upstreamBody = adapter.toUpstream(anthropicReq, upstreamModel);
  const headers = { 'content-type': 'application/json' };
  let path;
  if (meta.wire === 'anthropic') {
    path = '/v1/messages';
    headers['x-api-key'] = candidate.apiKey;
    headers['anthropic-version'] = '2023-06-01';
  } else if (meta.wire === 'gemini') {
    path = '/models/' + encodeURIComponent(upstreamModel) + (streaming ? ':streamGenerateContent?alt=sse' : ':generateContent');
    headers['x-goog-api-key'] = candidate.apiKey;
  } else {
    path = '/chat/completions';
    headers['authorization'] = 'Bearer ' + candidate.apiKey;
  }
  return { meta, adapter, url: joinUrl(candidate.baseUrl, path), headers, upstreamBody };
}

// Non-streaming dispatch: one full round trip, buffered.
async function dispatchOne(candidate, anthropicReq, requestedModel, estimatedTokens) {
  const { adapter, url, headers, upstreamBody } = upstreamRequestParts(candidate, anthropicReq, requestedModel, false);
  const started = Date.now();
  let resp;
  try {
    resp = await fetchWithTimeout(url, { method: 'POST', headers, body: JSON.stringify(upstreamBody) }, timeoutForTokens(estimatedTokens));
  } catch (err) {
    return { ok: false, reason: err.poolReason || 'unknown', detail: err.message, latencyMs: Date.now() - started };
  }
  const latencyMs = Date.now() - started;

  if (!resp.ok) {
    const text = await resp.text().catch(() => '');
    const reason = classifyHttpFailure(resp.status, text);
    return { ok: false, reason, status: resp.status, detail: text.slice(0, 300), latencyMs };
  }

  const json = await resp.json();
  const anthropicMessage = adapter.toAnthropic(json, requestedModel);
  return { ok: true, message: anthropicMessage, latencyMs };
}

// Resolve pool_retrieve tool calls: if the model asks to retrieve cached content,
// loop up to MAX_RETRIEVE_ROUNDS times to re-dispatch and resolve the retrieval.
// Accepts a dispatchFn parameter for testability (to allow injection of a fake
// dispatch function). Never throws; returns gracefully on any error.
async function resolveRetrieveLoop(candidate, req, requestedModel, estimatedTokens, message, dispatchFn) {
  for (let round = 0; round < MAX_RETRIEVE_ROUNDS; round++) {
    // If the message is not asking for a tool, return it as-is
    if (message.stop_reason !== 'tool_use') {
      return message;
    }

    // Find all pool_retrieve tool_use blocks in the message
    const toolUseBlocks = [];
    if (Array.isArray(message.content)) {
      for (const block of message.content) {
        if (block && block.type === 'tool_use' && block.name === 'pool_retrieve') {
          toolUseBlocks.push(block);
        }
      }
    }

    // If no pool_retrieve calls, return the message
    if (toolUseBlocks.length === 0) {
      return message;
    }

    // Build tool_result blocks for each retrieve call
    const toolResults = [];
    for (const toolUseBlock of toolUseBlocks) {
      const ref = toolUseBlock.input && toolUseBlock.input.ref;
      const retrievedText = retrieveOriginal(ref);
      const content = retrievedText || 'content not found or expired';
      toolResults.push({
        type: 'tool_result',
        tool_use_id: toolUseBlock.id,
        content,
      });
    }

    // Build a new request with the tool_use message + tool results
    const newReq = Object.assign({}, req, {
      messages: [
        ...req.messages,
        { role: 'assistant', content: message.content },
        { role: 'user', content: toolResults },
      ],
    });

    // Re-dispatch with the new request
    const result = await dispatchFn(candidate, newReq, requestedModel, estimatedTokens);

    if (!result.ok) {
      // Best-effort fallback: return the previous message rather than crashing
      console.error('[pool-router] pool_retrieve re-dispatch failed at round ' + round + ': ' + (result.reason || 'unknown'));
      return message;
    }

    // Update for the next loop iteration
    message = result.message;
    req = newReq;
  }

  // Hit MAX_RETRIEVE_ROUNDS: return the last message
  console.error('[pool-router] pool_retrieve loop hit MAX_RETRIEVE_ROUNDS, returning last message as-is');
  return message;
}

// Streaming dispatch: TRUE incremental pass-through, not buffer-then-emit.
// Only writes response headers/bytes to `res` once the upstream has
// confirmed 2xx — so a failure here NEVER leaves partial bytes on the wire,
// and the caller can safely retry the next candidate. Once bytes DO start
// flowing to the client, this function owns finishing the response; the
// caller must not attempt another candidate afterward (see routeMessage).
async function dispatchStreamingOne(candidate, anthropicReq, requestedModel, res, estimatedTokens) {
  const { meta, url, headers, upstreamBody } = upstreamRequestParts(candidate, anthropicReq, requestedModel, true);
  const started = Date.now();
  let resp;
  try {
    resp = await fetchWithTimeout(url, { method: 'POST', headers, body: JSON.stringify(upstreamBody) }, timeoutForTokens(estimatedTokens));
  } catch (err) {
    return { ok: false, reason: err.poolReason || 'unknown', detail: err.message, latencyMs: Date.now() - started, streamed: false };
  }

  if (!resp.ok) {
    const text = await resp.text().catch(() => '');
    const reason = classifyHttpFailure(resp.status, text);
    return { ok: false, reason, status: resp.status, detail: text.slice(0, 300), latencyMs: Date.now() - started, streamed: false };
  }

  // Past this point we are committed: headers are about to be flushed.
  res.writeHead(200, { 'Content-Type': 'text/event-stream; charset=utf-8', 'Cache-Control': 'no-store', Connection: 'keep-alive' });

  // Everything below this line runs AFTER headers are on the wire, so a
  // failure here is a fundamentally different class than the two
  // `return { ok: false, ... }`s above: the caller (routeMessage) can no
  // longer safely retry another candidate (a second res.writeHead() on this
  // same `res` throws ERR_HTTP_HEADERS_SENT), and real, billable output may
  // already have reached the client. Wrap the relay in its own try/catch so
  // a mid-stream failure (upstream connection drop, a broken `res.write`,
  // an adapter throwing on a malformed chunk) never propagates out of this
  // function past its {ok, ...} contract — instead it's reported back as a
  // COMMITTED failure (committedFailure:true) so routeMessage stops rotating
  // candidates and reconciles the limiter with record(), not release().
  try {
    if (meta.wire === 'anthropic') {
      // Already Anthropic SSE — literal byte pass-through, zero translation,
      // zero added latency beyond the network hop itself. No SSE parsing
      // happens on this path by design, so there's no real usage number to
      // report here — usage:null tells routeMessage's success handler to fall
      // back to the pre-flight estimate for tpm/tpd reconciliation on THIS
      // candidate only; every other wire reports exact provider usage.
      const reader = resp.body.getReader();
      while (true) {
        const { value, done } = await readWithIdleTimeout(reader);
        if (done) break;
        res.write(Buffer.from(value));
      }
      res.end();
      return { ok: true, streamed: true, latencyMs: Date.now() - started, usage: null };
    }

    if (meta.wire === 'gemini') {
      const usage = await streamGeminiToAnthropic(resp, requestedModel, (sse) => res.write(sse));
      res.end();
      return {
        ok: true, streamed: true, latencyMs: Date.now() - started,
        usage: usage ? { input_tokens: usage.promptTokenCount || 0, output_tokens: usage.candidatesTokenCount || 0 } : null,
      };
    }

    // OpenAI-compatible: translate each SSE chunk as it arrives.
    const usage = await streamOpenAIToAnthropic(resp, requestedModel, (sse) => res.write(sse));
    res.end();
    return {
      ok: true, streamed: true, latencyMs: Date.now() - started,
      usage: usage ? { input_tokens: usage.prompt_tokens || 0, output_tokens: usage.completion_tokens || 0 } : null,
    };
  } catch (err) {
    // Best-effort: terminate the SSE stream with a real Anthropic `error`
    // event so the client gets a well-formed end to a truncated stream
    // instead of a silently dropped connection. Both writes are individually
    // guarded — `res` itself may already be the broken thing that got us
    // here (e.g. the client disconnected), so a throw from res.write/res.end
    // must not re-escape this catch.
    try {
      res.write('event: error\ndata: ' + JSON.stringify({
        type: 'error',
        error: { type: 'api_error', message: 'Free-Tier Pool: upstream stream failed after dispatch: ' + err.message },
      }) + '\n\n');
    } catch (_) { /* res already broken/destroyed */ }
    try { res.end(); } catch (_) { /* already ended/destroyed */ }
    return {
      ok: true,
      streamed: true,
      committedFailure: true,
      latencyMs: Date.now() - started,
      detail: err.message,
      // No reliable usage number exists for a stream that died mid-flight —
      // routeMessage's committedFailure handling treats the full pre-flight
      // estimate as consumed rather than refunding it (see its comment).
      usage: null,
    };
  }
}

// ---------------------------------------------------------------------------
// Public entry point — one Anthropic Messages API call through the pool.
// `req` is the raw node:http IncomingMessage (only .headers is read, for the
// sticky-session key). `res` is only used (written to directly) on the
// streaming path; pass the real http.ServerResponse so true incremental
// streaming can flush bytes to the client as they arrive.
//
// Returns either:
//   { handled: true }                              — already wrote to `res`
//   { handled: false, status, json }                — caller must send this
// ---------------------------------------------------------------------------
async function routeMessage(req, res, anthropicReq) {
  anthropicReq = applyPoolCompact(anthropicReq);
  anthropicReq = applyTerseMode(anthropicReq);
  sweepSessions();
  const requestedTier = tierForModel(anthropicReq.model);
  const sessionKey = sessionKeyFor(req, anthropicReq);
  const estimatedTokens = limiter.estimateRequestTokens(anthropicReq);
  const candidates = orderedCandidates(requestedTier, sessionKey, estimatedTokens);
  const streaming = !!anthropicReq.stream;

  if (!candidates.length) {
    // Turn an opaque 503 into an actionable daemon.log line: WHY was every
    // registered key excluded — disabled, still cooling down, or does this
    // request's own estimated size simply exceed what any of them could ever
    // admit (a tpm bucket never holds more than its declared limit, so that
    // last case doesn't recover by waiting — the conversation itself would
    // need to shrink, e.g. via /compact, or a bigger-tpm key would need to be
    // registered).
    const all = store.listFreetierKeys();
    const lines = all.map((k) => {
      if (!k.enabled) return k.model + ': disabled';
      if (isCoolingDown(k.id)) return k.model + ': cooling down';
      return k.model + ': ' + limiter.explainAdmit(k, estimatedTokens);
    });
    console.error(
      '[pool-router] no candidate for tier "' + requestedTier + '" (estimated ' + estimatedTokens + ' tokens):\n  ' +
      lines.join('\n  ')
    );
    return { handled: false, status: 503, json: anthropicErrorBody('overloaded_error', 'No Free-Tier Pool candidate is enabled/available for tier "' + requestedTier + '".') };
  }

  const sticky = sessions.get(sessionKey);
  const requestSeq = ++seqCounter;
  const startedAt = Date.now();
  let tried = 0;
  const attemptLog = []; // diagnostic trail — logged only if every attempt fails
  for (const candidate of candidates) {
    if (tried >= MAX_CANDIDATES_TRIED || Date.now() - startedAt >= OVERALL_DEADLINE_MS) break;
    tried++;

    let reqForCandidate = anthropicReq;
    if (sticky && sticky.candidateId !== candidate.id) {
      // A swap is happening: splice in the context-handoff note right before
      // the last user turn so the new model knows it's continuing a task.
      reqForCandidate = Object.assign({}, anthropicReq, {
        messages: [contextHandoffNote(sticky.candidateId, candidate.id), ...anthropicReq.messages],
      });
    }

    // Spend this candidate's rpm/rpd slot + provisional tpm/tpd estimate
    // NOW — this is the one candidate actually being dispatched this
    // attempt, as opposed to the whole fallback list admit() merely peeked
    // at while orderedCandidates() was built.
    limiter.reserve(candidate, estimatedTokens);

    // dispatchOne/dispatchStreamingOne already catch their own fetch errors
    // and return { ok:false, reason } directly (see fetchWithTimeout's
    // poolReason) — this try/catch is a backstop for anything unexpected
    // thrown elsewhere in that call (e.g. an adapter bug), not the primary
    // failure-classification path.
    let result;
    try {
      result = streaming
        ? await dispatchStreamingOne(candidate, reqForCandidate, anthropicReq.model, res, estimatedTokens)
        : await dispatchOne(candidate, reqForCandidate, anthropicReq.model, estimatedTokens);
    } catch (err) {
      result = { ok: false, reason: err.poolReason || (/timeout/i.test(err.message) ? 'timeout' : 'provider_down'), detail: err.message };
    }

    if (result.ok && result.committedFailure) {
      // Bytes (and headers) are already on the wire for THIS candidate by the
      // time dispatchStreamingOne hit its internal failure — there is no safe
      // way to retry a different candidate now (a second res.writeHead() on
      // the same `res` throws ERR_HTTP_HEADERS_SENT), and no way to "undo"
      // whatever real, billable tokens the provider already streamed to the
      // client. So, unlike the ordinary failure path below:
      //   - the limiter is reconciled with record(), not release() — treat
      //     the full pre-flight estimate as consumed (no reliable actual
      //     count exists) rather than refunding it as if nothing happened.
      //   - a cooldown IS marked for this candidate (it did fail), but the
      //     sticky-session map is left untouched — a candidate that just
      //     broke mid-stream is exactly the one future turns of this
      //     conversation should NOT be biased back toward.
      //   - the for-loop stops here; dispatchStreamingOne already terminated
      //     the response (terminal `error` SSE event + res.end()), so there
      //     is nothing left for any candidate, including this one, to do.
      limiter.record(candidate, estimatedTokens, estimatedTokens);
      markCooldown(candidate.id, 'provider_down');
      return { handled: true };
    }

    if (result.ok) {
      // Two concurrent requests for the same session could both resolve
      // here; only let the request that started LATER (higher seq) win the
      // sticky slot, so an in-flight-but-slower earlier request can't
      // overwrite a newer decision after the fact.
      const existingSticky = sessions.get(sessionKey);
      if (!existingSticky || requestSeq >= existingSticky.seq) {
        sessions.set(sessionKey, { candidateId: candidate.id, lastAt: Date.now(), seq: requestSeq });
      }
      cooldowns.delete(candidate.id);
      consecutiveFailures.delete(candidate.id);
      if (typeof result.latencyMs === 'number') recordLatency(candidate.id, result.latencyMs);

      // Reconcile the pre-flight estimate down to what the provider actually
      // reported. Non-streaming: adapter.toAnthropic() already mapped usage
      // onto result.message.usage. Streaming: dispatchStreamingOne surfaces
      // normalized usage directly, or null for the anthropic byte-pass-through
      // wire (falls back to the estimate — see its definition for why).
      const actualTokens = streaming
        ? (result.usage ? (result.usage.input_tokens || 0) + (result.usage.output_tokens || 0) : estimatedTokens)
        : (result.message && result.message.usage
            ? (result.message.usage.input_tokens || 0) + (result.message.usage.output_tokens || 0)
            : estimatedTokens);
      limiter.record(candidate, estimatedTokens, actualTokens);

      if (streaming) return { handled: true };
      const finalMessage = await resolveRetrieveLoop(candidate, reqForCandidate, anthropicReq.model, estimatedTokens, result.message, dispatchOne);
      return { handled: false, status: 200, json: finalMessage };
    }

    // No real usage numbers exist for a failed dispatch — refund the
    // provisional tpm/tpd estimate in full. The rpm/rpd slot stays spent
    // (see pool-limiter.cjs's module banner for why that's the safe
    // direction).
    limiter.release(candidate, estimatedTokens);
    markCooldown(candidate.id, result.reason);
    attemptLog.push(candidate.model + ': ' + result.reason + (result.status ? ' (HTTP ' + result.status + ')' : '') + (result.detail ? ' — ' + String(result.detail).slice(0, 200) : ''));
    // Streaming failures only ever reach here BEFORE any bytes were written
    // (dispatchStreamingOne returns before res.writeHead on failure), so it's
    // always safe to fall through and try the next candidate.
  }

  if (attemptLog.length) {
    console.error(
      '[pool-router] every candidate failed for tier "' + requestedTier + '" (estimated ' + estimatedTokens + ' tokens, ' + attemptLog.length + ' tried):\n  ' +
      attemptLog.join('\n  ')
    );
  }

  return {
    handled: false,
    status: 503,
    json: anthropicErrorBody('overloaded_error', 'Every Free-Tier Pool candidate for tier "' + requestedTier + '" failed or is in cooldown.'),
  };
}

function anthropicErrorBody(type, message) {
  return { type: 'error', error: { type, message } };
}

// Claude Code sends a real model string (e.g. "claude-sonnet-4-5"); map it to
// a pool tier the same way ccx already aliases opus/sonnet/haiku.
function tierForModel(model) {
  const m = String(model || '').toLowerCase();
  if (m.includes('opus')) return 'opus';
  if (m.includes('haiku')) return 'haiku';
  return 'sonnet';
}

module.exports = {
  routeMessage,
  tierForModel,
  resolveRetrieveLoop,
  // exported for the dashboard's live-usage view.
  _debugCooldowns: cooldowns,
  _debugLatencyEma: latencyEma,
  usageSnapshot: limiter.usageSnapshot,
  tokensUsedToday: limiter.tokensUsedToday,
};
