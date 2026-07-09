import { layout } from "../styles.js";
import { useIsMobile } from "../useIsMobile.js";
import { HERO, STATS, INSTALL_CMD } from "../content.js";

const mono = "'IBM Plex Mono', monospace";

function TerminalSession() {
  return (
    <div
      style={{
        border: "1px solid #2a3038",
        background: "#14171c",
        boxShadow: "0 32px 64px -24px rgba(20,23,28,0.35)",
        animation: "sw-rise 0.6s 0.2s ease both",
      }}
    >
      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: "10px",
          padding: "12px 18px",
          borderBottom: "1px solid #232830",
        }}
      >
        <span style={{ fontFamily: mono, fontSize: "12px", color: "#5f6772" }}>
          claude — session
        </span>
        <span
          style={{
            marginLeft: "auto",
            fontFamily: mono,
            fontSize: "11px",
            color: "#5f6772",
          }}
        >
          ⌥ dashboard: 127.0.0.1:1510
        </span>
      </div>
      <div
        style={{
          padding: "22px 20px",
          fontFamily: mono,
          fontSize: "13px",
          lineHeight: 1.85,
        }}
      >
        <div style={{ color: "#ff7040" }}>
          ⚠ Claude usage limit reached — resets in 4d 12h
        </div>
        <div style={{ color: "#5f6772", marginTop: "10px" }}>
          ⏺ Switching to Free-Tier Pool…{" "}
          <span style={{ color: "#52d494" }}>done</span>
        </div>
        <div style={{ color: "#5f6772" }}>
          ⏺ Preflight <span style={{ color: "#eef0f3" }}>z-ai/glm-5.2</span> —{" "}
          <span style={{ color: "#52d494" }}>free tier · budget ok</span>
        </div>
        <div style={{ color: "#5f6772" }}>
          ⏺ Session continued — <span style={{ color: "#eef0f3" }}>same context, new model</span>
        </div>
        <div style={{ color: "#52d494", marginTop: "10px" }}>
          ▸ implement — running on GLM-5.2
          <span style={{ animation: "sw-blink 1s step-end infinite" }}>▌</span>
        </div>
        <div
          style={{
            display: "flex",
            gap: "18px",
            marginTop: "16px",
            paddingTop: "14px",
            borderTop: "1px dashed #2a3038",
            fontSize: "12px",
          }}
        >
          <span style={{ color: "#5f6772" }}>
            tokens <span style={{ color: "#eef0f3" }}>38.4k</span>
          </span>
          <span style={{ color: "#5f6772" }}>
            cost <span style={{ color: "#eef0f3" }}>$0.00</span>
          </span>
          <span style={{ color: "#5f6772" }}>
            files <span style={{ color: "#eef0f3" }}>12</span>
          </span>
          <span
            style={{
              marginLeft: "auto",
              color: "#52d494",
              animation: "sw-pulse 2s infinite",
            }}
          >
            ● live
          </span>
        </div>
      </div>
    </div>
  );
}

function StatsStrip({ m }) {
  const s = layout(m);
  return (
    <div style={{ borderTop: "1px solid #e5e3dd", background: "rgba(255,255,255,0.65)" }}>
      <div style={s.statsGrid}>
        {STATS.map((stat, i) => (
          <div
            key={stat.label}
            style={{
              padding: "24px 0",
              borderLeft: "1px solid #e5e3dd",
              borderRight: i === STATS.length - 1 ? "1px solid #e5e3dd" : undefined,
              paddingLeft: "28px",
            }}
          >
            <div style={{ fontSize: "30px", fontWeight: 800, letterSpacing: "-0.02em" }}>
              {stat.value}
            </div>
            <div
              style={{
                fontFamily: mono,
                fontSize: "11.5px",
                color: "#878d96",
                marginTop: "2px",
              }}
            >
              {stat.label}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

export default function Hero({ tagline, copyLabel, onCopy }) {
  const m = useIsMobile();
  const s = layout(m);

  return (
    <header
      style={{
        borderBottom: "1px solid #e5e3dd",
        position: "relative",
        overflow: "hidden",
      }}
    >
      <div
        style={{
          position: "absolute",
          top: "-140px",
          right: "-100px",
          width: "640px",
          height: "640px",
          background: "radial-gradient(circle, rgba(224,90,38,0.07), transparent 62%)",
          pointerEvents: "none",
        }}
      />
      <div style={s.heroGrid}>
        <div>
          <div
            style={{
              display: "inline-flex",
              alignItems: "center",
              gap: "10px",
              fontFamily: mono,
              fontSize: "12px",
              color: "#5a6069",
              border: "1px solid #d9d6cf",
              padding: "7px 14px",
              marginBottom: "32px",
              animation: "sw-rise 0.5s ease both",
            }}
          >
            <span style={{ color: "#e05a26" }}>●</span> {HERO.badge}
          </div>
          <h1 style={s.h1}>{tagline}</h1>
          <p
            style={{
              fontSize: "18px",
              lineHeight: 1.65,
              color: "#5a6069",
              maxWidth: "480px",
              margin: "0 0 40px",
              textWrap: "pretty",
              animation: "sw-rise 0.5s 0.1s ease both",
            }}
          >
            {HERO.subtitle}
          </p>
          <div
            style={{
              display: "flex",
              alignItems: "center",
              gap: "14px",
              flexWrap: "wrap",
              animation: "sw-rise 0.5s 0.15s ease both",
            }}
          >
            <div
              onClick={onCopy}
              className="sw-copy"
              style={{
                display: "flex",
                alignItems: "center",
                gap: "12px",
                fontFamily: mono,
                fontSize: "14.5px",
                border: "1px solid #e05a26",
                color: "#16181c",
                padding: "15px 22px",
                cursor: "pointer",
                background: "rgba(224,90,38,0.05)",
              }}
            >
              <span style={{ color: "#e05a26", userSelect: "none" }}>$</span>
              <span style={{ whiteSpace: "nowrap" }}>{INSTALL_CMD}</span>
              <span
                style={{
                  color: "#e05a26",
                  fontSize: "12px",
                  minWidth: "46px",
                  textAlign: "right",
                }}
              >
                {copyLabel}
              </span>
            </div>
            <a
              href="#v3-how"
              className="sw-muted-link"
              style={{
                fontFamily: mono,
                fontSize: "13px",
                color: "#5a6069",
                textDecoration: "none",
                padding: "15px 6px",
              }}
            >
              see the pipeline ↓
            </a>
          </div>
        </div>

        <TerminalSession />
      </div>

      <StatsStrip m={m} />
    </header>
  );
}
