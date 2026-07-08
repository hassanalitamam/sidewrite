// router.js — navigation state machine. Owns state.page/view/focus*; the only
// module that decides which view renders.
import { $, $$ } from "./dom.js";
import { PAGES } from "./config.js";
import { WK } from "./format.js";
import { state } from "./store.js";
import { renderRunList, renderRunDetail, loadRunning, loadRunLog, refreshRun } from "./views/runs.js";
import { renderWorkerSnapshot } from "./views/worker.js";
import { enterStudio } from "./views/studio.js";
import { enterAnalytics } from "./views/analytics.js";
import { enterRunsHistory } from "./views/history.js";
import { enterHealth } from "./views/health.js";
import { enterBudgets } from "./views/budgets.js";
import { enterPrivacy } from "./views/privacy.js";
import { enterFeedback } from "./views/feedback.js";
import { syncGlobalProjectInto } from "./views/projectswitch.js";

// Each page's router-enter hook. `runs` re-renders the live view; everything
// else delegates to the owning view module's enter()/render() pair.
// Entering Runs re-renders the live view AND (in list view) refreshes the
// folded-in history browser, so tab-switching back rehydrates it like before.
function enterRuns() {
  renderCurrent();
  if (state.view === "list") enterRunsHistory();
}
const ENTERS = {
  runs: enterRuns,
  studio: enterStudio,
  analytics: enterAnalytics,
  health: enterHealth,
  budgets: enterBudgets,
  privacy: enterPrivacy,
  feedback: enterFeedback,
  providers: () => {},
};

// Nav grouping (cosmetic only — every page above stays fully routable). Pages
// not listed here are primary; these live behind the tabrow's "More" dropdown.
// (History is no longer a page — it's folded into the Runs tab.)
const SECONDARY_PAGES = new Set(["analytics", "health", "budgets", "privacy", "feedback"]);

export function showPage(page) {
  if (!Object.prototype.hasOwnProperty.call(PAGES, page)) page = "runs";
  state.page = page;
  $$("#tabs .tab").forEach((b) => {
    if (b.dataset.page === page) b.setAttribute("aria-current", "page");
    else b.removeAttribute("aria-current");
  });
  // Keep the "More" trigger looking active when the current page is one of the
  // secondary tabs tucked behind it (even while the dropdown itself is closed).
  const moreBtn = $("#moreBtn");
  if (moreBtn) moreBtn.classList.toggle("has-active", SECONDARY_PAGES.has(page));
  // Toggle every registered page section; only the active one is shown.
  for (const key in PAGES) {
    const el = $("#" + PAGES[key]);
    if (el) el.hidden = key !== page;
  }
  const enter = ENTERS[page];
  if (enter) enter();
  // Runs now hosts the project-scoped history browser: push the global project
  // filter into its in-view select so the two never disagree (it owns its state).
  if (page === "runs") syncGlobalProjectInto();
}

export function showList() {
  state.view = "list"; state.focusRunId = null; state.focusWorker = null;
  renderCurrent();
  loadRunning();
  enterRunsHistory();
}

export function openRun(id) {
  state.view = "run"; state.focusRunId = id; state.focusWorker = null;
  renderCurrent();
  loadRunLog(id);
  refreshRun(id);
}

export function openWorker(id, w) {
  state.view = "worker"; state.focusRunId = id; state.focusWorker = WK(w);
  renderCurrent();
}

export function renderCurrent() {
  const root = $("#runsRoot");
  if (!root) return;
  // The embedded history browser (#runsHistory) shows only under the live list;
  // a run/worker detail takes over the whole Runs page.
  const hist = $("#runsHistory");
  const isDetail = (state.view === "run" && state.focusRunId) ||
    (state.view === "worker" && state.focusRunId != null && state.focusWorker != null);
  if (hist) hist.hidden = !!isDetail;
  if (state.view === "run" && state.focusRunId) renderRunDetail(state.focusRunId);
  else if (state.view === "worker" && state.focusRunId != null && state.focusWorker != null) renderWorkerSnapshot(state.focusRunId, state.focusWorker);
  else renderRunList();
}
