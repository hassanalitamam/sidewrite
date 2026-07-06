// views/budgets.js — Cost Budgets page. Reads/writes the budget config route
// added in Batch 2 (GET/POST /api/budget, viewer-daemon.cjs ~L3237) and reacts
// to budget_warn / budget_exceeded SSE events with an alert banner.
//
// Router contract (standard view interface, matches views/skills.js):
//   enterBudgets()   — router.showPage("budgets") entry hook: loads + renders.
//   renderBudgets()  — pure re-render from current in-module state.
//   wireBudgets()    — one-time event delegation, call at boot.
//   onBudgetEvent(ev)— call from events.js SSE dispatch on
//                       "budget_warn" | "budget_exceeded" (and, harmlessly, any
//                       other budget_* event) to show/refresh the alert banner
//                       and nudge the month-spend bars.
//
// Expected markup (added by the wiring pass, mirrors #runsRoot / #skillsTableWrap):
//   <section class="page" id="pageBudgets" hidden><div id="budgetsRoot"></div></section>
// renderBudgets() owns 100% of #budgetsRoot's innerHTML — no other IDs required.

import { $ } from "../dom.js";
import { esc, fmtUSD, fmtNum } from "../format.js";
import { api } from "../api.js";
import { state } from "../store.js";
import { toast } from "../components/toast.js";

const budgetsState = {
  loaded: false,
  loading: false,
  budget: { enabled: false, enforce: false, monthlyUsd: null, perRunUsd: null, warnPct: 80 },
  month: { from: null, usd: 0, entries: 0 },
  alert: null, // last budget_warn/budget_exceeded event, or null once dismissed
};

// ---- helpers ----
function pctOf(usd, cap) {
  if (cap == null || cap <= 0) return 0;
  return Math.max(0, Math.min(100, (usd / cap) * 100));
}

function barState(pct, warnPct, hardExceeded) {
  if (hardExceeded || pct >= 100) return { color: "var(--err)", label: "over" };
  if (pct >= warnPct) return { color: "var(--accent)", label: "warn" };
  return { color: "var(--ok)", label: "ok" };
}

// Inline SVG track+fill bar — zero-dep per the no-chart-libraries rule.
function renderBar(pct, color) {
  const w = Math.round(pct * 2); // 200-wide viewBox
  return '<svg class="budget-bar" viewBox="0 0 200 10" preserveAspectRatio="none" aria-hidden="true">' +
    '<rect x="0" y="0" width="200" height="10" fill="var(--bg-sub)"></rect>' +
    '<rect x="0" y="0" width="' + w + '" height="10" fill="' + color + '"></rect>' +
    "</svg>";
}

// Best-effort "current run" spend for the per-run cap bar: the largest cost.usd
// among runs the daemon currently reports as running (store.js `state`, same
// object every other view reads — no new plumbing needed).
function currentRunUsd() {
  try {
    if (!state.running || !state.runs) return 0;
    let max = 0;
    for (const id of state.running) {
      const r = state.runs[id];
      const u = r && r.cost && Number(r.cost.usd);
      if (Number.isFinite(u) && u > max) max = u;
    }
    return max;
  } catch (_) { return 0; }
}

function alertBannerHTML() {
  const a = budgetsState.alert;
  if (!a) return "";
  const exceeded = a.type === "budget_exceeded";
  const cls = exceeded ? "err" : "warn";
  const title = exceeded ? "Budget exceeded" : "Budget warning";
  const bits = [];
  if (a.monthlyUsd != null) bits.push("month " + fmtUSD(a.projectedUsd != null ? a.projectedUsd : a.monthUsd) + " / " + fmtUSD(a.monthlyUsd));
  if (a.estUsd != null) bits.push("this run est. " + fmtUSD(a.estUsd) + (a.perRunUsd != null ? " / " + fmtUSD(a.perRunUsd) + " cap" : ""));
  if (a.run_id) bits.push("run " + a.run_id);
  const blocked = exceeded && a.enforce && a.allow === false;
  return '<div class="budget-alert ' + cls + '" role="alert">' +
    '<div class="budget-alert-title">' + esc(title) + (blocked ? " — dispatch blocked" : "") + "</div>" +
    (bits.length ? '<div class="budget-alert-detail">' + esc(bits.join(" · ")) + "</div>" : "") +
    '<button class="budget-alert-dismiss" data-dismiss-alert="1" aria-label="Dismiss">&times;</button>' +
    "</div>";
}

// ---- render ----
export function renderBudgets() {
  const root = $("#budgetsRoot");
  if (!root) return;
  const b = budgetsState.budget;
  const m = budgetsState.month;

  const monthPct = pctOf(m.usd, b.monthlyUsd);
  const monthBar = barState(monthPct, b.warnPct, b.monthlyUsd != null && m.usd >= b.monthlyUsd);
  const runUsd = currentRunUsd();
  const runPct = pctOf(runUsd, b.perRunUsd);
  const runBar = barState(runPct, b.warnPct, b.perRunUsd != null && runUsd >= b.perRunUsd);

  root.innerHTML =
    alertBannerHTML() +
    '<div class="card budget-card">' +
      '<div class="card-head">' +
        '<div class="card-title">Cost budgets</div>' +
        '<div class="budget-toggles">' +
          '<label class="toggle-row"><span>Enabled</span><button class="toggle" role="switch" data-toggle-field="enabled" aria-checked="' + (b.enabled ? "true" : "false") + '"></button></label>' +
          '<label class="toggle-row"><span>Enforce (block dispatch)</span><button class="toggle" role="switch" data-toggle-field="enforce" aria-checked="' + (b.enforce ? "true" : "false") + '"></button></label>' +
        "</div>" +
      "</div>" +
      (b.enabled ? "" : '<div class="form-msg">Budgets are disabled — caps are saved but spend is not checked or enforced.</div>') +
      '<div class="budget-grid">' +
        '<div class="budget-metric">' +
          '<div class="budget-metric-label">Monthly spend' + (b.monthlyUsd != null ? " vs cap" : "") + "</div>" +
          renderBar(monthPct, monthBar.color) +
          '<div class="budget-metric-val">' + esc(fmtUSD(m.usd)) + " / " + esc(b.monthlyUsd != null ? fmtUSD(b.monthlyUsd) : "no cap") + "</div>" +
          '<div class="budget-metric-sub">' + fmtNum(m.entries) + " run" + (m.entries === 1 ? "" : "s") + " this month</div>" +
          '<label class="budget-input-row">Monthly cap ($)<input type="number" id="budgetMonthlyInput" min="0" step="0.01" placeholder="no cap" value="' + (b.monthlyUsd != null ? esc(String(b.monthlyUsd)) : "") + '"></label>' +
        "</div>" +
        '<div class="budget-metric">' +
          '<div class="budget-metric-label">Per-run spend' + (b.perRunUsd != null ? " vs cap" : "") + "</div>" +
          renderBar(runPct, runBar.color) +
          '<div class="budget-metric-val">' + esc(fmtUSD(runUsd)) + " / " + esc(b.perRunUsd != null ? fmtUSD(b.perRunUsd) : "no cap") + "</div>" +
          '<div class="budget-metric-sub">largest currently-running run</div>' +
          '<label class="budget-input-row">Per-run cap ($)<input type="number" id="budgetPerRunInput" min="0" step="0.01" placeholder="no cap" value="' + (b.perRunUsd != null ? esc(String(b.perRunUsd)) : "") + '"></label>' +
        "</div>" +
      "</div>" +
      '<div class="budget-warn-row"><label>Warn at <input type="number" id="budgetWarnPctInput" min="1" max="100" step="1" value="' + esc(String(b.warnPct)) + '" style="width:56px"> % of monthly cap</label></div>' +
      '<div class="card-foot">' +
        '<button class="btn primary" id="budgetSaveBtn">Save</button>' +
        '<span class="form-msg" id="budgetMsg"></span>' +
      "</div>" +
    "</div>";
}

// ---- data ----
export async function loadBudgets() {
  budgetsState.loading = true;
  try {
    const r = await api("/api/budget");
    if (r && r.budget) budgetsState.budget = r.budget;
    if (r && r.month) budgetsState.month = r.month;
    budgetsState.loaded = true;
  } catch (err) {
    toast("Load budgets failed: " + err.message, "err");
  } finally {
    budgetsState.loading = false;
  }
  renderBudgets();
}

async function saveBudgets(patch) {
  const msg = $("#budgetMsg");
  try {
    const r = await api("/api/budget", { method: "POST", body: JSON.stringify(patch) });
    if (r && r.budget) budgetsState.budget = r.budget;
    if (msg) { msg.className = "form-msg ok"; msg.textContent = "Saved."; }
    toast("Budget settings saved", "ok");
    renderBudgets();
  } catch (err) {
    if (msg) { msg.className = "form-msg err"; msg.textContent = err.message; }
    toast("Save budgets failed: " + err.message, "err");
    renderBudgets();
  }
}

// Router enter hook (mirrors enterSkills): load on first visit, else re-render.
export function enterBudgets() {
  if (!budgetsState.loaded && !budgetsState.loading) loadBudgets();
  else renderBudgets();
}

// SSE hook — call from events.js on "budget_warn" / "budget_exceeded" /
// "budget_blocked". ev shape (viewer-daemon.cjs ingestEvent call, ~L3303):
// { type, run_id, monthUsd, monthlyUsd, perRunUsd, projectedUsd, estUsd,
//   enforce, allow, ts }. "budget_blocked" carries only { run_id, reason } —
// it's emitted by bin/sidewrite-run's own pre-dispatch gate (both the
// single-provider and --workers-file parallel paths), before the daemon's
// own budget_exceeded/allow:false SSE would otherwise be the only signal.
export function onBudgetEvent(ev) {
  if (!ev || !["budget_warn", "budget_exceeded", "budget_blocked"].includes(ev.type)) return;
  budgetsState.alert = ev;
  if (ev.monthUsd != null) budgetsState.month.usd = ev.monthUsd;
  const exceeded = ev.type === "budget_exceeded";
  const hardBlocked = ev.type === "budget_blocked" || (exceeded && ev.enforce && ev.allow === false);
  toast(
    (ev.type === "budget_blocked" ? "Run blocked by budget" : exceeded ? "Budget exceeded" : "Budget warning") +
      (ev.run_id ? " (run " + ev.run_id + ")" : "") +
      (hardBlocked && ev.type !== "budget_blocked" ? " — dispatch blocked" : ""),
    ev.type === "budget_blocked" || exceeded ? "err" : { tag: "budget" }
  );
  renderBudgets();
}

// ---- wiring (call once at boot) ----
export function wireBudgets() {
  const root = $("#budgetsRoot");
  if (!root) return;

  root.addEventListener("click", (e) => {
    const dismiss = e.target.closest("[data-dismiss-alert]");
    if (dismiss) {
      budgetsState.alert = null;
      renderBudgets();
      return;
    }
    const tog = e.target.closest("[data-toggle-field]");
    if (tog) {
      const field = tog.dataset.toggleField;
      const next = tog.getAttribute("aria-checked") !== "true";
      saveBudgets({ [field]: next });
      return;
    }
    const save = e.target.closest("#budgetSaveBtn");
    if (save) {
      const monthlyEl = $("#budgetMonthlyInput");
      const perRunEl = $("#budgetPerRunInput");
      const warnEl = $("#budgetWarnPctInput");
      const parseCap = (el) => {
        const v = el && el.value.trim();
        if (!v) return null;
        const n = Number(v);
        return Number.isFinite(n) && n >= 0 ? n : false;
      };
      const monthlyUsd = parseCap(monthlyEl);
      const perRunUsd = parseCap(perRunEl);
      const warnN = warnEl ? Number(warnEl.value) : NaN;
      const msg = $("#budgetMsg");
      if (monthlyUsd === false || perRunUsd === false) {
        if (msg) { msg.className = "form-msg err"; msg.textContent = "Caps must be a non-negative number (or empty for no cap)."; }
        return;
      }
      if (!Number.isFinite(warnN) || warnN < 1 || warnN > 100) {
        if (msg) { msg.className = "form-msg err"; msg.textContent = "Warn % must be between 1 and 100."; }
        return;
      }
      if (msg) { msg.className = "form-msg"; msg.textContent = "Saving…"; }
      saveBudgets({ monthlyUsd, perRunUsd, warnPct: Math.floor(warnN) });
    }
  });
}
