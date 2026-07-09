import { layout } from "../styles.js";
import { useIsMobile } from "../useIsMobile.js";
import { MODES } from "../content.js";
import InlineCode from "./InlineCode.jsx";

const mono = "'IBM Plex Mono', monospace";

function Step({ index, content }) {
  return (
    <div
      style={{
        display: "flex",
        gap: "16px",
        padding: "16px 0",
        borderTop: "1px solid #e5e3dd",
      }}
    >
      <span style={{ fontFamily: mono, fontSize: "12px", color: "#e05a26" }}>
        {String(index + 1).padStart(2, "0")}
      </span>
      <span style={{ fontSize: "14.5px", lineHeight: 1.6, color: "#3a3f46" }}>
        {Array.isArray(content) ? (
          <>
            {content[0]}
            <InlineCode>{content[1]}</InlineCode>
            {content[2]}
          </>
        ) : (
          content
        )}
      </span>
    </div>
  );
}

function ModeCard({ mode }) {
  return (
    <div style={{ border: "1px solid #d9d6cf", background: "#ffffff", position: "relative" }}>
      <div
        style={{
          position: "absolute",
          top: "-1px",
          left: "-1px",
          background: mode.tagActive ? "#e05a26" : "#d9d6cf",
          color: mode.tagActive ? "#f6f5f2" : "#3a3f46",
          fontFamily: mono,
          fontSize: "11px",
          fontWeight: 600,
          padding: "5px 12px",
          letterSpacing: "0.06em",
        }}
      >
        {mode.tag}
      </div>
      <div style={{ padding: "56px 36px 36px" }}>
        <h3
          style={{
            fontSize: "26px",
            fontWeight: 800,
            textTransform: "uppercase",
            letterSpacing: "-0.01em",
            margin: "0 0 10px",
          }}
        >
          {mode.title}
        </h3>
        <p style={{ fontSize: "14.5px", color: "#5a6069", lineHeight: 1.6, margin: "0 0 28px" }}>
          {mode.blurb}
        </p>
        <div style={{ display: "flex", flexDirection: "column", gap: 0 }}>
          {mode.steps.map((content, i) => (
            <Step key={i} index={i} content={content} />
          ))}
        </div>
      </div>
    </div>
  );
}

// Grid only — no section wrapper or heading. Mounted inside HowItWorks.jsx,
// which owns the shared /01 chapter header for Modes + Features.
export default function ModesGrid() {
  const m = useIsMobile();
  const s = layout(m);

  return (
    <div style={s.twoColGrid}>
      {MODES.map((mode) => (
        <ModeCard key={mode.title} mode={mode} />
      ))}
    </div>
  );
}
