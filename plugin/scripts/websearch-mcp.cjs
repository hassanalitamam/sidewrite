#!/usr/bin/env node
'use strict';

/*
 * websearch-mcp.cjs — a minimal, zero-dependency MCP stdio server exposing a
 * single `web_search` tool, backed by DuckDuckGo's HTML results page (no API
 * key, no signup, no npm dependency).
 *
 * Why this exists: Claude Code's native WebSearch is an Anthropic-hosted
 * server tool — it silently does nothing (or reports "not working") when a
 * session runs against a third-party provider via ccx's base-URL swap (see
 * bin/ccx), because that provider has no idea how to execute Anthropic's
 * internal tool. MCP tools are different: they're invoked client-side by
 * Claude Code itself via ordinary function-calling, which every modern model
 * backend supports regardless of vendor — so exposing search this way works
 * the same whether the session is on Claude, mimo, GLM, or anything else ccx
 * points at.
 *
 * Protocol: JSON-RPC 2.0 over stdio, one message per line — see
 * modelcontextprotocol.io/specification/2025-06-18/basic/transports and
 * .../basic/lifecycle and .../server/tools for the exact message shapes this
 * implements. node: builtins only.
 */

const https = require('node:https');
const readline = require('node:readline');

const PROTOCOL_VERSION = '2025-06-18';
const FETCH_TIMEOUT_MS = 10000;
const MAX_REDIRECTS = 3;

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

// DuckDuckGo's HTML results link through a same-site redirect
// (//duckduckgo.com/l/?uddg=<url-encoded-real-url>&rut=...) rather than
// linking straight to the result — unwrap it to the real destination.
function extractRealUrl(ddgHref) {
  try {
    const u = new URL('https:' + ddgHref);
    const real = u.searchParams.get('uddg');
    return real ? decodeURIComponent(real) : ddgHref;
  } catch (_) {
    return ddgHref;
  }
}

function fetchHtml(url, redirectsLeft) {
  if (redirectsLeft === undefined) redirectsLeft = MAX_REDIRECTS;
  return new Promise((resolve, reject) => {
    const req = https.get(url, {
      headers: { 'User-Agent': 'Mozilla/5.0 (compatible; SidewriteSearch/1.0)' },
    }, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location && redirectsLeft > 0) {
        res.resume();
        resolve(fetchHtml(new URL(res.headers.location, url).toString(), redirectsLeft - 1));
        return;
      }
      if (res.statusCode !== 200) {
        res.resume();
        reject(new Error('HTTP ' + res.statusCode));
        return;
      }
      let body = '';
      res.setEncoding('utf8');
      res.on('data', (c) => { body += c; });
      res.on('end', () => resolve(body));
    });
    req.on('error', reject);
    req.setTimeout(FETCH_TIMEOUT_MS, () => req.destroy(new Error('search request timed out')));
  });
}

async function webSearch(query, maxResults) {
  const url = 'https://html.duckduckgo.com/html/?q=' + encodeURIComponent(query);
  const html = await fetchHtml(url);

  const titleRe = /<a rel="nofollow" class="result__a" href="([^"]+)">([\s\S]*?)<\/a>/g;
  const snippetRe = /<a class="result__snippet" href="[^"]*">([\s\S]*?)<\/a>/g;

  const titles = [];
  let m;
  while ((m = titleRe.exec(html)) !== null) {
    titles.push({ href: m[1], title: stripTags(m[2]) });
  }
  const snippets = [];
  while ((m = snippetRe.exec(html)) !== null) {
    snippets.push(stripTags(m[1]));
  }

  return titles.slice(0, maxResults).map((t, i) => ({
    title: t.title,
    url: extractRealUrl(t.href),
    snippet: snippets[i] || '',
  }));
}

const TOOLS = [
  {
    name: 'web_search',
    description: 'Search the public web (via DuckDuckGo) and return titles, URLs, and snippets. Use this for current events, prices, versions, or anything that might have changed since training — this session\'s model backend has no built-in search of its own.',
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'The search query' },
        max_results: { type: 'number', description: 'Max results to return (default 5, max 10)' },
      },
      required: ['query'],
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
        serverInfo: { name: 'sidewrite-websearch', version: '1.0.0' },
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
    if (name !== 'web_search') {
      send({ jsonrpc: '2.0', id, error: { code: -32602, message: 'Unknown tool: ' + name } });
      return;
    }
    const query = String(args.query || '').trim();
    const maxResults = Math.min(10, Math.max(1, Number(args.max_results) || 5));
    if (!query) {
      send({ jsonrpc: '2.0', id, result: { content: [{ type: 'text', text: 'query is required' }], isError: true } });
      return;
    }
    try {
      const results = await webSearch(query, maxResults);
      const text = results.length
        ? results.map((r, i) => (i + 1) + '. ' + r.title + '\n   ' + r.url + '\n   ' + r.snippet).join('\n\n')
        : 'No results found for "' + query + '".';
      send({ jsonrpc: '2.0', id, result: { content: [{ type: 'text', text }], isError: false } });
    } catch (err) {
      send({ jsonrpc: '2.0', id, result: { content: [{ type: 'text', text: 'Search failed: ' + err.message }], isError: true } });
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
