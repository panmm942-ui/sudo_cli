import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';

async function api() {
  const module = await import('../src/provider-capabilities.mjs').catch(() => ({}));
  assert.equal(typeof module.capabilityReport, 'function', 'capability evidence API must exist');
  return module;
}
const connection = { model: 'gpt-special-vision-tool-model', baseUrl: 'http://127.0.0.1:1234/v1', transport: 'chat-completions' };

test('model names do not imply capability support and declarations remain distinct from observations', async () => {
  const { capabilityReport } = await api();
  const report = capabilityReport(connection, { declared: { tools: true, vision: false }, observed: { streaming: true, tools: false } });
  assert.equal(report.capabilities.reasoning.state, 'unknown');
  assert.equal(report.capabilities.reasoning.supported, null);
  assert.equal(report.capabilities.vision.state, 'declared');
  assert.equal(report.capabilities.tools.state, 'observed');
  assert.equal(report.capabilities.tools.supported, false);
  assert.equal(report.capabilities.tools.declared, true);
  assert.equal(report.capabilities.tools.observed, false);
  assert.equal(report.contextWindow.state, 'unknown');
  assert.equal(report.capabilities.training.state, 'unknown');
  assert.equal(capabilityReport(connection, { declared: { hostedSearch: false, training: true } }).capabilities.hostedSearch.supported, false);
  assert.equal(capabilityReport(connection, { declared: { training: true } }).capabilities.training.state, 'declared');
});

test('explicit catalog discovery uses only GET and reports no generation capabilities', async t => {
  const { discoverModels, probeConnection } = await api();
  const requests = [];
  const server = createServer((req, res) => { requests.push([req.method, req.url]); res.end(JSON.stringify({ data: [{ id: 'first' }, { id: 'second' }] })); }).listen(0, '127.0.0.1');
  await once(server, 'listening'); t.after(() => { server.closeAllConnections(); server.close(); });
  const config = { ...connection, baseUrl: `http://127.0.0.1:${server.address().port}/v1` };
  assert.deepEqual((await discoverModels(config)).models, ['first', 'second']);
  const probe = await probeConnection(config);
  assert.equal(probe.ok, true);
  assert.equal(probe.capabilities.capabilities.streaming.state, 'unknown');
  assert.deepEqual(requests, [['GET', '/v1/models'], ['GET', '/v1/models']]);
});

test('catalog failures and timeouts do not disclose response bodies or credentials', async t => {
  const { discoverModels } = await api();
  const server = createServer((req, res) => { if (req.url.startsWith('/wait/')) return; res.writeHead(401); res.end('secret-fixture private-body'); }).listen(0, '127.0.0.1');
  await once(server, 'listening'); t.after(() => { server.closeAllConnections(); server.close(); });
  const config = { ...connection, apiKey: 'secret-fixture', baseUrl: `http://127.0.0.1:${server.address().port}/v1` };
  const failed = await discoverModels(config);
  assert.equal(failed.status, 'authentication-required');
  assert.doesNotMatch(JSON.stringify(failed), /secret-fixture|private-body/);
  const timeout = await discoverModels({ ...config, baseUrl: `http://127.0.0.1:${server.address().port}/wait` }, { timeoutMs: 40 });
  assert.equal(timeout.status, 'timeout');
});

test('invalid and oversized catalogs cannot become capability evidence', async t => {
  const { discoverModels } = await api();
  const server = createServer((_req, res) => res.end(JSON.stringify({ data: [{ id: 'secret-fixture' }, { id: 'okay' }], vision: true }))).listen(0, '127.0.0.1');
  await once(server, 'listening'); t.after(() => { server.closeAllConnections(); server.close(); });
  const result = await discoverModels({ ...connection, apiKey: 'secret-fixture', baseUrl: `http://127.0.0.1:${server.address().port}/v1` });
  assert.deepEqual(result.models, ['okay']);
  assert.doesNotMatch(JSON.stringify(result), /secret-fixture/);
});

test('native tool allowlists distinguish declared namespaces and deny ambiguous identifier collisions', async () => {
  const { createToolPolicy } = await api();
  const tools = ['first', 'second'].map(name => ({ type: 'namespace', name, tools: [{ type: 'function', name: 'run' }] }));
  const policy = createToolPolicy({ toolAllowlist: ['first.run'] });
  const request = policy.filterRequest({ tools, tool_choice: { type: 'function', namespace: 'second', name: 'run' } });
  assert.deepEqual(policy.getToolCatalog(), ['first.run', 'second.run']);
  assert.deepEqual(request.tools, [tools[0]]);
  assert.ok(!Object.hasOwn(request, 'tool_choice'));
  policy.assertItem({ type: 'function_call', namespace: 'first', name: 'run' });
  for (const namespace of ['second', undefined]) assert.throws(() => policy.assertItem({ type: 'function_call', namespace, name: 'run' }), { code: 'TOOL_NOT_ALLOWED' });
  const ambiguous = createToolPolicy({ toolAllowlist: ['first.run'] });
  assert.ok(!Object.hasOwn(ambiguous.filterRequest({ tools: [...tools, { type: 'function', name: 'first.run' }] }), 'tools'));
  assert.throws(() => ambiguous.assertItem({ type: 'function_call', namespace: 'first', name: 'run' }), { code: 'TOOL_NOT_ALLOWED' });
});
