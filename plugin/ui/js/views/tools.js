// views/tools.js — the Tools pane of the Studio page
// Manages token-saving features: Terse Mode, History Compaction, RTK Rewrite
import { $ } from "../dom.js";
import { api } from "../api.js";
import { toast } from "../components/toast.js";

const toolsState = {
  loaded: false,
  features: {
    terseMode: true,
    poolCompact: true,
    rtkRewrite: true,
  },
  rtkDetected: true,
};

// Enter hook for the router.
export async function enterTools() {
  try {
    const r = await api("/api/tools");
    if (r && r.ok) {
      toolsState.features = r.features || toolsState.features;
      toolsState.rtkDetected = !!r.rtkDetected;
      toolsState.loaded = true;
    }
  } catch (err) {
    toast("Load tools failed: " + err.message, "err");
  }
  renderTools();
}

export function renderTools() {
  // Set aria-checked attributes based on current state
  const buttons = document.querySelectorAll("[data-tool-toggle]");
  buttons.forEach((btn) => {
    const feature = btn.dataset.toolToggle;
    const isChecked = toolsState.features[feature];
    btn.setAttribute("aria-checked", isChecked ? "true" : "false");
  });

  // Show/hide RTK install card based on rtkDetected
  const rtkCard = $("#rtkInstallCard");
  if (rtkCard) {
    rtkCard.hidden = !!toolsState.rtkDetected;
  }
}

export function wireTools() {
  // Delegate click handler for tool toggles
  document.addEventListener("click", async (e) => {
    const btn = e.target.closest("[data-tool-toggle]");
    if (!btn) return;

    const feature = btn.dataset.toolToggle;
    if (!feature) return;

    const currentChecked = btn.getAttribute("aria-checked") === "true";
    const newEnabled = !currentChecked;

    // Optimistically update UI
    btn.setAttribute("aria-checked", newEnabled ? "true" : "false");

    try {
      await api("/api/tools/toggle", {
        method: "POST",
        body: JSON.stringify({ feature, enabled: newEnabled }),
      });
      // Update state
      toolsState.features[feature] = newEnabled;
      toast((newEnabled ? "Enabled " : "Disabled ") + feature, "ok");
    } catch (err) {
      // Revert on failure
      btn.setAttribute("aria-checked", currentChecked ? "true" : "false");
      toast("Toggle failed: " + err.message, "err");
    }
  });
}
