// events.js — the SSE dispatch brain: turn a wire event into store mutations +
// targeted re-renders. Global events first (returned), then run-scoped routing.
// worker == null is folded to worker 0 (WK) in every branch.
import { LOGGABLE, MAX_LOG } from "./config.js";
import { esc, fmtTime, WK } from "./format.js";
import {
  state, ensureRun, ensureWorker, markRunning, touchView,
  scheduleLoadRunning, scheduleRefreshRun, debounce,
} from "./store.js";
import { renderStatus, setConn } from "./components/status.js";
import { renderProviders, renderModeUI, renderActive, onProvidersChanged } from "./views/providers.js";
import { refreshOnboarding } from "./views/onboarding.js";
import { onBudgetEvent } from "./views/budgets.js";
import { loadRecentHistory } from "./views/history.js";
import { loadGlobalProjects } from "./views/projectswitch.js";
import { toast } from "./components/toast.js";

// The project a wire event belongs to (run rows use project_id; live run events
// use project). null when the event carries no project hint.
function eventProject(ev) { return (ev && (ev.project || ev.project_id)) || null; }

// Keep the embedded history browser fresh from SSE. It now lives at the bottom of
// the Runs page, so we nudge it when Runs is shown in list view (a detail view
// hides it). Gated (when a global project filter is active) to events for that
// project. The browser's own loader honors its in-view project filter, so we only
// trigger the refetch. The live "Now running" list is handled separately by runs.js.
function nudgeHistory(ev, deep) {
  if (!deep) return; // only meaningful run-lifecycle changes touch the recent list
  if (state.page !== "runs" || state.view !== "list") return;
  const p = state.project;
  const ep = eventProject(ev);
  if (p && ep && ep !== p) return; // event is for a different project — ignore
  debounce("history:recent", () => loadRecentHistory(true), 600);
}

// ---- per-run event log ----
export function logRowHTML(ev) {
  const type = ev.type;
  let badgeClass = type;
  let badgeText = type.replace("_", " ");
  let msg = "";
  if (type === "tool_use") {
    badgeText = "tool";
    msg = "<b>" + esc(ev.tool || "tool") + "</b> " + esc(ev.inputPreview || "");
  } else if (type === "tool_result") {
    if (ev.ok === false) badgeClass += " err";
    badgeText = ev.ok === false ? "err" : "result";
    msg = esc(ev.summary || (ev.ok === false ? "failed" : "ok"));
  } else if (type === "log_line") {
    badgeText = "text";
    msg = esc(ev.text || ev.message || "");
  } else if (type === "capture_gap") {
    badgeText = "gap";
    msg = esc(ev.rawLine || ev.reason || "capture gap");
  }
  const wk = (ev.worker != null) ? '<span class="srctag">#' + WK(ev.worker) + "</span> " : "";
  // v2 log rows reuse the prototype's styled row idiom (.recent-row > .rid/.badge/.rt).
  return '<span class="rid">' + fmtTime(ev.ts) + "</span>" +
    '<span class="badge ' + esc(badgeClass) + '" title="' + esc(type) + '">' + esc(badgeText) + "</span>" +
    '<span class="rt" style="color:var(--ink-body)">' + wk + msg + "</span>";
}

export function pushRunLog(r, ev, silent) {
  if (!LOGGABLE.has(ev.type)) return;
  const entry = { worker: ev.worker, type: ev.type, tool: ev.tool, ts: ev.ts, html: logRowHTML(ev) };
  r.log.push(entry);
  if (r.log.length > MAX_LOG) r.log.shift();
  if (!silent) touchView(r.id);
}

// ============================================================
//  SSE DISPATCH — global events, then per-run/-worker routing.
// ============================================================
export function handleEvent(ev) {
  if (!ev || !ev.type) return;
  const t = ev.type;

  // ---- global (non run-scoped) events ----
  switch (t) {
    case "connected":
      setConn("live", "live");
      return;
    case "initial_load":
      if (ev.active) state.active = { provider: ev.active.provider, model: ev.active.model };
      if (Array.isArray(ev.providers)) { state.providers = ev.providers; state.providersLoaded = true; onProvidersChanged(); }
      renderStatus();
      return;
    case "processing_status":
      renderStatus({ isProcessing: ev.isProcessing, queueDepth: ev.queueDepth });
      return;
    case "active_changed":
      state.active = { provider: ev.provider, model: ev.model };
      renderProviders(); renderActive(); renderStatus();
      return;
    case "config_changed":
      state.config.mode = (ev.mode === "subscription" || ev.mode === "standalone") ? ev.mode : null;
      state.config.onboarded = !!ev.onboarded;
      renderModeUI(); renderStatus(); refreshOnboarding();
      return;
    case "run_workers": {
      const r = ensureRun(ev.run_id);
      if (ev.provider) r.provider = ev.provider;
      if (ev.model) r.model = ev.model;
      if (eventProject(ev)) r.project = eventProject(ev);
      r.roster = (ev.workers || []).map((w) => ({ worker: WK(w.worker), title: w.title != null ? String(w.title) : null }));
      for (const w of r.roster) { const ww = ensureWorker(r, w.worker); if (w.title) ww.title = w.title; }
      markRunning(ev.run_id);
      touchView(ev.run_id);
      nudgeHistory(ev);
      return;
    }
    // ---- cost budgets (#): warn/exceeded/blocked alerts drive the Budgets
    // page banner + a toast, wherever the user currently is. Never run-scoped
    // routing. "budget_blocked" comes from bin/sidewrite-run's own pre-dispatch
    // gate (both the single-provider and --workers-file parallel paths).
    case "budget_warn":
    case "budget_exceeded":
    case "budget_blocked":
      onBudgetEvent(ev);
      return;
    // ---- multi-project redispatch (#9): a brand-new run spun up from an old
    // one. Seed it so the live Runs page can pick it up, keep History's running
    // panel current, and refresh the project switcher's per-project counts.
    case "run_redispatch": {
      if (ev.run_id) {
        const r = ensureRun(ev.run_id, { status: "running" });
        if (ev.provider) r.provider = ev.provider;
        if (eventProject(ev)) r.project = eventProject(ev);
        markRunning(ev.run_id);
      }
      scheduleLoadRunning();
      nudgeHistory(ev, true);
      debounce("gproj", () => loadGlobalProjects(), 1500);
      return;
    }
    // ---- local data purge: counts changed under us. Refresh project switcher
    // + any project-scoped panel that's on screen.
    case "data_purged":
      debounce("gproj", () => loadGlobalProjects(), 500);
      nudgeHistory(ev, true);
      return;
  }

  // ---- run-scoped events ----
  const runId = ev.run_id;
  if (!runId) return;
  const r = ensureRun(runId);
  markRunning(runId);
  if (eventProject(ev)) r.project = eventProject(ev);

  switch (t) {
    case "run_init":
      if (ev.task != null) r.task = ev.task;
      if (ev.provider) r.provider = ev.provider;
      if (ev.model) r.model = ev.model;
      if (!r.stage) r.stage = "plan";
      scheduleLoadRunning();
      nudgeHistory(ev, true);
      break;
    case "pipeline_stage_changed":
      r.stage = ev.stage || r.stage;
      if (ev.provider) r.provider = ev.provider;
      if (ev.worker != null || ev.title != null) {
        const w = ensureWorker(r, ev.worker);
        if (ev.stage) w.stage = ev.stage;
        if (ev.title) w.title = ev.title;
      }
      break;
    case "plan_written":
      if (ev.plan_summary != null) r.plan_summary = ev.plan_summary;
      if (!r.stage) r.stage = "plan";
      break;
    case "provider_activity":
      if (ev.provider) r.provider = ev.provider;
      break;
    case "provider_skipped":
      pushRunLog(r, { type: "log_line", worker: ev.worker, ts: ev.ts,
        text: "skipped " + ev.provider + " — " + ev.reason + (ev.detail ? ": " + ev.detail : "") });
      toast("Skipped " + ev.provider + ": " + ev.reason, "err");
      break;
    case "provider_failover":
      pushRunLog(r, { type: "log_line", worker: ev.worker, ts: ev.ts,
        text: ev.provider + " failed (" + ev.reason + (ev.detail ? ": " + ev.detail : "") + ") — trying next provider" });
      toast(ev.provider + " failed (" + ev.reason + ") — failing over", "err");
      break;
    case "cost_update":
      // per-worker cost is authoritative server-side; nudge a debounced refetch.
      ensureWorker(r, ev.worker);
      scheduleRefreshRun(runId);
      break;
    case "implement_finished": {
      const w = ensureWorker(r, ev.worker);
      w.status = ev.status || "success";
      w.stage = "implement";
      if (ev.branch) w.branch = ev.branch;
      if (ev.diff_stat) w.diff_stat = ev.diff_stat;
      if (ev.status && ev.status !== "success") {
        toast("Implement failed (" + (ev.reason || ev.status) + ") — handed back to Claude", "err");
      }
      scheduleLoadRunning();
      scheduleRefreshRun(runId);
      nudgeHistory(ev);
      break;
    }
    case "file_landed": {
      const w = ensureWorker(r, ev.worker);
      w.files.push({ path: ev.path || ev.file || "", action: ev.action === "delete" ? "delete" : "write", worker: WK(ev.worker) });
      break;
    }
    case "review_started":
      r.stage = "review";
      break;
    case "review_finding":
      break;
    case "review_finished":
      r.stage = "review";
      r.status = "finished";
      if (ev.verdict) r.verdict = ev.verdict;
      scheduleLoadRunning();
      nudgeHistory(ev, true);
      break;
    case "tool_use":
    case "tool_result":
    case "log_line":
    case "capture_gap":
      pushRunLog(r, ev);
      break;
    case "assistant_text":
      pushRunLog(r, { type: "log_line", worker: ev.worker, ts: ev.ts, text: ev.text });
      break;
    default:
      break;
  }
  touchView(runId);
}
