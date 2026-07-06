// views/projectswitch.js — the GLOBAL project switcher (#9). Lives in the tab
// row (#globalProject) and holds the canonical project filter in store.state.
// The history browser (now embedded at the bottom of the Runs page) owns its own
// project filter (#historyProject); this module keeps the two in agreement by
// pushing the global choice into that select (and reusing its change handler), so
// nothing in the history browser module needs to change.
import { $ } from "../dom.js";
import { esc, fmtNum } from "../format.js";
import { state } from "../store.js";
import { api } from "../api.js";
import { toast } from "../components/toast.js";

// Build the <option> list from the cached projects (store.state.projects).
function optionsHTML() {
  const opts = ['<option value="">All projects</option>'];
  for (const p of state.projects || []) {
    const id = p.project_id;
    if (!id) continue;
    const label = (p.name || id) + " (" + fmtNum(p.runs) + (p.active ? ", " + p.active + " live" : "") + ")";
    opts.push('<option value="' + esc(id) + '"' + (state.project === id ? " selected" : "") + ">" + esc(label) + "</option>");
  }
  return opts.join("");
}

export function populateGlobalProject() {
  const sel = $("#globalProject");
  if (!sel) return;
  sel.innerHTML = optionsHTML();
  // Keep the DOM value pinned to state even if the selected option was rebuilt.
  sel.value = state.project || "";
}

export async function loadGlobalProjects() {
  try {
    const r = await api("/api/projects");
    state.projects = (r && Array.isArray(r.projects)) ? r.projects : [];
  } catch (err) {
    state.projects = [];
    toast("Load projects failed: " + err.message, "err");
  }
  populateGlobalProject();
}

// Push the global project value into History's own select and fire the change
// it already listens for. Best-effort: only acts when the matching option is
// present (History loads its own /api/projects independently, so on a cold
// first visit the option may not exist yet — a no-op then, corrected on the
// next visit once both selects share the same option set).
export function syncGlobalProjectInto() {
  const hp = $("#historyProject");
  if (!hp) return;
  const want = state.project || "";
  if (hp.value === want) return;
  const has = Array.prototype.some.call(hp.options, (o) => o.value === want);
  if (!has) return;
  hp.value = want;
  hp.dispatchEvent(new Event("change", { bubbles: true }));
}

export function initGlobalProject() {
  const sel = $("#globalProject");
  if (sel) {
    sel.addEventListener("change", () => {
      state.project = sel.value || "";
      // The history browser lives on the Runs page now — if it's on screen, drive
      // its own filter to match immediately.
      if (state.page === "runs") syncGlobalProjectInto();
    });
  }
  loadGlobalProjects();
}
