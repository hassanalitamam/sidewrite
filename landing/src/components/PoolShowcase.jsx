import { useEffect, useRef, useState } from "react";
import { layout } from "../styles.js";
import { useIsMobile } from "../useIsMobile.js";

const mono = "'IBM Plex Mono', monospace";

// Kept in sync with plugin/data/pool-providers.json (9 providers, 197 models —
// Groq was dropped: every free-tier model there caps at a 6,000–30,000 TPM
// ceiling and its one high-budget model rejects tool-calling outright).
const POOL_PROVIDERS = [
  "Z.ai",
  "Cerebras",
  "GitHub Models",
  "OpenRouter free",
  "SambaNova",
  "Cloudflare",
  "NVIDIA NIM",
  "Gemini",
  "Mistral",
];

const poolChip = {
  border: "1px solid #d9d6cf",
  padding: "8px 14px",
  fontFamily: mono,
  fontSize: "12.5px",
  color: "#5a6069",
  whiteSpace: "nowrap",
  background: "#ffffff",
};
const poolArrow = { color: "#e05a26", fontSize: "22px", lineHeight: 1, flexShrink: 0 };
const poolBox = {
  border: "1px solid #e05a26",
  color: "#16181c",
  fontFamily: mono,
  fontSize: "13px",
  fontWeight: 700,
  padding: "14px 20px",
  textAlign: "center",
  flexShrink: 0,
};
const poolBoxSub = { fontWeight: 400, color: "#5a6069", fontSize: "11px", marginTop: "3px" };

// The page's signature visual: every free-tier provider pooled behind one
// router. Chips take a subtle highlight pass once scrolled into view (skipped
// entirely under prefers-reduced-motion via the .sw-pool-cycle rules in
// index.css) to make the "rotation" concept visible, not just described.
export default function PoolShowcase() {
  const m = useIsMobile();
  const s = layout(m);
  const ref = useRef(null);
  const [active, setActive] = useState(false);

  useEffect(() => {
    const el = ref.current;
    if (!el || typeof IntersectionObserver === "undefined") {
      setActive(true);
      return;
    }
    const obs = new IntersectionObserver(
      ([entry]) => {
        if (entry.isIntersecting) {
          setActive(true);
          obs.disconnect();
        }
      },
      { threshold: 0.4 }
    );
    obs.observe(el);
    return () => obs.disconnect();
  }, []);

  return (
    <div id="v3-pool" ref={ref} style={s.poolDiagramFull} className={active ? "sw-pool-cycle" : ""}>
      <div style={{ display: "flex", gap: "8px", flexWrap: "wrap", flex: 1 }}>
        {POOL_PROVIDERS.map((p) => (
          <span key={p} className="sw-pool-chip" style={poolChip}>
            {p}
          </span>
        ))}
      </div>
      <span style={poolArrow}>→</span>
      <div style={poolBox}>
        pool router
        <div style={poolBoxSub}>tier-aware · sticky · budget-gated</div>
      </div>
      <span style={poolArrow}>→</span>
      <div style={poolBox}>your Claude Code</div>
    </div>
  );
}
