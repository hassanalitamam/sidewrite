// views/health.js — the System Health panel (plan #10). Consumes
// GET /api/health/full (unauthenticated route on the daemon, but we still go
// through api() so the bearer header rides along consistently with every
// other view) and renders one card per check: node:sqlite / claude CLI (via
// gate-core.cjs, run out-of-process by the daemon) + daemon/database/disk/
// providers self-checks. Each failing check surfaces its `fix` text inline —
// no separate lookup, no guessing.
import { $, icon } from "../dom.js";
import { esc } from "../format.js";
import { api } from "../api.js";
import { toast } from "../components/toast.js";

const healthState = { checks: [], ok: null, version: null, loading: false, error: null };

// Friendlier labels for the check names the daemon reports (gate-core.cjs
// checks come through as "node" / "claude"; daemon self-checks are already
// named the way we want to show them). Falls back to the raw name.
const NAME_LABEL = {
  node: "node:sqlite",
  claude: "Claude Code CLI",
  daemon: "Daemon",
  database: "Database",
  disk: "Disk",
  providers: "Providers",
  gate: "Environment gate",
};

function labelFor(name) {
  return NAME_LABEL[name] || esc(name);
}

function checkCardHTML(c) {
  const name = String(c && c.name || "check");
  const ok = !!(c && c.ok);
  const detail = c && c.detail ? String(c.detail) : "";
  const fix = c && c.fix ? String(c.fix) : "";
  const badge = ok
    ? '<span class="badge ok"><span class="bdot"></span>ok</span>'
    : '<span class="badge err"><span class="bdot"></span>failing</span>';
  return (
    '<div class="card">' +
      '<div class="card-head">' +
        '<div class="card-title">' + labelFor(name) + "</div>" +
        badge +
      "</div>" +
      (detail ? '<div style="margin-top:6px; color:var(--ink-body); font-size:13px;">' + esc(detail) + "</div>" : "") +
      (!ok && fix
        ? '<div style="margin-top:10px; padding:10px 12px; background:var(--accent-soft); border:1px solid color-mix(in srgb,var(--accent) 35%, var(--border-obj)); font-size:13px; color:var(--ink);">' +
            "<b>Fix:</b> " + esc(fix) +
          "</div>"
        : "") +
    "</div>"
  );
}

export function renderHealth() {
  const root = $("#healthRoot");
  if (!root) return;

  if (healthState.loading && !healthState.checks.length) {
    root.innerHTML = '<div class="card" style="color:var(--ink-muted)">Checking system health…</div>';
    return;
  }
  if (healthState.error) {
    root.innerHTML =
      '<div class="card">' +
        '<div class="card-head"><div class="card-title">System health</div><span class="badge err"><span class="bdot"></span>unreachable</span></div>' +
        '<div style="margin-top:6px; color:var(--ink-body); font-size:13px;">' + esc(healthState.error) + "</div>" +
      "</div>";
    return;
  }

  const checks = healthState.checks || [];
  const overallOk = healthState.ok !== false;
  const summary =
    '<div class="card-head" style="margin-bottom:14px;">' +
      '<div class="card-title" style="display:flex; align-items:center; gap:8px;">' +
        icon("check") + "System health" +
      "</div>" +
      (overallOk
        ? '<span class="badge ok"><span class="bdot"></span>all checks passing</span>'
        : '<span class="badge err"><span class="bdot"></span>' + checks.filter((c) => !c.ok).length + " failing</span>") +
    "</div>";

  const grid = checks.length
    ? '<div style="display:grid; grid-template-columns:repeat(auto-fill,minmax(260px,1fr)); gap:12px;">' +
        checks.map(checkCardHTML).join("") +
      "</div>"
    : '<div class="card" style="color:var(--ink-muted)">No checks reported.</div>';

  const versionLine = healthState.version
    ? '<div style="margin-top:14px; color:var(--ink-muted); font-size:12px;">sidewrite v' + esc(healthState.version) + "</div>"
    : "";

  root.innerHTML = summary + grid + versionLine;
}

export async function loadHealth() {
  healthState.loading = true;
  healthState.error = null;
  renderHealth();
  try {
    const r = await api("/api/health/full");
    healthState.checks = (r && Array.isArray(r.checks)) ? r.checks : [];
    healthState.ok = (r && typeof r.ok === "boolean") ? r.ok : null;
    healthState.version = (r && r.version) || null;
  } catch (err) {
    healthState.checks = [];
    healthState.ok = null;
    healthState.error = err.message;
    toast("Load health failed: " + err.message, "err");
  } finally {
    healthState.loading = false;
  }
  renderHealth();
}

// Enter hook for the router: (re)load on every visit — health can change
// between visits (a provider gets removed, disk fills up, etc.) and the
// check is cheap/bounded on the daemon side.
export function enterHealth() {
  loadHealth();
}

export function wireHealth() {
  const refresh = $("#healthRefresh");
  if (refresh) refresh.addEventListener("click", loadHealth);
}
