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

const poolChip = {
  border: "1px solid #d9d6cf",
  padding: "4px 9px",
  fontFamily: mono,
  fontSize: "11px",
  color: "#5a6069",
  whiteSpace: "nowrap",
};
const poolArrow = { color: "#e05a26", fontSize: "18px", lineHeight: 1 };
const poolBox = {
  border: "1px solid #e05a26",
  color: "#16181c",
  fontFamily: mono,
  fontSize: "12px",
  fontWeight: 700,
  padding: "10px 16px",
  textAlign: "center",
};

const POOL_PROVIDERS = [
  "Z.ai",
  "Groq",
  "Cerebras",
  "GitHub Models",
  "OpenRouter free",
  "SambaNova",
  "Cloudflare",
  "NVIDIA NIM",
  "Gemini",
  "Mistral",
];

function PoolDiagram() {
  return (
    <div
      style={{
        display: "flex",
        alignItems: "center",
        gap: "14px",
        flexWrap: "wrap",
        marginTop: "20px",
        paddingTop: "20px",
        borderTop: "1px dashed #e5e3dd",
      }}
    >
      <div style={{ display: "flex", gap: "6px", flexWrap: "wrap", maxWidth: "360px" }}>
        {POOL_PROVIDERS.map((p) => (
          <span key={p} style={poolChip}>
            {p}
          </span>
        ))}
      </div>
      <span style={poolArrow}>→</span>
      <div style={poolBox}>
        pool router
        <div style={{ fontWeight: 400, color: "#5a6069", fontSize: "10.5px", marginTop: "2px" }}>
          tier-aware · sticky · budget-gated
        </div>
      </div>
      <span style={poolArrow}>→</span>
      <div style={poolBox}>your Claude Code</div>
    </div>
  );
}

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
      {feature.diagram ? <PoolDiagram /> : null}
    </div>
  );
}

export default function Features() {
  const m = useIsMobile();
  const s = layout(m);

  return (
    <section id="v3-features" style={{ borderBottom: "1px solid #e5e3dd" }}>
      <div style={s.sectionPad}>
        <div style={{ display: "flex", alignItems: "baseline", gap: "20px", marginBottom: "56px" }}>
          <span style={{ fontFamily: mono, fontSize: "13px", color: "#e05a26" }}>/02</span>
          <h2 style={s.h2}>Built for the gap</h2>
        </div>
        <div style={s.bentoGrid}>
          {/* Wide feature — providers */}
          <div style={s.bentoSpan}>
            <div>
              <div style={kickerStyle}>PROVIDERS</div>
              <h3 style={cardTitle}>Any provider, one click</h3>
              <p style={{ ...cardBody, maxWidth: "520px" }}>
                17 providers bundled, from 256 curated OpenRouter models to DeepSeek,
                GLM/Z.ai, and self-hosted Ollama, LM Studio, or vLLM — search, filter by
                vendor, paste a key; prices auto-fill. Or bring any base URL. The first
                model auto-activates.
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
              {PROVIDER_TAGS.map((tag) => (
                <span key={tag} style={{ border: "1px solid #d9d6cf", padding: "4px 10px" }}>
                  {tag}
                </span>
              ))}
            </div>
          </div>

          {FEATURES.map((feature) => (
            <FeatureCard key={feature.title} feature={feature} wide={feature.wide && !m} />
          ))}
        </div>
      </div>
    </section>
  );
}
