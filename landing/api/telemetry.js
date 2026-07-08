// Vercel serverless function — telemetry ingest endpoint for the sidewrite CLI.
//
// Client contract: plugin/scripts/error-scrub.cjs scrubs secrets/PII BEFORE an
// event ever leaves the machine, and plugin/scripts/telemetry-reporter.cjs
// queues + POSTs it here with backoff/retry. This endpoint re-validates shape
// and size defensively (never trust a network client), but does not attempt
// any scrubbing itself — that already happened client-side.
//
// Storage: opt-in durable storage via Vercel Blob. Until BLOB_READ_WRITE_TOKEN
// is set (and `@vercel/blob` installed in landing/), events fall back to
// structured console.log lines, visible in the Vercel function logs dashboard.
// Upgrading later needs no code change here.
//
// Live alerting: opt-in push notification per event via a chat webhook. Set
// DISCORD_WEBHOOK_URL and/or SLACK_WEBHOOK_URL in the Vercel project's env
// vars — either or both, no code change, no new dependency (plain
// node:https POST). Every event that reaches this endpoint is already a
// classified failure by the time it's queued client-side (see
// maybeReportTelemetry() in plugin/scripts/viewer-daemon.cjs — only
// provider_failover / provider_skipped / a non-success implement_finished
// are ever enqueued), so no extra severity filtering happens here.
//
// Issue tracking: opt-in forwarding to Sentry (or any Sentry-protocol-compatible
// service, e.g. a self-hosted GlitchTip) via the legacy Store API — a plain
// HTTPS POST built from the DSN, no @sentry/node SDK needed. Set SENTRY_DSN in
// the Vercel project's env vars. Only "issue" events are forwarded (kind !==
// 'usage_summary') — Sentry is for errors/issues, not aggregate usage digests,
// which stay in Blob storage instead. A fingerprint of [kind, code, provider]
// groups repeats of the same failure into one Sentry issue instead of
// one-issue-per-event.

import { randomUUID } from 'node:crypto';
import https from 'node:https';
import { createClient } from '@supabase/supabase-js';

const MAX_BODY_BYTES = 32 * 1024; // a single scrubbed event is tiny; reject anything larger
const RATE_LIMIT_WINDOW_MS = 60 * 1000;
const RATE_LIMIT_MAX = 30; // per IP, per warm instance — soft limit only, no shared store

// Warm-instance-local rate-limit state. Resets whenever Vercel spins up a
// fresh lambda instance — deliberately soft (no Redis/KV dependency): good
// enough to blunt one misbehaving client, not a defense against a distributed
// flood.
const hits = new Map();

function clientIp(req) {
  const fwd = req.headers['x-forwarded-for'];
  if (typeof fwd === 'string' && fwd.length > 0) return fwd.split(',')[0].trim();
  return (req.socket && req.socket.remoteAddress) || 'unknown';
}

function rateLimited(ip) {
  const now = Date.now();
  const entry = hits.get(ip);
  if (!entry || now - entry.windowStart > RATE_LIMIT_WINDOW_MS) {
    hits.set(ip, { windowStart: now, count: 1 });
    return false;
  }
  entry.count++;
  return entry.count > RATE_LIMIT_MAX;
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    let settled = false;
    const chunks = [];
    req.on('data', (chunk) => {
      if (settled) return;
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        // Don't destroy the socket here — that tears down the connection
        // before the 413 response below can ever be written, so the client
        // sees a bare connection reset instead of a real status code. Just
        // stop accumulating; Node drains the rest of the request in the
        // background while we respond normally on the same connection.
        settled = true;
        reject(Object.assign(new Error('payload too large'), { statusCode: 413 }));
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      if (settled) return;
      settled = true;
      resolve(Buffer.concat(chunks).toString('utf8'));
    });
    req.on('error', (e) => {
      if (settled) return;
      settled = true;
      reject(e);
    });
  });
}

async function persist(record) {
  if (process.env.BLOB_READ_WRITE_TOKEN) {
    try {
      // Dynamic import: `@vercel/blob` may not be installed yet. Until it is,
      // this rejects and we fall through to the log-only path below rather
      // than crashing the request.
      const { put } = await import('@vercel/blob');
      const key = `telemetry/${Date.now()}-${randomUUID()}.json`;
      await put(key, JSON.stringify(record), {
        access: 'private',
        contentType: 'application/json',
        token: process.env.BLOB_READ_WRITE_TOKEN,
      });
      return;
    } catch (_) {
      // fall through to log-only
    }
  }

  console.log('[telemetry]', JSON.stringify(record));
}

const WEBHOOK_TIMEOUT_MS = 5000;

// One-line, human-scannable summary. Discord/Slack both cap message length
// well above this, so no truncation needed for a single scrubbed event.
function formatUsageSummaryLine(record) {
  const runs = (record.runs && record.runs.total) || 0;
  const failed = (record.runs && record.runs.by_status && record.runs.by_status.failed) || 0;
  const providers = Array.isArray(record.providers)
    ? record.providers.slice(0, 3).map((p) => p.name).join(', ')
    : '';
  const models = Array.isArray(record.models)
    ? record.models.slice(0, 3).map((m) => m.name).join(', ')
    : '';
  const usd = typeof record.usd === 'number' ? record.usd.toFixed(2) : '0.00';
  return (
    `📊 sidewrite daily digest — install ${record.install_id || 'unknown'} (v${record.version || '?'}): ` +
    `${runs} run(s), ${failed} failed, $${usd} spent` +
    (providers ? ` · top providers: ${providers}` : '') +
    (models ? ` · top models: ${models}` : '')
  ).slice(0, 1800);
}

function formatAlertLine(record) {
  if (record && record.kind === 'usage_summary') return formatUsageSummaryLine(record);

  const kind = (record && record.kind) || 'event';
  const code = record && record.code ? ` (${record.code})` : '';
  const provider = record && record.provider ? ` provider=${record.provider}` : '';
  const model = record && record.model ? ` model=${record.model}` : '';
  const message = record && record.message ? `: ${record.message}` : '';
  return `⚠️ sidewrite ${kind}${code}${provider}${model}${message}`.slice(0, 1800);
}

// Fire-and-forget-with-a-cap POST to a chat webhook. Never rejects — a dead
// or misconfigured webhook must never affect the client's response.
function postWebhook(url, body) {
  return new Promise((resolve) => {
    let u;
    try {
      u = new URL(url);
    } catch (_) {
      resolve();
      return;
    }
    const payload = JSON.stringify(body);
    const req = https.request(
      {
        method: 'POST',
        hostname: u.hostname,
        port: u.port || 443,
        path: u.pathname + u.search,
        headers: {
          'content-type': 'application/json',
          'content-length': Buffer.byteLength(payload),
        },
      },
      (res) => {
        res.resume();
        res.on('end', resolve);
      }
    );
    req.on('error', () => resolve());
    req.setTimeout(WEBHOOK_TIMEOUT_MS, () => {
      req.destroy();
      resolve();
    });
    req.write(payload);
    req.end();
  });
}

async function notify(record) {
  const discordUrl = process.env.DISCORD_WEBHOOK_URL;
  const slackUrl = process.env.SLACK_WEBHOOK_URL;
  if (!discordUrl && !slackUrl) return;

  const line = formatAlertLine(record);
  const tasks = [];
  if (discordUrl) tasks.push(postWebhook(discordUrl, { content: line }));
  if (slackUrl) tasks.push(postWebhook(slackUrl, { text: line }));
  await Promise.allSettled(tasks);
}

// Parse a Sentry DSN into what the Store API needs. Returns null on any
// malformed input — the caller treats that as "Sentry not configured".
// Format: https://<publicKey>[:<secretKey>]@<host>/<projectId>
function parseDsn(dsn) {
  try {
    const u = new URL(dsn);
    const publicKey = u.username;
    const projectId = u.pathname.replace(/^\/+/, '');
    if (!publicKey || !projectId) return null;
    return {
      ingestUrl: `${u.protocol}//${u.host}/api/${projectId}/store/`,
      publicKey,
      secretKey: u.password || null,
    };
  } catch (_) {
    return null;
  }
}

function sentryEventFrom(record) {
  const tags = {};
  if (record.kind) tags.kind = String(record.kind);
  if (record.code) tags.code = String(record.code);
  if (record.provider) tags.provider = String(record.provider);
  if (record.model) tags.model = String(record.model);

  return {
    event_id: randomUUID().replace(/-/g, ''),
    timestamp: new Date().toISOString(),
    platform: 'node',
    level: 'error',
    logger: 'sidewrite',
    message: formatAlertLine(record).replace(/^[⚠️\s]+/, ''),
    tags,
    extra: record,
    // Groups repeats of the same failure shape into one Sentry issue instead
    // of a new issue per event — the whole point of using an issue tracker.
    fingerprint: ['sidewrite', String(record.kind || 'event'), String(record.code || ''), String(record.provider || '')],
  };
}

function sendToSentry(record) {
  return new Promise((resolve) => {
    const dsn = process.env.SENTRY_DSN;
    if (!dsn) return resolve();
    const parsed = parseDsn(dsn);
    if (!parsed) return resolve();

    let ingest;
    try {
      ingest = new URL(parsed.ingestUrl);
    } catch (_) {
      return resolve();
    }

    const payload = JSON.stringify(sentryEventFrom(record));
    let auth =
      `Sentry sentry_version=7, sentry_client=sidewrite-telemetry/1.0, ` +
      `sentry_timestamp=${Math.floor(Date.now() / 1000)}, sentry_key=${parsed.publicKey}`;
    if (parsed.secretKey) auth += `, sentry_secret=${parsed.secretKey}`;

    const req = https.request(
      {
        method: 'POST',
        hostname: ingest.hostname,
        port: ingest.port || 443,
        path: ingest.pathname,
        headers: {
          'content-type': 'application/json',
          'content-length': Buffer.byteLength(payload),
          'x-sentry-auth': auth,
        },
      },
      (res) => {
        res.resume();
        res.on('end', resolve);
      }
    );
    req.on('error', () => resolve());
    req.setTimeout(WEBHOOK_TIMEOUT_MS, () => {
      req.destroy();
      resolve();
    });
    req.write(payload);
    req.end();
  });
}

// Lazy-initialized Supabase client for telemetry event persistence.
let supabaseClient = null;

function getSupabaseClient() {
  if (!supabaseClient && process.env.SUPABASE_URL && process.env.SUPABASE_ANON_KEY) {
    supabaseClient = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_ANON_KEY);
  }
  return supabaseClient;
}

// Persist event to Supabase telemetry_events table. Independent of blob storage —
// failures here must never affect the client response or the blob/webhook/sentry flow.
async function persistToSupabase(record) {
  const supabase = getSupabaseClient();
  if (!supabase) return;

  try {
    // Prepare payload, truncating if necessary to satisfy the pg_column_size check.
    let payload = record;
    const payloadStr = JSON.stringify(record);
    if (payloadStr.length > 35000) {
      // Payload too large; keep only scalar fields to stay under the 40000-byte limit.
      payload = {
        kind: record.kind,
        code: record.code,
        provider: record.provider,
        model: record.model,
        install_id: record.install_id,
        version: record.version,
      };
    }

    const row = {
      kind: record.kind,
      code: record.code || null,
      provider: record.provider || null,
      model: record.model || null,
      install_id: record.install_id || null,
      version: record.version || null,
      payload: payload,
    };

    // Insert without .select() to avoid RLS policy violations (anon has no SELECT permission).
    const result = await supabase.from('telemetry_events').insert(row);
    if (result.error) {
      console.log('[telemetry-supabase-error]', result.error.message);
    }
  } catch (e) {
    console.log('[telemetry-supabase-error]', e && e.message ? e.message : String(e));
  }
}

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    res.status(405).json({ ok: false, error: 'method not allowed' });
    return;
  }

  if (rateLimited(clientIp(req))) {
    res.status(429).json({ ok: false, error: 'rate limited' });
    return;
  }

  let raw;
  try {
    raw = await readBody(req);
  } catch (e) {
    res.status(e && e.statusCode === 413 ? 413 : 400).json({ ok: false, error: 'invalid request body' });
    return;
  }

  let event;
  try {
    event = JSON.parse(raw);
  } catch (_) {
    res.status(400).json({ ok: false, error: 'invalid JSON' });
    return;
  }

  if (!event || typeof event !== 'object' || Array.isArray(event)) {
    res.status(400).json({ ok: false, error: 'event must be a JSON object' });
    return;
  }

  const record = { ...event, _receivedAt: new Date().toISOString() };

  try {
    await persist(record);
  } catch (_) {
    // Never surface a storage failure as a 5xx — the CLI's flush() would just
    // retry with backoff, wasting the user's bandwidth on our own error.
  }

  try {
    await persistToSupabase(record);
  } catch (_) {
    // same: Supabase being down/misconfigured must never affect the client
  }

  try {
    await notify(record);
  } catch (_) {
    // same: a dead/misconfigured webhook must never affect the client
  }

  if (record.kind !== 'usage_summary') {
    try {
      await sendToSentry(record);
    } catch (_) {
      // same: Sentry being down/misconfigured must never affect the client
    }
  }

  res.status(204).end();
}
