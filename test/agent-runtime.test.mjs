import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, readdir, access, readFile } from 'node:fs/promises';
import { tmpdir } from './fixtures/temp-root.mjs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createServer } from 'node:http';
import { once } from 'node:events';

const engineFixture = fileURLToPath(new URL('./fixtures/engine-server.mjs', import.meta.url));
const connection = { model: 'fixture-model', transport: 'chat-completions', baseUrl: 'http://127.0.0.1:1/v1', apiKey: 'runtime-only-secret', contextWindow: 128000, supportedEfforts: ['high'] };
async function fixture(t, scenario = 'normal') {
  const directory = await mkdtemp(join(tmpdir(), 'codexcli-agent-runtime-test-'));
  const homes = join(directory, 'homes'); await mkdir(homes);
  t.after(() => rm(directory, { recursive: true, force: true }));
  const module = await import('../src/agent-runtime.mjs');
  return { ...module, directory, homes, options: { connection, cwd: directory, prompt: 'Run an isolated task.', runtime: { codexPath: [process.execPath, engineFixture, scenario], baseDir: homes, requestTimeoutMs: 1000 } } };
}
async function httpFixture(t, handler) {
  const server = createServer(handler); server.listen(0, '127.0.0.1'); await once(server, 'listening');
  t.after(async () => { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); });
  return `http://127.0.0.1:${server.address().port}`;
}

test('agent runtime creates a private native thread, returns authoritative final text and cleans its home', async t => {
  const { runAgentTask, options, homes } = await fixture(t);
  const events = [];
  const result = await runAgentTask({ ...options, settings: { effort: 'high' }, onEvent: event => events.push(event) });
  assert.equal(result.threadId, 'thread-1');
  const audit = JSON.parse(result.text);
  assert.equal(audit.thread.ephemeral, true);
  assert.equal(audit.thread.approvalPolicy, 'on-request');
  assert.equal(audit.thread.sandbox, 'workspace-write');
  assert.equal(audit.params.effort, 'high');
  assert.ok(audit.argv.includes('model_context_window=128000'));
  assert.ok(!audit.argv.join(' ').includes(connection.apiKey));
  assert.notEqual(audit.home, process.env.CODEX_HOME);
  assert.ok(events.some(event => event.method === 'item/agentMessage/delta'));
  const bridgeUrl = JSON.parse(audit.argv.find(value => value.startsWith('model_providers.sudo_session.base_url=')).split('=').slice(1).join('='));
  await assert.rejects(fetch(`${bridgeUrl}/responses`));
  await assert.rejects(access(audit.home));
  assert.deepEqual(await readdir(homes), []);
});

test('headless out-of-scope approvals reject the job while an explicit foreground callback can approve once', async t => {
  const { runAgentTask, options, homes } = await fixture(t, 'approvals');
  await assert.rejects(runAgentTask(options), { code: 'APPROVAL_REQUIRED' });
  const approved = JSON.parse((await runAgentTask({ ...options, settings: { scope: 'full', webAccess: true }, onApproval: async ({ method }) => method === 'item/commandExecution/requestApproval' })).text);
  assert.deepEqual(approved['item/commandExecution/requestApproval'], { decision: 'accept' });
  assert.deepEqual(approved['item/fileChange/requestApproval'], { decision: 'decline' });
  assert.deepEqual(await readdir(homes), []);
});

test('agent policy validates scoped folders and tools before startup and honors connection capability precedence', async t => {
  const { runAgentTask, options, homes } = await fixture(t);
  for (const settings of [{ toolAllowlist: 'run' }, { toolAllowlist: ['run', 'run'] }, { writableRoots: ['relative'] }, { capabilities: { reasoning: false }, effort: 'high' }]) {
    await assert.rejects(runAgentTask({ ...options, settings }), /permission|folder|reasoning/i);
    assert.deepEqual(await readdir(homes), []);
  }
  const audit = JSON.parse((await runAgentTask({ ...options, connection: { ...connection, transport: 'responses', capabilities: { hostedSearch: false, reasoning: true } }, settings: { webAccess: true, effort: 'high', capabilities: { reasoning: false }, writableRoots: [options.cwd], toolAllowlist: ['exec_command'] } })).text);
  assert.ok(audit.argv.includes('web_search="disabled"'));
  assert.ok(audit.argv.includes(`sandbox_workspace_write.writable_roots=${JSON.stringify([options.cwd])}`));
  assert.equal(audit.params.effort, 'high');
});

test('fresh agent context rejects known capacity overflow before startup and marks the estimate', async t => {
  const { runAgentTask, options, homes } = await fixture(t);
  for (const patch of [{ prompt: 'x'.repeat(10000) }, { developerInstructions: 'x'.repeat(10000) }]) {
    await assert.rejects(runAgentTask({ ...options, connection: { ...connection, contextWindow: 6000 }, ...patch }), /estimated.*capacity|capacity.*estimate/i);
    assert.deepEqual(await readdir(homes), []);
  }
  const unknown = { ...connection }; delete unknown.contextWindow;
  assert.equal((await runAgentTask({ ...options, connection: unknown })).threadId, 'thread-1');
});

test('Web Off omits MCP servers; computer Off retains only classified noncomputer tools', async t => {
  const { runAgentTask, options } = await fixture(t);
  const mcp = { mixed: 'https://tools.example.test/mcp', unknown: 'https://unknown.example.test/mcp', computer: 'https://computer.example.test/mcp' };
  const offline = JSON.parse((await runAgentTask({ ...options, settings: { mcp } })).text);
  assert.ok(!offline.argv.some(value => value.startsWith('mcp_servers.')));
  const filtered = JSON.parse((await runAgentTask({ ...options, settings: { webAccess: true, computerUse: false, mcp, computerServers: ['computer'], disabledComputerTools: { mixed: ['browser_click'] } } })).text);
  assert.ok(filtered.argv.includes('mcp_servers.mixed.disabled_tools=["browser_click"]'));
  assert.ok(filtered.argv.some(value => value.startsWith('mcp_servers.mixed.url=')));
  assert.ok(!filtered.argv.some(value => /^mcp_servers\.(unknown|computer)\./.test(value)));
  assert.equal(filtered.thread.config['sandbox_workspace_write.network_access'], true);
});

test('explicit unrestricted permissions remain opt-in and invalid options fail before startup', async t => {
  const { runAgentTask, options, homes } = await fixture(t);
  const audit = JSON.parse((await runAgentTask({ ...options, settings: { permissions: 'allow-everything', scope: 'full', webAccess: true } })).text);
  assert.equal(audit.thread.sandbox, 'danger-full-access');
  assert.equal(audit.thread.approvalPolicy, 'never');
  for (const settings of [{ permissions: 'unknown-secret-permission' }, { webAccess: 'on' }, { effort: 'low' }, { mcp: { 'invalid.name': 'https://example.test/mcp' } }, { mcp: { server: 'https://key-secret@example.test/mcp' } }]) {
    await assert.rejects(runAgentTask({ ...options, settings }), error => !/unknown-secret|key-secret/.test(error.message));
    assert.deepEqual(await readdir(homes), []);
  }
});

test('native startup failures and task failures always clean the owned session home', async t => {
  const { runAgentTask, options, homes } = await fixture(t);
  for (const scenario of ['bad-thread', 'failed-turn', 'exit-turn']) {
    await assert.rejects(runAgentTask({ ...options, runtime: { ...options.runtime, codexPath: [process.execPath, engineFixture, scenario] } }));
    assert.deepEqual(await readdir(homes), []);
  }
});

test('abort interrupts active native work and rejects only after owned resources are cleaned', async t => {
  const { runAgentTask, options, homes } = await fixture(t, 'hang-turn');
  const controller = new AbortController();
  await assert.rejects(runAgentTask({ ...options, signal: controller.signal, onEvent: event => { if (event.method === 'turn/started') controller.abort(); } }), { name: 'AbortError' });
  assert.deepEqual(await readdir(homes), []);
  const preaborted = new AbortController(); preaborted.abort();
  await assert.rejects(runAgentTask({ ...options, signal: preaborted.signal }), { name: 'AbortError' });
  assert.deepEqual(await readdir(homes), []);
});

test('aborting during hung native startup closes the child before cleaning its home', async t => {
  const { runAgentTask, options, homes } = await fixture(t, 'hang-startup');
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 80);
  t.after(() => clearTimeout(timer));
  await assert.rejects(runAgentTask({ ...options, signal: controller.signal }), { name: 'AbortError' });
  assert.deepEqual(await readdir(homes), []);
});

test('GPU hook performs authenticated wake/sleep POSTs without returning remote body content', async t => {
  const { gpuHook } = await fixture(t);
  const requests = [];
  const url = await httpFixture(t, async (req, res) => {
    let body = ''; for await (const chunk of req) body += chunk;
    requests.push({ method: req.method, auth: req.headers.authorization, body: JSON.parse(body) });
    res.writeHead(200, { 'content-type': 'application/json' }); res.end('{"private":"do-not-return"}');
  });
  assert.deepEqual(await gpuHook({ url, apiKey: 'gpu-private-key' }), { ok: true, status: 200, verified: false, state: 'unknown', billing: 'unknown' });
  assert.deepEqual(await gpuHook({ url, action: 'sleep' }), { ok: true, status: 200, verified: false, state: 'unknown', billing: 'unknown' });
  assert.deepEqual(requests, [{ method: 'POST', auth: 'Bearer gpu-private-key', body: { action: 'wake' } }, { method: 'POST', auth: undefined, body: { action: 'sleep' } }]);
});

test('GPU hook refuses remote plaintext, embedded credentials and redirects without leaking secrets', async t => {
  const { gpuHook } = await fixture(t);
  for (const url of ['http://example.test/wake', 'https://private-key@example.test/wake', 'https://example.test/wake?key=private-key', 'https://example.test/wake#private-key']) await assert.rejects(gpuHook({ url }), error => !error.message.includes('private-key'));
  let reachedTarget = false;
  const target = await httpFixture(t, (_, res) => { reachedTarget = true; res.end('target'); });
  const redirect = await httpFixture(t, (_, res) => { res.writeHead(307, { location: target }); res.end(); });
  await assert.rejects(gpuHook({ url: redirect, apiKey: 'private-key' }), error => !error.message.includes('private-key'));
  assert.equal(reachedTarget, false);
});

test('GPU hook bounds response bytes, request time and cancellation', async t => {
  const { gpuHook } = await fixture(t);
  const oversized = await httpFixture(t, (_, res) => res.end('x'.repeat(65537)));
  await assert.rejects(gpuHook({ url: oversized }), /limit|large|GPU/i);
  const hanging = await httpFixture(t, () => {});
  await assert.rejects(gpuHook({ url: hanging, timeoutMs: 20 }), /timeout|GPU/i);
  const controller = new AbortController(); controller.abort();
  await assert.rejects(gpuHook({ url: hanging, signal: controller.signal }), { name: 'AbortError' });
});

test('agent runtime uses real native Codex workspace tools through a loopback model fixture', { timeout: 45000 }, async t => {
  const { localCodex } = await import('../src/local-engine.mjs');
  let codexPath; try { codexPath = localCodex(); } catch { t.skip('Install the native Codex runtime'); return; }
  const { runAgentTask, options, homes } = await fixture(t);
  const requests = [];
  const url = await httpFixture(t, async (req, res) => {
    let raw = ''; for await (const chunk of req) raw += chunk;
    const body = JSON.parse(raw); requests.push(body);
    const tool = body.messages.findLast(message => message.role === 'tool');
    const message = tool ? { role: 'assistant', content: 'Native agent task finished.' } : {
      role: 'assistant', content: null, tool_calls: [{ id: 'agent-proof-call', type: 'function', function: { name: 'exec_command', arguments: JSON.stringify({ cmd: process.platform === 'win32' ? "Set-Content -LiteralPath agent-proof.txt -Value 'native runtime proof'" : "printf 'native runtime proof\\n' > agent-proof.txt", workdir: options.cwd, login: false, max_output_tokens: 1000 }) } }],
    };
    res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify({ id: 'chatcmpl-agent', object: 'chat.completion', model: connection.model, choices: [{ index: 0, message, finish_reason: tool ? 'stop' : 'tool_calls' }] }));
  });
  const result = await runAgentTask({ ...options, settings: { scope: 'full', webAccess: true }, connection: { ...connection, baseUrl: `${url}/v1` }, developerInstructions: 'Use the native workspace tools.', runtime: { ...options.runtime, codexPath, requestTimeoutMs: 10000 }, onApproval: async ({ method, params }) => method === 'item/commandExecution/requestApproval' && String(params.command).includes('agent-proof.txt') });
  assert.match(result.text, /Native agent task finished/);
  assert.match(await readFile(join(options.cwd, 'agent-proof.txt'), 'utf8'), /native runtime proof/);
  assert.equal(requests.length, 2);
  assert.equal(requests[0].reasoning_effort, undefined);
  assert.ok(requests[0].tools.some(tool => tool.function?.name === 'exec_command'));
  assert.ok(JSON.stringify(requests[0].messages).includes('Use the native workspace tools.'));
  assert.deepEqual(await readdir(homes), []);
});

test('native Responses agent tasks use the selected API key and redact final output', { timeout: 45000 }, async t => {
  const { localCodex } = await import('../src/local-engine.mjs');
  let codexPath; try { codexPath = localCodex(); } catch { t.skip('Install the native Codex runtime'); return; }
  const { runAgentTask, options, homes } = await fixture(t);
  const requests = [];
  const url = await httpFixture(t, async (req, res) => {
    let raw = ''; for await (const chunk of req) raw += chunk;
    requests.push({ path: req.url, auth: req.headers.authorization, body: JSON.parse(raw) });
    const text = `Native response ${connection.apiKey} done.`;
    const item = { type: 'message', id: 'response-item', role: 'assistant', content: [{ type: 'output_text', text, annotations: [] }] };
    const events = [
      { type: 'response.created', response: { id: 'agent-response', status: 'in_progress', output: [] } },
      { type: 'response.output_item.added', output_index: 0, item: { ...item, content: [] } },
      { type: 'response.output_text.delta', item_id: item.id, output_index: 0, content_index: 0, delta: text },
      { type: 'response.output_item.done', output_index: 0, item },
      { type: 'response.completed', response: { id: 'agent-response', status: 'completed', output: [item], usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 } } },
    ];
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    for (const event of events) res.write(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`);
    res.end();
  });
  const result = await runAgentTask({ ...options, connection: { ...connection, transport: 'responses', baseUrl: `${url}/v1` }, runtime: { ...options.runtime, codexPath, requestTimeoutMs: 10000 } });
  assert.equal(requests.length, 1);
  assert.equal(requests[0].path, '/v1/responses');
  assert.equal(requests[0].auth, `Bearer ${connection.apiKey}`);
  assert.match(result.text, /Native response \[redacted\] done/);
  assert.ok(!result.text.includes(connection.apiKey));
  assert.deepEqual(await readdir(homes), []);
});

test('background native tasks enforce tools-off and exact allowlists before executable output', { timeout: 30000 }, async t => {
  const { localCodex } = await import('../src/local-engine.mjs');
  let codexPath; try { codexPath = localCodex(); } catch { t.skip('Install the native Codex runtime'); return; }
  const { runAgentTask, options, homes } = await fixture(t);
  for (const mode of ['chat-off', 'chat-list', 'responses-off']) {
    const requests = [], executable = [];
    const url = await httpFixture(t, async (req, res) => {
      let raw = ''; for await (const chunk of req) raw += chunk; requests.push(JSON.parse(raw));
      res.writeHead(200, { 'content-type': 'application/json' });
      const item = { type: 'function_call', id: 'rogue', call_id: 'c', name: 'rogue_outside_permission', arguments: '{}' };
      res.end(mode === 'responses-off' ? JSON.stringify({ object: 'response', status: 'completed', output: [item] }) : JSON.stringify({ choices: [{ message: { role: 'assistant', content: null, tool_calls: [{ id: 'c', type: 'function', function: { name: item.name, arguments: '{}' } }] }, finish_reason: 'tool_calls' }] }));
    });
    await assert.rejects(runAgentTask({ ...options, connection: { ...connection, baseUrl: `${url}/v1`, transport: mode === 'responses-off' ? 'responses' : 'chat-completions', capabilities: { tools: mode === 'chat-list' } }, settings: mode === 'chat-list' ? { toolAllowlist: ['exec_command'] } : {}, runtime: { ...options.runtime, codexPath, requestTimeoutMs: 10000 }, onEvent: event => { if (event.method === 'item/completed' && ['commandExecution', 'fileChange', 'mcpToolCall'].includes(event.params?.item?.type)) executable.push(event); } }), { code: 'APPROVAL_REQUIRED' });
    assert.equal(requests.length, 1, 'the policy error interrupts before a charged native retry');
    if (mode === 'chat-list') assert.deepEqual(requests[0].tools.map(tool => tool.function.name), ['exec_command']);
    else assert.ok(!Object.hasOwn(requests[0], 'tools'));
    assert.deepEqual(executable, []);
    assert.deepEqual(await readdir(homes), []);
  }
});
