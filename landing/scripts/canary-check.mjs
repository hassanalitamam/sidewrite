#!/usr/bin/env node
// Standalone verification script for the "verification loop" from the project plan.
// Runs in two modes:
//   1. Local mode (default): imports and calls handler functions directly, useful for pre-deploy checks.
//   2. Remote mode: makes real HTTP POSTs to a deployed URL (if CANARY_BASE_URL is set), useful for post-deploy monitoring.
//
// Usage: node landing/scripts/canary-check.mjs
// Env vars:
//   - CANARY_BASE_URL: if set, use remote mode (POST to this URL); otherwise local mode (import handlers)
//   - SUPABASE_SERVICE_ROLE_KEY: if set, perform read-back verification and cleanup; otherwise skip
//
// Checks:
//   1. Telemetry insert (hard-required) — canary event with kind="canary_check", code="verification_loop"
//   2. Feedback insert (hard-required) — canary row with email="canary@sidewrite.internal"
//   3. Version config read (hard-required) — anon-readable view, must have current_version, min_version, kill_switch, flags
//   4. Read-back + cleanup (optional) — only if service_role key available
//
// Exit code: 0 if all hard-required checks pass, 1 if any fail. Optional read-back never affects exit code.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import https from 'node:https';
import { EventEmitter } from 'node:events';
import { createClient } from '@supabase/supabase-js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Load landing/.env.local into process.env (same pattern as verify-api-handler.mjs)
function loadEnvLocal() {
  const envPath = path.join(__dirname, '..', '.env.local');
  if (!fs.existsSync(envPath)) return;
  for (const line of fs.readFileSync(envPath, 'utf8').split('\n')) {
    const m = line.match(/^([A-Z0-9_]+)=(.*)$/);
    if (!m) continue;
    let val = m[2].trim();
    if (val.startsWith('"') && val.endsWith('"')) val = val.slice(1, -1);
    if (!process.env[m[1]]) process.env[m[1]] = val;
  }
}
loadEnvLocal();

// Fake req/res for local handler invocation (same pattern as verify-api-handler.mjs)
function makeReq(body, method) {
  const req = new EventEmitter();
  req.method = method || 'POST';
  req.headers = { 'content-type': 'application/json', 'x-forwarded-for': '127.0.0.1' };
  process.nextTick(() => {
    if (body != null) req.emit('data', Buffer.from(JSON.stringify(body)));
    req.emit('end');
  });
  return req;
}

function makeRes() {
  const res = {
    _status: 200,
    _headers: {},
    _body: undefined,
    _ended: false,
    setHeader(k, v) { this._headers[k] = v; return this; },
    status(code) { this._status = code; return this; },
    json(obj) { this._body = obj; this._ended = true; return this; },
    end(data) { if (data !== undefined) this._body = data; this._ended = true; return this; },
  };
  return res;
}

// Make an HTTP POST to a remote URL (for remote mode).
function postRemote(url, body) {
  return new Promise((resolve, reject) => {
    try {
      const u = new URL(url);
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
          let data = '';
          res.on('data', (chunk) => { data += chunk; });
          res.on('end', () => {
            resolve({ status: res.statusCode, body: data });
          });
        }
      );
      req.on('error', reject);
      req.setTimeout(5000, () => {
        req.destroy();
        reject(new Error('HTTP request timeout'));
      });
      req.write(payload);
      req.end();
    } catch (e) {
      reject(e);
    }
  });
}

// Get Supabase client (anon key only, standard client).
function getAnonSupabase() {
  if (!process.env.SUPABASE_URL || !process.env.SUPABASE_ANON_KEY) {
    return null;
  }
  return createClient(process.env.SUPABASE_URL, process.env.SUPABASE_ANON_KEY);
}

// Get Supabase client with service_role key (for admin read-back/cleanup).
function getAdminSupabase() {
  if (!process.env.SUPABASE_URL || !process.env.SUPABASE_SERVICE_ROLE_KEY) {
    return null;
  }
  return createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);
}

// Format a check result line.
function formatCheck(name, passed, detail = '') {
  const status = passed ? 'PASS' : 'FAIL';
  return `  ${status}: ${name}${detail ? ' — ' + detail : ''}`;
}

async function main() {
  const checks = {
    telemetry_insert: false,
    feedback_insert: false,
    version_config_read: false,
  };

  const checkDetails = {};

  const canaryBaseUrl = process.env.CANARY_BASE_URL;
  const mode = canaryBaseUrl ? 'remote' : 'local';

  console.log(`[canary-check] Starting in ${mode} mode`);
  if (mode === 'remote') {
    console.log(`[canary-check] CANARY_BASE_URL: ${canaryBaseUrl}`);
  }
  console.log('');

  // ============================================================================
  // 1. TELEMETRY INSERT
  // ============================================================================
  try {
    const telemetryPayload = {
      kind: 'canary_check',
      code: 'verification_loop',
      provider: null,
      model: null,
      install_id: null,
      version: null,
      payload: { check: 'automated canary verification loop' },
    };

    if (mode === 'local') {
      // Import and call handler directly
      const telemetryHandler = (await import('../api/telemetry.js')).default;
      const req = makeReq(telemetryPayload, 'POST');
      const res = makeRes();
      await telemetryHandler(req, res);

      if (res._status >= 200 && res._status < 300) {
        checks.telemetry_insert = true;
        checkDetails.telemetry_insert = `local handler status ${res._status}`;
      } else {
        checkDetails.telemetry_insert = `local handler status ${res._status}, body: ${JSON.stringify(res._body)}`;
      }
    } else {
      // POST to remote URL
      const endpoint = `${canaryBaseUrl.replace(/\/$/, '')}/api/telemetry`;
      const result = await postRemote(endpoint, telemetryPayload);
      if (result.status >= 200 && result.status < 300) {
        checks.telemetry_insert = true;
        checkDetails.telemetry_insert = `remote status ${result.status}`;
      } else {
        checkDetails.telemetry_insert = `remote status ${result.status}, body: ${result.body}`;
      }
    }
  } catch (e) {
    checkDetails.telemetry_insert = `exception: ${e.message}`;
  }

  // ============================================================================
  // 2. FEEDBACK INSERT
  // ============================================================================
  try {
    const feedbackPayload = {
      message: 'automated canary check',
      email: 'canary@sidewrite.internal',
      phone: null,
      install_id: null,
      version: null,
      platform: null,
      attached_log: null,
    };

    if (mode === 'local') {
      // Import and call handler directly
      const feedbackHandler = (await import('../api/feedback.js')).default;
      const req = makeReq(feedbackPayload, 'POST');
      const res = makeRes();
      await feedbackHandler(req, res);

      if (res._status >= 200 && res._status < 300) {
        checks.feedback_insert = true;
        checkDetails.feedback_insert = `local handler status ${res._status}`;
      } else {
        checkDetails.feedback_insert = `local handler status ${res._status}, body: ${JSON.stringify(res._body)}`;
      }
    } else {
      // POST to remote URL
      const endpoint = `${canaryBaseUrl.replace(/\/$/, '')}/api/feedback`;
      const result = await postRemote(endpoint, feedbackPayload);
      if (result.status >= 200 && result.status < 300) {
        checks.feedback_insert = true;
        checkDetails.feedback_insert = `remote status ${result.status}`;
      } else {
        checkDetails.feedback_insert = `remote status ${result.status}, body: ${result.body}`;
      }
    }
  } catch (e) {
    checkDetails.feedback_insert = `exception: ${e.message}`;
  }

  // ============================================================================
  // 3. VERSION CONFIG READ (anon-readable)
  // ============================================================================
  try {
    const supabase = getAnonSupabase();
    if (!supabase) {
      checkDetails.version_config_read = 'SUPABASE_URL or SUPABASE_ANON_KEY not set';
    } else {
      const { data, error } = await supabase
        .from('version_config_public')
        .select('current_version, min_version, kill_switch, flags')
        .single();

      if (error) {
        checkDetails.version_config_read = `Supabase error: ${error.message}`;
      } else if (!data) {
        checkDetails.version_config_read = 'no rows returned';
      } else {
        // Verify shape
        const hasCurrentVersion = 'current_version' in data;
        const hasMinVersion = 'min_version' in data;
        const hasKillSwitch = 'kill_switch' in data;
        const hasFlags = 'flags' in data;

        if (hasCurrentVersion && hasMinVersion && hasKillSwitch && hasFlags) {
          checks.version_config_read = true;
          checkDetails.version_config_read = `current_version: ${data.current_version}`;
        } else {
          const missing = [
            !hasCurrentVersion && 'current_version',
            !hasMinVersion && 'min_version',
            !hasKillSwitch && 'kill_switch',
            !hasFlags && 'flags',
          ].filter(Boolean);
          checkDetails.version_config_read = `missing fields: ${missing.join(', ')}`;
        }
      }
    }
  } catch (e) {
    checkDetails.version_config_read = `exception: ${e.message}`;
  }

  // ============================================================================
  // 4. READ-BACK & CLEANUP (optional, requires service_role key)
  // ============================================================================
  let canaryRowIds = { telemetry: null, feedback: null };
  let readbackPassed = false;

  if (process.env.SUPABASE_SERVICE_ROLE_KEY) {
    console.log('[canary-check] SUPABASE_SERVICE_ROLE_KEY found — attempting read-back & cleanup...');
    try {
      const admin = getAdminSupabase();

      // Read back telemetry
      const { data: telemetryRows, error: telemetryError } = await admin
        .from('telemetry_events')
        .select('id')
        .eq('kind', 'canary_check')
        .eq('code', 'verification_loop')
        .order('id', { ascending: false })
        .limit(1);

      if (telemetryError) {
        console.log(`  [warning] Failed to read telemetry: ${telemetryError.message}`);
      } else if (telemetryRows && telemetryRows.length > 0) {
        canaryRowIds.telemetry = telemetryRows[0].id;
        console.log(`  [ok] Found telemetry canary row (id: ${canaryRowIds.telemetry})`);
      } else {
        console.log('  [warning] No telemetry canary row found');
      }

      // Read back feedback
      const { data: feedbackRows, error: feedbackError } = await admin
        .from('feedback')
        .select('id')
        .eq('email', 'canary@sidewrite.internal')
        .eq('message', 'automated canary check')
        .order('id', { ascending: false })
        .limit(1);

      if (feedbackError) {
        console.log(`  [warning] Failed to read feedback: ${feedbackError.message}`);
      } else if (feedbackRows && feedbackRows.length > 0) {
        canaryRowIds.feedback = feedbackRows[0].id;
        console.log(`  [ok] Found feedback canary row (id: ${canaryRowIds.feedback})`);
      } else {
        console.log('  [warning] No feedback canary row found');
      }

      // If we found both rows, attempt cleanup
      if (canaryRowIds.telemetry && canaryRowIds.feedback) {
        readbackPassed = true;
        console.log('  [ok] All canary rows found — cleaning up...');

        // Delete telemetry canary
        const { error: delTelemetryError } = await admin
          .from('telemetry_events')
          .delete()
          .eq('id', canaryRowIds.telemetry);

        if (delTelemetryError) {
          console.log(`  [warning] Failed to delete telemetry row: ${delTelemetryError.message}`);
        } else {
          console.log(`  [ok] Deleted telemetry canary row`);
        }

        // Delete feedback canary
        const { error: delFeedbackError } = await admin
          .from('feedback')
          .delete()
          .eq('id', canaryRowIds.feedback);

        if (delFeedbackError) {
          console.log(`  [warning] Failed to delete feedback row: ${delFeedbackError.message}`);
        } else {
          console.log(`  [ok] Deleted feedback canary row`);
        }
      } else {
        console.log('  [warning] Could not find both canary rows for cleanup — skipping deletion');
      }
    } catch (e) {
      console.log(`  [error] Read-back exception: ${e.message}`);
    }
    console.log('');
  } else {
    console.log('[canary-check] SUPABASE_SERVICE_ROLE_KEY not set — read-back & cleanup skipped (expected)');
    console.log('');
  }

  // ============================================================================
  // RESULTS
  // ============================================================================
  const allHardChecksPassed = checks.telemetry_insert && checks.feedback_insert && checks.version_config_read;

  console.log('CANARY CHECK RESULTS:');
  console.log(formatCheck('Telemetry Insert (telemetry_events)', checks.telemetry_insert, checkDetails.telemetry_insert));
  console.log(formatCheck('Feedback Insert (feedback)', checks.feedback_insert, checkDetails.feedback_insert));
  console.log(formatCheck('Version Config Read (version_config_public)', checks.version_config_read, checkDetails.version_config_read));

  if (process.env.SUPABASE_SERVICE_ROLE_KEY) {
    console.log(formatCheck('Read-Back & Cleanup (optional)', readbackPassed, readbackPassed ? 'rows verified and cleaned' : 'see details above'));
  } else {
    console.log('  SKIP: Read-Back & Cleanup (optional) — no service_role key available');
  }

  console.log('');

  if (allHardChecksPassed) {
    console.log('✓ All hard-required checks PASSED');
    process.exit(0);
  } else {
    console.log('✗ One or more hard-required checks FAILED');
    process.exit(1);
  }
}

main().catch((e) => {
  console.error('[canary-check] Fatal error:', e);
  process.exit(1);
});
