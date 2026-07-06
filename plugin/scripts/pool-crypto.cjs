#!/usr/bin/env node
'use strict';

/*
 * pool-crypto — AES-256-GCM envelope encryption for Free-Tier Pool secrets
 * at rest (milestone M4).
 *
 * Scope: this module only knows how to (a) hold one machine-local master
 * key and (b) seal/open envelopes with it. It has NO knowledge of the
 * candidate-record shape or the plaintext-migration path — that lives in
 * pool-store.cjs, which is the only caller. Keeping this module dumb and
 * dependency-free (just node:crypto + node:fs/path/os) means it can also be
 * reused later for any other secret this project ever needs to persist.
 *
 * Master key:
 *   - 32 random bytes (crypto.randomBytes), generated once on first use,
 *     stored hex-encoded as a single line at ~/.sidewrite/freetier/pool-master.key
 *     (dir 0700, file 0600 — same trust boundary as every other secret file
 *     in this project: loopback-only daemon, no multi-tenant auth, OS file
 *     permissions are the actual boundary).
 *   - Never rotated automatically. If the file exists but is malformed
 *     (wrong length/not hex), we throw rather than silently regenerating —
 *     silently regenerating would permanently strand every secret already
 *     encrypted under the old key with no way to recover it.
 *
 * Envelope shape (what gets stored in place of a plaintext string field):
 *   { v: 1, alg: 'aes-256-gcm', iv: base64, tag: base64, ct: base64 }
 *   - iv:  fresh crypto.randomBytes(12) (96-bit, the size GCM is designed
 *          for) generated PER ENCRYPTION CALL — never reused across calls,
 *          even for the same record. Stored alongside the ciphertext since
 *          it isn't secret, just needs to never repeat under the same key.
 *   - tag: the 16-byte GCM auth tag from cipher.getAuthTag(), stored
 *          alongside the ciphertext (this is the standard way to persist a
 *          GCM ciphertext — tag travels with it, checked on decrypt via
 *          decipher.setAuthTag(), and decryption fails closed if either the
 *          ciphertext or the tag has been altered).
 *   - ct:  the ciphertext itself.
 *
 * Optional AAD (associated data): callers may pass a stable id (e.g. the
 * pool-store record id) as `aad`. It's mixed into the GCM auth tag but not
 * encrypted, and decrypt() must be given the SAME aad it was encrypted
 * with or the auth check fails. This binds a ciphertext to the specific
 * record it was written for, so an envelope blob can't be silently copy-
 * pasted from one candidate's JSON file into another's and still decrypt.
 *
 * node: builtins only — no npm dependencies.
 */

const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');

const HOME = os.homedir();
const FREETIER_DIR = path.join(HOME, '.sidewrite', 'freetier');
const MASTER_KEY_PATH = path.join(FREETIER_DIR, 'pool-master.key');

const ALG = 'aes-256-gcm';
const KEY_BYTES = 32; // AES-256
const IV_BYTES = 12; // 96-bit, the size GCM is designed for

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

let cachedKey = null; // avoid a disk read + hex-decode on every candidate

// Returns the 32-byte master key as a Buffer, generating and persisting one
// on first use. Throws (does NOT regenerate) if a key file exists but is
// malformed — see module comment above for why that has to fail closed.
function getOrCreateMasterKey() {
  if (cachedKey) return cachedKey;
  ensureFreetierDir();
  let raw;
  try {
    raw = fs.readFileSync(MASTER_KEY_PATH, 'utf8').trim();
  } catch (err) {
    if (err && err.code === 'ENOENT') {
      const key = crypto.randomBytes(KEY_BYTES);
      writeFileMode(MASTER_KEY_PATH, key.toString('hex') + '\n', 0o600);
      cachedKey = key;
      return key;
    }
    throw err;
  }
  if (!/^[0-9a-f]{64}$/i.test(raw)) {
    throw new Error(
      'pool-crypto: master key file at ' + MASTER_KEY_PATH +
      ' exists but is not a valid 32-byte hex key. Refusing to overwrite it ' +
      '(that would permanently strand every secret already encrypted under it). ' +
      'Restore the original file, or if it is truly lost, every stored ' +
      'freetier apiKey will need to be re-entered after removing it.'
    );
  }
  cachedKey = Buffer.from(raw, 'hex');
  return cachedKey;
}

function isEnvelope(v) {
  return !!v && typeof v === 'object' && !Array.isArray(v) &&
    v.v === 1 && v.alg === ALG &&
    typeof v.iv === 'string' && typeof v.tag === 'string' && typeof v.ct === 'string';
}

// Seals `plaintext` (any string) into an envelope. `aad`, if given, binds
// the ciphertext to that value (see module comment) — pass the same value
// to decrypt().
function encrypt(plaintext, aad) {
  const key = getOrCreateMasterKey();
  const iv = crypto.randomBytes(IV_BYTES); // fresh IV every call, never reused
  const cipher = crypto.createCipheriv(ALG, key, iv);
  if (aad !== undefined && aad !== null) cipher.setAAD(Buffer.from(String(aad), 'utf8'));
  const ct = Buffer.concat([cipher.update(String(plaintext), 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return {
    v: 1,
    alg: ALG,
    iv: iv.toString('base64'),
    tag: tag.toString('base64'),
    ct: ct.toString('base64'),
  };
}

// Opens an envelope produced by encrypt(). Throws on any tamper/mismatch
// (wrong key, wrong aad, corrupted iv/tag/ct) — callers must decide what a
// failed decrypt means for them (pool-store treats it as "unusable secret,
// keep the record visible, drop just the key").
function decrypt(envelope, aad) {
  if (!isEnvelope(envelope)) {
    throw new Error('pool-crypto: not a valid envelope');
  }
  const key = getOrCreateMasterKey();
  const iv = Buffer.from(envelope.iv, 'base64');
  const tag = Buffer.from(envelope.tag, 'base64');
  const ct = Buffer.from(envelope.ct, 'base64');
  const decipher = crypto.createDecipheriv(ALG, key, iv);
  if (aad !== undefined && aad !== null) decipher.setAAD(Buffer.from(String(aad), 'utf8'));
  decipher.setAuthTag(tag);
  const pt = Buffer.concat([decipher.update(ct), decipher.final()]);
  return pt.toString('utf8');
}

module.exports = {
  MASTER_KEY_PATH,
  isEnvelope,
  encrypt,
  decrypt,
  // exported for doctor.cjs-style diagnostics only — never log the return value
  getOrCreateMasterKey,
};
