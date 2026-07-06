#!/usr/bin/env node
'use strict';

/*
 * context7-store — holds the single user-provided Context7 MCP API key
 * (https://context7.com), encrypted at rest via pool-crypto's AES-256-GCM
 * envelope (the same master key/file already used for Free-Tier Pool
 * secrets). One record, ~/.sidewrite/context7.json, mode 0600.
 *
 * apiKey never leaves this process in plaintext: redact() is the only shape
 * that may cross into an HTTP response.
 *
 * node: builtins only — no npm dependencies.
 */

const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const crypto = require('./pool-crypto.cjs');

const HOME = os.homedir();
const DATA_DIR = path.join(HOME, '.sidewrite');
const CONTEXT7_PATH = path.join(DATA_DIR, 'context7.json');
const AAD = 'context7-api-key'; // static: only ever one record, no per-id binding needed

function ensureDir() {
  fs.mkdirSync(DATA_DIR, { recursive: true, mode: 0o700 });
}

function writeFileMode(file, data, mode) {
  const tmp = file + '.tmp' + process.pid;
  fs.writeFileSync(tmp, data, { mode });
  try { fs.chmodSync(tmp, mode); } catch (_) {}
  fs.renameSync(tmp, file);
}

function readRaw() {
  try {
    const j = JSON.parse(fs.readFileSync(CONTEXT7_PATH, 'utf8'));
    if (j && typeof j === 'object') return j;
  } catch (_) {}
  return null;
}

// Returns { hasKey, apiKey } — apiKey is the decrypted plaintext, for
// SERVER-SIDE use only (station fan-out, /test health check). Never send
// this object's apiKey field to an HTTP client.
function readContext7Key() {
  const rec = readRaw();
  if (!rec || !rec.apiKey) return { hasKey: false, apiKey: null };
  try {
    return { hasKey: true, apiKey: crypto.decrypt(rec.apiKey, AAD) };
  } catch (_) {
    // Envelope unreadable (corrupt / master key changed) — fail closed, but
    // still report a key WAS configured so the UI doesn't silently show "no key".
    return { hasKey: true, apiKey: null };
  }
}

// { hasKey: boolean } — the only shape allowed to reach the dashboard client.
function redact() {
  const rec = readRaw();
  return { hasKey: !!(rec && rec.apiKey) };
}

function writeContext7Key(apiKey) {
  ensureDir();
  const envelope = crypto.encrypt(String(apiKey), AAD);
  writeFileMode(CONTEXT7_PATH, JSON.stringify({ version: 1, apiKey: envelope }, null, 2), 0o600);
}

function deleteContext7Key() {
  try { fs.unlinkSync(CONTEXT7_PATH); } catch (_) {}
}

module.exports = {
  CONTEXT7_PATH,
  readContext7Key,
  writeContext7Key,
  deleteContext7Key,
  redact,
};
