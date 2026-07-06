#!/usr/bin/env node
'use strict';

/*
 * agent-store — CRUD for user-defined custom sub-agents.
 *
 * One plain JSON file per agent under ~/.sidewrite/agents/<id>.json (dir 0700,
 * file 0600 — same trust boundary as the rest of this project: loopback-only
 * daemon, no multi-tenant auth, OS file permissions are the real boundary).
 * No secrets ever live in an agent record, so no encryption layer is needed
 * here (unlike pool-store.cjs / context7-store.cjs).
 *
 * A record materializes as a real Claude Code subagent definition
 * (agents/<name>.md — markdown + YAML frontmatter, the native convention
 * auto-discovered from $CLAUDE_CONFIG_DIR/agents/) fanned into every station,
 * so a sub-agent the user defines once is usable no matter which
 * provider/model a run ends up on.
 *
 * node: builtins only — no npm dependencies.
 */

const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');

const HOME = os.homedir();
const DATA_DIR = path.join(HOME, '.sidewrite');
const AGENTS_DIR = path.join(DATA_DIR, 'agents');

function ensureAgentsDir() {
  fs.mkdirSync(AGENTS_DIR, { recursive: true, mode: 0o700 });
  try { fs.chmodSync(AGENTS_DIR, 0o700); } catch (_) {}
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

function recordPath(id) {
  return path.join(AGENTS_DIR, id + '.json');
}

// Claude Code subagent names are lowercase-hyphenated (same rule the shipped
// agents/*.md files in this repo follow); this doubles as the filesystem-safe
// check before it's ever used in a path.
function nameSafe(name) {
  return typeof name === 'string' && /^[a-z][a-z0-9-]{0,63}$/.test(name);
}

function genId(name) {
  const base = String(name || 'agent').toLowerCase().replace(/[^a-z0-9._-]/g, '-').slice(0, 40);
  return base + '-' + crypto.randomBytes(4).toString('hex');
}

function listAgents() {
  ensureAgentsDir();
  let files = [];
  try { files = fs.readdirSync(AGENTS_DIR); } catch (_) { return []; }
  const out = [];
  for (const f of files) {
    if (!f.endsWith('.json')) continue;
    try {
      const rec = JSON.parse(fs.readFileSync(path.join(AGENTS_DIR, f), 'utf8'));
      if (rec && rec.id) out.push(rec);
    } catch (_) { /* skip unreadable/corrupt record */ }
  }
  out.sort((a, b) => String(a.name).localeCompare(String(b.name)));
  return out;
}

function readAgent(id) {
  if (!idSafe(id)) return null;
  try {
    return JSON.parse(fs.readFileSync(recordPath(id), 'utf8'));
  } catch (_) {
    return null;
  }
}

// fields: { name, description, instructions, model }. model is one of
// 'inherit'|'sonnet'|'opus'|'haiku' — 'inherit' omits the frontmatter field
// entirely (Claude Code then uses whatever model is driving the session).
function createAgent(fields) {
  ensureAgentsDir();
  const name = String(fields.name || '').trim().toLowerCase();
  if (!nameSafe(name)) throw new Error('invalid agent name (lowercase-hyphenated, e.g. "debug-helper")');
  if (listAgents().some((a) => a.name === name)) throw new Error('an agent named "' + name + '" already exists');
  const id = genId(name);
  const rec = {
    id,
    name,
    description: String(fields.description || '').slice(0, 2000),
    instructions: String(fields.instructions || ''),
    model: ['sonnet', 'opus', 'haiku'].includes(fields.model) ? fields.model : 'inherit',
    createdAt: fields.createdAt || null, // stamped by the caller (HTTP layer), never Date.now() in here
  };
  writeFileMode(recordPath(id), JSON.stringify(rec, null, 2), 0o600);
  return rec;
}

function updateAgent(id, patch) {
  const cur = readAgent(id);
  if (!cur) return null;
  const next = Object.assign({}, cur);
  if (patch.description !== undefined) next.description = String(patch.description).slice(0, 2000);
  if (patch.instructions !== undefined) next.instructions = String(patch.instructions);
  if (patch.model !== undefined) next.model = ['sonnet', 'opus', 'haiku'].includes(patch.model) ? patch.model : 'inherit';
  // name is immutable after creation: it's the fan-out filename (agents/<name>.md)
  // across every station, and renaming would orphan the old file everywhere.
  writeFileMode(recordPath(id), JSON.stringify(next, null, 2), 0o600);
  return next;
}

function deleteAgent(id) {
  try { fs.unlinkSync(recordPath(id)); } catch (_) {}
}

// Render a record into the agents/<name>.md contents Claude Code auto-discovers.
function renderAgentMarkdown(rec) {
  const lines = ['---', 'name: ' + rec.name, 'description: ' + JSON.stringify(rec.description || '')];
  if (rec.model && rec.model !== 'inherit') lines.push('model: ' + rec.model);
  lines.push('---', '', rec.instructions || '');
  return lines.join('\n') + '\n';
}

module.exports = {
  AGENTS_DIR,
  nameSafe,
  listAgents,
  readAgent,
  createAgent,
  updateAgent,
  deleteAgent,
  renderAgentMarkdown,
};
