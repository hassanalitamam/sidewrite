# Sidewrite

**Hand the typing to a cheap model. Keep the thinking on Claude. Watch the whole thing in a dashboard.**

Your Claude subscription is a genius, not a stenographer. Every session you spend watching it retype a file it already read, re-explore a codebase it already explored, or grind through boilerplate is quota you'll wish you had back when a *real* problem shows up. Sidewrite splits the job: Claude plans and reviews (the part that needs judgment), a cheap — or free — external model does the actual writing (the part that doesn't), and a local dashboard shows you exactly what ran and what it cost.

No external deps. Just Node. Free to use.

---

## Why this exists

Claude Code is genuinely great at agentic coding — and genuinely easy to run dry doing it:

- Anthropic doubled Claude Code's 5-hour usage caps in May 2026 and bumped weekly limits another 50% two months later, largely because users were blowing through them mid-session. If the vendor has to keep raising the ceiling, the ceiling was the problem. ([TrueFoundry](https://www.truefoundry.com/blog/claude-code-limits-explained), [Pasquale Pillitteri](https://pasqualepillitteri.it/en/news/2494/claude-code-weekly-limits-50-percent-anti-codex-anthropic-2026))
- One widely-shared dev account: *"I was burning through Claude Code's weekly limit in 3 days."* That's not a power-user edge case anymore, that's Tuesday. ([Medium](https://medium.com/@kunalbhardwaj598/i-was-burning-through-claude-codes-weekly-limit-in-3-days-here-s-how-i-fixed-it-0344c555abda))
- Benchmarks on real sessions found up to **47% of tokens spent just exploring code** — re-reading files, re-sending history — before a single line of the actual fix gets written. You're paying full price for your agent to find its keys. ([KD Agentic](https://medium.com/kd-agentic/your-claude-code-agent-wastes-47-of-tokens-searching-for-code-heres-the-fix-83ef7b5521f7), [Developers Digest](https://www.developersdigest.tech/blog/claude-code-token-burn-cache-observability))
- At the org level it's worse: reporting has pegged heavy Claude Code usage at **$500–$2,000 per engineer per month**, with teams reportedly burning through annual AI budgets in a matter of months. ([Level Up Coding](https://levelup.gitconnected.com/claude-code-token-burn-the-unplanned-100-month-reality-48587c6a92ce), [morphllm](https://www.morphllm.com/ai-coding-costs))
- And when a run *does* runaway — a subagent stuck in a loop, a bad tool call retried forever — that spend is usually gone. No refunds, no undo. ([AI Weekly](https://aiweekly.co/alerts/claude-code-ultracode-burns-17m-tokens-no-refunds))

None of that is an argument against Claude. It's an argument for not paying Claude prices for typing. That's the whole idea behind Sidewrite.

---

## The idea, in one picture

```
 You + Claude (interactive)  ──▶  plan the work, review the result
 Cheap / free external model ──▶  does the actual typing (headless, background)
 Dashboard (localhost)       ──▶  shows you every run, every token, every dollar — live
```

Planning and reviewing are where Claude's judgment earns its keep. Typing out the diff is the expensive, repetitive part. Sidewrite keeps the first on your subscription and moves the second somewhere cheap.

---

## Contents

- [Install](#install)
- [Quick start](#quick-start)
- [Two modes](#two-modes)
- [The dashboard](#the-dashboard)
- [Parallel workers](#parallel-workers)
- [Providers](#providers)
- [Commands](#commands)
- [Project structure](#project-structure)
- [How it works](#how-it-works)
- [Safety](#safety)
- [License](#license)

---

## Install

```sh
npm i -g sidewrite
```

You'll need:

| Requirement | Why |
|---|---|
| **Node.js ≥ 22.5** | Sidewrite is pure Node — zero external dependencies |
| **Claude Code** (`claude` CLI) | Sidewrite plugs into it; doesn't replace it |

Then wire it in once — this registers the plugin, the slash commands, and the dashboard:

```sh
sidewrite install
```

Something off? `sidewrite doctor` checks Node, Claude Code, and your config, and tells you exactly what to fix.

## Quick start

**On a Claude subscription?** Keep working in Claude Code as normal. When you're ready to build something, say:

```
/sidewrite-delegate
```

Claude turns the conversation into a self-contained brief and ships *that* — not the raw transcript — to a cheap external model to implement. You review the diff back inside your normal conversation, like nothing changed except your bill.

**No subscription, or just want to go fully external?**

```sh
sidewrite mode standalone
sidewrite code
```

This runs Claude Code itself against your chosen provider — same interface, different engine.

Either way:

```sh
sidewrite
```

opens the dashboard so you can watch it happen.

## Two modes

| | **subscription** *(default)* | **standalone** |
|---|---|---|
| Who plans & reviews | You, chatting with Claude, as usual | The external model |
| Who writes the code | A cheap external model, headless, in the background | Same external model — no Claude subscription touched at all |
| Delegate with | `/sidewrite-delegate` inside Claude Code | `sidewrite code` |
| Best for | Anyone with a Claude subscription who wants to stop burning it on typing | Anyone without a subscription — or who wants Claude Code's UX on someone else's model entirely |

Switch anytime: `sidewrite mode subscription` / `sidewrite mode standalone`.

## The dashboard

`sidewrite` opens it — a small local website, nothing leaves your machine, secured by a private access token. It's the control tower for everything above:

- **Runs** — watch a delegated task execute, or scroll back through history
- **Providers** — add a provider, pick a model, test the connection
- **Skills** — manage the skills installed alongside Sidewrite
- **Analytics** *(tucked under "More")* — token and cost breakdowns, per model, over time
- **Budgets** — set a spend alert before it becomes a surprise
- **Health** — is everything actually wired up correctly
- **Privacy** — exactly what's shared (if anything), and the switch to turn it off

If a provider fails — rate-limited, out of credit, down — Sidewrite falls through to your next configured one automatically. If they all fail, it hands the task back to you with a real reason instead of hanging forever.

## Parallel workers

Most tasks are one model, one job, one diff. But some tasks split cleanly — three independent docs pages, three unrelated modules — and for those, Sidewrite can fan out to **several workers running at once**, each in its own isolated `git worktree`:

1. You (or Claude, via `/sidewrite-delegate`) write one shared plan plus a manifest of which worker owns which files.
2. Sidewrite checks up front that no two workers claim the same files — if they overlap, it refuses to start rather than gamble on a merge conflict.
3. Each worker gets its own worktree and branch, and works only inside its own slice.
4. When everyone's done, their diffs land back in your project together.

```sh
sidewrite run --workers-file team.json --plan-file PLAN.md
```

Opt-in, advanced, and entirely optional — a single worker is the right default for almost everything you'll throw at this.

## Providers

Anything that speaks Claude's own Messages API ("Anthropic-compatible") is fair game:

| Provider | Notes |
|---|---|
| DeepSeek, GLM (Z.ai), Kimi (Moonshot), MiniMax, Qwen, DeepInfra, Novita, Fireworks, SambaNova, Baseten | Native Anthropic-wire endpoints, ready out of the box |
| **OpenRouter** | The easy button — search a model, paste a key, done. The catalog ships bundled, so browsing works offline |
| **Cloudflare AI Gateway** | One connection that fronts OpenAI, Google Gemini, Groq, and xAI models too, all through one setup |
| **Your own box** | Ollama, LM Studio, vLLM, or anything self-hosted — as long as it speaks Anthropic's wire format. A small free proxy ([claude-code-router](https://github.com/musistudio/claude-code-router), LiteLLM) translates if it doesn't |

Add any of them from the dashboard's **Providers** tab. Keys live only on your machine, permission-locked to your user.

## Commands

| Command | What it does |
|---|---|
| `sidewrite` | open the dashboard |
| `sidewrite install` / `uninstall` | register (or remove) the plugin + dashboard — settings survive uninstall |
| `sidewrite doctor` | diagnose your setup |
| `sidewrite setup` | guided first-run configuration |
| `sidewrite mode [subscription\|standalone]` | show or switch mode |
| `sidewrite code [provider]` | launch an interactive Claude Code session on an external provider |
| `sidewrite code --resume` / `-c` / `--continue` | resume a previous session — flags pass straight through to `claude` |
| `sidewrite run [provider] "task"` | delegate one task headlessly |
| `sidewrite run --workers-file team.json --plan-file PLAN.md` | fan out a task across parallel isolated workers |
| `sidewrite status` | quick health snapshot |
| `sidewrite up` / `stop` | start / stop the background dashboard daemon |
| `sidewrite undo` | revert files a run wrote back into your working directory |

Inside Claude Code: `/sidewrite-delegate` (hand off the current task), `/sidewrite-open` (open the dashboard), `/sidewrite-status` (health check), `/sidewrite-viewer` (dashboard URL + live pipeline stage).

## Project structure

```
bin/
  sidewrite       the command you actually run
  sidewrite-run   the plan → implement pipeline
  ccx             low-level: swaps in a provider's API, safely, in a scrubbed env

plugin/
  scripts/        dashboard server + all CLI logic
  ui/             the dashboard's web pages
  data/           the built-in provider + model catalog
  commands/       the /sidewrite-* slash commands
  skills/         packaged Claude Code skills
```

## How it works

Under the hood, `ccx` temporarily points Claude Code at a different provider's API address instead of Anthropic's — like changing a delivery address, not the courier. It runs in a completely separate, sandboxed copy of your Claude Code config (`CLAUDE_CONFIG_DIR=~/.claude-<provider>`), with a fully scrubbed environment so no stray `ANTHROPIC_*` variable or cached OAuth token leaks in. It refuses outright to point at `api.anthropic.com` — that would defeat the entire point. Every run streams its events to the local dashboard, live.

## Safety

- Your real Claude subscription is **never** run headlessly — only interactively, by you.
- Sidewrite **never** touches your Claude login, and never logs you out.
- The dashboard only listens on `localhost`, behind a private access token.
- API keys are stored locally, file-permission-locked (`0600`), and never echoed back once saved.
- Telemetry is **off by default** — you opt in, from the Privacy tab, if you ever want to.

## License

Apache-2.0 © 2026 Hassan Ali <hsnnet963@gmail.com>
