#!/usr/bin/env node
'use strict';

/*
 * pool-compact — Message history compaction for the Free-Tier Pool.
 *
 * Implements opt-out compaction of long message histories:
 *   - Deduplicates large identical text/tool_result blocks (>1000 chars)
 *   - Truncates very long blocks (>8000 chars) to head + tail (except last message)
 *   - Never drops or reorders messages, never touches .system
 *   - Node core only, no external dependencies
 */

const fs = require('node:fs');
const path = require('node:path');

// Read ~/.sidewrite/config.json; if cfg.features.poolCompact === false, return input unchanged.
// Missing file/key means enabled (default true).
function isPoolCompactEnabled() {
  try {
    const configPath = path.join(process.env.HOME || process.env.USERPROFILE || '', '.sidewrite', 'config.json');
    if (!fs.existsSync(configPath)) return true; // enabled by default
    const cfg = JSON.parse(fs.readFileSync(configPath, 'utf-8'));
    if (cfg.features && cfg.features.poolCompact === false) return false;
    return true; // enabled by default
  } catch (err) {
    return true; // enabled by default on read error
  }
}

// Helper: build a stable hash of a string (for deduplication)
function hashBlock(text) {
  const crypto = require('node:crypto');
  return crypto.createHash('md5').update(text).digest('hex');
}

// Helper: extract text from a content block
function extractTextFromBlock(block) {
  if (typeof block === 'string') return block;
  if (block && typeof block === 'object') {
    if (block.type === 'text' && block.text) return block.text;
    if (block.type === 'tool_result' && block.content) return block.content;
  }
  return null;
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

// Helper: truncate a block to head + tail with marker
function truncateBlock(block, headChars, tailChars) {
  const text = extractTextFromBlock(block);
  if (!text || text.length <= headChars + tailChars) return block;

  const head = text.slice(0, headChars);
  const tail = text.slice(-tailChars);
  const omittedCount = text.length - headChars - tailChars;
  const marker = `[... ${omittedCount} chars truncated ...]`;
  const truncated = head + '\n' + marker + '\n' + tail;

  if (typeof block === 'string') {
    return truncated;
  } else if (block && block.type === 'text') {
    return Object.assign({}, block, { text: truncated });
  } else if (block && block.type === 'tool_result') {
    return Object.assign({}, block, { content: truncated });
  }
  return block;
}

// Helper: replace a block with a short placeholder
function makePlaceholder(originalSize) {
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

  // Track seen large blocks (hash -> size) for deduplication
  const seenLargeBlocks = {}; // hash -> { size, firstIndex, firstBlockIndex }
  const messagesToModify = []; // array of indices that need changes

  // First pass: identify large blocks and deduplications
  messages.forEach((msg, msgIdx) => {
    if (!msg.content) return;

    const contentArray = Array.isArray(msg.content) ? msg.content : [msg.content];
    contentArray.forEach((block, blockIdx) => {
      const size = getBlockSize(block);
      if (size < 1000) return; // only track large blocks

      const hash = hashBlock(extractTextFromBlock(block));
      if (!seenLargeBlocks[hash]) {
        seenLargeBlocks[hash] = { size, firstIndex: msgIdx, firstBlockIndex: blockIdx };
      }
    });
  });

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
        const hash = hashBlock(extractTextFromBlock(block));
        const seen = seenLargeBlocks[hash];
        if (seen && (msgIdx > seen.firstIndex || (msgIdx === seen.firstIndex && blockIdx > seen.firstBlockIndex))) {
          // This is a duplicate — replace with placeholder
          modified = true;
          return makePlaceholder(size);
        }
      }

      // Rule b: truncation for blocks > 8000 chars, EXCEPT in the very last message
      if (size > 8000 && msgIdx < messages.length - 1) {
        modified = true;
        return truncateBlock(block, 2000, 500);
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

  // Return new object with shallow copy + new messages array
  return Object.assign({}, anthropicReq, { messages: newMessages });
}

module.exports = { applyPoolCompact };
