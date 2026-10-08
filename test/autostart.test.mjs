import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readdir, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from './fixtures/temp-root.mjs';
import { join } from 'node:path';

test('autostart planning has no host side effects and preserves paths with spaces as arguments', async t => {
  const { createAutostartPlan, installAutostart, removeAutostart } = await import('../src/autostart.mjs');
  const dir = await mkdtemp(join(tmpdir(), 'codexcli-startup-')); t.after(() => rm(dir, { recursive: true, force: true }));
  const plan = createAutostartPlan({ platform: 'linux', name: 'codexcli-test', installDir: dir, nodePath: '/opt/node with spaces/node', entryPath: '/opt/app with spaces/autostart.mjs', configPath: '/etc/cli with spaces/startup.json', cwd: '/project with spaces' });
  assert.deepEqual(await readdir(dir), []);
  const executed = [];
  await installAutostart(plan, { execute: async (file, args) => { executed.push({ file, args }); return { code: 0 }; } });
  assert.equal((await readdir(dir)).length, 1);
  assert.match(await readFile(join(dir, plan.filename), 'utf8'), /node with spaces/);
  assert.deepEqual(executed.map(value => value.file), ['systemctl', 'systemctl']);
  await removeAutostart(plan, { execute: async (file, args) => { executed.push({ file, args }); return { code: 0 }; } });
  assert.deepEqual(await readdir(dir), []);
});

test('startup config rejects plaintext keys and credential loader output is only delivered to runtime memory', async t => {
  const { validateStartupConfig, loadStartupConfig } = await import('../src/autostart.mjs');
  const config = { version: 1, cwd: '/project', stateDir: '/private/state', credentialProvider: { file: '/trusted/credential-loader', args: ['read-codexcli'] }, agent: { localConnection: { baseUrl: 'http://localhost:1234/v1', model: 'local', transport: 'chat-completions' }, cloudConnection: { baseUrl: 'https://example.com/v1', model: 'cloud', transport: 'responses', apiKeyEnv: 'CLOUD_KEY' }, settings: { permissions: 'ask' } } };
  assert.throws(() => validateStartupConfig({ ...config, agent: { ...config.agent, cloudConnection: { ...config.agent.cloudConnection, apiKey: 'saved-secret' } } }), error => !error.message.includes('saved-secret'));
  const dir = await mkdtemp(join(tmpdir(), 'codexcli-startup-config-')); t.after(() => rm(dir, { recursive: true, force: true }));
  const path = join(dir, 'startup.json'); await writeFile(path, JSON.stringify(config), { mode: 0o600 });
  const loaded = await loadStartupConfig(path, { env: {}, execute: async (file, args) => { assert.equal(file, '/trusted/credential-loader'); assert.deepEqual(args, ['read-codexcli']); return { code: 0, stdout: '{"CLOUD_KEY":"runtime-only-secret"}' }; } });
  assert.equal(loaded.config.cloudConnection.apiKey, 'runtime-only-secret');
  assert.ok(!(await readFile(path, 'utf8')).includes('runtime-only-secret'));
});

test('startup template rejects executable control characters and install refuses replacing existing files', async t => {
  const { createAutostartPlan, installAutostart } = await import('../src/autostart.mjs');
  const dir = await mkdtemp(join(tmpdir(), 'codexcli-startup-existing-')); t.after(() => rm(dir, { recursive: true, force: true }));
  assert.throws(() => createAutostartPlan({ platform: 'win32', name: 'safe', installDir: dir, configPath: 'C:/config.json', cwd: 'C:/project', nodePath: 'C:/node.exe\nmalicious' }), /path|invalid/i);
  const plan = createAutostartPlan({ platform: 'win32', name: 'safe', installDir: dir, configPath: 'C:/config.json', cwd: 'C:/project' });
  await writeFile(join(dir, plan.filename), 'existing data');
  await assert.rejects(installAutostart(plan, { execute: async () => assert.fail('Must not alter host') }), /exist/i);
  assert.equal(await readFile(join(dir, plan.filename), 'utf8'), 'existing data');
});
