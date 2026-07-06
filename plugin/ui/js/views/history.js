// views/history.js — the run-history BROWSER, embedded at the bottom of the Runs
// page (#runsHistory). Formerly a standalone "History" tab; folded into Runs so a
// single tab shows live delegations on top + keyset-paginated history below.
//
// This module owns ONLY the list/browser (project filter + keyset pagination +
// "Load more"). It keeps its own local model and rehydrates from REST, so it
// survives a hard refresh with no SSE replay. Drilling into a row opens the
// UNIFIED run detail owned by views/runs.js (openRun) — the same detail used for
// live runs, now carrying Files / Diff / Re-run (see runs.js). The live "Now
// running" list is rendered by runs.js above us, so we deliberately do NOT render
// a running block of our own.
import { $, icon } from "../dom.js";
import { esc, fmtNum, fmtCostText } from "../format.js";
import { api } from "../api.js";
import { toast } from "../components/toast.js";
import { openRun } from "../router.js";

// ---- local state ----
const h = {
  project: "",           // '' = all projects (?project= param)
  projects: [],          // GET /api/projects rows
  projectsLoaded: false,
  recent: [],            // GET /api/runs?limit=&cursor= accumulated rows (any status)
  cursor: null,          // opaque nextCursor for the next /api/runs page
  hasMore: false,
  recentOpen: true,      // <details> open state, preserved across re-renders
  loadingMore: false,
  loaded: false,         // first recent page fetched at least once
};

// ---- small pure helpers ----
function statusBadge(status) {
  if (status === "running") return '<span class="badge live"><span class="bdot pulse"></span>running</span>';
  if (status === "success" || status === "finished") return '<span class="badge ok">' + icon("check", "sm") + esc(status) + "</span>";
  if (!status) return '<span class="badge">unknown</span>';
  return '<span class="badge err">' + icon("x", "sm") + esc(status) + "</span>";
}

function projectParam() { return h.project ? "&project=" + encodeURIComponent(h.project) : ""; }

function rowHTML(row) {
  const tokTotal = (Number(row.tokens_in) || 0) + (Number(row.tokens_out) || 0) +
    (Number(row.cache_read) || 0) + (Number(row.cache_create) || 0);
  const costPart = (row.usd || tokTotal > 0) ? fmtCostText(row.usd, tokTotal) : "";
  const meta = [row.model ? esc(row.model) : (row.provider ? esc(row.provider) : ""),
    costPart].filter(Boolean).join(" · ");
  const proj = row.project ? '<span class="srctag">' + esc(row.project) + "</span>" : "";
  // data-run → the unified detail (runs.js) via the global run navigation.
  return '<div class="recent-row" data-run="' + esc(row.id) + '" tabindex="0" role="button" aria-label="Open run ' + esc(row.id) + '">' +
    '<span class="rid">' + esc(row.id) + "</span>" + statusBadge(row.status) +
    '<span class="rt">' + esc(row.task || row.plan_summary || row.id) + "</span>" +
    proj +
    '<span class="rc">' + esc(meta) + "</span>" +
  "</div>";
}

function projectOptionsHTML() {
  const opts = ['<option value=""' + (h.project ? "" : " selected") + '>All projects</option>'];
  for (const p of h.projects) {
    const label = (p.name || p.project_id) + " (" + fmtNum(p.runs) + (p.active ? ", " + p.active + " live" : "") + ")";
    opts.push('<option value="' + esc(p.project_id) + '"' + (h.project === p.project_id ? " selected" : "") + '>' + esc(label) + "</option>");
  }
  return opts.join("");
}

// ============================================================
//  RENDER — the history browser (list only)
// ============================================================
function browserHTML() {
  const recentRows = h.recent.filter((r) => r.status !== "running");
  const recentBody = recentRows.length
    ? recentRows.map(rowHTML).join("")
    : '<div class="empty" style="padding:20px">' +
        (h.loaded ? "No historical runs yet." : "Loading run history…") + "</div>";
  const loadMore = h.hasMore
    ? '<div style="padding:14px"><button type="button" class="btn" id="historyLoadMore"' +
        (h.loadingMore ? " disabled" : "") + '>' + (h.loadingMore ? "Loading…" : "Load more") + "</button></div>"
    : "";

  return (
    '<div class="section">' +
      '<div style="display:flex;align-items:center;justify-content:space-between;gap:12px;flex-wrap:wrap">' +
        '<p class="eyebrow">' + icon("history", "sm") + "History" +
          " <span class=\"count\">(" + recentRows.length + (h.hasMore ? "+" : "") + ")</span></p>" +
        '<div style="display:flex;gap:8px;align-items:center">' +
          '<select class="msel" id="historyProject" aria-label="Project filter">' + projectOptionsHTML() + "</select>" +
          '<button type="button" class="btn" id="historyRefresh">' + icon("refresh", "sm") + "Refresh</button>" +
        "</div>" +
      "</div>" +
      '<details class="disc" id="historyRecentDetails"' + (h.recentOpen ? " open" : "") + '>' +
        '<summary><span class="tw">' + icon("chevron", "sm") + "</span> Recent runs <span class=\"count\">(" +
          recentRows.length + (h.hasMore ? "+" : "") + ")</span></summary>" +
        recentBody + loadMore +
      "</details>" +
    "</div>"
  );
}

export function renderRunsHistory() {
  const root = $("#runsHistory");
  if (!root) return;
  root.innerHTML = browserHTML();
}

// ============================================================
//  DATA LOADS
// ============================================================
export async function loadProjectsHistory() {
  try {
    const r = await api("/api/projects");
    h.projects = (r && Array.isArray(r.projects)) ? r.projects : [];
  } catch (err) {
    h.projects = [];
    toast("Load projects failed: " + err.message, "err");
  }
  h.projectsLoaded = true;
  renderRunsHistory();
}

// reset=true starts a fresh keyset page (project switch / manual refresh);
// reset=false appends the next page onto the accumulated list ("Load more").
export async function loadRecentHistory(reset) {
  if (reset) { h.recent = []; h.cursor = null; h.hasMore = false; }
  h.loadingMore = true;
  renderRunsHistory();
  try {
    let path = "/api/runs?limit=20" + projectParam();
    if (!reset && h.cursor) path += "&cursor=" + encodeURIComponent(h.cursor);
    const r = await api(path);
    const rows = (r && Array.isArray(r.runs)) ? r.runs : [];
    h.recent = reset ? rows : h.recent.concat(rows);
    h.cursor = (r && r.nextCursor) || null;
    h.hasMore = !!h.cursor;
    h.loaded = true;
  } catch (err) {
    toast("Load history failed: " + err.message, "err");
  }
  h.loadingMore = false;
  renderRunsHistory();
}

// ============================================================
//  ENTER — called when the Runs list is shown. Idempotent loads.
// ============================================================
export function enterRunsHistory() {
  if (!h.projectsLoaded) loadProjectsHistory();
  if (!h.loaded) loadRecentHistory(true);
  else renderRunsHistory();
}

// ============================================================
//  WIRING — delegated on #runsHistory, attached once at boot.
// ============================================================
export function wireRunsHistory() {
  const root = $("#runsHistory");
  if (!root) return;

  root.addEventListener("change", (e) => {
    const sel = e.target.closest("#historyProject");
    if (sel) { h.project = sel.value || ""; loadRecentHistory(true); }
  });

  root.addEventListener("toggle", (e) => {
    if (e.target.id === "historyRecentDetails") h.recentOpen = e.target.open;
  }, true); // 'toggle' doesn't bubble — capture on the root instead

  root.addEventListener("click", (e) => {
    const refresh = e.target.closest("#historyRefresh");
    if (refresh) { loadRecentHistory(true); return; }
    const more = e.target.closest("#historyLoadMore");
    if (more) { loadRecentHistory(false); return; }
    const row = e.target.closest("[data-run]");
    if (row) { openRun(row.dataset.run); return; }
  });

  root.addEventListener("keydown", (e) => {
    if (e.key !== "Enter" && e.key !== " ") return;
    const t = e.target;
    if (t && t.closest && t.closest("[data-run]")) { e.preventDefault(); t.click(); }
  });
}
