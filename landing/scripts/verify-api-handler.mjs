#!/usr/bin/env node
// Manual verification harness for landing/api/*.js Vercel serverless handlers.
// Vercel Node functions have signature (req: http.IncomingMessage-like, res: ServerResponse-like)
// with `req.method`, `req.headers`, `req.on('data'|'end'|'error')`, and
// `res.status(code).json(obj)` / `res.setHeader()` / `res.end()`. This harness
// fakes just enough of that surface to invoke a handler directly with node,
// against the REAL Supabase project (reads SUPABASE_URL/SUPABASE_ANON_KEY from
// landing/.env.local) — no `vercel dev` needed.
//
// Usage: node landing/scripts/verify-api-handler.mjs <path-to-handler.js> <json-body> [method]
//   node landing/scripts/verify-api-handler.mjs api/contact.js '{"name":"t","email":"t@example.com","message":"hi"}'

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { EventEmitter } from 'node:events';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// load landing/.env.local into process.env (no dependency on dotenv package)
function loadEnvLocal() {
  const envPath = path.join(__dirname, '..', '.env.local');
  if (!fs.existsSync(envPath)) return;
  for (const line of fs.readFileSync(envPath, 'utf8').split('\n')) {
    const m = line.match(/^([A-Z0-9_]+)=(.*)$/);
    if (!m) continue;
    let val = m[2].trim();
    if (val.startsWith('"') && val.endsWith('"')) val = val.slice(1, -1);
    if (!process.env[m[1]]) process.env[m[1]] = val;
  }
}
loadEnvLocal();

function makeReq(body, method, headers) {
  const req = new EventEmitter();
  req.method = method || 'POST';
  req.headers = { 'content-type': 'application/json', 'x-forwarded-for': '127.0.0.1', ...headers };
  process.nextTick(() => {
    if (body != null) req.emit('data', Buffer.from(typeof body === 'string' ? body : JSON.stringify(body)));
    req.emit('end');
  });
  return req;
}

function makeRes() {
  const res = {
    _status: 200,
    _headers: {},
    _body: undefined,
    _ended: false,
    setHeader(k, v) { this._headers[k] = v; return this; },
    status(code) { this._status = code; return this; },
    json(obj) { this._body = obj; this._ended = true; return this; },
    end(data) { if (data !== undefined) this._body = data; this._ended = true; return this; },
  };
  return res;
}

async function main() {
  const [, , handlerPathArg, bodyArg, methodArg] = process.argv;
  if (!handlerPathArg) {
    console.error('usage: node verify-api-handler.mjs <path-to-handler.js> [json-body] [method]');
    process.exit(2);
  }
  const handlerPath = path.isAbsolute(handlerPathArg) ? handlerPathArg : path.join(process.cwd(), handlerPathArg);
  const mod = await import(`file://${handlerPath}`);
  const handler = mod.default;
  if (typeof handler !== 'function') {
    console.error('no default export function found in', handlerPath);
    process.exit(2);
  }
  const body = bodyArg ? JSON.parse(bodyArg) : undefined;
  const req = makeReq(body, methodArg || (body ? 'POST' : 'GET'));
  const res = makeRes();
  await handler(req, res);
  console.log(JSON.stringify({ status: res._status, headers: res._headers, body: res._body }, null, 2));
  process.exit(res._status >= 200 && res._status < 500 ? 0 : 1);
}

main().catch((err) => {
  console.error('handler threw:', err);
  process.exit(1);
});
