import { layout } from "../styles.js";
import { useIsMobile } from "../useIsMobile.js";
import { COMPARISONS } from "../content.js";

const mono = "'IBM Plex Mono', monospace";

// Rows only — no section wrapper or heading. Mounted inside WhyTrustIt.jsx,
// which owns the shared /02 chapter header for Safety + Comparison.
export default function ComparisonBlock() {
  const s = layout(useIsMobile());

  return (
    <div style={{ borderTop: "1px solid #d9d6cf" }}>
      {COMPARISONS.map((row) => (
        <div key={row.name} style={s.comparisonRow}>
          <div style={{ fontFamily: mono, fontSize: "14px", color: "#16181c" }}>{row.name}</div>
          <div style={{ fontSize: "15px", lineHeight: 1.65, color: "#5a6069" }}>
            {row.text}
            {row.link && (
              <>
                {" "}
                <a
                  href={row.link.href}
                  style={{ color: "#e05a26", textDecoration: "underline", fontFamily: mono, fontSize: "13px" }}
                >
                  {row.link.label}
                </a>
              </>
            )}
          </div>
        </div>
      ))}
    </div>
  );
}
