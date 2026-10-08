import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { setTimeout as delay } from 'node:timers/promises';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startBridge } from '../src/bridge.mjs';
import { createEngine } from '../src/engine.mjs';
import { localCodex } from '../src/local-engine.mjs';
import { createSessionHome, providerArgs } from '../src/runtime.mjs';

test('native Codex receives incremental Chat deltas before upstream finishes', { timeout: 20000 }, async t => {
  let executable; try { executable = localCodex(); } catch { t.skip('A native Codex runtime is required.'); return; }
  const workspace = await mkdtemp(join(tmpdir(), 'codexcli-stream-'));
  const home = await createSessionHome();
  let engine, bridge, upstreamCompleted = false, observedBeforeCompletion = false, release;
  const visibleDelta = new Promise(resolve => { release = resolve; });
  const requests = [];
  const server = createServer(async (req, res) => {
    let source = ''; for await (const chunk of req) source += chunk;
    requests.push(JSON.parse(source));
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    res.write('data: {"choices":[{"index":0,"delta":{"role":"assistant","content":"First "},"finish_reason":null}]}\n\n');
    await Promise.race([visibleDelta, delay(2000)]);
    upstreamCompleted = true;
    res.end('data: {"choices":[{"index":0,"delta":{"content":"second"},"finish_reason":"stop"}]}\n\ndata: {"choices":[],"usage":{"prompt_tokens":3,"completion_tokens":2,"total_tokens":5}}\n\ndata: [DONE]\n\n');
  }).listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(async () => { release(); await engine?.close(); await bridge?.close(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); await home.cleanup(); await rm(workspace, { recursive: true, force: true }); });
  const connection = { model: 'fixture-stream', transport: 'chat-completions', baseUrl: `http://127.0.0.1:${server.address().port}/v1` };
  bridge = await startBridge(connection);
  engine = await createEngine({ codexPath: executable, cwd: workspace, model: connection.model, providerArgs: providerArgs(connection, { baseUrl: bridge.baseUrl }), env: { ...process.env, CODEX_HOME: home.path, SUDO_CLI_SESSION_KEY: bridge.token }, onEvent: event => {
    if (event.method === 'item/agentMessage/delta' && event.params?.delta?.includes('First')) { observedBeforeCompletion = !upstreamCompleted; release(); }
  } });
  const result = await engine.startTurn('Reply with the streaming fixture.');
  assert.equal(result.status, 'completed');
  assert.equal(observedBeforeCompletion, true, 'The native user-facing delta must arrive before upstream completion');
  assert.ok(result.items.some(item => item.type === 'agentMessage' && item.text === 'First second'));
  assert.equal(requests[0].stream, true);
});
