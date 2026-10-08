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
