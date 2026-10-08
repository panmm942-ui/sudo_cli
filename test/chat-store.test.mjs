import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, readdir, lstat, rm, symlink } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createChatStore } from '../src/chat-store.mjs';
import { createChatHistory } from '../src/chat-history.mjs';

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'codexcli-chat-store-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const cwd = join(root, 'project');
  const otherCwd = join(root, 'other-project');
  await mkdir(cwd); await mkdir(otherCwd);
  return { root, cwd, otherCwd, stateDir: join(root, 'state') };
}
function conversation() {
  const history = createChatHistory();
  history.addUser('Continue building the project');
  history.finishAssistant('answer-one', 'First finished response');
  history.addUser('Now fix the next issue');
  history.appendAssistant('answer-two', 'Unfinished response');
  return history.snapshot();
}
const connection = { transport: 'chat-completions', model: 'local-model', baseUrl: 'http://localhost:1234/v1', contextWindow: 32768, supportedEfforts: ['low', 'high'] };

test('a fresh launch resumes the complete last saved chat and pending prompts', async t => {
  const paths = await fixture(t);
  const store = await createChatStore(paths);
  const transcript = conversation();
  const first = await store.create({ history: transcript, connection, pendingInputs: ['Queued task'] });
  assert.match(first.id, /^[0-9a-f-]{36}$/);
  assert.equal(first.title, 'Continue building the project');
  assert.equal((await store.last()).id, first.id);
  const fresh = await createChatStore(paths);
  const loaded = await fresh.last();
  assert.deepEqual(loaded.history, transcript);
  assert.deepEqual(loaded.connection, connection);
  assert.deepEqual(loaded.pendingInputs, ['Queued task']);
  const history = createChatHistory(); history.restore(loaded.history);
  history.appendAssistant('answer-two', ' completed'); history.finishAssistant('answer-two');
  const saved = await fresh.save({ id: first.id, history: history.snapshot(), pendingInputs: [] });
  assert.equal(saved.createdAt, first.createdAt);
  assert.equal((await fresh.get(first.id)).history.messages.at(-1).content, 'Unfinished response completed');
  assert.deepEqual((await fresh.get(first.id)).pendingInputs, []);
});

test('new chat retains previous chats, selects last and removal discards only the requested chat', async t => {
  const paths = await fixture(t);
  const store = await createChatStore(paths);
  const previous = await store.create({ title: 'Previous chat', history: conversation() });
  const current = await store.create({ title: 'New chat' });
  assert.equal((await store.last()).id, current.id);
  assert.deepEqual((await store.list()).map(value => value.id), [current.id, previous.id]);
  await store.setLast(previous.id);
  assert.equal((await store.last()).id, previous.id);
  assert.equal(await store.remove(current.id), true);
  assert.equal(await store.get(current.id), undefined);
  assert.equal(await store.remove(current.id), false);
  assert.equal((await store.last()).id, previous.id);
  await store.remove(previous.id);
  assert.equal(await store.last(), undefined);
});

test('project identities have separate last-chat pointers and explicit cross-project listing', async t => {
  const paths = await fixture(t);
  const firstStore = await createChatStore(paths);
  const secondStore = await createChatStore({ ...paths, cwd: paths.otherCwd });
  const first = await firstStore.create({ title: 'First project' });
  const second = await secondStore.create({ title: 'Second project' });
  assert.deepEqual((await firstStore.list()).map(value => value.id), [first.id]);
  assert.deepEqual((await secondStore.list()).map(value => value.id), [second.id]);
  assert.equal((await firstStore.list({ allProjects: true })).length, 2);
  assert.equal((await firstStore.last()).id, first.id);
  assert.equal((await secondStore.last()).id, second.id);
  assert.equal((await firstStore.get(second.id)).cwd, paths.otherCwd);
  await assert.rejects(firstStore.setLast(second.id), /project/i);
  await assert.rejects(firstStore.save({ id: second.id, history: conversation() }), /project/i);
  await assert.rejects(firstStore.remove(second.id), /project/i);
  assert.equal((await secondStore.last()).id, second.id);
});

test('saved chat files redact secrets and contain metadata only for connections and attachments', async t => {
  const paths = await fixture(t);
  const store = await createChatStore({ ...paths, secrets: () => ['private-api-key'] });
  const saved = await store.create({ title: 'A private-api-key chat', connection: { ...connection, apiKey: 'private-api-key', credentials: { private: true } }, history: {
    version: 1, messages: [{ id: 'one', role: 'user', model: null, content: 'Do not save private-api-key\u001b[31m', apiKey: 'private-api-key', attachments: [{ name: 'notes.txt', path: '/project/notes.txt', sizeBytes: 9, content: 'private source bytes', buffer: { private: true }, data: 'private image bytes' }] }],
  }, pendingInputs: ['Queued private-api-key'] });
  const text = await readFile(join(store.directory, `chat-${saved.id}.json`), 'utf8');
  assert.doesNotMatch(text, /private-api-key|credentials|apiKey|private source bytes|private image bytes|buffer/);
  assert.match(text, /\[redacted\]/);
  assert.equal(saved.history.messages[0].content, 'Do not save [redacted]');
  assert.deepEqual(saved.history.messages[0].attachments, [{ name: 'notes.txt', path: '/project/notes.txt', sizeBytes: 9 }]);
  if (process.platform !== 'win32') assert.equal((await lstat(join(store.directory, `chat-${saved.id}.json`))).mode & 0o777, 0o600);
});

test('corrupted records are skipped with warnings and cannot be overwritten', async t => {
  const paths = await fixture(t);
  const store = await createChatStore(paths);
  const good = await store.create({ title: 'Healthy chat' });
  const broken = await store.create({ title: 'Broken chat' });
  const path = join(store.directory, `chat-${broken.id}.json`);
  await writeFile(path, '{broken');
  assert.deepEqual((await store.list()).map(value => value.id), [good.id]);
  assert.equal(store.warnings().length, 1);
  assert.match(store.warnings()[0], /invalid|corrupt/i);
  await assert.rejects(store.get(broken.id), /invalid|corrupt/i);
  await assert.rejects(store.save({ id: broken.id, history: conversation() }), /invalid|corrupt/i);
  assert.equal(await readFile(path, 'utf8'), '{broken');
  await assert.rejects(store.last(), /invalid|corrupt/i);
});

test('path identifiers and oversized snapshots are refused without creating or altering records', async t => {
  const paths = await fixture(t);
  const store = await createChatStore(paths);
  const saved = await store.create({ title: 'Unchanged chat' });
  const before = await readFile(join(store.directory, `chat-${saved.id}.json`), 'utf8');
  await assert.rejects(store.get('../outside'), /identifier/i);
  await assert.rejects(store.save({ id: saved.id, history: { version: 1, messages: [{ id: 'user', role: 'user', model: null, content: 'a'.repeat(50 * 1024 * 1024) }] } }), /size|limit/i);
  assert.equal(await readFile(join(store.directory, `chat-${saved.id}.json`), 'utf8'), before);
  assert.equal((await readdir(store.directory)).some(name => name.endsWith('.tmp') || name.endsWith('.lock')), false);
});

test('overlapping autosaves on the same instance complete atomically in invocation order', async t => {
  const paths = await fixture(t);
  const store = await createChatStore(paths);
  const saved = await store.create();
  const snapshots = Array.from({ length: 5 }, (_, index) => {
    const history = createChatHistory(); history.addUser(`Checkpoint ${index}`); return history.snapshot();
  });
  await Promise.all(snapshots.map(history => store.save({ id: saved.id, history })));
  assert.equal((await store.get(saved.id)).history.messages[0].content, 'Checkpoint 4');
  assert.equal((await readdir(store.directory)).some(name => name.endsWith('.tmp') || name.endsWith('.lock')), false);
});

test('chat record symlinks are refused without touching their targets', async t => {
  const paths = await fixture(t);
  const store = await createChatStore(paths);
  const saved = await store.create();
  const path = join(store.directory, `chat-${saved.id}.json`);
  const outside = join(paths.root, 'outside.json');
  await writeFile(outside, 'untouched'); await rm(path);
  try { await symlink(outside, path, 'file'); } catch (error) {
    if (process.platform === 'win32' && ['EPERM', 'EACCES', 'UNKNOWN'].includes(error.code)) { t.skip('Windows file symlinks require Developer Mode or elevated test privileges.'); return; }
    throw error;
  }
  await assert.rejects(store.get(saved.id), /invalid|real|link/i);
  await assert.rejects(store.save({ id: saved.id, history: conversation() }), /invalid|real|link/i);
  assert.equal(await readFile(outside, 'utf8'), 'untouched');
});

test('a linked chat storage directory is refused', async t => {
  const paths = await fixture(t);
  await mkdir(paths.stateDir); await mkdir(join(paths.root, 'outside-storage'));
  try { await symlink(join(paths.root, 'outside-storage'), join(paths.stateDir, 'chats'), process.platform === 'win32' ? 'junction' : 'dir'); }
  catch (error) {
    if (process.platform === 'win32' && ['EPERM', 'EACCES', 'UNKNOWN'].includes(error.code)) { t.skip('Windows directory link creation unavailable.'); return; }
    throw error;
  }
  await assert.rejects(createChatStore(paths), /real|link/i);
  assert.deepEqual(await readdir(join(paths.root, 'outside-storage')), []);
});

test('keys supplied on the connection are remembered for redaction before history is saved', async t => {
  const paths = await fixture(t);
  const store = await createChatStore(paths);
  const history = createChatHistory(); history.addUser('The supplied-secret must stay private');
  const saved = await store.create({ connection: { ...connection, apiKey: 'supplied-secret' }, history: history.snapshot() });
  assert.doesNotMatch(await readFile(join(store.directory, `chat-${saved.id}.json`), 'utf8'), /supplied-secret/);
  const next = createChatHistory(); next.addUser('Even after switching, supplied-secret stays private');
  await store.save({ id: saved.id, connection, history: next.snapshot() });
  assert.equal((await store.get(saved.id)).history.messages[0].content, 'Even after switching, [redacted] stays private');
});

test('last-chat pointer corruption is not overwritten by selecting or creating another chat', async t => {
  const paths = await fixture(t);
  const store = await createChatStore(paths);
  const saved = await store.create();
  const pointer = (await readdir(store.directory)).find(name => name.startsWith('last-'));
  await writeFile(join(store.directory, pointer), '{invalid pointer');
  await assert.rejects(store.last(), /invalid/i);
  await assert.rejects(store.setLast(saved.id), /invalid/i);
  await assert.rejects(store.create(), /invalid/i);
  assert.equal((await readdir(store.directory)).filter(name => name.startsWith('chat-') && name.endsWith('.json')).length, 1);
  assert.equal(await readFile(join(store.directory, pointer), 'utf8'), '{invalid pointer');
});

test('oversized pending prompts and undefined history updates cannot erase an existing chat', async t => {
  const paths = await fixture(t);
  const store = await createChatStore(paths);
  const saved = await store.create({ history: conversation() });
  await assert.rejects(store.save({ id: saved.id, history: saved.history, pendingInputs: ['a'.repeat(50 * 1024 * 1024)] }), /size|limit/i);
  await assert.rejects(store.save({ id: saved.id }), /history|snapshot/i);
  assert.deepEqual((await store.get(saved.id)).history, saved.history);
});

test('reading saved chats during repeated autosaves observes valid complete generations', async t => {
  const paths = await fixture(t);
  const store = await createChatStore(paths);
  const saved = await store.create({ history: conversation() });
  const writes = (async () => { for (let index = 0; index < 25; index++) await store.save({ id: saved.id, history: saved.history, title: `Checkpoint ${index}` }); })();
  const reads = (async () => { for (let index = 0; index < 80; index++) assert.equal((await store.get(saved.id)).id, saved.id); })();
  await Promise.all([writes, reads]);
  assert.equal((await store.get(saved.id)).title, 'Checkpoint 24');
});
