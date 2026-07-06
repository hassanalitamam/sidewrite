---
name: sidewrite-delegate
description: Delegate the current implementation/coding task to a headless Sidewrite / external-provider run — author a concise brief from the conversation and hand only that to the provider; no PLAN.md.
when_to_use: Fire when the user wants to hand an implementation/coding task to Sidewrite or an external provider — 'delegate this', 'delegate task', 'assign this task', 'assign to task', 'hand off', 'offload', 'sidewrite this', 'let sidewrite build this', 'sw delegate', 'sw this', 'ccx this'; also common misspellings 'deligate', 'delagate', 'delegat', 'sidewright', 'sidewrte', 'assigne'. Do NOT fire when the user means delegating to a Claude subagent/Task tool, a teammate, or a ticket system rather than Sidewrite/an external provider.
---

# Delegate an implementation task to Sidewrite

**Guard:** Only proceed if the user means delegating to Sidewrite / an external provider run. If they mean a Claude subagent/Task tool, a teammate, or a ticket system, do NOT run this — ask one short clarifying question instead.

When the user asks to delegate/implement a task with Sidewrite (or says "delegate", "sidewrite this",
"implement this with sidewrite", etc.), do NOT implement it yourself in this session. Instead, author a
brief and hand it to the headless provider run.

## Steps

1. **Author a concise, self-contained implement brief** from the CURRENT conversation and repo context —
   not a huge prompt. Include, tersely:
   - **Goal** — one line: what to build/change.
   - **Constraints** — languages/frameworks, style, what must not break.
   - **Acceptance criteria** — how "done" is judged.
   - **Likely primary files** — a *prior*, NOT a fence. Name the files you expect the change to centre
     on ("start with X, Y, Z"). Never write "only touch these files": instruct the provider to trace
     callers, dependents, tests, and configs from those seeds and edit whatever else the change genuinely
     needs. For an exploratory / ill-defined task, omit the list entirely.
   - **Do-not-touch** — only genuinely off-limits areas (if any).
   - **Completeness self-check** — tell the provider: before finalizing, grep for every changed symbol
     and run the tests, so no call site, import, or test is left dangling.
   - **Divergence flag** — tell the provider: if the real change diverged from the likely-files prior
     (files added or dropped), state which files and why in the closing summary.
   - End with: "Leave the changes applied in the working tree. Do not commit."
   Do not paste the whole transcript — only the distilled brief crosses to the provider.

2. **Write the brief to a temp file**, e.g. `.sidewrite-brief.md` in the repo or a `mktemp` path.

3. **Author a signal-capped CONTEXT DIGEST** (cap the *signal*, not the size) and write it to a separate
   temp file (e.g. a `mktemp` path). Do NOT paste whole files — no full CLAUDE.md, no long repo map, no
   file dumps; they cost tokens AND steps and bury the signal. Include only:
   - **Invariants / prohibitions** — the load-bearing "never do X" rules that are NOT derivable from the
     code (e.g. never proxy OAuth, keep `ccx`'s `env -i`, `ccx` aborts on `api.anthropic.com`, fail-closed
     mode reads, never write `ANTHROPIC_BASE_URL` / `ANTHROPIC_AUTH_TOKEN` into `~/.claude`, never
     `claude logout`). This block is **mandatory and non-trimmable** whenever the task touches auth,
     provider base-URL, credentials, `~/.claude` isolation, or any security/config surface — never drop it
     to save tokens.
   - **Rejected approaches** — dead ends already ruled out this session, so the provider won't retry them.
   - **Pointers, not payloads** — paths to the key files/dirs that matter, not their contents.
   Omit the digest (`--minimal-brief`) ONLY for a trivial, single-file, non-security task.

4. **Delegate** by running (Bash):
   ```sh
   sidewrite run --prompt-file <brief-path> --context-file <digest-path> [--title "<short-slug>"] [--fast]
   ```
   Pass `--context-file` with the digest from step 3. Add `--fast` when speed matters (nudges the implement
   model toward a faster routing tier). Sidewrite reads the active provider/model (from the dashboard),
   creates a git worktree + `sidewrite/<slug>` branch, runs the implement step headless via `ccx`, and
   streams to the dashboard.

5. **Relay the result verbatim.** The run prints one line:
   - `✅ TASK COMPLETE | provider=… | branch=… | diff=… | status=success` → tell the user, then (in
     subscription mode) review the git diff on the branch and summarise.
   - `❌ IMPLEMENT FAILED | … reason=… ` → relay the reason and the suggested next step (top up / switch
     provider, or — subscription mode only — implement it yourself).

## Parallel delegation (multiple workers)

The steps above run ONE headless worker — that is the default and the right choice for almost every task.
Only when a task **cleanly splits into file-disjoint slices** (independent modules, separate docs
pages/sections, separate test files that never touch each other's paths) may you fan it out to several
workers that run concurrently, each in its own worktree, each owning its own files.

**Rubric — how many workers:**
- **Default to 1.** A single worker is correct unless you can point to genuinely independent parts.
- Use **2–4 workers** ONLY when the slices are independent AND **file-disjoint** — no worker touches a path
  another worker touches (a directory prefix counts: `src/a/` and `src/a/b.js` overlap).
- **Never over-split a cohesive change.** If the parts share files, call each other, or must land together to
  compile/pass, use a single worker — coordinating overlapping workers costs more than it saves.
- If in doubt, use **1**. On any prefix overlap the runner errors out and exits, so slices MUST be disjoint.

**To delegate in parallel:**

1. **Author ONE shared PLAN.md and ONE shared CONTRACT.md — do NOT re-type shared context per brief.**
   - **PLAN.md** holds the whole change, split into per-worker sections (`## §api-docs`, `## §cli-tests`).
   - **CONTRACT.md** is the single source of truth for every shared interface the slices must agree on —
     function signatures, schema, config keys, endpoint shapes — plus the invariants/prohibitions block
     (step 3 above). Write each ONCE, to its own temp file. Workers reference these; they do not re-type them.

2. **Author one short brief per worker as a *pointer*, not a copy**, and write each to its own temp file
   (`mktemp`). Each brief names the worker's **owned slice** (its ORIG-relative paths — the disjointness
   boundary the runner enforces) and says: "implement §<your-section> of PLAN.md; CONTRACT.md is
   authoritative for every shared interface." Within its slice the worker still traces callers/dependents/
   tests and edits whatever the change needs — it just must not write outside its owned paths. End each
   brief with: "Leave the changes applied in the working tree. Do not commit."

3. **Author a workers manifest JSON** and write it to a temp file:
   ```json
   {
     "workers": [
       { "title": "api-docs",  "brief_file": "/tmp/w-api.md",  "files": ["docs/api/"],  "plan_sections": ["api-docs"] },
       { "title": "cli-tests", "brief_file": "/tmp/w-cli.md",  "files": ["test/cli/"], "plan_sections": ["cli-tests"] }
     ]
   }
   ```
   - `title` — short slug (names the worker's worktree branch).
   - `brief_file` — abs/repo-relative path to that worker's brief (or inline `"brief": "…"`).
   - `files` — ORIG-relative paths/dir-prefixes this worker **OWNS**. A trailing `/` marks a directory
     subtree. These must be **disjoint across workers** — no prefix may cover another worker's path.
   - `plan_sections` — the PLAN.md section anchors this worker implements (e.g. `["api-docs"]`).

4. **Delegate** by running (Bash):
   ```sh
   sidewrite run --workers-file <manifest-path> --plan-file <plan-path> --contract-file <contract-path> [--context-file <digest-path>] [--fast]
   ```
   The runner verifies the slices are disjoint (errors and exits 2 on overlap, naming the overlap — fix the
   manifest or drop to a single worker), spins up one worktree + `sidewrite/<slug>` branch per worker, runs
   the workers concurrently, and mirrors each worker's files back into your tree. It waits for all workers,
   prints a combined per-worker report (which succeeded + diff-stat), and cleans up all the worktrees.

5. **Relay the combined result** the same way as the single-worker path. Undo covers every worker.

Everything else — context digest, provider setup, no-provider handling — is identical to the single-worker
steps above.

## Notes

- Precedence is **brief > PLAN.md > gate**; you are supplying the brief, so no `PLAN.md` is needed.
- **No provider set up?** If the run prints a `SIDEWRITE: no provider is set up …` / `ACTION —` block
  (exit 2), no provider/model is configured yet. RELAY that guidance to the user verbatim in the chat —
  tell them to run `sidewrite` to open the dashboard, add a provider (OpenRouter or their own
  anthropic-compatible endpoint), pick/activate a model, then retry. Do NOT attempt to configure a
  provider or implement the task yourself.
- Only the brief text is sent to the provider — never the raw conversation transcript.
