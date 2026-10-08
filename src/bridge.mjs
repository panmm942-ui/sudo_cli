import { createServer } from 'node:http';
import { createHash, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { once } from 'node:events';

const MAX_BODY_BYTES = 16 * 1024 * 1024;
const MAX_HISTORY_CALLS = 1024;

class BridgeError extends Error {
  constructor(status, message, code = 'invalid_request_error', headers = {}) {
    super(message);
    this.status = status;
    this.code = code;
    this.headers = headers;
  }
}

const invalid = (message) => { throw new BridgeError(400, message); };
const record = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
const text = (value, name) => { if (typeof value !== 'string') invalid(`${name} must be a string.`); return value; };
const identifier = (value, name) => { if (typeof value !== 'string' || !value.length || value.length > 256) invalid(`${name} must be a nonempty identifier.`); return value; };
const validModel = (value) => typeof value === 'string' && value.trim().length > 0 && !/[\u0000-\u001f\u007f]/.test(value);

function endpoint(baseUrl) {
  let url;
  try { url = new URL(baseUrl); } catch { throw new Error('The model base URL must be a valid HTTP or HTTPS URL.'); }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) {
    throw new Error('The model base URL must use HTTP or HTTPS without credentials, query, or fragment.');
  }
  url.pathname = `${url.pathname.replace(/\/+$/, '')}/chat/completions`;
  return url.href;
}

function content(value, { images = true } = {}) {
  if (typeof value === 'string') return value;
  if (!Array.isArray(value)) invalid('Message content must be text or an array of text/image items.');
  const parts = value.map((part) => {
    if (!record(part)) invalid('Message content items must be objects.');
    if (['input_text', 'output_text'].includes(part.type)) return { type: 'text', text: text(part.text, 'Content text') };
    if (part.type === 'input_image' && images) {
      const url = text(part.image_url, 'Image URL');
      if (!/^(https?:\/\/|data:image\/)/i.test(url)) invalid('Images must use HTTP(S) or a data:image URL.');
      if (part.detail !== undefined && !['auto', 'low', 'high', 'original'].includes(part.detail)) invalid('Image detail must be auto, low, high, or original.');
      return { type: 'image_url', image_url: { url, ...(part.detail ? { detail: part.detail } : {}) } };
    }
    invalid(`Unsupported content type: ${String(part.type)}.`);
  });
  return parts.every((part) => part.type === 'text') ? parts.map((part) => part.text).join('\n') : parts;
}

function toolOutput(value) {
  if (record(value) && typeof value.content === 'string') return { content: value.content, images: [] };
  const converted = content(value);
  if (typeof converted === 'string') return { content: converted, images: [] };
  return { content: converted.filter((part) => part.type === 'text').map((part) => part.text).join('\n'), images: converted.filter((part) => part.type === 'image_url') };
}

function convertTools(input) {
  if (input === undefined) return { tools: undefined, custom: new Map(), byFlat: new Map(), byLogical: new Map() };
  if (!Array.isArray(input) || input.length > 256) invalid('tools must be an array with at most 256 entries.');
  const custom = new Map();
  const byFlat = new Map();
  const byLogical = new Map();
  const entries = [];
  for (const tool of input) {
    if (!record(tool)) invalid('Tool definitions must be objects.');
    if (tool.type === 'namespace') {
      const namespace = identifier(tool.name, 'Tool namespace');
      if (!/^[a-zA-Z0-9_-]+$/.test(namespace) || !Array.isArray(tool.tools)) invalid('A tool namespace requires a valid name and a tools array.');
      for (const child of tool.tools) entries.push({ tool: child, namespace, description: tool.description });
    } else entries.push({ tool, namespace: null });
  }
  if (entries.length > 1024) invalid('The flattened tool catalog exceeds 1024 tools.');
  const directNames = new Set(entries.filter((entry) => entry.namespace === null).map((entry) => entry.tool?.name));
  const tools = entries.map(({ tool, namespace, description: namespaceDescription }) => {
    if (!record(tool)) invalid('Tool definitions must be objects.');
    if (!['function', 'custom'].includes(tool.type)) invalid(`Unsupported hosted or native tool: ${String(tool.type)}. Use a function tool or MCP instead.`);
    const originalName = identifier(tool.name, 'Tool name');
    if (!/^[a-zA-Z0-9_-]+$/.test(originalName)) invalid('Tool names must use letters, numbers, underscores, or hyphens.');
    const logical = JSON.stringify([namespace, originalName]);
    if (byLogical.has(logical)) invalid('Tool names must be unique within their namespace.');
    let name = namespace ? `${namespace}__${originalName}` : originalName;
    if (name.length > 64 || (namespace && directNames.has(name)) || byFlat.has(name)) {
      name = `${name.slice(0, 50)}__${createHash('sha256').update(logical).digest('hex').slice(0, 12)}`;
    }
    if (byFlat.has(name) || (namespace && directNames.has(name))) invalid('Tool names cannot be flattened without a collision.');
    byLogical.set(logical, name);
    byFlat.set(name, { name: originalName, namespace, type: tool.type });
    const descriptionParts = [namespaceDescription === undefined ? '' : text(namespaceDescription, 'Namespace description'), tool.description === undefined ? '' : text(tool.description, 'Tool description')].filter(Boolean);
    if (tool.type === 'function') {
      if (tool.parameters !== undefined && !record(tool.parameters)) invalid('Function parameters must be a JSON Schema object.');
      return { type: 'function', function: {
        name, ...(descriptionParts.length ? { description: descriptionParts.join('\n\n') } : {}),
        parameters: tool.parameters ?? { type: 'object', properties: {} },
        ...(tool.strict !== undefined ? { strict: Boolean(tool.strict) } : {}),
      } };
    }
    custom.set(name, tool);
    const description = [...descriptionParts,
      'Pass the complete raw tool input in the input string, preserving all newlines.',
      tool.format?.type === 'grammar' ? `The input must follow this ${tool.format.syntax ?? ''} grammar:\n${text(tool.format.definition, 'Custom tool grammar')}` : '',
    ].filter(Boolean).join('\n\n');
    return { type: 'function', function: { name, description, parameters: {
      type: 'object', properties: { input: { type: 'string' } }, required: ['input'], additionalProperties: false,
    } } };
  });
  return { tools, custom, byFlat, byLogical };
}

function messages(body, reasoning, byLogical) {
  const out = [];
  const calls = new Map();
  const outputs = new Set();
  const pending = new Set();
  const toolImages = [];
  if (body.instructions !== undefined && body.instructions !== null) out.push({ role: 'system', content: text(body.instructions, 'Instructions') });
  const input = typeof body.input === 'string' ? [{ role: 'user', content: body.input }] : body.input;
  if (!Array.isArray(input) || input.length > 10000) invalid('input must be text or an array with at most 10000 items.');
  for (const item of input) {
    if (!record(item)) invalid('Input items must be objects.');
    if (item.type === 'reasoning') continue;
    if (!item.type || item.type === 'message') {
      if (!['system', 'developer', 'user', 'assistant'].includes(item.role)) invalid('Unsupported message role.');
      out.push({ role: item.role === 'developer' ? 'system' : item.role, content: content(item.content, { images: item.role === 'user' }) });
      continue;
    }
    if (['function_call', 'custom_tool_call'].includes(item.type)) {
      const id = identifier(item.call_id, 'Tool call ID');
      if (calls.has(id)) invalid('Duplicate tool call ID in input history.');
      const originalName = identifier(item.name, 'Tool call name');
      const namespace = item.namespace == null ? null : identifier(item.namespace, 'Tool call namespace');
      calls.set(id, namespace ? `${namespace}.${originalName}` : originalName);
      pending.add(id);
      const mappedName = byLogical.get(JSON.stringify([namespace, originalName]));
      if (namespace && !mappedName) invalid('Input history contains an undeclared namespace tool.');
      const name = mappedName ?? originalName;
      const args = item.type === 'custom_tool_call' ? JSON.stringify({ input: text(item.input, 'Custom tool input') }) : text(item.arguments, 'Function arguments');
      let assistant = out.at(-1);
      if (!assistant || assistant.role !== 'assistant') {
        assistant = { role: 'assistant', content: null };
        out.push(assistant);
      }
      (assistant.tool_calls ??= []).push({ id, type: 'function', function: { name, arguments: args } });
      if (reasoning.has(id)) assistant.reasoning_content = reasoning.get(id);
      continue;
    }
    if (['function_call_output', 'custom_tool_call_output'].includes(item.type)) {
      const id = identifier(item.call_id, 'Tool output call ID');
      if (!calls.has(id) || outputs.has(id)) invalid('Tool output must match a preceding call exactly once.');
      outputs.add(id);
      pending.delete(id);
      const output = toolOutput(item.output);
      out.push({ role: 'tool', tool_call_id: id, content: output.content });
      if (output.images.length) toolImages.push({ type: 'text', text: `Images returned by tool ${calls.get(id)} (call ${id}). These images are tool output.` }, ...output.images);
      // Chat Completions tool messages cannot contain images. Attach them in a
      // clearly attributed user message after all parallel tool results finish.
      if (!pending.size && toolImages.length) out.push({ role: 'user', content: toolImages.splice(0) });
      continue;
    }
    invalid(`Unsupported input item type: ${String(item.type)}.`);
  }
  if (pending.size) invalid('Every tool call in input history must have a corresponding output.');
  if (!out.length) invalid('input must contain at least one message.');
  return out;
}

function modelRequest(body, model, reasoning) {
  if (!record(body)) invalid('The request must be a JSON object.');
  const selectedModel = body.model === undefined ? model : body.model;
  if (!validModel(selectedModel)) invalid('Model must be a nonempty identifier without control characters.');
  if (body.previous_response_id) invalid('previous_response_id is unsupported; send the complete input history.');
  if (body.stream !== undefined && typeof body.stream !== 'boolean') invalid('stream must be a boolean.');
  const { tools, custom, byFlat, byLogical } = convertTools(body.tools);
  const request = { model: selectedModel, stream: false, messages: messages(body, reasoning, byLogical) };
  if (body.reasoning !== undefined) {
    if (!record(body.reasoning)) invalid('reasoning must be an object.');
    const effort = body.reasoning.effort;
    // Native models can use custom effort identifiers. The runtime profile
    // validates support; the adapter preserves the exact explicit request.
    if (effort !== undefined) {
      if (typeof effort !== 'string' || !/^[a-z][a-z0-9_-]{0,63}$/.test(effort)) invalid('Reasoning effort must be a valid effort identifier.');
      request.reasoning_effort = effort;
    }
  }
  if (tools?.length) request.tools = tools;
  for (const key of ['temperature', 'top_p']) {
    if (body[key] !== undefined) {
      if (typeof body[key] !== 'number' || !Number.isFinite(body[key])) invalid(`${key} must be a finite number.`);
      request[key] = body[key];
    }
  }
  if (body.max_output_tokens !== undefined) {
    if (!Number.isSafeInteger(body.max_output_tokens) || body.max_output_tokens < 1) invalid('max_output_tokens must be a positive integer.');
    request.max_tokens = body.max_output_tokens;
  }
  if (body.parallel_tool_calls !== undefined) {
    if (typeof body.parallel_tool_calls !== 'boolean') invalid('parallel_tool_calls must be a boolean.');
    if (tools?.length) request.parallel_tool_calls = body.parallel_tool_calls;
  }
  if (body.tool_choice !== undefined && tools?.length) {
    if (['auto', 'none', 'required'].includes(body.tool_choice)) request.tool_choice = body.tool_choice;
    else if (record(body.tool_choice) && ['function', 'custom'].includes(body.tool_choice.type)) {
      const originalName = identifier(body.tool_choice.name, 'Tool choice name');
      const namespace = body.tool_choice.namespace == null ? null : identifier(body.tool_choice.namespace, 'Tool choice namespace');
      const name = byLogical.get(JSON.stringify([namespace, originalName]));
      if (!name) invalid('tool_choice must name a declared tool.');
      request.tool_choice = { type: 'function', function: { name } };
    } else invalid('Unsupported tool_choice.');
  }
  return { request, custom, toolNames: byFlat };
}

function completedResponse(upstream, model, custom, toolNames, reasoning) {
  const message = upstream?.choices?.[0]?.message;
  const malformed = () => { throw new BridgeError(502, 'The model returned an unsupported or malformed Chat Completions response.', 'upstream_error'); };
  if (!record(message) || message.role !== 'assistant') malformed();
  if (upstream.choices[0].finish_reason === 'length') throw new BridgeError(502, 'The model output was truncated. Increase its output token limit and retry.', 'upstream_incomplete');
  if (upstream.choices[0].finish_reason === 'content_filter') throw new BridgeError(502, 'The model endpoint filtered the response.', 'upstream_incomplete');
  const output = [];
  if (message.content !== undefined && message.content !== null && typeof message.content !== 'string') malformed();
  if (message.content) output.push({ id: `msg_${randomUUID()}`, type: 'message', status: 'completed', role: 'assistant', content: [{ type: 'output_text', text: message.content, annotations: [] }] });
  if (message.tool_calls !== undefined && !Array.isArray(message.tool_calls)) malformed();
  const ids = new Set();
  for (const call of message.tool_calls ?? []) {
    if (!record(call) || call.type !== 'function' || !record(call.function) || !toolNames.has(call.function.name) || typeof call.function.arguments !== 'string' || typeof call.id !== 'string' || !call.id || ids.has(call.id)) malformed();
    ids.add(call.id);
    const identity = toolNames.get(call.function.name);
    const item = { id: `fc_${randomUUID()}`, call_id: call.id, name: identity.name, ...(identity.namespace ? { namespace: identity.namespace } : {}) };
    if (custom.has(call.function.name)) {
      let args;
      try { args = JSON.parse(call.function.arguments); } catch { malformed(); }
      if (!record(args) || typeof args.input !== 'string') malformed();
      output.push({ ...item, type: 'custom_tool_call', input: args.input });
    } else output.push({ ...item, type: 'function_call', status: 'completed', arguments: call.function.arguments });
    if (typeof message.reasoning_content === 'string') {
      reasoning.delete(call.id);
      reasoning.set(call.id, message.reasoning_content);
      while (reasoning.size > MAX_HISTORY_CALLS) reasoning.delete(reasoning.keys().next().value);
    }
  }
  if (!output.length) output.push({ id: `msg_${randomUUID()}`, type: 'message', status: 'completed', role: 'assistant', content: [{ type: 'output_text', text: message.content ?? message.refusal ?? '', annotations: [] }] });
  const count = (value) => Number.isSafeInteger(value) && value >= 0 ? value : 0;
  const inputTokens = count(upstream.usage?.prompt_tokens);
  const outputTokens = count(upstream.usage?.completion_tokens);
  return {
    id: `resp_${randomUUID()}`, object: 'response', created_at: Math.floor(Date.now() / 1000), status: 'completed',
    model, output, error: null, incomplete_details: null,
    usage: { input_tokens: inputTokens, input_tokens_details: { cached_tokens: count(upstream.usage?.prompt_tokens_details?.cached_tokens) },
      output_tokens: outputTokens, output_tokens_details: { reasoning_tokens: count(upstream.usage?.completion_tokens_details?.reasoning_tokens) },
      total_tokens: count(upstream.usage?.total_tokens) || inputTokens + outputTokens },
  };
}

// The upstream result is buffered. Protocol events preserve the Responses event
// order required by Codex, but do not imply token-by-token upstream generation.
function sendSse(res, response) {
  res.writeHead(200, { 'content-type': 'text/event-stream; charset=utf-8', 'cache-control': 'no-cache', 'x-accel-buffering': 'no' });
  let sequence = 0;
  const emit = (type, value) => res.write(`event: ${type}\ndata: ${JSON.stringify({ type, sequence_number: sequence++, ...value })}\n\n`);
  const pending = { ...response, status: 'in_progress', output: [], usage: null };
  emit('response.created', { response: pending });
  emit('response.in_progress', { response: pending });
  response.output.forEach((item, output_index) => {
    const item_id = item.id;
    if (item.type === 'message') {
      emit('response.output_item.added', { output_index, item: { ...item, status: 'in_progress', content: [] } });
      item.content.forEach((part, content_index) => {
        const position = { item_id, output_index, content_index };
        emit('response.content_part.added', { ...position, part: { ...part, text: '' } });
        emit('response.output_text.delta', { ...position, delta: part.text });
        emit('response.output_text.done', { ...position, text: part.text });
        emit('response.content_part.done', { ...position, part });
      });
    } else if (item.type === 'function_call') {
      emit('response.output_item.added', { output_index, item: { ...item, status: 'in_progress', arguments: '' } });
      emit('response.function_call_arguments.delta', { item_id, output_index, delta: item.arguments });
      emit('response.function_call_arguments.done', { item_id, output_index, arguments: item.arguments });
    } else {
      emit('response.output_item.added', { output_index, item: { ...item, input: '' } });
      emit('response.custom_tool_call_input.delta', { item_id, output_index, delta: item.input });
      emit('response.custom_tool_call_input.done', { item_id, output_index, input: item.input });
    }
    emit('response.output_item.done', { output_index, item });
  });
  emit('response.completed', { response });
  res.end();
}

function sendJson(res, status, body, headers = {}) {
  if (res.destroyed || res.writableEnded) return;
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', ...headers });
  res.end(JSON.stringify(body));
}

function readRequest(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    let settled = false;
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        if (!settled) { settled = true; reject(new BridgeError(413, 'Request exceeds the 16 MiB bridge limit.')); }
        chunks.length = 0;
      } else if (!settled) chunks.push(chunk);
    });
    req.on('end', () => {
      if (settled) return;
      settled = true;
      try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8'))); }
      catch { reject(new BridgeError(400, 'Request body must be valid JSON.')); }
    });
    req.on('error', () => { if (!settled) { settled = true; reject(new BridgeError(400, 'Request body could not be read.')); } });
  });
}

async function readUpstream(response) {
  const chunks = [];
  let size = 0;
  for await (const chunk of response.body ?? []) {
    size += chunk.length;
    if (size > MAX_BODY_BYTES) throw new BridgeError(502, 'Model response exceeds the 16 MiB bridge limit.', 'upstream_error');
    chunks.push(chunk);
  }
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); }
  catch { throw new BridgeError(502, 'The model returned invalid JSON.', 'upstream_error'); }
}

/** Start a private, authenticated Responses-to-Chat-Completions adapter. */
export async function startBridge({ baseUrl, model, apiKey, timeoutMs = 120000, onMetrics = () => {} } = {}) {
  const url = endpoint(baseUrl);
  if (!validModel(model)) throw new Error('A nonempty model identifier without control characters is required.');
  if (apiKey !== undefined && (typeof apiKey !== 'string' || !apiKey.trim() || /[\r\n]/.test(apiKey))) throw new Error('If provided, the API key must be a nonempty string without line breaks.');
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 2147483647) throw new Error('timeoutMs must be a positive integer within the timer range.');
  const token = randomBytes(32).toString('hex');
  const expectedAuth = Buffer.from(`Bearer ${token}`);
  const reasoning = new Map();
  const controllers = new Set();
  const server = createServer(async (req, res) => {
    if (req.url === '/health' && req.method === 'GET') return sendJson(res, 200, { status: 'ok' });
    if (req.url !== '/v1/responses') return sendJson(res, 404, { error: { message: 'Endpoint not found.', type: 'invalid_request_error' } });
    const auth = Buffer.from(req.headers.authorization ?? '');
    if (auth.length !== expectedAuth.length || !timingSafeEqual(auth, expectedAuth)) return sendJson(res, 401, { error: { message: 'Bridge authentication required.', type: 'authentication_error' } }, { 'www-authenticate': 'Bearer' });
    if (req.method !== 'POST') return sendJson(res, 405, { error: { message: 'Use POST for Responses requests.', type: 'invalid_request_error' } }, { allow: 'POST' });
    const controller = new AbortController();
    controllers.add(controller);
    const abort = () => { if (!res.writableEnded) controller.abort(); };
    req.once('aborted', abort);
    res.once('close', abort);
    let timedOut = false;
    let requestId, started;
    const metric = (phase) => { if (requestId) { try { onMetrics({ phase, id: requestId, latencyMs: performance.now() - started, source: 'buffered-chat-response' }); } catch { /* Metrics cannot interrupt the transport. */ } } };
    const timer = setTimeout(() => { timedOut = true; controller.abort(); }, timeoutMs);
    timer.unref();
    try {
      if (req.headers['content-encoding'] && req.headers['content-encoding'] !== 'identity') throw new BridgeError(415, 'Compressed request bodies are unsupported.');
      const body = await readRequest(req);
      const { request, custom, toolNames } = modelRequest(body, model, reasoning);
      if (controller.signal.aborted) throw new Error('Aborted');
      requestId = randomUUID(); started = performance.now(); metric('started');
      const upstream = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json', ...(apiKey === undefined ? {} : { authorization: `Bearer ${apiKey}` }) }, body: JSON.stringify(request), signal: controller.signal, redirect: 'error' });
      if (!upstream.ok) {
        await upstream.body?.cancel();
        const status = upstream.status >= 400 && upstream.status <= 599 ? upstream.status : 502;
        const retryAfter = upstream.headers.get('retry-after');
        throw new BridgeError(status, `Model endpoint returned HTTP ${upstream.status}.`, 'upstream_error', retryAfter && /^\d{1,8}$/.test(retryAfter) ? { 'retry-after': retryAfter } : {});
      }
      const response = completedResponse(await readUpstream(upstream), request.model, custom, toolNames, reasoning);
      metric('succeeded');
      if (res.destroyed) return;
      if (body.stream === true) sendSse(res, response);
      else sendJson(res, 200, response);
    } catch (error) {
      metric(controller.signal.aborted && !timedOut ? 'cancelled' : 'failed');
      const failure = timedOut ? new BridgeError(504, 'Model request timed out.', 'upstream_timeout') : error instanceof BridgeError ? error : new BridgeError(502, 'Unable to reach the model endpoint.', 'upstream_error');
      sendJson(res, failure.status, { error: { message: failure.message, type: failure.code, code: failure.code } }, failure.headers);
    } finally {
      clearTimeout(timer);
      controllers.delete(controller);
      req.off('aborted', abort);
      res.off('close', abort);
    }
  });
  server.headersTimeout = 15000;
  server.requestTimeout = timeoutMs;
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  let closing;
  return {
    baseUrl: `http://127.0.0.1:${server.address().port}/v1`, token,
    close() {
      if (!closing) {
        for (const controller of controllers) controller.abort();
        reasoning.clear();
        closing = new Promise((resolve, reject) => {
          server.close((error) => error ? reject(error) : resolve());
          server.closeAllConnections();
        });
      }
      return closing;
    },
  };
}
