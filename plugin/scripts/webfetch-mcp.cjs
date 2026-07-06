#!/usr/bin/env node
'use strict';

/*
 * webfetch-mcp.cjs — a minimal, zero-dependency MCP stdio server exposing a
 * single `web_fetch` tool that fetches a URL and returns its extracted text
 * (no API key, no signup, no npm dependency).
 *
 * Why this exists: Claude Code's native WebFetch is an Anthropic-hosted
 * server tool — it silently does nothing (or reports "not working") when a
 * session runs against a third-party provider via ccx's base-URL swap (see
 * bin/ccx), because that provider has no idea how to execute Anthropic's
 * internal tool. MCP tools are different: they're invoked client-side by
 * Claude Code itself via ordinary function-calling, which every modern model
 * backend supports regardless of vendor — so exposing fetch this way works
 * the same whether the session is on Claude, mimo, GLM, or anything else ccx
 * points at. Note native WebFetch also runs an LLM summarization pass over
 * the page server-side on Anthropic's infra, which this cannot replicate —
 * this tool returns the extracted raw text (optionally prefixed by the
 * echoed `prompt` argument) and lets the calling model do its own
 * extraction/summarization.
 *
 * Protocol: JSON-RPC 2.0 over stdio, one message per line — see
 * modelcontextprotocol.io/specification/2025-06-18/basic/transports and
 * .../basic/lifecycle and .../server/tools for the exact message shapes this
 * implements. node: builtins only.
 */

const https = require('node:https');
const http = require('node:http');
const zlib = require('node:zlib');
const dns = require('node:dns');
const net = require('node:net');
const readline = require('node:readline');

const PROTOCOL_VERSION = '2025-06-18';
const FETCH_TIMEOUT_MS = 10000;
const MAX_REDIRECTS = 5;
const MAX_TEXT_CHARS = 50000;
// Cap the raw response body BEFORE decompression — a model-supplied URL is
// arbitrary and unbounded (a huge file, a slow/infinite stream, a compression
// bomb), unlike websearch-mcp.cjs which only ever hits one fixed, small
// DuckDuckGo results page.
const MAX_BODY_BYTES = 10 * 1024 * 1024; // 10 MB

function send(msg) {
  process.stdout.write(JSON.stringify(msg) + '\n');
}

function decodeEntities(s) {
  return String(s)
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#x27;/g, "'")
    .replace(/&#39;/g, "'");
}

function stripTags(s) {
  return decodeEntities(String(s).replace(/<[^>]*>/g, '')).trim();
}

function decompressBody(buf, contentEncoding) {
  const enc = String(contentEncoding || '').toLowerCase();
  try {
    if (enc.includes('br')) return zlib.brotliDecompressSync(buf);
    if (enc.includes('gzip')) return zlib.gunzipSync(buf);
    if (enc.includes('deflate')) return zlib.inflateSync(buf);
  } catch (_) {
    // Fall through and return the raw buffer if decompression fails —
    // some servers lie about content-encoding.
  }
  return buf;
}

// SSRF guard: web_fetch takes an arbitrary model/user-supplied URL and runs
// from the user's own machine (unlike websearch-mcp.cjs, which only ever
// hits one fixed DuckDuckGo host) — a prompt-injected or compromised model
// could otherwise use it to reach loopback/link-local/private addresses
// (e.g. 127.0.0.1, 169.254.169.254 cloud metadata, an internal LAN host).
// Resolve the hostname to a real IP and check THAT (not just the literal
// hostname string) before connecting, since a hostname can look public but
// resolve privately. Re-checked on every redirect hop for the same reason.
function isPrivateAddress(ip) {
  const kind = net.isIP(ip);
  if (kind === 4) {
    const parts = ip.split('.').map(Number);
    const [a, b] = parts;
    if (a === 127) return true; // loopback
    if (a === 10) return true; // private
    if (a === 172 && b >= 16 && b <= 31) return true; // private
    if (a === 192 && b === 168) return true; // private
    if (a === 169 && b === 254) return true; // link-local incl. cloud metadata
    if (a === 0) return true;
    return false;
  }
  if (kind === 6) {
    const lower = ip.toLowerCase();
    if (lower === '::1') return true; // loopback
    if (lower.startsWith('fe80:') || lower.startsWith('fe8') || lower.startsWith('fe9') || lower.startsWith('fea') || lower.startsWith('feb')) return true; // link-local
    if (lower.startsWith('fc') || lower.startsWith('fd')) return true; // unique local
    if (lower.startsWith('::ffff:')) return isPrivateAddress(lower.slice(7)); // IPv4-mapped
    return false;
  }
  return true; // unresolvable/unknown shape — fail closed
}

function assertPublicHost(hostname) {
  return new Promise((resolve, reject) => {
    dns.lookup(hostname, (err, address) => {
      if (err) {
        reject(new Error('DNS lookup failed for ' + hostname));
        return;
      }
      if (isPrivateAddress(address)) {
        reject(new Error('Refusing to fetch a private/internal address (' + address + ')'));
        return;
      }
      resolve();
    });
  });
}

async function fetchUrl(url, redirectsLeft) {
  if (redirectsLeft === undefined) redirectsLeft = MAX_REDIRECTS;
  let parsed;
  try {
    parsed = new URL(url);
  } catch (_) {
    throw new Error('Invalid URL: ' + url);
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new Error('Unsupported URL scheme: ' + parsed.protocol);
  }
  await assertPublicHost(parsed.hostname);

  return new Promise((resolve, reject) => {
    const transport = parsed.protocol === 'http:' ? http : https;
    const req = transport.get(parsed, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (compatible; SidewriteFetch/1.0)',
        'Accept-Encoding': 'gzip, deflate, br',
      },
    }, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location && redirectsLeft > 0) {
        res.resume();
        resolve(fetchUrl(new URL(res.headers.location, url).toString(), redirectsLeft - 1));
        return;
      }
      if (res.statusCode !== 200) {
        res.resume();
        reject(new Error('HTTP ' + res.statusCode));
        return;
      }
      const chunks = [];
      let size = 0;
      let settled = false;
      res.on('data', (c) => {
        if (settled) return;
        size += c.length;
        if (size > MAX_BODY_BYTES) {
          settled = true;
          res.destroy();
          reject(new Error('Response exceeded ' + MAX_BODY_BYTES + ' bytes'));
          return;
        }
        chunks.push(c);
      });
      res.on('end', () => {
        if (settled) return;
        settled = true;
        const raw = decompressBody(Buffer.concat(chunks), res.headers['content-encoding']);
        resolve({
          body: raw.toString('utf8'),
          contentType: String(res.headers['content-type'] || ''),
          finalUrl: url,
        });
      });
    });
    req.on('error', reject);
    req.setTimeout(FETCH_TIMEOUT_MS, () => req.destroy(new Error('fetch request timed out')));
  });
}

// Block-level and void elements whose boundaries must become whitespace
// BEFORE the generic tag-stripping regex runs — otherwise text from adjacent
// blocks (</h1><p>, </p><p>, </div><span>, <br>) glues together into one
// unreadable run whenever the source markup has no trailing space/punctuation
// at the boundary (common on real pages; stripTags alone only ever handled
// isolated single-line fragments in websearch-mcp.cjs, never a whole document).
const BLOCK_BOUNDARY_RE =
  /<\/?(p|div|h[1-6]|li|ul|ol|tr|td|th|table|thead|tbody|tfoot|blockquote|section|article|header|footer|nav|aside|main|form|fieldset|figure|figcaption|pre|hr)\b[^>]*>|<br\s*\/?>/gi;

function htmlToText(html) {
  let text = String(html)
    .replace(/<script[\s\S]*?<\/script>/gi, '')
    .replace(/<style[\s\S]*?<\/style>/gi, '')
    .replace(/<noscript[\s\S]*?<\/noscript>/gi, '')
    .replace(BLOCK_BOUNDARY_RE, '\n');
  text = stripTags(text);
  text = text
    .replace(/[ \t]+/g, ' ')
    .replace(/\n[ \t]+/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
  return text;
}

function truncate(text) {
  if (text.length <= MAX_TEXT_CHARS) return text;
  return text.slice(0, MAX_TEXT_CHARS) + '\n\n[truncated]';
}

async function webFetch(url, prompt) {
  const { body, contentType } = await fetchUrl(url);
  const isHtml = /text\/html|application\/xhtml/i.test(contentType);
  let text;
  if (isHtml) {
    text = htmlToText(body);
  } else {
    // json, plain text, and anything else: pass through with minimal
    // processing rather than running the HTML stripper on it.
    text = String(body).trim();
  }
  text = truncate(text);
  if (prompt) {
    return 'Instruction: ' + prompt + '\n\n' + text;
  }
  return text;
}

const TOOLS = [
  {
    name: 'web_fetch',
    description: 'Fetch a URL and return its extracted text content. Use this to read the contents of a specific web page — this session\'s model backend has no built-in fetch of its own.',
    inputSchema: {
      type: 'object',
      properties: {
        url: { type: 'string', description: 'The URL to fetch' },
        prompt: { type: 'string', description: 'Optional instruction describing what to extract or look for in the page' },
      },
      required: ['url'],
    },
  },
];

async function handleRequest(msg) {
  const id = msg.id;
  const method = msg.method;
  const params = msg.params;

  if (method === 'initialize') {
    send({
      jsonrpc: '2.0',
      id,
      result: {
        protocolVersion: PROTOCOL_VERSION,
        capabilities: { tools: {} },
        serverInfo: { name: 'sidewrite-webfetch', version: '1.0.0' },
      },
    });
    return;
  }
  // Notifications (no `id`) never get a response.
  if (method === 'notifications/initialized' || method === 'notifications/cancelled') return;
  if (method === 'ping') { send({ jsonrpc: '2.0', id, result: {} }); return; }

  if (method === 'tools/list') {
    send({ jsonrpc: '2.0', id, result: { tools: TOOLS } });
    return;
  }

  if (method === 'tools/call') {
    const name = params && params.name;
    const args = (params && params.arguments) || {};
    if (name !== 'web_fetch') {
      send({ jsonrpc: '2.0', id, error: { code: -32602, message: 'Unknown tool: ' + name } });
      return;
    }
    const url = String(args.url || '').trim();
    const prompt = args.prompt ? String(args.prompt) : '';
    if (!url) {
      send({ jsonrpc: '2.0', id, result: { content: [{ type: 'text', text: 'url is required' }], isError: true } });
      return;
    }
    try {
      const text = await webFetch(url, prompt);
      send({ jsonrpc: '2.0', id, result: { content: [{ type: 'text', text: text || '(empty response)' }], isError: false } });
    } catch (err) {
      send({ jsonrpc: '2.0', id, result: { content: [{ type: 'text', text: 'Fetch failed: ' + err.message }], isError: true } });
    }
    return;
  }

  if (id !== undefined) {
    send({ jsonrpc: '2.0', id, error: { code: -32601, message: 'Method not found: ' + method } });
  }
}

const rl = readline.createInterface({ input: process.stdin, terminal: false });
rl.on('line', (line) => {
  line = line.trim();
  if (!line) return;
  let msg;
  try { msg = JSON.parse(line); } catch (_) { return; }
  handleRequest(msg).catch(() => {});
});
