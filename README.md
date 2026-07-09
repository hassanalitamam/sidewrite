# Sidewrite

**Hit your Claude usage limit? Keep coding.**

Claude Code burns through your weekly limit fastest during implementation — reading files, running tools, iterating. Sidewrite keeps Claude for planning and review, delegates that grind to another model (free-tier or your own key), and switches you over automatically the moment you run out.

No external dependencies. Just Node. Apache-2.0.

<p align="center">
  <img src="https://raw.githubusercontent.com/hassanalitamam/sidewrite/main/assets/screenshots/runs.png" alt="Sidewrite's Runs page — a history of delegated tasks, each with its status and the model that ran it" width="820">
</p>

---

## Install

```sh
npm i -g sidewrite
sidewrite install
```

Requires Node.js ≥ 22.5 and the `claude` CLI. Something off? `sidewrite doctor` tells you what to fix.

## Quick start

**On a Claude subscription** — keep working normally, then delegate the implementation:

```
/sidewrite-delegate
```

**No subscription, or want to go fully external:**

```sh
sidewrite mode standalone
sidewrite code
```

Either way, `sidewrite` opens the dashboard so you can watch it happen.

## Two modes

| | **subscription** *(default)* | **standalone** |
|---|---|---|
| Plans & reviews | You + Claude, as usual | The external model |
| Writes the code | A cheap external model, headless | Same model — no subscription touched |
| Delegate with | `/sidewrite-delegate` | `sidewrite code` |

Switch anytime: `sidewrite mode subscription` / `sidewrite mode standalone`.

## Run for $0 — the Free-Tier Pool

One local gateway fronts 9 free-tier providers (197 models, no card required) and rotates across all of them automatically:

- **Tier-aware fallback** — exhausts every same-tier candidate before ever dropping a request to a weaker model.
- **Auto-renewing budgets** — a cooling-down provider isn't dead weight; its rate limit refills continuously and it rejoins rotation the moment it has room, no manual reset.
- **Failover on the fly** — a bad key, rate limit, or timeout falls through to the next provider mid-conversation, with a context-handoff note if it has to swap.
- **Sticky sessions** — you stay on the same provider for a conversation whenever possible.

<p align="center">
  <img src="https://raw.githubusercontent.com/hassanalitamam/sidewrite/main/assets/screenshots/providers.png" alt="Sidewrite's Free Lane pane — pooled free-tier providers, capacity claimed, and per-provider connection status" width="820">
</p>

## Providers

17 bundled providers speaking Claude's own Messages API out of the box — OpenRouter (256 curated models), DeepSeek, GLM/Z.ai, Moonshot/Kimi, MiniMax, Qwen, Fireworks, Baseten, Cloudflare AI Gateway, and more — plus any custom Anthropic-compatible endpoint, or a local model (Ollama, LM Studio, vLLM) via a small gateway.

## Token-saving features

Three opt-out features stretch a Free-Tier Pool budget further, controlled from the dashboard's **Studio → Tools** tab:

- **Terse replies** — a short instruction rides every outbound request, cutting output tokens on providers that tend to over-explain.
- **History compaction** — long conversations get deduplicated and truncated before dispatch, only once a request is already large (default ~100,000 tokens). Nothing is lost for good: omitted content is cached locally and the model can retrieve it on demand via a `pool_retrieve` tool, bounded to a few retrieval rounds so it can never loop forever.
- **RTK command compression** *(optional)* — compresses noisy Bash tool output (`git`, `grep`, `cargo test`, …) before it reaches the model, if you separately install the third-party [`rtk`](https://github.com/rtk-ai/rtk) CLI. Sidewrite never installs it for you, and degrades to a no-op if it isn't present.

Each toggle is on by default and can be switched off per-feature from the dashboard; nothing here talks to a network beyond the provider call itself.

## The dashboard

`sidewrite` opens a local-only site (`127.0.0.1`, token-protected): live runs, provider setup, skills, sub-agents, MCP, token-saving tools, analytics, budgets, health, a privacy panel showing exactly what's shared (off by default), and a feedback button for bug reports or screenshots.

## Commands

| Command | What it does |
|---|---|
| `sidewrite` | open the dashboard |
| `sidewrite install` / `uninstall` | register / remove the plugin + dashboard |
| `sidewrite doctor` | diagnose your setup |
| `sidewrite mode [subscription\|standalone]` | show or switch mode |
| `sidewrite code [provider]` | interactive Claude Code session on an external provider |
| `sidewrite run [provider] "task"` | delegate one task headlessly |
| `sidewrite status` | quick health snapshot |
| `sidewrite up` / `stop` | start / stop the background dashboard daemon |

Inside Claude Code: `/sidewrite-delegate`, `/sidewrite-open`, `/sidewrite-status`.

## Auto-update

A background check against the npm registry notifies you in the terminal the moment a newer version ships, with an opt-in apply path that backs up, installs, and rolls back on failure.

## Safety

- Your real Claude subscription is **never** run headlessly — only interactively, by you.
- Sidewrite never touches your Claude login, and never logs you out.
- External sessions run fully isolated (`CLAUDE_CONFIG_DIR`) and refuse to point at `api.anthropic.com`.
- API keys are stored locally, permission-locked (`0600`), never returned by any read API.

## Credits

The token-saving features were shaped by prior work in the same space:

- **Terse replies** adapts the MIT-licensed instruction text from [JuliusBrussee/caveman](https://github.com/JuliusBrussee/caveman).
- **History compaction**'s Compress-Cache-Retrieve design (cache what's omitted, let the model retrieve it on demand instead of losing it for good) follows the same approach pioneered by [headroom](https://github.com/headroomlabs-ai/headroom) — reimplemented natively in Node rather than depending on its Python service.
- **RTK command compression** is an optional integration with [rtk-ai/rtk](https://github.com/rtk-ai/rtk), a separate tool you install yourself.

Not part of sidewrite, but pairs well with it: [Ponytail](https://github.com/DietrichGebert/ponytail), a Claude Code plugin that nudges the agent toward writing less code. Install it independently from the Studio → Tools tab's link, or `/plugin marketplace add DietrichGebert/ponytail`.

## License

Apache-2.0 © 2026 Hassan Ali <hsnnet963@gmail.com> · Discord: hassanalitamam
