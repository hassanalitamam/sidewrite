// config.js — constants + injected globals.
// The daemon injects the bearer token/port into the SHELL html only (GET /);
// the bootstrap sets them on window. These static .js files stay token-free.
export const TOKEN = window.__SIDEWRITE_TOKEN__;
export const PORT  = window.__SIDEWRITE_PORT__;
export const BASE  = ""; // same-origin (served by the daemon on 127.0.0.1:PORT)

export const PAGES = {
  runs: "pageRuns",   // also hosts the folded-in history browser (#runsHistory)
  studio: "pageStudio", // Skills + Sub-agents + MCP, segmented (see views/studio.js)
  providers: "pageProviders",
  analytics: "pageAnalytics",
  health: "pageHealth",
  budgets: "pageBudgets",
  privacy: "pagePrivacy",
};

export const STAGES = ["plan", "implement", "review"];
export const STAGE_LABELS = { plan: "Plan", implement: "Implement", review: "Review" };
// prototype icon map — sprite symbol ids (#ic-*)
export const STAGE_ICON = { plan: "list", implement: "running", review: "check" };

export const LOGGABLE = new Set(["tool_use", "tool_result", "log_line", "capture_gap"]);
export const MAX_LOG = 500;
