---
description: Delegate the current task to a headless sidewrite provider run — you author a concise brief from this conversation (no PLAN.md needed).
allowed-tools: Bash(sidewrite:*), Write
---

Delegate the work under discussion to a headless sidewrite run. This is the subscription-style delegation path: you (interactive Claude) turn the CURRENT conversation into a self-contained implement brief and hand only that brief to the external provider — the raw transcript never crosses over.

Do this now:

1. Derive a concise, self-contained brief from the conversation so far. Do NOT ask the user for a PLAN.md and do NOT ask them to restate the task. The brief must stand on its own for a fresh agent that cannot see this chat. Include:
   - Goal — one or two sentences on what to build/change and why.
   - Constraints — invariants, style, libraries/patterns to follow.
   - Acceptance criteria — how "done" is verified.
   - Likely primary files — a prior, NOT a fence: name the files the change is expected to centre on; never say "only touch these". Tell the provider to trace callers/dependents/tests/configs from those seeds and edit whatever else the change needs. Omit the list for an exploratory/ill-defined task.
   - Do-not-touch — only genuinely off-limits areas.
   - Completeness self-check + divergence flag — before finalizing, grep every changed symbol and run tests so nothing is left dangling; if the real edit diverged from the likely-files prior, state which files and why.
   - End with: "Leave the changes applied in the working tree. Do not commit."

2. Write the brief to a temp file with the Write tool, e.g. a path under the system temp dir like `/tmp/sidewrite-brief-<something>.md`.

3. Run the headless implement:

   `sidewrite run --prompt-file <that temp file>`

   Also author a signal-capped context digest and pass it with `--context-file <that digest>` — cap the signal, not the size: do NOT paste whole files or CLAUDE.md; include only (1) invariants/prohibitions not derivable from code (never proxy OAuth, keep `ccx`'s `env -i`, `ccx` aborts on `api.anthropic.com`, fail-closed mode reads, never write `ANTHROPIC_BASE_URL`/`ANTHROPIC_AUTH_TOKEN` into `~/.claude`, never `claude logout`) — mandatory and non-trimmable for any auth/config/security task; (2) rejected approaches; (3) pointers (paths), not payloads. You may add `--fast` when speed matters. (Optionally add `--title <short-slug>` to name the worktree branch.)

4. Present the runner's final result line — the `✅ TASK COMPLETE …` or `❌ IMPLEMENT FAILED …` line and the `Viewer:` URL — to the user VERBATIM. If the run failed and hands the work back, follow the runner's NEXT guidance.

Parallel workers (advanced, opt-in): DEFAULT to a single worker — that is the right choice for almost every task. ONLY when the work cleanly splits into file-disjoint slices (independent modules, separate docs pages/sections, separate test files that never share a path) may you fan it out. Author ONE shared PLAN.md (split into per-worker sections) and ONE shared CONTRACT.md (every shared interface — signatures, schema, config keys, endpoint shapes — plus the invariants block); do NOT re-type shared context per brief. Then write one SHORT pointer brief per worker: it names the worker's owned slice (the ORIG-relative paths it may write — the enforced disjointness boundary) and says "implement §<section> of PLAN.md; CONTRACT.md is authoritative"; within its slice the worker still traces callers/tests. Author a manifest JSON `{ "workers": [ { "title": "<slug>", "brief_file": "<tmp path>", "files": ["<orig-relative paths/dirs this worker OWNS>"], "plan_sections": ["<section>"] }, ... ] }` (a trailing `/` in a path means a directory subtree; the `files` sets MUST be disjoint across workers) and run `sidewrite run --workers-file <manifest> --plan-file <plan> --contract-file <contract>` (you may still add `--context-file` / `--fast`). Use 2–4 workers ONLY when the slices are genuinely independent and file-disjoint; never over-split a cohesive change. If slices would overlap, use a single worker — the runner rejects overlapping slices (exit 2) and names the overlap. The runner runs the workers concurrently, prints a combined per-worker report, and cleans up; relay it the same way. Everything else (context digest, provider setup, no-provider handling) is identical to the single-worker path.

If instead the run prints a `SIDEWRITE: no provider is set up …` / `ACTION —` block, no provider/model has been configured yet. RELAY that guidance to the user in the chat — tell them to run `sidewrite` to open the dashboard, add a provider (OpenRouter or their own anthropic-compatible endpoint), pick/activate a model, then retry. Do NOT try to set up a provider or implement the task yourself.
