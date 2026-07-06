import { layout } from "../styles.js";
import { useIsMobile } from "../useIsMobile.js";
import { COMPARISONS } from "../content.js";

const mono = "'IBM Plex Mono', monospace";

export default function Comparison() {
  const m = useIsMobile();
  const s = layout(m);

  return (
    <section style={{ borderBottom: "1px solid #e5e3dd" }}>
      <div style={s.sectionPad}>
        <div style={{ display: "flex", alignItems: "baseline", gap: "20px", marginBottom: "56px" }}>
          <span style={{ fontFamily: mono, fontSize: "13px", color: "#e05a26" }}>/04</span>
          <h2 style={s.h2}>Why not…</h2>
        </div>
        <div style={{ borderTop: "1px solid #d9d6cf" }}>
          {COMPARISONS.map((row) => (
            <div key={row.name} style={s.comparisonRow}>
              <div style={{ fontFamily: mono, fontSize: "14px", color: "#16181c" }}>{row.name}</div>
              <div style={{ fontSize: "15px", lineHeight: 1.65, color: "#5a6069" }}>{row.text}</div>
            </div>
          ))}
        </div>
      </div>
    </section>
  );
}
