import { layout } from "../styles.js";
import { useIsMobile } from "../useIsMobile.js";
import { SAFETY_BADGES } from "../content.js";

const mono = "'IBM Plex Mono', monospace";

export default function Safety() {
  const m = useIsMobile();
  const s = layout(m);

  return (
    <section
      id="v3-safety"
      style={{ borderBottom: "1px solid #e5e3dd", background: "rgba(224,90,38,0.045)" }}
    >
      <div style={s.sectionPad}>
        <div style={{ display: "flex", alignItems: "baseline", gap: "20px", marginBottom: "24px" }}>
          <span style={{ fontFamily: mono, fontSize: "13px", color: "#e05a26" }}>/03</span>
          <h2 style={s.h2}>Safe by design</h2>
        </div>
        <p
          style={{
            fontSize: "17px",
            lineHeight: 1.7,
            color: "#5a6069",
            maxWidth: "680px",
            margin: "0 0 48px",
            textWrap: "pretty",
          }}
        >
          Your Claude subscription is only ever used the normal, interactive way — never
          proxied, never run headless. External providers run on{" "}
          <span style={{ color: "#16181c" }}>your own API keys</span> in a fully isolated
          environment, so nothing touches or logs out your Claude account.
        </p>
        <div style={s.safetyBadgeGrid}>
          {SAFETY_BADGES.map((badge) => (
            <div key={badge.code} style={{ borderLeft: "2px solid #e05a26", padding: "4px 0 4px 20px" }}>
              <div style={{ fontFamily: mono, fontSize: "13px", color: "#16181c", marginBottom: "6px" }}>
                {badge.code}
              </div>
              <div style={{ fontSize: "13.5px", lineHeight: 1.6, color: "#5a6069" }}>
                {badge.text}
              </div>
            </div>
          ))}
        </div>
      </div>
    </section>
  );
}
