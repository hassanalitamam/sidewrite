# Sidewrite (Claude Code plugin)

**Delegate the typing to a cheap external model, straight from inside Claude Code — and watch it happen in a live local dashboard.**

This is the plugin half of Sidewrite. It adds slash commands, a background daemon, and a skill that turns any Claude Code conversation into a headless implement run on whatever anthropic-compatible provider you've configured — GLM, DeepSeek, Kimi, OpenRouter, your own box, whatever. Planning and review stay right here, in this chat, on your subscription.

For the full story (why this exists, the CLI, providers, parallel workers) see the [main README](../README.md). This doc only covers what changes once Sidewrite is installed as a Claude Code plugin.

---

## Install

The easiest route is via npm — it installs the CLI *and* registers the plugin in one step:

```sh
npm i -g sidewrite
sidewrite install
```

`sidewrite install` runs `claude plugin marketplace add <dir> --scope user` followed by `claude plugin install sidewrite@sidewrite-marketplace` for you, links the `sidewrite`/`ccx` binaries, starts the dashboard daemon, and opens it in your browser. Restart Claude Code afterward so the new slash commands load.

If the `claude` CLI isn't on your PATH when you run `sidewrite install`, it skips that step and prints the exact commands to run yourself inside Claude Code:

```
/plugin marketplace add <path-it-prints>
/plugin install sidewrite@sidewrite-marketplace
```

To upgrade the plugin later: `claude plugin update sidewrite@sidewrite-marketplace`, then restart Claude Code.

**Requirements:** the `claude` CLI on PATH, and Node.js ≥ 22.5.

---

## Slash commands

| Command | What it does |
|---|---|
| `/sidewrite-delegate` | Turns the current conversation into a self-contained implement brief and hands off a headless run to your active provider. |
| `/delegate` | Alias of `/sidewrite-delegate` — takes an optional extra-context argument. |
| `/sw` | Same alias, shorter to type. |
| `/sidewrite-open` | Opens the dashboard (starts the daemon first if it isn't running). |
| `/sidewrite-status` | Fast health snapshot — daemon port, version, mode, active provider/model, current pipeline stage. |
| `/sidewrite-viewer` | Prints the dashboard URL and current pipeline stage/status. |

There's also a packaged **skill** (`sidewrite-delegate`) that fires on natural-language phrasing — "delegate this", "sidewrite this", "let sidewrite build this", and common typos/aliases — so you don't have to remember the exact slash command.

---

## The delegate workflow

1. Ask for `/sidewrite-delegate` (or just say "delegate this") once you're ready to hand off implementation.
2. Claude — the model you're talking to right now — distills the conversation into a self-contained brief: goal, constraints, acceptance criteria, likely files to start from, do-not-touch areas. The raw transcript never leaves this session; only the brief does.
3. That brief goes to `sidewrite run`, which spins up a git worktree, runs the implement step headless via `ccx` against your active provider, and streams every event to the dashboard.
4. You get one result line back — `✅ TASK COMPLETE` or `❌ IMPLEMENT FAILED` — and review the diff here, in your normal conversation, on your normal subscription.

Most tasks are a single worker. For work that cleanly splits into file-disjoint slices (independent modules, separate doc pages, separate test files), `/sidewrite-delegate` can also fan out to **several parallel workers**, each in its own worktree, each owning a distinct set of files — the runner refuses to start if two workers claim overlapping paths.

---

## The dashboard

`/sidewrite-open` (or plain `sidewrite` from a terminal) launches the control room — a small site on `localhost`, nothing leaves your machine:

- **Runs** — live view of a delegated task, plus history
- **Providers** — add one, pick a model, test the connection
- **Skills** — manage skills installed alongside Sidewrite
- **Analytics** — token/cost breakdowns per model, over time
- **Budgets** — spend alerts before they become surprises
- **Health** — confirms everything's actually wired up
- **Privacy** — what's shared (if anything) and the switch to turn it off

---

## Requirements & safety

- Needs the `claude` CLI and Node.js ≥ 22.5. No other dependencies.
- Anthropic-wire-only: providers must speak Claude's own Messages API (natively, or through a small translating proxy like claude-code-router).
- Your real Claude subscription is never run headlessly, and Sidewrite never touches your `~/.claude` login or logs you out.
- Telemetry is off by default.
- Claude Code's native `WebSearch`/`WebFetch` are Anthropic-hosted server tools that don't work under a third-party provider swap. The first time a provider is used with `sidewrite code`, Sidewrite registers working client-side replacements (`websearch-mcp.cjs`, DuckDuckGo-backed, and `webfetch-mcp.cjs`) as MCP tools and denies the broken native ones, so search and page-fetching keep working regardless of which model backend is active.

## License

Apache-2.0
