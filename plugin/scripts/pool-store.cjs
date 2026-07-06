#!/usr/bin/env node
'use strict';

/*
 * pool-store — CRUD for Free-Tier Pool key registrations.
 *
 * Mirrors the existing ~/.claude-providers/<name>.env pattern (see
 * providerFilePath/writeProvider in viewer-daemon.cjs) but as one plain JSON
 * file per registered (provider, model) entry under ~/.sidewrite/freetier/,
 * since pool entries carry richer typed fields (numeric limits, tier,
 * priority) than the flat KV .env shape suits. Same security posture as the
 * rest of the codebase: OS file permissions (dir 0700, file 0600) as the
 * base trust boundary (loopback-only daemon, no multi-tenant auth), PLUS an
 * AES-256-GCM envelope encryption layer on top for apiKey specifically, so
 * the secret itself isn't sitting in the clear even within that boundary —
 * see pool-crypto.cjs for the primitives.
 *
 * Plaintext migration: records written before encryption shipped have
 * apiKey as a bare string. readFreetierKey() detects that (pool-crypto's
 * envelope has a {v:1, alg:'aes-256-gcm', ...} shape; a legacy record is
 * just a string) and transparently re-encrypts it back to disk the first
 * time it's read, no user action required. writeFreetierKey() also always
 * writes the on-disk copy through pool-crypto.encrypt(), so any record
 * touched by either path ends up encrypted going forward. The in-memory
 * rec.apiKey callers see is ALWAYS plaintext (decrypted on read) — only the
 * bytes on disk are ever ciphertext.
 *
 * node: builtins only — no npm dependencies.
 */

const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');
const pcrypto = require('./pool-crypto.cjs');

const HOME = os.homedir();
const DATA_DIR = path.join(HOME, '.sidewrite');
const FREETIER_DIR = path.join(DATA_DIR, 'freetier');

function ensureFreetierDir() {
  fs.mkdirSync(FREETIER_DIR, { recursive: true, mode: 0o700 });
  try { fs.chmodSync(FREETIER_DIR, 0o700); } catch (_) {}
}

function writeFileMode(file, data, mode) {
  const tmp = file + '.tmp' + process.pid;
  fs.writeFileSync(tmp, data, { mode });
  try { fs.chmodSync(tmp, mode); } catch (_) {}
  fs.renameSync(tmp, file);
}

function idSafe(id) {
  return typeof id === 'string' && /^[A-Za-z0-9._-]{1,64}$/.test(id);
}

function keyFilePath(id) {
  return path.join(FREETIER_DIR, id + '.json');
}

// A fresh id: <providerId>-<8 hex chars>, always filesystem-safe.
function genId(providerId) {
  const base = String(providerId || 'key').toLowerCase().replace(/[^a-z0-9._-]/g, '-').slice(0, 32);
  return base + '-' + crypto.randomBytes(4).toString('hex');
}

function readFreetierKey(id) {
  if (!idSafe(id)) return null;
  try {
    const raw = fs.readFileSync(keyFilePath(id), 'utf8');
    const rec = JSON.parse(raw);
    rec.id = id;
    resolveApiKeyOnRead(rec, id);
    return rec;
  } catch (_) {
    return null;
  }
}

// Turns whatever is on disk in rec.apiKey into a plaintext string in memory,
// migrating legacy plaintext records to an encrypted envelope on disk along
// the way. Mutates `rec` in place. Never throws — decrypt/migrate failures
// degrade to "record visible, key unusable" rather than making the whole
// record disappear (the dashboard couldn't otherwise show the user which
// entry is broken).
function resolveApiKeyOnRead(rec, id) {
  if (rec.apiKey === undefined || rec.apiKey === null || rec.apiKey === '') return;

  if (pcrypto.isEnvelope(rec.apiKey)) {
    try {
      rec.apiKey = pcrypto.decrypt(rec.apiKey, id);
    } catch (_) {
      // Corrupted envelope, or the master key was lost/rotated out from
      // under it — fail closed. The record (label/baseUrl/model/etc.)
      // stays visible; the secret is simply gone until re-entered.
      rec.apiKey = undefined;
      rec.keyDecryptFailed = true;
    }
    return;
  }

  // Legacy plaintext record (written before at-rest encryption shipped).
  // rec.apiKey is already the plaintext the caller needs — just
  // opportunistically upgrade the on-disk copy so this branch is never hit
  // again for this id. Best-effort: if the rewrite fails (e.g. read-only
  // fs), the record is simply still plaintext on disk and gets the same
  // upgrade attempt on the next read, or the next writeFreetierKey() call.
  try {
    const onDisk = Object.assign({}, rec, { apiKey: pcrypto.encrypt(rec.apiKey, id) });
    writeFileMode(keyFilePath(id), JSON.stringify(onDisk), 0o600);
  } catch (_) {}
}

// List every registered key, sorted by (tier, priority) so callers get the
// exact candidate order the router should try — lower priority number first.
function listFreetierKeys() {
  ensureFreetierDir();
  let files = [];
  try {
    files = fs.readdirSync(FREETIER_DIR);
  } catch (_) {
    return [];
  }
  const out = [];
  for (const f of files) {
    if (!f.endsWith('.json') || f.endsWith('.tmp')) continue;
    const id = f.slice(0, -5);
    const rec = readFreetierKey(id);
    if (rec) out.push(rec);
  }
  out.sort((a, b) => {
    if (a.tier !== b.tier) return String(a.tier || '').localeCompare(String(b.tier || ''));
    return (Number(a.priority) || 0) - (Number(b.priority) || 0);
  });
  return out;
}

// Redact apiKey for anything that leaves this process toward the dashboard —
// same "never echo the key back" invariant as the existing providers list.
function redact(rec) {
  if (!rec) return rec;
  const { apiKey, ...rest } = rec;
  rest.hasKey = !!apiKey;
  return rest;
}

const VALID_TIERS = new Set(['opus', 'sonnet', 'haiku']);

function writeFreetierKey(id, fields) {
  ensureFreetierDir();
  if (!idSafe(id)) throw new Error('invalid freetier key id');
  const existing = readFreetierKey(id) || {};
  const rec = Object.assign({}, existing);

  if (fields.providerId !== undefined) rec.providerId = String(fields.providerId);
  if (fields.label !== undefined) rec.label = String(fields.label || '');
  if (fields.baseUrl !== undefined) rec.baseUrl = String(fields.baseUrl || '');
  if (fields.model !== undefined) rec.model = String(fields.model || '');
  if (fields.tier !== undefined) rec.tier = VALID_TIERS.has(fields.tier) ? fields.tier : 'sonnet';
  if (fields.priority !== undefined) rec.priority = Number(fields.priority) || 0;
  // Declared context window (tokens). Used by pool-router as a tie-break when
  // two candidates in the same tier share a priority (the common case, since
  // every newly-added key defaults to priority 0) — prefers the model that
  // can actually hold more of the conversation over an arbitrary pick.
  if (fields.contextWindow !== undefined) rec.contextWindow = numOrNull(fields.contextWindow);
  if (fields.enabled !== undefined) rec.enabled = !!fields.enabled;
  if (fields.limits !== undefined && fields.limits && typeof fields.limits === 'object') {
    rec.limits = {
      rpm: numOrNull(fields.limits.rpm),
      rpd: numOrNull(fields.limits.rpd),
      tpm: numOrNull(fields.limits.tpm),
      tpd: numOrNull(fields.limits.tpd),
    };
  }
  // Same masked-value guard as writeProvider(): an empty string or a
  // dashboard-displayed mask never overwrites a previously saved key.
  const isMask = typeof fields.apiKey === 'string' && fields.apiKey.trim() !== '' && /^[•*·\s]+$/.test(fields.apiKey.trim());
  if (fields.apiKey !== undefined && fields.apiKey !== null && fields.apiKey !== '' && !isMask) {
    rec.apiKey = fields.apiKey;
  }
  if (rec.enabled === undefined) rec.enabled = true;
  if (rec.priority === undefined) rec.priority = 0;
  if (rec.tier === undefined) rec.tier = 'sonnet';
  if (!rec.createdAt) rec.createdAt = Date.now();
  rec.updatedAt = Date.now();

  // `rec` (returned to the caller) always keeps apiKey as plaintext — every
  // existing caller relies on that (pool-router reading candidate.apiKey
  // straight off a listFreetierKeys() result, redact() stripping it before
  // anything reaches the dashboard). Only the copy that hits disk is ever
  // encrypted.
  const onDisk = Object.assign({}, rec);
  if (onDisk.apiKey !== undefined && onDisk.apiKey !== null && onDisk.apiKey !== '') {
    onDisk.apiKey = pcrypto.encrypt(onDisk.apiKey, id);
  }
  writeFileMode(keyFilePath(id), JSON.stringify(onDisk), 0o600);
  return rec;
}

function deleteFreetierKey(id) {
  if (!idSafe(id)) return false;
  try {
    fs.unlinkSync(keyFilePath(id));
    return true;
  } catch (_) {
    return false;
  }
}

// Bulk priority reorder: `orderedIds` is the full new top-to-bottom order
// WITHIN one tier. Assigns 0..N-1 so the router's tie-break stays stable.
function reorderFreetierKeys(orderedIds) {
  if (!Array.isArray(orderedIds)) return;
  orderedIds.forEach((id, idx) => {
    if (idSafe(id) && readFreetierKey(id)) writeFreetierKey(id, { priority: idx });
  });
}

function numOrNull(v) {
  if (v === null || v === undefined || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? n : null;
}

// The pool's unified access token — DISTINCT from the dashboard's per-boot
// bearer TOKEN. ccx needs a credential that survives a daemon restart (it's
// written once into a provider .env file), so this one is generated on first
// use and persisted, never regenerated automatically.
const POOL_TOKEN_PATH = path.join(FREETIER_DIR, 'pool.token');

function getOrCreatePoolToken() {
  ensureFreetierDir();
  try {
    const existing = fs.readFileSync(POOL_TOKEN_PATH, 'utf8').trim();
    if (existing) return existing;
  } catch (_) {}
  const token = 'ftpool-' + crypto.randomBytes(24).toString('hex');
  writeFileMode(POOL_TOKEN_PATH, token, 0o600);
  return token;
}

function regeneratePoolToken() {
  const token = 'ftpool-' + crypto.randomBytes(24).toString('hex');
  ensureFreetierDir();
  writeFileMode(POOL_TOKEN_PATH, token, 0o600);
  return token;
}

function poolTokenMatches(provided) {
  if (typeof provided !== 'string' || !provided) return false;
  const expected = getOrCreatePoolToken();
  if (provided.length !== expected.length) return false;
  try {
    return crypto.timingSafeEqual(Buffer.from(provided), Buffer.from(expected));
  } catch (_) {
    return false;
  }
}

module.exports = {
  FREETIER_DIR,
  ensureFreetierDir,
  idSafe,
  genId,
  readFreetierKey,
  listFreetierKeys,
  writeFreetierKey,
  deleteFreetierKey,
  reorderFreetierKeys,
  redact,
  getOrCreatePoolToken,
  regeneratePoolToken,
  poolTokenMatches,
};
