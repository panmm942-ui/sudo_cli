import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rm, readdir, symlink, link, lstat, chmod, realpath } from 'node:fs/promises';
import { tmpdir } from './fixtures/temp-root.mjs';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { captureAgentWorkspace, diffAgentWorkspace, applyAgentChanges, createAgentResults } from '../src/agent-changes.mjs';

const hash = data => createHash('sha256').update(data).digest('hex');
async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'codexcli-agent-changes-')), cwd = join(root, 'project'), copy = join(root, 'copy');
  await mkdir(cwd); await mkdir(copy); t.after(() => rm(root, { recursive: true, force: true }));
  return { root, cwd, copy, stateDir: join(root, 'state') };
}
function addition(path, value) { const bytes = Buffer.from(value); return { path, kind: 'added', beforeHash: null, beforeContent: null,
  afterHash: hash(bytes), content: bytes.toString('base64'), bytes: bytes.length, mode: 0o600 }; }
const proposal = files => ({ files, skipped: [], partial: false });

test('isolated proposal adds edits and deletes actual files while preserving unrelated human work', async t => {
  const { cwd, copy } = await fixture(t);
  for (const folder of [cwd, copy]) { await writeFile(join(folder, 'edited.js'), 'const one = 1;\r\n'); await writeFile(join(folder, 'deleted.txt'), 'old\n'); }
  const before = await captureAgentWorkspace({ cwd: copy });
  await writeFile(join(copy, 'edited.js'), 'const one = 2;\r\n'); await rm(join(copy, 'deleted.txt'));
  await mkdir(join(copy, 'new')); await writeFile(join(copy, 'new', 'created.js'), 'export const created = true;\n');
  const changes = diffAgentWorkspace(before, await captureAgentWorkspace({ cwd: copy }));
  assert.deepEqual(changes.files.map(file => [file.path, file.kind]), [['deleted.txt', 'deleted'], ['edited.js', 'modified'], ['new/created.js', 'added']]);
  assert.equal(Buffer.from(changes.files[1].beforeContent, 'base64').toString(), 'const one = 1;\r\n');
  await writeFile(join(cwd, 'human.txt'), 'human work');
  const applied = await applyAgentChanges({ cwd, changes });
  assert.equal(applied.conflicts.length, 0); assert.equal(applied.applied.length, 3);
  assert.equal(await readFile(join(cwd, 'edited.js'), 'utf8'), 'const one = 2;\r\n');
  assert.equal(await readFile(join(cwd, 'new', 'created.js'), 'utf8'), 'export const created = true;\n');
  assert.equal(await readFile(join(cwd, 'human.txt'), 'utf8'), 'human work');
  assert.equal((await readdir(cwd)).includes('deleted.txt'), false);
  assert.equal((await lstat(join(cwd, 'new', 'created.js'))).nlink, 1);
  assert.ok(!(await readdir(cwd)).some(name => name.endsWith('.tmp')));
});

test('intervening edits missing originals and human additions conflict without replacing them', async t => {
  const { cwd, copy } = await fixture(t);
  for (const folder of [cwd, copy]) for (const name of ['edit.txt', 'delete.txt', 'gone.txt']) await writeFile(join(folder, name), 'before');
  const before = await captureAgentWorkspace({ cwd: copy });
  await writeFile(join(copy, 'edit.txt'), 'agent'); await writeFile(join(copy, 'gone.txt'), 'agent'); await rm(join(copy, 'delete.txt')); await writeFile(join(copy, 'new.txt'), 'agent');
  const changes = diffAgentWorkspace(before, await captureAgentWorkspace({ cwd: copy }));
  await writeFile(join(cwd, 'edit.txt'), 'human'); await writeFile(join(cwd, 'delete.txt'), 'human'); await rm(join(cwd, 'gone.txt')); await writeFile(join(cwd, 'new.txt'), 'human');
  const applied = await applyAgentChanges({ cwd, changes });
  assert.equal(applied.applied.length, 0); assert.equal(applied.conflicts.length, 4);
  for (const name of ['edit.txt', 'delete.txt', 'new.txt']) assert.equal(await readFile(join(cwd, name), 'utf8'), 'human');
  assert.equal((await readdir(cwd)).includes('gone.txt'), false);
});

test('all proposal paths and hashes are validated before any writes', async t => {
  const { cwd } = await fixture(t);
  for (const path of ['../outside.txt', '/outside.txt', 'C:/outside.txt', '.env', 'nested\\bad.txt', 'NUL.txt']) {
    await assert.rejects(applyAgentChanges({ cwd, changes: proposal([addition('good.txt', 'safe'), addition(path, 'bad')]) }), /invalid|Unsafe|excluded/i);
    assert.deepEqual(await readdir(cwd), []);
  }
  const bad = addition('wrong.txt', 'safe'); bad.afterHash = '0'.repeat(64);
  await assert.rejects(applyAgentChanges({ cwd, changes: proposal([addition('good.txt', 'safe'), bad]) }), /integrity/);
  assert.deepEqual(await readdir(cwd), []);
});

test('symbolic parents and hard-linked original targets cannot redirect an apply', async t => {
  const { root, cwd } = await fixture(t); const outside = join(root, 'outside'); await mkdir(outside);
  await writeFile(join(outside, 'shared.txt'), 'outside');
  try { await symlink(outside, join(cwd, 'redirect'), process.platform === 'win32' ? 'junction' : 'dir'); }
  catch (error) { if (error.code === 'EPERM') { t.skip('Host does not permit symbolic links'); return; } throw error; }
  await link(join(outside, 'shared.txt'), join(cwd, 'shared.txt'));
  const changed = { ...addition('shared.txt', 'agent'), kind: 'modified', beforeHash: hash('outside'), beforeContent: Buffer.from('outside').toString('base64') };
  const applied = await applyAgentChanges({ cwd, changes: proposal([addition('redirect/new.txt', 'agent'), changed]) });
  assert.equal(applied.applied.length, 0); assert.equal(applied.conflicts.length, 2);
  assert.equal(await readFile(join(outside, 'shared.txt'), 'utf8'), 'outside');
  assert.deepEqual(await readdir(outside), ['shared.txt']);
});

test('capture omits credentials binary invalid UTF-8 and snapshot instruction markers without corrupting source', async t => {
  const { cwd } = await fixture(t), secret = 'synthetic-agent-private-key';
  for (const [path, value] of [['.env', `KEY=${secret}`], ['code.js', `const key="${secret}";`], ['password.js', 'const password = "hunter22!";'], ['placeholder.js', 'const key = "[redacted]";'], ['valid.js', 'const one = 1;\r\n'], ['.snapshot-owner', 'marker'], ['.source-AGENTS.md', 'untrusted instructions']]) await writeFile(join(cwd, path), value);
  await writeFile(join(cwd, 'binary.dat'), Buffer.from([0, 1, 2])); await writeFile(join(cwd, 'invalid.dat'), Buffer.from([0xff, 0xfe]));
  const captured = await captureAgentWorkspace({ cwd, secrets: () => [secret] });
  assert.deepEqual(captured.files.map(file => file.path), ['valid.js']); assert.equal(captured.partial, true);
  assert.ok(!JSON.stringify(captured).includes(secret));
  assert.equal(await readFile(join(cwd, 'code.js'), 'utf8'), `const key="${secret}";`);
  await writeFile(join(cwd, 'new.txt'), 'safe');
  const changes = diffAgentWorkspace(captured, await captureAgentWorkspace({ cwd, secrets: () => [secret] }));
  assert.deepEqual(changes.files.map(file => file.path), ['new.txt']);
});

test('partial bounded scans do not infer deletion or addition for missing coverage', async t => {
  const { cwd } = await fixture(t);
  await writeFile(join(cwd, 'one.txt'), 'one'); await writeFile(join(cwd, 'two.txt'), 'two'); await writeFile(join(cwd, 'three.txt'), 'three');
  const before = await captureAgentWorkspace({ cwd, maxFiles: 1 }); assert.equal(before.files.length, 1); assert.equal(before.partial, true);
  await rm(join(cwd, before.files[0].path));
  const changes = diffAgentWorkspace(before, await captureAgentWorkspace({ cwd, maxFiles: 1 }));
  assert.equal(changes.files.length, 0); assert.equal(changes.partial, true);
  await assert.rejects(captureAgentWorkspace({ cwd, maxFileBytes: 2 * 1024 * 1024 }), /bounded limit/);
});

test('private immutable agent results survive reopening support true diff and remain project scoped', async t => {
  const { cwd, copy, stateDir } = await fixture(t);
  for (const folder of [cwd, copy]) await writeFile(join(folder, 'code.js'), 'before\n');
  const before = await captureAgentWorkspace({ cwd: copy }); await writeFile(join(copy, 'code.js'), 'after\n');
  const changes = diffAgentWorkspace(before, await captureAgentWorkspace({ cwd: copy }));
  const results = await createAgentResults({ cwd, stateDir, maxRuns: 2 });
  const saved = await results.save({ task: 'Implement code', status: 'completed', results: [{ name: 'Coder', role: 'coder', mode: 'edit', status: 'completed', text: 'Proposed', model: 'Local model', changes }] });
  assert.equal(saved.verified, false); assert.equal(saved.results[0].verified, false); assert.equal(saved.results[0].changes.files[0].beforeContent, Buffer.from('before\n').toString('base64'));
  assert.equal(await readFile(join(cwd, 'code.js'), 'utf8'), 'before\n');
  const reopened = await createAgentResults({ cwd, stateDir, maxRuns: 2 });
  assert.deepEqual((await reopened.get(saved.id)).results, saved.results);
  assert.equal((await reopened.list())[0].results[0].changes, 1);
  assert.deepEqual(await (await createAgentResults({ cwd: copy, stateDir })).list(), []);
  const second = await reopened.save({ task: 'Second', results: [] }); await reopened.save({ task: 'Third', results: [] });
  assert.equal((await reopened.list()).length, 2); await assert.rejects(reopened.get(saved.id), /not found/);
  await reopened.remove(second.id); assert.equal((await reopened.list()).length, 1);
  assert.equal(await readFile(join(cwd, 'code.js'), 'utf8'), 'before\n');
});

test('result persistence redacts descriptive output but omits secret code proposals completely', async t => {
  const { root, cwd, stateDir } = await fixture(t), secret = 'synthetic-agent-private-key';
  const store = await createAgentResults({ cwd, stateDir, secrets: () => [secret] });
  const saved = await store.save({ task: `Task ${secret}`, connection: { apiKey: secret }, results: [{ name: 'Coder', role: 'coder', status: 'completed', text: `Output ${secret}`, apiKey: secret,
    error: `Error ${secret}`, changes: proposal([addition('code.js', `const key="${secret}";`), addition('safe.js', 'let value = 1;')]) }] });
  assert.equal(saved.results[0].changes.files.length, 1); assert.equal(saved.partial, true); assert.equal(saved.results[0].changes.files[0].path, 'safe.js');
  const storage = join(stateDir, 'agent-results', hash(await realpath(cwd)).slice(0, 32));
  const bytes = await readFile(join(storage, `${saved.id}.json`), 'utf8');
  assert.ok(!bytes.includes(secret)); assert.ok(!bytes.includes('apiKey')); assert.ok(!bytes.includes('"agents":'));
  const applied = await applyAgentChanges({ cwd, changes: proposal([addition('unsafe.js', secret)]), secrets: () => [secret] });
  assert.equal(applied.applied.length, 0); assert.equal(applied.skipped.length, 1); assert.deepEqual(await readdir(cwd), []); assert.ok(root);
});

test('cancelled apply and invalid saved identifiers never alter source', async t => {
  const { cwd, stateDir } = await fixture(t); const controller = new AbortController(); controller.abort();
  await assert.rejects(applyAgentChanges({ cwd, changes: proposal([addition('new.txt', 'new')]), signal: controller.signal }), { name: 'AbortError' });
  const store = await createAgentResults({ cwd, stateDir });
  await assert.rejects(store.get('../escape'), /identifier/); await assert.rejects(store.remove('../escape'), /identifier/);
  assert.deepEqual(await readdir(cwd), []);
});

test('modified Linux scripts preserve original executable mode and ownership instead of private snapshot mode', { skip: process.platform === 'win32' }, async t => {
  const { cwd, copy } = await fixture(t);
  for (const folder of [cwd, copy]) await writeFile(join(folder, 'run.sh'), '#!/bin/sh\nprintf before\n');
  await chmod(join(cwd, 'run.sh'), 0o755); const original = await lstat(join(cwd, 'run.sh'));
  const before = await captureAgentWorkspace({ cwd: copy }); await writeFile(join(copy, 'run.sh'), '#!/bin/sh\nprintf after\n');
  const applied = await applyAgentChanges({ cwd, changes: diffAgentWorkspace(before, await captureAgentWorkspace({ cwd: copy })) });
  assert.deepEqual(applied.applied, ['run.sh']); const actual = await lstat(join(cwd, 'run.sh'));
  assert.equal(actual.mode & 0o777, 0o755); assert.equal(actual.uid, original.uid); assert.equal(actual.gid, original.gid);
});

test('saved reports reject linked records and substituted symbolic storage', async t => {
  const { root, cwd, stateDir } = await fixture(t), store = await createAgentResults({ cwd, stateDir });
  const saved = await store.save({ task: 'report', results: [] });
  const storage = join(stateDir, 'agent-results', hash(await realpath(cwd)).slice(0, 32));
  const path = join(storage, `${saved.id}.json`); await link(path, join(root, 'shared-record.json'));
  await assert.rejects(store.get(saved.id), /invalid/); await assert.rejects(store.remove(saved.id), /invalid/);
  await rm(join(root, 'shared-record.json')); await rm(storage, { recursive: true }); const outside = join(root, 'outside'); await mkdir(outside);
  try { await symlink(outside, storage, process.platform === 'win32' ? 'junction' : 'dir'); }
  catch (error) { if (error.code === 'EPERM') { t.skip('Host does not permit symbolic links'); return; } throw error; }
  await assert.rejects(store.save({ task: 'unsafe', results: [] }), /storage changed/); assert.deepEqual(await readdir(outside), []);
});

test('Windows agent result storage accepts a native case alias without losing project or record identity', {skip:process.platform!=='win32'},async t=>{
  const {root,cwd}=await fixture(t),stateDir=join(root,'PrIvAtE-StAtE'),alias=join(root,'pRiVaTe-sTaTe');
  await mkdir(stateDir);const original=await lstat(stateDir),aliased=await lstat(alias);
  assert.equal(original.dev,aliased.dev);assert.equal(original.ino,aliased.ino);
  assert.notEqual(alias,await realpath(alias),'this fixture must exercise a real native spelling alias');
  const store=await createAgentResults({cwd,stateDir:alias}),saved=await store.save({task:'Case alias result',results:[]});
  const reopened=await createAgentResults({cwd,stateDir});assert.equal((await reopened.get(saved.id)).task,'Case alias result');
  assert.deepEqual((await store.list()).map(row=>row.id),[saved.id]);
  await reopened.remove(saved.id);assert.deepEqual(await store.list(),[]);
});
