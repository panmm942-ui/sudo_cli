import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir, rm, writeFile, symlink } from 'node:fs/promises';
import { tmpdir } from './fixtures/temp-root.mjs';
import { join } from 'node:path';
async function store(t) {
  const stateDir = await mkdtemp(join(tmpdir(), 'codexcli-profile-test-'));
  t.after(() => rm(stateDir, { recursive: true, force: true }));
  const { createModelProfiles } = await import('../src/model-profiles.mjs');
  return { stateDir, profiles: await createModelProfiles({ stateDir }) };
}
const connection = { name: 'Local coding', model: 'local-model', transport: 'chat-completions', baseUrl: 'http://localhost:11434/v1', contextWindow: 128000, apiKeyEnv: 'LOCAL_MODEL_KEY', supportedEfforts: ['low', 'high'] };

test('profiles retain only named connection metadata and never API keys or runtime permissions', async t => {
  const { stateDir, profiles } = await store(t);
  await profiles.save({ ...connection, apiKey: 'never-save-me', token: 'secret-token', permissions: 'allow-everything', webAccess: true, extra: { apiKey: 'nested-secret' } });
  const value = await profiles.get('local coding');
  assert.deepEqual(value, connection);
  const files = await readdir(join(stateDir, 'models'));
  assert.equal(files.length, 1);
  const body = await readFile(join(stateDir, 'models', files[0]), 'utf8');
  for (const secret of ['never-save-me', 'secret-token', 'nested-secret', 'allow-everything']) assert.ok(!body.includes(secret));
});
test('profiles validate URLs and capability fields before saving without echoing credentials', async t => {
  const { profiles } = await store(t);
  for (const patch of [{ baseUrl: 'https://user:private-secret@example.com/v1' }, { baseUrl: 'http://localhost:8000/v1?key=private-secret' }, { name: 'name\ncontrol' }, { supportedEfforts: ['high\ncommand'] }, { contextWindow: 0 }]) {
    await assert.rejects(profiles.save({ ...connection, ...patch }), error => { assert.ok(!error.message.includes('private-secret')); return true; });
  }
  assert.deepEqual(await profiles.list(), []);
});

test('model profiles retain a per-AI parallel-call declaration without disabling tools', async t => {
  const { profiles, stateDir } = await store(t);
  await profiles.save({ ...connection, capabilities: { tools: true, parallelToolCalls: false } });
  await profiles.save({ ...connection, name: 'Other AI', model: 'other-model', capabilities: { tools: true } });
  const { createModelProfiles } = await import('../src/model-profiles.mjs');
  const reopened = await createModelProfiles({ stateDir });
  assert.deepEqual((await reopened.get(connection.name)).capabilities, { tools: true, parallelToolCalls: false });
  assert.deepEqual((await reopened.get('Other AI')).capabilities, { tools: true });
  assert.equal((await reopened.get(connection.name)).model, 'local-model');
  for (const parallelToolCalls of ['off', null, 0]) {
    await assert.rejects(profiles.save({ ...connection, capabilities: { tools: true, parallelToolCalls } }), /boolean declarations/i);
  }
  assert.deepEqual((await reopened.get(connection.name)).capabilities, { tools: true, parallelToolCalls: false });
});
test('concurrent distinct profiles are preserved and traversal-like names cannot escape storage', async t => {
  const { profiles, stateDir } = await store(t);
  await Promise.all(Array.from({ length: 12 }, (_, index) => profiles.save({ ...connection, name: index === 0 ? '../outside' : `Model ${index}` })));
  assert.equal((await profiles.list()).length, 12);
  assert.deepEqual(await readdir(stateDir), ['models']);
  assert.ok((await readdir(join(stateDir, 'models'))).every(name => /^model-[a-f0-9]{64}\.json$/.test(name)));
});
test('saving updates one profile and remove leaves other profiles intact', async t => {
  const { profiles } = await store(t);
  await profiles.save(connection);
  await profiles.save({ ...connection, name: 'Other' });
  await profiles.save({ ...connection, model: 'updated-model' });
  assert.equal((await profiles.get(connection.name)).model, 'updated-model');
  assert.equal(await profiles.remove(connection.name), true);
  assert.equal(await profiles.remove(connection.name), false);
  assert.equal(await profiles.get(connection.name), undefined);
  assert.deepEqual((await profiles.list()).map(item => item.name), ['Other']);
});
test('corrupted saved profiles are reported and left unchanged', async t => {
  const { profiles, stateDir } = await store(t);
  await profiles.save(connection);
  const name = (await readdir(join(stateDir, 'models')))[0];
  await writeFile(join(stateDir, 'models', name), '{broken');
  await assert.rejects(profiles.list(), /profile|storage/i);
  await assert.rejects(profiles.save(connection), /profile|storage/i);
  assert.equal(await readFile(join(stateDir, 'models', name), 'utf8'), '{broken');
});
test('local presets describe running compatible endpoints without choosing or downloading a model', async () => {
  const { localEndpointPresets } = await import('../src/model-profiles.mjs');
  assert.equal(localEndpointPresets.find(item => item.id === 'ollama').baseUrl, 'http://localhost:11434/v1');
  assert.equal(localEndpointPresets.find(item => item.id === 'lmstudio').baseUrl, 'http://localhost:1234/v1');
  assert.ok(localEndpointPresets.every(item => item.requiresRunningServer === true && item.model === undefined));
});
test('an existing same-profile lock refuses concurrent edits without replacing the saved record', async t => {
  const { stateDir, profiles } = await store(t);
  await profiles.save(connection);
  const name = (await readdir(join(stateDir, 'models')))[0];
  const lock = join(stateDir, 'models', `${name}.lock`);
  await writeFile(lock, 'other session lock');
  await assert.rejects(profiles.save({ ...connection, model: 'must-not-win' }), /another session|lock/i);
  assert.equal((await profiles.get(connection.name)).model, connection.model);
  assert.equal(await readFile(lock, 'utf8'), 'other session lock');
});
test('symbolic-link profile records are refused and never replaced', { skip: process.platform === 'win32' }, async t => {
  const { stateDir, profiles } = await store(t);
  await profiles.save(connection);
  const name = (await readdir(join(stateDir, 'models')))[0];
  const outside = join(stateDir, 'outside.json');
  await writeFile(outside, 'keep');
  await rm(join(stateDir, 'models', name));
  await symlink(outside, join(stateDir, 'models', name));
  await assert.rejects(profiles.get(connection.name), /invalid|profile/i);
  await assert.rejects(profiles.save(connection), /invalid|profile/i);
  assert.equal(await readFile(outside, 'utf8'), 'keep');
});
test('oversized profile metadata is refused before creating an unreadable saved record', async t => {
  const { profiles } = await store(t);
  await assert.rejects(profiles.save({ ...connection, model: 'model'.repeat(5000) }), /size limit/i);
  assert.deepEqual(await profiles.list(), []);
});
