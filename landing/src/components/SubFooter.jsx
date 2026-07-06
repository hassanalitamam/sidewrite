import { CURRENT_VERSION } from "../content.js";

const mono = "'IBM Plex Mono', monospace";

/**
 * Footer for the docs / changelog subpages. The changelog design prefixes the
 * meta line with the logo mark (`withLogo`); docs does not.
 */
export default function SubFooter({ m, maxWidth = 1280, withLogo = false }) {
  return (
    <footer
      style={{
        borderTop: "1px solid #e5e3dd",
        marginTop: withLogo ? 0 : "40px",
      }}
    >
      <div
        style={{
          maxWidth: `${maxWidth}px`,
          margin: "0 auto",
          padding: m ? "24px 18px" : "32px 36px",
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          gap: "16px",
          flexWrap: "wrap",
        }}
      >
        <div style={{ display: "flex", alignItems: "center", gap: "12px" }}>
          {withLogo && (
            <div
              style={{
                width: "22px",
                height: "22px",
                border: "1.5px solid #e05a26",
                display: "grid",
                placeItems: "center",
                fontFamily: mono,
                fontWeight: 600,
                fontSize: "11px",
                color: "#e05a26",
              }}
            >
              s/
            </div>
          )}
          <span style={{ fontFamily: mono, fontSize: "12.5px", color: "#878d96" }}>
            sidewrite · Apache-2.0 · {CURRENT_VERSION} · zero deps
          </span>
        </div>
        <a
          href="/"
          className="sw-footer-link"
          style={{
            fontFamily: mono,
            fontSize: "12.5px",
            color: "#5a6069",
            textDecoration: "none",
            whiteSpace: "nowrap",
          }}
        >
          ← back to home
        </a>
      </div>
    </footer>
  );
}
