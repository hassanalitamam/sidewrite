// sse.js — the live /stream transport. EventSource can't set Authorization
// headers, so the bearer token rides as ?token= (only /stream accepts it).
// Transport only: each parsed event is handed to events.handleEvent.
import { TOKEN } from "./config.js";
import { setConn } from "./components/status.js";
import { handleEvent } from "./events.js";

let es = null;
let lastEventId = null;
let reconnectDelay = 1000;
let consecutiveErrors = 0;

// EventSource.onerror can't tell us WHY the connection died — a network blip
// and a stale token look identical. The daemon mints a fresh random TOKEN on
// every boot (see viewer-daemon.cjs), so if it ever restarts (crash, manual
// stop/up, machine reboot) while this tab is open, every future reconnect
// attempt is doomed: the token embedded in THIS page load is permanently
// wrong, and no amount of retrying fixes that — the dashboard would just
// spin on "reconnecting…" forever. After a few failed attempts, probe a real
// authenticated endpoint directly (bypassing EventSource) to check for a 401
// specifically; only then force a full reload, which re-fetches GET / and
// gets a fresh token baked into the new page. Any other failure (network
// blip, daemon still mid-restart) falls through to the normal backoff retry.
async function isTokenStale() {
  try {
    const res = await fetch("/api/config", { headers: { Authorization: "Bearer " + TOKEN }, cache: "no-store" });
    return res.status === 401;
  } catch (_) {
    return false; // network error — can't tell, don't force a reload on a guess
  }
}

export function connect() {
  if (es) { try { es.close(); } catch (_) {} }
  const url = "/stream?token=" + encodeURIComponent(TOKEN);
  es = new EventSource(url);

  es.onopen = () => { setConn("live", "live"); reconnectDelay = 1000; consecutiveErrors = 0; };

  es.onmessage = (m) => {
    if (m.lastEventId) lastEventId = m.lastEventId;
    let ev;
    try { ev = JSON.parse(m.data); } catch { return; }
    handleEvent(ev);
  };

  es.onerror = async () => {
    setConn("down", "reconnecting…");
    try { es.close(); } catch (_) {}
    consecutiveErrors++;
    if (consecutiveErrors >= 3 && (await isTokenStale())) {
      setConn("down", "reloading…");
      location.reload();
      return;
    }
    setTimeout(connect, reconnectDelay);
    reconnectDelay = Math.min(reconnectDelay * 1.6, 15000);
  };
}
