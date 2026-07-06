// Copy + data for the landing page, extracted so the section components stay
// presentational.

export const INSTALL_CMD = "npm i -g sidewrite";

export const GITHUB_URL = "https://github.com/hassanalitamam/sidewrite";

export const AUTHOR = {
  name: "Hassan Ali",
  email: "hsnnet963@gmail.com",
  discord: "hassanalitamam",
};

// Single source of truth for "current version" strings scattered across the
// site (Hero badge, Footer, SubFooter, docs overview) — keep this in sync
// with package.json / plugin.json / marketplace.json (scripts/sync-version.cjs
// bumps those three; this one is landing-only copy and isn't touched by it,
// so it must be updated by hand on release).
export const CURRENT_VERSION = "v0.2.0";

export const TAGLINE_OPTIONS = [
  "Any model. Your rules.",
  "Your Claude Code, any model.",
  "Delegate the work. Keep the subscription.",
  "One dashboard. Every provider. Zero lock-in.",
];

export const HERO = {
  badge: `Claude Code plugin · Apache-2.0 · ${CURRENT_VERSION}`,
  subtitle:
    "Run Claude Code on any Anthropic-compatible model — with or without a subscription. Plan on Claude, implement on your provider, watch every token on a live local dashboard.",
};

export const STATS = [
  { value: "17", label: "providers · 256 models bundled" },
  { value: "0", label: "external dependencies" },
  // Grounded in plugin/data/pool-providers.json — 10 pooled free-tier
  // providers, 209 models total, no card required for any of them.
  // Deliberately NOT a tokens/day or requests/day figure: every provider
  // publishes its own limits differently (some per-model RPD/TPD, some
  // account-wide RPM only, some a neuron budget, some nothing at all), so
  // any single combined throughput number needs estimation to fill the
  // gaps — and estimates drift as providers change limits without notice.
  // A plain provider/model count needs no such guesswork.
  { value: "10", label: "free-tier providers · 209 models, no card" },
  { value: "127.0.0.1", label: "local-only dashboard" },
];

export const MODES = [
  {
    tag: "HAS CLAUDE",
    tagActive: true,
    title: "Subscription",
    blurb:
      "Plan and review on Claude. Delegate the heavy lifting to a cheaper model.",
    steps: [
      "Plan & review with interactive Claude — your subscription, used normally.",
      // `code` marks a monospace/orange inline fragment: [text, code, text]
      ["Run ", "/sidewrite-delegate", ' — or just say "delegate this with Sidewrite."'],
      "A provider implements headless in an isolated git worktree; Claude reviews the diff.",
    ],
  },
  {
    tag: "NO SUBSCRIPTION",
    tagActive: false,
    title: "Standalone",
    blurb: "The full Claude Code experience, powered entirely by your own model.",
    steps: [
      "Add a provider — OpenRouter, your endpoint, or Ollama via a gateway — and pick a model.",
      ["", "sidewrite code", " launches interactive Claude Code on that model."],
      "Use Claude Code normally — powered by your model, billed to your key.",
    ],
  },
];

export const PROVIDER_TAGS = [
  "openrouter",
  "deepseek",
  "moonshot / kimi",
  "glm / z.ai",
  "minimax",
  "qwen / dashscope",
  "xiaomi mimo",
  "deepinfra",
  "novita",
  "fireworks",
  "baseten",
  "cloudflare ai gateway",
  "sambanova",
  "together",
  "ollama · local",
  "lm studio · local",
  "vllm · local",
  "custom base URL",
];

export const FEATURES = [
  {
    kicker: "DELEGATION",
    title: "No PLAN.md",
    body:
      "Claude writes a concise brief from the conversation and hands off. Only the brief crosses — never your transcript.",
  },
  {
    kicker: "FAILOVER",
    title: "Credit-aware failover",
    body:
      "Preflight credit checks; bad key, rate limit, or timeout falls through to the next provider. A watchdog kills hung runs.",
  },
  {
    kicker: "DASHBOARD",
    title: "Live dashboard suite",
    wide: true,
    body:
      "Real-time pipeline, provider activity, per-model cost in tokens and USD, and event log over SSE, " +
      "plus dedicated views for analytics (per-model, provider, agent, and project cost breakdowns with " +
      "time-series charts), system health, cost budgets with alerts, and a privacy/data panel.",
  },
  {
    kicker: "RUNTIME",
    title: "Fast & lightweight",
    body:
      "Node built-ins only. Sub-second commands from a cached snapshot; robust port handling, never duplicates a daemon. Catalog works offline.",
  },
  {
    kicker: "AUTO-UPDATE",
    title: "Always current",
    body:
      "A background check against the npm registry on every run notifies you in the terminal the moment a newer version ships, with an opt-in apply path that backs up, installs, and rolls back automatically on failure. A remote version floor can require the update before a run proceeds for critical fixes — fails open if the check itself can't be reached.",
  },
  {
    kicker: "FREE-TIER POOL",
    title: "Run for $0",
    wide: true,
    diagram: true,
    body:
      "One local gateway (POST /v1/messages, standard Anthropic wire) fronts all 10 providers — point any Claude-Code-compatible client at it and it rotates across every pooled key transparently, with tier-aware fallback so a sonnet request exhausts every sonnet-tier candidate before ever dropping to haiku. A cooling-down candidate isn't dead weight: its rpm/rpd/tpm/tpd budget refills continuously, so it rejoins rotation the moment it has room again — no manual reset. Sticky sessions keep the same provider for a conversation, and a context-handoff note covers you on a forced swap. Every candidate is proactively budget-checked before dispatch, not just retried after a 429. Mistral alone publishes a 1,000,000,000-token/month free quota across its \"Experiment\" tier models — one of ten pools this deep. Keys are stored AES-256-GCM encrypted, never returned by any read API.",
  },
];

export const SAFETY_BADGES = [
  {
    code: "CLAUDE_CONFIG_DIR",
    text: "External sessions run isolated — never logs you out. Switch modes freely.",
  },
  {
    code: "no OAuth proxying",
    text: "The isolated runner refuses api.anthropic.com and scrubs its environment.",
  },
  {
    code: "127.0.0.1 only",
    text: "Bearer token + host/origin guard; secrets redacted everywhere.",
  },
  {
    code: "0600 key files",
    text: "Keys stored locked-down, never returned by any read API.",
  },
];

export const COMPARISONS = [
  {
    name: "raw ANTHROPIC_BASE_URL",
    text: "Sidewrite manages providers, keys, model-alias maps, failover, and isolation — with a dashboard — and guarantees your login is never disturbed.",
  },
  {
    name: "claude-code-router",
    text: "Sidewrite adds the delegation workflow (plan on Claude, implement on a provider), live cost and pipeline visibility, credit-aware failover, and a subscription-safe design — not just routing.",
  },
  {
    name: "token-passing proxies",
    text: "Sidewrite never proxies OAuth and is explicitly designed to stay within bounds — each provider on its own key.",
  },
  {
    name: "a single free API key",
    text: "One free provider means you're stuck the moment you hit its rate limit. The Free-Tier Pool rotates across 10 providers, exhausting every same-tier candidate before ever dropping a sonnet request to haiku, keeps you on the same provider all conversation via sticky sessions (with a context-handoff note if it has to swap), and checks each candidate's rpm/rpd/tpm/tpd budget before dispatch — not after a 429.",
  },
];

export const INSTALL_CHIPS = [
  "/sidewrite-delegate",
  "/sidewrite-open",
  "/sidewrite-status",
  "sidewrite code",
  "sidewrite mode",
  "ccx",
  "sw",
];

export const FAQ = [
  {
    q: "Do I need a Claude subscription?",
    a: "No. Standalone mode runs Claude Code on your own provider. With a subscription, you get the plan-on-Claude / implement-on-provider split.",
  },
  {
    q: "Will it log me out of Claude?",
    a: "Never. External sessions are isolated; your ~/.claude login is untouched.",
  },
  {
    q: "Which models can I use?",
    a: "17 bundled providers, all Anthropic-compatible — OpenRouter (256 curated models), DeepSeek, GLM/Z.ai, Moonshot/Kimi, MiniMax, Qwen, and more — plus your own endpoint, or local models (Ollama, LM Studio, vLLM) via a small gateway. The Free-Tier Pool goes further and translates OpenAI- and Gemini-wire providers into Anthropic's protocol server-side, so no gateway is needed for those.",
  },
  {
    q: "Is it safe / allowed?",
    a: "Yes — no OAuth proxying, no headless subscription runs, provider keys only.",
  },
  {
    q: "What does it cost?",
    a: "Sidewrite is free and open source (Apache-2.0). You pay only your provider's usage.",
  },
  {
    q: "Does it work offline?",
    a: "The model catalog and dashboard work offline; a key and network are only needed to actually run a model.",
  },
  {
    q: "Can I use Sidewrite for free with no API key?",
    a: "Yes — the Free-Tier Pool rotates across 10 free-tier providers (Z.ai/GLM, Groq, Cerebras, GitHub Models, OpenRouter free models, SambaNova, Cloudflare Workers AI, NVIDIA NIM, Google Gemini, Mistral) with no key of your own required. It exhausts every same-tier candidate before dropping a sonnet request to haiku, checks each candidate's rpm/rpd/tpm/tpd budget before dispatch, and keeps you on the same provider all conversation via sticky sessions.",
  },
  {
    q: "Does WebSearch work on a third-party model?",
    a: "Not natively — Claude Code's built-in WebSearch is an Anthropic-hosted server tool, so it silently no-ops when a session runs against a third-party provider via ccx's base-URL swap. Sidewrite bundles a zero-dependency MCP web_search tool (backed by DuckDuckGo, no API key) that's invoked client-side instead, so search works the same on Claude, mimo, GLM, or anything else ccx points at.",
  },
  {
    q: "Can I cap my spend?",
    a: "You can set a monthly and/or per-run USD budget on the dashboard, with a warning threshold and live spend tracking against it. There's an enforce toggle for a hard stop, but no run path checks it yet — today budgets are visibility and alerts, not a block.",
  },
];

// ── Docs page ───────────────────────────────────────────────────────────────

// Sidebar structure. Each item is its own page — `slug` maps to a route
// (see src/docs/paths.js) and to a section body (see src/docs/sections.jsx).
// `blurb` is the one-liner shown on the Overview page's card grid.
export const DOCS_NAV = [
  {
    label: "Get started",
    items: [
      { slug: "index", label: "Overview", blurb: "Start here — what Sidewrite is and how the pieces fit." },
      { slug: "quickstart", label: "Quickstart", blurb: "Install the plugin and pick a mode in one command." },
      { slug: "two-modes", label: "Two modes", blurb: "Subscription vs standalone — how the pipeline runs." },
      { slug: "providers", label: "Providers", blurb: "17 bundled providers, 256 OpenRouter models, custom endpoints, and local gateways." },
    ],
  },
  {
    label: "Core concepts",
    items: [
      { slug: "delegation", label: "Delegation", blurb: "Hand off implementation with an auto-written brief." },
      { slug: "failover", label: "Failover", blurb: "Credit-aware failover and a watchdog for hung runs." },
      { slug: "dashboard", label: "Dashboard", blurb: "Live pipeline, analytics, health, budgets, and privacy views at 127.0.0.1." },
      { slug: "safety", label: "Safety model", blurb: "How your subscription and keys stay isolated and safe." },
    ],
  },
  {
    label: "Reference",
    items: [
      { slug: "commands", label: "CLI & commands", blurb: "Every CLI and slash command, at a glance." },
      { slug: "faq", label: "FAQ", blurb: "Requirements, safety, models, cost, and offline use." },
    ],
  },
];

export const DOCS_PROVIDERS = [
  { name: "openrouter", desc: "256 curated models — search, filter by vendor, paste a key; prices auto-fill." },
  { name: "17 bundled providers", desc: "DeepSeek, Moonshot/Kimi, GLM/Z.ai, MiniMax, Qwen, Fireworks, Baseten, and more — same paste-a-key flow." },
  { name: "custom endpoint", desc: "Any Anthropic-compatible base URL." },
  { name: "ollama / lm studio / vllm", desc: "Local models via claude-code-router or LiteLLM gateway." },
];

export const DOCS_COMMANDS = [
  { cmd: "/sidewrite-delegate", desc: "Hand off the current task to a provider." },
  { cmd: "/sidewrite-open", desc: "Open the live dashboard." },
  { cmd: "/sidewrite-status", desc: "Check current mode, provider, and run status." },
  { cmd: "sidewrite code", desc: "Launch interactive Claude Code on your model (standalone mode). Aliases: code, c, co." },
  { cmd: "sidewrite mode", desc: "Switch between subscription and standalone." },
  { cmd: "ccx", desc: "Shorthand alias for the CLI." },
  { cmd: "sw", desc: "Optional short shell alias for sidewrite, installed via sidewrite alias." },
];

// ── Changelog page ──────────────────────────────────────────────────────────

// Each release is a timeline node. `accent` draws the orange line + larger dot
// (used for the latest release); `last` trims the trailing timeline padding.
// Entry `parts` follow the RichText mini-format (see components/RichText.jsx).
export const CHANGELOG = [
  {
    version: "v0.2.0",
    date: "2026-07-06",
    latest: true,
    accent: true,
    entries: [
      {
        tag: "NEW",
        parts: [
          { strong: "Live telemetry & error reporting." },
          " Opt-in crash/error events and daily usage digests now flow end-to-end to a Vercel ingest endpoint (Sentry + webhook alerting) — off by default, scrubbed client-side before anything leaves the machine.",
        ],
      },
      {
        tag: "NEW",
        parts: [
          { strong: "Force-update gate." },
          " A remote-config version floor can require an update before a run proceeds — fails open until the hosting endpoint is live.",
        ],
      },
      {
        tag: "FIX",
        parts: [
          "Landing page install command, GitHub link, and provider rate-limit copy corrected to match what's actually shipped — including a live GitHub star count and a cleaned-up changelog.",
        ],
      },
    ],
  },
  {
    version: "v0.1.0",
    date: "2026-07-06",
    accent: false,
    last: true,
    entries: [
      {
        tag: "NEW",
        parts: [
          { strong: "Free-Tier Pool." },
          " Rotate across free-tier (provider, model, key) candidates with tier-aware fallback, sticky sessions, and proactive rpm/rpd/tpm/tpd budget gating — no silent drop to a weaker model mid-conversation.",
        ],
      },
      {
        tag: "NEW",
        parts: [
          { strong: "Auto-update." },
          " Background check against the npm registry on every run notifies you in the terminal when a newer version ships; opt-in apply path backs up, installs, and rolls back on failure.",
        ],
      },
      {
        tag: "NEW",
        parts: [
          { strong: "Analytics dashboard." },
          " Per-model / provider / agent / project token + cost breakdowns and daily trends, rendered as local SVG charts — local-first, no egress.",
        ],
      },
      {
        tag: "NEW",
        parts: [
          { strong: "Cost budgets & alerts." },
          " Set a monthly or per-run USD ceiling with a warn threshold, surfaced live on the dashboard. An enforce flag is there for a future hard-stop; no run path checks it yet.",
        ],
      },
      {
        tag: "NEW",
        parts: [
          "Dashboard additions: provider connectivity test, actionable failures with one-click re-dispatch, system-health panel, diff preview, and a privacy & data panel.",
        ],
      },
      {
        tag: "NEW",
        parts: [
          { strong: "Guided onboarding." },
          " First-run banner and empty-state walk through provider + model setup.",
        ],
      },
      {
        tag: "NEW",
        parts: [
          { strong: "CLI aliases." },
          " ",
          { code: "sw" },
          " shortcut, plus ",
          { code: "code" },
          " / ",
          { code: "c" },
          " / ",
          { code: "co" },
          " subcommand aliases.",
        ],
      },
      {
        tag: "NEW",
        parts: [
          { strong: "WebSearch / WebFetch MCP parity." },
          " Claude Code's native, Anthropic-hosted search tools don't work under a provider swap, so Sidewrite registers working client-side replacements as MCP tools the first time a provider runs.",
        ],
      },
      {
        tag: "NEW",
        parts: [
          "Resume, history, multi-project scoping, and install preflight — see ",
          { code: "IMPLEMENTATION.md" },
          " for the full list.",
        ],
      },
      {
        tag: "v1",
        parts: [
          { strong: "First published npm release." },
          " Version synced to ",
          { code: "0.1.0" },
          " across all manifests via ",
          { code: "sync-version.cjs" },
          " — installable via ",
          { code: "npm i -g sidewrite" },
          ".",
        ],
      },
    ],
  },
];
