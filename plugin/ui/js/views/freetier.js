// views/freetier.js — Free-Tier Pool (Track B): registered free-tier keys,
// tier + priority, live cooldown state, live rpm/rpd/tpm/tpd usage, and the
// pool's own endpoint/token.
//
// Deliberately ONE simple page (no separate Keys/Fallback/Analytics tabs,
// no drag-and-drop) — per-card usage bars instead of a shared chart page.
// The reference dashboard's per-model reliability/speed/intelligence scoring
// and routing-strategy presets are a genuinely separate, larger feature
// (needs latency/success-rate history we don't track) — deliberately not
// built here; this page shows real, already-available data (declared limits
// vs. live usage) well, rather than half-building a scoring engine. Same
// render()/wire() pair every other view module in this directory uses; no
// framework, no build step.
import { $, $$, icon } from "../dom.js";
import { esc, fmtNum } from "../format.js";
import { api } from "../api.js";
import { toast } from "../components/toast.js";

const state = {
  keys: [],
  catalog: [],
  endpoint: "",
  token: "",
  tokenShown: false,
  modalProviderId: null,  // catalog id whose "View models" popup is open, or null
  modalSearch: "",        // live filter text inside that popup
  selectedModels: new Set(), // "<providerId>::<modelId>" keys checked for the batch-add bar
};

const TIER_LABEL = { opus: "opus", sonnet: "sonnet", haiku: "haiku" };
const RISK_LABEL = { ok: "", caution: "ToS: caution", avoid: "ToS: avoid" };
const AXIS_LABEL = { rpm: "RPM", rpd: "RPD", tpm: "TPM", tpd: "TPD" };

function catalogEntry(providerId) {
  return state.catalog.find((p) => p.id === providerId) || null;
}

// Providers publish a request ceiling as EITHER a per-minute or a per-day
// number, never reliably both — to compare them on one "requests/day" scale
// for the capacity chart, a per-minute-only limit is projected out over an
// assumed active-use window. This mirrors the same honesty rule as the
// per-key monthly projection: never invent an axis the provider didn't
// publish, only ever re-express a real one on a common timescale, and always
// mark the result as an estimate so it reads as a projection, not a fact.
const ACTIVE_HOURS_PER_DAY = 6;
function dailyEstimateFromAxes(rpm, rpd, tpm, tpd) {
  let req = null, reqEstimated = false, tok = null, tokEstimated = false;
  if (rpd != null) req = rpd;
  else if (rpm != null) { req = rpm * 60 * ACTIVE_HOURS_PER_DAY; reqEstimated = true; }
  if (tpd != null) tok = tpd;
  else if (tpm != null) { tok = tpm * 60 * ACTIVE_HOURS_PER_DAY; tokEstimated = true; }
  return { req, reqEstimated, tok, tokEstimated };
}
function modelDailyEstimate(m) {
  if (!m) return { req: null, reqEstimated: false, tok: null, tokEstimated: false };
  return dailyEstimateFromAxes(m.rpm, m.rpd, m.tpm, m.tpd);
}
// A registered key's OWN declared limits win over the catalog's published
// hint (the user may have entered their own numbers) — only fall back to the
// catalog's best model when the key has no declared limits at all.
function keyDailyEstimate(k) {
  const u = k.usage || {};
  const rpm = u.rpm && u.rpm.limit, rpd = u.rpd && u.rpd.limit;
  const tpm = u.tpm && u.tpm.limit, tpd = u.tpd && u.tpd.limit;
  if (rpm || rpd || tpm || tpd) return dailyEstimateFromAxes(rpm || null, rpd || null, tpm || null, tpd || null);
  const meta = catalogEntry(k.providerId);
  const m = meta && Array.isArray(meta.models) ? meta.models.find((mm) => mm.id === k.model) : null;
  return modelDailyEstimate(m);
}
// The single most generous model a provider offers, by estimated daily
// request volume — what a user would naturally reach for first.
function bestModelFor(provider) {
  const models = Array.isArray(provider.models) ? provider.models : [];
  let best = null, bestScore = -1;
  for (const m of models) {
    const est = modelDailyEstimate(m);
    const score = est.req != null ? est.req : 0;
    if (score > bestScore) { bestScore = score; best = m; }
  }
  return best || models[0] || null;
}

// The "capacity you could unlock" summary: today's estimated free daily
// volume from what's already registered, plus a per-provider bar (claimed
// vs. unclaimed) sorted by how much each is worth — the signature element
// that turns "add more free keys" into something visibly worth doing.
function capacitySummary() {
  const registeredIds = new Set(state.keys.map((k) => k.providerId));
  let claimedReq = 0, claimedTok = 0, claimedReqEstimated = false, claimedTokEstimated = false;
  for (const k of state.keys) {
    if (!k.enabled) continue;
    const est = keyDailyEstimate(k);
    if (est.req) { claimedReq += est.req; claimedReqEstimated = claimedReqEstimated || est.reqEstimated; }
    if (est.tok) { claimedTok += est.tok; claimedTokEstimated = claimedTokEstimated || est.tokEstimated; }
  }
  const bars = state.catalog.map((p) => {
    const best = bestModelFor(p);
    const est = modelDailyEstimate(best);
    return { provider: p, req: est.req || 0, reqEstimated: est.reqEstimated, tok: est.tok || 0, tokEstimated: est.tokEstimated, claimed: registeredIds.has(p.id) };
  }).sort((a, b) => b.req - a.req);
  const totalPossibleReq = bars.reduce((s, b) => s + b.req, 0);
  const totalPossibleTok = bars.reduce((s, b) => s + b.tok, 0);
  const unclaimedPossibleReq = bars.filter((b) => !b.claimed).reduce((s, b) => s + b.req, 0);
  return { claimedReq, claimedTok, claimedReqEstimated, claimedTokEstimated, bars, totalPossibleReq, totalPossibleTok, unclaimedPossibleReq };
}

// Real per-axis usage (used/limit) from the live pool-limiter snapshot the
// API now includes — one mini progress bar per declared axis (RPM/RPD/TPM/TPD)
// rather than a single combined bar, since each axis is a genuinely different
// unit (requests vs. tokens, per-minute vs. per-day) and a user asking "how
// many requests do I have left today" wants that axis specifically, not a
// blended worst-case number.
function axisBarColor(frac) {
  return frac >= 0.9 ? "var(--err)" : frac >= 0.6 ? "var(--accent)" : "var(--ok)";
}

function axisRowsHtml(k) {
  const u = k.usage || {};
  const axes = ["rpm", "rpd", "tpm", "tpd"].filter((a) => u[a] && u[a].limit);
  if (!axes.length) return '<div class="hint" style="margin-top:8px;">no declared limits yet — every request is admitted</div>';
  return axes.map((a) => {
    const used = u[a].used, limit = u[a].limit;
    const frac = Math.min(1, used / limit);
    return '<div style="margin-top:6px;">' +
      '<div class="hint" style="display:flex; justify-content:space-between;">' +
        "<span>" + AXIS_LABEL[a] + "</span><span>" + fmtNum(used) + " / " + fmtNum(limit) + "</span>" +
      "</div>" +
      '<div style="margin-top:2px;background:var(--bg-sub);border:1px solid var(--border-obj);height:5px;">' +
        '<div style="height:100%;width:' + (frac * 100).toFixed(1) + '%;background:' + axisBarColor(frac) + ';"></div>' +
      "</div>" +
    "</div>";
  }).join("");
}

// Requests/tokens per day are the only axes providers actually publish a
// daily ceiling for — projecting that out ×30 gives a rough "capacity per
// month" figure the user asked to see. This is informational only: nothing
// enforces it (pool-limiter only ever tracks real RPM/RPD/TPM/TPD windows),
// so it's labeled as a projection, not a live count.
function monthlyProjectionText(k) {
  const u = k.usage || {};
  const parts = [];
  if (u.rpd && u.rpd.limit) parts.push(fmtNum(u.rpd.limit * 30) + " requests/mo");
  if (u.tpd && u.tpd.limit) parts.push(fmtNum(u.tpd.limit * 30) + " tokens/mo");
  return parts.length ? "~" + parts.join(" · ") + " projected at this daily rate" : "";
}

// ---------------------------------------------------------------------------
// Capacity hero: today's estimated free daily volume, plus a claimed/unclaimed
// bar per provider — the one thing on this page designed to be looked at
// rather than read, so adding a free key reads as a visible gain instead of
// an abstract chore. Bars are click targets: clicking an unclaimed provider
// expands it below (see providerRowHtml) — the chart IS the "suggested next"
// list now, not a separate widget with its own numbers to reconcile.
// ---------------------------------------------------------------------------
function capacityHeroHtml() {
  const s = capacitySummary();
  if (!s.bars.length) return "";
  const max = Math.max(1, ...s.bars.map((b) => b.req));
  const headline = s.claimedReq
    ? fmtNum(Math.round(s.claimedReq)) + (s.claimedReqEstimated ? "~" : "") + " requests/day"
    : "0 requests/day";
  const tokLine = s.claimedTok
    ? fmtNum(Math.round(s.claimedTok)) + (s.claimedTokEstimated ? "~" : "") + " tokens/day unlocked"
    : "no token ceiling unlocked yet";
  // The single overall bar the per-provider bars below roll up into: every
  // provider you claim (Groq's ~14k req/day, Mistral's own slice, etc.) moves
  // this one bar toward "every free provider connected" — the top-level
  // gamification the individual bars alone don't give you at a glance.
  const overallPct = s.totalPossibleReq > 0 ? Math.min(100, (s.claimedReq / s.totalPossibleReq) * 100) : 0;
  const overallComplete = s.totalPossibleReq > 0 && overallPct >= 99.5;
  const overallLabel = overallComplete
    ? "All free capacity claimed"
    : Math.round(overallPct) + "% of free capacity claimed";
  const overallBar = s.totalPossibleReq > 0
    ? '<div style="margin-top:14px;">' +
        '<div style="display:flex; justify-content:space-between; font-size:13px; margin-bottom:6px;">' +
          '<span style="font-weight:600;">' + esc(overallLabel) + "</span>" +
          '<span class="hint">' + fmtNum(Math.round(s.claimedReq)) + " / " + fmtNum(Math.round(s.totalPossibleReq)) + " requests/day</span>" +
        "</div>" +
        '<div style="background:var(--bg-sub); border:1px solid var(--border-obj); height:12px;">' +
          '<div style="height:100%; width:' + overallPct.toFixed(1) + '%; background:var(--accent);"></div>' +
        "</div>" +
      "</div>"
    : "";
  const bars = s.bars.map((b) => {
    const pct = Math.max(b.req > 0 ? 3 : 0, (b.req / max) * 100);
    const color = b.claimed ? "var(--accent)" : "var(--border-obj)";
    const valueText = b.req ? fmtNum(Math.round(b.req)) + (b.reqEstimated ? "~" : "") + "/day" : "unpublished";
    return '<div class="ft-capbar" data-ft-expand="' + esc(b.provider.id) + '" style="cursor:pointer; margin-top:8px;">' +
      '<div style="display:flex; justify-content:space-between; font-size:12px; margin-bottom:3px;">' +
        "<span>" + (b.claimed ? '<strong>&check; ' + esc(b.provider.name) + "</strong>" : esc(b.provider.name)) + "</span>" +
        '<span class="hint">' + valueText + "</span>" +
      "</div>" +
      '<div style="background:var(--bg-sub); border:1px solid var(--border-obj); height:7px;">' +
        '<div style="height:100%; width:' + pct.toFixed(1) + '%; background:' + color + ';"></div>' +
      "</div>" +
    "</div>";
  }).join("");
  return '<div class="card" style="padding:20px;margin-top:16px;">' +
    '<div class="prov-name">Capacity you\'ve unlocked</div>' +
    '<div style="display:flex; align-items:baseline; gap:10px; margin-top:6px;">' +
      '<span style="font-size:28px; font-weight:600; line-height:1;">' + headline + "</span>" +
    "</div>" +
    '<div class="hint" style="margin-top:2px;">' + tokLine + "</div>" +
    overallBar +
    '<div style="display:flex; gap:24px; flex-wrap:wrap; margin-top:14px; padding-top:14px; border-top:1px solid var(--border-rule);">' +
      '<div><div class="hint">Total if every free provider is added</div>' +
        '<div style="font-weight:600;">' + fmtNum(Math.round(s.totalPossibleReq)) + " requests/day &middot; " + fmtNum(Math.round(s.totalPossibleTok)) + " tokens/day</div>" +
      "</div>" +
      '<div><div class="hint">Still unclaimed</div>' +
        '<div style="font-weight:600;">' + fmtNum(Math.round(s.unclaimedPossibleReq)) + " requests/day</div>" +
      "</div>" +
    "</div>" +
    '<div class="hint" style="margin-top:14px;">Every free provider below, best free model each &mdash; claimed ones filled in. Click a bar to view and add it.</div>' +
    bars +
    (s.claimedReqEstimated || s.claimedTokEstimated
      ? '<div class="hint" style="margin-top:10px;">~ marks a provider that only publishes a per-minute limit, projected over ' + ACTIVE_HOURS_PER_DAY + "h of active use/day — an estimate, not a guarantee."
      : "") +
    '<div class="hint" style="margin-top:10px;">Rate limits change without notice — cross-checked against ' +
      '<a href="https://github.com/cheahjs/free-llm-api-resources" target="_blank" rel="noopener noreferrer">cheahjs/free-llm-api-resources</a>' +
      " and each provider's own docs; verify current limits before relying on them.</div>" +
  "</div>";
}

// Is this catalog model already registered as a Free Lane key? Drives the
// added/badge vs. checkbox split in each row (see providerModelTableHtml) —
// a model that's done shows status, not a redundant control to reselect it.
function isModelAdded(providerId, modelId) {
  return state.keys.some((k) => k.providerId === providerId && k.model === modelId);
}

// The "Connected" section inside a provider's modal — every key already
// registered against this provider, rendered with the SAME rich card
// (status/live usage bars/monthly projection/enable-disable-remove-reorder)
// the main provider list used to show inline. Moved here so the main list
// can stay one compact row per provider; this is now the only place that
// detail lives. Reuses keyRow() as-is (same tier-wide up/down semantics),
// just grouped and rendered inside the modal instead of the page.
function connectedSectionHtml(provider, q) {
  const myKeys = state.keys.filter((k) => k.providerId === provider.id);
  if (!myKeys.length) return "";
  const matching = myKeys.filter((k) => {
    const m = (provider.models || []).find((mm) => mm.id === k.model);
    const label = (m && (m.name || m.id)) || k.model;
    return !q || label.toLowerCase().includes(q);
  });
  if (!matching.length) return "";
  const byTier = {};
  for (const k of matching) (byTier[k.tier] = byTier[k.tier] || []).push(k);
  const cards = Object.keys(byTier).map((tier) => byTier[tier].map((k, i, arr) => keyRow(k, i, arr)).join("")).join("");
  return '<div style="margin-bottom:16px;">' +
    '<div class="hint" style="margin-bottom:6px; font-weight:600;">Connected (' + matching.length + ")</div>" +
    cards +
  "</div>";
}

// Per-provider "available to add" table shown inside the "View models" popup —
// scoped to just that provider (not the old flat 209-row global table),
// filtered live by the popup's search box (some providers publish 40+ models,
// so scrolling a contained list beats letting the page/card grow), and
// EXCLUDING models already connected (see connectedSectionHtml above — a
// model that's done belongs there, not repeated here as a redundant row).
// Each row is a checkbox (not an individual Add button): picking several
// models, then pasting one API key once in the batch bar below, is the whole
// point — a provider only ever hands out ONE key regardless of how many of
// its models you use, so entering it once per model was pure repetition.
function providerModelTableHtml(provider) {
  const q = state.modalSearch.trim().toLowerCase();
  const all = Array.isArray(provider.models) ? provider.models : [];
  if (!all.length) return "";
  const filtered = q ? all.filter((m) => (m.name || m.id).toLowerCase().includes(q) || m.id.toLowerCase().includes(q)) : all;
  const models = filtered.filter((m) => !isModelAdded(provider.id, m.id));
  const connected = connectedSectionHtml(provider, q);
  if (!models.length) {
    if (connected) return connected;
    return '<div class="empty" style="padding:16px;">No models match "' + esc(state.modalSearch) + '".</div>';
  }
  const rows = models.map((m) => {
    const key = provider.id + "::" + m.id;
    const est = modelDailyEstimate(m);
    const checked = state.selectedModels.has(key);
    return "<tr>" +
        '<td style="padding:5px 8px; border-bottom:1px solid var(--border-rule);">' + esc(m.name || m.id) + "</td>" +
        '<td style="padding:5px 8px; border-bottom:1px solid var(--border-rule); text-align:right;">' + (m.context != null ? fmtNum(m.context) : "—") + "</td>" +
        '<td style="padding:5px 8px; border-bottom:1px solid var(--border-rule); text-align:right;">' + (m.rpm != null ? fmtNum(m.rpm) : "—") + "</td>" +
        '<td style="padding:5px 8px; border-bottom:1px solid var(--border-rule); text-align:right;">' + (m.rpd != null ? fmtNum(m.rpd) : "—") + "</td>" +
        '<td style="padding:5px 8px; border-bottom:1px solid var(--border-rule); text-align:right;">' + (m.tpm != null ? fmtNum(m.tpm) : "—") + "</td>" +
        '<td style="padding:5px 8px; border-bottom:1px solid var(--border-rule); text-align:right;">' + (m.tpd != null ? fmtNum(m.tpd) : "—") + "</td>" +
        '<td style="padding:5px 8px; border-bottom:1px solid var(--border-rule); text-align:right;">' + (est.req ? "~" + fmtNum(Math.round(est.req)) + "/day" : "—") + "</td>" +
        '<td style="padding:5px 8px; border-bottom:1px solid var(--border-rule); text-align:center;"><input type="checkbox" data-ft-select-model="' + esc(key) + '" aria-label="Select ' + esc(m.name || m.id) + '"' + (checked ? " checked" : "") + "></td>" +
      "</tr>";
  }).join("");
  return connected +
    '<div style="display:flex; justify-content:space-between; align-items:center; margin:10px 0 4px;">' +
      '<span class="hint">' + models.length + " available to add" + "</span>" +
      (models.length > 1 ? '<button type="button" class="btn" data-ft-select-all="' + esc(provider.id) + '">Select all</button>' : "") +
    "</div>" +
    '<div style="overflow-x:auto;">' +
    '<table style="width:100%; border-collapse:collapse; font-size:12px;">' +
      "<thead><tr>" +
        '<th style="text-align:left; padding:6px 8px; border-bottom:1px solid var(--border-rule);">Model</th>' +
        '<th style="text-align:right; padding:6px 8px; border-bottom:1px solid var(--border-rule);">Context</th>' +
        '<th style="text-align:right; padding:6px 8px; border-bottom:1px solid var(--border-rule);">RPM</th>' +
        '<th style="text-align:right; padding:6px 8px; border-bottom:1px solid var(--border-rule);">RPD</th>' +
        '<th style="text-align:right; padding:6px 8px; border-bottom:1px solid var(--border-rule);">TPM</th>' +
        '<th style="text-align:right; padding:6px 8px; border-bottom:1px solid var(--border-rule);">TPD</th>' +
        '<th style="text-align:right; padding:6px 8px; border-bottom:1px solid var(--border-rule);">Est./day</th>' +
        '<th style="text-align:center; padding:6px 8px; border-bottom:1px solid var(--border-rule);">Add</th>' +
      "</tr></thead>" +
      "<tbody>" + rows + "</tbody>" +
    "</table>" +
  "</div>";
}

// The batch-add bar: one tier + (usually) one API key, applied to every
// selected model in a single submit. A provider only ever issues ONE key
// regardless of how many of its models you use — so once ANY key is already
// registered for this provider, the key field is skipped entirely and the
// server reuses the existing credential (see POST /api/freetier); re-pasting
// the identical value for every additional model was pure friction. Rendered
// only once at least one model is checked, so the modal stays quiet until
// there's something to act on.
function batchAddBarHtml(provider) {
  const n = state.selectedModels.size;
  if (!n) return "";
  const hasKey = state.keys.some((k) => k.providerId === provider.id);
  const description = hasKey
    ? n + " model" + (n === 1 ? "" : "s") + " selected — using your saved " + esc(provider.name) + " API key."
    : n + " model" + (n === 1 ? "" : "s") + " selected — paste the " + esc(provider.name) + " API key once to add " + (n === 1 ? "it" : "all of them") + ".";
  const keyField = hasKey
    ? ""
    : '<input type="password" class="tf" data-ft-batch-key placeholder="paste ' + esc(provider.name) + ' API key" style="flex:1; min-width:200px;" autocomplete="off">';
  return '<div class="card" style="padding:12px 14px; margin-top:10px; background:var(--bg-sub);">' +
    '<div class="hint" style="margin-bottom:8px;">' + description + "</div>" +
    '<div style="display:flex; gap:10px; align-items:center; flex-wrap:wrap;">' +
      '<select class="msel" data-ft-batch-tier style="max-width:140px;">' +
        '<option value="sonnet" selected>sonnet</option><option value="opus">opus</option><option value="haiku">haiku</option>' +
      "</select>" +
      keyField +
      '<button type="button" class="btn primary" data-ft-batch-submit="' + esc(provider.id) + '">' + (hasKey ? "Add " + n + " model" + (n === 1 ? "" : "s") : "Add key to " + n) + "</button>" +
      '<button type="button" class="btn" data-ft-batch-clear>Clear</button>' +
      '<span class="form-msg" data-ft-batch-msg></span>' +
    "</div>" +
  "</div>";
}

// One compact row per catalog provider, whether registered or not — the main
// list is providers ONLY now; every per-model detail (usage bars, enable/
// disable/remove, and adding MORE models from a provider you've already
// partially connected) lives one level down, inside "View models" (see
// connectedSectionHtml + providerModelTableHtml). Before this, a registered
// provider rendered its full key card(s) inline here AND lost its
// "View models" button entirely — so there was no way back in to add a
// second model from a provider you'd already added one from.
function providerRowHtml(provider) {
  const myKeys = state.keys.filter((k) => k.providerId === provider.id);
  const risk = RISK_LABEL[provider.tosRisk] ? '<span class="badge" title="' + esc(provider.tosNote || "") + '">' + esc(RISK_LABEL[provider.tosRisk]) + "</span>" : "";
  let statusLine, nameTag = "";
  if (myKeys.length) {
    const ready = myKeys.filter((k) => k.enabled && !k.cooling).length;
    const cooling = myKeys.filter((k) => k.cooling).length;
    const disabled = myKeys.filter((k) => !k.enabled).length;
    const parts = [];
    if (ready) parts.push(ready + " ready");
    if (cooling) parts.push(cooling + " cooling down");
    if (disabled) parts.push(disabled + " disabled");
    statusLine = myKeys.length + " model" + (myKeys.length === 1 ? "" : "s") + " connected" + (parts.length ? " — " + parts.join(" · ") : "");
    nameTag = ' <span class="badge live"><span class="bdot pulse"></span>connected</span>';
  } else {
    statusLine = provider.typicalLimits || "";
  }
  return '<div class="prov" style="padding:12px 14px;">' +
    '<div class="prov-top">' +
      '<div class="prov-id">' + icon("providers", "sm") +
        '<div><div class="prov-name">' + esc(provider.name) + nameTag + "</div>" +
        '<div class="prov-host">' + esc(statusLine) + "</div>" +
        (risk ? '<div style="margin-top:4px;">' + risk + "</div>" : "") + "</div>" +
      "</div>" +
      '<button type="button" class="btn" data-ft-view-models="' + esc(provider.id) + '">View models</button>' +
    "</div>" +
  "</div>";
}

// The "View models" popup: header + search box + the scoped model table
// (own internal scroll, so a 40-model provider never grows the page). Reuses
// the app's existing .modal-overlay/.modal design-system classes.
function modelModalHtml() {
  const provider = catalogEntry(state.modalProviderId);
  if (!provider) return "";
  const count = Array.isArray(provider.models) ? provider.models.length : 0;
  const signupLink = provider.docsUrl
    ? '<a href="' + esc(provider.docsUrl) + '" target="_blank" rel="noreferrer noopener" style="color:var(--accent); text-decoration:underline; text-underline-offset:2px;">Get an API key ↗</a>'
    : "";
  return '<div class="modal-head" style="display:flex; align-items:flex-start; justify-content:space-between; gap:12px;">' +
      "<div><h2>" + esc(provider.name) + '</h2><p class="modal-step-note" style="margin:0;">' + esc(provider.typicalLimits || "") + "</p>" +
        (signupLink ? '<p class="modal-step-note" style="margin:4px 0 0;">' + signupLink + "</p>" : "") + "</div>" +
      '<button type="button" class="btn" data-ft-modal-close aria-label="Close">&times;</button>' +
    "</div>" +
    '<div class="modal-body">' +
      (count > 8
        ? '<input type="text" class="tf" data-ft-modal-search placeholder="Search ' + esc(count) + ' models&hellip;" value="' + esc(state.modalSearch) + '" autocomplete="off" style="margin-bottom:10px;">'
        : "") +
      '<div data-ft-modal-results style="max-height:52vh; overflow-y:auto;">' + providerModelTableHtml(provider) + "</div>" +
      '<div data-ft-modal-batchbar>' + batchAddBarHtml(provider) + "</div>" +
    "</div>";
}

// Refreshes the model list + the batch-add bar inside the popup — used by the
// search box (so typing never rebuilds, and loses focus/cursor position in,
// the input that triggered it) and by every checkbox/select-all/clear action,
// since those only ever change rows + the bar within this same container.
function renderModalResultsOnly() {
  const provider = catalogEntry(state.modalProviderId);
  if (!provider) return;
  const modalBody = document.querySelector("#ftModelModalBody");
  if (!modalBody) return;
  const resultsEl = modalBody.querySelector("[data-ft-modal-results]");
  if (resultsEl) resultsEl.innerHTML = providerModelTableHtml(provider);
  const barEl = modalBody.querySelector("[data-ft-modal-batchbar]");
  if (barEl) barEl.innerHTML = batchAddBarHtml(provider);
}

function keyRow(k, idx, tierRows) {
  const meta = catalogEntry(k.providerId);
  const name = meta ? meta.name : k.providerId;
  const risk = meta && RISK_LABEL[meta.tosRisk] ? '<span class="badge" title="' + esc(meta.tosNote || "") + '">' + esc(RISK_LABEL[meta.tosRisk]) + "</span>" : "";
  const statusBadge = k.cooling
    ? '<span class="badge err"><span class="bdot"></span>cooling down</span>'
    : (k.enabled ? '<span class="badge live"><span class="bdot pulse"></span>ready</span>' : '<span class="badge">disabled</span>');
  const isFirst = idx === 0, isLast = idx === tierRows.length - 1;
  // Mirrors the existing Track A card composition exactly: prov-top holds
  // ONLY the icon/label/host (plus a single lightweight badge on the right,
  // same slot Track A uses for its "active" badge) — the denser, multi-button
  // action group lives in prov-foot instead, where the full card width is
  // available. Cramming all 4 buttons (reorder x2, enable/disable, remove)
  // into prov-top alongside a long registered model name squeezed the
  // label/host text down to almost nothing (live-tested: it wrapped
  // character-by-character at ~60px wide).
  return '<div class="prov" data-ft-id="' + esc(k.id) + '">' +
    '<div class="prov-top">' +
      '<div class="prov-id">' + icon("providers", "sm") +
        '<div><div class="prov-name">' + esc(k.label || name) + "</div>" +
        '<div class="prov-host">' + esc(k.model || name) + " · " + esc(TIER_LABEL[k.tier] || k.tier) + " tier" + (k.contextWindow ? " · " + esc(String(k.contextWindow)) + " ctx" : "") + "</div>" +
        (risk ? '<div style="margin-top:4px;">' + risk + "</div>" : "") + "</div>" +
      "</div>" +
      statusBadge +
    "</div>" +
    axisRowsHtml(k) +
    (monthlyProjectionText(k) ? '<div class="hint" style="margin-top:6px;">' + esc(monthlyProjectionText(k)) + "</div>" : "") +
    '<div class="prov-foot">' +
      '<span></span>' +
      '<span class="prov-foot-actions">' +
        '<button class="btn" data-ft-up="' + esc(k.id) + '" title="Move up in this tier"' + (isFirst ? " disabled" : "") + ">&uarr;</button>" +
        '<button class="btn" data-ft-down="' + esc(k.id) + '" title="Move down in this tier"' + (isLast ? " disabled" : "") + ">&darr;</button>" +
        '<button class="btn" data-ft-toggle="' + esc(k.id) + '">' + (k.enabled ? "Disable" : "Enable") + "</button>" +
        '<button class="prov-del" data-ft-del="' + esc(k.id) + '" title="Remove" aria-label="Remove">' + icon("x", "sm") + "</button>" +
      "</span>" +
    "</div>" +
  "</div>";
}

export function renderFreetier() {
  const root = $("#freetierRoot");
  if (!root) return;

  const modalEl = $("#ftModelModal");
  const modalBodyEl = $("#ftModelModalBody");
  if (modalEl && modalBodyEl) {
    modalEl.hidden = !state.modalProviderId;
    if (state.modalProviderId) modalBodyEl.innerHTML = modelModalHtml();
  }

  const tokenValue = state.tokenShown ? esc(state.token) : "•".repeat(Math.max(8, (state.token || "").length));
  // One list, ordered the same as the capacity bars above it (highest
  // potential first) so a bar and its row line up spatially — registered
  // providers render their live key card(s); unregistered ones render a
  // one-line summary with a "View models" button.
  const order = capacitySummary().bars.map((b) => b.provider);
  const providerListHtml = '<div class="grid auto" style="margin-top:16px;">' + order.map(providerRowHtml).join("") + "</div>";

  root.innerHTML =
    '<p class="eyebrow">' + icon("providers", "sm") + 'Free Lane <span class="hint">— pools your free-tier keys behind one Anthropic-compatible endpoint, with tier-aware fallback</span></p>' +
    '<div class="card" style="padding:20px;">' +
      '<div class="prov-name">Endpoint &amp; unified token</div>' +
      '<div class="hint" style="margin-bottom:10px;">Wire this into a provider pointing at the pool (Base URL below, key = the token below), the same way any other Anthropic-compatible provider is added.</div>' +
      '<div class="selrow"><code class="mono">' + esc(state.endpoint) + '</code></div>' +
      '<div class="selrow" style="margin-top:8px;">' +
        '<code class="mono">' + tokenValue + '</code>' +
        '<button class="btn" id="ftTokenShow">' + (state.tokenShown ? "Hide" : "Show") + '</button>' +
        '<button class="btn" id="ftTokenCopy">Copy</button>' +
        '<button class="btn" id="ftTokenRegen" title="Invalidates the old token — re-wire any provider using it">Regenerate</button>' +
      '</div>' +
    '</div>' +
    capacityHeroHtml() +
    providerListHtml +
    // Closed by default — the provider list above (with its "View models"
    // popup) is the primary add path now; this is only for a provider not in
    // the catalog or a fully custom endpoint.
    '<details class="addprov" style="margin-top:24px;">' +
      '<summary class="eyebrow" style="cursor:pointer;">Add manually <span class="hint">— a provider not listed above, or your own custom endpoint</span></summary>' +
      '<form id="ftAddForm" class="fields" style="margin-top:12px;">' +
        '<div class="field">' +
          '<label class="field-lbl" for="ftProvider">Provider</label>' +
          '<select class="msel" id="ftProvider">' + state.catalog.map((p) => '<option value="' + esc(p.id) + '">' + esc(p.name) + (RISK_LABEL[p.tosRisk] ? " (" + esc(RISK_LABEL[p.tosRisk]) + ")" : "") + '</option>').join("") + '</select>' +
          '<div class="hint" id="ftProviderHint" style="margin-top:4px;"></div>' +
        '</div>' +
        '<div class="field">' +
          '<label class="field-lbl" for="ftTier">Tier</label>' +
          '<select class="msel" id="ftTier"><option value="sonnet" selected>sonnet</option><option value="opus">opus</option><option value="haiku">haiku</option></select>' +
        '</div>' +
        '<div class="field full">' +
          '<label class="field-lbl" for="ftBaseUrl">Base URL <span class="hint">(editable)</span></label>' +
          '<input type="text" class="tf" id="ftBaseUrl" autocomplete="off">' +
        '</div>' +
        '<div class="field">' +
          '<label class="field-lbl" for="ftModel">Model</label>' +
          '<input type="text" class="tf" id="ftModel" list="ftModelList" placeholder="e.g. z-ai/glm-5.2" autocomplete="off">' +
          '<datalist id="ftModelList"></datalist>' +
        '</div>' +
        '<div class="field full">' +
          '<label class="field-lbl" for="ftApiKey">API key</label>' +
          '<input type="password" class="tf" id="ftApiKey" placeholder="paste key" autocomplete="off">' +
        '</div>' +
      '</form>' +
      // Everything below is optional and rarely needed for a first key —
      // collapsed by default so the primary flow is just provider + tier +
      // model + key, matching the "simplest possible" ask. Native <details>,
      // zero JS needed to toggle it.
      '<details style="margin-top:4px;">' +
        '<summary class="hint" style="cursor:pointer;">Advanced (context window, label, rate limits)</summary>' +
        '<div class="fields" style="margin-top:10px;">' +
          '<div class="field">' +
            '<label class="field-lbl" for="ftContextWindow">Context window <span class="hint">(tokens, optional)</span></label>' +
            '<input type="number" class="tf" id="ftContextWindow" min="0" placeholder="e.g. 128000">' +
          '</div>' +
          '<div class="field">' +
            '<label class="field-lbl" for="ftLabel">Label <span class="hint">(optional)</span></label>' +
            '<input type="text" class="tf" id="ftLabel" autocomplete="off">' +
          '</div>' +
          '<div class="field"><label class="field-lbl" for="ftRpm">RPM limit <span class="hint">(optional)</span></label><input type="number" class="tf" id="ftRpm" min="0"></div>' +
          '<div class="field"><label class="field-lbl" for="ftRpd">RPD limit <span class="hint">(optional)</span></label><input type="number" class="tf" id="ftRpd" min="0"></div>' +
          '<div class="field"><label class="field-lbl" for="ftTpm">TPM limit <span class="hint">(optional)</span></label><input type="number" class="tf" id="ftTpm" min="0"></div>' +
          '<div class="field"><label class="field-lbl" for="ftTpd">TPD limit <span class="hint">(optional)</span></label><input type="number" class="tf" id="ftTpd" min="0"></div>' +
        '</div>' +
      '</details>' +
      '<div style="display:flex; gap:12px; align-items:center;">' +
        '<button type="button" class="btn primary" id="ftAddBtn">Add key</button>' +
        '<span class="form-msg" id="ftAddMsg"></span>' +
      '</div>' +
      '<div class="hint">Declared limits are enforced proactively — a key nearing its own RPM/RPD/TPM/TPD cap is skipped before it\'s ever dispatched to, not just after it fails. A key that still errors out is cooled down and the pool rotates to the next one in this tier. When two keys in the same tier are otherwise tied, the one with the larger declared context window is tried first.</div>' +
    '</details>';

  const provSel = $("#ftProvider");
  if (provSel) {
    const modelInput = $("#ftModel");
    const modelListEl = $("#ftModelList");
    // Once the model field matches a known catalog model id exactly, prefill
    // the (collapsed) Advanced fields from that model's researched data — the
    // user only has to paste the API key for the common case of picking a
    // listed model. Values are still plain inputs, so anything prefilled here
    // stays fully editable/overridable.
    const applyModelPrefill = () => {
      const meta = catalogEntry(provSel.value);
      const val = modelInput ? modelInput.value.trim() : "";
      const models = (meta && Array.isArray(meta.models)) ? meta.models : [];
      const m = models.find((mm) => mm.id === val);
      if (!m) return;
      const ctxEl = $("#ftContextWindow"), rpmEl = $("#ftRpm"), rpdEl = $("#ftRpd"), tpmEl = $("#ftTpm"), tpdEl = $("#ftTpd");
      if (ctxEl && m.context != null) ctxEl.value = m.context;
      if (rpmEl && m.rpm != null) rpmEl.value = m.rpm;
      if (rpdEl && m.rpd != null) rpdEl.value = m.rpd;
      if (tpmEl && m.tpm != null) tpmEl.value = m.tpm;
      if (tpdEl && m.tpd != null) tpdEl.value = m.tpd;
    };
    const applyProviderHint = () => {
      const meta = catalogEntry(provSel.value);
      const baseUrlEl = $("#ftBaseUrl");
      if (baseUrlEl && meta) baseUrlEl.value = meta.baseUrl || "";
      const hintEl = $("#ftProviderHint");
      if (hintEl) {
        hintEl.textContent = meta && meta.typicalLimits ? "Typically: " + meta.typicalLimits + " (enter your own numbers below — this is just a published-ceiling hint)" : "";
      }
      const models = (meta && Array.isArray(meta.models)) ? meta.models : [];
      if (modelListEl) {
        modelListEl.innerHTML = models.map((m) =>
          '<option value="' + esc(m.id) + '">' + esc(m.name || m.id) + (m.context ? " — " + fmtNum(m.context) + " ctx" : "") + "</option>"
        ).join("");
      }
      // Prefill the first (best) known model as a convenience default — still
      // just text in a plain input, so it's freely overridable.
      if (modelInput && !modelInput.value && models.length) modelInput.value = models[0].id;
      applyModelPrefill();
    };
    provSel.addEventListener("change", applyProviderHint);
    if (modelInput) modelInput.addEventListener("input", applyModelPrefill);
    applyProviderHint();
  }
}

export async function loadFreetier() {
  try {
    const [list, tok] = await Promise.all([api("/api/freetier"), api("/api/freetier/token")]);
    state.keys = Array.isArray(list.keys) ? list.keys : [];
    state.catalog = Array.isArray(list.catalog) ? list.catalog : [];
    state.endpoint = list.endpoint || tok.endpoint || "";
    state.token = tok.token || "";
    renderFreetier();
  } catch (err) {
    toast("Load Free Lane failed: " + err.message, "err");
  }
}

export function enterFreetier() {
  loadFreetier();
}

export function wireFreetier() {
  const root = $("#freetierRoot");
  if (!root) return;

  root.addEventListener("click", async (e) => {
    if (e.target.closest("#ftTokenShow")) {
      state.tokenShown = !state.tokenShown;
      renderFreetier();
      return;
    }
    if (e.target.closest("#ftTokenCopy")) {
      try { await navigator.clipboard.writeText(state.token); } catch (_) {}
      toast("Token copied", "ok");
      return;
    }
    // Opens the "View models" popup for either a capacity-bar click or the
    // card's own button — the chart doubles as navigation into the same view.
    const openModal = e.target.closest("[data-ft-expand], [data-ft-view-models]");
    if (openModal) {
      const providerId = openModal.dataset.ftExpand || openModal.dataset.ftViewModels;
      state.modalProviderId = providerId;
      state.modalSearch = "";
      state.selectedModels = new Set();
      renderFreetier();
      return;
    }
    if (e.target.closest("#ftTokenRegen")) {
      if (!confirm("Regenerate the pool token? Any provider already wired to it will stop working until updated.")) return;
      try {
        const r = await api("/api/freetier/token", { method: "POST" });
        state.token = r.token;
        state.tokenShown = true;
        renderFreetier();
        toast("Token regenerated", "ok");
      } catch (err) { toast("Regenerate failed: " + err.message, "err"); }
      return;
    }
    if (e.target.closest("#ftAddBtn")) {
      const providerId = $("#ftProvider").value;
      const apiKey = $("#ftApiKey").value.trim();
      if (!providerId || !apiKey) {
        toast("Provider and API key are required", "err");
        return;
      }
      const limits = {
        rpm: $("#ftRpm").value || null,
        rpd: $("#ftRpd").value || null,
        tpm: $("#ftTpm").value || null,
        tpd: $("#ftTpd").value || null,
      };
      try {
        await api("/api/freetier", {
          method: "POST",
          body: JSON.stringify({
            providerId,
            apiKey,
            baseUrl: $("#ftBaseUrl").value.trim(),
            model: $("#ftModel").value.trim(),
            contextWindow: $("#ftContextWindow").value || null,
            label: $("#ftLabel").value.trim(),
            tier: $("#ftTier").value,
            limits,
          }),
        });
        toast("Added to Free Lane", "ok");
        await loadFreetier();
      } catch (err) { toast("Add failed: " + err.message, "err"); }
      return;
    }

  });

  // The popup lives outside #freetierRoot (a sibling in viewer.html), so it
  // gets its own delegated listeners. Registered-key actions (toggle/remove/
  // reorder) now live ONLY here too — since connectedSectionHtml renders
  // keyRow() cards inside this modal, not on the main page anymore.
  const modal = $("#ftModelModal");
  if (!modal) return;

  modal.addEventListener("click", async (e) => {
    // Close on the explicit button or a click on the dimmed backdrop itself
    // (not a click inside the modal card).
    if (e.target.closest("[data-ft-modal-close]") || e.target === modal) {
      state.modalProviderId = null;
      state.selectedModels = new Set();
      renderFreetier();
      return;
    }
    const selectAll = e.target.closest("[data-ft-select-all]");
    if (selectAll) {
      const providerId = selectAll.dataset.ftSelectAll;
      const provider = catalogEntry(providerId);
      const q = state.modalSearch.trim().toLowerCase();
      const all = provider && Array.isArray(provider.models) ? provider.models : [];
      const visible = q ? all.filter((m) => (m.name || m.id).toLowerCase().includes(q) || m.id.toLowerCase().includes(q)) : all;
      for (const m of visible) {
        if (!isModelAdded(providerId, m.id)) state.selectedModels.add(providerId + "::" + m.id);
      }
      renderModalResultsOnly();
      return;
    }
    if (e.target.closest("[data-ft-batch-clear]")) {
      state.selectedModels = new Set();
      renderModalResultsOnly();
      return;
    }
    const batchSubmit = e.target.closest("[data-ft-batch-submit]");
    if (batchSubmit) {
      const providerId = batchSubmit.dataset.ftBatchSubmit;
      const provider = catalogEntry(providerId);
      const bar = batchSubmit.closest("[data-ft-modal-batchbar]");
      const tierEl = bar ? bar.querySelector("[data-ft-batch-tier]") : null;
      const keyEl = bar ? bar.querySelector("[data-ft-batch-key]") : null;
      const msgEl = bar ? bar.querySelector("[data-ft-batch-msg]") : null;
      const apiKey = keyEl ? keyEl.value.trim() : "";
      const hasExistingKey = state.keys.some((k) => k.providerId === providerId);
      // No key field is even rendered once a key already exists for this
      // provider (see batchAddBarHtml) — the server reuses it. Only a
      // provider with NO key yet, and no field to have typed one into, is
      // actually missing something here.
      if (!apiKey && !hasExistingKey) {
        if (msgEl) { msgEl.className = "form-msg err"; msgEl.textContent = "API key required"; }
        return;
      }
      const tier = tierEl ? tierEl.value : "sonnet";
      const modelIds = Array.from(state.selectedModels)
        .filter((k) => k.startsWith(providerId + "::"))
        .map((k) => k.slice(providerId.length + 2));
      let ok = 0, failed = [];
      for (const modelId of modelIds) {
        const model = provider && Array.isArray(provider.models) ? provider.models.find((m) => m.id === modelId) : null;
        try {
          await api("/api/freetier", {
            method: "POST",
            body: JSON.stringify({
              providerId,
              apiKey,
              baseUrl: provider ? provider.baseUrl : "",
              model: modelId,
              contextWindow: model ? model.context : null,
              tier,
              limits: model ? { rpm: model.rpm, rpd: model.rpd, tpm: model.tpm, tpd: model.tpd } : undefined,
            }),
          });
          ok++;
        } catch (err) {
          failed.push((model ? model.name || modelId : modelId) + ": " + err.message);
        }
      }
      const label = provider ? provider.name : providerId;
      if (ok && !failed.length) {
        toast("Added " + ok + " " + label + " model" + (ok === 1 ? "" : "s") + " to Free Lane", "ok");
        state.modalProviderId = null;
        state.selectedModels = new Set();
        await loadFreetier();
      } else if (ok) {
        toast("Added " + ok + " of " + modelIds.length + " " + label + " models — " + failed.length + " failed", "err");
        state.selectedModels = new Set();
        await loadFreetier();
      } else {
        if (msgEl) { msgEl.className = "form-msg err"; msgEl.textContent = failed[0] || "Add failed"; }
        else toast("Add failed: " + (failed[0] || ""), "err");
      }
      return;
    }

    // Actions on an already-connected key card (see connectedSectionHtml) —
    // loadFreetier() re-renders the whole page, but since state.modalProviderId
    // stays set, renderFreetier() re-populates and keeps this modal open with
    // fresh data rather than closing it.
    const toggle = e.target.closest("[data-ft-toggle]");
    if (toggle) {
      const id = toggle.dataset.ftToggle;
      const k = state.keys.find((x) => x.id === id);
      try {
        await api("/api/freetier/" + encodeURIComponent(id), { method: "PATCH", body: JSON.stringify({ enabled: !(k && k.enabled) }) });
        await loadFreetier();
      } catch (err) { toast("Update failed: " + err.message, "err"); }
      return;
    }

    const del = e.target.closest("[data-ft-del]");
    if (del) {
      const id = del.dataset.ftDel;
      if (!confirm("Remove this free-tier key?")) return;
      try {
        await api("/api/freetier/" + encodeURIComponent(id), { method: "DELETE" });
        await loadFreetier();
        toast("Removed", "ok");
      } catch (err) { toast("Remove failed: " + err.message, "err"); }
      return;
    }

    const up = e.target.closest("[data-ft-up]");
    const down = e.target.closest("[data-ft-down]");
    if (up || down) {
      const id = (up || down).dataset.ftUp || (up || down).dataset.ftDown;
      const k = state.keys.find((x) => x.id === id);
      if (!k) return;
      const tierIds = state.keys.filter((x) => x.tier === k.tier).map((x) => x.id);
      const idx = tierIds.indexOf(id);
      const swapWith = up ? idx - 1 : idx + 1;
      if (swapWith < 0 || swapWith >= tierIds.length) return;
      [tierIds[idx], tierIds[swapWith]] = [tierIds[swapWith], tierIds[idx]];
      try {
        await api("/api/freetier/reorder", { method: "POST", body: JSON.stringify({ ids: tierIds }) });
        await loadFreetier();
      } catch (err) { toast("Reorder failed: " + err.message, "err"); }
      return;
    }
  });

  // Checkbox toggles use `change` (fires reliably on click AND keyboard),
  // unlike the button/link actions above which use `click`.
  modal.addEventListener("change", (e) => {
    const cb = e.target.closest("[data-ft-select-model]");
    if (!cb) return;
    const key = cb.dataset.ftSelectModel;
    if (cb.checked) state.selectedModels.add(key);
    else state.selectedModels.delete(key);
    renderModalResultsOnly();
  });

  // Live filter as you type — updates only the results list (see
  // renderModalResultsOnly) so the input never loses focus/cursor position.
  modal.addEventListener("input", (e) => {
    const search = e.target.closest("[data-ft-modal-search]");
    if (!search) return;
    state.modalSearch = search.value;
    renderModalResultsOnly();
  });
}
