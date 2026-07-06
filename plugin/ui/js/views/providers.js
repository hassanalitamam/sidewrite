// views/providers.js — mode + active model + provider registry (non-add flows).
import { $, $$, icon } from "../dom.js";
import { esc, fmtNum, fmtPrice } from "../format.js";
import { state, modeState, postConfig, loadCatalog } from "../store.js";
import { api } from "../api.js";
import { toast } from "../components/toast.js";
import { renderStatus } from "../components/status.js";
import { populateStandalone, refreshOnboarding } from "./onboarding.js";
import { updateKeyHints } from "./addprovider.js";
import { enterFreetier, wireFreetier } from "./freetier.js";

const MODE_NOTE = {
  subscription: "Plan/review stay on your subscription; only implement runs on the external provider.",
  standalone: "No subscription — Claude Code itself runs on the external provider via a base-URL swap.",
  unknown: "Mode: not set. Choose how Sidewrite runs Claude Code.",
};

// Self-hosted provider logos (plugin/ui/logos/*.svg, served same-origin). Resolve a
// provider's logo by name/host; fall back to the generic icon when there's no match.
const LOGO_IDS = new Set(["baseten", "deepinfra", "deepseek", "fireworks", "minimax", "moonshot-kimi", "novita", "ollama", "openrouter", "qwen-dashscope", "together", "xiaomi", "zai-glm"]);
const LOGO_ALIAS = { mimo: "xiaomi", xiaomimimo: "xiaomi", kimi: "moonshot-kimi", moonshot: "moonshot-kimi", moonshotai: "moonshot-kimi", zai: "zai-glm", "z-ai": "zai-glm", glm: "zai-glm", zhipu: "zai-glm", qwen: "qwen-dashscope", dashscope: "qwen-dashscope", alibaba: "qwen-dashscope", lmstudio: "ollama" };
function logoIdFor(p) {
  const n = (p.name || "").toLowerCase();
  if (LOGO_ALIAS[n]) return LOGO_ALIAS[n];
  if (LOGO_IDS.has(n)) return n;
  const h = (p.baseUrl || "").toLowerCase();
  for (const id of LOGO_IDS) if (h.includes(id)) return id;
  for (const a in LOGO_ALIAS) if (h.includes(a)) return LOGO_ALIAS[a];
  return null;
}

// Match a registered provider to its catalog entry (by normalized base URL first,
// then by id/name) so cards can reuse the catalog's logo + per-model metadata.
function normUrl(u) { return String(u || "").toLowerCase().replace(/\/+$/, ""); }
function catalogEntryFor(p) {
  const cat = state.catalog || [];
  const host = normUrl(p.baseUrl);
  if (host) {
    for (const c of cat) {
      const cb = normUrl(c.baseUrl);
      if (cb && (cb === host || host.startsWith(cb) || cb.startsWith(host))) return c;
    }
  }
  const name = (p.name || "").toLowerCase();
  for (const c of cat) {
    if ((c.id || "").toLowerCase() === name || (c.name || "").toLowerCase() === name) return c;
  }
  return null;
}

// Per-model context/price for a registered model: saved provider.prices wins for
// price; the catalog supplies context (and price when the provider stored none).
function modelMeta(p, model) {
  const c = catalogEntryFor(p);
  const cm = (c && Array.isArray(c.models)) ? c.models.find((m) => m && m.id === model) : null;
  const raw = (p.prices && p.prices[model]) || null;
  // Ignore corrupt saved prices (wrong unit): a real $/1M price is well under 10000.
  const saved = (raw && Number(raw.in) <= 10000 && Number(raw.out) <= 10000) ? raw : null;
  const price = saved || (cm ? { in: cm.in, out: cm.out } : null);
  const priceStr = (price && (price.in || price.out)) ? "$" + fmtPrice(price.in) + " / $" + fmtPrice(price.out) : "";
  const ctxStr = (cm && cm.context) ? fmtNum(cm.context) + " ctx" : "";
  // `short` = compact right-column tag (price preferred); `full` = hover tooltip.
  return {
    short: priceStr || ctxStr,
    full: [ctxStr, priceStr && priceStr + " per 1M"].filter(Boolean).join(" · "),
  };
}

function brandMark(p) {
  // Prefer the catalog's self-hosted logo (matched by base URL / id); fall back to
  // the name/host heuristic, then the generic mark. Missing SVGs hide themselves.
  const c = catalogEntryFor(p);
  if (c) {
    // Trust the catalog entry: its logo, or the generic mark when it ships none
    // (sambanova / lmstudio / vllm) — never a mis-branded heuristic fallback.
    return c.logo
      ? '<img class="plogo" src="' + esc(c.logo) + '" alt="" onerror="this.style.display=\'none\'">'
      : icon("providers", "sm");
  }
  const id = logoIdFor(p);
  return id
    ? '<img class="plogo" src="/logos/' + id + '.svg" alt="" onerror="this.style.display=\'none\'">'
    : icon("providers", "sm");
}

// ---- provider list ----
export function renderProviders() {
  const list = $("#provList");
  if (!list) return;
  const provs = state.providers || [];
  const count = $("#provCount");
  if (count) count.textContent = "(" + provs.length + ")";
  const emptyEl = $("#provEmpty");
  if (emptyEl) emptyEl.hidden = provs.length > 0;

  list.innerHTML = provs.map((p) => {
    const models = Array.isArray(p.models) ? p.models : [];
    const isActiveProv = state.active.provider === p.name;
    const rows = models.length
      ? models.map((m) => {
          const on = isActiveProv && state.active.model === m;
          const meta = modelMeta(p, m);
          const tip = esc(m) + (meta.full ? " — " + esc(meta.full) : "");
          return '<button class="mrow' + (on ? " on" : "") + '" data-activate="1" data-prov="' + esc(p.name) + '" data-model="' + esc(m) + '"' + (on ? " disabled" : "") + ' title="' + tip + '">' +
            '<span class="mrow-name">' + esc(m) + "</span>" +
            (meta.short ? '<span class="mrow-meta">' + esc(meta.short) + "</span>" : "") +
            "</button>";
        }).join("")
      : '<div class="mrow-empty">No models yet — activate one from the catalog below.</div>';
    const keyhint = p.hasKey ? 'key <code>saved</code>' : "no key set";
    const nModels = models.length + " model" + (models.length === 1 ? "" : "s");
    // Active provider shows its badge; others show a quiet icon-only remove control.
    const action = isActiveProv
      ? '<span class="badge live"><span class="bdot pulse"></span>active</span>'
      : '<button class="prov-del" data-del="' + esc(p.name) + '" title="Remove ' + esc(p.name) + '" aria-label="Remove ' + esc(p.name) + '">' + icon("x", "sm") + "</button>";
    return '<div class="prov' + (isActiveProv ? " active" : "") + '">' +
      '<div class="prov-top">' +
        '<div class="prov-id">' + brandMark(p) +
          '<div><div class="prov-name">' + esc(p.name) + "</div>" +
          '<div class="prov-host">' + esc(p.baseUrl || "") + "</div></div>" +
        "</div>" +
        action +
      "</div>" +
      '<div class="mlist">' + rows + "</div>" +
      '<div class="prov-foot"><span>' + keyhint + "</span>" +
        '<span class="prov-foot-actions">' +
          '<span class="test-pill" data-testpill="' + esc(p.name) + '" hidden></span>' +
          '<button class="btn test-btn" data-test="' + esc(p.name) + '" title="Probe this provider\'s models endpoint with its saved key">' +
            icon("running", "sm") + "Test</button>" +
          '<span class="prov-count">' + nModels + "</span>" +
        "</span>" +
      "</div>" +
    "</div>";
  }).join("");
}

// ---- active model select + delegate command chip ----
let activeOptions = [];
export function renderActive() {
  const sel = $("#activeSelect");
  if (!sel) return;
  activeOptions = [];
  const provs = state.providers || [];
  let selectedIdx = -1;
  let html = '<option value="">Select a model…</option>';
  for (const p of provs) {
    const models = Array.isArray(p.models) ? p.models : [];
    for (const m of models) {
      const idx = activeOptions.length;
      activeOptions.push({ provider: p.name, model: m });
      if (state.active.provider === p.name && state.active.model === m) selectedIdx = idx;
      const rawp = (p.prices && p.prices[m]) || null;
      const price = (rawp && Number(rawp.in) <= 10000 && Number(rawp.out) <= 10000) ? rawp : null;
      const suffix = (price && (price.in || price.out)) ? "  ·  $" + fmtPrice(price.in) + " / $" + fmtPrice(price.out) : "";
      html += '<option value="' + idx + '">' + esc(p.name) + " — " + esc(m) + esc(suffix) + "</option>";
    }
  }
  sel.innerHTML = html;
  sel.value = selectedIdx >= 0 ? String(selectedIdx) : "";
  const badge = $("#activeBadge");
  if (badge) badge.hidden = selectedIdx < 0;
}

// ---- mode segment + standalone visibility + banner ----
export function renderModeUI() {
  const m = modeState();
  $$("#modeSeg button").forEach((b) => b.setAttribute("aria-pressed", b.dataset.mode === m ? "true" : "false"));
  const note = $("#modeNote");
  if (note) note.textContent = MODE_NOTE[m] || MODE_NOTE.unknown;
  const stand = $("#standSettings");
  if (stand) stand.hidden = (m !== "standalone");
  const banner = $("#standaloneBanner");
  if (banner) banner.hidden = !(m === "standalone" && state.config.onboarded);
  if (m === "standalone") populateStandalone();
}

export async function loadProviders() {
  try {
    // Load the catalog alongside the registry so brand logos + model metadata
    // resolve on the very first render (both are cached/idempotent).
    const [provs] = await Promise.all([api("/api/providers"), loadCatalog()]);
    state.providers = Array.isArray(provs) ? provs : [];
    state.providersLoaded = true;
    onProvidersChanged();
    updateKeyHints();
  } catch (err) { toast("Load providers failed: " + err.message, "err"); }
}

// Providers changed (SSE or add/remove): refresh dependent UI + gates.
export function onProvidersChanged() {
  renderProviders();
  renderActive();
  if (modeState() === "standalone") populateStandalone();
  refreshOnboarding();
  updateProviderGate();
}

// ---- "no provider configured" attention banner (header strip) ----
// Fail-safe: only ever shown once we've actually heard back from a providers
// fetch (state.providersLoaded) — an unknown/not-yet-loaded state never shows it.
export function updateProviderGate() {
  const banner = $("#gateBanner");
  if (!banner) return;
  const noProviders = !!state.providersLoaded && (state.providers || []).length === 0;
  banner.hidden = !noProviders;
}

// ---- per-provider connection test (POST /api/providers/:name/test) ----
// Response shape (viewer-daemon.cjs): { ok, status, latencyMs, modelsResolved, error }.
// The daemon answers 200 even for a failed probe (ok:false); only an unknown
// provider 404s (api() throws). We reflect the outcome in the card's status pill
// and never surface the key.
function setTestPill(name, cls, text, title) {
  const pill = $('[data-testpill="' + (window.CSS && CSS.escape ? CSS.escape(name) : name) + '"]');
  if (!pill) return;
  pill.hidden = false;
  pill.className = "test-pill badge" + (cls ? " " + cls : "");
  pill.textContent = text;
  if (title) pill.title = title; else pill.removeAttribute("title");
}

async function testProvider(name, btn) {
  if (!name) return;
  if (btn) btn.disabled = true;
  setTestPill(name, "", "testing…", "Probing the provider's models endpoint…");
  try {
    const r = await api("/api/providers/" + encodeURIComponent(name) + "/test", { method: "POST" });
    if (r && r.ok) {
      const ms = Number(r.latencyMs) || 0;
      const n = Number(r.modelsResolved) || 0;
      setTestPill(name, "ok", "ok · " + ms + "ms" + (n ? " · " + n + " models" : ""),
        "Reachable — " + ms + "ms, " + n + " model" + (n === 1 ? "" : "s") + " resolved");
      toast(name + ": reachable (" + ms + "ms)", "ok");
    } else {
      const err = (r && r.error) || "probe failed";
      const st = r && r.status ? " · " + r.status : "";
      setTestPill(name, "err", "failed" + st, err);
      toast(name + ": " + err, "err");
    }
  } catch (err) {
    setTestPill(name, "err", "error", err.message);
    toast(name + ": " + err.message, "err");
  } finally {
    if (btn) btn.disabled = false;
  }
}

export function wireProviders() {
  // activate (model chip) + delete (button) delegation
  const list = $("#provList");
  if (list) list.addEventListener("click", async (e) => {
    const test = e.target.closest("[data-test]");
    if (test) { testProvider(test.dataset.test, test); return; }
    const act = e.target.closest("[data-activate]");
    const del = e.target.closest("[data-del]");
    if (act) {
      const provider = act.dataset.prov, model = act.dataset.model;
      if (state.active.provider === provider && state.active.model === model) return;
      try {
        await api("/api/active", { method: "POST", body: JSON.stringify({ provider, model }) });
        state.active = { provider, model };
        renderProviders(); renderActive(); renderStatus();
        toast("Activated " + model, "ok");
      } catch (err) { toast("Activate failed: " + err.message, "err"); }
    } else if (del) {
      const name = del.dataset.del;
      if (!confirm('Remove provider "' + name + '"?')) return;
      try {
        await api("/api/providers/" + encodeURIComponent(name), { method: "DELETE" });
        state.providers = state.providers.filter((p) => p.name !== name);
        onProvidersChanged();
        toast("Removed " + name, "ok");
      } catch (err) { toast("Delete failed: " + err.message, "err"); }
    }
  });

  // active-model select
  const sel = $("#activeSelect");
  if (sel) sel.addEventListener("change", async () => {
    const v = sel.value;
    if (v === "") return;
    const opt = activeOptions[Number(v)];
    if (!opt) return;
    if (state.active.provider === opt.provider && state.active.model === opt.model) return;
    try {
      await api("/api/active", { method: "POST", body: JSON.stringify({ provider: opt.provider, model: opt.model }) });
      state.active = { provider: opt.provider, model: opt.model };
      renderProviders(); renderActive(); renderStatus();
      toast("Activated " + opt.model, "ok");
    } catch (err) { toast("Activate failed: " + err.message, "err"); renderActive(); }
  });

  // mode segment
  $$("#modeSeg button").forEach((b) => b.addEventListener("click", async () => {
    const mode = b.dataset.mode;
    if (modeState() === mode) return;
    try {
      await postConfig({ mode });
      renderModeUI(); renderStatus(); refreshOnboarding();
      toast("Mode: " + mode, "ok");
    } catch (err) { toast("Mode change failed: " + err.message, "err"); }
  }));

  // delegate command chip → copy
  const chip = $(".cmdchip");
  if (chip) {
    chip.style.cursor = "pointer";
    chip.addEventListener("click", async () => {
      try { await navigator.clipboard.writeText("sidewrite delegate"); } catch (_) {}
      toast("sidewrite delegate", { tag: "copied" });
    });
  }

  wireProviderTrackSeg();
  wireFreetier();
  // Free Lane is the default-visible pane (see #provTrackSeg's markup), so
  // load it eagerly at boot the same way loadProviders() covers Track A.
  enterFreetier();
}

// ---- provider track toggle: "Free Lane" (Track B, pooled free-tier keys —
// the default) vs "Your Providers" (bring-your-own-key, Track A). A
// sub-state of the Providers page, not a separate router page — matches
// how the mode segment above it works.
function wireProviderTrackSeg() {
  const seg = $("#provTrackSeg");
  if (!seg) return;
  seg.addEventListener("click", (e) => {
    const btn = e.target.closest("button[data-track]");
    if (!btn) return;
    const track = btn.dataset.track;
    $$("#provTrackSeg button").forEach((b) => b.setAttribute("aria-pressed", b === btn ? "true" : "false"));
    const ownPane = $("#trackOwnPane");
    const ftPane = $("#freetierPane");
    if (ownPane) ownPane.hidden = track !== "own";
    if (ftPane) ftPane.hidden = track !== "freetier";
    if (track === "freetier") enterFreetier();
  });
}
