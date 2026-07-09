import { layout } from "../styles.js";
import { useIsMobile } from "../useIsMobile.js";
import SafetyBlock from "./Safety.jsx";
import ComparisonBlock from "./Comparison.jsx";

const mono = "'IBM Plex Mono', monospace";
const subHeading = {
  fontSize: "22px",
  fontWeight: 800,
  textTransform: "uppercase",
  letterSpacing: "-0.01em",
  margin: "0 0 28px",
};

// /02 chapter: Safety and Comparison used to be two separately-numbered
// sections doing the same job — convince, not inform. One trust chapter now.
export default function WhyTrustIt({ showComparison = true }) {
  const m = useIsMobile();
  const s = layout(m);

  return (
    <section id="v3-trust" style={{ borderBottom: "1px solid #e5e3dd", background: "rgba(224,90,38,0.045)" }}>
      <div style={s.sectionPad}>
        <div style={{ display: "flex", alignItems: "baseline", gap: "20px", marginBottom: "24px" }}>
          <span style={{ fontFamily: mono, fontSize: "13px", color: "#e05a26" }}>/02</span>
          <h2 style={s.h2}>Why trust it</h2>
        </div>

        <h3 style={subHeading}>Safe by design</h3>
        <SafetyBlock />

        {showComparison && (
          <div style={s.chapterDivider}>
            <h3 style={subHeading}>Why not…</h3>
            <ComparisonBlock />
          </div>
        )}
      </div>
    </section>
  );
}
