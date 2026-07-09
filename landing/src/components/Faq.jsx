import { HOME_FAQ } from "../content.js";

const mono = "'IBM Plex Mono', monospace";

// List + full-FAQ link only — no section wrapper or heading. Mounted inside
// GetStarted.jsx, which owns the shared /03 chapter header for FAQ + Contact.
// Shows the 5 highest-value questions; everything else lives at
// /docs/faq.html, linked below rather than repeated here.
export default function FaqBlock() {
  return (
    <div>
      {HOME_FAQ.map((item, i) => (
        <details
          key={item.q}
          className="sw-faq"
          style={{
            borderTop: "1px solid #d9d6cf",
            borderBottom: i === HOME_FAQ.length - 1 ? "1px solid #d9d6cf" : undefined,
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
      <div style={{ padding: "20px 2px 0" }}>
        <a
          href="/docs/faq.html"
          className="sw-muted-link"
          style={{ fontFamily: mono, fontSize: "13px", color: "#5a6069", textDecoration: "none" }}
        >
          Full FAQ →
        </a>
      </div>
    </div>
  );
}
