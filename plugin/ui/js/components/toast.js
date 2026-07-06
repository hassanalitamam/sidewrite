// components/toast.js — the #toasts host.
// Behaviour parity with the current dashboard: toast(msg, "err"|"ok") renders a
// plain accented toast. Also supports the prototype's tagged style via
// toast(msg, { tag: "skills" }) → <span class="tg">skills</span> msg.
import { $ } from "../dom.js";
import { esc } from "../format.js";

export function toast(msg, kind = "") {
  const host = $("#toasts");
  if (!host) return;
  const el = document.createElement("div");
  if (kind && typeof kind === "object" && kind.tag) {
    el.className = "toast";
    el.innerHTML = '<span class="tg">' + esc(kind.tag) + '</span> ' + esc(msg);
  } else {
    el.className = "toast " + (kind || "");
    el.textContent = msg;
  }
  host.appendChild(el);
  setTimeout(() => { el.style.opacity = "0"; el.style.transition = "opacity .3s"; }, 3200);
  setTimeout(() => el.remove(), 3600);
}
