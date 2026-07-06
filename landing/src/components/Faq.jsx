import { layout } from "../styles.js";
import { useIsMobile } from "../useIsMobile.js";
import { FAQ } from "../content.js";

const mono = "'IBM Plex Mono', monospace";

export default function Faq() {
  const m = useIsMobile();
  const s = layout(m);

  return (
    <section id="v3-faq" style={{ borderBottom: "1px solid #e5e3dd" }}>
      <div style={s.faqGrid}>
        <div style={{ display: "flex", alignItems: "baseline", gap: "20px" }}>
          <span style={{ fontFamily: mono, fontSize: "13px", color: "#e05a26" }}>/05</span>
          <h2 style={s.h2}>FAQ</h2>
        </div>
        <div>
          {FAQ.map((item, i) => (
            <details
              key={item.q}
              className="sw-faq"
              style={{
                borderTop: "1px solid #d9d6cf",
                borderBottom: i === FAQ.length - 1 ? "1px solid #d9d6cf" : undefined,
              }}
            >
              <summary
                style={{
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "space-between",
                  gap: "16px",
                  padding: "20px 2px",
                  fontSize: "16.5px",
                  fontWeight: 600,
                }}
              >
                {item.q}
                <span className="sw-plus" style={{ fontFamily: mono, color: "#e05a26" }} />
              </summary>
              <p
                style={{
                  fontSize: "14.5px",
                  lineHeight: 1.7,
                  color: "#5a6069",
                  margin: 0,
                  padding: "0 2px 22px",
                  textWrap: "pretty",
                }}
              >
                {item.a}
              </p>
            </details>
          ))}
        </div>
      </div>
    </section>
  );
}
