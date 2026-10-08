import test from 'node:test';
import assert from 'node:assert/strict';

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
