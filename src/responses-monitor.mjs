import { createServer } from 'node:http';
import { once } from 'node:events';
import { randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { validateConnection } from './runtime.mjs';

const MAX_REQUEST = 16 * 1024 * 1024;
const MAX_EVENT_LINE = MAX_REQUEST;
function json(res, status, message) {
  if (res.destroyed || res.writableEnded) return;
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(JSON.stringify({ error: { message, type: 'upstream_error' } }));
}

/** Private pass-through for native Responses. Content is neither logged nor saved. */
export async function startResponsesMonitor({ baseUrl, apiKey, timeoutMs = 120000, onMetrics = () => {} } = {}) {
  const connection = validateConnection({ model: 'responses-monitor', baseUrl, apiKey, transport: 'responses' });
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 2147483647) throw new Error('Invalid model timeout.');
  const endpoint = connection.baseUrl.replace(/\/$/, '') + '/responses';
  const token = randomBytes(32).toString('hex');
  const expected = Buffer.from(`Bearer ${token}`);
  const controllers = new Set();
  const server = createServer(async (req, res) => {
    if (req.url !== '/v1/responses') return json(res, 404, 'Endpoint not found.');
    const auth = Buffer.from(req.headers.authorization || '');
    if (auth.length !== expected.length || !timingSafeEqual(auth, expected)) return json(res, 401, 'Local model connection requires authentication.');
    if (req.method !== 'POST') return json(res, 405, 'Use POST.');
    const controller = new AbortController(); controllers.add(controller);
    const abort = () => { if (!res.writableEnded) controller.abort(); };
    req.once('aborted', abort); res.once('close', abort);
    let timedOut = false, requestId, started, firstLatency, streamFailed = false, completed = false;
    const metric = phase => { if (requestId) { try { onMetrics({ phase, id: requestId, latencyMs: firstLatency ?? performance.now() - started, source: 'native-first-output' }); } catch { /* Display failures cannot affect a model response. */ } } };
    const timer = setTimeout(() => { timedOut = true; controller.abort(); }, timeoutMs); timer.unref();
    try {
      if (req.headers['content-encoding'] && req.headers['content-encoding'] !== 'identity') return json(res, 415, 'Compressed request bodies are unsupported.');
      const chunks = []; let length = 0;
      for await (const chunk of req) {
        length += chunk.length;
        if (length > MAX_REQUEST) return json(res, 413, 'Request exceeds the 16 MiB model limit.');
        chunks.push(chunk);
      }
      if (controller.signal.aborted) throw new Error('Cancelled');
      requestId = randomUUID(); started = performance.now(); metric('started');
      const upstream = await fetch(endpoint, { method: 'POST', headers: { 'content-type': 'application/json', ...(connection.apiKey ? { authorization: `Bearer ${connection.apiKey}` } : {}) }, body: Buffer.concat(chunks), signal: controller.signal, redirect: 'error' });
      if (!upstream.ok) {
        await upstream.body?.cancel(); metric('failed');
        return json(res, upstream.status >= 400 && upstream.status <= 599 ? upstream.status : 502, `Model endpoint returned HTTP ${upstream.status}.`);
      }
      const contentType = upstream.headers.get('content-type') || 'application/json';
      res.writeHead(upstream.status, { 'content-type': contentType, 'cache-control': 'no-cache' });
      const sse = /text\/event-stream/i.test(contentType);
      const decoder = new TextDecoder(); let line = '', oversized = false;
      const jsonChunks = []; let jsonBytes = 0;
      const inspect = text => {
        for (const character of text) {
          if (character === '\n') {
            if (!oversized && line.startsWith('data:')) {
              try {
                const event = JSON.parse(line.slice(5).trim());
                if (event.type === 'response.failed' || event.type === 'error' || event.type === 'response.incomplete') streamFailed = true;
                if (event.type === 'response.completed') {
                  completed = event.response?.status === 'completed';
                  if (!completed) streamFailed = true;
                }
                const output = /^response\.(output_text|reasoning(?:_summary)?_text|function_call_arguments|custom_tool_call_input)\.delta$/.test(event.type);
                if (firstLatency == null && output && typeof event.delta === 'string' && event.delta.length) {
                  firstLatency = performance.now() - started; metric('responding');
                }
              } catch { /* Provider events pass through even if this optional monitor cannot parse them. */ }
            }
            line = ''; oversized = false;
          } else if (!oversized) {
            if (line.length >= MAX_EVENT_LINE) { line = ''; oversized = true; }
            else line += character;
          }
        }
      };
      for await (const chunk of upstream.body ?? []) {
        if (sse) inspect(decoder.decode(chunk, { stream: true }));
        else {
          jsonBytes += chunk.length;
          if (jsonBytes <= MAX_REQUEST) jsonChunks.push(Buffer.from(chunk));
          else jsonChunks.length = 0;
        }
        await new Promise((resolve, reject) => res.write(Buffer.from(chunk), error => error ? reject(error) : resolve()));
      }
      if (sse) inspect(decoder.decode() + '\n');
      else if (jsonBytes <= MAX_REQUEST) {
        try { const response = JSON.parse(Buffer.concat(jsonChunks).toString('utf8')); completed = response.object === 'response' && response.status === 'completed' && Array.isArray(response.output); }
        catch { /* Invalid native Responses data is not a healthy result. */ }
      }
      if (res.destroyed || controller.signal.aborted) { metric('cancelled'); return; }
      metric(streamFailed || !completed ? 'failed' : 'succeeded'); res.end();
    } catch {
      metric(controller.signal.aborted && !timedOut ? 'cancelled' : 'failed');
      if (!res.headersSent) json(res, timedOut ? 504 : 502, timedOut ? 'Model request timed out.' : 'Unable to reach the model endpoint.');
      else res.destroy();
    } finally {
      clearTimeout(timer); controllers.delete(controller); req.off('aborted', abort); res.off('close', abort);
    }
  });
  server.headersTimeout = 15000; server.requestTimeout = timeoutMs;
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  let closing;
  return { baseUrl: `http://127.0.0.1:${server.address().port}/v1`, token, close() {
    if (!closing) {
      for (const controller of controllers) controller.abort();
      closing = new Promise((resolve, reject) => { server.close(error => error ? reject(error) : resolve()); server.closeAllConnections(); });
    }
    return closing;
  } };
}
