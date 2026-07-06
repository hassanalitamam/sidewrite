import { layout } from "../styles.js";
import { useIsMobile } from "../useIsMobile.js";
import { INSTALL_CMD, INSTALL_CHIPS } from "../content.js";

const mono = "'IBM Plex Mono', monospace";

export default function Install({ copyLabel, onCopy }) {
  const m = useIsMobile();
  const s = layout(m);

  return (
    <section id="v3-install" style={{ borderBottom: "1px solid #e5e3dd", background: "#ffffff" }}>
      <div style={s.installOuter}>
        <h2 style={s.installH2}>One command</h2>
        <p style={{ fontSize: "16px", color: "#5a6069", margin: "0 0 40px" }}>
          Installs as a Claude Code plugin, globally — works in every project.
        </p>
        <div
          onClick={onCopy}
          className="sw-copy"
          style={{
            display: "inline-flex",
            alignItems: "center",
            gap: "16px",
            fontFamily: mono,
            fontSize: "19px",
            border: "1px solid #e05a26",
            background: "rgba(224,90,38,0.05)",
            padding: "20px 32px",
            cursor: "pointer",
          }}
        >
          <span style={{ color: "#e05a26", userSelect: "none" }}>$</span>
          <span style={{ whiteSpace: "nowrap" }}>{INSTALL_CMD}</span>
          <span style={{ color: "#e05a26", fontSize: "13px", minWidth: "50px", textAlign: "right" }}>
            {copyLabel}
          </span>
        </div>
        <div
          style={{
            display: "flex",
            justifyContent: "center",
            gap: "8px",
            flexWrap: "wrap",
            marginTop: "32px",
            fontFamily: mono,
            fontSize: "12px",
            color: "#878d96",
          }}
        >
          {INSTALL_CHIPS.map((chip) => (
            <span key={chip} style={{ border: "1px solid #e5e3dd", padding: "5px 12px" }}>
              {chip}
            </span>
          ))}
        </div>
      </div>
    </section>
  );
}
