// Route helpers for the multi-page docs. The Overview lives at /docs/;
// every other section is its own /docs/<slug>.html page.

export function docHref(slug) {
  return slug === "index" ? "/docs/" : `/docs/${slug}.html`;
}

/** Derive the current section slug from a pathname. /docs/ → "index". */
export function slugFromPath(pathname) {
  const m = pathname.match(/\/docs\/([^/]+)\.html$/);
  if (m && m[1] !== "index") return m[1];
  return "index";
}
