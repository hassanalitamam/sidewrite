// views/skills.js — the Skills + MCP (Context7) sections of the Studio page
// (owned by views/studio.js, merged with Sub-agents — see views/agents.js).
// A skill enabled here applies to every station (provider/model) at once, now
// and for any station launched later — there is no per-provider skill selection.
import { $, $$, icon } from "../dom.js";
import { esc, fmtNum } from "../format.js";
import { api } from "../api.js";
import { toast } from "../components/toast.js";

const skillsState = { loaded: false, skills: [], essential: [] };

// Enter hook for the router.
export function enterSkills() {
  loadSkills();
  loadContext7();
}

export function skillsEnabledCostTotal() {
  return (skillsState.skills || []).filter((s) => s.enabled).reduce((a, s) => a + (Number(s.tokenCost) || 0), 0);
}

export function renderSkillsBanner() {
  const el = $("#skillsCostBanner");
  if (!el) return;
  const total = skillsEnabledCostTotal();
  el.innerHTML = "<b>Skill token cost is curation, not accumulation.</b> Every enabled SKILL.md rides each run's system prompt, on every model. Enabled globally: <b>~" +
    fmtNum(total) + "</b> tokens.";
}

export async function loadSkills() {
  renderSkillsBanner();
  try {
    const r = await api("/api/skills");
    skillsState.skills = (r && Array.isArray(r.skills)) ? r.skills : [];
    skillsState.essential = (r && Array.isArray(r.essential)) ? r.essential : [];
    skillsState.loaded = true;
  } catch (err) {
    skillsState.skills = []; skillsState.essential = [];
    toast("Load skills failed: " + err.message, "err");
  }
  renderSkills();
}

export function renderSkills() {
  renderSkillsBanner();
  const wrap = $("#skillsTableWrap");
  const empty = $("#skillsEmpty");
  if (!wrap || !empty) return;

  const skills = skillsState.skills || [];
  if (!skills.length) {
    wrap.innerHTML = "";
    empty.style.display = "block";
    empty.textContent = skillsState.loaded ? "No skills found." : "Loading…";
    return;
  }
  empty.style.display = "none";

  const rows = skills.map((s) => {
    const togglable = (s.source === "personal" || s.source === "plugin");
    const toggle = togglable
      ? '<button class="toggle" role="switch" data-toggle="1" data-name="' + esc(s.name) + '" data-source="' + esc(s.source) + '" aria-checked="' + (s.enabled ? "true" : "false") + '" aria-label="Enable skill everywhere"></button>'
      : '<span class="badge ok">on</span>';
    const srcTag = '<span class="srctag">' + esc(s.source) + (s.plugin ? ": " + esc(s.plugin) : "") + "</span>";
    return "<tr>" +
      '<td><div class="skname">' + esc(s.name) + '</div><div class="skdesc">' + esc(s.description || "") + "</div></td>" +
      "<td>" + srcTag + "</td>" +
      '<td><span class="tokbadge">~' + fmtNum(s.tokenCost) + " tok</span></td>" +
      "<td>" + toggle + "</td>" +
    "</tr>";
  }).join("");

  wrap.innerHTML =
    '<div class="tablewrap"><table class="sk">' +
      "<thead><tr>" +
        '<th>Skill</th><th style="width:110px">Source</th><th style="width:90px">Tokens</th><th style="width:70px">Enabled everywhere</th>' +
      "</tr></thead>" +
      "<tbody>" + rows + "</tbody>" +
    "</table></div>";
}

export function wireSkills() {
  const refresh = $("#skillsRefresh");
  if (refresh) refresh.addEventListener("click", loadSkills);

  const pullToggle = $("#skillsPullToggle");
  if (pullToggle) pullToggle.addEventListener("click", () => {
    const p = $("#skillsPullPanel");
    if (p) p.hidden = !p.hidden;
  });

  const pullForm = $("#skillsPullForm");
  if (pullForm) pullForm.addEventListener("submit", async (e) => {
    e.preventDefault();
    const msg = $("#skillsPullMsg"); msg.className = "form-msg"; msg.textContent = "";
    const plugin = $("#pullPlugin").value.trim();
    const marketplace = $("#pullMarketplace").value.trim();
    if (!plugin) { msg.className = "form-msg err"; msg.textContent = "Plugin spec is required."; return; }
    const btn = $("#pullSubmit"); btn.disabled = true;
    msg.className = "form-msg"; msg.textContent = "Installing into every station…";
    try {
      const r = await api("/api/skills/pull", { method: "POST",
        body: JSON.stringify({ plugin, marketplace: marketplace || undefined }) });
      if (r && r.ok === false) {
        msg.className = "form-msg err"; msg.textContent = r.error || "install failed";
      } else {
        const n = (r && r.installed) || 0;
        msg.className = "form-msg ok"; msg.textContent = "Installed into " + n + " station" + (n === 1 ? "" : "s") + ".";
        pullForm.reset();
        loadSkills();
        toast("Pulled " + plugin, "ok");
      }
    } catch (err) {
      msg.className = "form-msg err"; msg.textContent = err.message;
    } finally {
      btn.disabled = false;
    }
  });

  // Table delegation: global enable/disable toggle.
  const wrap = $("#skillsTableWrap");
  if (wrap) wrap.addEventListener("click", async (e) => {
    const tog = e.target.closest("[data-toggle]");
    if (!tog) return;
    const name = tog.dataset.name, source = tog.dataset.source;
    const enabled = tog.getAttribute("aria-checked") !== "true";
    try {
      await api("/api/skills/toggle", { method: "POST",
        body: JSON.stringify({ name, source, enabled }) });
      toast((enabled ? "Enabled " : "Disabled ") + name + " everywhere", "ok");
      loadSkills();
    } catch (err) {
      toast("Toggle failed: " + err.message, "err");
      loadSkills();
    }
  });

  // ---- Sync from Claude Code: copy chosen global ~/.claude/skills into every station ----
  const syncToggle = $("#skillsSyncToggle");
  const syncPanel = $("#skillsSyncPanel");
  const syncList = $("#skillsSyncList");
  const syncMsg = $("#skillsSyncMsg");
  const syncCopy = $("#skillsSyncCopy");
  const syncCount = $("#skillsSyncCount");
  const selected = () => $$("#skillsSyncList input[type=checkbox]:checked:not(:disabled)").map((c) => c.value);
  function updateSyncCount() {
    const n = selected().length;
    if (syncCount) syncCount.textContent = n + " selected";
    if (syncCopy) syncCopy.disabled = n === 0;
  }
  async function loadGlobalSkills() {
    if (!syncList) return;
    syncList.innerHTML = '<div class="sync-row dim">Loading your Claude Code skills…</div>';
    try {
      const r = await api("/api/skills/global");
      const skills = (r && Array.isArray(r.skills)) ? r.skills : [];
      if (!skills.length) { syncList.innerHTML = '<div class="sync-row dim">No global skills found in ~/.claude/skills.</div>'; return; }
      syncList.innerHTML = skills.map((s) => {
        const cost = s.tokenCost ? fmtNum(s.tokenCost) + " tok" : "";
        return '<label class="sync-row' + (s.inStation ? " dim" : "") + '">' +
          '<input type="checkbox" value="' + esc(s.name) + '"' + (s.inStation ? " checked disabled" : "") + ">" +
          '<span style="min-width:0; flex:1;"><span class="sync-name">' + esc(s.name) +
            (s.inStation ? '<span class="tag">in every station</span>' : "") + "</span>" +
            (s.description ? '<span class="sync-desc">' + esc(s.description) + "</span>" : "") + "</span>" +
          (cost ? '<span class="sync-cost">' + cost + "</span>" : "") +
          "</label>";
      }).join("");
      updateSyncCount();
    } catch (err) {
      syncList.innerHTML = '<div class="sync-row dim">Failed to load: ' + esc(err.message) + "</div>";
    }
  }
  if (syncToggle) syncToggle.addEventListener("click", () => {
    if (!syncPanel) return;
    syncPanel.hidden = !syncPanel.hidden;
    if (!syncPanel.hidden) loadGlobalSkills();
  });
  if (syncList) syncList.addEventListener("change", updateSyncCount);
  const syncAll = $("#skillsSyncAll");
  if (syncAll) syncAll.addEventListener("click", () => {
    const boxes = $$("#skillsSyncList input[type=checkbox]:not(:disabled)");
    const allOn = boxes.length && boxes.every((b) => b.checked);
    boxes.forEach((b) => { b.checked = !allOn; });
    updateSyncCount();
  });
  if (syncCopy) syncCopy.addEventListener("click", async () => {
    const names = selected();
    if (!names.length) return;
    syncMsg.className = "form-msg"; syncMsg.textContent = "Copying to every station…";
    syncCopy.disabled = true;
    try {
      const r = await api("/api/skills/sync-global", { method: "POST",
        body: JSON.stringify({ names }) });
      const copied = (r && r.copied) || 0;
      syncMsg.className = "form-msg ok"; syncMsg.textContent = "Copied " + copied + " skill" + (copied === 1 ? "" : "s") + " to every station.";
      toast("Synced " + copied + " skill" + (copied === 1 ? "" : "s") + " everywhere", "ok");
      loadSkills();
      loadGlobalSkills();
    } catch (err) {
      syncMsg.className = "form-msg err"; syncMsg.textContent = err.message;
    } finally {
      syncCopy.disabled = false;
    }
  });

  wireContext7();
}

// ---- Context7 MCP integration: one shared key, fanned into every station ----
function renderContext7Status(status) {
  const pill = $("#ctx7Status");
  if (!pill) return;
  if (!status) { pill.hidden = true; return; }
  pill.hidden = false;
  const LABEL = { live: "live", throttled: "live · rate-limited", invalid: "invalid key", unreachable: "unreachable", "no-key": "" };
  pill.className = "badge " + (status === "live" || status === "throttled" ? "ok" : "err");
  pill.textContent = LABEL[status] || status;
}

export async function loadContext7() {
  const keyInput = $("#ctx7ApiKey");
  const removeBtn = $("#ctx7Remove");
  try {
    const r = await api("/api/context7");
    const hasKey = !!(r && r.hasKey);
    if (keyInput) keyInput.placeholder = hasKey ? "•••••••••••••••••••• (saved — paste to replace)" : "paste ctx7sk-… key";
    if (removeBtn) removeBtn.hidden = !hasKey;
    if (!hasKey) { renderContext7Status(null); return; }
    const t = await api("/api/context7/test", { method: "POST" });
    renderContext7Status(t && t.status);
  } catch (_) {
    renderContext7Status(null);
  }
}

function wireContext7() {
  const save = $("#ctx7Save");
  const remove = $("#ctx7Remove");
  const input = $("#ctx7ApiKey");
  const msg = $("#ctx7Msg");
  if (save) save.addEventListener("click", async () => {
    const apiKey = (input && input.value || "").trim();
    if (!apiKey) { if (msg) { msg.className = "form-msg err"; msg.textContent = "Paste a key first."; } return; }
    save.disabled = true;
    if (msg) { msg.className = "form-msg"; msg.textContent = "Saving + registering into every station…"; }
    try {
      await api("/api/context7", { method: "POST", body: JSON.stringify({ apiKey }) });
      if (input) input.value = "";
      if (msg) { msg.className = "form-msg ok"; msg.textContent = "Saved."; }
      toast("Context7 key saved", "ok");
      await loadContext7();
    } catch (err) {
      if (msg) { msg.className = "form-msg err"; msg.textContent = err.message; }
    } finally {
      save.disabled = false;
    }
  });
  if (remove) remove.addEventListener("click", async () => {
    if (!confirm("Remove the Context7 key and unregister it from every station?")) return;
    remove.disabled = true;
    try {
      await api("/api/context7/remove", { method: "POST" });
      toast("Context7 key removed", "ok");
      await loadContext7();
    } catch (err) {
      if (msg) { msg.className = "form-msg err"; msg.textContent = err.message; }
    } finally {
      remove.disabled = false;
    }
  });
}
