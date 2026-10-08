import { createServer } from 'node:http';
import { createHash, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { once } from 'node:events';
import { createToolPolicy } from './provider-capabilities.mjs';

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

function modelRequest(body, model, reasoning, toolsAllowed = true) {
  if (!record(body)) invalid('The request must be a JSON object.');
  if (!toolsAllowed) {
    body = { ...body };
    const adapterTools = tools => Array.isArray(tools) ? tools.flatMap(tool => tool?.type === 'namespace' ? [{ ...tool, tools: adapterTools(tool.tools) ?? [] }] : ['function', 'custom'].includes(tool?.type) ? [tool] : []) : undefined;
    body.tools = adapterTools(body.tools);
    delete body.tool_choice; delete body.parallel_tool_calls;
  }
  const selectedModel = body.model === undefined ? model : body.model;
  if (!validModel(selectedModel)) invalid('Model must be a nonempty identifier without control characters.');
  if (body.previous_response_id) invalid('previous_response_id is unsupported; send the complete input history.');
  if (body.stream !== undefined && typeof body.stream !== 'boolean') invalid('stream must be a boolean.');
  const { tools, custom, byFlat, byLogical } = convertTools(body.tools);
  const request = { model: selectedModel, stream: body.stream === true, ...(body.stream === true ? { stream_options: { include_usage: true } } : {}), messages: messages(body, reasoning, byLogical) };
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

function completedResponse(upstream, model, custom, toolNames, reasoning, toolsAllowed = true, toolPolicy) {
  const message = upstream?.choices?.[0]?.message;
  const malformed = () => { throw new BridgeError(502, 'The model returned an unsupported or malformed Chat Completions response.', 'upstream_error'); };
  if (!record(message) || message.role !== 'assistant') malformed();
  if (!toolsAllowed && (message.tool_calls?.length || message.function_call)) throw new BridgeError(502, 'The model returned a tool call while tool use is disabled.', 'tools_disabled');
  if (Array.isArray(message.tool_calls)) for (const call of message.tool_calls) toolPolicy?.assertItem({ type: 'function_call', name: call?.function?.name });
  if (upstream.choices[0].finish_reason === 'length') throw new BridgeError(502, 'The model output was truncated. Increase its output token limit and retry.', 'upstream_incomplete');
  if (upstream.choices[0].finish_reason === 'content_filter') throw new BridgeError(502, 'The model endpoint filtered the response.', 'upstream_incomplete');
  const output = [];
  if (message.content !== undefined && message.content !== null && typeof message.content !== 'string') malformed();
  if (message.content) output.push({ id: `msg_${randomUUID()}`, type: 'message', status: 'completed', role: 'assistant', content: [{ type: 'output_text', text: message.content, annotations: [] }] });
  if (message.tool_calls != null && !Array.isArray(message.tool_calls)) malformed();
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
  const measured = actualUsage(upstream.usage, 'chat-completions');
  const inputTokens = measured?.inputTokens;
  const outputTokens = measured?.outputTokens;
  return {
    id: `resp_${randomUUID()}`, object: 'response', created_at: Math.floor(Date.now() / 1000), status: 'completed',
    model, output, error: null, incomplete_details: null,
    usage: measured ? { input_tokens: inputTokens, input_tokens_details: { cached_tokens: count(upstream.usage?.prompt_tokens_details?.cached_tokens) },
      output_tokens: outputTokens, output_tokens_details: { reasoning_tokens: count(upstream.usage?.completion_tokens_details?.reasoning_tokens) },
      total_tokens: measured.totalTokens } : null,
  };
}

// Compatible providers may ignore stream and return JSON. Keep that fallback
// explicit; real event streams are translated incrementally below.
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

function sseWriter(res, model) {
  res.writeHead(200, { 'content-type': 'text/event-stream; charset=utf-8', 'cache-control': 'no-cache', 'x-accel-buffering': 'no' });
  let sequence = 0;
  const pending = { id: `resp_${randomUUID()}`, object: 'response', created_at: Math.floor(Date.now() / 1000), model, status: 'in_progress', output: [], error: null, incomplete_details: null, usage: null };
  const emit = (type, value) => {
    if (res.destroyed || res.writableEnded) throw new BridgeError(502, 'The model stream was interrupted.', 'upstream_error');
    if (res.writableLength > MAX_BODY_BYTES) throw new BridgeError(502, 'The model stream exceeded the output buffer limit.', 'upstream_error');
    res.write(`event: ${type}\ndata: ${JSON.stringify({ type, sequence_number: sequence++, ...value })}\n\n`);
  };
  emit('response.created', { response: pending }); emit('response.in_progress', { response: pending });
  return { pending, emit, fail(error) {
    if (!res.destroyed && !res.writableEnded) { emit('response.failed', { response: { ...pending, status: 'failed', error: { code: error.code, message: error.message } } }); res.end(); }
  } };
}

/** Translate Chat deltas before completion. Tool completion follows full validation. */
async function readChatStream(upstream, res, model, custom, toolNames, reasoning, responding, toolsAllowed = true, toolPolicy) {
  const writer = sseWriter(res, model);
  const message = { role: 'assistant', content: '', reasoning_content: '' };
  const calls = new Map(), items = [];
  let textItem, finishReason, usage, ended = false, bytes = 0;
  const malformed = () => { throw new BridgeError(502, 'The model returned an unsupported or malformed Chat Completions stream.', 'upstream_error'); };
  const ensureText = () => {
    if (textItem) return textItem;
    textItem = { id: `msg_${randomUUID()}`, type: 'message', role: 'assistant', status: 'in_progress', content: [] };
    const output_index = items.length; items.push({ kind: 'message', item: textItem, output_index });
    writer.emit('response.output_item.added', { output_index, item: textItem });
    writer.emit('response.content_part.added', { item_id: textItem.id, output_index, content_index: 0, part: { type: 'output_text', text: '', annotations: [] } });
    return textItem;
  };
  const publishCall = call => {
    const identity = toolNames.get(call.function.name);
    if (!identity || !call.id || custom.has(call.function.name)) return;
    if (toolPolicy && !toolPolicy.allows(call.function.name)) return;
    // A streamed name can still be a prefix of a different declared tool.
    // Hold ambiguous identity until completion rather than exposing the wrong tool.
    if (!call.item && [...toolNames.keys()].some(name => name !== call.function.name && name.startsWith(call.function.name))) return;
    if (call.publishedName && call.publishedName !== call.function.name) malformed();
    if (!call.item) {
      call.publishedName = call.function.name;
      call.item = { id: `fc_${randomUUID()}`, type: 'function_call', status: 'in_progress', call_id: call.id, name: identity.name, ...(identity.namespace ? { namespace: identity.namespace } : {}), arguments: '' };
      call.output_index = items.length; items.push({ kind: 'call', call, item: call.item, output_index: call.output_index });
      writer.emit('response.output_item.added', { output_index: call.output_index, item: call.item });
    }
    const delta = call.function.arguments.slice(call.emittedArguments);
    if (delta) { writer.emit('response.function_call_arguments.delta', { item_id: call.item.id, output_index: call.output_index, delta }); call.emittedArguments = call.function.arguments.length; }
  };
  const inspect = data => {
    if (data === '[DONE]') { ended = true; return; }
    if (ended) malformed();
    let event; try { event = JSON.parse(data); } catch { malformed(); }
    if (!record(event) || event.error || !Array.isArray(event.choices)) malformed();
    if (record(event.usage)) usage = event.usage;
    for (const choice of event.choices) {
      if (choice.index !== 0 || !record(choice.delta)) malformed();
      const delta = choice.delta;
      if (!toolsAllowed && (delta.tool_calls?.length || delta.function_call)) throw new BridgeError(502, 'The model returned a tool call while tool use is disabled.', 'tools_disabled');
      if (delta.role != null && delta.role !== 'assistant') malformed();
      for (const key of ['content', 'refusal', 'reasoning_content']) {
        if (delta[key] !== undefined && delta[key] !== null && typeof delta[key] !== 'string') malformed();
      }
      const text = delta.content || delta.refusal || '';
      if (text) {
        responding(); const item = ensureText(); message.content += text;
        writer.emit('response.output_text.delta', { item_id: item.id, output_index: items.find(entry => entry.item === item).output_index, content_index: 0, delta: text });
      }
      if (delta.reasoning_content) { responding(); message.reasoning_content += delta.reasoning_content; }
      if (delta.tool_calls != null) {
        if (!Array.isArray(delta.tool_calls)) malformed();
        for (const part of delta.tool_calls) {
          if (!record(part) || !Number.isSafeInteger(part.index) || part.index < 0 || part.index >= 1024 || (part.type !== undefined && part.type !== 'function') || (part.function !== undefined && !record(part.function))) malformed();
          let call = calls.get(part.index);
          if (!call) { call = { id: '', type: 'function', function: { name: '', arguments: '' }, emittedArguments: 0 }; calls.set(part.index, call); }
          if (part.id !== undefined) { if (typeof part.id !== 'string' || !part.id || (call.id && call.id !== part.id)) malformed(); call.id = part.id; }
          for (const key of ['name', 'arguments']) if (part.function?.[key] !== undefined) { if (typeof part.function[key] !== 'string') malformed(); call.function[key] += part.function[key]; }
          if (part.function?.arguments) responding();
          publishCall(call);
        }
      }
      if (choice.finish_reason !== undefined && choice.finish_reason !== null) {
        if (finishReason !== undefined || !['stop', 'tool_calls', 'length', 'content_filter'].includes(choice.finish_reason)) malformed();
        finishReason = choice.finish_reason;
      }
    }
  };
  const decoder = new TextDecoder(); let line = '', dataLines = [];
  const lineReady = raw => {
    const value = raw.endsWith('\r') ? raw.slice(0, -1) : raw;
    if (!value) { if (dataLines.length) inspect(dataLines.join('\n')); dataLines = []; }
    else if (value.startsWith('data:')) dataLines.push(value.slice(5).replace(/^ /, ''));
  };
  const consume = text => {
    line += text;
    for (;;) { const newline = line.indexOf('\n'); if (newline < 0) break; lineReady(line.slice(0, newline)); line = line.slice(newline + 1); }
  };
  try {
    for await (const chunk of upstream.body ?? []) {
      bytes += chunk.length; if (bytes > MAX_BODY_BYTES) throw new BridgeError(502, 'Model response exceeds the 16 MiB bridge limit.', 'upstream_error');
      consume(decoder.decode(chunk, { stream: true }));
      // DONE terminates generation even if a compatible server keeps its socket open.
      if (ended) break;
    }
    consume(decoder.decode()); if (line) lineReady(line); lineReady('');
    if (!finishReason) malformed();
    message.tool_calls = [...calls.entries()].sort(([a], [b]) => a - b).map(([_index, call]) => ({ id: call.id, type: call.type, function: call.function }));
    if (!message.tool_calls.length) delete message.tool_calls;
    const response = completedResponse({ choices: [{ message, finish_reason: finishReason }], usage }, model, custom, toolNames, reasoning, toolsAllowed, toolPolicy);
    // Validate the entire result before any executable completed tool event.
    const finalItems = [], finalEvents = [];
    const emitFinal = (type, value) => finalEvents.push([type, value]);
    for (const entry of items) {
      let final;
      if (entry.kind === 'message') {
        final = response.output.find(item => item.type === 'message'); final.id = entry.item.id;
        const part = final.content[0], position = { item_id: final.id, output_index: entry.output_index, content_index: 0 };
        emitFinal('response.output_text.done', { ...position, text: part.text }); emitFinal('response.content_part.done', { ...position, part });
      } else {
        final = response.output.find(item => item.call_id === entry.call.id); final.id = entry.item.id;
        emitFinal('response.function_call_arguments.done', { item_id: final.id, output_index: entry.output_index, arguments: final.arguments });
      }
      emitFinal('response.output_item.done', { output_index: entry.output_index, item: final }); finalItems.push(final);
    }
    for (const final of response.output.filter(item => !finalItems.includes(item))) {
      const output_index = finalItems.length;
      if (final.type === 'custom_tool_call') {
        emitFinal('response.output_item.added', { output_index, item: { ...final, input: '' } });
        emitFinal('response.custom_tool_call_input.delta', { item_id: final.id, output_index, delta: final.input });
        emitFinal('response.custom_tool_call_input.done', { item_id: final.id, output_index, input: final.input });
      } else if (final.type === 'function_call') {
        emitFinal('response.output_item.added', { output_index, item: { ...final, status: 'in_progress', arguments: '' } });
        emitFinal('response.function_call_arguments.delta', { item_id: final.id, output_index, delta: final.arguments });
        emitFinal('response.function_call_arguments.done', { item_id: final.id, output_index, arguments: final.arguments });
      } else {
        emitFinal('response.output_item.added', { output_index, item: { ...final, status: 'in_progress', content: [] } });
        const position = { item_id: final.id, output_index, content_index: 0 }, part = final.content[0];
        emitFinal('response.content_part.added', { ...position, part: { ...part, text: '' } });
        emitFinal('response.output_text.done', { ...position, text: part.text }); emitFinal('response.content_part.done', { ...position, part });
      }
      emitFinal('response.output_item.done', { output_index, item: final }); finalItems.push(final);
    }
    // The caller settles budget usage before exposing completed executable items.
    writer.flushFinal = () => { for (const [type, value] of finalEvents) writer.emit(type, value); };
    return { response: { ...response, id: writer.pending.id, created_at: writer.pending.created_at, output: finalItems }, writer, usage };
  } catch (error) { error.streamWriter = writer; throw error; }
}

function actualUsage(usage, style) {
  if (!record(usage)) return null;
  const inputTokens = usage[style === 'chat-completions' ? 'prompt_tokens' : 'input_tokens'];
  const outputTokens = usage[style === 'chat-completions' ? 'completion_tokens' : 'output_tokens'];
  if (![inputTokens, outputTokens].every(value => Number.isSafeInteger(value) && value >= 0)) return null;
  return { inputTokens, outputTokens, totalTokens: Number.isSafeInteger(usage.total_tokens) && usage.total_tokens >= 0 ? usage.total_tokens : inputTokens + outputTokens, estimated: false };
}

function sendJson(res, status, body, headers = {}) {
  if (res.destroyed || res.writableEnded || res.headersSent) return;
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
export async function startBridge({ baseUrl, model, apiKey, timeoutMs = 120000,streaming=true, toolsAllowed = true, toolAllowlist, onPolicyError = () => {}, onMetrics = () => {}, requestHooks = {}, beforeRequest = requestHooks.beforeRequest, onUsage = requestHooks.onUsage, afterRequest = requestHooks.afterRequest } = {}) {
  const url = endpoint(baseUrl);
  if (!validModel(model)) throw new Error('A nonempty model identifier without control characters is required.');
  if (apiKey !== undefined && (typeof apiKey !== 'string' || !apiKey.trim() || /[\r\n]/.test(apiKey))) throw new Error('If provided, the API key must be a nonempty string without line breaks.');
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 2147483647) throw new Error('timeoutMs must be a positive integer within the timer range.');
  createToolPolicy({ toolsAllowed, toolAllowlist });
  if (typeof onPolicyError !== 'function') throw new Error('The model policy callback must be a function.');
  const token = randomBytes(32).toString('hex');
  const expectedAuth = Buffer.from(`Bearer ${token}`);
  const reasoning = new Map();
  const controllers = new Set();
  let latestToolCatalog = [];
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
    let timedOut = false, admitted = false, settled = false, hookFailure = false, metricsStarted = false;
    let requestId, started, firstLatency, reportedUsage, selectedModel = model, streamWriter, streamed = false;
    const metric = (phase) => {
      if (requestId && metricsStarted) {
        const totalLatencyMs = performance.now() - started;
        const generationMs = firstLatency == null ? null : totalLatencyMs - firstLatency;
        try { onMetrics({ phase, id: requestId, latencyMs: firstLatency ?? totalLatencyMs, firstTokenLatencyMs: firstLatency ?? null,
          totalLatencyMs, outputTokens: reportedUsage?.outputTokens ?? null,
          generationTokensPerSecond: reportedUsage && generationMs > 0 ? reportedUsage.outputTokens * 1000 / generationMs : null,
          source: streamed ? 'streamed-chat-first-output' : 'buffered-chat-response' }); } catch { /* Metrics cannot interrupt the transport. */ }
      }
    };
    let timer;
    const setDeadline = duration => { clearTimeout(timer); timer = setTimeout(() => { timedOut = true; controller.abort(); }, duration); timer.unref(); };
    setDeadline(timeoutMs);
    const settle = async outcome => {
      if (!admitted || settled) return;
      settled = true;
      try { await afterRequest?.({ id: requestId, model: selectedModel, transport: 'chat-completions', outcome, durationMs: performance.now() - started }); }
      catch (error) { hookFailure = true; throw error; }
    };
    try {
      if (req.headers['content-encoding'] && req.headers['content-encoding'] !== 'identity') throw new BridgeError(415, 'Compressed request bodies are unsupported.');
      const body = await readRequest(req);
      const { request: preparedRequest, custom, toolNames } = modelRequest(body, model, reasoning, toolsAllowed);
      const toolPolicy = createToolPolicy({ toolsAllowed, toolAllowlist });
      const request = toolPolicy.filterRequest(preparedRequest, { format: 'chat-completions' });
      if(!streaming){request.stream=false;delete request.stream_options;}
      latestToolCatalog = toolPolicy.getToolCatalog().filter(name => !apiKey || !name.includes(apiKey));
      if (controller.signal.aborted) throw new Error('Aborted');
      requestId = randomUUID(); selectedModel = request.model; started = performance.now();
      let reservation;
      try { reservation = await beforeRequest?.({ id: requestId, model: request.model, transport: 'chat-completions', input: body.input, inputTokensEstimate: Math.ceil(Buffer.byteLength(JSON.stringify({ messages: request.messages, tools: request.tools }), 'utf8') / 3), maxOutputTokens: request.max_tokens, estimated: true }); }
      catch (error) { hookFailure = true; throw error; }
      admitted = true;
      if (reservation?.maxOutputTokens !== undefined) {
        if (!Number.isSafeInteger(reservation.maxOutputTokens) || reservation.maxOutputTokens < 1) { hookFailure = true; throw new Error('Invalid request budget cap.'); }
        request.max_tokens = Math.min(request.max_tokens ?? reservation.maxOutputTokens, reservation.maxOutputTokens);
      }
      if (reservation?.timeoutMs !== undefined && (!Number.isSafeInteger(reservation.timeoutMs) || reservation.timeoutMs < 1)) { hookFailure = true; throw new Error('Invalid request budget duration.'); }
      setDeadline(Math.min(timeoutMs, reservation?.timeoutMs ?? timeoutMs));
      if (controller.signal.aborted) throw new Error('Aborted');
      metricsStarted = true; started = performance.now(); metric('started');
      const upstream = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json', ...(apiKey === undefined ? {} : { authorization: `Bearer ${apiKey}` }) }, body: JSON.stringify(request), signal: controller.signal, redirect: 'error' });
      if (!upstream.ok) {
        await upstream.body?.cancel();
        const status = upstream.status >= 400 && upstream.status <= 599 ? upstream.status : 502;
        const retryAfter = upstream.headers.get('retry-after');
        throw new BridgeError(status, `Model endpoint returned HTTP ${upstream.status}.`, 'upstream_error', retryAfter && /^\d{1,8}$/.test(retryAfter) ? { 'retry-after': retryAfter } : {});
      }
      let response;
      if (body.stream === true && /text\/event-stream/i.test(upstream.headers.get('content-type') ?? '')) {
        streamed = true;
        const result = await readChatStream(upstream, res, request.model, custom, toolNames, reasoning, () => {
          if (firstLatency == null) { firstLatency = performance.now() - started; metric('responding'); }
        }, toolsAllowed, toolPolicy);
        response = result.response; streamWriter = result.writer; reportedUsage = actualUsage(result.usage, 'chat-completions');
      } else {
        const result = await readUpstream(upstream);
        response = completedResponse(result, request.model, custom, toolNames, reasoning, toolsAllowed, toolPolicy);
        reportedUsage = actualUsage(result.usage, 'chat-completions');
      }
      if (reportedUsage) {
        try { await onUsage?.({ id: requestId, model: request.model, transport: 'chat-completions', ...reportedUsage }); }
        catch (error) { hookFailure = true; throw error; }
      }
      await settle('succeeded');
      metric('succeeded');
      if (res.destroyed) return;
      if (streamWriter) { streamWriter.flushFinal(); streamWriter.emit('response.completed', { response }); res.end(); }
      else if (body.stream === true) sendSse(res, response);
      else sendJson(res, 200, response);
    } catch (error) {
      const outcome = controller.signal.aborted && !timedOut ? 'cancelled' : 'failed';
      try { await settle(outcome); } catch { hookFailure = true; }
      metric(outcome);
      const policyCode = String(error?.code).toUpperCase();
      if (['TOOLS_DISABLED', 'TOOL_NOT_ALLOWED'].includes(policyCode)) {
        try { Promise.resolve(onPolicyError({ code: policyCode, message: 'The model returned a tool call outside the configured tool permissions.' })).catch(() => {}); } catch { /* The provider response remains rejected even if notification fails. */ }
      }
      const failure = timedOut ? new BridgeError(504, 'Model request timed out.', 'upstream_timeout')
        : hookFailure ? new BridgeError(String(error?.code).toUpperCase() === 'BUDGET_EXCEEDED' ? 429 : 503, String(error?.code).toUpperCase() === 'BUDGET_EXCEEDED' ? 'The configured model budget is exhausted.' : 'The model budget could not be verified.', 'budget_error')
        : ['TOOLS_DISABLED', 'TOOL_NOT_ALLOWED'].includes(policyCode) ? new BridgeError(502, 'The model returned a tool call outside the configured tool permissions.', 'tool_policy_error')
        : error instanceof BridgeError ? error : new BridgeError(502, 'Unable to reach the model endpoint.', 'upstream_error');
      const writer = streamWriter ?? error?.streamWriter;
      if (writer) writer.fail(failure);
      else sendJson(res, failure.status, { error: { message: failure.message, type: failure.code, code: failure.code } }, failure.headers);
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
    getToolCatalog: () => [...latestToolCatalog],
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
