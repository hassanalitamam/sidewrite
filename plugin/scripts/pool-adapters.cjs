#!/usr/bin/env node
'use strict';

/*
 * pool-adapters — wire-format translation for the Free-Tier Pool.
 *
 * Written directly against the public Anthropic Messages API reference
 * (platform.claude.com/docs/en/api/messages) and the OpenAI Chat Completions
 * reference (platform.openai.com/docs/api-reference/chat) — not derived from
 * any other project's source. One adapter per wire family, matching
 * pool-providers.json's `wire` field:
 *
 *   "anthropic" — identity passthrough (zero translation; every provider
 *                 already in plugin/data/providers.json speaks this).
 *   "openai"    — covers every OpenAI-compatible free provider (Groq,
 *                 Cerebras, GitHub Models, OpenRouter free, SambaNova,
 *                 Cloudflare Workers AI, NVIDIA NIM, Mistral, OVH, ...).
 *   "gemini"    — Google Gemini's own generateContent/streamGenerateContent
 *                 shape (parts/role:"model", functionDeclarations with a
 *                 restricted JSON-Schema subset, systemInstruction as a
 *                 top-level sibling of contents, not a system message).
 *
 * Streaming: when the caller requests stream:true, pool-router dispatches
 * incrementally via streamOpenAIToAnthropic() below — real token-by-token
 * pass-through, not a buffer-then-emit shortcut. anthropicMessageToSyntheticSSE()
 * is kept as the encoder for the (rarer) case a candidate is dispatched
 * non-streaming internally but the client asked for an SSE response.
 *
 * node: builtins only — no npm dependencies.
 */

// ---------------------------------------------------------------------------
// Anthropic -> OpenAI request
// ---------------------------------------------------------------------------

const FINISH_TO_ANTHROPIC = {
  stop: 'end_turn',
  length: 'max_tokens',
  tool_calls: 'tool_use',
  content_filter: 'end_turn',
  function_call: 'tool_use',
};

function flattenContentToText(content) {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content
    .filter((b) => b && b.type === 'text')
    .map((b) => b.text || '')
    .join('\n');
}

// Anthropic content can be a string or an array of blocks (text / image /
// tool_use / tool_result). OpenAI chat messages are simpler: a user/assistant
// message has either a string or an array of {type:'text'|'image_url'} parts;
// tool results are their OWN message with role:'tool'. So one Anthropic
// "user" message containing a tool_result block must become a SEPARATE
// OpenAI {role:'tool', ...} message, not an inline part.
function anthropicMessagesToOpenAI(messages) {
  const out = [];
  for (const m of messages || []) {
    const content = m.content;
    if (typeof content === 'string') {
      out.push({ role: m.role, content });
      continue;
    }
    if (!Array.isArray(content)) continue;

    const toolResults = content.filter((b) => b && b.type === 'tool_result');
    const toolUses = content.filter((b) => b && b.type === 'tool_use');
    const parts = content.filter((b) => b && (b.type === 'text' || b.type === 'image'));

    // A tool-result message MUST come immediately after the assistant
    // message with the matching tool_calls — the OpenAI/Mistral spec rejects
    // any other role in between ("Unexpected role 'tool' after role 'user'").
    // An Anthropic "user" turn commonly carries a tool_result block AND
    // extra user text in the SAME content array (Claude Code routinely
    // injects a <system-reminder> text block alongside a tool_result) — so
    // the tool-role message(s) for this turn must be emitted BEFORE any
    // combined text message from the same array, not after.
    for (const tr of toolResults) {
      out.push({
        role: 'tool',
        tool_call_id: tr.tool_use_id,
        content: flattenContentToText(tr.content) || (typeof tr.content === 'string' ? tr.content : JSON.stringify(tr.content || '')),
      });
    }

    // An Anthropic assistant turn commonly carries BOTH a text block and a
    // tool_use block in the same content array (e.g. "I'll edit this file" +
    // the edit call) — the OpenAI spec models that as ONE message with both
    // `content` and `tool_calls` set, not two separate messages. Splitting it
    // changes the exact prompt bytes replayed every subsequent turn (extra
    // role boundaries in a long history), which can defeat prefix/KV-cache
    // reuse on the serving side for large agentic conversations.
    if (parts.length || toolUses.length) {
      const message = { role: m.role };
      if (parts.length) {
        const oaiParts = parts.map((b) => {
          if (b.type === 'text') return { type: 'text', text: b.text || '' };
          // Anthropic image block: {type:'image', source:{type:'base64', media_type, data}}
          const src = b.source || {};
          const url = src.type === 'base64'
            ? 'data:' + (src.media_type || 'image/png') + ';base64,' + src.data
            : (src.url || '');
          return { type: 'image_url', image_url: { url } };
        });
        message.content = oaiParts.length === 1 && oaiParts[0].type === 'text' ? oaiParts[0].text : oaiParts;
      } else if (toolUses.length) {
        message.content = null;
      }
      if (toolUses.length) {
        message.tool_calls = toolUses.map((tu) => ({
          id: tu.id,
          type: 'function',
          function: { name: tu.name, arguments: JSON.stringify(tu.input || {}) },
        }));
      }
      out.push(message);
    }
  }
  return out;
}

function anthropicToolChoiceToOpenAI(tc) {
  if (!tc) return undefined;
  if (tc.type === 'auto') return 'auto';
  if (tc.type === 'any') return 'required';
  if (tc.type === 'tool' && tc.name) return { type: 'function', function: { name: tc.name } };
  return undefined;
}

function anthropicToolsToOpenAI(tools) {
  if (!Array.isArray(tools)) return undefined;
  return tools.map((t) => ({
    type: 'function',
    function: {
      name: t.name,
      description: t.description || '',
      parameters: t.input_schema || { type: 'object', properties: {} },
    },
  }));
}

// Build an OpenAI-shaped chat/completions body from an Anthropic Messages
// API request body. `model` is the concrete upstream model id to send
// (already resolved by pool-router from the registered key record).
function anthropicRequestToOpenAI(anthropicReq, model) {
  const messages = [];
  if (anthropicReq.system) {
    const sysText = Array.isArray(anthropicReq.system)
      ? anthropicReq.system.map((b) => (b && b.text) || '').join('\n')
      : String(anthropicReq.system);
    if (sysText) messages.push({ role: 'system', content: sysText });
  }
  messages.push(...anthropicMessagesToOpenAI(anthropicReq.messages));

  const body = {
    model,
    messages,
    max_tokens: anthropicReq.max_tokens || 1024,
    stream: !!anthropicReq.stream,
  };
  if (body.stream) body.stream_options = { include_usage: true };
  if (anthropicReq.temperature !== undefined) body.temperature = anthropicReq.temperature;
  if (anthropicReq.top_p !== undefined) body.top_p = anthropicReq.top_p;
  if (anthropicReq.stop_sequences !== undefined) body.stop = anthropicReq.stop_sequences;
  const tools = anthropicToolsToOpenAI(anthropicReq.tools);
  if (tools) body.tools = tools;
  const toolChoice = anthropicToolChoiceToOpenAI(anthropicReq.tool_choice);
  if (toolChoice !== undefined) body.tool_choice = toolChoice;
  return body;
}

// ---------------------------------------------------------------------------
// OpenAI -> Anthropic response
// ---------------------------------------------------------------------------

function openAIResponseToAnthropic(completion, requestedModel) {
  const choice = (completion.choices && completion.choices[0]) || {};
  // OpenRouter (and some other aggregators) terminate a stream/response with
  // finish_reason:"error" when the upstream model itself failed mid-generation
  // — a non-standard value FINISH_TO_ANTHROPIC has no entry for. Without this
  // check it silently falls through to 'end_turn', telling the client the
  // turn ended normally when generation was actually truncated by a failure.
  // Throw instead so pool-router's existing try/catch classifies it and
  // rotates to the next candidate, rather than returning a fake success.
  if (choice.finish_reason === 'error') {
    throw new Error('upstream generation error (finish_reason: error)');
  }
  const msg = choice.message || {};
  const content = [];

  if (msg.content) content.push({ type: 'text', text: msg.content });
  if (Array.isArray(msg.tool_calls)) {
    for (const tc of msg.tool_calls) {
      let input = {};
      try { input = JSON.parse(tc.function.arguments || '{}'); } catch (_) { input = {}; }
      content.push({
        type: 'tool_use',
        id: tc.id || ('toolu_' + Math.random().toString(36).slice(2, 10)),
        name: tc.function.name,
        input,
      });
    }
  }
  if (!content.length) content.push({ type: 'text', text: '' });

  const usage = completion.usage || {};
  return {
    id: completion.id || ('msg_' + Math.random().toString(36).slice(2, 12)),
    type: 'message',
    role: 'assistant',
    model: requestedModel,
    content,
    stop_reason: FINISH_TO_ANTHROPIC[choice.finish_reason] || 'end_turn',
    stop_sequence: null,
    usage: {
      input_tokens: usage.prompt_tokens || 0,
      output_tokens: usage.completion_tokens || 0,
    },
  };
}

// One synthetic Anthropic SSE sequence from a complete (non-streamed)
// message — the M0 streaming shortcut described in the file header.
function anthropicMessageToSyntheticSSE(message) {
  const lines = [];
  const send = (event, data) => {
    lines.push('event: ' + event + '\ndata: ' + JSON.stringify(data) + '\n\n');
  };
  send('message_start', {
    type: 'message_start',
    message: Object.assign({}, message, { content: [], stop_reason: null, usage: { input_tokens: message.usage.input_tokens, output_tokens: 0 } }),
  });
  message.content.forEach((block, idx) => {
    send('content_block_start', { type: 'content_block_start', index: idx, content_block: block.type === 'text' ? { type: 'text', text: '' } : { type: 'tool_use', id: block.id, name: block.name, input: {} } });
    if (block.type === 'text') {
      send('content_block_delta', { type: 'content_block_delta', index: idx, delta: { type: 'text_delta', text: block.text } });
    } else {
      send('content_block_delta', { type: 'content_block_delta', index: idx, delta: { type: 'input_json_delta', partial_json: JSON.stringify(block.input || {}) } });
    }
    send('content_block_stop', { type: 'content_block_stop', index: idx });
  });
  send('message_delta', { type: 'message_delta', delta: { stop_reason: message.stop_reason, stop_sequence: null }, usage: { output_tokens: message.usage.output_tokens } });
  send('message_stop', { type: 'message_stop' });
  return lines.join('');
}

// SSE messages are terminated by a blank line — but "blank line" varies by
// server: OpenAI-compatible providers send plain `\n\n`, while Gemini's
// streamGenerateContent sends `\r\n\r\n` (CRLF). Live-tested: a naive
// `buf.indexOf('\n\n')` NEVER matches inside `\r\n\r\n` (the two `\n`s aren't
// adjacent — a `\r` sits between them), so a CRLF-emitting upstream would
// silently produce zero content_block events despite closing the stream
// normally. Search for either form and return how many characters to skip.
const SSE_BOUNDARY_RE = /\r\n\r\n|\n\n/;
function findSSEBoundary(buf) {
  const m = SSE_BOUNDARY_RE.exec(buf);
  return m ? { index: m.index, length: m[0].length } : null;
}

// ---------------------------------------------------------------------------
// Incremental streaming translation (OpenAI SSE -> Anthropic SSE), real
// token-by-token pass-through — this is what preserves native model speed
// and true streaming through the pool, rather than a buffer-then-emit shim.
// ---------------------------------------------------------------------------

// Stateful encoder: consumes one OpenAI streaming delta at a time (as parsed
// from `data: {...}` lines) and returns the Anthropic SSE event STRINGS to
// write to the client immediately. Tracks which content-block index is open
// (text vs. each parallel tool_call, keyed by OpenAI's own tool_call index)
// so multi-block / multi-tool-call streams interleave correctly.
class AnthropicStreamEncoder {
  constructor(requestedModel) {
    this.requestedModel = requestedModel;
    this.started = false;
    this.nextIndex = 0;
    this.textIndex = null;
    // Keyed by tc.index when the provider sends one; not every OpenAI-compatible
    // free provider numbers parallel tool calls reliably, so callers WITHOUT an
    // index fall back to keying on tc.id (or 'i0' as a last resort) instead of
    // all colliding on a shared '0' bucket.
    this.toolIndexByOpenAIIndex = new Map(); // key -> { anthIdx, id, name, started, argsBuf }
    this.inputTokens = 0;
    this.finishReason = null;
  }

  _event(event, data) {
    return 'event: ' + event + '\ndata: ' + JSON.stringify(data) + '\n\n';
  }

  start(inputTokens) {
    this.started = true;
    this.inputTokens = inputTokens || 0;
    return this._event('message_start', {
      type: 'message_start',
      message: {
        id: 'msg_' + Math.random().toString(36).slice(2, 12),
        type: 'message',
        role: 'assistant',
        model: this.requestedModel,
        content: [],
        stop_reason: null,
        stop_sequence: null,
        usage: { input_tokens: this.inputTokens, output_tokens: 0 },
      },
    });
  }

  // One OpenAI streaming chunk's choices[0]. Returns a (possibly empty) array
  // of SSE event strings to flush to the client right away.
  handleChoice(choice) {
    const out = [];
    const delta = (choice && choice.delta) || {};
    if (choice && choice.finish_reason) this.finishReason = choice.finish_reason;

    if (typeof delta.content === 'string' && delta.content !== '') {
      if (this.textIndex === null) {
        this.textIndex = this.nextIndex++;
        out.push(this._event('content_block_start', { type: 'content_block_start', index: this.textIndex, content_block: { type: 'text', text: '' } }));
      }
      out.push(this._event('content_block_delta', { type: 'content_block_delta', index: this.textIndex, delta: { type: 'text_delta', text: delta.content } }));
    }

    // Content_block_start only fires once a tool call's NAME is known (some
    // providers split id/name from the first argument fragment across
    // chunks); until then, argument fragments are buffered rather than
    // dropped, and flushed the moment content_block_start finally fires.
    if (Array.isArray(delta.tool_calls)) {
      for (const tc of delta.tool_calls) {
        const key = tc.index != null ? 'i' + tc.index : (tc.id ? 'id' + tc.id : 'i0');
        let entry = this.toolIndexByOpenAIIndex.get(key);
        if (entry === undefined) {
          entry = { anthIdx: this.nextIndex++, id: tc.id || ('toolu_' + Math.random().toString(36).slice(2, 10)), name: (tc.function && tc.function.name) || '', started: false, argsBuf: '' };
          this.toolIndexByOpenAIIndex.set(key, entry);
        } else {
          if (tc.id) entry.id = tc.id;
          if (tc.function && tc.function.name && !entry.name) entry.name = tc.function.name;
        }
        if (!entry.started && entry.name) {
          entry.started = true;
          out.push(this._event('content_block_start', { type: 'content_block_start', index: entry.anthIdx, content_block: { type: 'tool_use', id: entry.id, name: entry.name, input: {} } }));
          if (entry.argsBuf) {
            out.push(this._event('content_block_delta', { type: 'content_block_delta', index: entry.anthIdx, delta: { type: 'input_json_delta', partial_json: entry.argsBuf } }));
            entry.argsBuf = '';
          }
        }
        const argsFragment = (tc.function && tc.function.arguments) || '';
        if (argsFragment) {
          if (entry.started) out.push(this._event('content_block_delta', { type: 'content_block_delta', index: entry.anthIdx, delta: { type: 'input_json_delta', partial_json: argsFragment } }));
          else entry.argsBuf += argsFragment;
        }
      }
    }
    return out;
  }

  // Called once the upstream stream ends (data: [DONE] or connection close).
  finish(usage) {
    const out = [];
    // Flush any tool call whose name never arrived before the stream ended —
    // better to emit an empty-name block the client can at least see than to
    // silently drop it and leave content_block_stop counts inconsistent.
    for (const entry of this.toolIndexByOpenAIIndex.values()) {
      if (!entry.started) {
        out.push(this._event('content_block_start', { type: 'content_block_start', index: entry.anthIdx, content_block: { type: 'tool_use', id: entry.id, name: entry.name || '', input: {} } }));
        if (entry.argsBuf) out.push(this._event('content_block_delta', { type: 'content_block_delta', index: entry.anthIdx, delta: { type: 'input_json_delta', partial_json: entry.argsBuf } }));
      }
    }
    for (let i = 0; i < this.nextIndex; i++) {
      out.push(this._event('content_block_stop', { type: 'content_block_stop', index: i }));
    }
    // Bytes are already committed to the client at this point, so a
    // provider-signaled mid-stream error (e.g. OpenRouter's finish_reason:
    // "error") can't be turned into a rotation — emit a real Anthropic error
    // frame instead of fabricating a normal end_turn success.
    if (this.finishReason === 'error') {
      out.push(this._event('error', { type: 'error', error: { type: 'api_error', message: 'upstream generation error (finish_reason: error)' } }));
      return out.join('');
    }
    out.push(this._event('message_delta', {
      type: 'message_delta',
      delta: { stop_reason: FINISH_TO_ANTHROPIC[this.finishReason] || 'end_turn', stop_sequence: null },
      usage: { output_tokens: (usage && usage.completion_tokens) || 0 },
    }));
    out.push(this._event('message_stop', { type: 'message_stop' }));
    return out.join('');
  }
}

// Guards each individual reader.read() against a stalled-but-still-open
// upstream connection. fetchWithTimeout's AbortController (pool-router.cjs)
// only covers the CONNECT+HEADERS phase — its timer is cleared the moment
// fetch() resolves — so once a streaming response commits (headers sent,
// res.writeHead() already fired), a provider that goes silent mid-generation
// without closing the connection would otherwise hang reader.read() forever,
// leaving the client's spinner stuck with no error and no output (confirmed
// live: a Groq reasoning-model candidate idling mid-stream). Any single gap
// this long between chunks is treated as a stall, not a slow-but-alive
// stream — real SSE token/keep-alive traffic is far more frequent.
const STREAM_IDLE_TIMEOUT_MS = 25_000;

function readWithIdleTimeout(reader, idleMs = STREAM_IDLE_TIMEOUT_MS) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => {
      reject(Object.assign(new Error('upstream stream stalled: no data for ' + idleMs + 'ms'), { poolReason: 'timeout' }));
    }, idleMs);
  });
  return Promise.race([reader.read(), timeout]).finally(() => clearTimeout(timer));
}

// Drives a real fetch() streaming response from an OpenAI-compatible upstream
// through the encoder above, invoking `onChunk(sseString)` as soon as each
// translated event is ready — true incremental pass-through, no buffering
// beyond what's needed to find SSE line boundaries. Returns the final usage
// object (for the router's counters) once the upstream stream ends.
async function streamOpenAIToAnthropic(upstreamResponse, requestedModel, onChunk) {
  const encoder = new AnthropicStreamEncoder(requestedModel);
  const reader = upstreamResponse.body.getReader();
  const decoder = new TextDecoder();
  let buf = '';
  let usage = null;
  let startedMessage = false;

  while (true) {
    const { value, done } = await readWithIdleTimeout(reader);
    if (done) break;
    buf += decoder.decode(value, { stream: true });
    let boundary;
    while ((boundary = findSSEBoundary(buf)) !== null) {
      const line = buf.slice(0, boundary.index);
      buf = buf.slice(boundary.index + boundary.length);
      const dataLine = line.split(/\r?\n/).find((l) => l.startsWith('data:'));
      if (!dataLine) continue;
      const payload = dataLine.slice(5).trim();
      if (payload === '[DONE]') continue;
      let chunk;
      try { chunk = JSON.parse(payload); } catch (_) { continue; }
      if (!startedMessage) {
        startedMessage = true;
        onChunk(encoder.start((chunk.usage && chunk.usage.prompt_tokens) || 0));
      }
      if (chunk.usage) usage = chunk.usage;
      const choice = chunk.choices && chunk.choices[0];
      if (choice) {
        for (const ev of encoder.handleChoice(choice)) onChunk(ev);
      }
    }
  }
  if (!startedMessage) onChunk(encoder.start(0)); // upstream sent no chunks at all before closing
  onChunk(encoder.finish(usage));
  return usage;
}

// ---------------------------------------------------------------------------
// Gemini adapter — written directly against Google's official Gemini API
// reference: generateContent/streamGenerateContent request+response shape
// (ai.google.dev/api/generate-content), function calling (ai.google.dev/
// gemini-api/docs/function-calling), FinishReason enum + UsageMetadata field
// names (ai.google.dev/api/rest/v1beta/GenerateContentResponse), and API-key
// auth via x-goog-api-key (ai.google.dev/gemini-api/docs/api-key).
// ---------------------------------------------------------------------------

const GEMINI_FINISH_TO_ANTHROPIC = {
  STOP: 'end_turn',
  MAX_TOKENS: 'max_tokens',
  SAFETY: 'end_turn',
  RECITATION: 'end_turn',
  LANGUAGE: 'end_turn',
  BLOCKLIST: 'end_turn',
  PROHIBITED_CONTENT: 'end_turn',
  SPII: 'end_turn',
  MALFORMED_FUNCTION_CALL: 'end_turn',
  OTHER: 'end_turn',
  FINISH_REASON_UNSPECIFIED: 'end_turn',
};

// Gemini's `parameters` field only accepts a restricted OpenAPI-3.0-style
// subset of JSON Schema. Anthropic tool input_schema commonly contains keys
// outside that subset (often emitted by zod-to-json-schema); sending them
// causes a 400 INVALID_ARGUMENT for the ENTIRE request. Strip them recursively.
const GEMINI_UNSUPPORTED_SCHEMA_KEYS = new Set([
  '$schema', '$id', '$ref', '$defs', 'definitions',
  'additionalProperties', 'unevaluatedProperties', 'patternProperties', 'propertyNames',
  'contentEncoding', 'contentMediaType', 'examples', 'const',
  'if', 'then', 'else', 'not',
  'exclusiveMinimum', 'exclusiveMaximum',
]);

function sanitizeGeminiSchema(schema) {
  if (Array.isArray(schema)) return schema.map(sanitizeGeminiSchema);
  if (!schema || typeof schema !== 'object') return schema;
  const out = {};
  for (const [key, value] of Object.entries(schema)) {
    if (GEMINI_UNSUPPORTED_SCHEMA_KEYS.has(key)) continue;
    // Gemini has no anyOf/oneOf/allOf combinator support, only a flat
    // `nullable: true` flag. Collapse the common [X, {type:'null'}] optional
    // pattern down to X + nullable; otherwise best-effort take branch 0.
    if ((key === 'anyOf' || key === 'oneOf') && Array.isArray(value)) {
      const nonNull = value.filter((v) => !(v && v.type === 'null'));
      const hadNull = nonNull.length !== value.length;
      if (nonNull.length >= 1) {
        Object.assign(out, sanitizeGeminiSchema(nonNull[0]));
        if (hadNull) out.nullable = true;
      }
      continue;
    }
    if (key === 'allOf' && Array.isArray(value)) {
      for (const branch of value) Object.assign(out, sanitizeGeminiSchema(branch));
      continue;
    }
    out[key] = sanitizeGeminiSchema(value);
  }
  return out;
}

function anthropicMessagesToGemini(messages) {
  const contents = [];
  // Anthropic tool_result blocks only carry tool_use_id, but Gemini's
  // functionResponse part requires the function NAME — track id->name from
  // the tool_use block seen earlier in the same message array.
  const toolNameById = new Map();

  for (const m of messages || []) {
    const role = m.role === 'assistant' ? 'model' : 'user';
    const content = m.content;

    if (typeof content === 'string') {
      if (content) contents.push({ role, parts: [{ text: content }] });
      continue;
    }
    if (!Array.isArray(content)) continue;

    const parts = [];
    for (const b of content) {
      if (!b) continue;
      if (b.type === 'text') {
        parts.push({ text: b.text || '' });
      } else if (b.type === 'image') {
        const src = b.source || {};
        if (src.type === 'base64') {
          parts.push({ inlineData: { mimeType: src.media_type || 'image/png', data: src.data } });
        }
        // A source.url image has no equivalent: Gemini's fileData part
        // expects a Gemini-uploaded file URI, not an arbitrary external URL,
        // so it is dropped rather than mis-encoded.
      } else if (b.type === 'tool_use') {
        toolNameById.set(b.id, b.name);
        parts.push({ functionCall: { name: b.name, args: b.input || {} } });
      } else if (b.type === 'tool_result') {
        const name = toolNameById.get(b.tool_use_id) || 'unknown_function';
        const text = flattenContentToText(b.content)
          || (typeof b.content === 'string' ? b.content : JSON.stringify(b.content || ''));
        // functionResponse.response has no fixed schema (free-form JSON) —
        // this wrapper is a reasonable but non-authoritative choice; a tool
        // expecting the exact original return shape may not round-trip
        // perfectly.
        parts.push({ functionResponse: { name, response: { content: text } } });
      }
    }
    if (parts.length) contents.push({ role, parts });
  }
  return contents;
}

function anthropicToolsToGemini(tools) {
  if (!Array.isArray(tools) || !tools.length) return undefined;
  return [{
    functionDeclarations: tools.map((t) => ({
      name: t.name,
      description: t.description || '',
      parameters: sanitizeGeminiSchema(t.input_schema || { type: 'object', properties: {} }),
    })),
  }];
}

function anthropicToolChoiceToGemini(tc) {
  if (!tc) return undefined;
  if (tc.type === 'auto') return { functionCallingConfig: { mode: 'AUTO' } };
  if (tc.type === 'any') return { functionCallingConfig: { mode: 'ANY' } };
  if (tc.type === 'none') return { functionCallingConfig: { mode: 'NONE' } };
  if (tc.type === 'tool' && tc.name) return { functionCallingConfig: { mode: 'ANY', allowedFunctionNames: [tc.name] } };
  return undefined;
}

function anthropicRequestToGemini(anthropicReq, model) {
  const body = { contents: anthropicMessagesToGemini(anthropicReq.messages) };

  if (anthropicReq.system) {
    const sysText = Array.isArray(anthropicReq.system)
      ? anthropicReq.system.map((b) => (b && b.text) || '').join('\n')
      : String(anthropicReq.system);
    // systemInstruction is a top-level sibling of `contents`, NOT a message
    // with role "system" inside contents — the biggest structural difference
    // from the Anthropic/OpenAI request shape.
    if (sysText) body.systemInstruction = { parts: [{ text: sysText }] };
  }

  const generationConfig = {};
  if (anthropicReq.max_tokens !== undefined) generationConfig.maxOutputTokens = anthropicReq.max_tokens;
  if (anthropicReq.temperature !== undefined) generationConfig.temperature = anthropicReq.temperature;
  if (anthropicReq.top_p !== undefined) generationConfig.topP = anthropicReq.top_p;
  if (anthropicReq.stop_sequences !== undefined) generationConfig.stopSequences = anthropicReq.stop_sequences;
  if (Object.keys(generationConfig).length) body.generationConfig = generationConfig;

  const tools = anthropicToolsToGemini(anthropicReq.tools);
  if (tools) body.tools = tools;
  const toolConfig = anthropicToolChoiceToGemini(anthropicReq.tool_choice);
  if (toolConfig) body.toolConfig = toolConfig;

  // Deliberately NOT set here: `model` and `stream`. Gemini takes the model
  // from the URL path (models/{model}:generateContent) and picks streaming
  // vs non-streaming from which of two URL suffixes the caller hits
  // (:generateContent vs :streamGenerateContent?alt=sse), not a body flag —
  // see pool-router.cjs's upstreamRequestParts.
  return body;
}

function geminiResponseToAnthropic(completion, requestedModel) {
  const candidate = (completion.candidates && completion.candidates[0]) || {};
  const parts = (candidate.content && candidate.content.parts) || [];
  const content = [];
  let sawFunctionCall = false;

  for (const p of parts) {
    if (!p) continue;
    if (typeof p.text === 'string') {
      content.push({ type: 'text', text: p.text });
    } else if (p.functionCall) {
      sawFunctionCall = true;
      content.push({
        type: 'tool_use',
        // Gemini function calls carry no id; synthesize one so a later
        // tool_result can round-trip back via tool_use_id.
        id: 'toolu_' + Math.random().toString(36).slice(2, 10),
        name: p.functionCall.name,
        input: p.functionCall.args || {},
      });
    }
  }
  if (!content.length) content.push({ type: 'text', text: '' });

  const usage = completion.usageMetadata || {};
  // Gemini reports finishReason "STOP" even when the turn is entirely a
  // function call — there is no distinct finish reason for a *successful*
  // call (MALFORMED_FUNCTION_CALL is only for a failed one). Mapping STOP ->
  // end_turn unconditionally would make a Claude-Code-style agent loop treat
  // the turn as finished and never execute the tool, since it keys off
  // stop_reason === 'tool_use'. Force it whenever a functionCall part is
  // present; only fall back to the table otherwise.
  const stopReason = sawFunctionCall
    ? 'tool_use'
    : (GEMINI_FINISH_TO_ANTHROPIC[candidate.finishReason] || 'end_turn');

  return {
    id: completion.responseId || ('msg_' + Math.random().toString(36).slice(2, 12)),
    type: 'message',
    role: 'assistant',
    model: requestedModel,
    content,
    stop_reason: stopReason,
    stop_sequence: null,
    usage: {
      input_tokens: usage.promptTokenCount || 0,
      output_tokens: usage.candidatesTokenCount || 0,
    },
  };
}

// Gemini streams whole GenerateContentResponse objects per chunk (not OpenAI-
// style deltas): text still arrives incrementally (each chunk's part.text is
// the NEW fragment), but a functionCall arrives whole in one chunk rather
// than fragmented token-by-token — so there's no per-index partial_json
// accumulation needed; a tool_use block is opened, filled, and closed in one step.
class GeminiStreamEncoder {
  constructor(requestedModel) {
    this.requestedModel = requestedModel;
    this.nextIndex = 0;
    this.textIndex = null;
    this.finishReason = null;
    this.sawFunctionCall = false;
  }
  _event(event, data) { return 'event: ' + event + '\ndata: ' + JSON.stringify(data) + '\n\n'; }
  start(inputTokens) {
    return this._event('message_start', {
      type: 'message_start',
      message: {
        id: 'msg_' + Math.random().toString(36).slice(2, 12), type: 'message', role: 'assistant', model: this.requestedModel,
        content: [], stop_reason: null, stop_sequence: null,
        usage: { input_tokens: inputTokens || 0, output_tokens: 0 },
      },
    });
  }
  handleChunk(chunk) {
    const out = [];
    const candidate = (chunk.candidates && chunk.candidates[0]) || {};
    if (candidate.finishReason) this.finishReason = candidate.finishReason;
    const parts = (candidate.content && candidate.content.parts) || [];
    for (const p of parts) {
      if (!p) continue;
      if (typeof p.text === 'string' && p.text !== '') {
        if (this.textIndex === null) {
          this.textIndex = this.nextIndex++;
          out.push(this._event('content_block_start', { type: 'content_block_start', index: this.textIndex, content_block: { type: 'text', text: '' } }));
        }
        out.push(this._event('content_block_delta', { type: 'content_block_delta', index: this.textIndex, delta: { type: 'text_delta', text: p.text } }));
      } else if (p.functionCall) {
        this.sawFunctionCall = true;
        const idx = this.nextIndex++;
        const id = 'toolu_' + Math.random().toString(36).slice(2, 10);
        out.push(this._event('content_block_start', { type: 'content_block_start', index: idx, content_block: { type: 'tool_use', id, name: p.functionCall.name, input: {} } }));
        out.push(this._event('content_block_delta', { type: 'content_block_delta', index: idx, delta: { type: 'input_json_delta', partial_json: JSON.stringify(p.functionCall.args || {}) } }));
      }
    }
    return out;
  }
  finish(usage) {
    const out = [];
    for (let i = 0; i < this.nextIndex; i++) out.push(this._event('content_block_stop', { type: 'content_block_stop', index: i }));
    const stopReason = this.sawFunctionCall
      ? 'tool_use'
      : (GEMINI_FINISH_TO_ANTHROPIC[this.finishReason] || 'end_turn');
    out.push(this._event('message_delta', {
      type: 'message_delta',
      delta: { stop_reason: stopReason, stop_sequence: null },
      usage: { output_tokens: (usage && usage.candidatesTokenCount) || 0 },
    }));
    out.push(this._event('message_stop', { type: 'message_stop' }));
    return out.join('');
  }
}

async function streamGeminiToAnthropic(upstreamResponse, requestedModel, onChunk) {
  const encoder = new GeminiStreamEncoder(requestedModel);
  const reader = upstreamResponse.body.getReader();
  const decoder = new TextDecoder();
  let buf = ''; let usage = null; let startedMessage = false;
  while (true) {
    const { value, done } = await readWithIdleTimeout(reader);
    if (done) break;
    buf += decoder.decode(value, { stream: true });
    let boundary;
    while ((boundary = findSSEBoundary(buf)) !== null) {
      const line = buf.slice(0, boundary.index); buf = buf.slice(boundary.index + boundary.length);
      const dataLine = line.split(/\r?\n/).find((l) => l.startsWith('data:'));
      if (!dataLine) continue;
      const payload = dataLine.slice(5).trim();
      if (!payload || payload === '[DONE]') continue;
      let chunk;
      try { chunk = JSON.parse(payload); } catch (_) { continue; }
      if (!startedMessage) {
        startedMessage = true;
        onChunk(encoder.start((chunk.usageMetadata && chunk.usageMetadata.promptTokenCount) || 0));
      }
      if (chunk.usageMetadata) usage = chunk.usageMetadata;
      for (const ev of encoder.handleChunk(chunk)) onChunk(ev);
    }
  }
  if (!startedMessage) onChunk(encoder.start(0));
  onChunk(encoder.finish(usage));
  return usage;
}

// ---------------------------------------------------------------------------
// Adapter dispatch
// ---------------------------------------------------------------------------

const adapters = {
  anthropic: {
    // Identity passthrough — forward the Anthropic body (and its stream flag)
    // unchanged, exactly what bin/ccx already does for base-URL swap. A
    // native Anthropic-wire provider's own SSE bytes ARE already
    // Anthropic-shaped, so the streaming path is a literal byte pass-through
    // (see pool-router.cjs's dispatchStreaming) — no translation at all.
    toUpstream(anthropicReq, model) {
      return Object.assign({}, anthropicReq, { model });
    },
    toAnthropic(upstreamJson) {
      return upstreamJson;
    },
  },
  openai: {
    toUpstream: anthropicRequestToOpenAI,
    toAnthropic: openAIResponseToAnthropic,
  },
  gemini: {
    toUpstream: anthropicRequestToGemini,
    toAnthropic: geminiResponseToAnthropic,
  },
};

function adapterFor(wire) {
  const a = adapters[wire];
  if (!a) throw new Error('unknown wire format: ' + wire);
  return a;
}

module.exports = {
  adapterFor,
  anthropicMessageToSyntheticSSE,
  streamOpenAIToAnthropic,
  streamGeminiToAnthropic,
  readWithIdleTimeout,
};
