import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { setTimeout as nativeSetTimeout, clearTimeout as nativeClearTimeout } from 'node:timers';
import { setTimeout as delay } from 'node:timers/promises';
import { startBridge } from '../src/bridge.mjs';

const SECRET = 'sk-fake-boundary-secret';

test('MiMo-shaped streaming chunks accept null role and tool_calls and replay reasoning', async t => {
  const {post,requests}=await setup(t,(_request,res)=>{
    res.writeHead(200,{'content-type':'text/event-stream'});
    for(const delta of [{role:null,tool_calls:null,content:null,reasoning_content:'Check the file.'},{role:null,tool_calls:[{index:0,id:'mimo-call',type:'function',function:{name:'read',arguments:'{}'}}],content:null}])res.write('data: '+JSON.stringify({choices:[{index:0,delta,finish_reason:null}]})+'\n\n');
    res.end('data: '+JSON.stringify({choices:[{index:0,delta:{role:null,tool_calls:null},finish_reason:'tool_calls'}]})+'\n\ndata: [DONE]\n\n');
  });
  const tools=[{type:'function',name:'read',parameters:{type:'object',properties:{}}}];
  const response=await post({input:'Read',tools});assert.equal(response.status,200);
  const emitted=events(await response.text());assert.ok(emitted.some(event=>event.type==='response.completed'));
  const call=emitted.find(event=>event.type==='response.output_item.done'&&event.item.type==='function_call').item;
  const follow=await post({input:[{role:'user',content:'Read'},call,{type:'function_call_output',call_id:call.call_id,output:'file content'}],tools});
  await follow.text();assert.equal(requests[1].body.messages.find(message=>message.tool_calls)?.reasoning_content,'Check the file.');
});

test('bridge beforeRequest receives native tool history transiently',async t=>{
  let captured;const input=[{role:'user',content:'Read'},{type:'function_call',name:'read',call_id:'guard-1',arguments:'{}'},{type:'function_call_output',call_id:'guard-1',output:'done'}];
  const {post}=await setup(t,()=>messageResult(),{requestHooks:{beforeRequest:request=>{captured=request;}}});
  await(await post({input,tools:[{type:'function',name:'read'}]})).text();assert.deepEqual(captured.input,input);
});

test('JSON fallback and declared non-streaming replies accept null tool_calls',async t=>{
  for(const streaming of [true,false]){
    const {post}=await setup(t,()=>messageResult({role:'assistant',content:'Valid no-tool reply.',tool_calls:null}),{streaming});
    const response=await post({input:'Answer'});assert.equal(response.status,200);const emitted=events(await response.text());assert.ok(emitted.some(event=>event.type==='response.completed'));assert.ok(emitted.some(event=>event.delta==='Valid no-tool reply.'));
  }
});
const messageResult = (message = { role: 'assistant', content: 'Hello from the model.' }) => ({
  id: 'chatcmpl-fixture', object: 'chat.completion', model: 'fixture-model',
  choices: [{ index: 0, message, finish_reason: message.tool_calls ? 'tool_calls' : 'stop' }],
  usage: { prompt_tokens: 12, completion_tokens: 5, total_tokens: 17 },
});

test('bridge signals sanitized tool policy failure before a native client can retry', async t => {
  const errors = [];
  const { post } = await setup(t, () => messageResult({ role: 'assistant', content: null, tool_calls: [{ id: 'rogue', type: 'function', function: { name: SECRET, arguments: '{}' } }] }), { toolsAllowed: false, onPolicyError: error => errors.push(error) });
  const response = await post({ input: 'Text', tools: [{ type: 'function', name: 'allowed' }] });
  await response.text();
  assert.equal(response.status, 502);
  assert.equal(errors.length, 1);
  assert.equal(errors[0].code, 'TOOLS_DISABLED');
  assert.doesNotMatch(JSON.stringify(errors), new RegExp(SECRET));
});

test('bridge forwards explicit reasoning effort and preserves provider default when omitted', async (t) => {
  const { requests, post } = await setup(t);
  for (const effort of ['none', 'xhigh', 'max', 'ultra', 'adaptive']) {
    const res = await post({ input: 'Think', reasoning: { effort }, stream: false });
    assert.equal(res.status, 200);
    await res.text();
    assert.equal(requests.at(-1).body.reasoning_effort, effort);
  }
  await (await post({ input: 'Default', reasoning: {}, stream: false })).text();
  assert.equal(Object.hasOwn(requests.at(-1).body, 'reasoning_effort'), false);
  await (await post({ input: 'Default', stream: false })).text();
  assert.equal(Object.hasOwn(requests.at(-1).body, 'reasoning_effort'), false);
  const count = requests.length;
  for (const reasoning of [null, [], { effort: null }, { effort: 'secret\nvalue' }]) {
    const res = await post({ input: 'Invalid', reasoning });
    assert.equal(res.status, 400);
    assert.ok(!(await res.text()).includes('secret'));
  }
  assert.equal(requests.length, count);
});
test('a declared non-streaming Chat provider receives JSON generation while native SSE still works',async t=>{const {requests,post}=await setup(t,()=>messageResult(),{streaming:false});const response=await post({input:'Hello',stream:true});assert.equal(response.status,200);const text=await response.text();assert.match(text,/response.completed/);assert.match(text,/Hello from the model/);assert.equal(requests[0].body.stream,false);assert.equal(requests[0].body.stream_options,undefined);});

async function setup(t, handler = () => messageResult(), options = {}, observeResponse = () => {}) {
  const requests = [];
  const upstream = createServer(async (req, res) => {
    // Cancellation can close this response while request-body consumption is pending.
    observeResponse(req,res);
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

async function withinNativeDeadline(pending, message) {
  let timer;
  try {
    return await Promise.race([pending, new Promise((_, reject) => {
      timer = nativeSetTimeout(() => reject(new Error(message)), 1500);
    })]);
  } finally { nativeClearTimeout(timer); }
}

async function expireBridgeDeadline(t, start, ready, readinessMessage) {
  let pending;
  // Freeze only the unchanged bridge deadline until the intended network phase.
  // Captured native timers keep readiness and cancellation failures bounded.
  t.mock.timers.enable({ apis: ['setTimeout'] });
  try {
    pending = start();
    pending.catch(() => {});
    await withinNativeDeadline(ready, readinessMessage);
    t.mock.timers.tick(60);
  } finally { t.mock.timers.reset(); }
  return { pending };
}

function events(source) {
  return source.split('\n\n').filter(Boolean).map((block) => {
    const event = block.split('\n').find((line) => line.startsWith('event: '))?.slice(7);
    const data = JSON.parse(block.split('\n').find((line) => line.startsWith('data: ')).slice(6));
    assert.equal(event, data.type);
    return data;
  });
}

test('bridge requests upstream streaming and accepts compatible JSON fallback', async (t) => {
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
    model: 'fixture-model', stream: true, stream_options: { include_usage: true }, messages: [{ role: 'system', content: 'Be helpful' }, { role: 'user', content: 'Hello' }],
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
  let reached, closed, modelSocket;
  const didReach = new Promise((resolve) => { reached = resolve; });
  const didClose = new Promise((resolve) => { closed = resolve; });
  const { post, requests } = await setup(t, () => { reached(); }, { timeoutMs: 60 }, (req, res) => {
    modelSocket = req.socket; res.once('close', closed);
  });
  const { pending } = await expireBridgeDeadline(t, () => post({ input: 'Hi' }), didReach, 'model request was not dispatched');
  const res = await withinNativeDeadline(pending, 'bridge timeout did not return HTTP 504');
  assert.equal(res.status, 504);
  assert.match((await res.json()).error.message, /timed out/i);
  await withinNativeDeadline(didClose, 'model connection was not cancelled');
  assert.equal(requests.length, 1);
  assert.equal(modelSocket.destroyed, true);
});

test('timeout cancellation is observed before a delayed fixture handler can miss the close event', async t => {
  let reached, closed, handled, release, modelSocket, lateDestroyed = false, lateCloseEvents = 0;
  const didReach = new Promise(resolve => { reached = resolve; });
  const didClose = new Promise(resolve => { closed = resolve; });
  const didHandle = new Promise(resolve => { handled = resolve; });
  const held = new Promise(resolve => { release = resolve; });
  t.after(() => release());
  const { post, requests } = await setup(t, async (_req, res) => {
    reached(); await held;
    lateDestroyed = res.destroyed; res.once('close', () => { lateCloseEvents++; }); handled();
  }, { timeoutMs: 60 }, (req, res) => { modelSocket = req.socket; res.once('close', closed); });
  const { pending } = await expireBridgeDeadline(t, () => post({ input: 'Hi' }), didReach, 'model request was not dispatched');
  const response = await withinNativeDeadline(pending, 'bridge timeout did not return HTTP 504');
  assert.equal(response.status, 504);
  assert.match((await response.json()).error.message, /timed out/i);
  await withinNativeDeadline(didClose, 'model connection was not cancelled');
  release();
  await withinNativeDeadline(didHandle, 'delayed fixture handler did not settle');
  assert.equal(requests.length, 1);
  assert.equal(modelSocket.destroyed, true);
  assert.equal(lateDestroyed, true);
  assert.equal(lateCloseEvents, 0);
});

test('timeout before dispatch returns 504 without a model request', async t => {
  let reached, release, observed = 0;
  const didReach = new Promise(resolve => { reached = resolve; });
  const held = new Promise(resolve => { release = resolve; });
  t.after(() => release());
  const { post, requests } = await setup(t, () => messageResult(), {
    timeoutMs: 60, requestHooks: { beforeRequest: () => { reached(); return held; } },
  }, () => { observed++; });
  const { pending } = await expireBridgeDeadline(t, () => post({ input: 'Hi' }), didReach, 'request admission was not reached');
  release();
  const response = await withinNativeDeadline(pending, 'bridge timeout did not return HTTP 504');
  assert.equal(response.status, 504);
  assert.match((await response.json()).error.message, /timed out/i);
  assert.equal(requests.length, 0);
  assert.equal(observed, 0);
});

test('client cancellation aborts its model request and close is repeatable', async (t) => {
  let reached, closed,modelSocket;
  const didReach = new Promise((resolve) => { reached = resolve; });
  const didClose = new Promise((resolve) => { closed = resolve; });
  const { post, bridge } = await setup(t,()=>{reached();},{},(req,res)=>{modelSocket=req.socket;res.once('close',closed);});
  const controller = new AbortController();
  const pending = post({ input: 'Hi' }, { signal: controller.signal });
  await didReach;
  controller.abort();
  await assert.rejects(pending, { name: 'AbortError' });
  await withinNativeDeadline(didClose, 'client cancellation did not abort model');
  assert.equal(modelSocket.destroyed,true);
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

test('health metrics use upstream response latency without disclosing request or key', async t => {
  const metrics = [];
  const { post } = await setup(t, () => messageResult(), { onMetrics: value => metrics.push(value) });
  const response = await post({ input: 'private prompt' }); await response.text();
  assert.deepEqual(metrics.map(value => value.phase), ['started', 'succeeded']);
  assert.ok(metrics[1].latencyMs >= 0);
  assert.equal(metrics[0].id, metrics[1].id);
  assert.doesNotMatch(JSON.stringify(metrics), /private prompt|sk-fake/);
});

test('real upstream deltas reach Responses clients before upstream completion and preserve final usage', async t => {
  let release; const held = new Promise(resolve => { release = resolve; });
  const metrics = [], usage = [], outcomes = [];
  const { post, requests } = await setup(t, async (_req, res) => {
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    res.write('data: ' + JSON.stringify({ choices: [{ index: 0, delta: { role: 'assistant', content: 'First ' }, finish_reason: null }] }) + '\n\n');
    await held;
    res.write('data: ' + JSON.stringify({ choices: [{ index: 0, delta: { content: 'second' }, finish_reason: 'stop' }] }) + '\n\n');
    res.end('data: ' + JSON.stringify({ choices: [], usage: { prompt_tokens: 20, completion_tokens: 4, total_tokens: 24 } }) + '\n\ndata: [DONE]\n\n');
  }, { onMetrics: event => metrics.push(event), requestHooks: { beforeRequest: async () => ({ maxOutputTokens: 8 }), onUsage: async event => usage.push(event), afterRequest: async event => outcomes.push(event) } });
  let response;
  try { response = await Promise.race([post({ input: 'private input', max_output_tokens: 99 }), delay(1000).then(() => { throw new Error('No streaming headers before upstream completion'); })]); }
  catch (error) { release(); throw error; }
  const reader = response.body.getReader(); let source = '';
  try {
    while (!source.includes('"delta":"First "')) {
      const part = await Promise.race([reader.read(), delay(1000).then(() => { throw new Error('No incremental delta before completion'); })]);
      assert.equal(part.done, false); source += new TextDecoder().decode(part.value);
    }
  } finally { release(); }
  for (;;) { const part = await reader.read(); if (part.done) break; source += new TextDecoder().decode(part.value); }
  const result = events(source);
  assert.deepEqual(result.filter(event => event.type === 'response.output_text.delta').map(event => event.delta), ['First ', 'second']);
  assert.equal(result.at(-1).response.output[0].content[0].text, 'First second');
  assert.equal(result.at(-1).response.usage.total_tokens, 24);
  assert.equal(requests[0].body.max_tokens, 8);
  assert.deepEqual(metrics.map(event => event.phase), ['started', 'responding', 'succeeded']);
  assert.ok(metrics.at(-1).totalLatencyMs >= metrics[1].firstTokenLatencyMs);
  assert.equal(usage[0].estimated, false);
  assert.equal(usage[0].outputTokens, 4);
  assert.equal(outcomes[0].outcome, 'succeeded');
  assert.equal(outcomes[0].id, usage[0].id);
  assert.doesNotMatch(JSON.stringify(metrics), /private input|sk-fake/);
});

test('fragmented parallel tool calls preserve arguments and custom raw input', async t => {
  const { post } = await setup(t, (_req, res) => {
    const chunks = [
      { choices: [{ index: 0, delta: { role: 'assistant', tool_calls: [{ index: 0, id: 'call-f', type: 'function', function: { name: 'run', arguments: '{"value":' } }, { index: 1, id: 'call-c', type: 'function', function: { name: 'patch', arguments: '{"input":"line' } }] }, finish_reason: null }] },
      { choices: [{ index: 0, delta: { tool_calls: [{ index: 0, function: { arguments: '5}' } }, { index: 1, function: { arguments: '\\nnext"}' } }] }, finish_reason: 'tool_calls' }] },
      { choices: [], usage: { prompt_tokens: 10, completion_tokens: 9, total_tokens: 19 } },
    ];
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    res.end(chunks.map(chunk => 'data: ' + JSON.stringify(chunk) + '\n\n').join('') + 'data: [DONE]\n\n');
  });
  const result = events(await (await post({ input: 'Use tools', tools: [{ type: 'function', name: 'run' }, { type: 'custom', name: 'patch' }] })).text());
  const output = result.at(-1).response.output;
  assert.equal(output[0].arguments, '{"value":5}');
  assert.equal(output[1].input, 'line\nnext');
  assert.equal(output[0].call_id, 'call-f');
  assert.equal(output[1].call_id, 'call-c');
  assert.deepEqual(result.filter(event => event.type === 'response.function_call_arguments.delta').map(event => event.delta), ['{"value":', '5}']);
});

test('unfinished and filtered tool streams emit failure without completed executable tool items', async t => {
  for (const finish_reason of [null, 'length', 'content_filter']) {
    const { post } = await setup(t, (_req, res) => {
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.end('data: ' + JSON.stringify({ choices: [{ index: 0, delta: { role: 'assistant', tool_calls: [{ index: 0, id: 'x', type: 'function', function: { name: 'run', arguments: '{}' } }] }, finish_reason }] }) + '\n\ndata: [DONE]\n\n');
    });
    const result = events(await (await post({ input: 'Tool', tools: [{ type: 'function', name: 'run' }] })).text());
    assert.equal(result.at(-1).type, 'response.failed');
    assert.ok(!result.some(event => event.type === 'response.output_item.done'));
  }
});

test('budget exhaustion blocks outbound generation and missing usage settles admitted requests', async t => {
  const { post, requests } = await setup(t, () => messageResult(), { requestHooks: { beforeRequest() { const error = new Error('secret budget diagnostics'); error.code = 'BUDGET_EXCEEDED'; throw error; } } });
  const blocked = await post({ input: 'Hi' });
  assert.equal(blocked.status, 429);
  assert.doesNotMatch(await blocked.text(), /secret budget/);
  assert.equal(requests.length, 0);
  const after = [], usage = [];
  const admitted = await setup(t, () => { const result = messageResult(); delete result.usage; return result; }, { requestHooks: { beforeRequest: async () => ({}), onUsage: event => usage.push(event), afterRequest: event => after.push(event) } });
  await (await admitted.post({ input: 'Hi' })).text();
  assert.equal(usage.length, 0);
  assert.equal(after[0].outcome, 'succeeded');
});

test('budget duration bounds running bridge requests and accounting errors prevent completed streams', async t => {
  const outcomes = [];
  const bounded = await setup(t, () => undefined, { timeoutMs: 200, requestHooks: { beforeRequest: () => ({ timeoutMs: 30 }), afterRequest: event => outcomes.push(event) } });
  const timeout = await bounded.post({ input: 'Wait' });
  assert.equal(timeout.status, 504); await timeout.text();
  assert.equal(outcomes[0].outcome, 'failed');
  const failed = await setup(t, (_req, res) => {
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    res.end('data: {"choices":[{"index":0,"delta":{"content":"Done"},"finish_reason":"stop"}],"usage":{"prompt_tokens":1,"completion_tokens":1,"total_tokens":2}}\n\ndata: [DONE]\n\n');
  }, { requestHooks: { beforeRequest: () => ({}), onUsage: () => { throw new Error('secret accounting failure'); }, afterRequest: event => outcomes.push(event) } });
  const stream = events(await (await failed.post({ input: 'Hi' })).text());
  assert.equal(stream.at(-1).type, 'response.failed');
  assert.ok(!stream.some(event => event.type === 'response.completed'));
  assert.doesNotMatch(JSON.stringify(stream.at(-1)), /secret accounting/);
  assert.equal(outcomes.at(-1).outcome, 'failed');
});

test('upstream DONE completes generation even when its HTTP stream stays open', async t => {
  const { post } = await setup(t, (_req, res) => {
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    res.write('data: {"choices":[{"index":0,"delta":{"content":"Finished"},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n');
  }, { timeoutMs: 80 });
  const result = events(await (await post({ input: 'Finish' })).text());
  assert.equal(result.at(-1).type, 'response.completed');
});

test('malformed provider token usage remains unknown instead of becoming a measured zero', async t => {
  const usage = [], metrics = [];
  const { post } = await setup(t, () => ({ ...messageResult(), usage: { prompt_tokens: -1, completion_tokens: '5', total_tokens: 7 } }), { requestHooks: { onUsage: event => usage.push(event) }, onMetrics: event => metrics.push(event) });
  const result = await (await post({ input: 'Hi', stream: false })).json();
  assert.equal(result.usage, null);
  assert.equal(usage.length, 0);
  assert.equal(metrics.at(-1).outputTokens, null);
  assert.equal(metrics.at(-1).generationTokensPerSecond, null);
});

test('fragmented names that share a declared tool prefix cannot select the shorter tool early', async t => {
  const { post } = await setup(t, (_req, res) => {
    const chunks = [
      { choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id: 'call-prefix', type: 'function', function: { name: 'run', arguments: '' } }] }, finish_reason: null }] },
      { choices: [{ index: 0, delta: { tool_calls: [{ index: 0, function: { name: '_long', arguments: '{}' } }] }, finish_reason: 'tool_calls' }] },
    ];
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    res.end(chunks.map(chunk => 'data: ' + JSON.stringify(chunk) + '\n\n').join('') + 'data: [DONE]\n\n');
  });
  const result = events(await (await post({ input: 'Tool', tools: [{ type: 'function', name: 'run' }, { type: 'function', name: 'run_long' }] })).text());
  assert.equal(result.at(-1).type, 'response.completed');
  assert.equal(result.at(-1).response.output[0].name, 'run_long');
  assert.ok(!result.some(event => event.item?.name === 'run'));
});

test('streamed tools cannot complete before budget accounting accepts their reported usage', async t => {
  const { post } = await setup(t, (_req, res) => {
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    res.end('data: {"choices":[{"index":0,"delta":{"tool_calls":[{"index":0,"id":"call-budget","type":"function","function":{"name":"run","arguments":"{}"}}]},"finish_reason":"tool_calls"}],"usage":{"prompt_tokens":1,"completion_tokens":1,"total_tokens":2}}\n\ndata: [DONE]\n\n');
  }, { requestHooks: { onUsage: () => { throw new Error('Accounting unavailable'); } } });
  const result = events(await (await post({ input: 'Tool', tools: [{ type: 'function', name: 'run' }] })).text());
  assert.equal(result.at(-1).type, 'response.failed');
  assert.ok(!result.some(event => event.type === 'response.output_item.done'));
  assert.ok(!result.some(event => event.type === 'response.function_call_arguments.done'));
});

test('tools-off bridge omits definitions and rejects rogue JSON function calls without executable events', async t => {
  const { post, requests } = await setup(t, () => messageResult({ role: 'assistant', content: null, tool_calls: [{ id: 'rogue', type: 'function', function: { name: 'run', arguments: '{}' } }] }), { toolsAllowed: false });
  const response = await post({ input: 'Reply using text only', tools: [{ type: 'function', name: 'run' }], tool_choice: { type: 'function', name: 'run' }, parallel_tool_calls: true });
  const source = await response.text();
  assert.equal(response.status, 502);
  assert.ok(!source.includes('response.output_item.done'));
  assert.ok(!Object.hasOwn(requests[0].body, 'tools'));
  assert.ok(!Object.hasOwn(requests[0].body, 'tool_choice'));
  assert.ok(!Object.hasOwn(requests[0].body, 'parallel_tool_calls'));
});

test('tools-off bridge rejects rogue streamed tool deltas before executable completion', async t => {
  const { post, requests } = await setup(t, (_req, res) => {
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    res.end('data: {"choices":[{"index":0,"delta":{"tool_calls":[{"index":0,"id":"rogue","type":"function","function":{"name":"run","arguments":"{}"}}]},"finish_reason":"tool_calls"}]}\n\ndata: [DONE]\n\n');
  }, { toolsAllowed: false });
  const result = events(await (await post({ input: 'Text only', tools: [{ type: 'function', name: 'run' }] })).text());
  assert.equal(result.at(-1).type, 'response.failed');
  assert.ok(!result.some(event => event.type === 'response.output_item.done' || event.type === 'response.function_call_arguments.done'));
  assert.ok(!Object.hasOwn(requests[0].body, 'tools'));
});

test('tools-off bridge accepts text and strips native hosted tool declarations before conversion', async t => {
  const { post, requests } = await setup(t, () => messageResult(), { toolsAllowed: false });
  const response = await post({ input: 'Text only', tools: [{ type: 'web_search' }], tool_choice: 'required' });
  assert.equal(response.status, 200);
  assert.equal(events(await response.text()).at(-1).response.status, 'completed');
  assert.ok(!Object.hasOwn(requests[0].body, 'tools'));
});

test('bridge allowlist filters exact wire names and reports the advertised catalog without definitions', async t => {
  const { post, requests, bridge } = await setup(t, () => messageResult(), { toolAllowlist: ['named__run'] });
  await (await post({ input: 'Text', tools: [{ type: 'function', name: 'other', description: 'private description' }, { type: 'namespace', name: 'named', tools: [{ type: 'function', name: 'run', parameters: { type: 'object', properties: { secret: { type: 'string' } } } }] }], tool_choice: { type: 'function', name: 'other' } })).text();
  assert.deepEqual(requests[0].body.tools.map(tool => tool.function.name), ['named__run']);
  assert.ok(!Object.hasOwn(requests[0].body, 'tool_choice'));
  assert.deepEqual(bridge.getToolCatalog(), ['named__run', 'other']);
  assert.doesNotMatch(JSON.stringify(bridge.getToolCatalog()), /private description|secret/);
});

test('bridge allowlist rejects a rogue excluded function while accepting allowed calls', async t => {
  for (const name of ['allowed', 'excluded']) {
    const { post } = await setup(t, () => messageResult({ role: 'assistant', content: null, tool_calls: [{ id: 'call-policy', type: 'function', function: { name, arguments: '{}' } }] }), { toolAllowlist: ['allowed'] });
    const response = await post({ input: 'Tool', tools: [{ type: 'function', name: 'allowed' }, { type: 'function', name: 'excluded' }] });
    const source = await response.text();
    if (name === 'allowed') assert.equal(events(source).at(-1).response.output[0].name, 'allowed');
    else { assert.equal(response.status, 502); assert.ok(!source.includes('response.output_item.done')); }
  }
});
