// views/runs.js — the Runs list + run-detail views (rendered into #runsRoot).
// The run detail is the UNIFIED detail for both live and historical runs: it
// carries the live pipeline/workers/cost/event-log AND the Files / Diff / Re-run
// drill-in folded in from the former History page.
import { $, icon } from "../dom.js";
import { esc, fmtNum, fmtUSD, fmtCost, fmtCostBadge, isUnpriced, WK } from "../format.js";
import { STAGES, STAGE_LABELS, STAGE_ICON, LOGGABLE } from "../config.js";
import {
  state, ensureRun, ensureWorker, rosterFromWorkers, seedRunRow, scheduleRender,
} from "../store.js";
import { api } from "../api.js";
import { pushRunLog } from "../events.js";
import { toast } from "../components/toast.js";

// Total tokens backing a cost block — distinguishes an UNPRICED provider ($0 with
// real tokens) from a genuinely blank/zero cost. Mirrors history.js's old helper.
function costTok(cost) {
  if (!cost) return 0;
  return (Number(cost.tokensIn) || 0) + (Number(cost.tokensOut) || 0) +
    (Number(cost.cacheRead) || 0) + (Number(cost.cacheCreate) || 0);
}

// Anything not running/succeeded is a redispatch candidate (mirrors the daemon's
// own redispatch guard, which refuses running or succeeded runs).
function isRedispatchable(status) {
  return !!status && status !== "running" && status !== "success";
}

// ---- run card (v2 .card.click) ----
function badgeFor(r, running) {
  const stage = r.stage || "…";
  if (running) {
    return '<span class="badge live"><span class="bdot pulse"></span>' + esc(stage) + "</span>";
  }
  const ok = r.status === "success" || r.verdict === "pass";
  const bad = r.status && r.status !== "running" && r.status !== "finished" && r.status !== "success";
  if (ok) return '<span class="badge ok">' + icon("check", "sm") + esc(r.status || "done") + "</span>";
  if (bad) return '<span class="badge err">' + icon("x", "sm") + esc(r.status || "failed") + "</span>";
  return '<span class="badge">' + esc(r.status || "done") + "</span>";
}

export function runCardHTML(r, running) {
  const nWorkers = (r.roster && r.roster.length) ? r.roster.length : Object.keys(r.workers).length;
  const cost = (r.cost && r.cost.usd) ? fmtUSD(r.cost.usd) : "";
  const title = esc(r.task || r.plan_summary || r.id);
  const prov = r.provider ? esc(r.provider) + (r.model ? " / " + esc(r.model) : "") : "";
  return '<div class="card click rise" data-run="' + esc(r.id) + '" tabindex="0" role="button" aria-label="Open run ' + esc(r.id) + '">' +
    '<div class="card-head">' + badgeFor(r, running) +
      (nWorkers ? '<span class="meta"><b>' + nWorkers + "</b> worker" + (nWorkers > 1 ? "s" : "") + "</span>" : "") +
    "</div>" +
    '<div class="card-title">' + title + "</div>" +
    '<div class="meta"><span class="mono" style="color:var(--accent)">' + esc(r.id) + "</span>" +
      (prov ? '<span class="sep">·</span>' + prov : "") +
    "</div>" +
    '<div class="card-foot">' +
      '<span class="meta">' + icon("worker", "sm") + (nWorkers || 0) + " worker" + ((nWorkers || 0) === 1 ? "" : "s") + "</span>" +
      (cost ? '<span class="cost-inline">' + icon("cost", "sm") + cost + "</span>" : "<span></span>") +
    "</div>" +
  "</div>";
}

// ---- Now-running panel row ----
function nowRunningRow(r) {
  const stage = r.stage || "…";
  const label = STAGE_LABELS[stage] || stage;
  const detail = esc(r.task || r.plan_summary || "streaming…");
  const cost = (r.cost && r.cost.usd) ? fmtUSD(r.cost.usd) : "";
  return '<div class="nr-row">' +
    '<div class="nr-row-top">' +
      '<span class="nr-stage">' + icon("running", "sm spin") + esc(label) + "</span>" +
      '<span class="nr-id mono">run ' + esc(r.id) + "</span>" +
      '<span class="nr-detail">' + detail + "</span>" +
      (cost ? '<span class="nr-cost mono">' + cost + "</span>" : "") +
    "</div>" +
    '<div class="nr-progress"><span class="nr-progress-fill' + (stage === "plan" ? " slow" : "") + '"></span></div>' +
  "</div>";
}

export function renderRunList() {
  const root = $("#runsRoot");
  if (!root) return;
  const runningIds = [...state.running];
  const runningRuns = runningIds.map((id) => state.runs[id] || ensureRun(id));

  // Now-running panel (only when something is running).
  const nowPanel = runningRuns.length
    ? '<div class="nowrunning rise" role="status" aria-label="Now running">' +
        '<div class="nr-head">' +
          '<span class="nr-title"><span class="livedot"></span>Now running</span>' +
          '<span class="nr-meta">' + runningRuns.length + " delegation" + (runningRuns.length > 1 ? "s" : "") + " · streaming live</span>" +
        "</div>" +
        runningRuns.map(nowRunningRow).join("") +
      "</div>"
    : "";

  // Running grid. When nothing is running AND no provider is configured yet,
  // greet first-time users with a CTA instead of the bare "no runs" copy.
  const noProviders = state.providersLoaded && (state.providers || []).length === 0;
  const runningCards = runningRuns.map((r) => runCardHTML(r, true)).join("");
  const runningBlock = runningRuns.length
    ? '<div class="grid two">' + runningCards + "</div>"
    : noProviders
      ? '<div class="empty"><span class="ei">' + icon("providers") + '</span><div class="et">Welcome to Sidewrite</div>' +
        "Add a provider to start delegating tasks to Claude Code." +
        '<div><button type="button" class="btn primary" data-goto-page="providers">Add your first provider</button></div></div>'
      : '<div class="empty"><span class="ei">' + icon("inbox") + '</span><div class="et">No runs in progress</div>Delegate a task and it appears here live.</div>';

  // NOTE: the collapsed "recent" list that used to live here has moved into the
  // dedicated history browser below (#runsHistory, views/history.js) — keyset
  // paginated, project-filterable. renderRunList only owns the live section now.

  root.innerHTML =
    nowPanel +
    '<div class="section">' +
      '<p class="eyebrow">' + icon("running", "sm") + "Running now <span class=\"count\">(" + runningRuns.length + ")</span></p>" +
      runningBlock +
    "</div>";
}

// ---- pipeline lane ----
export function laneHTML(stage, subs) {
  const ai = STAGES.indexOf(stage);
  let html = '<div class="lane">';
  STAGES.forEach((s, i) => {
    const cls = (ai !== -1 && i < ai) ? "done" : (i === ai ? "active" : "todo");
    if (i > 0) html += '<div class="lane-conn' + (ai !== -1 && i <= ai ? " filled" : "") + '"></div>';
    const glyph = cls === "done" ? icon("check") : icon(STAGE_ICON[s] || "runs");
    html += '<div class="stage ' + cls + '"><span class="bubble">' + glyph + "</span>" +
      '<span class="slabel">' + esc(STAGE_LABELS[s] || s) + "</span></div>";
  });
  html += "</div>";
  const note = (subs && ai !== -1 && subs[STAGES[ai]]) ? String(subs[STAGES[ai]]) : "";
  if (note) html += '<div class="lane-note">Current stage: "' + esc(note) + '"</div>';
  return html;
}

// ---- cost block ----
export function costBlockHTML(cost) {
  const c = cost || {};
  // Unpriced provider ($0 with real tokens) shows a badge instead of "$0.0000".
  const big = isUnpriced(c.usd, costTok(c))
    ? fmtCostBadge()
    : '<span class="cur">$</span>' + (Number(c.usd) || 0).toFixed(4);
  return '<div class="cost-block">' +
    '<div class="cost-big">' + big + "</div>" +
    '<div class="cost-list">' +
      '<div><span class="ck">in</span><span class="cv">' + fmtNum(c.tokensIn || 0) + "</span></div>" +
      '<div><span class="ck">out</span><span class="cv">' + fmtNum(c.tokensOut || 0) + "</span></div>" +
      '<div><span class="ck">cache read</span><span class="cv">' + fmtNum(c.cacheRead || 0) + "</span></div>" +
      '<div><span class="ck">cache write</span><span class="cv">' + fmtNum(c.cacheCreate || 0) + "</span></div>" +
    "</div>" +
  "</div>";
}

// ---- worker cards (one per sub-agent) ----
export function renderWorkerCards(roster, r) {
  if (!roster || !roster.length) roster = [{ worker: 0, title: null }];
  return '<div class="grid" style="grid-template-columns:repeat(auto-fill,minmax(200px,1fr))">' +
    roster.map((rw) => {
      const w = r.workers[WK(rw.worker)] || ensureWorker(r, rw.worker);
      const live = state.running.has(r.id);
      const st = w.status || (live ? "running" : "—");
      let badge;
      if (st === "success") badge = '<span class="badge ok">' + icon("check", "sm") + "done</span>";
      else if (st === "running" || st === "—") badge = '<span class="badge live"><span class="bdot pulse"></span>' + esc(w.stage || "…") + "</span>";
      else badge = '<span class="badge err">' + icon("x", "sm") + esc(st) + "</span>";
      const title = esc(rw.title || w.title || ("worker " + WK(rw.worker)));
      const wTok = (Number(w.tokensIn) || 0) + (Number(w.tokensOut) || 0);
      return '<div class="wcard rise" data-run="' + esc(r.id) + '" data-worker="' + WK(rw.worker) + '" tabindex="0" role="button" aria-label="Open worker ' + WK(rw.worker) + '">' +
        '<div class="wc-top"><span class="wc-idx">' + icon("worker", "sm") + "worker " + WK(rw.worker) + "</span>" + badge + "</div>" +
        '<div class="wc-title">' + title + "</div>" +
        '<div class="wc-foot"><span>in ' + fmtNum(w.tokensIn || 0) + " / out " + fmtNum(w.tokensOut || 0) + "</span><b>" + fmtCost(w.usd || 0, wTok) + "</b></div>" +
      "</div>";
    }).join("") + "</div>";
}

// ---- per-run event log (details.disc; rows reuse the styled .recent-row idiom) ----
export function runLogHTML(r) {
  const rows = (r.log || []).map((e) => '<div class="recent-row">' + e.html + "</div>").join("");
  return '<details class="disc"><summary><span class="tw">' + icon("chevron", "sm") +
    '</span> Event log <span class="count">(' + (r.log || []).length + ")</span></summary>" +
    (rows || '<div class="empty" style="padding:20px">No events captured for this run yet.</div>') +
  "</details>";
}

// ---- Files (snapshot) drill-in — folded in from the former History detail ----
function snapshotFilesHTML(snap) {
  if (!snap) return "";
  const files = snap.files || [];
  if (!files.length) return '<div class="empty" style="padding:20px">No files landed for this run.</div>';
  const rows = files.map((f) =>
    "<tr><td>#" + esc(f.worker) + "</td><td class=\"mono\">" + esc(f.path) + "</td><td>" +
      (f.action === "delete" ? '<span class="badge err">delete</span>' : '<span class="badge ok">write</span>') + "</td></tr>"
  ).join("");
  return '<div class="tablewrap"><table class="sk">' +
    "<thead><tr><th>Worker</th><th>Path</th><th>Action</th></tr></thead>" +
    "<tbody>" + rows + "</tbody></table></div>";
}

function snapshotSectionHTML(r) {
  const n = r.snapshot ? ((r.snapshot.files || []).length) : null;
  return '<details class="disc" id="runSnapshotDetails"' + (r.snapshotOpen ? " open" : "") + '>' +
    '<summary><span class="tw">' + icon("chevron", "sm") + "</span> Files " +
      (n != null ? '<span class="count">(' + n + ")</span>" : "") + "</summary>" +
    (r.snapshotLoading ? '<div class="empty" style="padding:20px">Loading snapshot…</div>' : snapshotFilesHTML(r.snapshot)) +
  "</details>";
}

// ---- Diff drill-in — capped colorized diff (zero-dep, pure per-line tint) ----
function diffLineClass(line) {
  if (line.startsWith("diff --git") || line.startsWith("index ") || line.startsWith("--- ") || line.startsWith("+++ ") ||
      line.startsWith("rename ") || line.startsWith("copy ")) return "df-meta";
  if (line.startsWith("@@")) return "df-hunk";
  if (line.startsWith("+")) return "df-add";
  if (line.startsWith("-")) return "df-del";
  return "df-ctx";
}
const DIFF_COLOR = { "df-meta": "var(--ink-muted)", "df-hunk": "var(--accent)", "df-add": "var(--ok)", "df-del": "var(--err)", "df-ctx": "var(--ink-body)" };
function diffLineHTML(line) {
  const cls = diffLineClass(line);
  const body = esc(line);
  return '<div style="color:' + DIFF_COLOR[cls] + '; white-space:pre">' + (body || "&nbsp;") + "</div>";
}

function diffPanelHTML(r) {
  if (r.diffLoading) return '<div class="empty" style="padding:20px">Loading diff…</div>';
  if (!r.diff) return "";
  if (!Array.isArray(r.diff.lines)) {
    return '<div class="empty" style="padding:20px">' + esc(r.diff.note || "No diff captured for this run.") +
      (r.diff.diff_stat ? '<div class="mono" style="margin-top:8px;color:var(--ink-body)">' + esc(r.diff.diff_stat) + "</div>" : "") +
    "</div>";
  }
  const body = r.diff.lines.map(diffLineHTML).join("");
  return '<div class="tablewrap" style="max-height:420px;overflow:auto;padding:10px 14px;font-family:var(--mono);font-size:12.5px">' + body + "</div>" +
    (r.diff.truncated ? '<div class="meta" style="padding:8px 2px">Diff truncated to the captured cap — showing the first lines only.</div>' : "");
}

function diffSectionHTML(r) {
  return '<details class="disc" id="runDiffDetails"' + (r.diffOpen ? " open" : "") + '>' +
    '<summary><span class="tw">' + icon("chevron", "sm") + "</span> Diff" +
      (r.diff_stat ? " <span class=\"count\">" + esc(r.diff_stat) + "</span>" : "") + "</summary>" +
    diffPanelHTML(r) +
  "</details>";
}

export function renderRunDetail(id) {
  const r = state.runs[id] || ensureRun(id);
  const root = $("#runsRoot");
  if (!root) return;
  const roster = (r.roster && r.roster.length) ? r.roster : rosterFromWorkers(r);
  const subs = {
    plan: r.plan_summary ? String(r.plan_summary).slice(0, 60) : "",
    implement: "",
    review: r.verdict ? String(r.verdict) : "",
  };
  const live = state.running.has(id);
  const headBadge = live
    ? '<span class="badge live"><span class="bdot pulse"></span>' + esc(r.stage || "…") + "</span>"
    : badgeFor(r, false);
  // Re-run (redispatch the persisted brief) — only for finished/failed runs, never
  // live or already-succeeded ones (mirrors the daemon's redispatch guard).
  const redispatchBtn = (!live && isRedispatchable(r.status))
    ? '<button type="button" class="btn" id="runRedispatch"' + (r.redispatching ? " disabled" : "") + '>' +
        icon("refresh", "sm") + (r.redispatching ? "Redispatching…" : "Re-run") + "</button>"
    : "";

  root.innerHTML =
    '<button class="back" data-nav="list">' + icon("back", "sm") + "All runs</button>" +
    '<div class="detail-head rise">' +
      "<div><h1 class=\"pagehead\">" + esc(r.task || r.plan_summary || id) + "</h1>" +
      '<div class="headmeta"><span class="k">' + esc(id) + "</span>" +
        (r.provider ? '<span class="sep">·</span>' + esc(r.provider) + (r.model ? " / " + esc(r.model) : "") : "") +
        (r.project ? '<span class="sep">·</span>' + esc(r.project) : "") +
        '<span class="sep">·</span>' + esc(r.status || "running") + "</div></div>" +
      '<div style="display:flex;align-items:center;gap:10px">' + headBadge + redispatchBtn + "</div>" +
    "</div>" +
    '<div class="section rise" style="animation-delay:.05s">' +
      '<p class="eyebrow">Pipeline</p>' + laneHTML(r.stage, subs) +
    "</div>" +
    '<div class="section grid two rise" style="animation-delay:.1s">' +
      "<div><p class=\"eyebrow\">" + icon("cost", "sm") + "Cost</p>" + costBlockHTML(r.cost) + "</div>" +
      "<div><p class=\"eyebrow\">" + icon("worker", "sm") + "Workers <span class=\"count\">(" + roster.length + ")</span></p>" +
        renderWorkerCards(roster, r) + "</div>" +
    "</div>" +
    '<div class="section rise" style="animation-delay:.15s">' + runLogHTML(r) + "</div>" +
    '<div class="section rise" style="animation-delay:.2s">' + snapshotSectionHTML(r) + "</div>" +
    '<div class="section rise" style="animation-delay:.25s">' + diffSectionHTML(r) + "</div>";
}

// ============================================================
//  DATA LOADS (authoritative shapes from the daemon)
// ============================================================

// GET /api/runs?status=running — the authoritative live set from the DB; events
// only nudge us to re-fetch. (The history/recent slice is owned by the embedded
// history browser below, views/history.js, so we no longer fetch it here.)
export async function loadRunning() {
  try {
    const runningR = await api("/api/runs?status=running");
    if (runningR && Array.isArray(runningR.runs)) {
      const ids = new Set();
      for (const row of runningR.runs) { seedRunRow(row); ids.add(row.id); }
      state.running = ids;
    }
  } catch (_) {}
  if (state.page === "runs" && state.view === "list") scheduleRender();
}

// GET /api/runs/:id — authoritative roster + per-worker cost rollup.
export async function refreshRun(id) {
  try {
    const d = await api("/api/runs/" + encodeURIComponent(id));
    if (!d || d.ok === false) return;
    const r = ensureRun(id);
    if (d.run) seedRunRow(Object.assign({ id }, d.run));
    if (Array.isArray(d.workers)) {
      r.roster = d.workers.map((w) => ({ worker: WK(w.worker), title: w.title != null ? w.title : null }));
      for (const w of d.workers) {
        const ww = ensureWorker(r, w.worker);
        if (w.title != null) ww.title = w.title;
        if (w.stage) ww.stage = w.stage;
        if (w.status) ww.status = w.status;
        ww.tokensIn = w.tokensIn; ww.tokensOut = w.tokensOut;
        ww.cacheRead = w.cacheRead; ww.cacheCreate = w.cacheCreate; ww.usd = w.usd;
      }
    }
    if (d.cost) r.cost = d.cost;
  } catch (_) {}
  if (state.page === "runs" && (state.view === "run" || state.view === "worker") && state.focusRunId === id) scheduleRender();
}

// GET /api/events?run_id=<id> — rebuild this run's collapsible log.
export async function loadRunLog(id) {
  try {
    const h = await api("/api/events?run_id=" + encodeURIComponent(id));
    if (h && Array.isArray(h.events)) {
      const r = ensureRun(id);
      r.log = [];
      for (const ev of h.events) if (LOGGABLE.has(ev.type)) pushRunLog(r, ev, true);
    }
  } catch (_) {}
  if (state.view === "run" && state.focusRunId === id) scheduleRender();
}

// GET /api/runs/:id/snapshot — landed-files sidecar (disk-preferred, DB fallback).
// Lazy: fetched the first time the Files disclosure is opened.
export async function loadSnapshot(id) {
  const r = ensureRun(id);
  r.snapshotLoading = true;
  if (state.view === "run" && state.focusRunId === id) scheduleRender();
  try {
    const s = await api("/api/runs/" + encodeURIComponent(id) + "/snapshot");
    if (s && s.ok !== false) r.snapshot = s;
  } catch (err) { toast("Load snapshot failed: " + err.message, "err"); }
  r.snapshotLoading = false;
  if (state.view === "run" && state.focusRunId === id) scheduleRender();
}

// GET /api/runs/:id/diff — LOCAL-ONLY, bounded diff preview. Lazy on open.
export async function loadDiff(id) {
  const r = ensureRun(id);
  r.diffLoading = true;
  if (state.view === "run" && state.focusRunId === id) scheduleRender();
  try {
    const d = await api("/api/runs/" + encodeURIComponent(id) + "/diff");
    if (d && d.ok !== false) r.diff = d;
  } catch (err) { toast("Load diff failed: " + err.message, "err"); }
  r.diffLoading = false;
  if (state.view === "run" && state.focusRunId === id) scheduleRender();
}

// POST /api/runs/:id/redispatch — re-run the persisted brief of a finished/failed
// run. The new run surfaces in "Now running" via the daemon's run_redispatch SSE
// event; we just reflect button state + toast the outcome here.
export async function redispatchRun(id) {
  const r = ensureRun(id);
  if (r.redispatching) return;
  r.redispatching = true;
  if (state.view === "run" && state.focusRunId === id) scheduleRender();
  try {
    const resp = await api("/api/runs/" + encodeURIComponent(id) + "/redispatch", { method: "POST" });
    if (resp && resp.ok === false) toast(resp.error || "Redispatch failed", "err");
    else toast("Redispatched as " + (resp && resp.run_id ? resp.run_id : "a new run"), "ok");
  } catch (err) { toast("Redispatch failed: " + err.message, "err"); }
  r.redispatching = false;
  if (state.view === "run" && state.focusRunId === id) scheduleRender();
}

// ---- run-detail action wiring (redispatch click + Files/Diff lazy-open) ----
// Attached once at boot on #runsRoot. Navigation (data-run/-worker/-nav) is wired
// separately in main.js; these are the detail-only extras folded in from History.
export function wireRuns() {
  const root = $("#runsRoot");
  if (!root) return;

  root.addEventListener("click", (e) => {
    const redis = e.target.closest("#runRedispatch");
    if (redis && state.focusRunId) redispatchRun(state.focusRunId);
  });

  // 'toggle' doesn't bubble — capture on the root. Lazy-load on first open and
  // remember the open state so live re-renders don't collapse the panel.
  root.addEventListener("toggle", (e) => {
    const id = state.focusRunId;
    if (!id) return;
    const r = state.runs[id];
    if (!r) return;
    if (e.target.id === "runSnapshotDetails") {
      r.snapshotOpen = e.target.open;
      if (r.snapshotOpen && !r.snapshot && !r.snapshotLoading) loadSnapshot(id);
    } else if (e.target.id === "runDiffDetails") {
      r.diffOpen = e.target.open;
      if (r.diffOpen && !r.diff && !r.diffLoading) loadDiff(id);
    }
  }, true);
}
