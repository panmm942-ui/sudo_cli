import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { setTimeout as delay } from 'node:timers/promises';

async function fixture(t, handler, options = {}) {
  const metrics = [];
  const server = createServer(handler).listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => { server.closeAllConnections(); server.close(); });
  const { startResponsesMonitor } = await import('../src/responses-monitor.mjs');
  const monitor = await startResponsesMonitor({ baseUrl: `http://127.0.0.1:${server.address().port}/v1`, apiKey: 'fixture-key', onMetrics: value => metrics.push(value), ...options });
  t.after(() => monitor.close());
  const post = (extra = {}) => fetch(`${monitor.baseUrl}/responses`, { method: 'POST', headers: { authorization: `Bearer ${monitor.token}`, 'content-type': 'application/json' }, body: '{"model":"fixture","stream":true}', ...extra });
  return { metrics, monitor, post };
}

test('Responses monitoring preserves bytes and measures semantic output rather than early headers', async t => {
  const initial = 'event: response.created\r\ndata: {"type":"response.created"}\r\n\r\n';
  const reply = 'event: response.output_text.delta\ndata: {"type":"response.output_text.delta","delta":"hello"}\n\nevent: response.completed\ndata: {"type":"response.completed","response":{"status":"completed"}}\n\n';
  const { metrics, post } = await fixture(t, async (req, res) => {
    assert.equal(req.url, '/v1/responses');
    assert.equal(req.headers.authorization, 'Bearer fixture-key');
    let body = ''; for await (const chunk of req) body += chunk;
    assert.equal(body, '{"model":"fixture","stream":true}');
    res.writeHead(200, { 'content-type': 'text/event-stream' }); res.write(initial);
    await delay(45); res.write(reply.slice(0, 40)); res.end(reply.slice(40));
  });
  const response = await post();
  assert.equal(await response.text(), initial + reply);
  assert.deepEqual(metrics.map(value => value.phase), ['started', 'responding', 'succeeded']);
  assert.ok(metrics[1].latencyMs >= 35);
  assert.equal(metrics[0].id, metrics[2].id);
  assert.doesNotMatch(JSON.stringify(metrics), /fixture-key|hello|model/);
});

test('truncated streams and malformed HTTP200 bodies count as failed model results', async t => {
  for (const [type, body] of [['text/event-stream', 'data: {"type":"response.output_text.delta","delta":"partial"}\n\n'], ['application/json', '{"status":"failed"}'], ['application/json', 'invalid-json']]) {
    const { metrics, post } = await fixture(t, (_req, res) => { res.writeHead(200, { 'content-type': type }); res.end(body); });
    const response = await post(); assert.equal(await response.text(), body);
    assert.equal(metrics.at(-1).phase, 'failed');
    assert.equal(metrics.filter(value => value.phase === 'failed').length, 1);
    assert.ok(!metrics.some(value => value.phase === 'succeeded'));
  }
});

test('long complete Responses events are recognized without corrupting output', async t => {
  const text = 'x'.repeat(100000);
  const event = 'data: ' + JSON.stringify({ type: 'response.completed', response: { status: 'completed', output: [{ text }] } }) + '\n\n';
  const { metrics, post } = await fixture(t, (_req, res) => { res.writeHead(200, { 'content-type': 'text/event-stream' }); res.end(event); });
  assert.equal(await (await post()).text(), event);
  assert.equal(metrics.at(-1).phase, 'succeeded');
});

test('HTTP model failures and timeouts produce one failure with sanitized output', async t => {
  for (const timeout of [false, true]) {
    const { metrics, post } = await fixture(t, (_req, res) => { if (!timeout) { res.writeHead(401); res.end('private-secret'); } }, { timeoutMs: 50 });
    const response = await post();
    assert.equal(response.status, timeout ? 504 : 401);
    assert.doesNotMatch(await response.text(), /private-secret|fixture-key/);
    assert.deepEqual(metrics.map(value => value.phase), ['started', 'failed']);
  }
});

test('unauthenticated or unsupported routes never call the upstream model', async t => {
  let calls = 0;
  const { monitor, metrics } = await fixture(t, () => { calls++; });
  const unauth = await fetch(`${monitor.baseUrl}/responses`, { method: 'POST', body: '{}' });
  assert.equal(unauth.status, 401);
  const wrong = await fetch(`${monitor.baseUrl}/other`);
  assert.equal(wrong.status, 404);
  assert.equal(calls, 0); assert.equal(metrics.length, 0);
});

test('client interruption cancels a request without counting a model failure', async t => {
  let reached; const ready = new Promise(resolve => { reached = resolve; });
  const { metrics, post, monitor } = await fixture(t, () => { reached(); });
  const controller = new AbortController(); const pending = post({ signal: controller.signal });
  await ready; controller.abort();
  await assert.rejects(pending, { name: 'AbortError' });
  for (let i = 0; i < 50 && metrics.length < 2; i++) await delay(10);
  assert.deepEqual(metrics.map(value => value.phase), ['started', 'cancelled']);
  await monitor.close(); await monitor.close();
});
