const mono = "'IBM Plex Mono', monospace";
const linkBase = { color: "#5a6069", textDecoration: "none" };

/**
 * Sticky nav for the docs / changelog subpages: logo → home, a "back to home"
 * link, one sibling link, and the GitHub CTA. Faithful to the source designs,
 * which differ only in container width, backdrop opacity, and sibling target.
 */
export default function SubNav({ m, maxWidth = 1280, bgAlpha = 0.92, sibling }) {
  const navPad = {
    maxWidth: `${maxWidth}px`,
    margin: "0 auto",
    padding: m ? "14px 18px" : "16px 36px",
    display: "flex",
    alignItems: "center",
    justifyContent: "space-between",
    gap: m ? "16px" : "24px",
  };
  const navLinks = {
    display: "flex",
    alignItems: "center",
    gap: m ? "12px" : "30px",
    fontFamily: mono,
    fontSize: "12.5px",
  };

  return (
    <nav
      style={{
        position: "sticky",
        top: 0,
        zIndex: 50,
        background: `rgba(246,245,242,${bgAlpha})`,
        backdropFilter: "blur(12px)",
        borderBottom: "1px solid #e5e3dd",
      }}
    >
      <div style={navPad}>
        <a
          href="/"
          style={{
            display: "flex",
            alignItems: "center",
            gap: "12px",
            textDecoration: "none",
            color: "inherit",
          }}
        >
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
        </a>

        <div style={navLinks}>
          <a
            href="/"
            className="sw-navlink"
            style={{ ...linkBase, fontSize: m ? "18px" : "12.5px" }}
          >
            {m ? "←" : "← back to home"}
          </a>
          <a
            href={sibling.href}
            className="sw-navlink"
            style={{ ...linkBase, whiteSpace: "nowrap" }}
          >
            {sibling.label}
          </a>
          <a
            href="#"
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
            GitHub ↗
          </a>
        </div>
      </div>
    </nav>
  );
}
