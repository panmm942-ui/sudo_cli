import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { setTimeout as delay } from 'node:timers/promises';
import { startBridge } from '../src/bridge.mjs';

const SECRET = 'sk-fake-boundary-secret';
const messageResult = (message = { role: 'assistant', content: 'Hello from the model.' }) => ({
  id: 'chatcmpl-fixture', object: 'chat.completion', model: 'fixture-model',
  choices: [{ index: 0, message, finish_reason: message.tool_calls ? 'tool_calls' : 'stop' }],
  usage: { prompt_tokens: 12, completion_tokens: 5, total_tokens: 17 },
});

async function setup(t, handler = () => messageResult(), options = {}) {
  const requests = [];
  const upstream = createServer(async (req, res) => {
    let raw = '';
    for await (const chunk of req) raw += chunk;
    requests.push({ path: req.url, headers: req.headers, body: JSON.parse(raw) });
    try {
      const result = await handler(requests.at(-1), res, requests.length);
      if (result !== undefined && !res.destroyed) {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify(result));
      }
    } catch { res.destroy(); }
  });
  upstream.listen(0, '127.0.0.1');
  await once(upstream, 'listening');
  t.after(() => { upstream.closeAllConnections(); upstream.close(); });
  const bridge = await startBridge({ baseUrl: `http://127.0.0.1:${upstream.address().port}/v1/`, model: 'fixture-model', apiKey: SECRET, ...options });
  t.after(() => bridge.close());
  const post = (body, extra = {}) => fetch(`${bridge.baseUrl}/responses`, {
    method: 'POST', headers: { authorization: `Bearer ${bridge.token}`, 'content-type': 'application/json' },
    body: typeof body === 'string' ? body : JSON.stringify({ stream: true, ...body }), ...extra,
  });
  return { bridge, requests, post };
}

function events(source) {
  return source.split('\n\n').filter(Boolean).map((block) => {
    const event = block.split('\n').find((line) => line.startsWith('event: '))?.slice(7);
    const data = JSON.parse(block.split('\n').find((line) => line.startsWith('data: ')).slice(6));
    assert.equal(event, data.type);
    return data;
  });
}

test('bridge returns complete text Responses SSE and sends only a nonstream model request', async (t) => {
  const { bridge, requests, post } = await setup(t);
  assert.match(bridge.baseUrl, /^http:\/\/127\.0\.0\.1:\d+\/v1$/);
  assert.ok(bridge.token.length >= 32);
  const res = await post({ input: 'Hello', instructions: 'Be helpful', temperature: 0.3, max_output_tokens: 50 });
  assert.equal(res.status, 200);
  assert.match(res.headers.get('content-type'), /text\/event-stream/);
  const result = events(await res.text());
  assert.deepEqual(result.map((item) => item.type), [
    'response.created', 'response.in_progress', 'response.output_item.added', 'response.content_part.added',
    'response.output_text.delta', 'response.output_text.done', 'response.content_part.done', 'response.output_item.done', 'response.completed',
  ]);
  assert.deepEqual(result.map((item) => item.sequence_number), [0, 1, 2, 3, 4, 5, 6, 7, 8]);
  assert.equal(result[2].item.content.length, 0);
  assert.equal(result[4].delta, 'Hello from the model.');
  assert.equal(result[5].text, 'Hello from the model.');
  assert.equal(result.at(-1).response.output[0].content[0].text, 'Hello from the model.');
  assert.equal(result.at(-1).response.status, 'completed');
  assert.equal(result.at(-1).response.usage.total_tokens, 17);
  assert.deepEqual(requests[0].body, {
    model: 'fixture-model', stream: false, messages: [{ role: 'system', content: 'Be helpful' }, { role: 'user', content: 'Hello' }],
    temperature: 0.3, max_tokens: 50,
  });
  assert.equal(requests[0].path, '/v1/chat/completions');
  assert.equal(requests[0].headers.authorization, `Bearer ${SECRET}`);
});

test('turn model switches reach upstream and Responses while omitted model uses the startup default', async (t) => {
  const { requests, post } = await setup(t);
  for (const [model, expected] of [['provider/another-model', 'provider/another-model'], [undefined, 'fixture-model'], ['  literal model name  ', '  literal model name  ']]) {
    const res = await post({ input: 'Continue this conversation', ...(model === undefined ? {} : { model }) });
    assert.equal(res.status, 200);
    const result = events(await res.text());
    assert.equal(requests.at(-1).body.model, expected);
    assert.equal(result.at(-1).response.model, expected);
  }
});

test('models without an API key receive no authorization header while the bridge remains authenticated', async (t) => {
  const { requests, bridge, post } = await setup(t, () => messageResult(), { apiKey: undefined });
  const res = await post({ input: 'Hello local model' });
  assert.equal(res.status, 200);
  assert.equal(events(await res.text()).at(-1).response.output[0].content[0].text, 'Hello from the model.');
  assert.equal(requests[0].headers.authorization, undefined);
  const unauthorized = await fetch(`${bridge.baseUrl}/responses`, { method: 'POST', body: '{"input":"Hello"}' });
  assert.equal(unauthorized.status, 401);
  await unauthorized.text();
  assert.equal(requests.length, 1);
});

test('invalid turn model identifiers fail before contacting upstream and never appear in errors', async (t) => {
  const { requests, post } = await setup(t);
  for (const model of ['', '  ', null, 42, `${SECRET}\nmodel`, 'invalid\u0000model', 'invalid\u007fmodel']) {
    const res = await post({ input: 'Continue', model });
    assert.equal(res.status, 400);
    const body = await res.text();
    assert.match(JSON.parse(body).error.message, /model/i);
    assert.ok(!body.includes(SECRET));
  }
  assert.equal(requests.length, 0);
});

test('startup model identifiers reject control characters without retaining a listener', async (t) => {
  for (const model of [`${SECRET}\nmodel`, 'invalid\u0000model', 'invalid\u007fmodel']) {
    let bridge;
    let failure;
    try { bridge = await startBridge({ baseUrl: 'https://example.com/v1', model, apiKey: SECRET }); }
    catch (error) { failure = error; }
    if (bridge) t.after(() => bridge.close());
    assert.ok(failure, 'Control characters must be rejected before opening a listener');
    assert.ok(!failure.message.includes(SECRET));
  }
});

test('bridge coalesces function calls, preserves outputs and reasoning through multiple model rounds', async (t) => {
  const tools = [{ type: 'function', name: 'exec_command', description: 'Run a shell command', parameters: { type: 'object', properties: { cmd: { type: 'string' } }, required: ['cmd'] }, strict: false }];
  const { requests, post } = await setup(t, (_req, _res, round) => round === 1 ? messageResult({
    role: 'assistant', content: null, reasoning_content: 'Need two files.', tool_calls: [
      { id: 'call-A', type: 'function', function: { name: 'exec_command', arguments: '{"cmd":"type a.txt"}' } },
      { id: 'call-B', type: 'function', function: { name: 'exec_command', arguments: '{"cmd":"type b.txt"}' } },
    ],
  }) : messageResult());
  const first = events(await (await post({ input: 'Read files', tools })).text());
  const calls = first.filter((item) => item.type === 'response.output_item.done').map((item) => item.item);
  assert.equal(calls.length, 2);
  assert.equal(first.filter((item) => item.type === 'response.function_call_arguments.delta').length, 2);
  assert.equal(first.filter((item) => item.type === 'response.function_call_arguments.done').length, 2);
  assert.equal(calls[0].call_id, 'call-A');
  const follow = await post({ input: [
    { role: 'user', content: [{ type: 'input_text', text: 'Read files' }] }, ...calls,
    { type: 'function_call_output', call_id: 'call-A', output: 'file A' },
    { type: 'function_call_output', call_id: 'call-B', output: [{ type: 'input_text', text: 'file B' }] },
  ], tools, parallel_tool_calls: false, tool_choice: { type: 'function', name: 'exec_command' } });
  assert.equal(follow.status, 200);
  await follow.text();
  assert.deepEqual(requests[1].body.messages, [
    { role: 'user', content: 'Read files' },
    { role: 'assistant', content: null, tool_calls: [
      { id: 'call-A', type: 'function', function: { name: 'exec_command', arguments: '{"cmd":"type a.txt"}' } },
      { id: 'call-B', type: 'function', function: { name: 'exec_command', arguments: '{"cmd":"type b.txt"}' } },
    ], reasoning_content: 'Need two files.' },
    { role: 'tool', tool_call_id: 'call-A', content: 'file A' },
    { role: 'tool', tool_call_id: 'call-B', content: 'file B' },
  ]);
  assert.equal(requests[1].body.tools[0].function.name, 'exec_command');
  assert.deepEqual(requests[1].body.tool_choice, { type: 'function', function: { name: 'exec_command' } });
  assert.equal(requests[1].body.parallel_tool_calls, false);
});

test('custom patch tools round-trip exact input and correct SSE input events', async (t) => {
  const patch = '*** Begin Patch\n*** Add File: example.txt\n+hello\n*** End Patch';
  const tools = [{ type: 'custom', name: 'apply_patch', description: 'Apply a patch', format: { type: 'grammar', syntax: 'lark', definition: 'start: /.+/s' } }];
  const { requests, post } = await setup(t, (_req, _res, round) => round === 1 ? messageResult({ role: 'assistant', content: null,
    tool_calls: [{ id: 'patch-1', type: 'function', function: { name: 'apply_patch', arguments: JSON.stringify({ input: patch }) } }],
  }) : messageResult());
  const first = events(await (await post({ input: 'Write a file', tools })).text());
  assert.equal(first.find((item) => item.type === 'response.custom_tool_call_input.delta').delta, patch);
  assert.equal(first.find((item) => item.type === 'response.custom_tool_call_input.done').input, patch);
  assert.ok(!first.some((item) => item.type === 'response.function_call_arguments.delta'));
  const call = first.find((item) => item.type === 'response.output_item.done').item;
  assert.equal(call.type, 'custom_tool_call');
  assert.equal(call.input, patch);
  const follow = await post({ input: [{ role: 'user', content: 'Write a file' }, call, { type: 'custom_tool_call_output', call_id: 'patch-1', output: { content: 'Applied successfully', success: true } }], tools });
  assert.equal(follow.status, 200);
  await follow.text();
  assert.deepEqual(requests[0].body.tools[0].function.parameters, { type: 'object', properties: { input: { type: 'string' } }, required: ['input'], additionalProperties: false });
  assert.match(requests[0].body.tools[0].function.description, /start: \/\.\+\/s/);
  assert.equal(requests[1].body.messages[1].tool_calls[0].function.arguments, JSON.stringify({ input: patch }));
  assert.equal(requests[1].body.messages[2].content, 'Applied successfully');
});

test('namespace functions and custom tools preserve namespace identity across tool rounds', async (t) => {
  const tools = [{ type: 'namespace', name: 'functions', description: 'Execution tools', tools: [
    { type: 'function', name: 'exec_command', description: 'Run a command', parameters: { type: 'object', properties: { cmd: { type: 'string' } } } },
    { type: 'custom', name: 'apply_patch', description: 'Apply a patch' },
  ] }];
  const { requests, post } = await setup(t, (req, _res, round) => round === 1 ? messageResult({ role: 'assistant', content: null, tool_calls: [
    { id: 'run-1', type: 'function', function: { name: req.body.tools[0].function.name, arguments: '{"cmd":"type notes.txt"}' } },
    { id: 'patch-1', type: 'function', function: { name: req.body.tools[1].function.name, arguments: '{"input":"*** Begin Patch\\n*** End Patch"}' } },
  ] }) : messageResult());
  const res = await post({ input: 'Read and edit', tools, tool_choice: { type: 'function', namespace: 'functions', name: 'exec_command' } });
  assert.equal(res.status, 200);
  const result = events(await res.text());
  const calls = result.filter((event) => event.type === 'response.output_item.done').map((event) => event.item);
  assert.deepEqual(calls.map((call) => [call.name, call.namespace, call.type]), [['exec_command', 'functions', 'function_call'], ['apply_patch', 'functions', 'custom_tool_call']]);
  assert.equal(requests[0].body.tools[0].function.name, 'functions__exec_command');
  assert.equal(requests[0].body.tools[1].function.name, 'functions__apply_patch');
  assert.equal(requests[0].body.tool_choice.function.name, 'functions__exec_command');
  const follow = await post({ input: [{ role: 'user', content: 'Read and edit' }, ...calls,
    { type: 'function_call_output', call_id: 'run-1', output: 'notes' },
    { type: 'custom_tool_call_output', call_id: 'patch-1', output: 'applied' },
  ], tools });
  assert.equal(follow.status, 200);
  await follow.text();
  assert.deepEqual(requests[1].body.messages[1].tool_calls.map((call) => call.function.name), ['functions__exec_command', 'functions__apply_patch']);
});

test('namespace flattening keeps ambiguous names unique, bounded and reversible', async (t) => {
  const longNamespace = `mcp_${'n'.repeat(100)}`;
  const tools = [
    { type: 'function', name: 'a__b' },
    { type: 'namespace', name: 'a', description: 'A', tools: [{ type: 'function', name: 'b' }] },
    { type: 'namespace', name: longNamespace, description: 'Long namespace', tools: [{ type: 'function', name: 'b' }] },
    { type: 'namespace', name: 'c', description: 'C', tools: [{ type: 'function', name: 'b' }] },
  ];
  const { requests, post } = await setup(t, (req) => messageResult({ role: 'assistant', content: null, tool_calls: req.body.tools.map((tool, i) => ({ id: `call-${i}`, type: 'function', function: { name: tool.function.name, arguments: '{}' } })) }));
  const res = await post({ input: 'Use tools', tools });
  assert.equal(res.status, 200);
  const calls = events(await res.text()).filter((event) => event.type === 'response.output_item.done').map((event) => event.item);
  const names = requests[0].body.tools.map((tool) => tool.function.name);
  assert.equal(new Set(names).size, 4);
  for (const name of names) assert.match(name, /^[a-zA-Z0-9_-]{1,64}$/);
  assert.deepEqual(calls.map((call) => [call.name, call.namespace ?? null]), [['a__b', null], ['b', 'a'], ['b', longNamespace], ['b', 'c']]);
});

test('text/image content and assistant history reach the model without fetching images', async (t) => {
  const { requests, post } = await setup(t);
  const res = await post({ input: [
    { type: 'message', role: 'developer', content: [{ type: 'input_text', text: 'Use the image' }] },
    { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'Describe' }, { type: 'input_image', image_url: 'data:image/png;base64,YWJj', detail: 'low' }] },
    { type: 'reasoning', id: 'reasoning-old', encrypted_content: 'opaque' },
    { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'An image', annotations: [] }] },
    { role: 'user', content: 'More detail' },
  ] });
  assert.equal(res.status, 200);
  await res.text();
  assert.deepEqual(requests[0].body.messages, [
    { role: 'system', content: 'Use the image' },
    { role: 'user', content: [{ type: 'text', text: 'Describe' }, { type: 'image_url', image_url: { url: 'data:image/png;base64,YWJj', detail: 'low' } }] },
    { role: 'assistant', content: 'An image' },
    { role: 'user', content: 'More detail' },
  ]);
});

test('multimodal tool results preserve tool text and attribute images after every pending tool result', async (t) => {
  const { requests, post } = await setup(t);
  const res = await post({ tools: [{ type: 'namespace', name: 'computer', description: 'Computer tools', tools: [{ type: 'function', name: 'screenshot' }, { type: 'custom', name: 'image_analysis' }] }], input: [
    { role: 'user', content: 'Inspect the screenshots' },
    { type: 'function_call', namespace: 'computer', name: 'screenshot', call_id: 'screen-1', arguments: '{}' },
    { type: 'custom_tool_call', namespace: 'computer', name: 'image_analysis', call_id: 'screen-2', input: 'inspect image' },
    { type: 'function_call_output', call_id: 'screen-1', output: [{ type: 'input_text', text: 'Current screen' }, { type: 'input_image', image_url: 'data:image/png;base64,YWJj', detail: 'original' }] },
    { type: 'custom_tool_call_output', call_id: 'screen-2', output: [{ type: 'input_image', image_url: 'https://example.com/screenshot.png', detail: 'low' }] },
    { role: 'user', content: 'Explain the highlighted region' },
  ] });
  assert.equal(res.status, 200);
  await res.text();
  const history = requests[0].body.messages;
  assert.deepEqual(history.map((message) => message.role), ['user', 'assistant', 'tool', 'tool', 'user', 'user']);
  assert.equal(history[2].content, 'Current screen');
  assert.equal(history[3].content, '');
  assert.deepEqual(history[4].content.filter((part) => part.type === 'image_url'), [
    { type: 'image_url', image_url: { url: 'data:image/png;base64,YWJj', detail: 'original' } },
    { type: 'image_url', image_url: { url: 'https://example.com/screenshot.png', detail: 'low' } },
  ]);
  const attribution = history[4].content.filter((part) => part.type === 'text').map((part) => part.text).join('\n');
  assert.match(attribution, /computer\.screenshot.*screen-1/);
  assert.match(attribution, /computer\.image_analysis.*screen-2/);
  assert.equal(history[5].content, 'Explain the highlighted region');
});

test('incomplete parallel tool history cannot silently drop screenshot outputs', async (t) => {
  const { requests, post } = await setup(t);
  const res = await post({ input: [
    { role: 'user', content: 'Inspect the screen' },
    { type: 'function_call', name: 'screenshot', call_id: 'screen-1', arguments: '{}' },
    { type: 'function_call', name: 'inspect', call_id: 'screen-2', arguments: '{}' },
    { type: 'function_call_output', call_id: 'screen-1', output: [{ type: 'input_image', image_url: 'data:image/png;base64,YWJj' }] },
  ] });
  assert.equal(res.status, 400);
  await res.text();
  assert.equal(requests.length, 0);
});

test('JSON clients receive a completed response without an SSE envelope', async (t) => {
  const { post } = await setup(t);
  const res = await post({ input: 'Hello', stream: false });
  assert.equal(res.status, 200);
  assert.match(res.headers.get('content-type'), /application\/json/);
  const body = await res.json();
  assert.equal(body.object, 'response');
  assert.equal(body.output[0].content[0].text, 'Hello from the model.');
});

test('omitting stream follows Responses default JSON behavior', async (t) => {
  const { post } = await setup(t);
  const res = await post({ input: 'Hello' }, { body: '{"input":"Hello"}' });
  assert.equal(res.status, 200);
  assert.match(res.headers.get('content-type'), /application\/json/);
  assert.equal((await res.json()).output[0].content[0].text, 'Hello from the model.');
});

test('bridge health is harmless while response endpoint rejects unauthorized and unsupported requests', async (t) => {
  const { bridge, requests } = await setup(t);
  const health = await fetch(bridge.baseUrl.replace('/v1', '/health'));
  assert.deepEqual(await health.json(), { status: 'ok' });
  for (const token of ['', 'Bearer wrong']) {
    const res = await fetch(`${bridge.baseUrl}/responses`, { method: 'POST', headers: { authorization: token }, body: '{"input":"hello"}' });
    assert.equal(res.status, 401);
    assert.ok(!(await res.text()).includes(bridge.token));
  }
  assert.equal((await fetch(`${bridge.baseUrl}/responses`, { headers: { authorization: `Bearer ${bridge.token}` } })).status, 405);
  assert.equal((await fetch(`${bridge.baseUrl}/nope`)).status, 404);
  assert.equal(requests.length, 0);
});

test('invalid inputs, native hosted tools, unsupported contents and bad JSON fail before upstream work', async (t) => {
  const { post, requests } = await setup(t);
  const cases = [
    '{bad json', { input: 42 }, { input: 'Hi', tools: [{ type: 'web_search' }] },
    { input: [{ role: 'user', content: [{ type: 'input_audio', data: 'abc' }] }] },
    { input: [{ type: 'function_call', call_id: 'x', name: 'tool', arguments: '{}' }, { type: 'function_call_output', call_id: 'different', output: 'oops' }] },
    { input: 'Hi', previous_response_id: 'resp-old' },
  ];
  for (const body of cases) {
    const res = await post(body);
    assert.equal(res.status, 400);
    assert.ok((await res.json()).error.message.length > 0);
  }
  assert.equal(requests.length, 0);
});

test('upstream errors preserve useful status but redact credentials and provider response bodies', async (t) => {
  const { post } = await setup(t, (_req, res) => {
    res.writeHead(429, { 'content-type': 'application/json', 'retry-after': '2' });
    res.end(JSON.stringify({ error: { message: `Secret ${SECRET}, private prompt` } }));
  });
  const res = await post({ input: 'Hello' });
  assert.equal(res.status, 429);
  assert.equal(res.headers.get('retry-after'), '2');
  const text = await res.text();
  assert.ok(text.includes('429'));
  assert.ok(!text.includes(SECRET));
  assert.ok(!text.includes('private prompt'));
});

test('malformed successful model data and invalid custom arguments return a sanitized gateway error', async (t) => {
  const { post } = await setup(t, () => messageResult({ role: 'assistant', content: null, tool_calls: [{ id: 'bad', type: 'function', function: { name: 'patch', arguments: 'not-json-secret' } }] }));
  const res = await post({ input: 'Hi', tools: [{ type: 'custom', name: 'patch' }] });
  assert.equal(res.status, 502);
  assert.ok(!(await res.text()).includes('not-json-secret'));
});

for (const failure of ['truncated generations', 'filtered generations', 'undeclared tool calls']) {
  test(`${failure} fail without exposing executable response items`, async (t) => {
    const { post } = await setup(t, () => {
      const result = failure === 'undeclared tool calls' ? messageResult({ role: 'assistant', content: null, tool_calls: [{ id: 'unknown', type: 'function', function: { name: 'unknown_tool', arguments: '{}' } }] }) : messageResult();
      if (failure === 'truncated generations') result.choices[0].finish_reason = 'length';
      if (failure === 'filtered generations') result.choices[0].finish_reason = 'content_filter';
      return result;
    });
    const res = await post({ input: 'Hi', tools: [{ type: 'function', name: 'expected_tool' }] });
    assert.equal(res.status, 502);
    assert.match(res.headers.get('content-type'), /application\/json/);
    assert.ok((await res.json()).error.message.length > 0);
  });
}

test('upstream timeout yields 504 and cancels the model connection', async (t) => {
  let closed;
  const didClose = new Promise((resolve) => { closed = resolve; });
  const { post } = await setup(t, (_req, res) => { res.on('close', closed); }, { timeoutMs: 60 });
  const res = await post({ input: 'Hi' });
  assert.equal(res.status, 504);
  assert.match((await res.json()).error.message, /timed out/i);
  await Promise.race([didClose, delay(1500).then(() => assert.fail('model connection was not cancelled'))]);
});

test('client cancellation aborts its model request and close is repeatable', async (t) => {
  let reached, closed;
  const didReach = new Promise((resolve) => { reached = resolve; });
  const didClose = new Promise((resolve) => { closed = resolve; });
  const { post, bridge } = await setup(t, (_req, res) => { reached(); res.on('close', closed); });
  const controller = new AbortController();
  const pending = post({ input: 'Hi' }, { signal: controller.signal });
  await didReach;
  controller.abort();
  await assert.rejects(pending, { name: 'AbortError' });
  await Promise.race([didClose, delay(1500).then(() => assert.fail('client cancellation did not abort model'))]);
  await bridge.close();
  await bridge.close();
  await assert.rejects(fetch(`${bridge.baseUrl}/responses`));
});

test('oversized input returns 413 without reaching the model', async (t) => {
  const { post, requests } = await setup(t);
  const res = await post({ input: 'x'.repeat(16 * 1024 * 1024) });
  assert.equal(res.status, 413);
  await res.text();
  assert.equal(requests.length, 0);
});

test('unsafe bridge configuration is rejected before starting a listener', async () => {
  for (const options of [
    { baseUrl: 'file:///tmp/model' }, { baseUrl: 'https://user:password@example.com/v1' },
    { model: '' }, { apiKey: '' }, { apiKey: null }, { apiKey: 'bad\r\nkey' }, { timeoutMs: 0 },
  ]) await assert.rejects(startBridge({ baseUrl: 'https://example.com/v1', model: 'fixture-model', apiKey: SECRET, ...options }));
});
