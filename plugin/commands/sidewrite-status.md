---
description: Print the sidewrite daemon health snapshot (fast: reads status.json).
allowed-tools: Bash(node:*), Bash(curl:*)
---

Sidewrite daemon health snapshot:

!`node -e 'const fs=require("fs");const p=process.env.HOME+"/.sidewrite/status.json";try{const s=JSON.parse(fs.readFileSync(p,"utf8"));const hb=Number(s.heartbeat_ts),ttl=Number(s.ttl_seconds);if(!isFinite(hb)||!isFinite(ttl)||Date.now()-hb>ttl*1000)process.exit(1);const a=s.active||{};process.stdout.write("sidewrite viewer: running (status.json)\n  url:     http://127.0.0.1:"+s.port+"\n  version: "+(s.version||"unknown")+"\n  mode:    "+(s.mode||"unknown")+"\n  stage:   "+((s.pipeline&&s.pipeline.stage)||"idle")+"\n  active:  "+((a.provider||"?")+"/"+(a.model||"?"))+"\n");}catch(e){process.exit(1);}' 2>/dev/null || curl -s -m 2 "http://127.0.0.1:$(node -e 'const fs=require("fs");try{const d=JSON.parse(fs.readFileSync(process.env.HOME+"/.sidewrite/daemon.json","utf8"));process.stdout.write(String(d.port||1510));}catch(e){process.stdout.write("1510");}')/api/health"`

This reads `~/.sidewrite/status.json` directly (zero node-HTTP, ~1ms) when the daemon heartbeat is fresh (within `ttl_seconds`); if the file is missing or stale it falls back to the unauthenticated, host-guarded `GET /api/health`. It shows the daemon port, version, mode, active provider/model, and current pipeline stage.
