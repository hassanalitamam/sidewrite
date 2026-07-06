// api.js — the ONLY module that calls fetch. Every request carries the bearer.
import { TOKEN, BASE } from "./config.js";

export async function api(path, opts = {}) {
  const headers = Object.assign(
    { "Authorization": "Bearer " + TOKEN },
    opts.body ? { "Content-Type": "application/json" } : {},
    opts.headers || {}
  );
  const res = await fetch(BASE + path, Object.assign({}, opts, { headers }));
  const text = await res.text();
  let data;
  try { data = text ? JSON.parse(text) : null; } catch { data = text; }
  if (!res.ok) {
    const msg = (data && data.error) ? data.error : ("HTTP " + res.status);
    throw new Error(msg);
  }
  return data;
}
