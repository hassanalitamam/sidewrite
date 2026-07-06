// views/privacy.js — Privacy & Data panel: what Sidewrite stores locally, a
// plain-language telemetry disclosure (default OFF), and a confirm-gated purge.
//
// Wiring-pass contract (this module never touches viewer.html/router.js/etc.):
//   - Mount point: a single empty container the page section wraps, id
//     "#privacyRoot". render() replaces its entire innerHTML each call.
//   - Router hook:  enterPrivacy()  — call when the "privacy" page tab is
//     shown (mirrors enterSkills()). Fetches fresh data every visit since a
//     purge on this page changes the numbers.
//   - Boot-time wiring: wirePrivacy() — call once from main.boot(), same
//     spot as wireSkills()/wireProviders(). Sets up event delegation on
//     #privacyRoot, so it only needs to run once (it survives re-renders).
// No other file needs to know about privacyState.
import { $, icon } from "../dom.js";
import { esc, fmtNum } from "../format.js";
import { api } from "../api.js";
import { toast } from "../components/toast.js";

const privacyState = {
  storage: null,     // { db_bytes, tables:{runs,events,costs,reviews,projects}, run_sidecars, telemetry_queue:{files,bytes}, providers }
  telemetry: null,   // { level, enabled, disclosure:{summary, neverSent[], sentWhenOn[]} }
  loading: false,
  armed: false,       // purge button unlocked (user typed the confirm phrase)
};

const CONFIRM_PHRASE = "DELETE";

const LEVEL_LABEL = {
  off: "Off — nothing leaves this machine (default)",
  crash: "Crash — anonymized crash signatures only",
  error: "Crash + error — anonymized crash and error counters",
  all: "All — anonymized crash, error, and usage counters",
};

function fmtBytes(n) {
  n = Number(n) || 0;
  if (n < 1024) return n + " B";
  const units = ["KB", "MB", "GB", "TB"];
  let u = -1;
  do { n /= 1024; u++; } while (n >= 1024 && u < units.length - 1);
  return n.toFixed(n >= 10 || u === 0 ? 0 : 1) + " " + units[u];
}

// ---- data load ----
export async function loadPrivacy() {
  privacyState.loading = true;
  renderPrivacy();
  try {
    const r = await api("/api/data/summary");
    privacyState.storage = (r && r.storage) || null;
    privacyState.telemetry = (r && r.telemetry) || null;
  } catch (err) {
    privacyState.storage = null;
    privacyState.telemetry = null;
    toast("Load privacy summary failed: " + err.message, "err");
  }
  privacyState.loading = false;
  renderPrivacy();
}

// Router enter hook — always refetch (a purge on this page changes counts).
export function enterPrivacy() {
  loadPrivacy();
}

// ---- render ----
function renderTelemetryCard() {
  const t = privacyState.telemetry;
  if (!t) return "";
  const on = !!t.enabled;
  const d = t.disclosure || {};
  const never = Array.isArray(d.neverSent) ? d.neverSent : [];
  const sent = Array.isArray(d.sentWhenOn) ? d.sentWhenOn : [];
  const levels = ["off", "crash", "error", "all"];
  const levelOpts = levels.map((lv) =>
    '<option value="' + lv + '"' + (t.level === lv ? " selected" : "") + ">" + esc(LEVEL_LABEL[lv] || lv) + "</option>"
  ).join("");

  const row = (i, text) => '<div style="display:flex; align-items:center; gap:8px; padding:5px 0; font-size:12.5px; color:var(--ink-body);">' +
    i + "<span>" + esc(text) + "</span></div>";
  const neverList = never.map((s) => row(icon("check", "sm"), s)).join("");
  const sentList = on && sent.length
    ? sent.map((s) => row(icon("running", "sm"), s)).join("")
    : row(icon("check", "sm"), "Nothing — telemetry is off.");

  return '<div class="card">' +
    '<div class="card-head"><div class="card-title" style="margin:0">Telemetry</div>' +
      '<span class="badge' + (on ? "" : " ok") + '"><span class="bdot' + (on ? " pulse" : "") + '"></span>' +
      (on ? "on — " + esc(t.level) : "off") + "</span>" +
    "</div>" +
    '<p class="meta" style="margin-top:10px; line-height:1.6; font-size:13px;">' + esc(d.summary || "") + "</p>" +
    '<div class="grid two" style="margin-top:16px;">' +
      '<div><div class="field-lbl">Never sent, ever</div>' + neverList + "</div>" +
      '<div><div class="field-lbl">Sent only when telemetry is on</div>' + sentList + "</div>" +
    "</div>" +
    '<div class="field" style="margin-top:16px; max-width:420px;">' +
      '<label for="privacyTelemetryLevel">Telemetry level</label>' +
      '<select id="privacyTelemetryLevel" class="msel">' + levelOpts + "</select>" +
      '<div class="hint">Changing this only affects what Sidewrite is <em>allowed</em> to send — it never turns itself back on.</div>' +
    "</div>" +
    '<div class="form-msg" id="privacyTelemetryMsg"></div>' +
  "</div>";
}

function renderStorageCard() {
  const s = privacyState.storage;
  if (!s) return "";
  const tb = s.tables || {};
  const q = s.telemetry_queue || { files: 0, bytes: 0 };
  const rows = [
    ["Runs", fmtNum(tb.runs)],
    ["Events", fmtNum(tb.events)],
    ["Cost rows", fmtNum(tb.costs)],
    ["Review findings", fmtNum(tb.reviews)],
    ["Projects", fmtNum(tb.projects)],
    ["Run sidecar folders", fmtNum(s.run_sidecars)],
    ["Queued telemetry files", fmtNum(q.files) + (q.files ? " (" + fmtBytes(q.bytes) + ")" : "")],
    ["Configured providers", fmtNum(s.providers)],
    ["Database size", fmtBytes(s.db_bytes)],
  ];
  const kv = rows.map(([k, v]) => "<div>" + esc(k) + "</div><div class=\"mono\" style=\"text-align:right\">" + v + "</div>").join("");
  return '<div class="card">' +
    '<div class="card-head"><div class="card-title" style="margin:0">What\'s stored locally</div></div>' +
    '<p class="meta" style="margin-top:2px;">Everything below lives in <code>~/.sidewrite</code> on this machine. Nothing here is uploaded anywhere unless telemetry is explicitly turned on above.</p>' +
    '<div class="kv" style="margin-top:14px;">' + kv + "</div>" +
  "</div>";
}

function renderPurgeCard() {
  const s = privacyState.storage;
  const disabledAttr = s ? "" : " disabled";
  return '<div class="card">' +
    '<div class="card-head"><div class="card-title" style="margin:0; color:var(--err)">Delete local data</div></div>' +
    '<p class="meta" style="margin-top:2px;">Permanent. Deletes rows from the local database and files on disk — it does not touch anything remote (there is nothing remote unless telemetry is on).</p>' +
    '<div style="display:flex; align-items:center; gap:8px; margin-top:14px; font-size:13px; color:var(--ink);">' +
      '<label style="display:flex; align-items:center; gap:8px; cursor:pointer;"><input type="checkbox" id="privacyPurgeRuns"' + disabledAttr + "> Runs, events &amp; cost history <span style=\"color:var(--ink-muted); font-size:12px;\">(includes per-run sidecar files)</span></label>" +
    "</div>" +
    '<div style="display:flex; align-items:center; gap:8px; margin-top:10px; font-size:13px; color:var(--ink);">' +
      '<label style="display:flex; align-items:center; gap:8px; cursor:pointer;"><input type="checkbox" id="privacyPurgeTelemetry"' + disabledAttr + "> Queued telemetry files on disk</label>" +
    "</div>" +
    '<div class="field" style="max-width:320px; margin-top:14px;">' +
      '<label for="privacyPurgeConfirm">Type <code>' + CONFIRM_PHRASE + "</code> to confirm</label>" +
      '<input type="text" id="privacyPurgeConfirm" class="tf mono" autocomplete="off" placeholder="' + CONFIRM_PHRASE + '"' + disabledAttr + ">" +
    "</div>" +
    '<button class="btn primary" id="privacyPurgeBtn" disabled style="border-color:var(--err); background:var(--err);">' +
      icon("x", "sm") + " Permanently delete selected data</button>" +
    '<div class="form-msg" id="privacyPurgeMsg"></div>' +
  "</div>";
}

export function renderPrivacy() {
  const root = $("#privacyRoot");
  if (!root) return;
  if (privacyState.loading && !privacyState.storage && !privacyState.telemetry) {
    root.innerHTML = '<div class="empty">Loading privacy &amp; data…</div>';
    return;
  }
  if (!privacyState.storage && !privacyState.telemetry) {
    root.innerHTML = '<div class="empty">Could not load privacy &amp; data. <button class="btn" id="privacyRetry">Retry</button></div>';
    return;
  }
  root.innerHTML =
    '<div class="grid" style="gap:18px;">' +
      renderTelemetryCard() +
      renderStorageCard() +
      renderPurgeCard() +
    "</div>";
  updatePurgeArmed();
}

// ---- purge arming: require BOTH a checked scope and the typed phrase ----
function updatePurgeArmed() {
  const btn = $("#privacyPurgeBtn");
  if (!btn) return;
  const runs = $("#privacyPurgeRuns");
  const telemetry = $("#privacyPurgeTelemetry");
  const confirmInput = $("#privacyPurgeConfirm");
  const anyScope = !!((runs && runs.checked) || (telemetry && telemetry.checked));
  const phraseOk = !!(confirmInput && confirmInput.value.trim() === CONFIRM_PHRASE);
  btn.disabled = !(anyScope && phraseOk);
}

// ---- wiring (call once at boot; delegates on #privacyRoot, survives re-renders) ----
export function wirePrivacy() {
  const root = $("#privacyRoot");
  if (!root) return;

  root.addEventListener("input", (e) => {
    if (e.target.id === "privacyPurgeConfirm") updatePurgeArmed();
  });
  root.addEventListener("change", async (e) => {
    if (e.target.id === "privacyPurgeRuns" || e.target.id === "privacyPurgeTelemetry") {
      updatePurgeArmed();
      return;
    }
    if (e.target.id === "privacyTelemetryLevel") {
      const level = e.target.value;
      const msg = $("#privacyTelemetryMsg");
      if (msg) { msg.className = "form-msg"; msg.textContent = "Saving…"; }
      try {
        await api("/api/config/safe", { method: "POST", body: JSON.stringify({ telemetry: { level } }) });
        toast("Telemetry: " + level, "ok");
        await loadPrivacy();
      } catch (err) {
        if (msg) { msg.className = "form-msg err"; msg.textContent = err.message; }
        toast("Telemetry update failed: " + err.message, "err");
      }
    }
  });
  root.addEventListener("click", async (e) => {
    if (e.target.closest && e.target.closest("#privacyRetry")) { loadPrivacy(); return; }
    const btn = e.target.closest && e.target.closest("#privacyPurgeBtn");
    if (!btn || btn.disabled) return;
    const runs = $("#privacyPurgeRuns");
    const telemetry = $("#privacyPurgeTelemetry");
    const scope = { runs: !!(runs && runs.checked), telemetry: !!(telemetry && telemetry.checked) };
    if (!confirm("This permanently deletes the selected local data. This cannot be undone. Continue?")) return;
    const msg = $("#privacyPurgeMsg");
    btn.disabled = true;
    if (msg) { msg.className = "form-msg"; msg.textContent = "Deleting…"; }
    try {
      const r = await api("/api/data/purge", { method: "POST",
        body: JSON.stringify({ confirm: true, runs: scope.runs, telemetry: scope.telemetry }) });
      const p = (r && r.purged) || {};
      const parts = [];
      if (p.runs) parts.push(fmtNum(p.runs) + " runs");
      if (p.events) parts.push(fmtNum(p.events) + " events");
      if (p.run_sidecars) parts.push(fmtNum(p.run_sidecars) + " run folders");
      if (p.telemetry_files) parts.push(fmtNum(p.telemetry_files) + " telemetry files");
      const summary = parts.length ? "Deleted " + parts.join(", ") + "." : "Nothing to delete.";
      if (msg) { msg.className = "form-msg ok"; msg.textContent = summary; }
      toast(summary, "ok");
      await loadPrivacy();
    } catch (err) {
      if (msg) { msg.className = "form-msg err"; msg.textContent = err.message; }
      toast("Purge failed: " + err.message, "err");
      btn.disabled = false;
    }
  });
}
