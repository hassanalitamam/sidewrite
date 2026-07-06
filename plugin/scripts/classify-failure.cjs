#!/usr/bin/env node
'use strict';

/*
 * classify-failure <exitCode> <errlogPath> [resultPath] — turn a failed
 * implement run (any provider) into a reason + human detail.
 *
 * Prints one line: "<reason>|<detail>"
 *   ok                — exit 0, nothing to classify
 *   no_credit         — insufficient balance / quota / billing
 *   auth              — key rejected / unauthorized
 *   rate_limit        — throttled / overloaded
 *   model_unavailable — model not found / unsupported at this provider
 *   provider_down     — 5xx / network / connection error
 *   timeout           — killed by the watchdog or timed out
 *   unknown           — failed for a reason we couldn't name (detail = last line)
 *
 * Reads the provider's stderr tail (and optional stream-json result file) and
 * pattern-matches HTTP codes / error phrasing. node: builtins only.
 */

const fs = require('fs');

const code = parseInt(process.argv[2] || '1', 10);
let txt = '';
try { txt = fs.readFileSync(process.argv[3] || '', 'utf8'); } catch (_) {}
try { if (process.argv[4]) txt += '\n' + fs.readFileSync(process.argv[4], 'utf8'); } catch (_) {}
const tail = txt.slice(-6000);

function out(reason, detail) {
  process.stdout.write(reason + '|' + (detail || ''));
  process.exit(0);
}

if (code === 0) out('ok', '');

// Content-based reasons are checked FIRST so they win over the generic
// "killed => exit 143 => timeout" default: when the watchdog fast-fails a run on
// a clear provider error (402 no-credit, 401 bad key, 429...), report THAT
// actionable reason rather than a misleading "timeout".
if (/\b402\b|insufficient|no credit|\bcredits?\b|quota|balance|payment required|billing|top[ _-]?up|add funds/i.test(tail)) {
  out('no_credit', firstMatchLine(tail, /402|insufficient|credit|quota|balance|billing|payment/i) || 'provider reported insufficient credit/quota');
}
if (/\b401\b|\b403\b|unauthoriz|invalid[ _-]?api[ _-]?key|invalid_api_key|authentication|forbidden|permission denied/i.test(tail)) {
  out('auth', firstMatchLine(tail, /401|403|unauthor|invalid.*key|authentication|forbidden/i) || 'provider rejected the API key');
}
if (/\b429\b|rate[ _-]?limit|too many requests|overloaded|slow down/i.test(tail)) {
  out('rate_limit', firstMatchLine(tail, /429|rate|overloaded|too many/i) || 'provider rate-limited the request');
}
if (/\b404\b|model not found|no such model|unknown model|does not exist|unsupported model|not a valid model/i.test(tail)) {
  out('model_unavailable', firstMatchLine(tail, /404|model|unsupported|no such/i) || 'model not available at this provider');
}
if (/\b5\d\d\b|ECONNREFUSED|ENOTFOUND|EAI_AGAIN|ECONNRESET|network error|connection (refused|reset|error)|socket hang|upstream|bad gateway|service unavailable/i.test(tail)) {
  out('provider_down', firstMatchLine(tail, /5\d\d|ECONN|ENOTFOUND|network|connection|upstream|gateway|unavailable/i) || 'provider or network error');
}
// Watchdog kills with SIGTERM => exit 143; also explicit timeout wording. This
// is the FALLBACK when no clearer provider error was found in the log.
if (code === 143 || /\btimed?[ _-]?out\b|ETIMEDOUT|deadline exceeded/i.test(tail)) {
  out('timeout', 'implement exceeded the time limit');
}

const lines = tail.split(/\r?\n/).map((s) => s.trim()).filter(Boolean);
out('unknown', (lines[lines.length - 1] || 'exit ' + code).slice(0, 200));

function firstMatchLine(text, re) {
  for (const line of text.split(/\r?\n/)) {
    if (re.test(line)) return line.trim().slice(0, 200);
  }
  return '';
}
