// format.js — pure formatters, no DOM. Every string the UI shows passes here.
export const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => (
  { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

export const fmtTime = (ts) => {
  const d = ts ? new Date(ts) : new Date();
  return d.toLocaleTimeString([], { hour12: false });
};

export const fmtNum = (n) => (Number(n) || 0).toLocaleString();

export const fmtUSD = (n) => "$" + (Number(n) || 0).toFixed(4);

// Compact per-1M price (verbatim from the current dashboard).
export const fmtPrice = (n) => {
  n = Number(n) || 0;
  if (n === 0) return "0";
  if (n >= 1) return n.toFixed(2);
  if (n >= 0.01) return n.toFixed(3).replace(/0+$/, "").replace(/\.$/, "");
  return n.toPrecision(2);
};

// worker == null / absent  =>  implicit worker 0 everywhere (contract-critical).
export function WK(w) { return (w == null) ? 0 : Number(w); }

// ---- cost display (Bug: $0/blank cost read as "broken" for unpriced providers) ----
// Some providers are legitimately UNPRICED (e.g. a plan-based provider with no
// per-token price configured) — token accounting stays exact but usd is 0.
// Without a per-row price/unpriced signal from the API, usd<=0 alongside
// tokens>0 is the best available heuristic for "unpriced" vs. a cell that
// simply hasn't loaded yet. Never fabricate a price — just label the state.
export function isUnpriced(usd, tokens) {
  return (Number(usd) || 0) <= 0 && (Number(tokens) || 0) > 0;
}

// HTML badge (mirrors the existing .badge visual language used elsewhere, e.g.
// the "~N% est." badge in analytics.js) — for call sites that splice raw HTML
// into innerHTML and do NOT re-escape the result afterward.
export function fmtCostBadge() {
  return '<span class="badge" style="color:var(--ink-muted);border-color:var(--border-obj)" title="' +
    esc("This provider has no per-token price configured, so cost cannot be computed. Token counts are still accurate.") +
    '">unpriced</span>';
}

// usd/tokens -> the real formatted cost when priced, else the unpriced badge.
export function fmtCost(usd, tokens) {
  return isUnpriced(usd, tokens) ? fmtCostBadge() : fmtUSD(usd);
}

// Plain-text variant for contexts where HTML can't render (SVG <title>, or a
// string that gets esc()'d again by the caller after this returns).
export function fmtCostText(usd, tokens) {
  return isUnpriced(usd, tokens) ? "unpriced" : fmtUSD(usd);
}
