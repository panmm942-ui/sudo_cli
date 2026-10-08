import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';

async function localCatalog(t, { status = 200, data = [{ id: 'already-installed-model' }] } = {}) {
  const requests = [];
  const server = createServer((request, response) => {
    requests.push({ path: request.url, authorization: request.headers.authorization });
    response.writeHead(status, { 'content-type': 'application/json' });
    response.end(JSON.stringify({ data }));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => { server.close(resolve); server.closeAllConnections(); }));
  return { baseUrl: `http://127.0.0.1:${server.address().port}/v1`, requests };
}

function answersFor(values, calls) {
  return async (prompt, hidden) => {
    calls.push({ prompt, hidden });
    assert.ok(values.length, `Unexpected prompt: ${prompt}`);
    return values.shift();
  };
}

test('initial launch uses flags/environment in memory without prompting for existing settings', async () => {
  const { configureConnection } = await import('../src/wizard.mjs');
  const result = await configureConnection({ opts: { model: 'model-a', baseUrl: 'http://127.0.0.1:3000/v1', transport: 'responses' }, env: { SUDO_CLI_API_KEY: 'test-only-key' }, interactive: true, ask: () => { throw new Error('Unexpected prompt'); } });
  assert.equal(result.model, 'model-a');
  assert.equal(result.apiKey, 'test-only-key');
});

test('explicit reconnect asks for every setting even when launch flags and environment exist', async () => {
  const { configureConnection } = await import('../src/wizard.mjs');
  const answers = ['new-model', 'https://new.example/v1', '2', 'new-test-key'];
  const calls = [];
  const result = await configureConnection({ opts: { model: 'old-model', baseUrl: 'https://old.example/v1', transport: 'chat-completions', apiKeyEnv: 'OLD_KEY' }, env: { OLD_KEY: 'old-key', SUDO_CLI_API_KEY: 'other-old-key' }, interactive: true, refresh: true, ask: async (prompt, hidden) => { calls.push({ prompt, hidden }); return answers.shift(); } });
  assert.equal(result.model, 'new-model');
  assert.equal(result.baseUrl, 'https://new.example/v1');
  assert.equal(result.transport, 'responses');
  assert.equal(result.apiKey, 'new-test-key');
  assert.equal(calls.length, 4);
  assert.equal(calls.at(-1).hidden, true);
});

test('keyless interactive endpoint retains no API key', async () => {
  const { configureConnection } = await import('../src/wizard.mjs');
  const answers = ['model', 'http://127.0.0.1:3000/v1', '', ''];
  const result = await configureConnection({ opts: {}, env: {}, interactive: true, ask: async () => answers.shift() });
  assert.equal(result.transport, 'chat-completions');
  assert.equal(result.apiKey, undefined);
});

test('invalid wizard fields are reported and retried before requesting a hidden key', async () => {
  const { configureConnection } = await import('../src/wizard.mjs');
  const answers = ['', 'valid-model', 'https://user:secret@example.com/v1', 'http://127.0.0.1:3000/v1', 'bad-format', '1', ''];
  const reports = [];
  const result = await configureConnection({ opts: {}, env: {}, interactive: true, ask: async () => answers.shift(), report: message => reports.push(message) });
  assert.equal(result.model, 'valid-model');
  assert.equal(reports.length, 3);
  assert.doesNotMatch(reports.join(''), /secret/);
});

test('guided local AI uses the running catalog without asking for a key or inheriting cloud settings', async t => {
  const { configureConnection } = await import('../src/wizard.mjs');
  const fixture = await localCatalog(t), calls = [], reports = [];
  const result = await configureConnection({ opts: {}, env: { SUDO_CLI_MODEL: 'inherited-cloud-model', SUDO_CLI_API_KEY: 'unrelated-cloud-key', SUDO_CLI_TRANSPORT: 'responses', SUDO_CLI_BASE_URL: 'https://cloud.example/v1' }, guided: true, interactive: true,
    ask: answersFor(['2', '1', fixture.baseUrl, '', '1', ''], calls), report: value => reports.push(value) });
  assert.equal(result.model, 'already-installed-model');
  assert.equal(result.baseUrl, fixture.baseUrl);
  assert.equal(result.transport, 'chat-completions');
  assert.equal(result.apiKey, undefined);
  assert.equal(calls.some(call => call.hidden), false);
  assert.equal(fixture.requests[0].path, '/v1/models');
  assert.equal(fixture.requests[0].authorization, undefined);
  assert.match(calls[0].prompt, /Local AI on this PC/);
  assert.ok(reports.some(value => value.includes('already-installed-model')));
});

test('explicit local setup ignores launch cloud settings and supports a custom loopback server', async t => {
  const { configureConnection } = await import('../src/wizard.mjs');
  const fixture = await localCatalog(t), calls = [];
  const result = await configureConnection({ opts: { model: 'old-cloud-model', baseUrl: 'https://cloud.example/v1', apiKeyEnv: 'CLOUD_KEY', contextWindow: 65536 }, env: { SUDO_CLI_MODEL: 'another-cloud-model', CLOUD_KEY: 'cloud-secret', SUDO_CLI_API_KEY: 'other-cloud-secret' }, forceLocal: true, interactive: true,
    ask: answersFor(['3', fixture.baseUrl, '', '1', '8192'], calls) });
  assert.equal(result.model, 'already-installed-model');
  assert.equal(result.baseUrl, fixture.baseUrl);
  assert.equal(result.contextWindow, 8192);
  assert.equal(result.apiKey, undefined);
  assert.equal(result.apiKeyEnv, undefined);
  assert.equal(calls.some(call => call.hidden), false);
});

test('local setup rejects remote and credential-bearing URLs before discovery', async t => {
  const { configureConnection } = await import('../src/wizard.mjs');
  const fixture = await localCatalog(t), calls = [], reports = [];
  const result = await configureConnection({ opts: {}, env: {}, forceLocal: true, interactive: true,
    ask: answersFor(['3', 'https://remote.example/v1', 'http://user:private-secret@localhost:1234/v1', fixture.baseUrl, '', '1', ''], calls), report: value => reports.push(value) });
  assert.equal(result.baseUrl, fixture.baseUrl);
  assert.ok(reports.some(value => /localhost|127\.0\.0\.1/.test(value)));
  assert.doesNotMatch(reports.join('\n'), /private-secret/);
  assert.equal(fixture.requests.length, 1);
});

test('unavailable local catalog explains how to run the server and accepts an exact installed model ID', async t => {
  const { configureConnection } = await import('../src/wizard.mjs');
  const fixture = await localCatalog(t, { status: 503 }), calls = [], reports = [];
  const result = await configureConnection({ opts: {}, env: {}, forceLocal: true, interactive: true,
    ask: answersFor(['1', fixture.baseUrl, '', 'my-installed-model', ''], calls), report: value => reports.push(value) });
  assert.equal(result.model, 'my-installed-model');
  assert.ok(reports.some(value => /ollama serve/.test(value)));
  assert.ok(reports.some(value => /catalog unavailable/i.test(value)));
  assert.equal(calls.some(call => call.hidden), false);
});

test('local authentication is only requested after an explicit opt-in and is used for catalog discovery', async t => {
  const { configureConnection } = await import('../src/wizard.mjs');
  const fixture = await localCatalog(t), calls = [];
  const result = await configureConnection({ opts: {}, env: { SUDO_CLI_API_KEY: 'unrelated-cloud-key' }, forceLocal: true, interactive: true,
    ask: answersFor(['2', fixture.baseUrl, 'yes', 'local-server-key', '1', ''], calls) });
  assert.equal(result.apiKey, 'local-server-key');
  assert.equal(fixture.requests[0].authorization, 'Bearer local-server-key');
  assert.equal(calls.filter(call => call.hidden).length, 1);
});

test('saved loopback AI does not receive an unrelated cloud key', async () => {
  const { configureConnection } = await import('../src/wizard.mjs');
  const calls = [];
  const result = await configureConnection({ opts: {}, env: { SUDO_CLI_API_KEY: 'unrelated-cloud-key' }, guided: true, interactive: true,
    preset: { model: 'saved-local', baseUrl: 'http://localhost:1234/v1', transport: 'chat-completions', contextWindow: 4096 }, ask: answersFor(['3', ''], calls) });
  assert.equal(result.model, 'saved-local');
  assert.equal(result.apiKey, undefined);
  assert.equal(calls.some(call => call.hidden), false);
});

test('a stopped local server still gives clear startup instructions and does not request a cloud key', async () => {
  const { configureConnection } = await import('../src/wizard.mjs');
  const server = createServer();
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const baseUrl = `http://127.0.0.1:${server.address().port}/v1`;
  await new Promise(resolve => server.close(resolve));
  const calls = [], reports = [];
  const result = await configureConnection({ opts: {}, env: { SUDO_CLI_API_KEY: 'cloud-secret' }, forceLocal: true, interactive: true,
    ask: answersFor(['2', baseUrl, '', 'my-loaded-model', ''], calls), report: value => reports.push(value) });
  assert.equal(result.apiKey, undefined);
  assert.equal(result.model, 'my-loaded-model');
  assert.ok(reports.some(value => /start its Local Server/.test(value)));
  assert.ok(reports.some(value => /catalog unavailable/i.test(value)));
  assert.equal(calls.some(call => call.hidden), false);
});

test('explicit reconnect does not carry the previous model context capacity into a new AI', async () => {
  const { configureConnection } = await import('../src/wizard.mjs');
  const calls = [];
  const result = await configureConnection({ opts: { model: 'old', baseUrl: 'https://old.example/v1', contextWindow: 128000 }, env: {}, refresh: true, guided: true, interactive: true,
    ask: answersFor(['1', 'new', 'https://new.example/v1', '1', '', ''], calls) });
  assert.equal(result.contextWindow, undefined);
  assert.ok(calls.some(call => /context capacity/.test(call.prompt)));
});

test('last AI preserves explicit capability and effort metadata', async () => {
  const { configureConnection } = await import('../src/wizard.mjs');
  const calls = [];
  const result = await configureConnection({ opts: {}, env: {}, guided: true, interactive: true,
    preset: { model: 'saved', baseUrl: 'http://localhost:8000/v1', transport: 'responses', contextWindow: 65536, capabilities: { reasoning: true, tools: false }, supportedEfforts: ['low', 'high'] },
    ask: answersFor(['3', ''], calls) });
  assert.deepEqual(result.capabilities, { reasoning: true, tools: false });
  assert.deepEqual(result.supportedEfforts, ['low', 'high']);
  assert.equal(result.contextWindow, 65536);
});

test('local endpoint classification accepts normalized loopback only', async () => {
  const { isLocalEndpoint } = await import('../src/wizard.mjs');
  for (const baseUrl of ['http://localhost:8000/v1', 'http://127.0.0.2:8000/v1', 'http://[::1]:8000/v1']) assert.equal(isLocalEndpoint({ baseUrl }), true);
  for (const baseUrl of ['http://0.0.0.0:8000/v1', 'http://192.168.1.2:8000/v1', 'http://localhost.example/v1', 'http://user:key@localhost/v1']) assert.equal(isLocalEndpoint(baseUrl), false);
});
