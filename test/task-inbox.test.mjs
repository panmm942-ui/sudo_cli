import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile, readdir, rm, symlink } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createTaskInbox } from '../src/task-inbox.mjs';

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'codexcli-task-inbox-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const cwd = join(root, 'project'); await mkdir(cwd);
  return { root, cwd, stateDir: join(root, 'state') };
}

test('task submissions and completion persist through independent inbox instances', async t => {
  const paths = await fixture(t);
  const inbox = await createTaskInbox(paths);
  const job = await inbox.submit({ prompt: 'Fix the parser', source: 'terminal' });
  assert.equal(job.status, 'pending');
  await inbox.update(job.id, { status: 'assessing' });
  await inbox.update(job.id, { status: 'running' });
  await inbox.update(job.id, { status: 'completed', result: 'Parser fixed' });
  const fresh = await createTaskInbox(paths);
  assert.equal((await fresh.get(job.id)).result, 'Parser fixed');
  assert.equal((await fresh.list())[0].status, 'completed');
});

test('opening an inbox never interrupts a live job and explicit recovery blocks interrupted work', async t => {
  const paths = await fixture(t);
  const inbox = await createTaskInbox(paths);
  const one = await inbox.submit({ prompt: 'One' });
  const two = await inbox.submit({ prompt: 'Two' });
  await inbox.update(one.id, { status: 'assessing' });
  await inbox.update(two.id, { status: 'assessing' });
  await inbox.update(two.id, { status: 'running' });
  const fresh = await createTaskInbox(paths);
  assert.equal((await fresh.get(two.id)).status, 'running');
  const lease = await fresh.acquireWorker();
  const recovered = await fresh.recoverInterrupted();
  assert.equal(recovered.length, 2);
  assert.ok((await fresh.list()).every(job => job.status === 'blocked'));
  assert.match((await fresh.get(one.id)).reason, /interrupted/i);
  assert.equal((await fresh.recoverInterrupted()).length, 0);
  await lease.release();
});

test('only one worker may own a project and release permits a later worker', async t => {
  const paths = await fixture(t);
  const one = await createTaskInbox(paths);
  const two = await createTaskInbox(paths);
  const lease = await one.acquireWorker();
  await assert.rejects(two.acquireWorker(), /already|worker|session/i);
  await lease.release();
  const next = await two.acquireWorker();
  await next.release();
});

test('task records strip keys and terminal controls and ignore arbitrary payload fields', async t => {
  const paths = await fixture(t);
  const inbox = await createTaskInbox({ ...paths, secrets: () => ['fixture-key'] });
  const job = await inbox.submit({ prompt: 'Do not write fixture-key\u001b[31m', source: 'fixture-key', apiKey: 'fixture-key' });
  await inbox.update(job.id, { status: 'assessing', reason: 'fixture-key', payload: { raw: 'private data' } });
  await inbox.update(job.id, { status: 'completed', result: 'Finished with fixture-key' });
  const text = await readFile(join(inbox.directory, `task-${job.id}.json`), 'utf8');
  assert.doesNotMatch(text, /fixture-key|private data|payload|apiKey|\\u001b/);
  assert.match(text, /\[redacted\]/);
});

test('project task lists are isolated and corrupted tasks are skipped without replacement', async t => {
  const paths = await fixture(t);
  const otherCwd = join(paths.root, 'other'); await mkdir(otherCwd);
  const inbox = await createTaskInbox(paths);
  const other = await createTaskInbox({ ...paths, cwd: otherCwd });
  const job = await inbox.submit({ prompt: 'Current project' });
  await other.submit({ prompt: 'Other project' });
  const path = join(inbox.directory, `task-${job.id}.json`);
  await writeFile(path, '{invalid');
  assert.deepEqual(await inbox.list(), []);
  assert.equal(inbox.warnings().length, 1);
  await assert.rejects(inbox.update(job.id, { status: 'blocked' }), /invalid/i);
  assert.equal(await readFile(path, 'utf8'), '{invalid');
  assert.equal((await other.list()).length, 1);
});

test('invalid transitions and oversized tasks leave existing tasks unchanged', async t => {
  const paths = await fixture(t);
  const inbox = await createTaskInbox(paths);
  const job = await inbox.submit({ prompt: 'Safe task' });
  await assert.rejects(inbox.update(job.id, { status: 'completed' }), /transition/i);
  await assert.rejects(inbox.update('../outside', { status: 'blocked' }), /identifier/i);
  await assert.rejects(inbox.submit({ prompt: 'a'.repeat(1024 * 1024 + 1) }), /size|limit/i);
  assert.equal((await inbox.get(job.id)).status, 'pending');
  assert.equal((await readdir(inbox.directory)).some(name => name.endsWith('.tmp') || name.endsWith('.lock')), false);
});

test('task record symlinks are refused without touching the target', async t => {
  const paths = await fixture(t);
  const inbox = await createTaskInbox(paths);
  const job = await inbox.submit({ prompt: 'Safe task' });
  const outside = join(paths.root, 'outside.json'); await writeFile(outside, 'untouched');
  const path = join(inbox.directory, `task-${job.id}.json`); await rm(path);
  try { await symlink(outside, path, 'file'); } catch (error) {
    if (process.platform === 'win32' && ['EPERM', 'EACCES', 'UNKNOWN'].includes(error.code)) { t.skip('Windows file symlinks require Developer Mode or elevated test privileges.'); return; }
    throw error;
  }
  await assert.rejects(inbox.get(job.id), /invalid|link/i);
  assert.equal(await readFile(outside, 'utf8'), 'untouched');
});

test('concurrent status readers observe valid atomic generations during repeated updates', async t => {
  const paths = await fixture(t);
  const inbox = await createTaskInbox(paths);
  const job = await inbox.submit({ prompt: 'Checkpoint task' });
  await inbox.update(job.id, { status: 'assessing' });
  const writes = (async () => { for (let index = 0; index < 25; index++) await inbox.update(job.id, { status: 'assessing', reason: `Checkpoint ${index}` }); })();
  const reads = (async () => { for (let index = 0; index < 80; index++) assert.equal((await inbox.get(job.id)).status, 'assessing'); })();
  await Promise.all([writes, reads]);
});
