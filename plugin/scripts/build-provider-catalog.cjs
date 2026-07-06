#!/usr/bin/env node
'use strict';

/*
 * build-provider-catalog — regenerate the bundled provider catalog from models.dev.
 *
 * Run at release time (or whenever you want to refresh the shipped catalog):
 *   node plugin/scripts/build-provider-catalog.cjs
 *
 * Pipeline:
 *   1. Fetch https://models.dev/api.json (the community model registry).
 *   2. Read the hand-curated overlay plugin/data/anthropic-endpoints.json — the
 *      source of Anthropic-wire TRUTH (baseUrl / keyHint / docsUrl / notes / logo /
 *      modelsDevId). Only providers listed there are eligible.
 *   3. For each overlay provider, JOIN the models.dev model list (matched by
 *      modelsDevId), keeping only text-output + tool-capable models, normalized to
 *      {id,name,in,out,context} (prices USD per 1M; null when unpriced). Providers
 *      absent from models.dev (modelsDevId=null) fall back to their overlay `models`.
 *   4. Write plugin/data/providers.json in the catalog schema — every entry is
 *      anthropicCompatible:true, gateway:null, source:"models.dev" (or "manual"),
 *      logo:"/logos/<id>.svg" when the self-hosted asset exists (else null).
 *
 * Node built-ins only. Idempotent (deterministic sort). Offline-safe: if the fetch
 * fails, the existing providers.json is left untouched and the script exits non-zero.
 *
 * Invariants preserved: never api.anthropic.com; no writes outside plugin/data; the
 * overlay endpoints are Anthropic-wire only.
 */

const fs = require('fs');
const path = require('path');
const https = require('https');

const DATA_DIR = path.join(__dirname, '..', 'data');
const LOGO_DIR = path.join(__dirname, '..', 'ui', 'logos');
const OVERLAY = path.join(DATA_DIR, 'anthropic-endpoints.json');
const OUT = path.join(DATA_DIR, 'providers.json');
const MODELS_DEV = 'https://models.dev/api.json';

// ---- helpers ---------------------------------------------------------------

function fetchJson(u, redirects) {
  redirects = redirects || 0;
  return new Promise((resolve, reject) => {
    const req = https.request(
      u,
      { headers: { Accept: 'application/json', 'User-Agent': 'sidewrite-build' } },
      (r) => {
        // follow a couple of redirects, just in case models.dev moves the asset
        if (r.statusCode >= 300 && r.statusCode < 400 && r.headers.location && redirects < 4) {
          r.resume();
          const next = new URL(r.headers.location, u).toString();
          return resolve(fetchJson(next, redirects + 1));
        }
        let body = '';
        r.setEncoding('utf8');
        r.on('data', (c) => (body += c));
        r.on('end', () => {
          if (r.statusCode !== 200) return reject(new Error('HTTP ' + r.statusCode + ' from ' + u));
          try { resolve(JSON.parse(body)); } catch (e) { reject(new Error('bad JSON from ' + u + ': ' + e.message)); }
        });
      }
    );
    req.on('error', reject);
    req.setTimeout(30000, () => { req.destroy(); reject(new Error('timed out fetching ' + u)); });
    req.end();
  });
}

function money(v) {
  return typeof v === 'number' && isFinite(v) ? v : null;
}

// models.dev model -> catalog model. Prices are already USD per 1M tokens.
function toCatalogModel(m) {
  return {
    id: m.id,
    name: m.name || m.id,
    in: money(m.cost && m.cost.input),
    out: money(m.cost && m.cost.output),
    context: m.limit && typeof m.limit.context === 'number' ? m.limit.context : null,
  };
}

// text output + tool/function calling — the only models Claude Code can drive.
function isDrivable(m) {
  return !!(
    m &&
    m.tool_call === true &&
    m.modalities &&
    Array.isArray(m.modalities.output) &&
    m.modalities.output.includes('text')
  );
}

function hasLogo(id) {
  try { return fs.statSync(path.join(LOGO_DIR, id + '.svg')).isFile(); }
  catch (_) { return false; }
}

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

// ---- main ------------------------------------------------------------------

(async function main() {
  // Overlay is required (it is the eligibility list). A missing/broken overlay is a
  // hard error regardless of network state.
  let overlay;
  try {
    overlay = readJson(OVERLAY);
  } catch (e) {
    process.stderr.write('build-provider-catalog: cannot read overlay ' + OVERLAY + ': ' + e.message + '\n');
    process.exit(1);
    return;
  }
  const providersIn = overlay && overlay.providers;
  if (!providersIn || typeof providersIn !== 'object') {
    process.stderr.write('build-provider-catalog: overlay has no `providers` map\n');
    process.exit(1);
    return;
  }

  // Fetch models.dev. On any failure, keep the existing providers.json (offline-safe).
  let apiData;
  try {
    apiData = await fetchJson(MODELS_DEV);
  } catch (err) {
    const kept = fs.existsSync(OUT) ? ' — existing ' + OUT + ' left untouched' : ' — no existing catalog to fall back to';
    process.stderr.write('build-provider-catalog: models.dev fetch failed: ' + (err && err.message) + kept + '\n');
    process.exit(1);
    return;
  }

  const providers = [];
  const summary = [];
  for (const id of Object.keys(providersIn)) {
    const p = providersIn[id] || {};
    const devId = p.modelsDevId || null;
    const src = devId && apiData[devId] ? apiData[devId] : null;

    let models;
    let source;
    if (src && src.models) {
      models = Object.values(src.models)
        .filter(isDrivable)
        .map(toCatalogModel)
        .filter((m) => m.id)
        .sort((a, b) => a.id.localeCompare(b.id));
      source = 'models.dev';
    } else {
      // provider absent from models.dev (or explicitly null): use hand-curated seed.
      // Confirmed: modelsDevId:null providers (sambanova, vllm, cloudflare-ai-gateway)
      // land here with source:'manual' and their overlay `models[]` carried through
      // untouched — no models.dev join is attempted for them.
      models = Array.isArray(p.models) ? p.models.slice() : [];
      source = devId ? 'models.dev-missing' : 'manual';
      if (devId && !src) {
        process.stderr.write('build-provider-catalog: WARN modelsDevId "' + devId + '" for ' + id + ' not in models.dev — using overlay seed (' + models.length + ')\n');
      }
    }

    const entry = {
      id: id,
      name: p.name || id,
      baseUrl: p.baseUrl,
      anthropicCompatible: true,
      gateway: null,
      modelsEndpoint: p.modelsEndpoint || null,
      keyHint: p.keyHint || null,
      docsUrl: p.docsUrl || null,
      logo: hasLogo(id) ? '/logos/' + id + '.svg' : null,
      local: !!p.local,
      featured: !!p.featured,
      source: source,
      notes: p.notes || null,
      models: models,
    };
    providers.push(entry);
    summary.push(id + '(' + models.length + (entry.logo ? '' : ',no-logo') + ')');
  }

  // Offline-safe, part 2: a fetch that *succeeds* (HTTP 200, valid JSON) but whose
  // payload contains NONE of our expected providers (e.g. models.dev serves `{}` or an
  // unrelated document) is a data failure just like a dropped connection — writing it
  // would silently collapse every models.dev provider to its (usually empty) seed and
  // clobber the shipped catalog. Refuse and keep the existing file, exit non-zero.
  const expected = Object.keys(providersIn).filter((id) => (providersIn[id] || {}).modelsDevId);
  const joined = providers.filter((e) => e.source === 'models.dev');
  if (expected.length && joined.length === 0) {
    const kept = fs.existsSync(OUT) ? ' — existing ' + OUT + ' left untouched' : ' — no existing catalog to fall back to';
    process.stderr.write(
      'build-provider-catalog: REFUSING — models.dev returned none of the ' + expected.length +
      ' expected providers (empty/unrecognized payload)' + kept + '\n'
    );
    process.exit(1);
    return;
  }

  // Guard the load-bearing invariant right here in the builder.
  const bad = providers.filter((e) => /(^|\/\/)api\.anthropic\.com/i.test(String(e.baseUrl || '')));
  if (bad.length) {
    process.stderr.write('build-provider-catalog: REFUSING — api.anthropic.com base URL in ' + bad.map((e) => e.id).join(', ') + '\n');
    process.exit(1);
    return;
  }

  // Bump version off the existing catalog; stamp today's date.
  let prevVersion = 0;
  try { prevVersion = Number(readJson(OUT).version) || 0; } catch (_) { prevVersion = 0; }

  const out = {
    version: prevVersion + 1,
    updated: new Date().toISOString().slice(0, 10),
    source: 'models.dev',
    note:
      'Auto-generated by build-provider-catalog.cjs from models.dev, filtered to the ' +
      'Anthropic-wire providers in anthropic-endpoints.json. anthropicCompatible=true ' +
      'plug in DIRECTLY (base URL + API key, never api.anthropic.com). local=true run ' +
      'on this machine. Models are text+tool-capable only; prices USD per 1M tokens ' +
      '(null = unpriced). Edit the overlay, then re-run this script to refresh.',
    providers: providers,
  };

  fs.writeFileSync(OUT, JSON.stringify(out, null, 2) + '\n');

  const totalModels = providers.reduce((n, e) => n + e.models.length, 0);
  process.stdout.write(
    'wrote ' + providers.length + ' providers, ' + totalModels + ' models (v' + out.version + ') -> ' + OUT + '\n'
  );
  process.stdout.write('  ' + summary.join(' ') + '\n');
})().catch((err) => {
  process.stderr.write('build-provider-catalog: unexpected error: ' + (err && err.stack || err) + '\n');
  process.exit(1);
});
