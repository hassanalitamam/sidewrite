// components/status.js — topbar live state: status pills + connection indicator.
import { $ } from "../dom.js";
import { esc } from "../format.js";
import { state, modeState } from "../store.js";

// renderStatus(s) — running count, active model, mode (+ optional processing).
export function renderStatus(s) {
  const wrap = $("#topbarStatus");
  if (!wrap) return;
  wrap.innerHTML = "";

  const mk = (html, cls = "") => {
    const p = document.createElement("span");
    p.className = "pill " + cls;
    p.innerHTML = html;
    wrap.appendChild(p);
  };

  const n = state.running.size;
  mk('<span class="livedot"></span><b>' + n + '</b>&nbsp;running');

  if (s && typeof s.isProcessing !== "undefined") {
    mk(s.isProcessing ? '<span class="dot"></span>running' : '<span class="dot"></span>idle', "hide-sm");
    if (s.queueDepth != null) mk('<span class="label">queue</span>&nbsp;<b>' + esc(String(s.queueDepth)) + "</b>", "hide-sm");
  }
  if (state.active.model) {
    mk('<span class="label">active model</span>&nbsp;<b class="mono">' + esc(state.active.model) + "</b>", "hide-sm");
  }
  if (modeState() !== "unknown") {
    mk('<span class="label">mode</span>&nbsp;<b>' + esc(modeState()) + "</b>", "hide-sm");
  }
}

// setConn(kind, text) — the connection indicator (#conn / #connText), styled as a pill.
export function setConn(kind, text) {
  const c = $("#conn");
  if (c) c.className = "pill conn " + kind;
  const t = $("#connText");
  if (t) t.textContent = text;
}
