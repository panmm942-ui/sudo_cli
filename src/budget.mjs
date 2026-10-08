import { createHash } from 'node:crypto';
import { realpath } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { defaultWorkStateDir } from './work-meter.mjs';
import { createOperationsStore } from './operations-store.mjs';

const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const number = value => typeof value === 'number' && Number.isFinite(value) && value >= 0;
const count = value => Number.isSafeInteger(value) && value >= 0;
const identifier = value => { if (typeof value !== 'string' || !value || value.length > 256 || ['__proto__', 'constructor', 'prototype'].includes(value) || /[\u0000-\u001f\u007f]/.test(value)) throw new Error('Budget task/request identifier is invalid.'); return value; };
const exceeded = message => Object.assign(new Error(message), { code: 'BUDGET_EXCEEDED' });
const dayKey = now => new Date(now).toISOString().slice(0, 10);
const dayStart = day => Date.parse(`${day}T00:00:00Z`);

export function normalizeBudgetPolicy(value = {}) {
  if (!object(value)) throw new Error('Budget policy must be an object.');
  const policy = {};
  for (const scope of ['task', 'day']) if (value[scope] !== undefined) {
    if (!object(value[scope])) throw new Error('Budget scope must be an object.');
    policy[scope] = {};
    for (const field of ['costUsd', 'tokens', 'requests', 'durationMs']) if (value[scope][field] !== undefined) {
      const cap = value[scope][field];
      if (!(field === 'costUsd' ? number(cap) : count(cap))) throw new Error('Budget caps must be finite nonnegative amounts.');
      policy[scope][field] = cap;
    }
  }
  return policy;
}
export function normalizePricing(value) {
  if (value === undefined || value === null) return undefined;
  if (!object(value) || !number(value.inputUsdPerMillion) || !number(value.outputUsdPerMillion)) throw new Error('Pricing requires finite nonnegative USD rates per million input/output tokens.');
  return { inputUsdPerMillion: value.inputUsdPerMillion, outputUsdPerMillion: value.outputUsdPerMillion };
}
export function estimateUsage({ input, inputTokensEstimate, outputTokenLimit = 4096, pricing } = {}) {
  if (inputTokensEstimate === undefined) inputTokensEstimate = Math.ceil(Buffer.byteLength(typeof input === 'string' ? input : JSON.stringify(input ?? '')) / 4);
  if (!count(inputTokensEstimate) || !count(outputTokenLimit)) throw new Error('Usage estimation requires nonnegative bounded token counts.');
  pricing = normalizePricing(pricing);
  return { inputTokens: inputTokensEstimate, outputTokens: outputTokenLimit, tokens: inputTokensEstimate + outputTokenLimit,
    costUsd: pricing ? (inputTokensEstimate * pricing.inputUsdPerMillion + outputTokenLimit * pricing.outputUsdPerMillion) / 1e6 : null,
    estimated: true, costEstimated: true, costSource: pricing ? 'configured-rates' : 'unknown' };
}
function validate(value) {
  if (!object(value) || value.version !== 1 || !object(value.tasks) || !object(value.requests)) throw new Error('Invalid budget record.');
  for (const [id, task] of Object.entries(value.tasks)) {
    identifier(id); if (!object(task) || !count(task.elapsedMs) || !object(task.days) || task.startedAt !== null && !count(task.startedAt) || Object.values(task.days).some(ms => !count(ms))) throw new Error('Invalid budget task.');
  }
  for (const [id, req] of Object.entries(value.requests)) {
    identifier(id); identifier(req.taskId);
    if (!value.tasks[req.taskId] || !/^\d{4}-\d\d-\d\d$/.test(req.day) || !['reserved', 'reported', 'settled'].includes(req.status) || !count(req.tokens) || req.costUsd !== null && !number(req.costUsd) || !count(req.durationMs) || !count(req.startedAt) || typeof req.estimated !== 'boolean') throw new Error('Invalid budget request.');
  }
  return value;
}

/** Request admission is durable and conservative. Currency amounts are estimates, never provider invoices. */
export async function createBudgetLedger({ stateDir = defaultWorkStateDir(), cwd = process.cwd(), policy = {}, clock = Date.now } = {}) {
  policy = normalizeBudgetPolicy(policy);
  if (typeof clock !== 'function') throw new Error('Budget clock must be a function.');
  const project = await realpath(resolve(cwd));
  const hash = createHash('sha256').update(process.platform === 'win32' ? project.toLowerCase() : project).digest('hex');
  const store = await createOperationsStore({ directory: join(resolve(stateDir), 'budgets', hash), filename: 'ledger.json', initial: { version: 1, tasks: {}, requests: {} }, validate });
  const now = () => { const value = clock(); if (!count(value)) throw new Error('Budget clock must return a nonnegative integer timestamp.'); return value; };
  function ensureTask(value, taskId, at) { return value.tasks[taskId] ??= { elapsedMs: 0, days: {}, startedAt: at }; }
  function duration(task, at, day) {
    if (task.startedAt !== null && at < task.startedAt) throw exceeded('Budget clock moved backwards; request admission is blocked.');
    return (day ? task.days[day] ?? 0 : task.elapsedMs) + (task.startedAt === null ? 0 : Math.max(0, at - Math.max(task.startedAt, day ? dayStart(day) : 0)));
  }
  function totals(value, at, { taskId, day } = {}) {
    const requests = Object.values(value.requests).filter(req => (!taskId || req.taskId === taskId) && (!day || req.day === day));
    let durationMs = Object.entries(value.tasks).filter(([id]) => !taskId || id === taskId).reduce((sum, [, task]) => sum + duration(task, at, day), 0);
    durationMs += requests.filter(req => req.status !== 'settled').reduce((sum, req) => sum + Math.max(0, req.durationMs - (at - req.startedAt)), 0);
    return { requests: requests.length, tokens: requests.reduce((sum, req) => sum + req.tokens, 0), costUsd: requests.some(req => req.costUsd === null) ? null : requests.reduce((sum, req) => sum + req.costUsd, 0), durationMs, estimatedRequests: requests.filter(req => req.estimated).length, inFlight: requests.filter(req => req.status !== 'settled').length };
  }
  async function beginTask(taskId) {
    identifier(taskId);
    return store.update(value => {
      const at = now(), task = ensureTask(value, taskId, at); if (task.startedAt === null) task.startedAt = at;
      let remaining = Infinity;
      for (const [scope, selector] of [['task', { taskId }], ['day', { day: dayKey(at) }]]) if (policy[scope]?.durationMs !== undefined) remaining = Math.min(remaining, policy[scope].durationMs - totals(value, at, selector).durationMs);
      if (remaining < 1) throw exceeded('The task or daily duration budget is exhausted.');
      return { taskId, startedAt: task.startedAt, ...(remaining === Infinity ? {} : { timeoutMs: Math.min(2147483647, Math.floor(remaining)) }) };
    });
  }
  async function endTask(taskId) {
    identifier(taskId);
    return store.update(value => {
      const task = value.tasks[taskId]; if (!task || task.startedAt === null) return;
      const at = now(); duration(task, at);
      let start = task.startedAt;
      while (start < at) { const day = dayKey(start), end = Math.min(at, dayStart(day) + 86400000); task.days[day] = (task.days[day] ?? 0) + end - start; start = end; }
      task.elapsedMs += at - task.startedAt; task.startedAt = null;
      // An interrupted task retains the full unreported reservation, then closes it.
      for (const req of Object.values(value.requests)) if (req.taskId === taskId && req.status !== 'settled') { req.status = 'settled'; req.outcome = 'cancelled'; }
    });
  }
  async function reserveRequest({ taskId, requestId, estimate, pricing } = {}, adaptiveDuration = false) {
    identifier(taskId); identifier(requestId); pricing = normalizePricing(pricing);
    if (!object(estimate) || !count(estimate.inputTokens) || !count(estimate.outputTokens) || !count(estimate.durationMs) || estimate.durationMs < 1) throw new Error('Budget reservation requires input/output token and duration estimates.');
    return store.update(value => {
      const at = now(), day = dayKey(at); ensureTask(value, taskId, at);
      if (value.requests[requestId]) throw exceeded('This request identifier was already admitted; duplicate dispatch is blocked.');
      const costUsd = estimate.costUsd !== undefined ? estimate.costUsd : estimateUsage({ inputTokensEstimate: estimate.inputTokens, outputTokenLimit: estimate.outputTokens, pricing }).costUsd;
      if (costUsd !== null && !number(costUsd)) throw new Error('Budget cost estimate is invalid.');
      const scopes = [['task', totals(value, at, { taskId })], ['day', totals(value, at, { day })]];
      let timeout = estimate.durationMs;
      if (adaptiveDuration) {
        for (const [scope, used] of scopes) if (policy[scope]?.durationMs !== undefined) timeout = Math.min(timeout, policy[scope].durationMs - used.durationMs);
        timeout = Math.floor(timeout);
        if (timeout < 1) throw exceeded('The task or daily duration budget is exhausted.');
      }
      const charge = { requests: 1, tokens: estimate.inputTokens + estimate.outputTokens, costUsd, durationMs: timeout };
      for (const [scope, used] of scopes) {
        for (const [field, cap] of Object.entries(policy[scope] ?? {})) if (field === 'costUsd' && (charge.costUsd === null || used.costUsd === null) || cap + 1e-12 < used[field] + charge[field]) throw exceeded(`The ${scope} ${field} budget cannot admit this request${field === 'costUsd' && charge.costUsd === null ? '; configure pricing first' : ''}.`);
      }
      value.requests[requestId] = { taskId, day, status: 'reserved', tokens: charge.tokens, costUsd, durationMs: charge.durationMs, startedAt: at, estimated: true, ...(pricing ? { pricing } : {}) };
      return { reservationId: requestId, maxOutputTokens: estimate.outputTokens, timeoutMs: charge.durationMs };
    });
  }
  const reserve = options => reserveRequest(options);
  async function reportUsage(requestId, usage) {
    identifier(requestId);
    if (!object(usage) || !count(usage.inputTokens) || !count(usage.outputTokens) || !count(usage.totalTokens) || usage.totalTokens < usage.inputTokens + usage.outputTokens || usage.estimated !== false) throw new Error('Budget settlement requires valid actual provider token usage.');
    return store.update(value => {
      const req = value.requests[requestId]; if (!req || req.status === 'settled') throw exceeded('No active budget reservation exists for this usage.');
      req.tokens = usage.totalTokens; req.costUsd = req.pricing ? (usage.inputTokens * req.pricing.inputUsdPerMillion + usage.outputTokens * req.pricing.outputUsdPerMillion) / 1e6 : null; req.estimated = false; req.status = 'reported';
    });
  }
  async function settle(requestId, { usage, outcome = 'succeeded' } = {}) {
    if (usage) await reportUsage(requestId, usage);
    identifier(requestId); if (!['succeeded', 'failed', 'cancelled'].includes(outcome)) throw new Error('Budget request outcome is invalid.');
    return store.update(value => { const req = value.requests[requestId]; if (!req) throw exceeded('No budget reservation exists to settle.'); req.status = 'settled'; req.outcome = outcome; });
  }
  async function snapshot({ taskId } = {}) {
    if (taskId !== undefined) identifier(taskId);
    const value = await store.read(), at = now(), day = dayKey(at);
    return { policy: structuredClone(policy), dayKey: day, day: totals(value, at, { day }), ...(taskId ? { taskId, task: totals(value, at, { taskId }) } : {}), costEstimated: true, costSource: 'configured-rates-or-unknown' };
  }
  function requestHooks({ taskId, pricing, maxOutputTokens = 4096, durationMs = 120000 } = {}) {
    identifier(taskId); pricing = normalizePricing(pricing);
    if (!count(maxOutputTokens) || maxOutputTokens < 1 || !count(durationMs) || durationMs < 1) throw new Error('Budget request limits must be positive integers.');
    return {
      async beforeRequest({ id, inputTokensEstimate, maxOutputTokens: requested } = {}) {
        if (!count(inputTokensEstimate) || requested !== undefined && (!count(requested) || requested < 1)) throw new Error('Model request token estimates are invalid.');
        const state = await snapshot({ taskId }); let output = Math.min(maxOutputTokens, requested ?? maxOutputTokens), timeout = durationMs;
        for (const scope of ['task', 'day']) {
          const used = state[scope], caps = policy[scope] ?? {};
          if (caps.tokens !== undefined) output = Math.min(output, caps.tokens - used.tokens - inputTokensEstimate);
          if (caps.durationMs !== undefined) timeout = Math.min(timeout, caps.durationMs - used.durationMs);
          if (caps.costUsd !== undefined && pricing) {
            const remaining = caps.costUsd - (used.costUsd ?? Infinity) - inputTokensEstimate * pricing.inputUsdPerMillion / 1e6;
            if (remaining < 0) output = -1;
            else if (pricing.outputUsdPerMillion > 0) output = Math.min(output, Math.floor(remaining * 1e6 / pricing.outputUsdPerMillion));
          }
        }
        output = Math.floor(output); timeout = Math.floor(timeout);
        if (output < 1 || timeout < 1) throw exceeded('The token or duration budget is exhausted.');
        return reserveRequest({ taskId, requestId: id, estimate: { inputTokens: inputTokensEstimate, outputTokens: output, durationMs: timeout }, pricing }, true);
      },
      onUsage(usage) { return reportUsage(usage.id, usage); },
      afterRequest({ id, outcome } = {}) { return settle(id, { outcome }); },
    };
  }
  async function reset({ day = false, taskId } = {}) {
    if (!day && !taskId) throw new Error('Budget reset requires explicit day or task scope.');
    if (taskId) identifier(taskId);
    return store.update(value => {
      const today = dayKey(now()), matches = req => taskId ? req.taskId === taskId : req.day === today;
      if (Object.values(value.requests).some(req => matches(req) && req.status !== 'settled')) throw new Error('Budget reset is blocked while requests are in flight.');
      for (const [id, req] of Object.entries(value.requests)) if (matches(req)) delete value.requests[id];
      if (taskId) delete value.tasks[taskId]; else for (const task of Object.values(value.tasks)) { if (task.startedAt !== null) throw new Error('Budget reset is blocked while tasks are active.'); delete task.days[today]; }
    });
  }
  return { path: store.path, policy, beginTask, endTask, reserve, reportUsage, settle, snapshot, requestHooks, reset };
}
