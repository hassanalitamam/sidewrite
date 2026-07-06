import { useIsMobile } from "../useIsMobile.js";
import DocsLayout from "./DocsLayout.jsx";
import { SECTIONS, FLAT } from "./sections.jsx";
import { docHref } from "./paths.js";
import { CURRENT_VERSION } from "../content.js";

const mono = "'IBM Plex Mono', monospace";

function Pager({ prev, next }) {
  const cell = (s, dir) => (
    <a
      href={docHref(s.slug)}
      className="sw-pager-link"
      style={{
        flex: "1 1 0",
        minWidth: 0,
        display: "flex",
        flexDirection: "column",
        gap: "6px",
        border: "1px solid #e5e3dd",
        padding: "16px 18px",
        textDecoration: "none",
        textAlign: dir === "next" ? "right" : "left",
      }}
    >
      <span style={{ fontFamily: mono, fontSize: "11px", color: "#878d96", letterSpacing: "0.04em" }}>
        {dir === "next" ? "Next →" : "← Previous"}
      </span>
      <span className="sw-pager-title" style={{ fontSize: "15px", fontWeight: 600, color: "#16181c" }}>
        {s.label}
      </span>
    </a>
  );

  return (
    <nav
      style={{
        marginTop: "56px",
        paddingTop: "28px",
        borderTop: "1px solid #e5e3dd",
        display: "flex",
        gap: "16px",
      }}
    >
      {prev ? cell(prev, "prev") : <span style={{ flex: "1 1 0" }} />}
      {next ? cell(next, "next") : <span style={{ flex: "1 1 0" }} />}
    </nav>
  );
}

/** Renders a single docs section page for the given slug. */
export default function DocsApp({ slug }) {
  const m = useIsMobile(860);
  const section = SECTIONS[slug] || SECTIONS.index;
  const isIndex = section.slug === "index";

  const idx = FLAT.findIndex((s) => s.slug === section.slug);
  const prev = idx > 0 ? FLAT[idx - 1] : null;
  const next = idx < FLAT.length - 1 ? FLAT[idx + 1] : null;

  const Body = section.Body;
  const h1Style = {
    fontSize: m ? "34px" : isIndex ? "52px" : "44px",
    fontWeight: 900,
    letterSpacing: "-0.02em",
    textTransform: "uppercase",
    margin: "0 0 18px",
    lineHeight: 1.05,
  };

  return (
    <DocsLayout m={m} activeSlug={section.slug}>
      <div
        style={{
          fontFamily: mono,
          fontSize: "12px",
          color: "#e05a26",
          letterSpacing: "0.08em",
          marginBottom: "16px",
          textTransform: "uppercase",
        }}
      >
        {isIndex ? `Documentation · ${CURRENT_VERSION}` : section.group}
      </div>
      <h1 style={h1Style}>{isIndex ? "Docs" : section.label}</h1>
      <p style={{ fontSize: "17px", lineHeight: 1.65, color: "#5a6069", margin: "0 0 48px", textWrap: "pretty" }}>
        {section.lead}
      </p>

      <Body m={m} />

      <Pager prev={prev} next={next} />
    </DocsLayout>
  );
}
