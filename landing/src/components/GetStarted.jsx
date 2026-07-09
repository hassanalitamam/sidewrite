import { layout } from "../styles.js";
import { useIsMobile } from "../useIsMobile.js";
import FaqBlock from "./Faq.jsx";
import ContactBlock from "./Contact.jsx";

const mono = "'IBM Plex Mono', monospace";
const subHeading = {
  fontSize: "22px",
  fontWeight: 800,
  textTransform: "uppercase",
  letterSpacing: "-0.01em",
  margin: "0 0 28px",
  textAlign: "center",
};

// /03 chapter: FAQ and Contact used to be two separately-numbered sections
// at the tail of the page. Both are "what's left before you commit" —
// one chapter now, FAQ trimmed to the 5 highest-value questions (the rest
// live at /docs/faq.html).
export default function GetStarted() {
  const m = useIsMobile();
  const s = layout(m);

  return (
    <section style={{ borderBottom: "1px solid #e5e3dd" }}>
      <div style={s.sectionPad}>
        <div style={{ display: "flex", alignItems: "baseline", gap: "20px", marginBottom: "56px" }}>
          <span style={{ fontFamily: mono, fontSize: "13px", color: "#e05a26" }}>/03</span>
          <h2 style={s.h2}>Get started</h2>
        </div>

        <div id="v3-faq" style={{ maxWidth: "760px", margin: "0 auto" }}>
          <FaqBlock />
        </div>

        <div id="v3-contact" style={s.chapterDivider}>
          <h3 style={subHeading}>Get in touch</h3>
          <ContactBlock />
        </div>
      </div>
    </section>
  );
}
