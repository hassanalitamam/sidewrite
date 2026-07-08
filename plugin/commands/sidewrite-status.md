---
description: Print the sidewrite daemon health snapshot (fast: reads status.json).
allowed-tools: Bash(node:*)
---

Sidewrite daemon health snapshot:

!`node ${CLAUDE_PLUGIN_ROOT}/scripts/hook-client.cjs status-fast`

This reads `~/.sidewrite/status.json` directly (zero node-HTTP, ~1ms) when the daemon heartbeat is fresh (within `ttl_seconds`); if the file is missing or stale it falls back to an in-process HTTP GET of the unauthenticated, host-guarded `/api/health` endpoint. It shows the daemon port, version, mode, active provider/model, and current pipeline stage.
