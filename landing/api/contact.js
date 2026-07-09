// Vercel serverless function — contact form / issue reporting endpoint for the landing page.
//
// Receives: name, email, message, type ('contact' or 'issue', default 'contact'),
// page_url (optional), and a honeypot "company" field. Honeypot submissions are
// silently dropped with a 204 response.
//
// Stores submissions in the contact_messages Supabase table via the anon key
// (RLS-protected for INSERT only; never chains select() due to Postgres RLS
// requiring a SELECT policy for INSERT...RETURNING to succeed).
//
// Validation: name (non-empty, ≤200 chars), email (basic regex), message
// (non-empty, ≤5000 chars), type (must be 'contact' or 'issue').
//
// Error handling: swallows Supabase failures (never surfaces as 5xx to the user)
// and logs them to console. Optional Discord/Slack webhook notifications via env vars.

import https from 'node:https';
import { randomUUID } from 'node:crypto';
import { createClient } from '@supabase/supabase-js';

// Sized to Vercel serverless body-size ceiling (~4.5MB); base64 inflates raw bytes ~33%,
// so 3MB raw → ~4MB base64 leaves safe headroom under the limit.
const MAX_BODY_BYTES = 4.5 * 1024 * 1024;
const RATE_LIMIT_WINDOW_MS = 60 * 1000;
const RATE_LIMIT_MAX = 5; // per IP, per warm instance — soft limit only, no shared store

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

const WEBHOOK_TIMEOUT_MS = 5000;

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

function formatContactNotification(record) {
  const typeLabel = record.type === 'issue' ? '🐛 Issue Report' : '💬 Contact Message';
  const from = `${record.name} <${record.email}>`;
  const msg = record.message.slice(0, 500) + (record.message.length > 500 ? '...' : '');
  return `${typeLabel}\n\nFrom: ${from}\nMessage: ${msg}`;
}

async function notifyWebhook(record) {
  const discordUrl = process.env.DISCORD_WEBHOOK_URL;
  const slackUrl = process.env.SLACK_WEBHOOK_URL;
  if (!discordUrl && !slackUrl) return;

  const text = formatContactNotification(record);
  const tasks = [];
  if (discordUrl) tasks.push(postWebhook(discordUrl, { content: text }));
  if (slackUrl) tasks.push(postWebhook(slackUrl, { text }));
  await Promise.allSettled(tasks);
}

// Basic email regex validation — matches common email formats
function isValidEmail(email) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
}

// Allowed MIME types for attachments.
const ALLOWED_MIME_TYPES = new Set([
  'image/png',
  'image/jpeg',
  'image/webp',
  'image/gif',
  'text/plain',
  'application/pdf',
]);

// Validate and process attachments array.
// Returns { valid: [...], error: null } on success, or { valid: [], error: <message> } on validation failure.
function validateAttachments(attachmentsInput) {
  if (!attachmentsInput) {
    return { valid: [], error: null };
  }

  if (!Array.isArray(attachmentsInput)) {
    return { valid: [], error: 'attachments must be an array' };
  }

  if (attachmentsInput.length > 3) {
    return { valid: [], error: 'attachments: max 3 files per submission' };
  }

  const validated = [];
  let combinedSize = 0;

  for (const att of attachmentsInput) {
    if (!att || typeof att !== 'object') {
      return { valid: [], error: 'each attachment must be an object' };
    }

    const { filename, mime_type, data_base64 } = att;

    if (!filename || typeof filename !== 'string') {
      return { valid: [], error: 'each attachment must have a filename (string)' };
    }

    if (!mime_type || typeof mime_type !== 'string') {
      return { valid: [], error: 'each attachment must have a mime_type (string)' };
    }

    if (!ALLOWED_MIME_TYPES.has(mime_type)) {
      return { valid: [], error: `mime_type "${mime_type}" not allowed` };
    }

    if (!data_base64 || typeof data_base64 !== 'string') {
      return { valid: [], error: 'each attachment must have data_base64 (string)' };
    }

    let buffer;
    try {
      buffer = Buffer.from(data_base64, 'base64');
    } catch (_) {
      return { valid: [], error: 'invalid base64 in attachment' };
    }

    const size = buffer.length;

    if (size > 2 * 1024 * 1024) {
      return { valid: [], error: 'each attachment must be <= 2MB (decoded)' };
    }

    combinedSize += size;
    if (combinedSize > 3 * 1024 * 1024) {
      return { valid: [], error: 'total attachments size must be <= 3MB (decoded)' };
    }

    validated.push({ filename, mime_type, buffer, size });
  }

  return { valid: validated, error: null };
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

  let body;
  try {
    body = JSON.parse(raw);
  } catch (_) {
    res.status(400).json({ ok: false, error: 'invalid JSON' });
    return;
  }

  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    res.status(400).json({ ok: false, error: 'body must be a JSON object' });
    return;
  }

  // Honeypot: silently drop if "company" field is present and non-empty
  if (body.company && typeof body.company === 'string' && body.company.trim()) {
    res.status(204).end();
    return;
  }

  // Validation
  const name = typeof body.name === 'string' ? body.name.trim() : '';
  const email = typeof body.email === 'string' ? body.email.trim() : '';
  const message = typeof body.message === 'string' ? body.message.trim() : '';
  const type = typeof body.type === 'string' ? body.type.trim() : 'contact';
  const pageUrl = typeof body.page_url === 'string' ? body.page_url.trim() : null;

  const errors = [];

  if (!name || name.length === 0) {
    errors.push('name is required');
  } else if (name.length > 200) {
    errors.push('name must be at most 200 characters');
  }

  if (!email || email.length === 0) {
    errors.push('email is required');
  } else if (!isValidEmail(email)) {
    errors.push('email is invalid');
  }

  if (!message || message.length === 0) {
    errors.push('message is required');
  } else if (message.length > 5000) {
    errors.push('message must be at most 5000 characters');
  }

  if (type !== 'contact' && type !== 'issue') {
    errors.push("type must be 'contact' or 'issue'");
  }

  if (errors.length > 0) {
    res.status(400).json({ ok: false, errors });
    return;
  }

  // Validate attachments array.
  const { valid: validatedAttachments, error: attachmentError } = validateAttachments(body.attachments);
  if (attachmentError) {
    res.status(400).json({ ok: false, error: attachmentError });
    return;
  }

  // Build Supabase client
  const supabaseUrl = process.env.SUPABASE_URL;
  const supabaseAnonKey = process.env.SUPABASE_ANON_KEY;

  if (!supabaseUrl || !supabaseAnonKey) {
    console.error('[contact] Supabase credentials not configured');
    res.status(200).json({ ok: true });
    return;
  }

  const supabase = createClient(supabaseUrl, supabaseAnonKey);

  // Upload attachments to Storage and build stored record.
  const storedAttachments = [];
  for (const att of validatedAttachments) {
    const uploadPath = `contact/${randomUUID()}/${att.filename}`;
    try {
      const uploadResult = await supabase.storage
        .from('feedback-attachments')
        .upload(uploadPath, att.buffer, { contentType: att.mime_type });

      if (uploadResult.error) {
        console.log('[contact] Attachment upload failed:', uploadResult.error, 'path:', uploadPath);
        // Don't fail the entire submission; just omit this attachment.
        continue;
      }

      storedAttachments.push({
        path: uploadPath,
        filename: att.filename,
        size: att.size,
        mime_type: att.mime_type,
      });
    } catch (e) {
      console.log('[contact] Exception uploading attachment:', e, 'path:', uploadPath);
      // Don't fail the entire submission; just omit this attachment.
    }
  }

  const record = {
    name,
    email,
    message,
    type,
    page_url: pageUrl,
    attachments: storedAttachments,
  };

  // Insert without chaining select() — Postgres RLS requires a SELECT policy
  // for INSERT...RETURNING to succeed. The anon key has INSERT only, no SELECT.
  try {
    const result = await supabase.from('contact_messages').insert(record);
    if (result.error) {
      console.error('[contact] Supabase insert error:', result.error);
    }
  } catch (e) {
    console.error('[contact] Supabase insert exception:', e);
  }

  // Webhook notification happens regardless of insert success or failure.
  // This mirrors the telemetry.js pattern: persist and notify are independent operations.
  try {
    await notifyWebhook(record);
  } catch (_) {
    // Webhook failures must never affect the client response
  }

  // Always return success to the client, even if Supabase failed
  res.status(200).json({ ok: true });
}
