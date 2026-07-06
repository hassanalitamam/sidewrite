import { useIsMobile } from "./useIsMobile.js";
import { CHANGELOG, GITHUB_URL } from "./content.js";
import SubNav from "./components/SubNav.jsx";
import SubFooter from "./components/SubFooter.jsx";
import RichText from "./components/RichText.jsx";

const mono = "'IBM Plex Mono', monospace";

// Tag pill palette. Falls back to the neutral gray treatment.
const TAG_COLORS = {
  NEW: { color: "#1f9d63", border: "#1f9d63" },
  FIX: { color: "#5a6069", border: "#cfccc4" },
  SEC: { color: "#5a6069", border: "#cfccc4" },
  v1: { color: "#e05a26", border: "#e05a26" },
};

function TagPill({ tag }) {
  const c = TAG_COLORS[tag] || TAG_COLORS.FIX;
  return (
    <span
      style={{
        fontFamily: mono,
        fontSize: "10px",
        color: c.color,
        border: `1px solid ${c.border}`,
        padding: "2px 7px",
        height: "19px",
        flexShrink: 0,
        marginTop: "2px",
      }}
    >
      {tag}
    </span>
  );
}

function Entry({ release, m }) {
  const gray = "2px solid #d9d6cf";
  const orange = "2px solid #e05a26";
  const linePad = m ? "2px 0 32px 24px" : "2px 0 48px 40px";
  const lastPad = m ? "2px 0 8px 24px" : "2px 0 8px 40px";

  const lineStyle = {
    borderLeft: release.accent ? orange : gray,
    padding: release.last ? lastPad : linePad,
    position: "relative",
  };
  const dotStyle = release.accent
    ? {
        position: "absolute",
        left: "-7px",
        top: "6px",
        width: "12px",
        height: "12px",
        borderRadius: "50%",
        background: "#e05a26",
        border: "2px solid #f6f5f2",
      }
    : {
        position: "absolute",
        left: "-6px",
        top: "6px",
        width: "10px",
        height: "10px",
        borderRadius: "50%",
        background: "#b7b3aa",
        border: "2px solid #f6f5f2",
      };

  return (
    <>
      <div style={{ padding: m ? "0 0 8px" : "0 0 12px" }}>
        <div style={{ display: "inline-flex", alignItems: "center", gap: "9px" }}>
          <span style={{ fontFamily: mono, fontSize: "20px", fontWeight: 600, color: "#16181c" }}>
            {release.version}
          </span>
          {release.latest && (
            <span
              style={{
                fontFamily: mono,
                fontSize: "10px",
                fontWeight: 600,
                color: "#f6f5f2",
                background: "#e05a26",
                padding: "2px 7px",
                letterSpacing: "0.04em",
              }}
            >
              LATEST
            </span>
          )}
        </div>
        <div style={{ fontFamily: mono, fontSize: "12px", color: "#878d96", marginTop: "8px" }}>
          {release.date}
        </div>
      </div>

      <div style={lineStyle}>
        <span style={dotStyle} />
        <ul
          style={{
            margin: 0,
            padding: 0,
            listStyle: "none",
            display: "flex",
            flexDirection: "column",
            gap: "12px",
          }}
        >
          {release.entries.map((entry, i) => (
            <li
              key={i}
              style={{
                display: "flex",
                gap: "14px",
                fontSize: "15.5px",
                lineHeight: 1.55,
                color: "#3a3f46",
              }}
            >
              <TagPill tag={entry.tag} />
              <span>
                <RichText parts={entry.parts} />
              </span>
            </li>
          ))}
        </ul>
      </div>
    </>
  );
}

export default function Changelog() {
  const m = useIsMobile(720);

  const wrap = { maxWidth: "1080px", margin: "0 auto" };
  const h1Style = {
    fontSize: m ? "42px" : "80px",
    lineHeight: 0.98,
    fontWeight: 900,
    letterSpacing: "-0.025em",
    textTransform: "uppercase",
    margin: "0 0 20px",
  };
  const timelineGrid = {
    display: "grid",
    gridTemplateColumns: m ? "1fr" : "210px 1fr",
    gap: m ? "0" : "0 48px",
  };

  return (
    <div
      style={{
        minHeight: "100vh",
        backgroundColor: "#f6f5f2",
        backgroundImage:
          "linear-gradient(rgba(15,17,20,0.045) 1px, transparent 1px), linear-gradient(90deg, rgba(15,17,20,0.045) 1px, transparent 1px)",
        backgroundSize: "56px 56px",
        color: "#16181c",
        fontFamily: "'Archivo', sans-serif",
        WebkitFontSmoothing: "antialiased",
        // `clip` (not `hidden`) prevents horizontal overflow without turning
        // this into a scroll container — which would break the sticky nav.
        overflowX: "clip",
      }}
    >
      <SubNav
        m={m}
        maxWidth={1080}
        bgAlpha={0.88}
        sibling={{ label: "docs", href: "/docs/" }}
      />

      <header style={{ borderBottom: "1px solid #e5e3dd" }}>
        <div style={{ ...wrap, padding: m ? "48px 20px 40px" : "88px 36px 72px" }}>
          <div
            style={{
              fontFamily: mono,
              fontSize: "12px",
              color: "#e05a26",
              letterSpacing: "0.08em",
              marginBottom: "24px",
            }}
          >
            RELEASES · APACHE-2.0 · NO TELEMETRY
          </div>
          <h1 style={h1Style}>Changelog</h1>
          <p
            style={{
              fontSize: "18px",
              lineHeight: 1.65,
              color: "#5a6069",
              maxWidth: "560px",
              margin: 0,
              textWrap: "pretty",
            }}
          >
            Every release, in the open. Current version{" "}
            <span style={{ fontFamily: mono, fontSize: "16px", color: "#16181c" }}>v0.1.0</span> —
            zero dependencies, built on Node built-ins.
          </p>
        </div>
      </header>

      <section>
        <div style={{ ...wrap, padding: m ? "40px 20px 64px" : "72px 36px 112px" }}>
          <div style={timelineGrid}>
            {CHANGELOG.map((release) => (
              <Entry key={release.version} release={release} m={m} />
            ))}
          </div>

          <div
            style={{
              marginTop: "40px",
              paddingTop: "28px",
              borderTop: "1px solid #e5e3dd",
              display: "flex",
              alignItems: "center",
              justifyContent: "space-between",
              gap: "20px",
              flexWrap: "wrap",
            }}
          >
            <span style={{ fontFamily: mono, fontSize: "13px", color: "#5a6069" }}>
              Follow releases on GitHub — every change is public.
            </span>
            <a
              href={`${GITHUB_URL}/commits`}
              target="_blank"
              rel="noopener noreferrer"
              className="sw-ghost-btn"
              style={{
                fontFamily: mono,
                fontSize: "13px",
                color: "#16181c",
                textDecoration: "none",
                border: "1px solid #cfccc4",
                padding: "10px 18px",
              }}
            >
              full history ↗
            </a>
          </div>
        </div>
      </section>

      <SubFooter m={m} maxWidth={1080} withLogo />
    </div>
  );
}
