#!/usr/bin/env node
'use strict';

/*
 * terse-mode — opt-out terse response instruction for Free-Tier Pool.
 *
 * Sourced from JuliusBrussee/caveman (MIT) — skills/caveman/SKILL.md,
 * trimmed to the core ruleset. When enabled (default), prepends a
 * terse-response instruction to the system prompt to reduce output tokens.
 *
 * Controlled by ~/.sidewrite/config.json features.terseMode:
 *   - absent or true: terse mode ON (instruction added)
 *   - false: terse mode OFF (instruction NOT added)
 *
 * node: builtins only — no npm dependencies.
 */

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const TERSE_INSTRUCTIONS = `Compress your response style per the following:
- Remove articles (a/an/the), filler words (just/really/basically), and pleasantries
- Use fragments and short synonyms where possible
- Drop decorative elements (emoji, gratuitous tables, tool narration)
- Quote only essential error lines, never raw logs

What must never change:
- Technical terms, code blocks, API names, CLI commands, error strings stay verbatim
- Standard acronyms (DB, API) remain; never invent abbreviations

State facts concisely: [thing] [action] [reason]. [next step].
Avoid elaboration chains.

Safety override: revert to normal speech for security warnings, destructive action confirmations, or multi-step sequences where compression could cause misunderstanding.`;

/**
 * Read feature flags from ~/.sidewrite/config.json.
 *
 * @param {string} name - Feature flag name
 * @param {*} defaultValue - Default if not found or on any read error
 * @returns {*} Feature flag value, or defaultValue if error/absent
 */
function readFeatureFlag(name, defaultValue) {
  try {
    const configPath = path.join(os.homedir(), '.sidewrite', 'config.json');
    const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
    const flagValue = config.features?.[name];
    // Opt-out: if explicitly false, return false; otherwise return the flag or default
    return flagValue === false ? false : (flagValue ?? defaultValue);
  } catch (err) {
    // Any error (file not found, parse error, etc.) → use default
    return defaultValue;
  }
}

/**
 * Apply terse-mode instruction to an Anthropic Messages API request.
 *
 * If terse mode is disabled (features.terseMode === false), returns the request
 * unchanged. Otherwise, prepends TERSE_INSTRUCTIONS to the system field:
 *   - if system is absent: set to TERSE_INSTRUCTIONS
 *   - if system is a string: concatenate with "\n\n" + TERSE_INSTRUCTIONS
 *   - if system is an array: append {type:"text", text:TERSE_INSTRUCTIONS}
 *
 * Returns a new object (does not mutate the input).
 *
 * @param {object} anthropicReq - Anthropic Messages API request
 * @returns {object} Request with terse mode applied (or original if disabled)
 */
function applyTerseMode(anthropicReq) {
  // Check feature flag: default true (opt-out means explicit false disables it)
  if (readFeatureFlag('terseMode', true) === false) {
    return anthropicReq;
  }

  // Determine the new system value
  let newSystem;

  if (!anthropicReq.system) {
    // No existing system → just the terse instructions
    newSystem = TERSE_INSTRUCTIONS;
  } else if (typeof anthropicReq.system === 'string') {
    // String system → concatenate with the instructions
    newSystem = anthropicReq.system + '\n\n' + TERSE_INSTRUCTIONS;
  } else if (Array.isArray(anthropicReq.system)) {
    // Array system (content blocks) → append a new text block
    newSystem = [
      ...anthropicReq.system,
      { type: 'text', text: TERSE_INSTRUCTIONS },
    ];
  } else {
    // Unexpected type → leave unchanged
    return anthropicReq;
  }

  // Return a new object with the updated system field
  return Object.assign({}, anthropicReq, { system: newSystem });
}

module.exports = {
  applyTerseMode,
  TERSE_INSTRUCTIONS,
};
