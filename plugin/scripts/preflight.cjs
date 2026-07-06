#!/usr/bin/env node
'use strict';

/*
 * preflight <provider> — a fast, pre-run capability/credit probe.
 *
 * Prints one line: "<verdict>|<detail>"
 *   ok           — good to go (or unlimited / pay-as-you-go)
 *   no_credit    — the provider has no usable balance; skip it
 *   auth         — the provider rejected the key; skip it
 *   skip         — no probe available for this provider (just run and see)
 *
 * Only OpenRouter is actively probed (GET /api/v1/key exposes limit_remaining
 * for the SAME key). Every other provider returns "skip" — the run itself plus
 * the classifier catch any failure, so failover still covers any provider.
 *
 * node: builtins only, no deps. Never throws; worst case prints "skip".
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const https = require('https');

const HOME = process.env.HOME || os.homedir();
const name = process.argv[2];

function out(verdict, detail) {
  process.stdout.write(verdict + '|' + (detail || ''));
  process.exit(0);
}

if (!name) out('skip', 'no provider');

let env = {};
try {
  const raw = fs.readFileSync(path.join(HOME, '.claude-providers', name + '.env'), 'utf8');
  for (const line of raw.split(/\r?\n/)) {
    const t = line.trim();
    if (!t || t.startsWith('#')) continue;
    const i = t.indexOf('=');
    if (i < 0) continue;
    let k = t.slice(0, i).trim();
    if (k.startsWith('export ')) k = k.slice(7).trim();
    let v = t.slice(i + 1).trim();
    if (v.length >= 2 && v[0] === '"' && v.endsWith('"')) v = v.slice(1, -1).replace(/\\(["\\$`])/g, '$1');
    else if (v.length >= 2 && v[0] === "'" && v.endsWith("'")) v = v.slice(1, -1);
    env[k] = v;
  }
} catch (_) {
  out('skip', 'no registry file');
}

const base = env.CCX_BASE_URL || '';
const token = env.CCX_TOKEN || '';

// Only OpenRouter exposes a credit endpoint keyed by the same token.
if (!/openrouter\.ai/i.test(base) || !token) out('skip', 'no probe for this provider');

const u = new URL('https://openrouter.ai/api/v1/key');
const req = https.request(
  {
    method: 'GET',
    hostname: u.hostname,
    path: u.pathname,
    headers: { Authorization: 'Bearer ' + token, Accept: 'application/json', 'User-Agent': 'sidewrite' },
  },
  (r) => {
    let b = '';
    r.setEncoding('utf8');
    r.on('data', (c) => (b += c));
    r.on('end', () => {
      if (r.statusCode === 401 || r.statusCode === 403) out('auth', 'OpenRouter rejected the key (HTTP ' + r.statusCode + ')');
      if (r.statusCode !== 200) out('skip', 'key endpoint HTTP ' + r.statusCode);
      let j;
      try { j = JSON.parse(b); } catch (_) { out('skip', 'bad JSON'); }
      const d = (j && j.data) || {};
      const rem = d.limit_remaining;
      // null => unlimited / pay-as-you-go => fine.
      if (rem != null && Number(rem) <= 0) out('no_credit', 'OpenRouter credits exhausted (limit_remaining=' + rem + ')');
      if (d.limit != null && d.usage != null && Number(d.usage) >= Number(d.limit)) out('no_credit', 'OpenRouter usage >= limit');
      out('ok', 'remaining=' + (rem == null ? 'unlimited' : rem));
    });
  }
);
req.on('error', () => out('skip', 'network error'));
req.setTimeout(6000, () => { req.destroy(); out('skip', 'timeout'); });
req.end();
