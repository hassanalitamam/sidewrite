import { layout } from "../styles.js";
import { useIsMobile } from "../useIsMobile.js";
import { useGithubStars, formatStars } from "../useGithubStars.js";
import { GITHUB_URL } from "../content.js";

const mono = "'IBM Plex Mono', monospace";
const linkBase = { color: "#5a6069", textDecoration: "none" };

function GithubLink() {
  const stars = useGithubStars();
  return (
    <a
      href={GITHUB_URL}
      target="_blank"
      rel="noopener noreferrer"
      className="sw-navlink"
      style={{
        ...linkBase,
        display: "inline-flex",
        alignItems: "center",
        gap: "6px",
        whiteSpace: "nowrap",
      }}
    >
      <svg width="16" height="16" viewBox="0 0 16 16" fill="currentColor" aria-hidden="true">
        <path d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27.68 0 1.36.09 2 .27 1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.01 8.01 0 0 0 16 8c0-4.42-3.58-8-8-8Z" />
      </svg>
      {stars != null && <span style={{ fontFamily: mono, fontSize: "12px" }}>★ {formatStars(stars)}</span>}
    </a>
  );
}

export default function Nav() {
  const m = useIsMobile();
  const s = layout(m);

  return (
    <nav
      style={{
        position: "sticky",
        top: 0,
        zIndex: 50,
        background: "rgba(246,245,242,0.88)",
        backdropFilter: "blur(12px)",
        borderBottom: "1px solid #e5e3dd",
      }}
    >
      <div style={s.navPad}>
        <div style={{ display: "flex", alignItems: "center", gap: "12px" }}>
          <div
            style={{
              width: "30px",
              height: "30px",
              border: "1.5px solid #e05a26",
              display: "grid",
              placeItems: "center",
              fontFamily: mono,
              fontWeight: 600,
              fontSize: "15px",
              color: "#e05a26",
            }}
          >
            s/
          </div>
          {!m && (
            <span
              style={{
                fontWeight: 800,
                fontSize: "16px",
                letterSpacing: "0.06em",
                textTransform: "uppercase",
              }}
            >
              Sidewrite
            </span>
          )}
          <span
            style={{
              fontFamily: mono,
              fontSize: "10px",
              fontWeight: 600,
              letterSpacing: "0.05em",
              color: "#e05a26",
              border: "1px solid #e05a26",
              padding: "2px 6px",
            }}
          >
            BETA
          </span>
        </div>

        <div style={s.navLinks}>
          {!m && (
            <a href="#v3-how" className="sw-navlink" style={linkBase}>
              how it works
            </a>
          )}
          {!m && (
            <a href="#v3-trust" className="sw-navlink" style={linkBase}>
              why trust it
            </a>
          )}
          {!m && (
            <a href="#v3-faq" className="sw-navlink" style={linkBase}>
              faq
            </a>
          )}
          {!m && (
            <a href="#v3-contact" className="sw-navlink" style={linkBase}>
              contact
            </a>
          )}
          <a
            href="/docs/"
            className="sw-navlink"
            style={{ ...linkBase, whiteSpace: "nowrap" }}
          >
            docs
          </a>
          {!m && (
            <a
              href="/changelog.html"
              className="sw-navlink"
              style={{ ...linkBase, whiteSpace: "nowrap" }}
            >
              changelog
            </a>
          )}
          <GithubLink />
          <a
            href="#v3-install"
            className="sw-cta"
            style={{
              color: "#f6f5f2",
              background: "#e05a26",
              textDecoration: "none",
              fontWeight: 600,
              padding: "9px 18px",
              whiteSpace: "nowrap",
            }}
          >
            install →
          </a>
        </div>
      </div>
    </nav>
  );
}
