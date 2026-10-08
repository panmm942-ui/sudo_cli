import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { spawn } from 'node:child_process';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { localCodex } from '../src/local-engine.mjs';
import { startBridge } from '../src/bridge.mjs';
import { createEngine } from '../src/engine.mjs';
import { providerArgs, createSessionHome } from '../src/runtime.mjs';

test('actual Codex app-server runs a sudo cli task through the compatibility bridge', { timeout: 45000 }, async (t) => {
  let enginePath;
  try { enginePath = localCodex(); } catch { t.skip('Install Codex engine to run its real integration'); return; }
  const workspace = await mkdtemp(join(tmpdir(), 'sudo-cli-e2e-'));
  const requests = [];
  const server = createServer(async (req, res) => {
    let body = '';
    for await (const chunk of req) body += chunk;
    requests.push({ path: req.url, body: JSON.parse(body), authorization: req.headers.authorization });
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ id: 'chatcmpl-local-fixture', object: 'chat.completion', created: 1, model: 'fixture-model', choices: [{ index: 0, message: { role: 'assistant', content: 'sudo cli integration verified' }, finish_reason: 'stop' }], usage: { prompt_tokens: 50, completion_tokens: 5, total_tokens: 55 } }));
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  let child;
  t.after(async () => { child?.kill(); server.closeAllConnections(); await new Promise(r => server.close(r)); await rm(workspace, { recursive: true, force: true }); });
  child = spawn(process.execPath, [fileURLToPath(new URL('../bin/sudo-cli.mjs', import.meta.url)), '--once', 'Reply with the integration confirmation.', '--model', 'fixture-model', '--base-url', `http://127.0.0.1:${server.address().port}/v1`, '--cwd', workspace], {
    env: { ...process.env, SUDO_CLI_CODEX: enginePath, SUDO_CLI_API_KEY: 'test-key-not-real', NO_COLOR: '1' }, shell: false, windowsHide: true,
  });
  let stdout = '', stderr = '';
  child.stdout.on('data', chunk => stdout += chunk);
  child.stderr.on('data', chunk => stderr += chunk);
  const [code] = await once(child, 'exit');
  assert.equal(code, 0, stderr);
  assert.match(stdout, /sudo cli integration verified/);
  assert.doesNotMatch(stdout + stderr, /test-key-not-real/);
  assert.equal(requests.length, 1);
  assert.equal(requests[0].path, '/v1/chat/completions');
  assert.equal(requests[0].authorization, 'Bearer test-key-not-real');
  assert.equal(requests[0].body.model, 'fixture-model');
  assert.ok(requests[0].body.messages.some(msg => typeof msg.content === 'string' && msg.content.includes('integration confirmation')));
  assert.ok(requests[0].body.tools.length > 0, 'The real engine must expose execution tools');
});

test('actual Codex engine executes a model tool call inside the selected workspace', { timeout: 45000 }, async (t) => {
  let enginePath;
  try { enginePath = localCodex(); } catch { t.skip('Install Codex engine to run its real integration'); return; }
  const workspace = await mkdtemp(join(tmpdir(), 'sudo-cli-tool-e2e-'));
  const requests = [];
  const server = createServer(async (req, res) => {
    let raw = '';
    for await (const chunk of req) raw += chunk;
    const body = JSON.parse(raw);
    requests.push(body);
    const tool = body.messages.findLast(msg => msg.role === 'tool');
    const message = tool ? { role: 'assistant', content: 'Workspace file created.' } : {
      role: 'assistant', content: null, tool_calls: [{ id: 'call_workspace_test', type: 'function', function: {
        name: 'exec_command', arguments: JSON.stringify({
          cmd: process.platform === 'win32' ? "Set-Content -LiteralPath proof.txt -Value 'sudo tool verified'" : "printf 'sudo tool verified\\n' > proof.txt",
          workdir: workspace, login: false, max_output_tokens: 1000,
        }),
      } }],
    };
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ id: `chatcmpl-tool-${requests.length}`, object: 'chat.completion', created: 1, model: 'fixture-model', choices: [{ index: 0, message, finish_reason: tool ? 'stop' : 'tool_calls' }] }));
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const home = await createSessionHome();
  let engine, bridge;
  t.after(async () => { await engine?.close(); await bridge?.close(); server.closeAllConnections(); await new Promise(r => server.close(r)); await home.cleanup(); await rm(workspace, { recursive: true, force: true }); });
  const connection = { model: 'fixture-model', baseUrl: `http://127.0.0.1:${server.address().port}/v1`, transport: 'chat-completions' };
  bridge = await startBridge(connection);
  const approvals = [];
  engine = await createEngine({ codexPath: enginePath, cwd: workspace, model: connection.model,
    providerArgs: providerArgs(connection, { baseUrl: bridge.baseUrl }),
    env: { ...process.env, CODEX_HOME: home.path, SUDO_CLI_SESSION_KEY: bridge.token },
    onApproval: async ({ method, params }) => {
      approvals.push({ method, command: params.command });
      // This local fixture is explicitly allowed to perform only its known workspace write.
      return method === 'item/commandExecution/requestApproval' && String(params.command).includes('proof.txt') && String(params.command).includes('sudo tool verified');
    },
  });
  const completed = await engine.startTurn('Create proof.txt in this workspace.');
  assert.equal(completed.status, 'completed');
  assert.equal(requests.length, 2);
  assert.ok(completed.items.some(item => item.type === 'agentMessage' && item.text.includes('Workspace file created')));
  const proof = await readFile(join(workspace, 'proof.txt'), 'utf8').catch(error => { throw new Error(`${error.code}: ${JSON.stringify(requests[1].messages.filter(msg => msg.role === 'tool'))}`); });
  assert.match(proof, /sudo tool verified/);
  assert.ok(requests[1].messages.some(msg => msg.role === 'tool' && msg.tool_call_id === 'call_workspace_test'));
});

test('native Responses stream passes through the real engine with split credentials redacted', { timeout: 45000 }, async (t) => {
  let enginePath;
  try { enginePath = localCodex(); } catch { t.skip('Install Codex engine to run its real integration'); return; }
  const workspace = await mkdtemp(join(tmpdir(), 'sudo-cli-responses-e2e-'));
  const key = 'fixture-stream-key-do-not-print';
  const requests = [];
  const server = createServer(async (req, res) => {
    let raw = '';
    for await (const chunk of req) raw += chunk;
    requests.push({ path: req.url, body: JSON.parse(raw), auth: req.headers.authorization });
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    const content = `Native stream ${key} verified.`;
    const item = { type: 'message', id: 'msg_native', role: 'assistant', content: [{ type: 'output_text', text: content, annotations: [] }] };
    const events = [
      { type: 'response.created', response: { id: 'resp_native', status: 'in_progress', output: [] } },
      { type: 'response.output_item.added', output_index: 0, item: { ...item, content: [] } },
      ...['Native stream fixture-stream-', 'key-do-not-print verified.'].map(delta => ({ type: 'response.output_text.delta', item_id: item.id, output_index: 0, content_index: 0, delta })),
      { type: 'response.output_item.done', output_index: 0, item },
      { type: 'response.completed', response: { id: 'resp_native', status: 'completed', output: [item], usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 } } },
    ];
    for (const event of events) res.write(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`);
    res.end();
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  let child;
  t.after(async () => { child?.kill(); server.closeAllConnections(); await new Promise(r => server.close(r)); await rm(workspace, { recursive: true, force: true }); });
  child = spawn(process.execPath, [fileURLToPath(new URL('../bin/sudo-cli.mjs', import.meta.url)), '--once', 'Test the native stream.', '--model', 'fixture-model', '--transport', 'responses', '--base-url', `http://127.0.0.1:${server.address().port}/v1`, '--cwd', workspace], {
    env: { ...process.env, SUDO_CLI_CODEX: enginePath, SUDO_CLI_API_KEY: key, NO_COLOR: '1' }, shell: false, windowsHide: true,
  });
  let stdout = '', stderr = '';
  child.stdout.on('data', chunk => stdout += chunk);
  child.stderr.on('data', chunk => stderr += chunk);
  const [code] = await once(child, 'exit');
  assert.equal(code, 0, stderr);
  assert.match(stdout, /Native stream \[redacted\] verified\./);
  assert.doesNotMatch(stdout + stderr, /fixture-stream-key-do-not-print/);
  assert.equal(requests.length, 1);
  assert.equal(requests[0].path, '/v1/responses');
  assert.equal(requests[0].auth, `Bearer ${key}`);
});
