import { INSTALL_CMD, CURRENT_VERSION, GITHUB_URL, AUTHOR } from "../content.js";

const mono = "'IBM Plex Mono', monospace";

export default function Footer({ onCopy }) {
  return (
    <footer>
      <div
        style={{
          maxWidth: "1240px",
          margin: "0 auto",
          padding: "36px",
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          gap: "24px",
          flexWrap: "wrap",
        }}
      >
        <div style={{ display: "flex", alignItems: "center", gap: "12px" }}>
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
          <span style={{ fontFamily: mono, fontSize: "12.5px", color: "#878d96" }}>
            sidewrite · Apache-2.0 · {CURRENT_VERSION} · zero deps
          </span>
        </div>
        <div style={{ display: "flex", alignItems: "center", gap: "22px", fontFamily: mono, fontSize: "12.5px" }}>
          <span
            onClick={onCopy}
            className="sw-footer-link"
            style={{ color: "#5a6069", cursor: "pointer", whiteSpace: "nowrap" }}
          >
            {INSTALL_CMD}
          </span>
          <a
            href={GITHUB_URL}
            target="_blank"
            rel="noopener noreferrer"
            className="sw-footer-link"
            style={{ color: "#5a6069", textDecoration: "none", whiteSpace: "nowrap" }}
          >
            GitHub ↗
          </a>
        </div>
      </div>
      <div
        style={{
          borderTop: "1px solid #e5e3dd",
          padding: "16px 36px 28px",
          textAlign: "center",
          fontFamily: mono,
          fontSize: "11px",
          color: "#b7b3aa",
        }}
      >
        © {new Date().getFullYear()} {AUTHOR.name} · {AUTHOR.email} · Discord: {AUTHOR.discord}
      </div>
    </footer>
  );
}
