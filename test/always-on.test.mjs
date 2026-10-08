import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createTaskInbox } from '../src/task-inbox.mjs';
import { createAlwaysOn } from '../src/always-on.mjs';

const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(predicate, ms = 4000) {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) { if (await predicate()) return; await delay(10); }
  assert.fail('Coordinator did not reach its expected state in time.');
}
async function fixture(t, options = {}) {
  const root = await mkdtemp(join(tmpdir(), 'codexcli-always-on-'));
  const cwd = join(root, 'project'); await mkdir(cwd);
  const inbox = await createTaskInbox({ cwd, stateDir: join(root, 'state') });
  const agent = createAlwaysOn({ inbox, pollMs: 10, idleSleepMs: 40, ...options });
  t.after(async () => { await agent.stop(); await rm(root, { recursive: true, force: true }); });
  return { root, cwd, inbox, agent };
}

test('an idle coordinator makes no model calls and submits work only when explicitly requested', async t => {
  let assessed = 0, cloud = 0;
  const { agent, inbox } = await fixture(t, { assess: async () => { assessed++; return { action: 'cloud' }; }, runCloud: async () => { cloud++; return 'Completed'; } });
  await agent.start(); await delay(90);
  assert.equal(assessed, 0); assert.equal(cloud, 0);
  const job = await agent.submit({ prompt: 'Explicit task' });
  await until(async () => (await inbox.get(job.id)).status === 'completed');
  assert.equal(assessed, 1); assert.equal(cloud, 1);
  assert.equal((await inbox.get(job.id)).result, 'Completed');
});

test('local and wait decisions never invoke cloud and wait does not retry automatically', async t => {
  let assessed = 0, cloud = 0;
  const { agent, inbox } = await fixture(t, { assess: async job => { assessed++; return job.prompt === 'Local' ? { action: 'local', result: 'Handled locally' } : { action: 'wait', reason: 'Need more input' }; }, runCloud: async () => { cloud++; } });
  await agent.start();
  const local = await agent.submit({ prompt: 'Local' });
  const wait = await agent.submit({ prompt: 'Wait' });
  await until(async () => (await inbox.get(wait.id)).status === 'blocked');
  assert.equal((await inbox.get(local.id)).result, 'Handled locally');
  await delay(80);
  assert.equal(assessed, 2); assert.equal(cloud, 0);
});

test('malformed local decisions block the task without invoking a costly worker', async t => {
  let cloud = 0;
  const { agent, inbox } = await fixture(t, { assess: async () => ({ action: 'launch anything', instructions: 'private payload' }), runCloud: async () => { cloud++; } });
  await agent.start(); const job = await agent.submit({ prompt: 'Task' });
  await until(async () => (await inbox.get(job.id)).status === 'blocked');
  assert.equal(cloud, 0);
  assert.match((await inbox.get(job.id)).reason, /invalid decision/i);
});

test('wake hooks run before cloud, sleep after idle, and failed wake prevents the cloud call', async t => {
  const events = [];
  const { agent, inbox } = await fixture(t, { assess: async () => ({ action: 'cloud', prompt: 'Assessed task' }), wake: async () => events.push('wake'), sleep: async () => events.push('sleep'), runCloud: async job => { events.push(job.prompt); return 'Done'; } });
  await agent.start(); const job = await agent.submit({ prompt: 'Task' });
  await until(async () => (await inbox.get(job.id)).status === 'completed');
  const runIndex = events.indexOf('Assessed task');
  await until(() => events.slice(runIndex + 1).includes('sleep'));
  assert.equal(events[runIndex - 1], 'wake', 'Wake must precede the cloud call even when an initial idle sleep already occurred.');
  const failures = [];
  const failed = await fixture(t, { assess: async () => ({ action: 'cloud' }), wake: async () => { throw new Error('Wake failed'); }, runCloud: async () => failures.push('cloud'), onError: error => failures.push(error.message) });
  await failed.agent.start(); const other = await failed.agent.submit({ prompt: 'Task' });
  await until(async () => (await failed.inbox.get(other.id)).status === 'blocked');
  assert.equal(failures.includes('cloud'), false); assert.ok(failures.some(value => /Wake failed/.test(value)));
});

test('stop aborts a running worker and leaves its task blocked for explicit recovery', async t => {
  let aborted = false;
  const { agent, inbox } = await fixture(t, { assess: async () => ({ action: 'cloud' }), runCloud: async (_job, { signal }) => new Promise((resolve, reject) => {
    signal.addEventListener('abort', () => { aborted = true; reject(signal.reason); }, { once: true });
  }) });
  await agent.start(); const job = await agent.submit({ prompt: 'Long task' });
  await until(() => agent.snapshot().state === 'working');
  await agent.stop();
  assert.equal(aborted, true);
  assert.equal((await inbox.get(job.id)).status, 'blocked');
  assert.equal(agent.snapshot().state, 'stopped');
  await agent.start(); await delay(60);
  assert.equal((await inbox.get(job.id)).status, 'blocked');
});

test('sleep failure is reported once and does not trigger a busy retry loop', async t => {
  const errors = [];
  let slept = 0;
  const { agent } = await fixture(t, { assess: async () => ({ action: 'wait' }), runCloud: async () => '', sleep: async () => { slept++; throw new Error('Sleep failed'); }, onError: error => errors.push(error.message) });
  await agent.start(); await until(() => errors.length === 1); await delay(90);
  assert.equal(slept, 1); assert.equal(agent.snapshot().cloudState, 'error');
});

test('explicit standing goals assess locally on a heartbeat and waiting never wakes cloud', async t => {
  let assessed = 0, cloud = 0;
  const { agent, inbox } = await fixture(t, { standingGoal: 'Watch for assigned tasks', heartbeatMs: 30, assess: async () => { assessed++; return { action: 'wait', reason: 'Nothing to do' }; }, runCloud: async () => { cloud++; } });
  await agent.start(); await until(() => assessed >= 2); await agent.stop();
  assert.equal(cloud, 0); assert.deepEqual(await inbox.list(), []);
});

test('folder watches create one task for external changes and ignore worker feedback and metadata', async t => {
  let processed = 0;
  const root = await mkdtemp(join(tmpdir(), 'codexcli-always-on-watch-'));
  const cwd = join(root, 'project'); await mkdir(cwd);
  await mkdir(join(cwd, '.git')); await mkdir(join(cwd, 'node_modules'));
  const inbox = await createTaskInbox({ cwd, stateDir: join(cwd, '.sudocli-state') });
  const agent = createAlwaysOn({ inbox, pollMs: 10, idleSleepMs: 40, watchDebounceMs: 25, watchPaths: [cwd], assess: async () => ({ action: 'cloud' }), runCloud: async () => { processed++; await writeFile(join(cwd, 'worker-output.txt'), 'worker feedback'); return 'Done'; } });
  t.after(async () => { await agent.stop(); await rm(root, { recursive: true, force: true }); }); await agent.start();
  await writeFile(join(cwd, '.git', 'ignored'), 'ignore');
  await writeFile(join(cwd, 'node_modules', 'ignored'), 'ignore');
  await writeFile(join(cwd, 'source.txt'), 'External task');
  await until(() => processed === 1);
  await delay(250);
  assert.equal(processed, 1);
  assert.equal((await inbox.list()).length, 1);
});

test('outside-project watch paths are rejected before starting a worker', async t => {
  const { root, agent } = await fixture(t, { assess: async () => ({ action: 'wait' }), runCloud: async () => '', watchPaths: [tmpdir()] });
  await assert.rejects(agent.start(), /project|watch/i);
  assert.equal(agent.snapshot().state, 'stopped');
});

test('permissions requiring human approval block cloud jobs instead of granting permissions or retrying', async t => {
  let runs = 0;
  const { agent, inbox } = await fixture(t, { assess: async () => ({ action: 'cloud' }), runCloud: async () => { runs++; const error = new Error('Human approval is required'); error.code = 'APPROVAL_REQUIRED'; throw error; } });
  await agent.start(); const job = await agent.submit({ prompt: 'Privileged action' });
  await until(async () => (await inbox.get(job.id)).status === 'blocked');
  await delay(70);
  assert.equal(runs, 1); assert.match((await inbox.get(job.id)).reason, /approval/i);
});

test('cloud failures are durable failed tasks and never retry by themselves', async t => {
  let runs = 0;
  const { agent, inbox } = await fixture(t, { assess: async () => ({ action: 'cloud' }), runCloud: async () => { runs++; throw new Error('Backend unavailable'); } });
  await agent.start(); const job = await agent.submit({ prompt: 'Task' });
  await until(async () => (await inbox.get(job.id)).status === 'failed');
  await delay(70);
  assert.equal(runs, 1); assert.match((await inbox.get(job.id)).reason, /Backend unavailable/);
});

test('standing goal does not repeatedly schedule the same cloud task without a fresh local decision', async t => {
  let runs = 0;
  const { agent, inbox } = await fixture(t, { standingGoal: 'Watch for jobs', heartbeatMs: 35, assess: async () => ({ action: 'cloud', prompt: 'Same assigned task' }), runCloud: async () => { runs++; return 'Done'; } });
  await agent.start(); await until(() => runs === 1); await delay(160);
  assert.equal(runs, 1); assert.equal((await inbox.list()).length, 1);
});

test('a local completion decision requires a nonempty result instead of silently claiming success', async t => {
  const { agent, inbox } = await fixture(t, { assess: async () => ({ action: 'local', reason: 'Looks easy' }), runCloud: async () => assert.fail('Invalid local decision must never invoke cloud') });
  await agent.start(); const job = await agent.submit({ prompt: 'Task' });
  await until(async () => (await inbox.get(job.id)).status === 'blocked');
  assert.match((await inbox.get(job.id)).reason, /invalid decision/i);
});

test('GPU acknowledgements leave coordinator power and billing unknown while verified status is displayed', async t => {
  const { agent, inbox } = await fixture(t, { assess: async () => ({ action: 'cloud' }), wake: async () => ({ ok: true }), sleep: async () => ({ ok: true }), runCloud: async () => 'Done' });
  await agent.start(); const job = await agent.submit('Work');
  await until(async () => (await inbox.get(job.id)).status === 'completed');
  assert.equal(agent.snapshot().cloudState, 'unknown');
  assert.equal(agent.snapshot().cloudBilling, 'unknown');
  const verified = await fixture(t, { assess: async () => ({ action: 'cloud' }), wake: async () => ({ verified: true, state: 'running', billing: 'active' }), sleep: async () => ({ verified: true, state: 'stopped', billing: 'storage-only' }), runCloud: async () => 'Done' });
  await verified.agent.start(); const other = await verified.agent.submit('Work');
  await until(async () => (await verified.inbox.get(other.id)).status === 'completed');
  await until(() => verified.agent.snapshot().cloudState === 'asleep');
  assert.equal(verified.agent.snapshot().cloudBilling, 'storage-only');
});

test('coordinator closes task budget lifecycle after a provider failure', async t => {
  const lifecycle = [];
  const { agent, inbox } = await fixture(t, { assess: async () => ({ action: 'cloud' }), runCloud: async () => { throw new Error('Provider failed'); }, beginTask: async id => lifecycle.push(`begin:${id}`), endTask: async id => lifecycle.push(`end:${id}`) });
  await agent.start(); const job = await agent.submit('Work');
  await until(async () => (await inbox.get(job.id)).status === 'failed');
  await until(() => lifecycle.length === 2);
  assert.deepEqual(lifecycle, [`begin:${job.id}`, `end:${job.id}`]);
});

test('coordinator ticks durable schedules without idle model requests', async t => {
  let assessments = 0;
  const { agent, inbox } = await fixture(t, { assess: async () => { assessments++; return { action: 'local', result: 'Scheduled task completed' }; }, runCloud: async () => assert.fail('Local scheduled work should not use cloud') });
  const { createScheduler } = await import('../src/scheduler.mjs');
  const scheduler = await createScheduler({ inbox });
  const scheduled = createAlwaysOn({ inbox, scheduler, pollMs: 10, idleSleepMs: 40, assess: async () => { assessments++; return { action: 'local', result: 'Scheduled task completed' }; }, runCloud: async () => assert.fail('Cloud should remain idle') });
  // Stop this additional worker before the fixture removes its inbox. Registered
  // after-hooks run in order, so a later stop hook races earlier directory cleanup.
  try {
    await scheduler.add({ id: 'scheduled-proof', prompt: 'Explicit local work', at: Date.now() + 40 });
    await scheduled.start();
    await until(async () => (await inbox.list())[0]?.status === 'completed');
    await delay(50); assert.equal(assessments, 1);
  } finally { await scheduled.stop(); }
});

test('stop between durable running status and dispatch prevents an already cancelled cloud call', async t => {
  let calls = 0, stopping;
  const { agent, inbox } = await fixture(t, { assess: async () => ({ action: 'cloud' }), runCloud: async () => { calls++; return 'Unexpected dispatch'; } });
  const update = inbox.update;
  inbox.update = async (id, patch) => { const result = await update(id, patch); if (patch.status === 'running') stopping = agent.stop(); return result; };
  await agent.start(); const job = await agent.submit('Work');
  await until(() => stopping !== undefined); await stopping;
  assert.equal(calls, 0);
  assert.equal((await inbox.get(job.id)).status, 'blocked');
});

test('whole task duration budget interrupts native work between provider requests', { timeout: 3000 }, async t => {
  const { agent, inbox } = await fixture(t, { beginTask: async () => ({ timeoutMs: 100 }), endTask: async () => {}, assess: async () => ({ action: 'cloud' }), runCloud: async (_job, { signal }) => new Promise((resolve, reject) => { if (signal.aborted) reject(signal.reason); else signal.addEventListener('abort', () => reject(signal.reason), { once: true }); }) });
  await agent.start(); const job = await agent.submit('Bounded native work');
  await until(async () => (await inbox.get(job.id)).status === 'blocked', 1500);
  await until(() => agent.snapshot().state === 'idle');
  assert.match((await inbox.get(job.id)).reason, /duration|budget/i);
});
test('durable background completion waits for acceptance and records its failure',async t=>{
  let checking=false,release;
  const gate=new Promise(resolve=>{release=resolve;});
  t.after(()=>release());
  const {agent,inbox}=await fixture(t,{assess:async()=>({action:'local',result:'Model claims success.'}),runCloud:async()=>assert.fail('Local completion should not call cloud'),onTaskResult:async(_job,patch)=>{checking=true;await gate;return {...patch,status:'failed',reason:'Selected acceptance check failed.'};}});
  try{
    await agent.start();const job=await agent.submit('Check the actual work');
    await until(()=>checking);assert.notEqual((await inbox.get(job.id)).status,'completed');
    release();await until(async()=>(await inbox.get(job.id)).status==='failed');
    assert.equal(agent.snapshot().completed,0);assert.match((await inbox.get(job.id)).reason,/acceptance check failed/);
  }finally{release();}
});
