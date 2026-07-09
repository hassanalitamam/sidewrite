import { layout } from "../styles.js";
import { useIsMobile } from "../useIsMobile.js";
import ModesGrid from "./Modes.jsx";
import FeaturesGrid from "./Features.jsx";
import PoolShowcase from "./PoolShowcase.jsx";

const mono = "'IBM Plex Mono', monospace";
const subHeading = {
  fontSize: "22px",
  fontWeight: 800,
  textTransform: "uppercase",
  letterSpacing: "-0.01em",
  margin: "0 0 28px",
};

// /01 chapter: Modes and Features used to be two separately-numbered
// sections that told the same story in two halves — how you'd use Sidewrite,
// then what it does once you have. One chapter, two labeled sub-blocks.
export default function HowItWorks() {
  const m = useIsMobile();
  const s = layout(m);

  return (
    <section id="v3-how" style={{ borderBottom: "1px solid #e5e3dd" }}>
      <div style={s.sectionPad}>
        <div style={{ display: "flex", alignItems: "baseline", gap: "20px", marginBottom: "56px" }}>
          <span style={{ fontFamily: mono, fontSize: "13px", color: "#e05a26" }}>/01</span>
          <h2 style={s.h2}>How it works</h2>
        </div>

        <h3 style={subHeading}>Two modes. One switch.</h3>
        <ModesGrid />

        <div style={s.chapterDivider}>
          <h3 style={subHeading}>Built for the gap</h3>
          <FeaturesGrid />
          <PoolShowcase />
        </div>
      </div>
    </section>
  );
}
