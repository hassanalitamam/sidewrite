// Vercel serverless function — feedback ingest endpoint for the sidewrite plugin.
//
// Client contract: the plugin daemon (viewer-daemon.cjs) calls this endpoint
// with user feedback that has already been scrubbed of secrets/PII by
// error-scrub.cjs. This endpoint validates shape and size defensively, then
// inserts the feedback into the Supabase feedback table.
//
// RLS: anon INSERT only, no SELECT policy — so .insert() is called WITHOUT
// chaining .select() (critical bug: chaining .select() would fail every insert
// with "new row violates row-level security policy").
//
// Error handling: unlike telemetry.js, a genuine Supabase error means the
// plugin UI should show "Failed" and let the user retry, so we respond 502
// instead of faking success.

import { createClient } from '@supabase/supabase-js';

const MAX_BODY_BYTES = 220 * 1024;
const RATE_LIMIT_WINDOW_MS = 60 * 1000;
const RATE_LIMIT_MAX = 10; // per IP, per warm instance — soft limit only

// Warm-instance-local rate-limit state.
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

// Basic email regex for validation.
function isValidEmail(email) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
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

  let payload;
  try {
    payload = JSON.parse(raw);
  } catch (_) {
    res.status(400).json({ ok: false, error: 'invalid JSON' });
    return;
  }

  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    res.status(400).json({ ok: false, error: 'payload must be a JSON object' });
    return;
  }

  // Validate required and optional fields.
  const message = payload.message;
  const email = payload.email;
  const phone = payload.phone || null;
  const install_id = payload.install_id || null;
  const version = payload.version || null;
  const platform = payload.platform || null;
  const attached_log = payload.attached_log || null;

  // Validate message: non-empty, max 5000 chars.
  if (!message || typeof message !== 'string' || message.length === 0 || message.length > 5000) {
    res.status(400).json({ ok: false, error: 'message required (1-5000 chars)' });
    return;
  }

  // Validate email: required, must match regex.
  if (!email || typeof email !== 'string' || !isValidEmail(email)) {
    res.status(400).json({ ok: false, error: 'email required and must be valid' });
    return;
  }

  // Validate attached_log: max 200000 chars if present.
  if (attached_log && typeof attached_log === 'string' && attached_log.length > 200000) {
    res.status(400).json({ ok: false, error: 'attached_log must be under 200000 chars' });
    return;
  }

  // Initialize Supabase client with anon key.
  const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_ANON_KEY);

  // Insert record into feedback table.
  // CRITICAL: do NOT chain .select() after .insert() — anon has no SELECT policy.
  const record = {
    install_id,
    version,
    platform,
    message,
    email,
    phone,
    attached_log,
  };

  try {
    const result = await supabase.from('feedback').insert(record);

    if (result.error) {
      console.error('[feedback] Supabase error:', result.error);
      res.status(502).json({ ok: false, error: 'storage unavailable' });
      return;
    }

    res.status(200).json({ ok: true });
  } catch (e) {
    console.error('[feedback] Exception during insert:', e);
    res.status(502).json({ ok: false, error: 'storage unavailable' });
  }
}
