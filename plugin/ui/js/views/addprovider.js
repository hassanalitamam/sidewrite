// views/addprovider.js — the add-provider surface (bundled catalog only).
import { $, $$, icon } from "../dom.js";
import { esc, fmtNum, fmtPrice } from "../format.js";
import { state, loadCatalog as loadCatalogShared } from "../store.js";
import { api } from "../api.js";
import { toast } from "../components/toast.js";
import { loadProviders } from "./providers.js";

function modelRowHTML(m, sel) {
  // Shows id + name + price + context. Priced models list $in/$out per 1M with the
  // context appended; unpriced (e.g. local) models fall back to context alone.
  const priced = m.in || m.out;
  const ctx = m.context ? fmtNum(m.context) + " ctx" : "";
  const meta = priced
    ? "$" + fmtPrice(m.in) + " / $" + fmtPrice(m.out) + '<br><span style="opacity:.7">per 1M' + (ctx ? " · " + ctx : "") + "</span>"
    : (ctx ? '<span style="opacity:.7">' + ctx + "</span>" : '<span style="opacity:.6">free / —</span>');
  return '<input type="checkbox" data-id="' + esc(m.id) + '" ' + (sel ? "checked" : "") + ">" +
    '<span><span class="m-name">' + esc(m.name || m.id) + '</span><br><span class="m-id">' + esc(m.id) + "</span></span>" +
    '<span class="m-price">' + meta + "</span>";
}

// ============================================================
//  Bundled catalog picker
// ============================================================
const catState = { providers: [], entry: null, keyHint: "", models: [], byId: {}, selected: new Set(), loaded: false };

async function loadCatalog() {
  try {
    // Shared, cached fetch of GET /api/providers-catalog (never throws).
    catState.providers = await loadCatalogShared();
    catState.loaded = true;
  } catch (_) {
    catState.providers = [];
  }
  renderCatCatalog();
}

// A provider's self-hosted logo (catalog `logo` field), or the generic mark when
// the SVG doesn't exist yet (sambanova / lmstudio / vllm ship logo:null).
function catLogo(p) {
  return (p && p.logo)
    ? '<img class="plogo" src="' + esc(p.logo) + '" alt="" onerror="this.style.display=\'none\'">'
    : icon("providers", "sm");
}

function catRowHTML(p, i) {
  const n = (p.models && p.models.length) || 0;
  // Every catalog provider is Anthropic-wire; locals additionally want a gateway.
  const tag = p.local
    ? '<span class="cattag local">local · gateway</span>'
    : '<span class="cattag direct">direct anthropic</span>';
  const star = p.featured ? '<span class="catstar" title="Recommended">★</span>' : "";
  const on = catState.entry && catState.entry.id === p.id;
  return '<button type="button" class="catrow' + (on ? " sel" : "") + '" data-cat="' + i + '">' +
    catLogo(p) +
    '<span class="catrow-main"><span class="catrow-name">' + esc(p.name || p.id) + star + "</span>" + tag + "</span>" +
    '<span class="catrow-count">' + n + " model" + (n === 1 ? "" : "s") + "</span>" +
    "</button>";
}

// The native <select id="catSelect"> is repurposed into a logo grid: it's hidden
// and a sibling .catgrid of provider rows (logo + name + tag + model count) is
// rendered next to it. Selecting a row prefills the fields + model list.
function renderCatCatalog() {
  const sel = $("#catSelect");
  if (!sel) return;
  sel.hidden = true; sel.setAttribute("aria-hidden", "true"); sel.tabIndex = -1;
  let host = $("#catCatalog");
  if (!host) {
    host = document.createElement("div");
    host.id = "catCatalog";
    host.className = "catgrid";
    sel.insertAdjacentElement("afterend", host);
  }
  const provs = catState.providers;
  if (!provs.length) { host.innerHTML = '<div class="empty" style="padding:16px">No providers in catalog</div>'; return; }
  const order = provs.map((p, i) => [p, i]);
  order.sort((a, b) =>
    (b[0].featured ? 1 : 0) - (a[0].featured ? 1 : 0) ||
    (a[0].local ? 1 : 0) - (b[0].local ? 1 : 0) ||
    String(a[0].name || a[0].id).localeCompare(String(b[0].name || b[0].id))
  );
  host.innerHTML = order.map(([p, i]) => catRowHTML(p, i)).join("");
}

// Select a catalog provider: prefill name/baseUrl/modelsEndpoint + notes, and seed
// the model list straight from the catalog (id + context + price) — no fetch needed.
// "Fetch models" stays available to refresh live from the provider.
function selectCatEntry(p) {
  catState.entry = p || null;
  const note = $("#catNote");
  const nameEl = $("#catName"), baseEl = $("#catBaseUrl"), meEl = $("#catModelsEndpoint");
  const fetchMsg = $("#catFetchMsg"); fetchMsg.className = "form-msg"; fetchMsg.textContent = "";
  renderCatCatalog(); // reflect selection highlight
  if (!p) {
    catState.keyHint = ""; catState.models = []; catState.byId = {}; catState.selected.clear();
    nameEl.value = ""; baseEl.value = ""; meEl.value = "";
    note.hidden = true; note.innerHTML = "";
    renderCatList(); updateKeyHints();
    return;
  }
  nameEl.value = p.id || p.name || "";
  baseEl.value = p.baseUrl || "";
  meEl.value = p.modelsEndpoint || "";
  catState.keyHint = p.keyHint || "";
  const parts = [];
  if (p.local) {
    parts.push('<div class="cat-gateway">Local / OpenAI-wire endpoint — needs an external Anthropic gateway (claude-code-router / LiteLLM). Point the Base URL at the gateway once it\'s running.</div>');
  }
  if (p.notes) parts.push("<div>" + esc(p.notes) + "</div>");
  if (p.docsUrl) parts.push('<div><a href="' + esc(p.docsUrl) + '" target="_blank" rel="noreferrer noopener">Setup docs ↗</a></div>');
  note.innerHTML = parts.join("");
  note.hidden = !parts.length;
  // Seed the model picker from the catalog's embedded models.
  const models = Array.isArray(p.models) ? p.models : [];
  catState.models = models.slice();
  catState.byId = {};
  for (const m of catState.models) if (m && m.id) catState.byId[m.id] = m;
  catState.selected.clear();
  renderCatList();
  updateKeyHints();
}

async function fetchCatModels() {
  const p = catState.entry;
  const msg = $("#catFetchMsg"); msg.className = "form-msg"; msg.textContent = "";
  if (!p) { msg.className = "form-msg err"; msg.textContent = "Select a provider first."; return; }
  const baseUrl = $("#catBaseUrl").value.trim();
  const modelsEndpoint = $("#catModelsEndpoint").value.trim();
  const apiKey = $("#catKey").value.trim();
  if (!baseUrl) { msg.className = "form-msg err"; msg.textContent = "Base URL is required."; return; }
  if (/api\.anthropic\.com/i.test(baseUrl)) { msg.className = "form-msg err"; msg.textContent = "Base URL must not be api.anthropic.com."; return; }
  const listEl = $("#catList");
  listEl.innerHTML = '<div class="empty" style="padding:20px">Fetching models…</div>';
  const btn = $("#catFetch"); btn.disabled = true;
  try {
    const r = await api("/api/provider-models", {
      method: "POST",
      body: JSON.stringify({ baseUrl, modelsEndpoint, apiKey: apiKey || undefined }),
    });
    if (r && r.ok === false) {
      catState.models = []; catState.byId = {}; catState.selected.clear();
      renderCatList();
      msg.className = "form-msg err";
      msg.textContent = (r.error || "couldn't fetch models") + (r.status ? " (HTTP " + r.status + ")" : "");
      return;
    }
    catState.models = (r && Array.isArray(r.models)) ? r.models : [];
    catState.byId = {};
    for (const m of catState.models) if (m && m.id) catState.byId[m.id] = m;
    catState.selected.clear();
    renderCatList();
    msg.className = "form-msg ok";
    msg.textContent = catState.models.length
      ? "Fetched " + catState.models.length + " model" + (catState.models.length > 1 ? "s" : "") + "."
      : "No models returned.";
  } catch (err) {
    catState.models = []; catState.byId = {}; catState.selected.clear();
    renderCatList();
    msg.className = "form-msg err"; msg.textContent = err.message;
  } finally {
    btn.disabled = false;
  }
}

function catFiltered() {
  const q = $("#catSearch").value.trim().toLowerCase();
  return catState.models.filter((m) => {
    if (!q) return true;
    return (m.id || "").toLowerCase().includes(q) || (m.name || "").toLowerCase().includes(q);
  });
}

function renderCatList() {
  const list = $("#catList");
  if (!list) return;
  if (!catState.models.length) {
    list.innerHTML = '<div class="empty" style="padding:20px">' + (catState.entry ? "No bundled models for this provider — click “Fetch models” to load them live." : "Select a provider to see its models.") + "</div>";
    updateCatCount();
    return;
  }
  const items = catFiltered();
  if (!items.length) {
    list.innerHTML = '<div class="empty" style="padding:20px">No models match your search.</div>';
    updateCatCount();
    return;
  }
  const frag = document.createDocumentFragment();
  for (const m of items) {
    const on = catState.selected.has(m.id);
    const row = document.createElement("label");
    row.className = "orrow" + (on ? " sel" : "");
    row.innerHTML = modelRowHTML(m, on);
    frag.appendChild(row);
  }
  list.innerHTML = "";
  list.appendChild(frag);
  updateCatCount();
}

function updateCatCount() {
  const n = catState.selected.size;
  $("#catCount").textContent = n + " selected";
  $("#catAdd").textContent = n ? "Add " + n + " model" + (n > 1 ? "s" : "") : "Add selected";
  $("#catAdd").disabled = n === 0;
  const items = catFiltered();
  const allSel = items.length > 0 && items.every((m) => catState.selected.has(m.id));
  $("#catSelectAll").textContent = allSel ? "Clear all" : "Select all";
}

// ============================================================
//  Saved-key placeholder for the catalog form
// ============================================================
export function updateKeyHints() {
  const provs = state.providers || [];
  const savedMask = "•••••••••••• (saved — leave blank to keep)";

  const catNameEl = $("#catName");
  const catName = catNameEl ? catNameEl.value.trim() : "";
  const catSaved = !!catName && provs.some((p) => p.name === catName && p.hasKey);
  const catKey = $("#catKey"), catHint = $("#catKeyHint");
  if (catKey) catKey.placeholder = catSaved ? savedMask : (catState.keyHint || "paste key");
  if (catHint) catHint.textContent = catSaved ? "✓ saved — leave blank to keep" : (catState.keyHint ? "hint: " + catState.keyHint : "");
}

// ============================================================
//  Wiring + preload
// ============================================================
export function initAddProvider() {
  // ---- Catalog ----
  // The logo grid is injected next to the (now-hidden) #catSelect; delegate row
  // clicks from the stable parent field so the handler survives re-renders.
  const catSel = $("#catSelect");
  const catField = catSel ? catSel.parentNode : null;
  if (catField) catField.addEventListener("click", (e) => {
    const row = e.target.closest(".catrow");
    if (!row || !catField.contains(row)) return;
    selectCatEntry(catState.providers[Number(row.dataset.cat)]);
  });
  $("#catFetch").addEventListener("click", fetchCatModels);
  $("#catSearch").addEventListener("input", renderCatList);
  $("#catName").addEventListener("input", updateKeyHints);
  const catList = $("#catList");
  if (catList) catList.addEventListener("change", (e) => {
    const cb = e.target.closest("input[type=checkbox]");
    if (!cb) return;
    if (cb.checked) catState.selected.add(cb.dataset.id); else catState.selected.delete(cb.dataset.id);
    const row = cb.closest(".orrow");
    if (row) row.classList.toggle("sel", cb.checked);
    updateCatCount();
  });
  $("#catSelectAll").addEventListener("click", () => {
    const items = catFiltered();
    const allSel = items.length > 0 && items.every((m) => catState.selected.has(m.id));
    for (const m of items) { if (allSel) catState.selected.delete(m.id); else catState.selected.add(m.id); }
    renderCatList();
  });
  $("#catAdd").addEventListener("click", async () => {
    const msg = $("#catAddMsg"); msg.className = "form-msg"; msg.textContent = "";
    const name = $("#catName").value.trim();
    const baseUrl = $("#catBaseUrl").value.trim();
    const key = $("#catKey").value.trim();
    const ids = Array.from(catState.selected);
    if (!/^[A-Za-z0-9._-]+$/.test(name)) { msg.className = "form-msg err"; msg.textContent = "Name can use letters, numbers, . _ - only."; return; }
    if (!baseUrl) { msg.className = "form-msg err"; msg.textContent = "Base URL is required."; return; }
    if (/api\.anthropic\.com/i.test(baseUrl)) { msg.className = "form-msg err"; msg.textContent = "Base URL must not be api.anthropic.com."; return; }
    if (!ids.length) { msg.className = "form-msg err"; msg.textContent = "Select at least one model."; return; }
    const existing = (state.providers || []).find((p) => p.name === name);
    const hasSavedKey = !!(existing && existing.hasKey);
    if (!key && !hasSavedKey) { msg.className = "form-msg err"; msg.textContent = "Enter the provider's API key to run these models."; return; }
    const prices = {};
    for (const id of ids) { const m = catState.byId[id]; if (m && (m.in || m.out)) prices[id] = { in: m.in || 0, out: m.out || 0 }; }
    $("#catAdd").disabled = true;
    try {
      await api("/api/providers", {
        method: "POST",
        body: JSON.stringify({ name, baseUrl, apiKey: key, models: ids, prices }),
      });
      msg.className = "form-msg ok"; msg.textContent = "Added " + ids.length + " model" + (ids.length > 1 ? "s" : "") + ' under "' + name + '".';
      catState.selected.clear();
      await loadProviders();
      renderCatList();
      toast("Added " + ids.length + " model" + (ids.length > 1 ? "s" : "") + " from catalog", "ok");
    } catch (err) {
      msg.className = "form-msg err"; msg.textContent = err.message;
    } finally {
      $("#catAdd").disabled = false;
    }
  });

  loadCatalog();
}
