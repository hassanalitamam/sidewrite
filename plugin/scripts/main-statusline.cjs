#!/usr/bin/env node
'use strict';

/*
 * main-statusline.cjs — statusline for the MAIN interactive subscription
 * (~/.claude/settings.json, NOT a per-provider ~/.claude-<provider> station).
 *
 * Replaces the previously configured `ccstatusline` command, which was not
 * actually resolvable on PATH (confirmed via `sh -c ccstatusline` ->
 * "command not found") and therefore rendered nothing. Deliberately omits
 * token/context-window consumption (the one thing the user asked to drop)
 * and instead surfaces Sidewrite's live delegate-agent count, read from
 * ~/.sidewrite/status.json — the same file `sidewrite status` reads, so no
 * HTTP round-trip and no daemon dependency for this to render fast.
 *
 * node: builtins only, matching the rest of the project.
 */

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const HOME = os.homedir();
const STATUS_PATH = path.join(HOME, '.sidewrite', 'status.json');

function readStdin() {
  try {
    return fs.readFileSync(0, 'utf8');
  } catch (_) {
    return '';
  }
}

function readJsonSafe(p) {
  try {
    return JSON.parse(fs.readFileSync(p, 'utf8'));
  } catch (_) {
    return null;
  }
}

function git(args, cwd) {
  const r = spawnSync('git', args, { cwd, encoding: 'utf8', timeout: 2000 });
  if (r.status !== 0 || !r.stdout) return null;
  return r.stdout.trim();
}

function gitSegment(cwd) {
  const branch = git(['branch', '--show-current'], cwd);
  if (!branch) return null;
  const dirty = git(['status', '--porcelain'], cwd);
  const changes = dirty ? dirty.split('\n').filter(Boolean).length : 0;
  return changes > 0 ? `${branch} (+${changes})` : branch;
}

// The dashboard mirrors a fresh heartbeat into status.json roughly every
// STATUS_REFRESH_MS (10s, see viewer-daemon.cjs); anything older than its own
// ttl_seconds means the daemon isn't running/updating, so treat as "unknown"
// rather than showing a stale agent count.
function runningAgents() {
  const snap = readJsonSafe(STATUS_PATH);
  if (!snap || typeof snap.runningAgents !== 'number') return 0;
  const ttlMs = (snap.ttl_seconds || 30) * 1000;
  if (!snap.heartbeat_ts || Date.now() - snap.heartbeat_ts > ttlMs) return 0;
  return snap.runningAgents;
}

function main() {
  let input = {};
  try {
    input = JSON.parse(readStdin() || '{}');
  } catch (_) {
    input = {};
  }

  const cwd = (input.workspace && (input.workspace.current_dir || input.workspace.project_dir)) || process.cwd();
  const modelName = (input.model && input.model.display_name) || 'Claude';

  const segments = [modelName];

  const gitSeg = gitSegment(cwd);
  if (gitSeg) segments.push(gitSeg);

  const agents = runningAgents();
  if (agents > 0) {
    segments.push(`🤖 ${agents} delegate agent${agents === 1 ? '' : 's'} running`);
  }

  process.stdout.write(segments.join('  │  '));
}

main();
