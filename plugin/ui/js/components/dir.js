// components/dir.js — text-direction (LTR / RTL) toggle. The user works in
// Arabic, so the whole shell can flip to right-to-left. Sets `dir` on <html>
// (the daemon wraps this file in the doctype/head/body skeleton, so there is no
// static <html> tag to author — we stamp it at runtime, same as theme.js does
// for data-theme). CSS uses logical properties + a small [dir=rtl] override
// block so the layout mirrors cleanly. Choice persists in localStorage.
import { $ } from "../dom.js";

export function initDir() {
  const root = document.documentElement;
  const btn = $("#dirBtn");

  function apply(dir) {
    const rtl = dir === "rtl";
    root.setAttribute("dir", rtl ? "rtl" : "ltr");
    if (btn) btn.setAttribute("aria-pressed", rtl ? "true" : "false");
  }

  let saved = null;
  try { saved = localStorage.getItem("sidewrite-dir"); } catch (_) {}
  apply(saved === "rtl" ? "rtl" : "ltr");

  if (btn) {
    btn.addEventListener("click", () => {
      const next = root.getAttribute("dir") === "rtl" ? "ltr" : "rtl";
      try { localStorage.setItem("sidewrite-dir", next); } catch (_) {}
      apply(next);
    });
  }
}
