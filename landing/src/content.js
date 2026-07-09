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
export const CURRENT_VERSION = "v0.3.0";

export const TAGLINE_OPTIONS = [
  "Hit your limit. Keep coding.",
  "Any model. Your rules.",
  "Your Claude Code, any model.",
  "Delegate the work. Keep the subscription.",
  "One dashboard. Every provider. Zero lock-in.",
];

export const HERO = {
  badge: `Claude Code plugin · Apache-2.0 · ${CURRENT_VERSION}`,
  subtitle:
    "Claude Code burns through your weekly limit fastest during implementation — reading files, running tools, iterating. Sidewrite keeps Claude for planning and review, delegates that grind to another model, and switches you to a free one automatically if you still run out.",
};

export const STATS = [
  { value: "17", label: "providers · 256 models bundled" },
  { value: "0", label: "external dependencies" },
  // Grounded in plugin/data/pool-providers.json — 9 pooled free-tier
  // providers, 197 models total, no card required for any of them.
  // Deliberately NOT a tokens/day or requests/day figure: every provider
  // publishes its own limits differently (some per-model RPD/TPD, some
  // account-wide RPM only, some a neuron budget, some nothing at all), so
  // any single combined throughput number needs estimation to fill the
  // gaps — and estimates drift as providers change limits without notice.
  // A plain provider/model count needs no such guesswork.
  { value: "9", label: "free-tier providers · 197 models, no card" },
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
      "Real-time pipeline, provider activity, and per-model cost, streamed live over SSE. Dedicated views cover analytics, system health, budgets, and privacy.",
  },
  {
    kicker: "RUNTIME",
    title: "Fast & lightweight",
    body:
      "Node built-ins only, with sub-second commands from a cached snapshot. Robust port handling never duplicates a daemon, and the catalog works offline.",
  },
  {
    kicker: "AUTO-UPDATE",
    title: "Always current",
    body:
      "A background check notifies you the moment a newer version ships, with an opt-in apply path that backs up and rolls back on failure. A remote version floor can require the update first for critical fixes.",
  },
  {
    kicker: "FREE-TIER POOL",
    title: "Run for $0",
    wide: true,
    body:
      "One local gateway fronts all 9 free providers, rotating across every pooled key automatically — tier-aware, so a sonnet request exhausts every same-tier candidate before ever dropping to haiku. Sticky sessions keep you on the same provider all conversation, and every candidate's budget is checked before dispatch, not after a 429.",
  },
  {
    kicker: "TOKEN SAVINGS",
    title: "Terse mode, compaction, RTK",
    wide: true,
    body:
      "Three opt-out toggles, controllable live from Studio → Tools: terse replies trim output tokens, history compaction shrinks large conversations before dispatch without losing anything for good, and an optional hook compresses noisy Bash output. All independent, all reversible.",
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
    text: "One free provider means you're stuck the moment you hit its rate limit.",
    link: { href: "#v3-pool", label: "See the Free-Tier Pool ↑" },
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
    q: "Can I use Sidewrite for free?",
    a: "Yes — the Free-Tier Pool rotates across 9 free-tier providers (Z.ai/GLM, Cerebras, GitHub Models, OpenRouter free models, SambaNova, Cloudflare Workers AI, NVIDIA NIM, Google Gemini, Mistral). Each is free to sign up for, no card required — you'll still paste each provider's own free API key. It exhausts every same-tier candidate before dropping a sonnet request to haiku, checks each candidate's rpm/rpd/tpm/tpd budget before dispatch, and keeps you on the same provider all conversation via sticky sessions.",
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

// Curated subset shown on the homepage — short, high-value questions only.
// The full FAQ (above) lives at /docs/faq.html; the homepage section links
// there for anything not covered here.
export const HOME_FAQ = [
  FAQ[0], // Do I need a Claude subscription?
  FAQ[2], // Which models can I use?
  FAQ[4], // What does it cost?
  {
    q: "Can I use Sidewrite for free?",
    a: "Yes — the Free-Tier Pool rotates across 9 free-tier providers, free to sign up with no card required (you'll still add each provider's own free key). See how it works ↑.",
  },
  FAQ[3], // Is it safe / allowed?
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
    version: "v0.3.0",
    date: "2026-07-09",
    latest: true,
    accent: true,
    beta: true,
    entries: [
      {
        tag: "FIX",
        parts: [
          { strong: "Onboarding only ever offered a paid provider." },
          " Finishing setup required adding your own API key, even though the Free-Tier Pool needs no paid account. Added a real free-provider path that routes to the Free Lane pane instead of claiming instant, keyless setup.",
        ],
      },
      {
        tag: "FIX",
        parts: [
          { strong: "Removed an inflated tokens/day figure from the Free Lane pane." },
          " It summed every provider's rate limit assuming continuous 24/7 use, ballooning into implausible numbers. Requests/day — directly grounded in published limits — stays.",
        ],
      },
      {
        tag: "NEW",
        parts: [
          { strong: "Feedback modal with attachments." },
          " In-plugin feedback moved from a full page to a popup, reachable from the dashboard's feedback button, and can now carry up to 3 screenshots or files (2MB each, 3MB combined) alongside the message. Remembers your email between opens — never the message text.",
        ],
      },
      {
        tag: "NEW",
        parts: [
          { strong: "Contact form on the landing page." },
          " A contact us / report an issue form, with the same attachment support as the in-plugin feedback modal.",
        ],
      },
      {
        tag: "NEW",
        parts: [
          { strong: "Homepage redesign." },
          " Six sections collapsed into three — how it works, why trust it, get started. The Free-Tier Pool, previously explained in three separate places, now has one full explanation and a dedicated diagram. FAQ and the provider list trimmed to the essentials, with links out to the full versions.",
        ],
      },
      {
        tag: "FIX",
        parts: [
          { strong: "Feedback submissions were silently failing in production." },
          " An overly aggressive PII scrubber was redacting the reply email to ",
          { code: "[email]" },
          " before every send, so every submission was rejected by landing and fell back to the local disk queue. Email is no longer run through the scrubber — message text still is.",
        ],
      },
      {
        tag: "FIX",
        parts: [
          { strong: "Dashboard-reported version was stale." },
          " Hardcoded to an old ",
          { code: "1.2.0" },
          "; now reads the real version from ",
          { code: "package.json" },
          " at boot.",
        ],
      },
      {
        tag: "FIX",
        parts: [
          { strong: "Xiaomi MiMo provider corrected." },
          " Removed 3 discontinued models and fixed the base URL to use MiMo's Anthropic-compatible endpoint instead of its OpenAI-compatible one.",
        ],
      },
      {
        tag: "FIX",
        parts: ["Enlarged the Base URL / Models Endpoint input fields in the add-provider form — long URLs were cramped."],
      },
      {
        tag: "FIX",
        parts: [
          { strong: "Free-Tier Pool count corrected to 9 providers / 197 models." },
          " Groq was dropped from the pool (every free-tier model capped at a 6,000–30,000 TPM ceiling, and its one high-budget model rejected tool-calling outright), but the site's stats, feature copy, and comparisons still quoted the old 10-provider / 209-model figures. All of them now match ",
          { code: "plugin/data/pool-providers.json" },
          ".",
        ],
      },
      {
        tag: "NEW",
        parts: [
          { strong: "GitHub icon in the dashboard header." },
          " A one-click link to the repo sits next to the theme toggle in the local dashboard's topbar.",
        ],
      },
      {
        tag: "NEW",
        parts: [
          "Repo discoverability: GitHub topics (",
          { code: "claude-code" },
          ", ",
          { code: "cli" },
          ", ",
          { code: "llm" },
          ", and more) and a homepage link to the live site added to the repo's About panel.",
        ],
      },
      {
        tag: "FIX",
        parts: [
          { strong: "README rewritten." },
          " Trimmed to install, quick start, modes, the Free-Tier Pool, providers, commands, and safety — dropped the long-form rationale section for a page that's quicker to scan.",
        ],
      },
      {
        tag: "NEW",
        parts: [
          { strong: "Terse mode." },
          " An opt-out toggle prepends a short, terse-reply instruction to every Free-Tier Pool request, cutting output tokens. Adapted from the MIT-licensed ",
          { code: "caveman" },
          " project's instruction text.",
        ],
      },
      {
        tag: "NEW",
        parts: [
          { strong: "History compaction with Compress-Cache-Retrieve." },
          " Long conversations get deduplicated and truncated before dispatch, but only once a request is already big (default ~100,000 tokens) — a short exchange that merely repeats a small tool output is never touched. Nothing omitted is lost for good: it's cached locally and the model can pull it back on demand via a ",
          { code: "pool_retrieve" },
          " tool, capped at 3 retrieval rounds so a looping model can't ask forever.",
        ],
      },
      {
        tag: "NEW",
        parts: [
          { strong: "Optional RTK command compression." },
          " A PreToolUse hook shells out to the third-party ",
          { code: "rtk" },
          " CLI, if installed, to compress noisy Bash output before it reaches the model. Sidewrite never installs it for you and the hook is a silent no-op when it's absent.",
        ],
      },
      {
        tag: "NEW",
        parts: [
          { strong: "Studio → Tools dashboard tab." },
          " Toggle all three token-saving features live, see an install prompt when RTK isn't detected, view and clear the compaction retrieval cache, and find a link to the separate, recommended ",
          { code: "Ponytail" },
          " Claude Code plugin.",
        ],
      },
    ],
  },
  {
    version: "v0.2.1",
    date: "2026-07-06",
    beta: true,
    entries: [
      {
        tag: "FIX",
        parts: [
          { strong: "Cross-provider session history invisible to --resume." },
          " Other providers' transcripts were mirrored in with symlinks, but Claude Code's own session lister checks the raw on-disk type and never follows a link, so they silently never showed up in --resume. Switched to hard links (same inode, stays in sync, and passes the check) and self-repairs any leftover symlinks from the old code on next launch.",
        ],
      },
      {
        tag: "NEW",
        parts: [
          { strong: "Remote-config endpoint live." },
          " The force-update gate's version floor / kill switch now reads from a real hosted endpoint instead of failing open on an unconfigured host.",
        ],
      },
    ],
  },
  {
    version: "v0.2.0",
    date: "2026-07-06",
    beta: true,
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
    beta: true,
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
