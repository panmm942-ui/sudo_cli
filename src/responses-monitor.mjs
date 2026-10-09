import { createServer } from 'node:http';
import { once } from 'node:events';
import { randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { validateConnection } from './runtime.mjs';
import { createToolPolicy } from './provider-capabilities.mjs';
import { applyReasoningPolicy } from './reasoning-policy.mjs';

const MAX_REQUEST = 16 * 1024 * 1024;
const MAX_EVENT_LINE = MAX_REQUEST;
function json(res, status, message, type = 'upstream_error') {
  if (res.destroyed || res.writableEnded || res.headersSent) return;
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(JSON.stringify({ error: { message, type } }));
}

const reportedUsage = usage => {
  if (!usage || ![usage.input_tokens, usage.output_tokens].every(value => Number.isSafeInteger(value) && value >= 0)) return null;
  return { inputTokens: usage.input_tokens, outputTokens: usage.output_tokens, totalTokens: Number.isSafeInteger(usage.total_tokens) && usage.total_tokens >= 0 ? usage.total_tokens : usage.input_tokens + usage.output_tokens, estimated: false };
};

/** Private pass-through for native Responses. Content is neither logged nor saved. */
export async function startResponsesMonitor({ baseUrl, apiKey, timeoutMs = 120000, toolsAllowed = true, toolAllowlist, parallelToolCalls, reasoningPolicy, onPolicyError = () => {}, onMetrics = () => {}, requestHooks = {}, beforeRequest = requestHooks.beforeRequest, onUsage = requestHooks.onUsage, afterRequest = requestHooks.afterRequest } = {}) {
  const connection = validateConnection({ model: 'responses-monitor', baseUrl, apiKey, transport: 'responses' });
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 2147483647) throw new Error('Invalid model timeout.');
  createToolPolicy({ toolsAllowed, toolAllowlist, parallelToolCalls });
  if (typeof onPolicyError !== 'function') throw new Error('The model policy callback must be a function.');
  if (reasoningPolicy !== undefined && typeof reasoningPolicy !== 'function') throw new Error('The reasoning policy must be a function.');
  const endpoint = connection.baseUrl.replace(/\/$/, '') + '/responses';
  const token = randomBytes(32).toString('hex');
  const expected = Buffer.from(`Bearer ${token}`);
  const controllers = new Set();
  let latestToolCatalog = [];
  const server = createServer(async (req, res) => {
    if (req.url !== '/v1/responses') return json(res, 404, 'Endpoint not found.');
    const auth = Buffer.from(req.headers.authorization || '');
    if (auth.length !== expected.length || !timingSafeEqual(auth, expected)) return json(res, 401, 'Local model connection requires authentication.');
    if (req.method !== 'POST') return json(res, 405, 'Use POST.');
    const controller = new AbortController(); controllers.add(controller);
    const abort = () => { if (!res.writableEnded) controller.abort(); };
    req.once('aborted', abort); res.once('close', abort);
    let timedOut = false, requestId, started, firstLatency, streamFailed = false, completed = false, admitted = false, settled = false, hookFailure = false, metricsStarted = false, usage, usageAccounted = false, model;
    const metric = phase => {
      if (requestId && metricsStarted) {
        const totalLatencyMs = performance.now() - started, generationMs = firstLatency == null ? null : totalLatencyMs - firstLatency;
        try { onMetrics({ phase, id: requestId, latencyMs: firstLatency ?? totalLatencyMs, firstTokenLatencyMs: firstLatency ?? null, totalLatencyMs,
          outputTokens: usage?.outputTokens ?? null, generationTokensPerSecond: usage && generationMs > 0 ? usage.outputTokens * 1000 / generationMs : null, source: 'native-first-output' }); } catch { /* Display failures cannot affect a model response. */ }
      }
    };
    let timer;
    const setDeadline = duration => { clearTimeout(timer); timer = setTimeout(() => { timedOut = true; controller.abort(); }, duration); timer.unref(); };
    setDeadline(timeoutMs);
    const settle = async outcome => {
      if (!admitted || settled) return; settled = true;
      try { await afterRequest?.({ id: requestId, model, transport: 'responses', outcome, durationMs: performance.now() - started }); }
      catch (error) { hookFailure = true; throw error; }
    };
    const accountUsage = async () => {
      if (!usage || usageAccounted) return; usageAccounted = true;
      try { await onUsage?.({ id: requestId, model, transport: 'responses', ...usage }); }
      catch (error) { hookFailure = true; throw error; }
    };
    try {
      if (req.headers['content-encoding'] && req.headers['content-encoding'] !== 'identity') return json(res, 415, 'Compressed request bodies are unsupported.');
      const chunks = []; let length = 0;
      for await (const chunk of req) {
        length += chunk.length;
        if (length > MAX_REQUEST) return json(res, 413, 'Request exceeds the 16 MiB model limit.');
        chunks.push(chunk);
      }
      if (controller.signal.aborted) throw new Error('Cancelled');
      let outgoing = Buffer.concat(chunks), request;
      try { request = JSON.parse(outgoing.toString('utf8')); } catch { return json(res, 400, 'Model requests must contain JSON.'); }
      if (!request || typeof request !== 'object' || Array.isArray(request)) return json(res, 400, 'Model requests must contain a JSON object.');
      const toolPolicy = createToolPolicy({ toolsAllowed, toolAllowlist, parallelToolCalls });
      request = toolPolicy.filterRequest(request);
      if(reasoningPolicy)request=applyReasoningPolicy(request,reasoningPolicy());
      latestToolCatalog = toolPolicy.getToolCatalog().filter(name => !connection.apiKey || !name.includes(connection.apiKey));
      if (!toolPolicy.unrestricted || parallelToolCalls === false || reasoningPolicy) outgoing = Buffer.from(JSON.stringify(request));
      model = request.model;
      requestId = randomUUID(); started = performance.now();
      let reservation;
      try { reservation = await beforeRequest?.({ id: requestId, model, transport: 'responses', input: request.input, inputTokensEstimate: Math.ceil(outgoing.length / 3), maxOutputTokens: request.max_output_tokens, estimated: true }); }
      catch (error) { hookFailure = true; throw error; }
      admitted = true;
      if (reservation?.maxOutputTokens !== undefined) {
        if (!Number.isSafeInteger(reservation.maxOutputTokens) || reservation.maxOutputTokens < 1) { hookFailure = true; throw new Error('Invalid budget cap.'); }
        const requested = Number.isSafeInteger(request.max_output_tokens) && request.max_output_tokens > 0 ? request.max_output_tokens : reservation.maxOutputTokens;
        request.max_output_tokens = Math.min(requested, reservation.maxOutputTokens); outgoing = Buffer.from(JSON.stringify(request));
      }
      if (reservation?.timeoutMs !== undefined && (!Number.isSafeInteger(reservation.timeoutMs) || reservation.timeoutMs < 1)) { hookFailure = true; throw new Error('Invalid budget duration.'); }
      setDeadline(Math.min(timeoutMs, reservation?.timeoutMs ?? timeoutMs));
      if (controller.signal.aborted) throw new Error('Cancelled');
      metricsStarted = true; started = performance.now(); metric('started');
      const upstream = await fetch(endpoint, { method: 'POST', headers: { 'content-type': 'application/json', ...(connection.apiKey ? { authorization: `Bearer ${connection.apiKey}` } : {}) }, body: outgoing, signal: controller.signal, redirect: 'error' });
      if (!upstream.ok) {
        await upstream.body?.cancel(); await settle('failed'); metric('failed');
        return json(res, upstream.status >= 400 && upstream.status <= 599 ? upstream.status : 502, `Model endpoint returned HTTP ${upstream.status}.`);
      }
      const contentType = upstream.headers.get('content-type') || 'application/json';
      const sendHeaders = () => res.writeHead(upstream.status, { 'content-type': contentType, 'cache-control': 'no-cache' });
      if (toolPolicy.unrestricted) sendHeaders();
      const sse = /text\/event-stream/i.test(contentType);
      const decoder = new TextDecoder(); let line = '', oversized = false;
      const jsonChunks = []; let jsonBytes = 0;
      const observe = event => {
        if (event.type === 'response.failed' || event.type === 'error' || event.type === 'response.incomplete') streamFailed = true;
        if (event.type === 'response.completed') { completed = event.response?.status === 'completed'; if (!completed) streamFailed = true; }
        if (event.response?.usage) usage = reportedUsage(event.response.usage);
        const output = /^response\.(output_text|reasoning(?:_summary)?_text|function_call_arguments|custom_tool_call_input)\.delta$/.test(event.type);
        if (firstLatency == null && output && typeof event.delta === 'string' && event.delta.length) { firstLatency = performance.now() - started; metric('responding'); }
      };
      const inspect = text => {
        for (const character of text) {
          if (character === '\n') {
            if (!oversized && line.startsWith('data:')) {
              try {
                observe(JSON.parse(line.slice(5).trim()));
              } catch { /* Provider events pass through even if this optional monitor cannot parse them. */ }
            }
            line = ''; oversized = false;
          } else if (!oversized) {
            if (line.length >= MAX_EVENT_LINE) { line = ''; oversized = true; }
            else line += character;
          }
        }
      };
      const write = bytes => new Promise((resolve, reject) => { if (!res.headersSent) sendHeaders(); res.write(bytes, error => error ? reject(error) : resolve()); });
      let gated = Buffer.alloc(0);
      const inspectFrame = frame => {
        const lines = frame.toString('utf8').split(/\r\n|\r|\n/);
        const eventName = lines.find(value => value.startsWith('event:'))?.slice(6).trim();
        const data = lines.filter(value => value.startsWith('data:')).map(value => value.slice(5).replace(/^ /, '')).join('\n');
        let event = {};
        if (data && data !== '[DONE]') {
          try { event = JSON.parse(data); } catch { const error = new Error('The model returned an invalid event while tool permissions were restricted.'); error.code = 'TOOL_NOT_ALLOWED'; throw error; }
          if (!event || typeof event !== 'object' || Array.isArray(event)) { const error = new Error('Invalid model event.'); error.code = 'TOOL_NOT_ALLOWED'; throw error; }
        }
        toolPolicy.assertEvent(event, eventName);
        if (eventName && eventName !== event.type) toolPolicy.assertEvent({ ...event, type: eventName });
        if (event.type) observe(event);
      };
      const forwardFrames = async chunk => {
        gated = Buffer.concat([gated, Buffer.from(chunk)]);
        for (;;) {
          const boundaries = [['\n\n', 2], ['\r\n\r\n', 4], ['\r\r', 2]].map(([marker, size]) => ({ index: gated.indexOf(marker), size })).filter(value => value.index >= 0).sort((a, b) => a.index - b.index);
          if (!boundaries.length) { if (gated.length > MAX_REQUEST) throw new Error('Model event exceeds its policy inspection limit.'); break; }
          const boundary = boundaries[0], end = boundary.index + boundary.size;
          if (end > MAX_REQUEST) throw new Error('Model event exceeds its policy inspection limit.');
          const frame = gated.subarray(0, end); gated = gated.subarray(end);
          inspectFrame(frame); await accountUsage(); await write(frame);
        }
      };
      for await (const chunk of upstream.body ?? []) {
        if (!toolPolicy.unrestricted && sse) { await forwardFrames(chunk); continue; }
        if (sse) inspect(decoder.decode(chunk, { stream: true }));
        else {
          jsonBytes += chunk.length;
          if (jsonBytes <= MAX_REQUEST) jsonChunks.push(Buffer.from(chunk));
          else jsonChunks.length = 0;
          if (!toolPolicy.unrestricted) { if (jsonBytes > MAX_REQUEST) throw new Error('Model response exceeds its policy inspection limit.'); continue; }
        }
        await accountUsage();
        await write(Buffer.from(chunk));
      }
      if (sse && !toolPolicy.unrestricted) { if (gated.length) { inspectFrame(gated); await accountUsage(); await write(gated); } }
      else if (sse) inspect(decoder.decode() + '\n');
      else if (jsonBytes <= MAX_REQUEST) {
        const body = Buffer.concat(jsonChunks);
        let response;
        try { response = JSON.parse(body.toString('utf8')); }
        catch { if (!toolPolicy.unrestricted) throw new Error('Invalid model response.'); }
        if (response) { toolPolicy.assertResponse(response); completed = response.object === 'response' && response.status === 'completed' && Array.isArray(response.output); usage = reportedUsage(response.usage); }
        if (!toolPolicy.unrestricted) { await accountUsage(); await write(body); }
      }
      await accountUsage();
      if (res.destroyed || controller.signal.aborted) { await settle(timedOut ? 'failed' : 'cancelled'); metric(timedOut ? 'failed' : 'cancelled'); return; }
      const outcome = streamFailed || !completed ? 'failed' : 'succeeded';
      await settle(outcome); metric(outcome); res.end();
    } catch (error) {
      const outcome = controller.signal.aborted && !timedOut ? 'cancelled' : 'failed';
      try { await settle(outcome); } catch { hookFailure = true; }
      metric(outcome);
      const exhausted = String(error?.code).toUpperCase() === 'BUDGET_EXCEEDED';
      const toolViolation = ['TOOLS_DISABLED', 'TOOL_NOT_ALLOWED'].includes(error?.code);
      if (toolViolation) {
        try { Promise.resolve(onPolicyError({ code: error.code, message: 'The model returned a tool call outside the configured tool permissions.' })).catch(() => {}); } catch { /* The provider response remains rejected even if notification fails. */ }
      }
      const invalidReasoning=['INVALID_REASONING_REQUEST','INVALID_REASONING_POLICY'].includes(error?.code);
      if (!res.headersSent) json(res, timedOut ? 504 : invalidReasoning ? 400 : hookFailure ? exhausted ? 429 : 503 : 502, timedOut ? 'Model request timed out.' : invalidReasoning ? error.message : hookFailure ? exhausted ? 'The configured model budget is exhausted.' : 'The model budget could not be verified.' : toolViolation ? 'The model returned a tool call outside the configured tool permissions.' : 'Unable to reach the model endpoint.', invalidReasoning ? 'invalid_request_error' : hookFailure ? 'budget_error' : toolViolation ? 'tool_policy_error' : 'upstream_error');
      else res.destroy();
    } finally {
      clearTimeout(timer); controllers.delete(controller); req.off('aborted', abort); res.off('close', abort);
    }
  });
  server.headersTimeout = 15000; server.requestTimeout = timeoutMs;
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  let closing;
  return { baseUrl: `http://127.0.0.1:${server.address().port}/v1`, token, getToolCatalog: () => [...latestToolCatalog], close() {
    if (!closing) {
      for (const controller of controllers) controller.abort();
      closing = new Promise((resolve, reject) => { server.close(error => error ? reject(error) : resolve()); server.closeAllConnections(); });
    }
    return closing;
  } };
}
