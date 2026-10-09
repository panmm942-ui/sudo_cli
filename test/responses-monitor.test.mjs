import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { setTimeout as delay } from 'node:timers/promises';
import { startResponsesMonitor } from '../src/responses-monitor.mjs';

test('native parallel tool compatibility succeeds against a provider rejecting the parameter and preserves schemas and history', async t => {
  const tools = [{ type: 'function', name: 'read', description: 'Read a file', strict: true, parameters: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'], additionalProperties: false } }, { type: 'custom', name: 'patch', format: { type: 'grammar', syntax: 'lark', definition: 'start: "patch"' } }, { type: 'web_search' }, { type: 'namespace', name: 'files', tools: [{ type: 'function', name: 'stat', parameters: { type: 'object', properties: {} } }] }];
  const input = [{ role: 'user', content: 'Read file.txt' }, { type: 'function_call', name: 'read', call_id: 'previous', arguments: '{"path":"file.txt"}' }, { type: 'function_call_output', call_id: 'previous', output: 'contents' }];
  const output = [{ type: 'function_call', name: 'read', call_id: 'next', arguments: '{"path":"next.txt"}' }, { type: 'custom_tool_call', name: 'patch', call_id: 'patch-1', input: 'patch' }];
  const source = JSON.stringify({ object: 'response', status: 'completed', output });
  for (const parallelToolCalls of [undefined, false]) {
    let received;
    const { post, metrics } = await fixture(t, async (req, res) => {
      let raw = ''; for await (const chunk of req) raw += chunk; received = JSON.parse(raw);
      if (Object.hasOwn(received, 'parallel_tool_calls')) {
        res.writeHead(400, { 'content-type': 'application/json' }); res.end('{"error":{"code":"unsupported_parameter","param":"parallel_tool_calls"}}'); return;
      }
      res.writeHead(200, { 'content-type': 'application/json' }); res.end(source);
    }, { parallelToolCalls });
    for (const value of [true, false]) {
      const response = await post({ body: JSON.stringify({ model: 'fixture', stream: false, input, tools, tool_choice: 'required', parallel_tool_calls: value }) });
      assert.equal(response.status, parallelToolCalls === false ? 200 : 400);
      const body = await response.text();
      if (parallelToolCalls !== false) continue;
      assert.equal(body, source);
      assert.deepEqual(received, { model: 'fixture', stream: false, input, tools, tool_choice: 'required' });
      assert.equal(metrics.at(-1).phase, 'succeeded');
    }
  }
});

test('native parallel tool compatibility preserves supported explicit values and original bytes', async t => {
  for (const parallelToolCalls of [undefined, true]) {
    let received;
    const { post } = await fixture(t, async (req, res) => {
      received = ''; for await (const chunk of req) received += chunk;
      res.end('{"object":"response","status":"completed","output":[]}');
    }, { parallelToolCalls });
    for (const value of [undefined, true, false]) {
      const source = '{ "model": "fixture", "tools": [{"type":"function","name":"read"}]' + (value === undefined ? '' : ', "parallel_tool_calls": ' + value) + ' }';
      const response = await post({ body: source });
      assert.equal(response.status, 200); await response.text();
      assert.equal(received, source);
    }
  }
});

test('native parallel tool compatibility leaves unrestricted event forwarding permissive', async t => {
  const source = 'data: provider-extension\n\ndata: {"type":"response.function_call_arguments.delta","delta":"{}"}\n\ndata: {"type":"response.completed","response":{"status":"completed","output":[{"type":"function_call","name":"provider-extension"}]}}\n\n';
  const { post, metrics } = await fixture(t, async (req, res) => {
    let raw = ''; for await (const chunk of req) raw += chunk;
    if (Object.hasOwn(JSON.parse(raw), 'parallel_tool_calls')) { res.writeHead(400); res.end(); return; }
    res.writeHead(200, { 'content-type': 'text/event-stream' }); res.end(source);
  }, { parallelToolCalls: false });
  const response = await post({ body: '{"model":"fixture","stream":true,"parallel_tool_calls":true}' });
  assert.equal(response.status, 200);
  assert.equal(await response.text(), source);
  assert.equal(metrics.at(-1).phase, 'succeeded');
});

test('native parallel tool compatibility validates configuration before starting', async () => {
  for (const parallelToolCalls of [null, 'false', 0]) {
    await assert.rejects(async () => {
      const monitor = await startResponsesMonitor({ baseUrl: 'http://127.0.0.1:1/v1', parallelToolCalls });
      await monitor.close();
    }, /parallelToolCalls must be a boolean/);
  }
});

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

test('native monitor applies budget caps and accounts reported usage without changing response bytes', async t => {
  const before = [], usage = [], after = [];
  const source = 'data: {"type":"response.output_text.delta","delta":"Hi"}\n\ndata: {"type":"response.completed","response":{"status":"completed","usage":{"input_tokens":5,"output_tokens":2,"total_tokens":7}}}\n\n';
  const { metrics, post } = await fixture(t, async (req, res) => {
    let raw = ''; for await (const chunk of req) raw += chunk;
    assert.equal(JSON.parse(raw).max_output_tokens, 6);
    res.writeHead(200, { 'content-type': 'text/event-stream' }); res.end(source);
  }, { requestHooks: { beforeRequest: async event => { before.push(event); return { maxOutputTokens: 6 }; }, onUsage: async event => usage.push(event), afterRequest: async event => after.push(event) } });
  assert.equal(await (await post()).text(), source);
  assert.equal(before[0].estimated, true);
  assert.equal(usage[0].outputTokens, 2);
  assert.equal(usage[0].estimated, false);
  assert.equal(after[0].outcome, 'succeeded');
  assert.equal(after[0].id, before[0].id);
  assert.ok(metrics.at(-1).totalLatencyMs >= 0);
});

test('native beforeRequest exposes tool history transiently without altering the provider request',async t=>{
  const input=[{role:'user',content:'Read'},{type:'function_call',call_id:'native-guard',name:'read',arguments:'{}'},{type:'function_call_output',call_id:'native-guard',output:'unchanged'}];let captured,received;
  const {post}=await fixture(t,async(req,res)=>{let raw='';for await(const chunk of req)raw+=chunk;received=JSON.parse(raw);res.writeHead(200,{'content-type':'application/json'});res.end('{"status":"completed"}');},{requestHooks:{beforeRequest:request=>{captured=request;}}});
  await(await post({body:JSON.stringify({model:'fixture',stream:false,input})})).text();assert.deepEqual(captured.input,input);assert.deepEqual(received.input,input);
});

test('native budget failure prevents model work and duration caps abort outbound requests', async t => {
  let calls = 0;
  const blocked = await fixture(t, () => { calls++; }, { timeoutMs: 80, requestHooks: { beforeRequest: () => { const error = new Error('private-secret'); error.code = 'BUDGET_EXCEEDED'; throw error; } } });
  const response = await blocked.post(); assert.equal(response.status, 429);
  assert.doesNotMatch(await response.text(), /private-secret/); assert.equal(calls, 0);
  const after = [];
  const bounded = await fixture(t, () => { calls++; }, { timeoutMs: 80, requestHooks: { beforeRequest: () => ({ timeoutMs: 40 }), afterRequest: event => after.push(event) } });
  const timed = await bounded.post(); assert.equal(timed.status, 504); await timed.text();
  assert.equal(after[0].outcome, 'failed');
});

async function capture(response) {
  let source = ''; const reader = response.body.getReader(), decoder = new TextDecoder();
  try { for (;;) { const part = await reader.read(); if (part.done) break; source += decoder.decode(part.value, { stream: true }); } }
  catch { /* A policy-rejected stream can end its already-started native response. */ }
  return source + decoder.decode();
}

test('tools-off native monitor strips tool definitions and blocks split executable SSE events', async t => {
  for (const type of ['function_call', 'custom_tool_call', 'web_search_call', 'mcp_call']) {
    let request;
    const initial = 'event: response.created\r\ndata: {"type":"response.created"}\r\n\r\n';
    const rogue = 'event: response.output_item.done\r\ndata: ' + JSON.stringify({ type: 'response.output_item.done', output_index: 0, item: { id: 'rogue', type, call_id: 'x', name: 'run', arguments: '{}' } }) + '\r\n\r\n';
    const { post, metrics } = await fixture(t, async (req, res) => {
      let source = ''; for await (const chunk of req) source += chunk; request = JSON.parse(source);
      res.writeHead(200, { 'content-type': 'text/event-stream' }); res.write(initial);
      // Split the JSON/event boundary so inspection must precede forwarding any event bytes.
      res.write(rogue.slice(0, 73)); await delay(10); res.end(rogue.slice(73));
    }, { toolsAllowed: false });
    const source = await capture(await post({ body: JSON.stringify({ model: 'fixture', stream: true, tools: [{ type: 'function', name: 'run' }], tool_choice: 'required', parallel_tool_calls: true }) }));
    assert.ok(!source.includes('response.output_item.done'), type);
    assert.ok(!Object.hasOwn(request, 'tools'));
    assert.ok(!Object.hasOwn(request, 'tool_choice'));
    assert.ok(!Object.hasOwn(request, 'parallel_tool_calls'));
    assert.equal(metrics.at(-1).phase, 'failed');
  }
});

test('tools-off native monitor blocks tool items hidden in JSON or completed Responses envelopes', async t => {
  for (const sse of [false, true]) {
    const response = { object: 'response', status: 'completed', output: [{ type: 'mcp_call', name: 'run', arguments: '{}' }] };
    const source = sse ? 'data: ' + JSON.stringify({ type: 'response.completed', response }) + '\n\n' : JSON.stringify(response);
    const { post, metrics } = await fixture(t, (_req, res) => { res.writeHead(200, { 'content-type': sse ? 'text/event-stream' : 'application/json' }); res.end(source); }, { toolsAllowed: false });
    const result = await capture(await post());
    assert.ok(!result.includes('mcp_call'));
    assert.ok(!result.includes('"status":"completed"'));
    assert.equal(metrics.at(-1).phase, 'failed');
  }
});

test('tools-off native monitor preserves safe UTF-8 text events with multiline data', async t => {
  const source = 'event: response.output_text.delta\r\ndata: {"type":"response.output_text.delta",\r\ndata: "delta":"Hello α🙂"}\r\n\r\ndata: {"type":"response.completed","response":{"status":"completed","output":[]}}\n\n';
  const { post, metrics } = await fixture(t, (_req, res) => {
    const bytes = Buffer.from(source); const middle = bytes.indexOf(Buffer.from('🙂')) + 1;
    res.writeHead(200, { 'content-type': 'text/event-stream' }); res.write(bytes.subarray(0, middle)); res.end(bytes.subarray(middle));
  }, { toolsAllowed: false });
  assert.equal(await (await post()).text(), source);
  assert.equal(metrics.at(-1).phase, 'succeeded');
});

test('native allowlist filters exact function names and hosted types and exposes a content-free catalog', async t => {
  let request;
  const { post, monitor } = await fixture(t, async (req, res) => {
    let source = ''; for await (const chunk of req) source += chunk; request = JSON.parse(source);
    res.end('{"object":"response","status":"completed","output":[]}');
  }, { toolAllowlist: ['allowed', 'web_search'] });
  await (await post({ body: JSON.stringify({ model: 'fixture', tools: [{ type: 'function', name: 'allowed', description: 'private description' }, { type: 'function', name: 'excluded' }, { type: 'web_search' }, { type: 'mcp', server_label: 'private-server-label' }], tool_choice: { type: 'function', name: 'excluded' } }) })).text();
  assert.deepEqual(request.tools.map(tool => tool.name ?? tool.type), ['allowed', 'web_search']);
  assert.ok(!Object.hasOwn(request, 'tool_choice'));
  assert.deepEqual(monitor.getToolCatalog(), ['allowed', 'excluded', 'mcp', 'web_search']);
  assert.doesNotMatch(JSON.stringify(monitor.getToolCatalog()), /private/);
});

test('native allowlist preserves allowed tools and blocks excluded executable SSE items', async t => {
  for (const name of ['allowed', 'excluded']) {
    const item = { id: 'tool-policy', type: 'function_call', name, call_id: 'c', arguments: '{}' };
    const source = 'data: ' + JSON.stringify({ type: 'response.output_item.added', output_index: 0, item: { ...item, arguments: '' } }) + '\n\ndata: ' + JSON.stringify({ type: 'response.function_call_arguments.delta', item_id: item.id, output_index: 0, delta: '{}' }) + '\n\ndata: ' + JSON.stringify({ type: 'response.output_item.done', output_index: 0, item }) + '\n\ndata: ' + JSON.stringify({ type: 'response.completed', response: { status: 'completed', output: [item] } }) + '\n\n';
    const { post, metrics } = await fixture(t, (_req, res) => { res.writeHead(200, { 'content-type': 'text/event-stream' }); res.end(source); }, { toolAllowlist: ['allowed'] });
    const received = await capture(await post({ body: JSON.stringify({ model: 'fixture', stream: true, tools: [{ type: 'function', name: 'allowed' }, { type: 'function', name: 'excluded' }] }) }));
    if (name === 'allowed') { assert.equal(received, source); assert.equal(metrics.at(-1).phase, 'succeeded'); }
    else { assert.ok(!received.includes('response.output_item.done')); assert.equal(metrics.at(-1).phase, 'failed'); }
  }
});

test('native namespace allowlists prevent same-leaf provider calls from crossing namespaces', async t => {
  for (const namespace of ['first', 'second', undefined]) {
    let outgoing;
    const item = { id: 'namespace-policy', type: 'function_call', namespace, name: 'run', call_id: 'c', arguments: '{}' };
    const source = 'data: ' + JSON.stringify({ type: 'response.output_item.done', output_index: 0, item }) + '\n\ndata: ' + JSON.stringify({ type: 'response.completed', response: { status: 'completed', output: [item] } }) + '\n\n';
    const { post, monitor, metrics } = await fixture(t, async (req, res) => {
      let raw = ''; for await (const chunk of req) raw += chunk; outgoing = JSON.parse(raw);
      res.writeHead(200, { 'content-type': 'text/event-stream' }); res.end(source);
    }, { toolAllowlist: ['first.run'] });
    const received = await capture(await post({ body: JSON.stringify({ model: 'fixture', stream: true, tools: ['first', 'second'].map(name => ({ type: 'namespace', name, tools: [{ type: 'function', name: 'run' }] })) }) }));
    assert.deepEqual(outgoing.tools?.map(tool => tool.name), ['first']);
    assert.deepEqual(monitor.getToolCatalog(), ['first.run', 'second.run']);
    if (namespace === 'first') { assert.equal(received, source); assert.equal(metrics.at(-1).phase, 'succeeded'); }
    else { assert.ok(!received.includes('response.output_item.done')); assert.equal(metrics.at(-1).phase, 'failed'); }
  }
});

test('native monitor signals sanitized tool policy errors before retry', async t => {
  const errors = [];
  const { post } = await fixture(t, (_req, res) => res.end(JSON.stringify({ object: 'response', status: 'completed', output: [{ type: 'function_call', name: 'fixture-key', arguments: '{}' }] })), { toolsAllowed: false, onPolicyError: error => errors.push(error) });
  const response = await post(); await response.text();
  assert.equal(response.status, 502);
  assert.equal(errors.length, 1);
  assert.equal(errors[0].code, 'TOOLS_DISABLED');
  assert.doesNotMatch(JSON.stringify(errors), /fixture-key/);
});
