#!/usr/bin/env node
'use strict';

/*
 * pool-compact — Message history compaction for the Free-Tier Pool.
 *
 * Implements opt-out compaction of long message histories:
 *   - Only engages once the WHOLE request is actually big enough that
 *     compaction serves a purpose (see poolCompactMinTokens below) — a short
 *     conversation that merely happens to contain two identical 1200-char
 *     `ls` outputs must never lose that content just because it matches the
 *     per-block dedup/truncate rules; those rules only apply once the
 *     request as a whole is worth shrinking.
 *   - Deduplicates large identical text/tool_result blocks (>1000 chars)
 *   - Truncates very long blocks (>8000 chars) to head + tail (except last message)
 *   - Never drops or reorders messages, never touches .system
 *   - Stores omitted content in cache for on-demand retrieval (CCR pattern)
 *   - Node core only, no external dependencies
 */

const fs = require('node:fs');
const path = require('node:path');
const { storeOriginal, retrieveOriginal } = require('./pool-compact-cache.cjs');

function readConfigSafe() {
  try {
    const configPath = path.join(process.env.HOME || process.env.USERPROFILE || '', '.sidewrite', 'config.json');
    if (!fs.existsSync(configPath)) return {};
    return JSON.parse(fs.readFileSync(configPath, 'utf-8')) || {};
  } catch (err) {
    return {};
  }
}

// Read ~/.sidewrite/config.json; if cfg.features.poolCompact === false, return input unchanged.
// Missing file/key means enabled (default true).
function isPoolCompactEnabled() {
  const cfg = readConfigSafe();
  if (cfg.features && cfg.features.poolCompact === false) return false;
  return true; // enabled by default
}

// Default: only start compacting once the WHOLE request is already at
// ~100000 tokens (~400000 chars, assuming ~4 chars/token — the same rough
// ratio used elsewhere in this codebase for pre-flight estimates). The goal
// is the same "compact proactively, well before you actually hit the wall"
// posture used by Claude Code's own /compact guidance — not "compact any
// request that happens to contain a duplicated block", which would
// destructively touch conversations that never needed it. Configurable via
// features.poolCompactMinTokens.
const DEFAULT_MIN_TRIGGER_TOKENS = 100000;
const CHARS_PER_TOKEN_ESTIMATE = 4;

function minTriggerChars() {
  const cfg = readConfigSafe();
  const configured = cfg.features && cfg.features.poolCompactMinTokens;
  const tokens = (typeof configured === 'number' && configured > 0) ? configured : DEFAULT_MIN_TRIGGER_TOKENS;
  return tokens * CHARS_PER_TOKEN_ESTIMATE;
}

// Total character count across every message's content (string or block
// array) — a cheap, honest proxy for "how big is this request as a whole",
// independent of any single block's size. Used ONLY to decide whether
// compaction should engage at all; the per-block rules below are unchanged.
function estimateTotalChars(messages) {
  let total = 0;
  for (const msg of messages) {
    if (!msg || !msg.content) continue;
    if (typeof msg.content === 'string') { total += msg.content.length; continue; }
    if (!Array.isArray(msg.content)) continue;
    for (const block of msg.content) {
      const text = extractTextFromBlock(block);
      total += text ? text.length : 0;
    }
  }
  return total;
}

// Helper: build a stable hash of a string (for deduplication)
function hashBlock(text) {
  const crypto = require('node:crypto');
  return crypto.createHash('md5').update(text).digest('hex');
}

// Helper: flatten an Anthropic content value (string | array of blocks) to text.
// tool_result.content is frequently an array of {type:'text',text} parts in real
// Claude Code traffic, not a bare string — measure/hash on the flattened text so
// compaction actually engages on that shape (and never call .length on an array).
function flattenToText(content) {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content
    .filter((b) => b && b.type === 'text')
    .map((b) => (typeof b.text === 'string' ? b.text : ''))
    .join('\n');
}

// Helper: extract text from a content block
function extractTextFromBlock(block) {
  if (typeof block === 'string') return block;
  if (block && typeof block === 'object') {
    if (block.type === 'text' && typeof block.text === 'string') return block.text;
    if (block.type === 'tool_result' && block.content != null) return flattenToText(block.content);
  }
  return null;
}

// Helper: return a NEW block with its text payload replaced by newText, preserving
// block structure (type, tool_use_id, is_error, cache_control, ...). For a
// tool_result whose content was an array, collapse to a single text part so the
// tool_use/tool_result pairing (tool_use_id) is never dropped.
function setBlockText(block, newText) {
  if (typeof block === 'string') return newText;
  if (block && block.type === 'text') return Object.assign({}, block, { text: newText });
  if (block && block.type === 'tool_result') {
    const content = typeof block.content === 'string' ? newText : [{ type: 'text', text: newText }];
    return Object.assign({}, block, { content });
  }
  return block;
}

// Helper: check if a block is text or tool_result
function isCompactableBlock(block) {
  if (typeof block === 'string') return true;
  if (block && typeof block === 'object' && (block.type === 'text' || block.type === 'tool_result')) {
    return true;
  }
  return false;
}

// Helper: get the size of a block's text content
function getBlockSize(block) {
  const text = extractTextFromBlock(block);
  return text ? text.length : 0;
}

// Helper: truncate a block to head + tail with marker.
// If ccrEnabled, caches the omitted middle segment and includes a ref in the marker
function truncateBlock(block, headChars, tailChars, ccrEnabled = false) {
  const text = extractTextFromBlock(block);
  if (!text || text.length <= headChars + tailChars) return block;

  const head = text.slice(0, headChars);
  const tail = text.slice(-tailChars);
  const omittedCount = text.length - headChars - tailChars;
  let marker;
  if (ccrEnabled) {
    // Cache only the omitted middle segment (not head/tail)
    const omittedMiddle = text.slice(headChars, text.length - tailChars);
    const ref = storeOriginal(omittedMiddle);
    marker = `[... ${omittedCount} chars truncated, ref: ${ref} -- use pool_retrieve to see it ...]`;
  } else {
    marker = `[... ${omittedCount} chars truncated ...]`;
  }

  const truncated = head + '\n' + marker + '\n' + tail;

  return setBlockText(block, truncated);
}

// Helper: replace a block with a short placeholder.
// If ccrEnabled, caches the full original block and includes a ref
function makePlaceholder(originalSize, ccrEnabled = false, originalText = null) {
  if (ccrEnabled && originalText) {
    const ref = storeOriginal(originalText);
    return `[duplicate of earlier output, ${originalSize} chars, ref: ${ref} -- use pool_retrieve to see it]`;
  }
  return `[duplicate of earlier output, ${originalSize} chars, omitted]`;
}

// Main compaction function
function applyPoolCompact(anthropicReq) {
  if (!isPoolCompactEnabled()) {
    return anthropicReq;
  }

  const messages = anthropicReq.messages || [];

  // Skip if fewer than 6 messages
  if (messages.length < 6) {
    return anthropicReq;
  }

  // Skip entirely if the request as a whole isn't big enough to need
  // compacting yet — this is the gate that keeps an ordinary, small
  // conversation from ever losing content just because it happens to
  // contain one duplicated or oversized block. Compaction only kicks in
  // once the total size actually approaches a real budget concern.
  if (estimateTotalChars(messages) < minTriggerChars()) {
    return anthropicReq;
  }

  // CCR (Compress-Cache-Retrieve) is ONLY safe for non-streaming requests.
  // Streaming requests already have bytes flushed to the client as they arrive,
  // so there's no way to intercept a tool-use turn and loop before the client
  // sees it. For streaming, keep the old plain-marker behavior (no refs, no tool).
  const ccrEnabled = anthropicReq.stream !== true;

  // Track seen large blocks (hash -> size) for deduplication
  const seenLargeBlocks = {}; // hash -> { size, firstIndex, firstBlockIndex, originalText }
  const messagesToModify = []; // array of indices that need changes

  // First pass: identify large blocks and deduplications
  messages.forEach((msg, msgIdx) => {
    if (!msg.content) return;

    const contentArray = Array.isArray(msg.content) ? msg.content : [msg.content];
    contentArray.forEach((block, blockIdx) => {
      const size = getBlockSize(block);
      if (size < 1000) return; // only track large blocks

      const originalText = extractTextFromBlock(block);
      const hash = hashBlock(originalText);
      if (!seenLargeBlocks[hash]) {
        seenLargeBlocks[hash] = { size, firstIndex: msgIdx, firstBlockIndex: blockIdx, originalText };
      }
    });
  });

  // Track whether any compaction actually happens
  let didCompact = false;

  // Second pass: build new messages array with deduplication and truncation
  const newMessages = messages.map((msg, msgIdx) => {
    let contentArray = Array.isArray(msg.content) ? [...msg.content] : [msg.content];
    let modified = false;

    // Apply deduplication and truncation
    contentArray = contentArray.map((block, blockIdx) => {
      if (!isCompactableBlock(block)) return block;

      const size = getBlockSize(block);

      // Rule a: deduplication for blocks >= 1000 chars
      if (size >= 1000) {
        const originalText = extractTextFromBlock(block);
        const hash = hashBlock(originalText);
        const seen = seenLargeBlocks[hash];
        if (seen && (msgIdx > seen.firstIndex || (msgIdx === seen.firstIndex && blockIdx > seen.firstBlockIndex))) {
          // This is a duplicate — replace payload with placeholder, but keep the
          // block structure so a tool_result never loses its tool_use_id (which
          // would break Anthropic tool_use/tool_result pairing at dispatch).
          modified = true;
          didCompact = true;
          const placeholder = makePlaceholder(size, ccrEnabled, originalText);
          return setBlockText(block, placeholder);
        }
      }

      // Rule b: truncation for blocks > 8000 chars, EXCEPT in the very last message
      if (size > 8000 && msgIdx < messages.length - 1) {
        modified = true;
        didCompact = true;
        return truncateBlock(block, 2000, 500, ccrEnabled);
      }

      return block;
    });

    if (modified) {
      return Object.assign({}, msg, {
        content: contentArray.length === 1 && typeof contentArray[0] === 'string' ? contentArray[0] : contentArray,
      });
    }
    return msg;
  });

  // Build the result
  let result = Object.assign({}, anthropicReq, { messages: newMessages });

  // If compaction happened and CCR is enabled, inject the pool_retrieve tool
  if (didCompact && ccrEnabled) {
    const retrieveTool = {
      name: 'pool_retrieve',
      description: 'Retrieve the full original text of a context block that was omitted or truncated for length. Call with the exact ref string shown in the omitted/truncated marker.',
      input_schema: {
        type: 'object',
        properties: {
          ref: { type: 'string' },
        },
        required: ['ref'],
      },
    };

    if (result.tools && Array.isArray(result.tools)) {
      // Check if pool_retrieve already exists to avoid duplicates
      if (!result.tools.some((t) => t.name === 'pool_retrieve')) {
        result = Object.assign({}, result, { tools: [...result.tools, retrieveTool] });
      }
    } else {
      // Create tools array if it doesn't exist
      result = Object.assign({}, result, { tools: [retrieveTool] });
    }
  }

  return result;
}

module.exports = { applyPoolCompact, retrieveOriginal };
