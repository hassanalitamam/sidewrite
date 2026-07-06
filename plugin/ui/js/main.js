// main.js — boot / entry. The ONLY <script> the shell references. Owns wiring +
// startup order; mirrors the current boot() IIFE.
import { $, $$ } from "./dom.js";
import { state, hooks, normalizeConfig } from "./store.js";
import { api } from "./api.js";
import { showPage, renderCurrent, showList, openRun, openWorker } from "./router.js";
import { loadRunning, refreshRun, wireRuns } from "./views/runs.js";
import { renderProviders, renderActive, renderModeUI, wireProviders, updateProviderGate } from "./views/providers.js";
import { renderStatus } from "./components/status.js";
import { renderSkillsBanner, wireSkills } from "./views/skills.js";
import { wireAgents } from "./views/agents.js";
import { wireStudio } from "./views/studio.js";
import { initAddProvider, updateKeyHints } from "./views/addprovider.js";
import { refreshOnboarding, wireStandalone } from "./views/onboarding.js";
import { wireAnalytics } from "./views/analytics.js";
import { wireRunsHistory, enterRunsHistory } from "./views/history.js";
import { wireHealth } from "./views/health.js";
import { wireBudgets } from "./views/budgets.js";
import { wirePrivacy } from "./views/privacy.js";
import { initGlobalProject } from "./views/projectswitch.js";
import { initTheme } from "./components/theme.js";
// disabled for now: language / RTL switcher (re-enable by uncommenting this
// import + the initDir() call below, and the #dirBtn button in viewer.html)
// import { initDir } from "./components/dir.js";
import { toast } from "./components/toast.js";
import { connect } from "./sse.js";

// Route a click/keydown target to the right run sub-view navigation.
function navFrom(el) {
  if (!el || !el.closest) return false;
  const nav = el.closest("[data-nav]");
  if (nav) {
    if (nav.dataset.nav === "list") showList();
    else if (nav.dataset.nav === "run") openRun(nav.dataset.run);
    return true;
  }
  const wc = el.closest("[data-worker]");
  if (wc) { openWorker(wc.dataset.run, wc.dataset.worker); return true; }
  const rc = el.closest("[data-run]");
  if (rc) { openRun(rc.dataset.run); return true; }
  return false;
}

// Generic "jump to another tab" control (e.g. empty-state CTAs) — delegated
// globally so any view can drop in a `data-goto-page` button without wiring.
function gotoPageFrom(el) {
  if (!el || !el.closest) return false;
  const g = el.closest("[data-goto-page]");
  if (!g) return false;
  showPage(g.dataset.gotoPage);
  return true;
}

function boot() {
  // theme first (stamps data-theme, swaps the sun/moon icon)
  initTheme();
  // disabled for now: language / RTL switcher — initDir();

  // register store reconciliation hooks (avoids router/view import cycles)
  hooks.renderCurrent = renderCurrent;
  hooks.loadRunning = loadRunning;
  hooks.refreshRun = refreshRun;

  // top-nav tabs (scoped to [data-page] so the "More" toggle button — which has
  // no data-page — doesn't get wired here too and hijack its own click into a
  // showPage(undefined) → Runs navigation; see the dedicated wiring below)
  $$("#tabs .tab[data-page]").forEach((b) => b.addEventListener("click", () => showPage(b.dataset.page)));

  // global "jump to tab" delegation (gate banner + empty-state CTAs anywhere)
  document.addEventListener("click", (e) => { gotoPageFrom(e.target); });

  // "More" nav dropdown (secondary tabs: Analytics/History/Health/Budgets/Privacy)
  const moreBtn = $("#moreBtn"), moreMenu = $("#moreMenu");
  if (moreBtn && moreMenu) {
    const closeMore = () => { moreMenu.hidden = true; moreBtn.setAttribute("aria-expanded", "false"); };
    moreBtn.addEventListener("click", (e) => {
      e.stopPropagation();
      const opening = moreMenu.hidden;
      if (opening) {
        // .tab-more-menu is position:fixed (see viewer.css) to escape #tabs'
        // overflow-x:auto, which otherwise clips it vertically — so position it
        // here from the button's live rect instead of relying on CSS top/left.
        const r = moreBtn.getBoundingClientRect();
        moreMenu.style.top = `${r.bottom + 1}px`;
        moreMenu.style.left = `${r.left}px`;
      }
      moreMenu.hidden = !opening;
      moreBtn.setAttribute("aria-expanded", opening ? "true" : "false");
    });
    moreMenu.addEventListener("click", (e) => { if (e.target.closest(".tab")) closeMore(); });
    document.addEventListener("click", (e) => { if (!moreMenu.hidden && !e.target.closest(".tab-more")) closeMore(); });
    document.addEventListener("keydown", (e) => { if (e.key === "Escape" && !moreMenu.hidden) { closeMore(); moreBtn.focus(); } });
  }

  // refresh button — spin + reconcile the live view
  const refreshBtn = $("#refreshBtn");
  if (refreshBtn) refreshBtn.addEventListener("click", () => {
    const svg = refreshBtn.querySelector(".icon");
    if (svg && !matchMedia("(prefers-reduced-motion: reduce)").matches) {
      svg.classList.add("spin");
      setTimeout(() => svg.classList.remove("spin"), 700);
    }
    loadRunning();
    if (state.view === "run" && state.focusRunId) refreshRun(state.focusRunId);
    toast("refreshed the live view", { tag: "runs" });
  });

  // run sub-view navigation (delegation on #runsRoot: click + keyboard)
  const runsRoot = $("#runsRoot");
  if (runsRoot) {
    runsRoot.addEventListener("click", (e) => { navFrom(e.target); });
    runsRoot.addEventListener("keydown", (e) => {
      if (e.key !== "Enter" && e.key !== " ") return;
      const t = e.target;
      if (t && t.closest && (t.closest("[data-run]") || t.closest("[data-worker]") || t.closest("[data-nav]"))) {
        e.preventDefault();
        navFrom(t);
      }
    });
  }

  // wire the page surfaces
  wireProviders();
  initAddProvider();
  wireSkills();
  wireAgents();
  wireStudio();
  wireStandalone();
  wireAnalytics();
  wireRuns();          // run-detail actions (Re-run / Files / Diff) on #runsRoot
  wireRunsHistory();   // embedded history browser on #runsHistory
  wireHealth();
  wireBudgets();
  wirePrivacy();
  initGlobalProject();

  // initial (pre-data) renders
  renderProviders();
  renderActive();
  renderStatus();
  renderCurrent();
  renderSkillsBanner();
  updateProviderGate(); // fail-safe: providersLoaded is false here, so this just keeps it hidden

  // Boot REST loads (providers + active + config) in case SSE initial_load lags.
  (async function loadInitial() {
    try {
      const [provs, active, cfg] = await Promise.allSettled([
        api("/api/providers"), api("/api/active"), api("/api/config"),
      ]);
      if (provs.status === "fulfilled" && Array.isArray(provs.value)) {
        state.providers = provs.value;
        // FAIL-SAFE: only flip this once we've actually heard back — an unknown
        // state (fetch failure) must never show the "no provider" banner.
        state.providersLoaded = true;
      }
      if (active.status === "fulfilled" && active.value) state.active = active.value;
      // FAIL-CLOSED: on any config load failure, config stays unknown/not-onboarded.
      if (cfg.status === "fulfilled" && cfg.value) state.config = normalizeConfig(cfg.value);
      if (!state.config.onboarded) state.onboardingActive = true;
      renderProviders(); renderActive(); renderStatus(); renderModeUI(); refreshOnboarding();
      updateKeyHints(); updateProviderGate();
    } catch (_) {}

    // Fetch the running set (authoritative) for the live list view.
    await loadRunning();
    renderCurrent();
    // Populate the embedded history browser (projects + first keyset page).
    enterRunsHistory();
    connect();
  })();
}

boot();
