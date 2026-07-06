import { DOCS_NAV } from "../content.js";
import { docHref } from "./paths.js";
import SubNav from "../components/SubNav.jsx";
import SubFooter from "../components/SubFooter.jsx";

const mono = "'IBM Plex Mono', monospace";

function Sidebar({ m, activeSlug }) {
  const inner = m
    ? { display: "flex", flexDirection: "row", gap: "28px", flexWrap: "nowrap" }
    : { display: "flex", flexDirection: "column", gap: "28px" };

  return (
    <aside
      style={
        m
          ? { position: "static", padding: "20px 0 8px", overflowX: "auto", borderBottom: "1px solid #e5e3dd" }
          : { position: "sticky", top: "73px", padding: "48px 0", alignSelf: "start" }
      }
    >
      <div style={inner}>
        {DOCS_NAV.map((group) => (
          <div key={group.label} style={m ? { flexShrink: 0 } : undefined}>
            <div
              style={{
                fontFamily: mono,
                fontSize: "11px",
                color: "#878d96",
                letterSpacing: "0.08em",
                textTransform: "uppercase",
                marginBottom: "10px",
                whiteSpace: "nowrap",
              }}
            >
              {group.label}
            </div>
            <div style={{ display: "flex", flexDirection: "column", gap: "2px" }}>
              {group.items.map((item) => {
                const isActive = item.slug === activeSlug;
                return (
                  <a
                    key={item.slug}
                    href={docHref(item.slug)}
                    className="sw-doc-link"
                    aria-current={isActive ? "page" : undefined}
                    style={{
                      display: "block",
                      textDecoration: "none",
                      fontSize: "14px",
                      padding: "7px 10px",
                      whiteSpace: "nowrap",
                      color: isActive ? "#16181c" : "#5a6069",
                      fontWeight: isActive ? 600 : 400,
                      background: isActive ? "rgba(224,90,38,0.08)" : "transparent",
                      borderLeft: isActive ? "2px solid #e05a26" : "2px solid transparent",
                    }}
                  >
                    {item.label}
                  </a>
                );
              })}
            </div>
          </div>
        ))}
      </div>
    </aside>
  );
}

/** Docs chrome shared by every section page. `children` is the page body. */
export default function DocsLayout({ m, activeSlug, children }) {
  const layoutStyle = {
    maxWidth: "1280px",
    margin: "0 auto",
    padding: m ? "0 18px" : "0 36px",
    display: "grid",
    gridTemplateColumns: m ? "1fr" : "250px 1fr",
    gap: m ? "0" : "64px",
    alignItems: "start",
  };
  const mainStyle = { padding: m ? "28px 0 88px" : "48px 0 120px", maxWidth: "760px" };

  return (
    <div
      style={{
        minHeight: "100vh",
        backgroundColor: "#f6f5f2",
        color: "#16181c",
        fontFamily: "'Archivo', sans-serif",
        WebkitFontSmoothing: "antialiased",
        // `clip` (not `hidden`) prevents horizontal overflow without turning
        // this into a scroll container — which would break the sticky sidebar.
        overflowX: "clip",
      }}
    >
      <SubNav m={m} maxWidth={1280} bgAlpha={0.92} sibling={{ label: "changelog", href: "/changelog.html" }} />
      <div style={layoutStyle}>
        <Sidebar m={m} activeSlug={activeSlug} />
        <main style={mainStyle}>{children}</main>
      </div>
      <SubFooter m={m} maxWidth={1280} />
    </div>
  );
}
