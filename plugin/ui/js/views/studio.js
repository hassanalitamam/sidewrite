// views/studio.js — the Studio page: Skills + Sub-agents + MCP (Context7),
// merged into one page as compact segmented sections instead of three stacked
// full-height pages. Everything here is GLOBAL (see views/skills.js / views/agents.js
// for the underlying "no per-provider selection" model) — this module only owns
// the segmented toggle between the three panes.
import { $, $$ } from "../dom.js";
import { enterSkills } from "./skills.js";
import { enterAgents } from "./agents.js";

const PANES = { skills: "studioSkillsPane", agents: "studioAgentsPane", mcp: "studioMcpPane" };

// Router entry hook: load all three sections' data up front (cheap GETs) so
// switching segments never shows a load flicker.
export function enterStudio() {
  enterSkills();
  enterAgents();
}

export function wireStudio() {
  const seg = $("#studioSeg");
  if (!seg) return;
  seg.addEventListener("click", (e) => {
    const btn = e.target.closest("button[data-studio]");
    if (!btn) return;
    const section = btn.dataset.studio;
    $$("#studioSeg button").forEach((b) => b.setAttribute("aria-pressed", b === btn ? "true" : "false"));
    for (const key in PANES) {
      const el = $("#" + PANES[key]);
      if (el) el.hidden = key !== section;
    }
  });
}
