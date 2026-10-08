import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createTaskInbox } from '../src/task-inbox.mjs';

async function fixture(t) {
  const cwd = await mkdtemp(join(tmpdir(), 'codexcli-schedules-'));
  t.after(() => rm(cwd, { recursive: true, force: true }));
  const inbox = await createTaskInbox({ cwd, stateDir: join(cwd, 'state') });
  const { createScheduler } = await import('../src/scheduler.mjs');
  let now = Date.parse('2026-10-08T12:00:00Z');
  return { inbox, scheduler: await createScheduler({ inbox, clock: () => now }), clock: () => now, advance(ms) { now += ms; } };
}

test('idempotent inbox submission converges across concurrent sessions and rejects changed content', async t => {
  const { inbox } = await fixture(t);
  const second = await createTaskInbox({ cwd: inbox.cwd, stateDir: inbox.stateDir });
  const input = { prompt: 'Inspect the project', source: 'schedule', idempotencyKey: 'daily:2026-10-08' };
  const values = await Promise.all([inbox.submit(input), second.submit(input)]);
  assert.equal(values[0].id, values[1].id);
  assert.equal((await inbox.list()).length, 1);
  await assert.rejects(inbox.submit({ ...input, prompt: 'Different task' }), /idempotenc|different/i);
});

test('durable scheduler enqueues a due occurrence once across reopen and concurrent ticks', async t => {
  const { scheduler, inbox, clock } = await fixture(t);
  await scheduler.add({ id: 'daily-review', prompt: 'Review pending work', at: clock(), intervalMs: 86400000 });
  const { createScheduler } = await import('../src/scheduler.mjs');
  const reopened = await createScheduler({ inbox, clock });
  await Promise.all([scheduler.tick(), reopened.tick(), scheduler.tick()]);
  assert.equal((await inbox.list()).length, 1);
  assert.equal((await reopened.list())[0].nextAt, clock() + 86400000);
});

test('scheduler retries ambiguous enqueue errors through idempotency and never retries failed task execution', async t => {
  const { scheduler, inbox, clock, advance } = await fixture(t);
  await scheduler.add({ id: 'once', prompt: 'Perform the approved work', at: clock(), maxAttempts: 2, retryDelayMs: 1000 });
  const submit = inbox.submit;
  let interrupted = true;
  inbox.submit = async input => { const task = await submit(input); if (interrupted) { interrupted = false; throw new Error('Connection lost after durable write'); } return task; };
  await scheduler.tick();
  assert.equal((await inbox.list()).length, 1);
  advance(1000); await scheduler.tick();
  const job = (await inbox.list())[0];
  await inbox.update(job.id, { status: 'failed', reason: 'Execution interrupted after side effect' });
  advance(10000); await scheduler.tick();
  assert.equal((await inbox.list()).length, 1);
  assert.equal((await inbox.get(job.id)).status, 'failed');
});
