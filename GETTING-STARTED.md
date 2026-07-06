# Sidewrite — Getting Started & Test Guide (v1.2.0)

A hands-on, zero-knowledge walkthrough: install → set up → run a real task → verify everything works →
explore every feature. Follow it top to bottom the first time.

> **New in 1.2.0** (this is what changed): live **file-by-file edits** into your real working tree (like
> Codex), **one-command undo**, **parallel workers** for big tasks, a **`--fast`** speed mode, a
> **`sidewrite doctor` / `setup`** environment check, much faster startup, and far more forgiving delegation
> triggering (typos + short aliases). Details in each section below.

---

## 0. What Sidewrite is (in one minute)

Sidewrite lets you run coding work on **any Anthropic-compatible model** (OpenRouter, DeepSeek, GLM, local
Ollama via a gateway…) instead of only your Claude subscription — and watch it live in a local dashboard.

- **Subscription mode** — you keep planning/reviewing on Claude; you **delegate** the implementation to a
  cheaper external model. The model edits your files **live**; Claude reviews the diff.
- **Standalone mode** — no Claude subscription: `sidewrite code` launches Claude Code itself powered by your
  own model.

Your Claude login is **never** touched, proxied, or run headless — external providers use their own keys in an
isolated environment.

---

## 1. One-time install

```sh
npx sidewrite install
```

That registers the CLI (`sidewrite`, `ccx`) and the Claude Code plugin (slash commands + dashboard) globally.

> **If you're upgrading and already had it installed:** the CLI updates itself; to refresh the plugin inside
> Claude Code run `claude plugin update sidewrite@sidewrite-marketplace` and then **restart Claude Code** so
> the new slash commands load.

### Verify your machine is ready

```sh
sidewrite doctor
```

You should see a list of green check-marks (Node, git, `claude`, PATH, `~/.sidewrite` writable, provider files
locked to `0600`, daemon reachable). Anything red prints the exact command to fix it. To provision missing
pieces:

```sh
sidewrite setup       # verifies + creates ~/.sidewrite, scaffolds config, fixes 0600 perms
```

`doctor`/`setup` **never** touch your PATH, shell profile, or `~/.claude` unless you pass `--write-profile`.

---

## 2. First run — open the dashboard and pick a mode

```sh
sidewrite            # bare command opens the live dashboard in your browser
```

The dashboard opens at **http://127.0.0.1:1510** (local-only). On first run it asks:

1. **"Do you have a Claude subscription?"** → choose **Subscription** or **Standalone**. (Change later with
   `sidewrite mode <subscription|standalone>`.)
2. **Add a provider.** Two tabs:
   - **OpenRouter** — search the bundled catalog of **256 Anthropic-compatible models** (works offline —
     browsing needs no key), pick one or more, paste your OpenRouter key. Prices auto-fill.
   - **Custom / local** — any Anthropic-compatible base URL (Ollama/OpenAI-style needs a small gateway; the
     form links the recipe).
3. The **first model auto-activates** — you never end up with "no model selected".

That's it — you're ready.

---

## 3. Example task A — delegate in Subscription mode

This is the headline flow. In a Claude Code session, inside any git project:

**Step 1 — just ask, in plain language:**

```
delegate this task with sidewrite: add input validation to src/user.js and a matching test
```

Triggering is forgiving — all of these work too: `/sidewrite-delegate`, the short aliases **`/sw`** or
**`/delegate`**, or natural phrases like *"assign this to sidewrite"*, *"offload this"*, even typos like
*"deligate this"*.

**Step 2 — what happens automatically:**
- Interactive Claude writes a concise brief from the conversation (no `PLAN.md` needed) and hands **only that
  brief** to your provider.
- The provider implements **headless in an isolated worktree**, and each file it writes appears **live in your
  real project files, one at a time** — watch them show up in your editor / `git status` as it works.
- When done you see one line: `✅ TASK COMPLETE | provider=… | diff=… | status=success`.

**Step 3 — verify it worked:**

```sh
git status            # the changed/created files are here, unstaged, ready to review
git diff              # inspect exactly what the model did
```

The dashboard shows the same edits landing live (a `file_landed` event per file), plus tokens + USD cost.

**Step 4 — don't like it? Undo in one command:**

```sh
sidewrite undo        # reverts the last run's files to their pre-run state
```

Undo is safe: it only reverts files that still match what the run produced — if **you** edited a file
afterwards, it refuses to clobber your work (use `--force` to override). It reverts against the run's original
project directory, so it's correct even from another folder.

---

## 4. Example task B — Standalone mode (no subscription)

```sh
sidewrite code        # launches interactive Claude Code powered by YOUR model
```

Use Claude Code exactly as normal — every request is answered by your external model, billed to your key. If
you have one model it backs all of opus/sonnet/haiku; with several, map them in the dashboard. If no model is
set yet, `sidewrite code` shows a short guide and opens the dashboard so you can add one.

---

## 5. Speed & scale (advanced)

### Fast mode
Add `--fast` (or set `speed: true` in `~/.sidewrite/config.json`) to route the run to the **fastest** provider
path (OpenRouter `:nitro` throughput routing) and skip slow free (`:free`) models:

```sh
sidewrite run --fast --prompt-file brief.md
```

### Parallel workers (finish big tasks faster)
When a task **cleanly splits into independent files** (e.g. a 10-page doc, several independent modules), Claude
can decompose it and run several workers **at once**, each owning a disjoint slice — landing live, with no
conflicts. Claude authors a small manifest and runs:

```sh
sidewrite run --workers-file workers.json
```

```json
{ "workers": [
  { "title": "docs-intro", "brief_file": "/tmp/w0.md", "files": ["docs/intro.md"] },
  { "title": "docs-api",   "brief_file": "/tmp/w1.md", "files": ["docs/api.md"] }
] }
```

Sidewrite **validates the slices are disjoint** (overlap → clear error), runs the workers concurrently, and
each worker mirrors **only its own files**. Default is a single worker — it only parallelizes when the split is
genuinely independent (that's usually faster and cheaper than over-splitting).

---

## 6. Command reference

| Command | What it does |
|---|---|
| `sidewrite` | Open the live dashboard (control center). |
| `sidewrite doctor` \| `setup` | Verify / provision your environment. |
| `sidewrite mode <subscription\|standalone>` | Switch mode. |
| `sidewrite code` | Standalone: launch Claude Code on your model. |
| `sidewrite run [--fast] [--prompt-file F] [--workers-file M]` | Run a delegated implement task. |
| `sidewrite undo [runId] [--force]` | Revert a run's edits. |
| `/sidewrite-delegate` · `/sw` · `/delegate` | Delegate the current task (slash commands). |
| `/sidewrite-open` · `/sidewrite-status` | Open dashboard / show status. |
| `ccx <provider> …` | Low-level isolated runner (advanced). |

---

## 7. Prove-it checklist (verify the whole thing end-to-end)

1. `sidewrite doctor` → all green.
2. `sidewrite` opens the dashboard fast; mode + an active model are shown.
3. In a **git** project, delegate a small task → files appear live in your tree; `git diff` shows them.
4. `sidewrite undo` cleanly reverts them; `git status` is clean again.
5. (Standalone) `sidewrite code` → `/status` inside it shows your external base URL, not Anthropic.
6. Safety: after any external run, your Claude login still works with no re-login; nothing was written to
   `~/.claude`.

---

## 8. Troubleshooting

- **New slash commands (`/sw`, `/delegate`) don't appear** → restart Claude Code (plugin changes load on
  restart); the CLI/daemon are already live.
- **"no provider is set up"** → run `sidewrite`, add a provider + activate a model, retry.
- **A run stalls on a weak free model** → it's auto-killed within ~2 min (idle watchdog) and fails over; pick a
  stronger/faster model, or use `--fast`.
- **Dashboard won't start / daemon unhealthy** → check `~/.sidewrite/RUN_LOG`; ensure **free disk space**
  (the daemon needs room for its local SQLite DB).
- **Everything read-only & local**: the dashboard binds to `127.0.0.1` only, behind a bearer token; provider
  keys live in `0600` files and are never returned by any API.

---

## 9. What changed in 1.2.0 (summary of this release)

- **Live edits**: each file the delegate writes lands in your real tree instantly (was: one diff at the end).
- **Undo**: `sidewrite undo` reverts a run safely (per-file backups + hash guard).
- **Parallel workers**: `--workers-file` runs disjoint slices concurrently with conflict-free live merge.
- **Fast mode**: `--fast` → `:nitro` routing, skips slow `:free` models; context digest + trimmed tools for
  fewer, faster turns.
- **Doctor/Setup**: `sidewrite doctor` / `setup` verify + provision your machine, best-practice and safe.
- **Faster everywhere**: fewer process spawns per run, near-instant dashboard first-open, cached Node startup.
- **Forgiving triggering**: delegation fires on many phrasings, short aliases, and common typos.
- All original safety invariants preserved (no OAuth proxy, no headless subscription, isolated
  `CLAUDE_CONFIG_DIR`, `0600` keys, aborts on `api.anthropic.com`).
