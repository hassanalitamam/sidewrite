import { useCopy } from "./useCopy.js";
import { TAGLINE_OPTIONS } from "./content.js";
import Nav from "./components/Nav.jsx";
import Hero from "./components/Hero.jsx";
import Modes from "./components/Modes.jsx";
import Features from "./components/Features.jsx";
import Safety from "./components/Safety.jsx";
import Comparison from "./components/Comparison.jsx";
import Install from "./components/Install.jsx";
import Faq from "./components/Faq.jsx";
import Footer from "./components/Footer.jsx";

/**
 * Sidewrite Landing v3 (Light) — React port of the Claude Design page.
 *
 * Props mirror the design's editable controls:
 *   tagline        — hero headline (one of TAGLINE_OPTIONS, or any string)
 *   showComparison — toggles the "Why not…" comparison section
 */
export default function App({
  tagline = TAGLINE_OPTIONS[0],
  showComparison = true,
}) {
  const { copyLabel, copy } = useCopy();

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
      <Nav />
      <Hero tagline={tagline} copyLabel={copyLabel} onCopy={copy} />
      <Modes />
      <Features />
      <Safety />
      {showComparison && <Comparison />}
      <Install copyLabel={copyLabel} onCopy={copy} />
      <Faq />
      <Footer onCopy={copy} />
    </div>
  );
}
