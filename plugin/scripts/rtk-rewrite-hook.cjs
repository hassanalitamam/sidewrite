#!/usr/bin/env node
'use strict';

/*
 * sidewrite rtk-rewrite-hook
 *
 * PreToolUse hook that shells out to the `rtk` CLI to rewrite/compress Bash
 * tool-call commands before they run. This is an OPT-OUT, fail-safe hook:
 * - If rtk is not installed, silently passes through
 * - If features.rtkRewrite is false in ~/.sidewrite/config.json, opt-out
 * - If any error or timeout occurs, silently passes through
 * - Always exits 0, never blocks, never throws uncaught
 *
 * stdin:  JSON object shaped like {session_id,cwd,hook_event_name:"PreToolUse",tool_name:"Bash",tool_input:{command:"...",description:"..."}}
 * stdout: JSON response (or nothing if passthrough)
 * exit:   always 0
 *
 * CommonJS, node: builtins only, no external deps.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFile } = require('child_process');

const HOME = process.env.HOME || os.homedir();
const CONFIG_JSON = path.join(HOME, '.sidewrite', 'config.json');

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

/**
 * Read and parse ~/.sidewrite/config.json
 * Returns the config object or null if missing/invalid
 */
function readConfig() {
  try {
    const raw = fs.readFileSync(CONFIG_JSON, 'utf8');
    return JSON.parse(raw);
  } catch (_) {
    return null;
  }
}

/**
 * Read all available stdin synchronously into a string
 */
function readStdinSync() {
  try {
    return fs.readFileSync(0, 'utf8');
  } catch (_) {
    return '';
  }
}

/**
 * Exit safely: output if provided, then process.exit(0)
 */
function safeExit(output) {
  if (output) {
    process.stdout.write(output);
  }
  process.exit(0);
}

// ---------------------------------------------------------------------------
// main hook logic
// ---------------------------------------------------------------------------

function runHook() {
  try {
    // Read stdin
    const stdinRaw = readStdinSync().trim();
    if (!stdinRaw) {
      safeExit();
    }

    // Parse input JSON
    let input;
    try {
      input = JSON.parse(stdinRaw);
    } catch (_) {
      // Invalid JSON; silently passthrough
      safeExit();
    }

    // Only process Bash tool calls
    if (input.tool_name !== 'Bash') {
      safeExit();
    }

    // Extract command from tool_input
    if (!input.tool_input || typeof input.tool_input.command !== 'string') {
      safeExit();
    }

    const originalCommand = input.tool_input.command;

    // Check config for opt-out flag (default: enabled, opt-out mode)
    const config = readConfig();
    if (config && config.features && config.features.rtkRewrite === false) {
      // User has explicitly disabled rtk rewriting; silent passthrough
      safeExit();
    }

    // Spawn rtk rewrite <command>
    // Pass the command as a single argv element, never via shell string
    execFile('rtk', ['rewrite', originalCommand], { timeout: 2000 }, (err, stdout, stderr) => {
      try {
        // Distinguish a spawn/timeout failure from a normal non-zero exit.
        // On a normal non-zero exit, execFile still reports `err` but err.code
        // is the NUMERIC exit code. On spawn failure (rtk absent) err.code is a
        // string like 'ENOENT'; on timeout the process is killed (err.killed).
        if (err && (err.killed || typeof err.code !== 'number')) {
          // Binary not found (ENOENT), timeout/kill, or any non-exit failure:
          // silent passthrough, never block.
          safeExit();
        }

        // For exit code 0, err is null. For non-zero exits, err.code holds the
        // numeric exit code.
        const exitCode = err ? err.code : 0;

        const rewrittenCommand = stdout ? stdout.trim() : '';

        if (exitCode === 0) {
          // Rewrite found and allowed
          if (rewrittenCommand && rewrittenCommand !== originalCommand) {
            // Command was rewritten; report it
            const response = {
              hookSpecificOutput: {
                hookEventName: 'PreToolUse',
                permissionDecision: 'allow',
                permissionDecisionReason: 'rtk: compacted command output',
                updatedInput: {
                  command: rewrittenCommand,
                },
              },
            };
            safeExit(JSON.stringify(response));
          } else {
            // No change; silent passthrough
            safeExit();
          }
        } else if (exitCode === 1) {
          // No equivalent rewrite found; silent passthrough
          safeExit();
        } else if (exitCode === 2) {
          // Deny rule matched
          const response = {
            hookSpecificOutput: {
              hookEventName: 'PreToolUse',
              permissionDecision: 'deny',
              permissionDecisionReason: 'blocked by rtk policy',
            },
          };
          safeExit(JSON.stringify(response));
        } else if (exitCode === 3) {
          // Ask rule matched; same as rewrite case but decision is "ask"
          if (rewrittenCommand && rewrittenCommand !== originalCommand) {
            const response = {
              hookSpecificOutput: {
                hookEventName: 'PreToolUse',
                permissionDecision: 'ask',
                permissionDecisionReason: 'rtk: compacted command output',
                updatedInput: {
                  command: rewrittenCommand,
                },
              },
            };
            safeExit(JSON.stringify(response));
          } else {
            safeExit();
          }
        } else {
          // Other exit codes treated like exit 1: silent passthrough
          safeExit();
        }
      } catch (_) {
        // Inner catch-all; never block
        safeExit();
      }
    });
  } catch (_) {
    // Outermost catch-all; never block, never throw
    safeExit();
  }
}

// ---------------------------------------------------------------------------
// entry
// ---------------------------------------------------------------------------

runHook();
