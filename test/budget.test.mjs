import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from './fixtures/temp-root.mjs';
import { join } from 'node:path';

async function fixture(t, options = {}) {
  const cwd = await mkdtemp(join(tmpdir(), 'codexcli-budget-'));
  t.after(() => rm(cwd, { recursive: true, force: true }));
  const { createBudgetLedger } = await import('../src/budget.mjs');
  let now = Date.parse('2026-10-08T12:00:00Z');
  return { cwd, advance(ms) { now += ms; }, ledger: await createBudgetLedger({ cwd, stateDir: join(cwd, 'state'), clock: () => now, ...options }) };
}

test('budget reservations prevent concurrent requests from spending the same remaining allowance', async t => {
  const { ledger, cwd } = await fixture(t, { policy: { task: { tokens: 100, requests: 1 } } });
  const { createBudgetLedger } = await import('../src/budget.mjs');
  const second = await createBudgetLedger({ cwd, stateDir: join(cwd, 'state'), clock: () => Date.parse('2026-10-08T12:00:00Z'), policy: { task: { tokens: 100, requests: 1 } } });
  await ledger.beginTask('task');
  const results = await Promise.allSettled([
    ledger.reserve({ taskId: 'task', requestId: 'a', estimate: { inputTokens: 10, outputTokens: 80, durationMs: 1000 } }),
    second.reserve({ taskId: 'task', requestId: 'b', estimate: { inputTokens: 10, outputTokens: 80, durationMs: 1000 } }),
  ]);
  assert.equal(results.filter(value => value.status === 'fulfilled').length, 1);
  assert.equal(results.find(value => value.status === 'rejected').reason.code, 'BUDGET_EXCEEDED');
  assert.equal((await ledger.snapshot({ taskId: 'task' })).task.requests, 1);
});

test('request hooks clamp output and timeout, account actual usage, and retain missing usage estimates', async t => {
  const { ledger, advance } = await fixture(t, { policy: { task: { tokens: 100, durationMs: 5000 } } });
  await ledger.beginTask('task');
  const hooks = ledger.requestHooks({ taskId: 'task', maxOutputTokens: 1000, durationMs: 120000 });
  const admitted = await hooks.beforeRequest({ id: 'a', inputTokensEstimate: 10 });
  assert.equal(admitted.maxOutputTokens, 90);
  assert.equal(admitted.timeoutMs, 5000);
  advance(1000);
  await hooks.onUsage({ id: 'a', inputTokens: 10, outputTokens: 20, totalTokens: 30, estimated: false });
  await hooks.afterRequest({ id: 'a', outcome: 'succeeded', durationMs: 1000 });
  const next = await hooks.beforeRequest({ id: 'b', inputTokensEstimate: 5, maxOutputTokens: 10 });
  assert.equal(next.maxOutputTokens, 10);
  advance(500);
  await hooks.afterRequest({ id: 'b', outcome: 'failed', durationMs: 500 });
  const state = await ledger.snapshot({ taskId: 'task' });
  assert.equal(state.task.tokens, 45);
  assert.equal(state.task.estimatedRequests, 1);
  assert.equal(state.task.durationMs, 1500);
});

test('cost caps fail closed without configured pricing and rate based costs are explicitly estimates', async t => {
  const { ledger } = await fixture(t, { policy: { day: { costUsd: 1 } } });
  const missing = ledger.requestHooks({ taskId: 'task', maxOutputTokens: 10 });
  await assert.rejects(missing.beforeRequest({ id: 'a', inputTokensEstimate: 10 }), { code: 'BUDGET_EXCEEDED' });
  const priced = ledger.requestHooks({ taskId: 'task', pricing: { inputUsdPerMillion: 2, outputUsdPerMillion: 4 }, maxOutputTokens: 10 });
  await priced.beforeRequest({ id: 'b', inputTokensEstimate: 10 });
  await priced.onUsage({ id: 'b', inputTokens: 10, outputTokens: 5, totalTokens: 15, estimated: false });
  await priced.afterRequest({ id: 'b', outcome: 'succeeded', durationMs: 1 });
  const state = await ledger.snapshot({ taskId: 'task' });
  assert.equal(state.day.costUsd, 0.00004);
  assert.equal(state.costEstimated, true);
});

test('daily reservations survive reopen and reset only after in flight requests finish', async t => {
  const { ledger, cwd } = await fixture(t, { policy: { day: { requests: 1 } } });
  await ledger.reserve({ taskId: 'task', requestId: 'a', estimate: { inputTokens: 1, outputTokens: 1, durationMs: 1 } });
  const { createBudgetLedger } = await import('../src/budget.mjs');
  const reopened = await createBudgetLedger({ cwd, stateDir: join(cwd, 'state'), clock: () => Date.parse('2026-10-08T12:00:00Z'), policy: { day: { requests: 1 } } });
  await assert.rejects(reopened.reserve({ taskId: 'other', requestId: 'b', estimate: { inputTokens: 1, outputTokens: 1, durationMs: 1 } }), { code: 'BUDGET_EXCEEDED' });
  await assert.rejects(reopened.reset({ day: true }), /in.flight/i);
  await ledger.settle('a', { outcome: 'failed' });
  await ledger.endTask('task');
  await reopened.reset({ day: true });
  assert.equal((await reopened.snapshot()).day.requests, 0);
});

test('corrupt budget storage blocks requests without replacing evidence', async t => {
  const { ledger } = await fixture(t);
  const original = '{broken budget';
  await writeFile(ledger.path, original);
  await assert.rejects(ledger.reserve({ taskId: 'task', requestId: 'a', estimate: { inputTokens: 1, outputTokens: 1, durationMs: 1 } }), { code: 'BUDGET_STORAGE_INVALID' });
  assert.equal(await readFile(ledger.path, 'utf8'), original);
});

test('a missing live ledger cannot silently reset exhausted allowances', async t => {
  const { ledger } = await fixture(t, { policy: { day: { requests: 1 } } });
  await ledger.reserve({ taskId: 'task', requestId: 'first', estimate: { inputTokens: 1, outputTokens: 1, durationMs: 1 } });
  await ledger.settle('first');
  await rm(ledger.path);
  await assert.rejects(ledger.reserve({ taskId: 'task', requestId: 'a', estimate: { inputTokens: 1, outputTokens: 1, durationMs: 1 } }), { code: 'BUDGET_STORAGE_INVALID' });
});

test('task lifecycle exposes remaining wall duration and a completed task cannot reset its accumulated cap', async t => {
  const { ledger, advance } = await fixture(t, { policy: { task: { durationMs: 5000 } } });
  assert.equal((await ledger.beginTask('task')).timeoutMs, 5000);
  advance(2000); await ledger.endTask('task');
  assert.equal((await ledger.beginTask('task')).timeoutMs, 3000);
  advance(3000); await ledger.endTask('task');
  await assert.rejects(ledger.beginTask('task'), { code: 'BUDGET_EXCEEDED' });
});

test('adaptive request duration uses fresh atomic task allowance as the clock advances during storage',async t=>{
  let tick=0;const {ledger}=await fixture(t,{clock:()=>++tick,policy:{task:{durationMs:30000}}});
  await ledger.beginTask('task');
  const admitted=await ledger.requestHooks({taskId:'task'}).beforeRequest({id:'first',inputTokensEstimate:1});
  assert.equal(tick,3);assert.equal(admitted.timeoutMs,29998);
  const stored=JSON.parse(await readFile(ledger.path,'utf8')).requests.first;
  assert.equal(stored.durationMs,admitted.timeoutMs);assert.equal(stored.startedAt,3);
});

test('adaptive duration honors fresh daily allowance consumed by another active task',async t=>{
  let tick=0;const {ledger}=await fixture(t,{clock:()=>++tick,policy:{task:{durationMs:30000},day:{durationMs:5000}}});
  await ledger.beginTask('other');await ledger.beginTask('task');
  const admitted=await ledger.requestHooks({taskId:'task'}).beforeRequest({id:'first',inputTokensEstimate:1});
  assert.equal(tick,4);assert.equal(admitted.timeoutMs,4995);
  assert.equal(JSON.parse(await readFile(ledger.path,'utf8')).requests.first.durationMs,4995);
});

test('adaptive duration keeps an explicit shorter request bound and admits exactly one remaining millisecond',async t=>{
  await t.test('request bound',async t=>{
    let tick=0;const {ledger}=await fixture(t,{clock:()=>++tick,policy:{task:{durationMs:30000}}});await ledger.beginTask('task');
    const admitted=await ledger.requestHooks({taskId:'task',durationMs:1000}).beforeRequest({id:'first',inputTokensEstimate:1});
    assert.equal(admitted.timeoutMs,1000);assert.equal(JSON.parse(await readFile(ledger.path,'utf8')).requests.first.durationMs,1000);
  });
  await t.test('remaining millisecond',async t=>{
    const ticks=[0,5,9];let index=0;const {ledger}=await fixture(t,{clock:()=>ticks[index++],policy:{task:{durationMs:10}}});await ledger.beginTask('task');
    const admitted=await ledger.requestHooks({taskId:'task'}).beforeRequest({id:'first',inputTokensEstimate:1});
    assert.equal(admitted.timeoutMs,1);assert.equal(JSON.parse(await readFile(ledger.path,'utf8')).requests.first.durationMs,1);
  });
});

test('adaptive duration rejects freshly exhausted task or daily allowance without reserving a request',async t=>{
  for(const scope of ['task','day'])await t.test(scope,async t=>{
    const ticks=[0,5,10];let index=0;const {ledger}=await fixture(t,{clock:()=>ticks[index++],policy:{[scope]:{durationMs:10}}});
    await ledger.beginTask('task');
    await assert.rejects(ledger.requestHooks({taskId:'task'}).beforeRequest({id:'first',inputTokensEstimate:1}),{code:'BUDGET_EXCEEDED'});
    assert.deepEqual(JSON.parse(await readFile(ledger.path,'utf8')).requests,{});
  });
});

test('concurrent adaptive requests cannot share the same remaining duration reservation',async t=>{
  const policy={task:{durationMs:1000,tokens:1000,requests:2}}, {ledger,cwd}=await fixture(t,{clock:()=>0,policy});
  const {createBudgetLedger}=await import('../src/budget.mjs'),second=await createBudgetLedger({cwd,stateDir:join(cwd,'state'),clock:()=>0,policy});
  await ledger.beginTask('task');
  const results=await Promise.allSettled([ledger.requestHooks({taskId:'task',maxOutputTokens:10}).beforeRequest({id:'first',inputTokensEstimate:1}),second.requestHooks({taskId:'task',maxOutputTokens:10}).beforeRequest({id:'second',inputTokensEstimate:1})]);
  assert.equal(results.filter(value=>value.status==='fulfilled').length,1);assert.equal(results.find(value=>value.status==='rejected').reason.code,'BUDGET_EXCEEDED');
  const state=await ledger.snapshot({taskId:'task'});assert.equal(state.task.requests,1);assert.equal(state.task.inFlight,1);assert.equal(state.task.durationMs,1000);
});

test('public duration reservations remain strict and cannot opt into adaptive admission',async t=>{
  let tick=0;const {ledger}=await fixture(t,{clock:()=>++tick,policy:{task:{durationMs:30000}}});await ledger.beginTask('task');
  await assert.rejects(ledger.reserve({taskId:'task',requestId:'first',adaptiveDuration:true,estimate:{inputTokens:1,outputTokens:1,durationMs:30000}},true),{code:'BUDGET_EXCEEDED'});
  assert.deepEqual(JSON.parse(await readFile(ledger.path,'utf8')).requests,{});
});

test('adaptive duration does not weaken other caps or duplicate dispatch protection',async t=>{
  for(const [name,policy] of [['task requests',{task:{durationMs:30000,requests:0}}],['daily requests',{day:{durationMs:30000,requests:0}}],['task tokens',{task:{durationMs:30000,tokens:1}}],['daily cost',{day:{durationMs:30000,costUsd:0}}]])await t.test(name,async t=>{
    let tick=0;const {ledger}=await fixture(t,{clock:()=>++tick,policy});await ledger.beginTask('task');
    const hooks=ledger.requestHooks({taskId:'task',maxOutputTokens:1,pricing:{inputUsdPerMillion:1,outputUsdPerMillion:1}});
    await assert.rejects(hooks.beforeRequest({id:'first',inputTokensEstimate:1}),{code:'BUDGET_EXCEEDED'});assert.deepEqual(JSON.parse(await readFile(ledger.path,'utf8')).requests,{});
  });
  const {ledger}=await fixture(t,{clock:()=>0,policy:{task:{durationMs:1000}}}),hooks=ledger.requestHooks({taskId:'task',maxOutputTokens:1});await ledger.beginTask('task');
  await hooks.beforeRequest({id:'first',inputTokensEstimate:1});await hooks.afterRequest({id:'first',outcome:'succeeded'});
  await assert.rejects(hooks.beforeRequest({id:'first',inputTokensEstimate:1}),/duplicate dispatch/);
  assert.equal(Object.keys(JSON.parse(await readFile(ledger.path,'utf8')).requests).length,1);
});
