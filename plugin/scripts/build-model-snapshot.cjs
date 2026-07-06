#!/usr/bin/env node
'use strict';

/*
 * build-model-snapshot — regenerate the bundled OpenRouter catalog snapshot.
 *
 * Run at release time (or whenever you want to refresh the shipped list):
 *   node plugin/scripts/build-model-snapshot.cjs
 *
 * Fetches https://openrouter.ai/api/v1/models, keeps only the models Claude Code
 * can drive through OpenRouter's Anthropic endpoint (tool/function calling + text
 * output), normalizes them to {id,name,vendor,context,in,out} (prices USD per 1M),
 * and writes plugin/data/openrouter-models.json. Node built-ins only.
 */

const fs = require('fs');
const path = require('path');
const https = require('https');

const OUT = path.join(__dirname, '..', 'data', 'openrouter-models.json');
const URL_STR = 'https://openrouter.ai/api/v1/models';
const BASE = 'https://openrouter.ai/api';

function isCompatible(m) {
  return !!(
    m &&
    Array.isArray(m.supported_parameters) &&
    m.supported_parameters.includes('tools') &&
    m.architecture &&
    Array.isArray(m.architecture.output_modalities) &&
    m.architecture.output_modalities.includes('text')
  );
}

function perMillion(v) {
  const n = parseFloat(v);
  if (!isFinite(n) || n < 0) return 0;
  return Math.round(n * 1e6 * 1e6) / 1e6;
}

function normalize(m) {
  return {
    id: m.id,
    name: m.name || m.id,
    vendor: String(m.id || '').split('/')[0] || 'other',
    context: m.context_length || (m.top_provider && m.top_provider.context_length) || 0,
    in: perMillion(m.pricing && m.pricing.prompt),
    out: perMillion(m.pricing && m.pricing.completion),
  };
}

function fetchJson(u) {
  return new Promise((resolve, reject) => {
    const req = https.request(
      u,
      { headers: { Accept: 'application/json', 'User-Agent': 'sidewrite-build' } },
      (r) => {
        let body = '';
        r.setEncoding('utf8');
        r.on('data', (c) => (body += c));
        r.on('end', () => {
          if (r.statusCode !== 200) return reject(new Error('HTTP ' + r.statusCode));
          try { resolve(JSON.parse(body)); } catch (e) { reject(e); }
        });
      }
    );
    req.on('error', reject);
    req.setTimeout(20000, () => { req.destroy(); reject(new Error('timed out')); });
    req.end();
  });
}

(async function main() {
  try {
    const j = await fetchJson(URL_STR);
    const models = ((j && j.data) || [])
      .filter(isCompatible)
      .map(normalize)
      .filter((m) => m.id)
      .sort((a, b) => a.vendor.localeCompare(b.vendor) || a.name.localeCompare(b.name));
    const envelope = {
      version: 1,
      source: 'openrouter',
      baseUrl: BASE,
      note: 'Anthropic/tool-use compatible subset; refresh from dashboard',
      count: models.length,
      models,
    };
    fs.mkdirSync(path.dirname(OUT), { recursive: true });
    fs.writeFileSync(OUT, JSON.stringify(envelope, null, 2) + '\n');
    process.stdout.write('wrote ' + models.length + ' models -> ' + OUT + '\n');
  } catch (err) {
    process.stderr.write('build-model-snapshot failed: ' + (err && err.message) + '\n');
    process.exit(1);
  }
})();
