// views/analytics.js — Analytics station (Plan Feature #4, flagship view).
//
// Consumes the daemon's query-on-read analytics API (all under Bearer auth via
// api()), exactly as implemented in plugin/scripts/viewer-daemon.cjs:
//   GET /api/analytics/summary?from&to               -> { ok, from, to, summary }
//   GET /api/analytics/timeseries?from&to             -> { ok, from, to, series: [...] }
//   GET /api/analytics/breakdown?by=&from&to           -> { ok, from, to, by, rows: [...] }
// `by` is one of: model | provider | agent | worker | session | project (server
// allowlist BREAKDOWN_COLUMNS). This view surfaces model | provider | agent |
// project (the four the spec calls out) with `model` as the flagship default.
//
// `from`/`to` are epoch-ms; the daemon defaults to a 30d window when omitted.
// summary/timeseries/breakdown rows share the same cost-aggregate shape:
//   { tokens_in, tokens_out, cache_read, cache_create, usd, entries, estimated_entries }
// (breakdown rows additionally carry `key`; summary additionally carries
// `runs`, `providers`, `models`).
//
// ---- Wiring contract for the router/main.js pass (this file changes nothing
// shared) ----
// This module owns ONE container end-to-end: everything is rendered into
//   <div id="analyticsRoot"></div>
// The wiring pass only needs to, in viewer.html:
//   1. Add a tab button:  <button class="tab" data-page="analytics"><svg class="icon"><use href="#ic-cost"/></svg>Analytics</button>
//   2. Add a page section: <section id="pageAnalytics" hidden><div id="analyticsRoot"></div></section>
// ...and in config.js/router.js/main.js:
//   3. config.js:  PAGES.analytics = "pageAnalytics"
//   4. router.js:  import { enterAnalytics } from "./views/analytics.js";
//                  in showPage(): toggle `#pageAnalytics` hidden like the others,
//                  and `if (page === "analytics") enterAnalytics();`
//   5. main.js:    import { wireAnalytics } from "./views/analytics.js"; call
//                  wireAnalytics() once at boot (alongside wireSkills()).
//
// Exported view interface (mirrors views/skills.js's enter()/render() pair):
//   enterAnalytics()  — router calls this on tab activation (load-if-stale + render)
//   renderAnalytics() — pure re-render from current in-memory state
//   wireAnalytics()   — one-time event delegation setup (call once at boot)

import { $, icon } from "../dom.js";
import { esc, fmtNum, fmtCost, fmtCostText } from "../format.js";
import { api } from "../api.js";
import { toast } from "../components/toast.js";

// ---- local view state (this module owns it; nothing else reads/writes it) ----
const RANGES = [
  { key: "7d", label: "7d", ms: 7 * 24 * 60 * 60 * 1000 },
  { key: "30d", label: "30d", ms: 30 * 24 * 60 * 60 * 1000 },
  { key: "all", label: "All time", ms: null },
];
const DIMS = [
  { key: "model", label: "Model" },
  { key: "provider", label: "Provider" },
  { key: "agent", label: "Agent" },
  { key: "project", label: "Project" },
];
const COLS = [
  { key: "key", label: "Name" },
  { key: "tokens_in", label: "Tokens In" },
  { key: "tokens_out", label: "Tokens Out" },
  { key: "cache_read", label: "Cache Read" },
  { key: "cache_create", label: "Cache Create" },
  { key: "total", label: "Total Tok" },
  { key: "usd", label: "Cost" },
  { key: "entries", label: "Entries" },
];

const analyticsState = {
  range: "30d",
  dim: "model",
  sortKey: "usd",
  sortDir: "desc",
  loading: false,
  loaded: false,
  error: null,
  summary: null,   // { tokens_in, tokens_out, cache_read, cache_create, usd, entries, estimated_entries, runs, providers, models }
  series: [],       // [{ day, tokens_in, tokens_out, cache_read, cache_create, usd, entries, estimated_entries }]
  breakdown: [],    // [{ key, tokens_in, tokens_out, cache_read, cache_create, usd, entries, estimated_entries }]
};

function rangeBounds(key) {
  const to = Date.now();
  if (key === "all") return { from: 0, to };
  const opt = RANGES.find((r) => r.key === key);
  const ms = (opt && opt.ms) || RANGES[1].ms;
  return { from: to - ms, to };
}

// ---- data load ----
export async function loadAnalytics() {
  analyticsState.loading = true;
  analyticsState.error = null;
  renderAnalytics();
  const { from, to } = rangeBounds(analyticsState.range);
  const qs = "?from=" + from + "&to=" + to;
  try {
    const [sumR, serR, bkR] = await Promise.allSettled([
      api("/api/analytics/summary" + qs),
      api("/api/analytics/timeseries" + qs),
      api("/api/analytics/breakdown?by=" + encodeURIComponent(analyticsState.dim) + "&from=" + from + "&to=" + to),
    ]);
    analyticsState.summary = (sumR.status === "fulfilled" && sumR.value && sumR.value.summary) || {};
    analyticsState.series = (serR.status === "fulfilled" && Array.isArray(serR.value && serR.value.series)) ? serR.value.series : [];
    analyticsState.breakdown = (bkR.status === "fulfilled" && Array.isArray(bkR.value && bkR.value.rows)) ? bkR.value.rows : [];
    if (sumR.status === "rejected" && serR.status === "rejected" && bkR.status === "rejected") {
      throw new Error((sumR.reason && sumR.reason.message) || "load failed");
    }
  } catch (err) {
    analyticsState.error = err.message || String(err);
    toast("Analytics load failed: " + analyticsState.error, "err");
  } finally {
    analyticsState.loading = false;
    analyticsState.loaded = true;
    renderAnalytics();
  }
}

// Router enter hook: load once, then just re-render on subsequent tab switches
// (the in-page refresh control forces a reload).
export function enterAnalytics() {
  if (!analyticsState.loaded && !analyticsState.loading) loadAnalytics();
  else renderAnalytics();
}

// ---- breakdown re-fetch (range/dim change without a full reload flicker) ----
async function reloadBreakdownOnly() {
  const { from, to } = rangeBounds(analyticsState.range);
  try {
    const r = await api("/api/analytics/breakdown?by=" + encodeURIComponent(analyticsState.dim) + "&from=" + from + "&to=" + to);
    analyticsState.breakdown = (r && Array.isArray(r.rows)) ? r.rows : [];
  } catch (err) {
    toast("Breakdown load failed: " + err.message, "err");
    analyticsState.breakdown = [];
  }
  renderAnalytics();
}

// ---- helpers ----
function n0(v) { return Number(v) || 0; }
function rowTotal(r) { return n0(r.tokens_in) + n0(r.tokens_out) + n0(r.cache_read) + n0(r.cache_create); }
function estPct(r) {
  const e = n0(r.entries);
  return e > 0 ? (n0(r.estimated_entries) / e) * 100 : 0;
}
function estBadge(r, label) {
  const pct = estPct(r);
  if (pct <= 0) return "";
  const shown = pct < 1 ? "<1" : Math.round(pct);
  return '<span class="badge" style="color:var(--ink-muted);border-color:var(--border-obj)" title="' +
    esc(n0(r.estimated_entries) + " of " + n0(r.entries) + " " + (label || "entries") + " are estimated (usage not exact — no provider-reported token counts)") +
    '">~' + shown + '% est.</span>';
}

// ---- KPI cards ----
function kpiHTML(s) {
  const cards = [
    { label: "Tokens In", val: fmtNum(s.tokens_in) },
    { label: "Tokens Out", val: fmtNum(s.tokens_out) },
    { label: "Cache Read", val: fmtNum(s.cache_read) },
    { label: "Cache Create", val: fmtNum(s.cache_create) },
    { label: "Total Cost", val: fmtCost(s.usd, rowTotal(s)), accent: true },
  ];
  const cardsHTML = cards.map((c) =>
    '<div class="card" style="padding:14px 16px;">' +
      '<div style="font-size:11px;letter-spacing:.04em;text-transform:uppercase;color:var(--ink-muted);margin-bottom:6px;">' + esc(c.label) + "</div>" +
      '<div style="font-size:22px;font-weight:600;' + (c.accent ? "color:var(--accent);" : "color:var(--ink);") + '">' + c.val + "</div>" +
    "</div>"
  ).join("");
  const estRow = estBadge(s, "cost entries");
  const meta = fmtNum(s.runs) + " run" + (n0(s.runs) === 1 ? "" : "s") + " · " +
    fmtNum(s.providers) + " provider" + (n0(s.providers) === 1 ? "" : "s") + " · " +
    fmtNum(s.models) + " model" + (n0(s.models) === 1 ? "" : "s") + " · " +
    fmtNum(s.entries) + " cost entries";
  return '<div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(140px,1fr));gap:10px;margin-bottom:14px;">' + cardsHTML + "</div>" +
    '<div style="display:flex;align-items:center;gap:8px;flex-wrap:wrap;color:var(--ink-muted);font-size:12.5px;margin-bottom:20px;">' +
      "<span>" + meta + "</span>" + (estRow ? estRow : "") +
    "</div>";
}

// ---- inline SVG: daily trend (rect volume bars + polyline cost overlay) ----
function trendSVG(series) {
  if (!series.length) return emptyBox("No cost activity in this range.");
  const W = 720, H = 190, padL = 8, padR = 8, padT = 10, padB = 22;
  const plotW = W - padL - padR, plotH = H - padT - padB;
  const nDays = series.length;
  const vols = series.map((d) => n0(d.tokens_in) + n0(d.tokens_out) + n0(d.cache_read) + n0(d.cache_create));
  const costs = series.map((d) => n0(d.usd));
  const maxVol = Math.max(1, ...vols);
  const maxCost = Math.max(0.0001, ...costs);
  const slot = plotW / nDays;
  const bw = Math.max(2, slot * 0.55);

  const bars = series.map((d, i) => {
    const x = padL + i * slot + (slot - bw) / 2;
    const h = (vols[i] / maxVol) * plotH;
    const y = padT + plotH - h;
    return '<rect x="' + x.toFixed(1) + '" y="' + y.toFixed(1) + '" width="' + bw.toFixed(1) + '" height="' + Math.max(0, h).toFixed(1) +
      '" style="fill:var(--accent-soft);stroke:var(--border-obj);stroke-width:.5">' +
      "<title>" + esc(d.day) + " — " + fmtNum(vols[i]) + " tokens</title></rect>";
  }).join("");

  const pts = series.map((d, i) => {
    const x = padL + i * slot + slot / 2;
    const y = padT + plotH - (costs[i] / maxCost) * plotH;
    return [x, y];
  });
  const line = '<polyline points="' + pts.map((p) => p[0].toFixed(1) + "," + p[1].toFixed(1)).join(" ") +
    '" style="fill:none;stroke:var(--accent);stroke-width:2" />';
  const dots = series.map((d, i) => {
    const [x, y] = pts[i];
    return '<circle cx="' + x.toFixed(1) + '" cy="' + y.toFixed(1) + '" r="2.8" style="fill:var(--accent)">' +
      "<title>" + esc(d.day) + " — " + esc(fmtCostText(costs[i], vols[i])) + "</title></circle>";
  }).join("");

  const labelIdxs = nDays <= 6 ? series.map((_, i) => i) : [0, Math.floor((nDays - 1) / 2), nDays - 1];
  const labels = labelIdxs.map((i) => {
    const x = padL + i * slot + slot / 2;
    return '<text x="' + x.toFixed(1) + '" y="' + (H - 4) + '" text-anchor="middle" style="font-size:9px;fill:var(--ink-muted)">' +
      esc(series[i].day) + "</text>";
  }).join("");

  return '<svg viewBox="0 0 ' + W + " " + H + '" style="width:100%;height:auto;display:block" role="img" aria-label="Daily token volume and cost trend">' +
    '<line x1="' + padL + '" y1="' + (padT + plotH) + '" x2="' + (W - padR) + '" y2="' + (padT + plotH) + '" style="stroke:var(--border-obj);stroke-width:1"/>' +
    bars + line + dots + labels +
    "</svg>";
}

// ---- inline SVG: stacked token-type composition per day ----
function stackedSVG(series) {
  if (!series.length) return emptyBox("No token activity in this range.");
  const W = 720, H = 130, padL = 8, padR = 8, padT = 8, padB = 8;
  const plotW = W - padL - padR, plotH = H - padT - padB;
  const nDays = series.length;
  const slot = plotW / nDays;
  const bw = Math.max(2, slot * 0.55);
  const types = [
    { k: "tokens_in", color: "var(--accent)", label: "Tokens In" },
    { k: "tokens_out", color: "var(--accent-hi)", label: "Tokens Out" },
    { k: "cache_read", color: "var(--ok)", label: "Cache Read" },
    { k: "cache_create", color: "var(--ink-muted)", label: "Cache Create" },
  ];
  const vols = series.map((d) => n0(d.tokens_in) + n0(d.tokens_out) + n0(d.cache_read) + n0(d.cache_create));
  const maxVol = Math.max(1, ...vols);

  const bars = series.map((d, i) => {
    const x = padL + i * slot + (slot - bw) / 2;
    let yCursor = padT + plotH;
    let segs = "";
    for (const t of types) {
      const v = n0(d[t.k]);
      const h = (v / maxVol) * plotH;
      if (h <= 0) continue;
      yCursor -= h;
      segs += '<rect x="' + x.toFixed(1) + '" y="' + yCursor.toFixed(1) + '" width="' + bw.toFixed(1) + '" height="' + h.toFixed(1) +
        '" style="fill:' + t.color + '"><title>' + esc(d.day) + " — " + t.label + ": " + fmtNum(v) + "</title></rect>";
    }
    return segs;
  }).join("");

  const legend = types.map((t) =>
    '<span style="display:inline-flex;align-items:center;gap:5px;margin-right:14px;font-size:12px;color:var(--ink-body)">' +
      '<span style="width:9px;height:9px;display:inline-block;background:' + t.color + '"></span>' + esc(t.label) +
    "</span>"
  ).join("");

  return '<svg viewBox="0 0 ' + W + " " + H + '" style="width:100%;height:auto;display:block" role="img" aria-label="Daily token type composition">' +
    bars +
    "</svg>" +
    '<div style="margin-top:8px;display:flex;flex-wrap:wrap;">' + legend + "</div>";
}

function emptyBox(msg) {
  return '<div style="padding:28px 10px;text-align:center;color:var(--ink-muted);font-size:13px;">' + esc(msg) + "</div>";
}

// ---- per-dimension breakdown bars (cost-ranked) ----
function breakdownBarsHTML(rows, dimLabel) {
  if (!rows.length) return emptyBox("No " + esc(dimLabel).toLowerCase() + " activity in this range.");
  const maxUsd = Math.max(0.0001, ...rows.map((r) => n0(r.usd)));
  return rows.map((r) => {
    const label = r.key == null || r.key === "" ? "(unknown)" : String(r.key);
    const pct = Math.max(1.5, (n0(r.usd) / maxUsd) * 100);
    return '<div style="display:grid;grid-template-columns:140px 1fr 90px;align-items:center;gap:10px;margin-bottom:7px;">' +
      '<div style="font-size:12.5px;color:var(--ink);white-space:nowrap;overflow:hidden;text-overflow:ellipsis;" title="' + esc(label) + '">' + esc(label) + "</div>" +
      '<div style="background:var(--bg-sub);border:1px solid var(--border-obj);height:16px;position:relative;">' +
        '<div style="height:100%;width:' + pct.toFixed(1) + '%;background:var(--accent);"></div>' +
      "</div>" +
      '<div style="font-size:12.5px;text-align:right;color:var(--ink-body);white-space:nowrap;">' + fmtCost(r.usd, rowTotal(r)) + "</div>" +
    "</div>";
  }).join("");
}

// ---- sortable per-dimension table ----
function sortedBreakdown() {
  const rows = analyticsState.breakdown.slice();
  const key = analyticsState.sortKey, dir = analyticsState.sortDir === "asc" ? 1 : -1;
  rows.sort((a, b) => {
    let av, bv;
    if (key === "key") { av = String(a.key ?? ""); bv = String(b.key ?? ""); return av.localeCompare(bv) * dir; }
    if (key === "total") { av = rowTotal(a); bv = rowTotal(b); }
    else { av = n0(a[key]); bv = n0(b[key]); }
    return (av - bv) * dir;
  });
  return rows;
}

function breakdownTableHTML() {
  const rows = sortedBreakdown();
  if (!rows.length) return "";
  const head = COLS.map((c) => {
    const active = analyticsState.sortKey === c.key;
    const arrow = active ? (analyticsState.sortDir === "asc" ? " ▲" : " ▼") : "";
    return '<th data-sort="' + esc(c.key) + '" style="cursor:pointer;user-select:none;white-space:nowrap;' +
      (active ? "color:var(--accent);" : "") + '">' + esc(c.label) + arrow + "</th>";
  }).join("");
  const body = rows.map((r) => {
    const label = r.key == null || r.key === "" ? "(unknown)" : String(r.key);
    const est = estBadge(r);
    return "<tr>" +
      '<td style="max-width:220px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;" title="' + esc(label) + '">' + esc(label) + "</td>" +
      "<td>" + fmtNum(r.tokens_in) + "</td>" +
      "<td>" + fmtNum(r.tokens_out) + "</td>" +
      "<td>" + fmtNum(r.cache_read) + "</td>" +
      "<td>" + fmtNum(r.cache_create) + "</td>" +
      "<td>" + fmtNum(rowTotal(r)) + "</td>" +
      '<td style="font-weight:600;">' + fmtCost(r.usd, rowTotal(r)) + "</td>" +
      "<td>" + fmtNum(r.entries) + (est ? " " + est : "") + "</td>" +
    "</tr>";
  }).join("");
  return '<div class="tablewrap"><table style="width:100%;border-collapse:collapse;font-size:12.5px;">' +
    "<thead><tr>" + head + "</tr></thead><tbody>" + body + "</tbody></table></div>";
}

// ---- range + dimension selector controls ----
function controlsHTML() {
  const rangeBtns = RANGES.map((r) =>
    '<button data-range="' + r.key + '" aria-pressed="' + (analyticsState.range === r.key ? "true" : "false") + '" style="' +
      "padding:6px 12px;border:1px solid var(--border-obj);background:" + (analyticsState.range === r.key ? "var(--accent-soft)" : "var(--surface)") +
      ";color:" + (analyticsState.range === r.key ? "var(--accent)" : "var(--ink-body)") + ";cursor:pointer;font:inherit;font-size:12.5px;" +
    '">' + esc(r.label) + "</button>"
  ).join("");
  const dimBtns = DIMS.map((d) =>
    '<button data-dim="' + d.key + '" aria-pressed="' + (analyticsState.dim === d.key ? "true" : "false") + '" style="' +
      "padding:6px 12px;border:1px solid var(--border-obj);background:" + (analyticsState.dim === d.key ? "var(--accent-soft)" : "var(--surface)") +
      ";color:" + (analyticsState.dim === d.key ? "var(--accent)" : "var(--ink-body)") + ";cursor:pointer;font:inherit;font-size:12.5px;" +
    '">' + esc(d.label) + "</button>"
  ).join("");
  return '<div style="display:flex;align-items:center;justify-content:space-between;flex-wrap:wrap;gap:14px;margin-bottom:16px;">' +
    '<div style="display:flex;gap:0;">' + rangeBtns + "</div>" +
    '<button data-refresh="1" style="display:inline-flex;align-items:center;gap:6px;padding:6px 12px;border:1px solid var(--border-obj);background:var(--surface);color:var(--ink-body);cursor:pointer;font:inherit;font-size:12.5px;">' +
      icon("refresh", "sm") + "Refresh</button>" +
  "</div>" +
  '<div style="display:flex;align-items:center;gap:10px;flex-wrap:wrap;margin-bottom:8px;">' +
    '<span style="font-size:12px;color:var(--ink-muted);">Breakdown by</span>' +
    '<div style="display:flex;gap:0;">' + dimBtns + "</div>" +
  "</div>";
}

function sectionHTML(title, bodyHTML) {
  return '<div class="card" style="padding:16px 18px;margin-bottom:16px;">' +
    '<div style="font-size:13px;font-weight:600;color:var(--ink);margin-bottom:12px;">' + esc(title) + "</div>" +
    bodyHTML +
  "</div>";
}

// ---- top-level render ----
export function renderAnalytics() {
  const root = $("#analyticsRoot");
  if (!root) return;

  if (analyticsState.loading && !analyticsState.loaded) {
    root.innerHTML = '<div style="padding:40px 10px;text-align:center;color:var(--ink-muted);">Loading analytics…</div>';
    return;
  }
  if (analyticsState.error && !analyticsState.loaded) {
    root.innerHTML = '<div style="padding:40px 10px;text-align:center;color:var(--err);">Failed to load analytics: ' + esc(analyticsState.error) + "</div>";
    return;
  }

  const s = analyticsState.summary || {};
  const dimLabel = (DIMS.find((d) => d.key === analyticsState.dim) || {}).label || "Model";

  root.innerHTML =
    controlsHTML() +
    kpiHTML(s) +
    sectionHTML("Daily trend — token volume &amp; cost", trendSVG(analyticsState.series)) +
    sectionHTML("Token type composition", stackedSVG(analyticsState.series)) +
    sectionHTML(dimLabel + " — cost breakdown", breakdownBarsHTML(analyticsState.breakdown.slice().sort((a, b) => n0(b.usd) - n0(a.usd)), dimLabel)) +
    sectionHTML(dimLabel + " — detail", breakdownTableHTML() || emptyBox("No " + dimLabel.toLowerCase() + " activity in this range."));
}

// ---- one-time event delegation (call once at boot, alongside wireSkills()) ----
export function wireAnalytics() {
  const root = $("#analyticsRoot");
  if (!root) return;
  root.addEventListener("click", (e) => {
    const rangeBtn = e.target.closest("[data-range]");
    if (rangeBtn) {
      const key = rangeBtn.dataset.range;
      if (key && key !== analyticsState.range) {
        analyticsState.range = key;
        loadAnalytics();
      }
      return;
    }
    const dimBtn = e.target.closest("[data-dim]");
    if (dimBtn) {
      const key = dimBtn.dataset.dim;
      if (key && key !== analyticsState.dim) {
        analyticsState.dim = key;
        analyticsState.sortKey = "usd";
        analyticsState.sortDir = "desc";
        reloadBreakdownOnly();
      }
      return;
    }
    const refreshBtn = e.target.closest("[data-refresh]");
    if (refreshBtn) { loadAnalytics(); return; }

    const th = e.target.closest("[data-sort]");
    if (th) {
      const key = th.dataset.sort;
      if (analyticsState.sortKey === key) {
        analyticsState.sortDir = analyticsState.sortDir === "asc" ? "desc" : "asc";
      } else {
        analyticsState.sortKey = key;
        analyticsState.sortDir = key === "key" ? "asc" : "desc";
      }
      renderAnalytics();
    }
  });
}
