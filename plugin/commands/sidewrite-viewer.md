---
description: Show the sidewrite viewer URL and current pipeline status.
allowed-tools: Bash(node:*)
---

Sidewrite viewer status:

!`node ${CLAUDE_PLUGIN_ROOT}/scripts/hook-client.cjs print-status`

Open the viewer URL printed above in your browser to watch runs live. The dashboard is where you add providers, activate a model, and follow pipeline events (plan, implement, review) in real time.
