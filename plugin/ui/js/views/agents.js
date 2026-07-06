// views/agents.js — Sub-agents section of the Studio page. Custom sub-agents
// defined here are materialized as a real agents/<name>.md in every station
// (the native Claude Code convention), so one you define once is usable no
// matter which provider/model a run ends up on — mirrors the Skills section's
// "global, not per-provider" model (see views/skills.js).
//
// Owned by views/studio.js, which merges this section with Skills + MCP into
// one segmented page (#pageStudio):
//   enterAgents() — called from studio.js's enterStudio(): loads + renders.
//   wireAgents()  — one-time event delegation, call at boot.
//
// Expected markup: <div id="studioAgentsPane"><div id="agentsRoot"></div></div>
// renderAgents() owns 100% of #agentsRoot's innerHTML.

import { $ } from "../dom.js";
import { esc } from "../format.js";
import { api } from "../api.js";
import { toast } from "../components/toast.js";

const MODEL_LABEL = { inherit: "inherit (session model)", sonnet: "sonnet", opus: "opus", haiku: "haiku" };

const state = {
  loaded: false,
  agents: [],
  formOpen: false,
  editingId: null, // non-null while editing an existing agent (name becomes read-only)
  maxConcurrency: null, // null = use bin/sidewrite-run's nproc-based default
};

export function enterAgents() {
  loadAgents();
  loadConcurrency();
}

async function loadConcurrency() {
  try {
    const r = await api("/api/config");
    state.maxConcurrency = (r && r.parallel && Number.isInteger(r.parallel.maxConcurrency)) ? r.parallel.maxConcurrency : null;
  } catch (_) {
    state.maxConcurrency = null;
  }
  renderConcurrency();
}

function renderConcurrency() {
  const input = $("#agConcurrency");
  if (input && document.activeElement !== input) input.value = state.maxConcurrency == null ? "" : String(state.maxConcurrency);
}

export async function loadAgents() {
  try {
    const r = await api("/api/agents");
    state.agents = (r && Array.isArray(r.agents)) ? r.agents : [];
    state.loaded = true;
  } catch (err) {
    state.agents = [];
    toast("Load sub-agents failed: " + err.message, "err");
  }
  renderAgents();
}

function formHtml(editing) {
  const nameDisabled = editing ? ' disabled title="name can\'t be changed after creation"' : "";
  const name = editing ? editing.name : "";
  const description = editing ? editing.description : "";
  const instructions = editing ? editing.instructions : "";
  const model = editing ? editing.model : "inherit";
  return (
    '<div class="card" style="padding:14px; margin-top:12px;" id="agentForm">' +
      '<p class="eyebrow">' + (editing ? "Edit sub-agent" : "New sub-agent") + "</p>" +
      '<div class="fields">' +
        '<div class="field">' +
          '<label class="field-lbl" for="agName">Name <span class="hint">(lowercase-hyphenated, e.g. "debug-helper")</span></label>' +
          '<input type="text" class="tf" id="agName" value="' + esc(name) + '"' + nameDisabled + ' placeholder="debug-helper" autocomplete="off">' +
        "</div>" +
        '<div class="field">' +
          '<label class="field-lbl" for="agModel">Model</label>' +
          '<select class="msel" id="agModel">' +
            Object.keys(MODEL_LABEL).map((m) => '<option value="' + m + '"' + (m === model ? " selected" : "") + ">" + MODEL_LABEL[m] + "</option>").join("") +
          "</select>" +
        "</div>" +
        '<div class="field full">' +
          '<label class="field-lbl" for="agDescription">Description <span class="hint">(when Claude Code should delegate to it)</span></label>' +
          '<input type="text" class="tf" id="agDescription" value="' + esc(description) + '" placeholder="Use for root-causing bugs before writing a fix" autocomplete="off">' +
        "</div>" +
        '<div class="field full">' +
          '<label class="field-lbl" for="agInstructions">Instructions</label>' +
          '<textarea class="tf" id="agInstructions" rows="6" placeholder="Always reproduce the bug first, then explain the root cause before writing a fix.">' + esc(instructions) + "</textarea>" +
        "</div>" +
      "</div>" +
      '<div style="display:flex; gap:12px; align-items:center; margin-top:10px;">' +
        '<button type="button" class="btn primary" id="agSave">' + (editing ? "Save changes" : "Create") + "</button>" +
        '<button type="button" class="btn" id="agCancel">Cancel</button>' +
        '<span class="form-msg" id="agFormMsg"></span>' +
      "</div>" +
      '<div class="hint" style="margin-top:8px;">Applies everywhere — creating or editing fans <span class="cmd mono">agents/' + esc(name || "&lt;name&gt;") + '.md</span> into every station instantly, and into any station launched later.</div>' +
    "</div>"
  );
}

export function renderAgents() {
  const root = $("#agentsRoot");
  if (!root) return;
  const editing = state.editingId ? state.agents.find((a) => a.id === state.editingId) : null;

  const rows = state.agents.map((a) => {
    return "<tr>" +
      '<td><div class="skname">' + esc(a.name) + '</div><div class="skdesc">' + esc(a.description || "") + "</div></td>" +
      "<td><span class=\"srctag\">" + esc(MODEL_LABEL[a.model] || a.model) + "</span></td>" +
      '<td style="white-space:nowrap;">' +
        '<button type="button" class="btn" data-edit="' + esc(a.id) + '">Edit</button> ' +
        '<button type="button" class="btn" data-del="' + esc(a.id) + '" data-name="' + esc(a.name) + '">Delete</button>' +
      "</td>" +
    "</tr>";
  }).join("");

  const tableHtml = state.agents.length
    ? '<div class="tablewrap"><table class="sk"><thead><tr><th>Sub-agent</th><th style="width:160px">Model</th><th style="width:160px"></th></tr></thead><tbody>' + rows + "</tbody></table></div>"
    : '<div class="empty">' + (state.loaded ? "No sub-agents defined yet." : "Loading…") + "</div>";

  const addBtn = state.formOpen ? "" : '<button type="button" class="btn primary" id="agAddToggle"><svg class="icon sm" aria-hidden="true"><use href="#ic-plus"></use></svg>New sub-agent</button>';

  const concurrencyRow =
    '<div class="selrow" style="gap:10px; flex-wrap:wrap; margin-bottom:12px;">' +
      '<span class="hint" title="Caps how many disjoint sidewrite run parallel workers execute at once. Blank = automatic (based on CPU count).">Max concurrent workers</span>' +
      '<input type="number" class="tf" id="agConcurrency" min="1" max="16" placeholder="auto" style="max-width:80px;">' +
      '<button type="button" class="btn" id="agConcurrencySave">Save</button>' +
      '<span class="form-msg" id="agConcurrencyMsg"></span>' +
    "</div>";

  root.innerHTML =
    '<div class="hint" style="margin-bottom:10px;">A sub-agent defined here works on every provider/model, now and for any station launched later. Claude Code auto-delegates to it based on its description, the same way built-in subagents work.</div>' +
    concurrencyRow +
    '<div class="selrow">' + addBtn + "</div>" +
    tableHtml +
    (state.formOpen ? formHtml(editing) : "");
  renderConcurrency();
}

export function wireAgents() {
  const root = $("#agentsRoot");
  if (!root) return;

  root.addEventListener("click", async (e) => {
    if (e.target.closest("#agConcurrencySave")) {
      const input = $("#agConcurrency");
      const msg = $("#agConcurrencyMsg");
      const raw = input ? input.value.trim() : "";
      const value = raw === "" ? null : Number(raw);
      if (raw !== "" && (!Number.isInteger(value) || value < 1 || value > 16)) {
        if (msg) { msg.className = "form-msg err"; msg.textContent = "Enter a whole number 1-16, or leave blank for automatic."; }
        return;
      }
      if (msg) { msg.className = "form-msg"; msg.textContent = "Saving…"; }
      try {
        await api("/api/config", { method: "POST", body: JSON.stringify({ parallel: { maxConcurrency: value } }) });
        state.maxConcurrency = value;
        if (msg) { msg.className = "form-msg ok"; msg.textContent = "Saved."; }
        toast("Parallel concurrency updated", "ok");
      } catch (err) {
        if (msg) { msg.className = "form-msg err"; msg.textContent = err.message; }
      }
      return;
    }
    if (e.target.closest("#agAddToggle")) {
      state.editingId = null;
      state.formOpen = true;
      renderAgents();
      return;
    }
    if (e.target.closest("#agCancel")) {
      state.formOpen = false;
      state.editingId = null;
      renderAgents();
      return;
    }
    const editBtn = e.target.closest("[data-edit]");
    if (editBtn) {
      state.editingId = editBtn.dataset.edit;
      state.formOpen = true;
      renderAgents();
      return;
    }
    const delBtn = e.target.closest("[data-del]");
    if (delBtn) {
      const name = delBtn.dataset.name;
      if (!confirm('Delete sub-agent "' + name + '"? It will be removed from every station.')) return;
      try {
        await api("/api/agents/" + encodeURIComponent(delBtn.dataset.del), { method: "DELETE" });
        toast("Deleted " + name, "ok");
        await loadAgents();
      } catch (err) {
        toast("Delete failed: " + err.message, "err");
      }
      return;
    }
    if (e.target.closest("#agSave")) {
      const nameEl = $("#agName");
      const name = nameEl ? nameEl.value.trim().toLowerCase() : "";
      const description = ($("#agDescription") || {}).value || "";
      const instructions = ($("#agInstructions") || {}).value || "";
      const model = ($("#agModel") || {}).value || "inherit";
      const msg = $("#agFormMsg");
      const saveBtn = $("#agSave");
      if (msg) { msg.className = "form-msg"; msg.textContent = "Saving + applying to every station…"; }
      if (saveBtn) saveBtn.disabled = true;
      try {
        if (state.editingId) {
          await api("/api/agents/" + encodeURIComponent(state.editingId), { method: "PATCH", body: JSON.stringify({ description, instructions, model }) });
          toast("Updated sub-agent", "ok");
        } else {
          if (!name) throw new Error("Name is required.");
          await api("/api/agents", { method: "POST", body: JSON.stringify({ name, description, instructions, model }) });
          toast("Created sub-agent", "ok");
        }
        state.formOpen = false;
        state.editingId = null;
        await loadAgents();
      } catch (err) {
        if (msg) { msg.className = "form-msg err"; msg.textContent = err.message; }
        if (saveBtn) saveBtn.disabled = false;
      }
    }
  });
}
