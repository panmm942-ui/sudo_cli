import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from './fixtures/temp-root.mjs';
import { join } from 'node:path';

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'sudocli-agent-presets-'));
  const cwd = join(root, 'project'); await mkdir(cwd);
  t.after(() => rm(root, { recursive: true, force: true }));
  const { createAgentPresets } = await import('../src/agent-presets.mjs');
  return { root, cwd, stateDir: join(root, 'state'), createAgentPresets };
}

test('named agents include immutable built-ins and an isolated edit coder', async t => {
  const { cwd, stateDir, createAgentPresets } = await fixture(t);
  const store = await createAgentPresets({ cwd, stateDir });
  const list = await store.list();
  assert.deepEqual(list.map(agent => agent.name), ['planner', 'reviewer', 'tester', 'security', 'researcher', 'coder']);
  assert.equal((await store.get('coder')).mode, 'edit');
  assert.equal((await store.get('reviewer')).mode, 'review');
  await assert.rejects(store.save({ name: 'reviewer', role: 'coder', mode: 'edit', instructions: 'Replace reviewer' }), /built.in/i);
  await assert.rejects(store.remove('coder'), /built.in/i);
  assert.equal((await store.get('reviewer')).role, 'reviewer');
});

test('agent definitions persist project scoped preferences without connection keys', async t => {
  const { root, cwd, stateDir, createAgentPresets } = await fixture(t);
  const secret = 'named-agent-secret-fixture';
  const store = await createAgentPresets({ cwd, stateDir, secrets: () => [secret] });
  const saved = await store.save({ name: 'my-reviewer', role: 'reviewer', instructions: `Keep replies short. ${secret}`, profileName: 'My local model', apiKey: secret, connection: { apiKey: secret } });
  assert.equal(saved.mode, 'review'); assert.equal(saved.profileName, 'My local model');
  assert.ok(!saved.instructions.includes(secret));
  const reopened = await createAgentPresets({ cwd, stateDir });
  assert.deepEqual(await reopened.get('my-reviewer'), saved);
  const raw = await readFile(store.path, 'utf8');
  assert.ok(!raw.includes(secret)); assert.ok(!raw.includes('apiKey')); assert.ok(!raw.includes('connection'));
  const other = join(root, 'other-project'); await mkdir(other);
  assert.equal(await (await createAgentPresets({ cwd: other, stateDir })).get('my-reviewer'), undefined);
  assert.equal(await reopened.remove('my-reviewer'), true);
  assert.equal(await reopened.remove('my-reviewer'), false);
});

test('agent definitions reject unsafe names, unknown modes, oversized instructions and excess saved agents', async t => {
  const { cwd, stateDir, createAgentPresets } = await fixture(t);
  const store = await createAgentPresets({ cwd, stateDir });
  for (const input of [
    { name: '../escape', role: 'reviewer' }, { name: 'valid', role: 'unknown' },
    { name: 'valid', role: 'coder', mode: 'full-access' },
    { name: 'valid', role: 'reviewer', instructions: 'x'.repeat(8193) },
    { name: 'valid', role: 'reviewer', instructions: 'hidden\u0000text' },
  ]) await assert.rejects(store.save(input));
  for (let index = 0; index < 32; index++) await store.save({ name: `agent-${index}`, role: 'reviewer' });
  await assert.rejects(store.save({ name: 'one-too-many', role: 'planner' }), /limit|32/i);
  await store.save({ name: 'agent-0', role: 'planner', instructions: 'Updated existing agent' });
  assert.equal((await store.get('agent-0')).role, 'planner');
});

test('corrupted agent storage is refused without replacing the existing file', async t => {
  const { cwd, stateDir, createAgentPresets } = await fixture(t);
  const store = await createAgentPresets({ cwd, stateDir });
  await store.save({ name: 'my-agent', role: 'tester' });
  await writeFile(store.path, '{"version":1,"agents":[{"name":"../escape"}]}');
  const damaged = await readFile(store.path, 'utf8');
  await assert.rejects(store.list(), /invalid/i);
  await assert.rejects(store.save({ name: 'another', role: 'tester' }), /invalid/i);
  assert.equal(await readFile(store.path, 'utf8'), damaged);
});

test('simultaneous agent saves never silently overwrite another successful save', async t => {
  const { cwd, stateDir, createAgentPresets } = await fixture(t);
  const first = await createAgentPresets({ cwd, stateDir });
  const second = await createAgentPresets({ cwd, stateDir });
  const results = await Promise.allSettled(Array.from({ length: 12 }, (_, index) => (index % 2 ? first : second).save({ name: `parallel-${index}`, role: 'tester' })));
  const names = new Set((await first.list()).map(agent => agent.name));
  for (const [index, result] of results.entries()) {
    if (result.status === 'fulfilled') assert.ok(names.has(`parallel-${index}`));
    else assert.match(result.reason.message, /lock/i);
  }
  assert.ok(results.some(result => result.status === 'fulfilled'));
});
