#!/usr/bin/env node
'use strict';

/*
 * pool-compact-cache — Content cache for Compress-Cache-Retrieve (CCR) pattern.
 *
 * Stores omitted text segments locally and provides retrieval by content hash.
 * Used by pool-compact.cjs to enable lossless context management: instead of
 * permanently deleting content, we stash it and give the model a tool to
 * retrieve it on demand if needed.
 *
 * Node core only, no external dependencies.
 */

const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');

const CACHE_DIR = path.join(os.homedir(), '.sidewrite', 'pool-compact-cache');

// Run cache pruning probabilistically (1-in-50 calls) to avoid full-directory
// scans on every single store operation. Wrapped in try/catch — never throw.
function pruneOldCacheFiles(maxAgeMs = 7 * 24 * 60 * 60 * 1000) {
  try {
    // 1-in-50 chance of running
    if (Math.random() > 0.02) return;

    if (!fs.existsSync(CACHE_DIR)) return;

    const now = Date.now();
    const files = fs.readdirSync(CACHE_DIR);

    for (const file of files) {
      try {
        const filePath = path.join(CACHE_DIR, file);
        const stats = fs.statSync(filePath);
        if (now - stats.mtimeMs > maxAgeMs) {
          fs.unlinkSync(filePath);
        }
      } catch (_) {
        // Skip individual file errors; best-effort cleanup
      }
    }
  } catch (_) {
    // Best-effort: never throw from pruning
  }
}

// Store original text in cache, identified by content hash (sha256).
// Returns a short ref string (first 16 hex chars of the hash).
// On write failure, still returns the ref — the caller's marker text will
// just be non-retrievable in that rare case, but the request completes.
// Never throws.
function storeOriginal(text) {
  try {
    // Normalize input to string for hashing
    const textStr = typeof text === 'string' ? text : String(text || '');
    const hash = crypto.createHash('sha256').update(textStr, 'utf-8').digest('hex');
    const ref = hash.slice(0, 16);
    const filePath = path.join(CACHE_DIR, ref + '.txt');

    // Content-addressed: if the file already exists, don't rewrite it
    if (fs.existsSync(filePath)) {
      return ref;
    }

    // Create cache directory if needed
    if (!fs.existsSync(CACHE_DIR)) {
      fs.mkdirSync(CACHE_DIR, { recursive: true });
    }

    // Write the text
    fs.writeFileSync(filePath, textStr, 'utf-8');

    // Opportunistic pruning
    pruneOldCacheFiles();

    return ref;
  } catch (_) {
    // On any error, we still compute and return the ref so the caller's
    // marker text is consistent (same input -> same ref), even if retrieval
    // later fails. Best-effort behavior; never crash the request.
    try {
      const textStr = typeof text === 'string' ? text : String(text || '');
      const hash = crypto.createHash('sha256').update(textStr, 'utf-8').digest('hex');
      return hash.slice(0, 16);
    } catch (__) {
      // Last resort: return a dummy ref so the caller never gets null/throws
      return 'error00000000';
    }
  }
}

// Retrieve original text from cache by ref.
// Returns the text if found, or null if missing/unreadable/any error.
// Never throws.
function retrieveOriginal(ref) {
  try {
    if (!ref || typeof ref !== 'string') return null;

    const filePath = path.join(CACHE_DIR, ref + '.txt');

    if (!fs.existsSync(filePath)) {
      return null;
    }

    const text = fs.readFileSync(filePath, 'utf-8');
    return text;
  } catch (_) {
    // Any error: return null, never throw
    return null;
  }
}

module.exports = { storeOriginal, retrieveOriginal };
