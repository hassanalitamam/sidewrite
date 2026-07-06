// views/worker.js — the worker snapshot view (rendered into #runsRoot / #snapBody).
import { $, icon } from "../dom.js";
import { esc, fmtNum, fmtUSD, WK } from "../format.js";
import { state, ensureRun } from "../store.js";
import { api } from "../api.js";

// Count tool_use per worker from the per-run log.
export function toolBreakdown(r, w) {
  const counts = {};
  for (const e of (r.log || [])) {
    if (e.type === "tool_use" && WK(e.worker) === w) {
      const n = e.tool || "tool";
      counts[n] = (counts[n] || 0) + 1;
    }
  }
  return Object.keys(counts).map((n) => ({ name: n, count: counts[n] })).sort((a, b) => b.count - a.count);
}

export function snapshotCardHTML(id, w, ws, snap) {
  const r = state.runs[id] || ensureRun(id);
  if (!ws) ws = { worker: w, status: null, branch: null, diff_stat: null, pass: null, files: [], tokensIn: 0, tokensOut: 0, cacheRead: 0, cacheCreate: 0, usd: 0 };

  const passBadge = ws.pass === true ? '<span class="badge ok">' + icon("check", "sm") + "passed</span>"
    : ws.pass === false ? '<span class="badge err">' + icon("x", "sm") + "failed</span>"
    : "";

  const files = ws.files || [];
  const filesHTML = files.length
    ? '<div class="filelist">' + files.map((f) => {
        const cls = f.action === "delete" ? "D" : "M";
        return '<div><span class="fchip ' + cls + '">' + cls + '</span><span class="fpath">' + esc(f.path) + "</span></div>";
      }).join("") + "</div>"
    : '<div class="empty" style="padding:20px">No files recorded for this worker.</div>';

  const tools = toolBreakdown(r, w);
  const maxCount = tools.reduce((m, t) => Math.max(m, t.count), 0) || 1;
  const toolsHTML = tools.length
    ? tools.map((t) => {
        const pct = Math.round((t.count / maxCount) * 100);
        return '<div class="toolbar-row"><span class="tname">' + esc(t.name) + "</span>" +
          '<span class="toolbar-track"><span class="toolbar-fill" style="width:' + pct + '%"></span></span>' +
          '<span class="tcount">' + t.count + "</span></div>";
      }).join("")
    : '<div class="empty" style="padding:20px">No tool activity captured.</div>';

  return '<div class="section grid two rise">' +
    '<div class="card">' +
      '<p class="eyebrow">Snapshot' + (passBadge ? "&nbsp;" + passBadge : "") + "</p>" +
      '<dl class="kv">' +
        "<dt>status</dt><dd>" + esc(ws.status || "—") + "</dd>" +
        '<dt>branch</dt><dd class="branch">' + esc(ws.branch || "—") + "</dd>" +
        "<dt>diff</dt><dd>" + esc(ws.diff_stat || "—") + "</dd>" +
        "<dt>source</dt><dd>" + esc(snap.source || "—") + "</dd>" +
        '<dt>cost</dt><dd style="color:var(--accent)">' + fmtUSD(ws.usd || 0) + "</dd>" +
        "<dt>tokens</dt><dd>in " + fmtNum(ws.tokensIn || 0) + " · out " + fmtNum(ws.tokensOut || 0) + " · cache-r " + fmtNum(ws.cacheRead || 0) + "</dd>" +
      "</dl>" +
    "</div>" +
    '<div style="display:flex; flex-direction:column; gap:14px;">' +
      '<div class="card">' +
        '<p class="eyebrow">' + icon("file", "sm") + 'Files changed <span class="count">(' + files.length + ")</span></p>" +
        filesHTML +
      "</div>" +
      '<div class="card">' +
        '<p class="eyebrow">Tools used</p>' +
        toolsHTML +
      "</div>" +
    "</div>" +
  "</div>";
}

export function renderWorkerSnapshot(id, worker) {
  const root = $("#runsRoot");
  if (!root) return;
  const r = state.runs[id] || ensureRun(id);
  const w = WK(worker);
  const wt = (r.workers[w] && r.workers[w].title) ? " · " + esc(r.workers[w].title) : "";
  root.innerHTML =
    '<button class="back" data-nav="run" data-run="' + esc(id) + '">' + icon("back", "sm") + "Run " + esc(id) + "</button>" +
    '<div class="detail-head rise">' +
      "<div><h1 class=\"pagehead\">Worker #" + w + wt + "</h1>" +
      '<div class="headmeta"><span class="k">' + esc(id) + "-w" + w + "</span>" +
        (r.provider ? '<span class="sep">·</span>' + esc(r.provider) + (r.model ? " / " + esc(r.model) : "") : "") + "</div></div>" +
    "</div>" +
    '<div id="snapBody"><div class="empty" style="padding:40px"><span class="ei">' + icon("running", "spin") + "</span>Loading snapshot…</div></div>";
  fetchSnapshot(id, w);
}

// GET /api/runs/:id/snapshot — guards against stale navigation.
export async function fetchSnapshot(id, w) {
  let snap = null;
  try { snap = await api("/api/runs/" + encodeURIComponent(id) + "/snapshot"); } catch (_) {}
  // bail if the user navigated away while the request was in flight
  if (!(state.view === "worker" && state.focusRunId === id && WK(state.focusWorker) === w)) return;
  const body = $("#snapBody");
  if (!body) return;
  if (!snap || snap.ok === false) {
    body.innerHTML = '<div class="empty" style="padding:40px"><span class="et">Snapshot unavailable</span>No snapshot for this run yet.</div>';
    return;
  }
  const ws = (snap.workers || []).find((x) => WK(x.worker) === w) || null;
  body.innerHTML = snapshotCardHTML(id, w, ws, snap);
}
