// store.js — in-memory view model + mutators. Imports nothing that renders;
// re-render / reconciliation is delegated through `hooks`, which main.js wires
// (avoids import cycles with the router/views).
import { WK } from "./format.js";
import { api } from "./api.js";

// Late-bound hooks (set in main.boot()). Keeps store free of render imports.
export const hooks = {
  renderCurrent: () => {},   // router.renderCurrent
  loadRunning: () => {},     // views/runs.loadRunning
  refreshRun: (_id) => {},   // views/runs.refreshRun
};

// view = 'list' | 'run' | 'worker'  (+ focusRunId / focusWorker)
export const state = {
  page: "runs",              // 'runs'|'skills'|'providers'|'analytics'|'history'|'health'|'budgets'|'privacy'
  view: "list",              // 'list' | 'run' | 'worker'
  focusRunId: null,
  focusWorker: null,
  runs: {},                  // run_id -> run meta (see ensureRun)
  running: new Set(),        // ids the daemon reports as status=running (authoritative)
  recent: [],                // recent run rows (any status) for the collapsed tab
  active: { provider: null, model: null },
  providers: [],             // [{name,baseUrl,models,prices,hasKey}]
  providersLoaded: false,    // true once a real providers fetch has landed (SSE or REST) — gates the "no provider" banner so it never flashes before we actually know

  catalog: [],               // models.dev-derived provider catalog [{id,name,baseUrl,logo,models,…}]
  config: { mode: null, onboarded: false, session: { provider: null, aliases: {} } },
  onboardingActive: false,
  project: "",               // global project filter ('' = all projects); #9 switcher
  projects: [],              // GET /api/projects rows, cached for the global switcher
};

export function zeroCost() {
  return { tokensIn: 0, tokensOut: 0, cacheRead: 0, cacheCreate: 0, usd: 0 };
}

export function ensureRun(id, seed) {
  let r = state.runs[id];
  if (!r) {
    r = {
      id, task: null, provider: null, model: null, status: "running",
      started_at: null, finished_at: null, branch: null, diff_stat: null,
      plan_summary: null, verdict: null, stage: null,
      roster: [],            // [{worker,title}]
      workers: {},           // workerInt -> worker meta
      cost: zeroCost(),
      log: [],               // per-run collapsible log
      // ---- run-detail drill-in cache (Files/Diff/Re-run — folded in from the
      // former History page). Lazy-loaded from REST when the disclosure opens;
      // open-state is preserved on the run so live re-renders don't collapse it.
      snapshot: null, snapshotOpen: false, snapshotLoading: false,
      diff: null, diffOpen: false, diffLoading: false,
      redispatching: false,
    };
    state.runs[id] = r;
  }
  if (seed) Object.assign(r, seed);
  return r;
}

export function ensureWorker(r, w) {
  const k = WK(w);
  if (!r.workers[k]) {
    r.workers[k] = {
      worker: k, title: null, stage: null, status: null,
      branch: null, diff_stat: null, files: [],
      tokensIn: 0, tokensOut: 0, cacheRead: 0, cacheCreate: 0, usd: 0,
    };
  }
  return r.workers[k];
}

export function rosterFromWorkers(r) {
  const ks = Object.keys(r.workers).map(Number).sort((a, b) => a - b);
  const list = ks.map((w) => ({ worker: w, title: (r.workers[w] && r.workers[w].title) || null }));
  return list.length ? list : [{ worker: 0, title: null }];
}

export function seedRunRow(row) {
  if (!row || !row.id) return;
  const r = ensureRun(row.id);
  if (row.task != null) r.task = row.task;
  if (row.provider) r.provider = row.provider;
  if (row.model) r.model = row.model;
  if (row.branch) r.branch = row.branch;
  if (row.diff_stat) r.diff_stat = row.diff_stat;
  if (row.plan_summary != null) r.plan_summary = row.plan_summary;
  if (row.started_at) r.started_at = row.started_at;
  if (row.finished_at) r.finished_at = row.finished_at;
  if (row.status) r.status = row.status;
}

export function markRunning(id) {
  if (!id) return;
  if (!state.running.has(id)) {
    state.running.add(id);
    if (state.page === "runs" && state.view === "list") scheduleRender();
  }
}

// ---- fail-closed config ----
export function normalizeConfig(c) {
  c = (c && typeof c === "object") ? c : {};
  const session = (c.session && typeof c.session === "object") ? c.session : {};
  const aliases = (session.aliases && typeof session.aliases === "object") ? session.aliases : {};
  return {
    mode: (c.mode === "subscription" || c.mode === "standalone") ? c.mode : null,
    onboarded: !!c.onboarded,
    session: { provider: session.provider || null, aliases },
  };
}

export function modeState() {
  const m = state.config && state.config.mode;
  return (m === "subscription" || m === "standalone") ? m : "unknown";
}

// Provider catalog (GET /api/providers-catalog) — models.dev-derived, self-hosted
// logos + embedded model lists. Fetched at most once; cached on state.catalog and
// shared by the providers view + the add-provider catalog picker. Never throws
// (an empty catalog just degrades gracefully to name/host-only cards).
let _catalogPromise = null;
export function loadCatalog() {
  if (_catalogPromise) return _catalogPromise;
  _catalogPromise = api("/api/providers-catalog")
    .then((r) => {
      state.catalog = (r && Array.isArray(r.providers)) ? r.providers : [];
      return state.catalog;
    })
    .catch(() => { state.catalog = []; return state.catalog; });
  return _catalogPromise;
}

export async function postConfig(patch) {
  const r = await api("/api/config", { method: "POST", body: JSON.stringify(patch) });
  if (r && r.config) state.config = normalizeConfig(r.config);
  return r;
}

// ---- debounced background reconciliation ----
const _debouncers = {};
export function debounce(key, fn, ms) {
  clearTimeout(_debouncers[key]);
  _debouncers[key] = setTimeout(fn, ms);
}
export function scheduleLoadRunning() { debounce("running", () => hooks.loadRunning(), 500); }
export function scheduleRefreshRun(id) { debounce("run:" + id, () => hooks.refreshRun(id), 500); }

// ---- rAF-coalesced re-render of the on-screen view ----
let _renderPending = false;
export function scheduleRender() {
  if (_renderPending) return;
  _renderPending = true;
  requestAnimationFrame(() => { _renderPending = false; hooks.renderCurrent(); });
}

// Re-render the current view iff the changed run is what's on screen.
export function touchView(runId) {
  if (state.page !== "runs") return;
  if (state.view === "list") scheduleRender();
  else if ((state.view === "run" || state.view === "worker") && state.focusRunId === runId) scheduleRender();
}
