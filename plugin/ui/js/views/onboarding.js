// views/onboarding.js — first-run modal + standalone alias map + standalone banner.
import { $, $$ } from "../dom.js";
import { esc } from "../format.js";
import { state, modeState, postConfig } from "../store.js";
import { toast } from "../components/toast.js";
import { renderStatus } from "../components/status.js";
import { renderModeUI } from "./providers.js";

// The single .addprov node is relocated between the Providers page and the
// onboarding host during onboarding.
let addprovOrigin = null;
export function moveAddprovTo(host) {
  const el = document.querySelector(".addprov");
  if (!el || !host) return;
  if (!addprovOrigin) addprovOrigin = { parent: el.parentNode, next: el.nextSibling };
  if (el.parentNode !== host) host.appendChild(el);
}
export function restoreAddprov() {
  const el = document.querySelector(".addprov");
  if (el && addprovOrigin && el.parentNode !== addprovOrigin.parent) {
    addprovOrigin.parent.insertBefore(el, addprovOrigin.next);
  }
}

export function populateStandalone() {
  const provSel = $("#sessProvider");
  if (!provSel) return;
  const names = (state.providers || []).map((p) => p.name);
  const curProv = (state.config.session && state.config.session.provider) || "";
  // "freetier" is a synthetic entry, not a Track A provider (it's a separate
  // registry — see pool-store.cjs) — listing it here means `sidewrite code`
  // (no args) can resolve straight to the pool, same as any registered
  // provider, with no separate command for the free-tier track.
  provSel.innerHTML = '<option value="">Select a provider…</option>' +
    '<option value="freetier">Free Lane (pooled free-tier keys)</option>' +
    names.map((n) => '<option value="' + esc(n) + '">' + esc(n) + "</option>").join("");
  provSel.value = (curProv === "freetier" || names.indexOf(curProv) !== -1) ? curProv : "";
  populateAliasOptions();
}

export function populateAliasOptions() {
  const name = $("#sessProvider") ? $("#sessProvider").value : "";
  const aliasGrid = $("#aliasGrid");
  const freetierNote = $("#aliasFreetierNote");
  // The pool self-configures its own aliases (pool-sonnet/opus/haiku) via its
  // ~/.claude-providers/freetier.env — the dashboard's per-model alias map
  // doesn't apply to it, so hide the grid instead of showing empty selects.
  if (name === "freetier") {
    if (aliasGrid) aliasGrid.hidden = true;
    if (freetierNote) freetierNote.hidden = false;
    return;
  }
  if (aliasGrid) aliasGrid.hidden = false;
  if (freetierNote) freetierNote.hidden = true;
  const prov = (state.providers || []).find((p) => p.name === name);
  const models = (prov && Array.isArray(prov.models)) ? prov.models : [];
  const aliases = (state.config.session && state.config.session.aliases) || {};
  const rows = [["sonnet", "#aliasSonnet"], ["opus", "#aliasOpus"], ["haiku", "#aliasHaiku"]];
  for (const [key, sel] of rows) {
    const el = $(sel);
    if (!el) continue;
    const cur = aliases[key] || "";
    el.innerHTML = '<option value="">—</option>' +
      models.map((mm) => '<option value="' + esc(mm) + '">' + esc(mm) + "</option>").join("");
    el.value = models.indexOf(cur) !== -1 ? cur : "";
  }
}

export function refreshOnboarding() {
  const modal = $("#onboardModal");
  if (!modal) return;
  const m = modeState();
  const haveProv = (state.providers || []).length > 0;
  if (!state.onboardingActive) { modal.hidden = true; restoreAddprov(); return; }
  if (m !== "unknown" && haveProv) {
    state.onboardingActive = false;
    modal.hidden = true;
    restoreAddprov();
    renderModeUI();
    return;
  }
  modal.hidden = false;
  const stepMode = $("#onboardStepMode");
  const stepProv = $("#onboardStepProvider");
  if (m === "unknown") {
    stepMode.hidden = false;
    stepProv.hidden = true;
    restoreAddprov();
  } else {
    stepMode.hidden = true;
    stepProv.hidden = false;
    moveAddprovTo($("#onboardProvHost"));
    $("#obProvCount").textContent = haveProv ? "Provider added." : "No providers yet.";
    $("#obProviderSub").textContent = (m === "standalone")
      ? "Standalone needs a provider whose base URL swaps the Anthropic endpoint. Add one to finish."
      : "Subscription mode delegates implement steps to a provider. Add at least one to finish.";
  }
}

export async function chooseOnboardMode(mode) {
  const msg = $("#obModeMsg");
  msg.className = "form-msg"; msg.textContent = "";
  try {
    await postConfig({ mode });
    renderModeUI();
    renderStatus();
    refreshOnboarding();
  } catch (err) {
    msg.className = "form-msg err"; msg.textContent = err.message;
  }
}

// wire onboarding-modal choices + standalone settings.
export function wireStandalone() {
  const obSub = $("#obSubscription");
  if (obSub) obSub.addEventListener("click", () => chooseOnboardMode("subscription"));
  const obStand = $("#obStandalone");
  if (obStand) obStand.addEventListener("click", () => chooseOnboardMode("standalone"));

  const sess = $("#sessProvider");
  if (sess) sess.addEventListener("change", populateAliasOptions);

  const save = $("#saveStand");
  if (save) save.addEventListener("click", async () => {
    const msg = $("#standMsg");
    msg.className = "form-msg"; msg.textContent = "";
    const provider = ($("#sessProvider").value || null);
    const aliases = {
      sonnet: $("#aliasSonnet").value || null,
      opus: $("#aliasOpus").value || null,
      haiku: $("#aliasHaiku").value || null,
    };
    try {
      await postConfig({ session: { provider, aliases } });
      msg.className = "form-msg ok"; msg.textContent = "Saved.";
      renderModeUI();
      toast("Standalone settings saved", "ok");
    } catch (err) { msg.className = "form-msg err"; msg.textContent = err.message; }
  });
}
