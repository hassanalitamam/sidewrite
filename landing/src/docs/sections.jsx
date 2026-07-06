import { DOCS_NAV, DOCS_PROVIDERS, DOCS_COMMANDS, FAQ } from "../content.js";
import { docHref } from "./paths.js";
import InlineCode from "../components/InlineCode.jsx";

const mono = "'IBM Plex Mono', monospace";

// Shared prose styles, mirroring the source design.
const p = { fontSize: "15.5px", lineHeight: 1.7, color: "#3a3f46", margin: 0, textWrap: "pretty" };
const p20 = { ...p, margin: "0 0 20px" };
const p12 = { ...p, margin: "0 0 12px" };
const cardStyle = { border: "1px solid #e5e3dd", background: "#ffffff", padding: "22px" };

function Terminal({ children }) {
  return (
    <div
      style={{
        border: "1px solid #262b33",
        background: "#16181c",
        padding: "18px 22px",
        fontFamily: mono,
        fontSize: "14.5px",
        color: "#eef0f3",
        display: "flex",
        alignItems: "center",
        gap: "12px",
        margin: "0 0 20px",
      }}
    >
      <span style={{ color: "#878d96" }}>$</span>
      <span>{children}</span>
    </div>
  );
}

function Table({ cols, rows }) {
  return (
    <div style={{ border: "1px solid #e5e3dd", overflow: "hidden" }}>
      {rows.map((row, i) => (
        <div
          key={i}
          style={{
            display: "grid",
            gridTemplateColumns: cols,
            padding: "14px 20px",
            background: "#ffffff",
            borderBottom: i === rows.length - 1 ? undefined : "1px solid #e5e3dd",
          }}
        >
          {row}
        </div>
      ))}
    </div>
  );
}

// ── Section bodies ───────────────────────────────────────────────────────────

function OverviewBody() {
  const cards = FLAT.filter((s) => s.slug !== "index");
  return (
    <div
      style={{
        display: "grid",
        gridTemplateColumns: "repeat(auto-fill, minmax(240px, 1fr))",
        gap: "16px",
      }}
    >
      {cards.map((s) => (
        <a
          key={s.slug}
          href={docHref(s.slug)}
          className="sw-doc-card"
          style={{
            ...cardStyle,
            display: "flex",
            flexDirection: "column",
            gap: "8px",
            textDecoration: "none",
            color: "inherit",
          }}
        >
          <div style={{ fontFamily: mono, fontSize: "10.5px", color: "#878d96", letterSpacing: "0.08em", textTransform: "uppercase" }}>
            {s.group}
          </div>
          <div style={{ fontSize: "16.5px", fontWeight: 700, letterSpacing: "-0.01em" }}>{s.label}</div>
          <div style={{ fontSize: "13.5px", lineHeight: 1.5, color: "#5a6069", flex: 1 }}>{s.blurb}</div>
          <div style={{ fontFamily: mono, fontSize: "12px", color: "#e05a26", marginTop: "4px" }}>Read →</div>
        </a>
      ))}
    </div>
  );
}

function QuickstartBody() {
  return (
    <>
      <p style={p20}>Install once as a Claude Code plugin — it works globally, in every project.</p>
      <Terminal>npx sidewrite install</Terminal>
      <p style={p}>
        On first run, pick a mode — <strong style={{ fontWeight: 700 }}>Subscription</strong> if you
        have Claude, <strong style={{ fontWeight: 700 }}>Standalone</strong> if you don't. The choice
        persists; switch anytime with <InlineCode>sidewrite mode</InlineCode>.
      </p>
    </>
  );
}

function TwoModesBody({ m }) {
  return (
    <>
      <div
        style={{
          display: "grid",
          gridTemplateColumns: m ? "1fr" : "1fr 1fr",
          gap: "16px",
          marginBottom: "20px",
        }}
      >
        <div style={cardStyle}>
          <div style={{ fontFamily: mono, fontSize: "11px", color: "#e05a26", marginBottom: "8px" }}>SUBSCRIPTION</div>
          <p style={{ ...p, fontSize: "14.5px", lineHeight: 1.6 }}>
            Plan &amp; review with interactive Claude. Delegate implementation to a provider via{" "}
            <InlineCode>/sidewrite-delegate</InlineCode>.
          </p>
        </div>
        <div style={cardStyle}>
          <div style={{ fontFamily: mono, fontSize: "11px", color: "#5a6069", marginBottom: "8px" }}>STANDALONE</div>
          <p style={{ ...p, fontSize: "14.5px", lineHeight: 1.6 }}>
            <InlineCode>sidewrite code</InlineCode> launches interactive Claude Code directly on your
            own model.
          </p>
        </div>
      </div>
      <p style={p}>
        Both modes stream the same <InlineCode>plan → implement → review</InlineCode> pipeline to the
        local dashboard.
      </p>
    </>
  );
}

function ProvidersBody() {
  return (
    <>
      <p style={p20}>
        Sidewrite ships a bundled catalog of 256 Anthropic-compatible OpenRouter models — tool-use +
        text only. Browse and select with no network or key; a key is only needed to run.
      </p>
      <Table
        cols="1fr 2fr"
        rows={DOCS_PROVIDERS.map((row) => (
          <>
            <div style={{ fontFamily: mono, fontSize: "13px", fontWeight: 600 }}>{row.name}</div>
            <div style={{ fontSize: "13.5px", color: "#5a6069" }}>{row.desc}</div>
          </>
        ))}
      />
    </>
  );
}

function DelegationBody() {
  return (
    <>
      <p style={p12}>
        No hand-written PLAN.md. Claude reads the conversation and writes a concise brief, then hands
        off — trigger with <InlineCode>/sidewrite-delegate</InlineCode> or by saying{" "}
        <em>"implement this with Sidewrite."</em>
      </p>
      <p style={p}>
        Only the brief crosses to the provider — never your raw transcript. The provider works
        headless in an isolated git worktree; Claude reviews the diff when it's done.
      </p>
    </>
  );
}

function FailoverBody() {
  return (
    <>
      <p style={p12}>
        A preflight credit check on OpenRouter catches "out of credit" before wasting a run. If a
        provider fails for any reason — no credit, bad key, rate limit, model unavailable, timeout —
        Sidewrite tries the next provider automatically.
      </p>
      <p style={p}>
        A watchdog kills hung providers. If every provider fails, you get a clean handback telling
        you exactly what to do next.
      </p>
    </>
  );
}

function DashboardBody() {
  const views = [
    "Pipeline — provider activity, per-model cost in tokens and USD, and an event/memory log, live over SSE.",
    "Analytics — per-model, provider, agent, and project cost breakdowns with time-series charts.",
    "Health — system status at a glance.",
    "Budgets — monthly/per-run spend caps with warn/exceeded alerts.",
    "Privacy — a plain-language view of what's stored locally, and a one-click data purge.",
  ];
  return (
    <>
      <p style={p12}>
        A local dashboard at <InlineCode>http://127.0.0.1:1510</InlineCode> covers five views:
      </p>
      <ul style={{ margin: "0 0 20px", padding: 0, listStyle: "none", display: "flex", flexDirection: "column", gap: "10px" }}>
        {views.map((node, i) => (
          <li key={i} style={{ display: "flex", gap: "12px", fontSize: "14.5px", color: "#3a3f46" }}>
            <span style={{ color: "#e05a26" }}>—</span>
            <span>{node}</span>
          </li>
        ))}
      </ul>
      <p style={p}>
        Open it anytime with <InlineCode>/sidewrite-open</InlineCode>.
      </p>
    </>
  );
}

function SafetyBody() {
  const items = [
    <>
      No OAuth proxying, no headless subscription runs. The runner refuses{" "}
      <code style={{ fontFamily: mono, fontSize: "12.5px" }}>api.anthropic.com</code> and scrubs its
      environment.
    </>,
    "Dashboard binds to 127.0.0.1 only, with a bearer token + host/origin guard.",
    "Provider keys are stored in 0600 files and never returned by any read API.",
  ];
  return (
    <>
      <p style={p20}>
        Your Claude subscription is only ever used interactively, by you. External sessions run in an
        isolated <InlineCode>CLAUDE_CONFIG_DIR</InlineCode>, so your login is never touched.
      </p>
      <ul style={{ margin: 0, padding: 0, listStyle: "none", display: "flex", flexDirection: "column", gap: "10px" }}>
        {items.map((node, i) => (
          <li key={i} style={{ display: "flex", gap: "12px", fontSize: "14.5px", color: "#3a3f46" }}>
            <span style={{ color: "#e05a26" }}>—</span>
            <span>{node}</span>
          </li>
        ))}
      </ul>
    </>
  );
}

function CommandsBody({ m }) {
  return (
    <Table
      cols={m ? "150px 1fr" : "200px 1fr"}
      rows={DOCS_COMMANDS.map((row) => (
        <>
          <code style={{ fontFamily: mono, fontSize: "13px", color: "#e05a26" }}>{row.cmd}</code>
          <span style={{ fontSize: "13.5px", color: "#5a6069" }}>{row.desc}</span>
        </>
      ))}
    />
  );
}

function FaqBody() {
  return (
    <div>
      {FAQ.map((item, i) => (
        <details
          key={item.q}
          className="sw-faq"
          style={{
            borderTop: "1px solid #d9d6cf",
            borderBottom: i === FAQ.length - 1 ? "1px solid #d9d6cf" : undefined,
          }}
        >
          <summary
            style={{
              display: "flex",
              alignItems: "center",
              justifyContent: "space-between",
              gap: "16px",
              padding: "18px 2px",
              fontSize: "16px",
              fontWeight: 600,
            }}
          >
            {item.q}
            <span className="sw-plus" style={{ fontFamily: mono, color: "#e05a26" }} />
          </summary>
          <p style={{ fontSize: "14.5px", lineHeight: 1.7, color: "#5a6069", margin: 0, padding: "0 2px 20px", textWrap: "pretty" }}>
            {item.a}
          </p>
        </details>
      ))}
    </div>
  );
}

// ── Assembly ─────────────────────────────────────────────────────────────────

// Flat, ordered list of every section (drives the sidebar and prev/next pager).
export const FLAT = DOCS_NAV.flatMap((g) => g.items.map((i) => ({ ...i, group: g.label })));

// Per-slug metadata: the short lead shown under the page title, and the body.
const META = {
  index: { lead: "Everything you need to run Claude Code on any Anthropic-compatible model — plan on Claude, implement anywhere.", Body: OverviewBody },
  quickstart: { lead: "Get from zero to a working install in one command.", Body: QuickstartBody },
  "two-modes": { lead: "One switch decides where the work runs — the pipeline stays the same.", Body: TwoModesBody },
  providers: { lead: "Bring any Anthropic-compatible model: bundled, custom, or local.", Body: ProvidersBody },
  delegation: { lead: "Hand off implementation without ever writing a plan file.", Body: DelegationBody },
  failover: { lead: "Every provider failure falls through to the next, automatically.", Body: FailoverBody },
  dashboard: { lead: "Watch the plan → implement → review pipeline in real time.", Body: DashboardBody },
  safety: { lead: "Your subscription is only ever used interactively, by you.", Body: SafetyBody },
  commands: { lead: "The full command surface for the CLI and Claude Code.", Body: CommandsBody },
  faq: { lead: "Short answers to the questions people ask most.", Body: FaqBody },
};

// slug → full section descriptor { slug, label, group, blurb, lead, Body }
export const SECTIONS = Object.fromEntries(
  FLAT.map((f) => [f.slug, { ...f, ...META[f.slug] }])
);
