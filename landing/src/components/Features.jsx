import { layout } from "../styles.js";
import { useIsMobile } from "../useIsMobile.js";
import { FEATURES, PROVIDER_TAGS } from "../content.js";

const mono = "'IBM Plex Mono', monospace";

const kickerStyle = {
  fontFamily: mono,
  fontSize: "11.5px",
  color: "#e05a26",
  letterSpacing: "0.08em",
  marginBottom: "12px",
};
const cardTitle = { fontSize: "22px", fontWeight: 700, margin: "0 0 10px" };
const cardBody = {
  fontSize: "14.5px",
  lineHeight: 1.65,
  color: "#5a6069",
  margin: 0,
  textWrap: "pretty",
};

function FeatureCard({ feature, wide }) {
  return (
    <div
      style={{
        border: "1px solid #d9d6cf",
        background: "#ffffff",
        padding: "32px",
        ...(wide ? { gridColumn: "1 / -1" } : {}),
      }}
    >
      <div style={kickerStyle}>{feature.kicker}</div>
      <h3 style={cardTitle}>{feature.title}</h3>
      <p style={{ ...cardBody, ...(wide ? { maxWidth: "760px" } : {}) }}>{feature.body}</p>
    </div>
  );
}

const PROVIDER_SHOWN = 8;

// Grid only — no section wrapper or heading. Mounted inside HowItWorks.jsx,
// which owns the shared /01 chapter header for Modes + Features.
export default function FeaturesGrid() {
  const m = useIsMobile();
  const s = layout(m);
  const shownTags = PROVIDER_TAGS.slice(0, PROVIDER_SHOWN);
  const moreCount = PROVIDER_TAGS.length - PROVIDER_SHOWN;

  return (
    <div style={s.bentoGrid}>
      {/* Wide feature — providers */}
      <div style={s.bentoSpan}>
        <div>
          <div style={kickerStyle}>PROVIDERS</div>
          <h3 style={cardTitle}>Any provider, one click</h3>
          <p style={{ ...cardBody, maxWidth: "520px" }}>
            17 providers bundled — DeepSeek, GLM/Z.ai, Kimi, MiniMax, 256 curated
            OpenRouter models, and self-hosted Ollama, LM Studio, or vLLM — search,
            filter by vendor, paste a key, and prices auto-fill. Or bring any base URL;
            the first model auto-activates.
          </p>
        </div>
        <div
          style={{
            display: "flex",
            gap: "8px",
            flexWrap: "wrap",
            fontFamily: mono,
            fontSize: "11.5px",
            color: "#5a6069",
          }}
        >
          {shownTags.map((tag) => (
            <span key={tag} style={{ border: "1px solid #d9d6cf", padding: "4px 10px" }}>
              {tag}
            </span>
          ))}
          {moreCount > 0 && (
            <span style={{ border: "1px solid #e05a26", padding: "4px 10px", color: "#e05a26" }}>
              +{moreCount} more
            </span>
          )}
        </div>
      </div>

      {FEATURES.map((feature) => (
        <FeatureCard key={feature.title} feature={feature} wide={feature.wide && !m} />
      ))}
    </div>
  );
}
