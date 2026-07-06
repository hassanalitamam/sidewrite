// dom.js — DOM + inline-sprite helpers. The only module that knows how to reach
// elements and emit an icon.
export const $  = (s, r = document) => r.querySelector(s);
export const $$ = (s, r = document) => Array.from(r.querySelectorAll(s));

// icon(name, cls) → an <svg> that references the inline sprite symbol #ic-<name>.
// Verbatim from the v2 prototype (crisp 1.5px stroke, currentColor).
export function icon(name, cls) {
  return '<svg class="icon ' + (cls || "") + '" aria-hidden="true"><use href="#ic-' + name + '"></use></svg>';
}

// mount(id) — convenience for view roots.
export function mount(id) {
  return $("#" + id);
}
