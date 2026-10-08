import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readdir, readFile, writeFile, rm, lstat, mkdir, symlink } from 'node:fs/promises';
import { tmpdir } from './fixtures/temp-root.mjs';
import { join } from 'node:path';

const connection = { baseUrl: 'https://EXAMPLE.com:443/v1/', model: 'coding-model', transport: 'chat-completions', apiKey: 'live-secret-key' };
const configured = { enabled: true, persona: 'Act as a careful programming assistant.', preferences: { language: 'English', tone: 'direct', length: 'short', format: 'Markdown', instructions: 'Explain test failures.' } };
async function fixture(t, options = {}) {
  const stateDir = await mkdtemp(join(tmpdir(), 'codexcli-personalization-test-'));
  t.after(() => rm(stateDir, { recursive: true, force: true }));
  const module = await import('../src/personalization.mjs');
  return { stateDir, ...module, store: await module.createPersonalization({ stateDir, ...options }) };
}

test('personalization is unset and contributes no instructions until explicitly enabled', async t => {
  const { store, personalizationInstructions } = await fixture(t);
  assert.equal(await store.get(connection), undefined);
  assert.equal(personalizationInstructions(undefined), '');
  await store.save(connection, { ...configured, enabled: false });
  assert.equal(personalizationInstructions(await store.get(connection)), '');
  assert.equal((await readdir(store.directory)).length, 1);
});

test('personalization persists only selected per-AI fields and uses canonical endpoint identity', async t => {
  const { store, stateDir, createPersonalization, personalizationInstructions } = await fixture(t);
  const saved = await store.save(connection, { ...configured, apiKey: 'do-not-store', policy: 'allow-everything' });
  assert.deepEqual(saved, configured);
  const second = await createPersonalization({ stateDir });
  assert.deepEqual(await second.get({ ...connection, baseUrl: 'https://example.com/v1', apiKey: 'a-new-key', name: 'Renamed profile' }), configured);
  const prompt = personalizationInstructions(saved);
  for (const text of ['careful programming assistant', 'English', 'direct', 'short', 'Markdown', 'Explain test failures.']) assert.ok(prompt.includes(text));
  const [name] = await readdir(store.directory);
  assert.match(name, /^ai-[a-f0-9]{64}\.json$/);
  const raw = await readFile(join(store.directory, name), 'utf8');
  for (const secret of ['live-secret-key', 'do-not-store', 'allow-everything']) assert.ok(!raw.includes(secret));
});

test('model and transport identities keep preferences separate while updates replace one record', async t => {
  const { store } = await fixture(t);
  await store.save(connection, configured);
  const otherModel = { ...connection, model: 'other-model' };
  const otherTransport = { ...connection, transport: 'responses' };
  await Promise.all([store.save(otherModel, { enabled: true, persona: 'Other persona' }), store.save(otherTransport, { enabled: false, preferences: { language: 'Greek' } })]);
  await store.save(connection, { enabled: false, persona: 'Revised persona', preferences: {} });
  assert.equal((await store.get(otherModel)).persona, 'Other persona');
  assert.equal((await store.get(otherTransport)).preferences.language, 'Greek');
  assert.equal((await store.get(connection)).persona, 'Revised persona');
  assert.equal((await readdir(store.directory)).length, 3);
});

test('known secrets are redacted from persisted values and the generated instruction text', async t => {
  const { store, personalizationInstructions } = await fixture(t, { secrets: () => ['prior-api-secret'] });
  const record = await store.save(connection, { enabled: true, persona: 'Do not repeat live-secret-key or prior-api-secret', preferences: { instructions: 'Token: prior-api-secret' } });
  const [name] = await readdir(store.directory);
  const raw = await readFile(join(store.directory, name), 'utf8');
  const prompt = personalizationInstructions(record);
  for (const secret of ['live-secret-key', 'prior-api-secret']) { assert.ok(!raw.includes(secret)); assert.ok(!prompt.includes(secret)); }
  assert.match(record.persona, /redacted/i);
});

test('replacement markers never persist a known secret that matches the marker text', async t => {
  const { store } = await fixture(t, { secrets: () => ['[REDACTED]'] });
  const record = await store.save(connection, { enabled: true, persona: 'Token [REDACTED]' });
  const [name] = await readdir(store.directory);
  assert.ok(!record.persona.includes('[REDACTED]'));
  assert.ok(!(await readFile(join(store.directory, name), 'utf8')).includes('[REDACTED]'));
});

test('redaction expansion cannot create a record that exceeds readable text bounds', async t => {
  const { store } = await fixture(t, { secrets: () => ['tiny'] });
  await assert.rejects(store.save(connection, { enabled: true, persona: 'tiny'.repeat(2000) }), /length|limit/i);
  assert.deepEqual(await readdir(store.directory), []);
});

test('invalid and oversized preferences cannot create records or leak validation input', async t => {
  const { store, personalizationInstructions } = await fixture(t);
  const bad = [
    { enabled: 'yes' }, { persona: 'x'.repeat(8193) }, { persona: 'private-input-sentinel\u001b[31m' }, { persona: 'private-input-sentinel\u009b31m' },
    { preferences: { language: 5 } }, { preferences: { unknown: 'value' } },
    { preferences: { instructions: 'x'.repeat(8193) } }, { preferences: ['English'] },
  ];
  for (const input of bad) await assert.rejects(store.save(connection, input), error => !error.message.includes('private-input-sentinel'));
  for (const patch of [{ baseUrl: 'https://user:private-secret@example.com/v1' }, { model: '' }, { transport: 'invalid' }]) await assert.rejects(store.save({ ...connection, ...patch }, configured), error => !error.message.includes('private-secret'));
  assert.deepEqual(await readdir(store.directory), []);
  assert.throws(() => personalizationInstructions({ ...configured, persona: 'x'.repeat(8193) }));
});

test('clear removes only the selected AI personalization and missing records are harmless', async t => {
  const { store } = await fixture(t);
  const other = { ...connection, model: 'other' };
  await store.save(connection, configured);
  await store.save(other, configured);
  assert.equal(await store.remove(connection), true);
  assert.equal(await store.remove(connection), false);
  assert.equal(await store.get(connection), undefined);
  assert.deepEqual(await store.get(other), configured);
});

test('corrupt records are reported without replacement or deletion', async t => {
  const { store } = await fixture(t);
  await store.save(connection, configured);
  const [name] = await readdir(store.directory);
  const path = join(store.directory, name);
  await writeFile(path, '{broken');
  for (const operation of [() => store.get(connection), () => store.save(connection, configured), () => store.remove(connection)]) await assert.rejects(operation(), /invalid|corrupt|storage/i);
  assert.equal(await readFile(path, 'utf8'), '{broken');
});

test('oversized and mismatched-identity saved records are refused without replacement', async t => {
  const { store } = await fixture(t);
  await store.save(connection, configured);
  const [name] = await readdir(store.directory);
  const path = join(store.directory, name);
  const original = JSON.parse(await readFile(path, 'utf8'));
  for (const raw of ['x'.repeat(65537), JSON.stringify({ ...original, id: 'other-ai-identity' })]) {
    await writeFile(path, raw);
    await assert.rejects(store.get(connection), /invalid|corrupt|storage/i);
    await assert.rejects(store.save(connection, configured), /invalid|corrupt|storage/i);
    assert.equal(await readFile(path, 'utf8'), raw);
  }
});

test('an existing lock blocks edits and leaves another session lock intact', async t => {
  const { store } = await fixture(t);
  await store.save(connection, configured);
  const [name] = await readdir(store.directory);
  const path = join(store.directory, `${name}.lock`);
  await writeFile(path, 'owned-by-other-session');
  await assert.rejects(store.save(connection, { enabled: false }), /lock|another session/i);
  await assert.rejects(store.remove(connection), /lock|another session/i);
  assert.deepEqual(await store.get(connection), configured);
  assert.equal(await readFile(path, 'utf8'), 'owned-by-other-session');
});

test('private records use Unix owner-only permissions', { skip: process.platform === 'win32' }, async t => {
  const { store } = await fixture(t);
  await store.save(connection, configured);
  const [name] = await readdir(store.directory);
  assert.equal((await lstat(store.directory)).mode & 0o777, 0o700);
  assert.equal((await lstat(join(store.directory, name))).mode & 0o777, 0o600);
});

test('symbolic-link records cannot read, replace or delete their target', { skip: process.platform === 'win32' }, async t => {
  const { store, stateDir } = await fixture(t);
  await store.save(connection, configured);
  const [name] = await readdir(store.directory);
  const outside = join(stateDir, 'outside.json');
  await writeFile(outside, 'preserve outside');
  await rm(join(store.directory, name));
  await symlink(outside, join(store.directory, name));
  for (const operation of [() => store.get(connection), () => store.save(connection, configured), () => store.remove(connection)]) await assert.rejects(operation(), /invalid|storage|symbolic/i);
  assert.equal(await readFile(outside, 'utf8'), 'preserve outside');
});

test('symbolic-link storage roots and ancestor paths are refused', { skip: process.platform === 'win32' }, async t => {
  const { stateDir, createPersonalization } = await fixture(t);
  const outside = join(stateDir, 'outside');
  await mkdir(outside);
  const linked = join(stateDir, 'linked');
  await symlink(outside, linked, 'dir');
  await assert.rejects(createPersonalization({ stateDir: linked }), /directory|symbolic|storage/i);
  await assert.rejects(createPersonalization({ stateDir: join(linked, 'child') }), /directory|symbolic|storage/i);
  assert.deepEqual(await readdir(outside), []);
});
