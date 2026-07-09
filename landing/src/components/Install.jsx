import { layout } from "../styles.js";
import { useIsMobile } from "../useIsMobile.js";
import { INSTALL_CMD, INSTALL_CHIPS } from "../content.js";

const mono = "'IBM Plex Mono', monospace";

// Unnumbered — a bridge between chapters, not a chapter of its own. The Hero
// already carries the primary install moment and explanation; this repeats
// only the ask (copyable command), at a fraction of the height.
export default function Install({ copyLabel, onCopy }) {
  const m = useIsMobile();
  const s = layout(m);

  return (
    <section id="v3-install" style={{ borderBottom: "1px solid #e5e3dd", background: "#ffffff" }}>
      <div style={s.installBarOuter}>
        <div
          onClick={onCopy}
          className="sw-copy"
          style={{
            display: "inline-flex",
            alignItems: "center",
            gap: "16px",
            fontFamily: mono,
            fontSize: m ? "15px" : "17px",
            border: "1px solid #e05a26",
            background: "rgba(224,90,38,0.05)",
            padding: m ? "14px 20px" : "16px 26px",
            cursor: "pointer",
          }}
        >
          <span style={{ color: "#e05a26", userSelect: "none" }}>$</span>
          <span style={{ whiteSpace: "nowrap" }}>{INSTALL_CMD}</span>
          <span style={{ color: "#e05a26", fontSize: "12px", minWidth: "46px", textAlign: "right" }}>
            {copyLabel}
          </span>
        </div>
        <div
          style={{
            display: "flex",
            justifyContent: "center",
            gap: "8px",
            flexWrap: "wrap",
            marginTop: "18px",
            fontFamily: mono,
            fontSize: "11.5px",
            color: "#878d96",
          }}
        >
          {INSTALL_CHIPS.map((chip) => (
            <span key={chip} style={{ border: "1px solid #e5e3dd", padding: "4px 10px" }}>
              {chip}
            </span>
          ))}
        </div>
      </div>
    </section>
  );
}
