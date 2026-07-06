// components/theme.js — light/dark toggle. Stamps data-theme on :root and swaps
// the topbar sun/moon icon. Verbatim behaviour from the v2 prototype.
import { $, icon } from "../dom.js";

export function initTheme() {
  const root = document.documentElement;
  const themeBtn = $("#themeBtn");

  function applyTheme(t) {
    if (t === "light" || t === "dark") root.setAttribute("data-theme", t);
    else root.removeAttribute("data-theme");
    const dark = t === "dark" || (t == null && matchMedia("(prefers-color-scheme: dark)").matches);
    if (themeBtn) themeBtn.innerHTML = icon(dark ? "sun" : "moon");
  }

  let saved = null;
  try { saved = localStorage.getItem("sidewrite-theme"); } catch (_) {}
  applyTheme(saved);

  if (themeBtn) {
    themeBtn.addEventListener("click", () => {
      const cur = root.getAttribute("data-theme");
      const isDark = cur ? cur === "dark" : matchMedia("(prefers-color-scheme: dark)").matches;
      const next = isDark ? "light" : "dark";
      try { localStorage.setItem("sidewrite-theme", next); } catch (_) {}
      applyTheme(next);
    });
  }
}
