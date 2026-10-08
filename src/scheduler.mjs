import { randomUUID } from 'node:crypto';
import { createOperationsStore } from './operations-store.mjs';

const count = value => Number.isSafeInteger(value) && value >= 0;
const name = value => typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/.test(value);
function validate(value) {
  if (!value || value.version !== 1 || !Array.isArray(value.schedules) || !Array.isArray(value.occurrences) || value.schedules.length > 1000 || value.occurrences.length > 10000) throw new Error('Schedule storage is invalid.');
  for (const item of value.schedules) if (!name(item.id) || typeof item.prompt !== 'string' || !item.prompt.trim() || Buffer.byteLength(item.prompt) > 1024 * 1024 || !count(item.nextAt) || !['enabled', 'paused', 'completed'].includes(item.status) || !count(item.intervalMs) || !count(item.maxAttempts) || item.maxAttempts < 1 || !count(item.retryDelayMs)) throw new Error('Schedule record is invalid.');
  for (const item of value.occurrences) if (!name(item.scheduleId) || typeof item.key !== 'string' || !count(item.at) || !['retrying', 'queued', 'failed'].includes(item.status) || !count(item.attempts) || !count(item.nextAttemptAt) || item.taskId !== undefined && typeof item.taskId !== 'string') throw new Error('Schedule occurrence is invalid.');
  return value;
}

/** Schedules enqueue inbox work only. Retries repeat idempotent enqueue, never task side effects. */
export async function createScheduler({ inbox, directory = inbox?.directory, clock = Date.now } = {}) {
  if (!inbox || typeof inbox.submit !== 'function' || typeof inbox.get !== 'function' || typeof inbox.list !== 'function' || typeof clock !== 'function') throw new Error('Scheduler requires a durable task inbox and clock.');
  const store = await createOperationsStore({ directory, filename: 'schedules.json', initial: { version: 1, schedules: [], occurrences: [] }, validate });
  const now = () => { const value = clock(); if (!count(value)) throw new Error('Schedule clock must return an integer timestamp.'); return value; };
  async function add({ id = randomUUID(), prompt, at = now(), intervalMs = 0, maxAttempts = 3, retryDelayMs = 1000 } = {}) {
    if (typeof at === 'string') at = Date.parse(at);
    if (!name(id) || typeof prompt !== 'string' || !prompt.trim() || Buffer.byteLength(prompt) > 1024 * 1024 || !count(at) || !count(intervalMs) || intervalMs !== 0 && intervalMs < 1000 || !count(maxAttempts) || maxAttempts < 1 || maxAttempts > 10 || !count(retryDelayMs) || retryDelayMs < 100 || retryDelayMs > 3600000) throw new Error('Schedule requires a valid ID, prompt, UTC time and bounded interval/retry limits.');
    prompt = typeof inbox.redact === 'function' ? inbox.redact(prompt) : prompt;
    return store.update(value => { if (value.schedules.some(item => item.id === id)) throw new Error('Schedule ID already exists.'); const item = { id, prompt, nextAt: at, intervalMs, maxAttempts, retryDelayMs, status: 'enabled', createdAt: now() }; value.schedules.push(item); return { ...item }; });
  }
  async function list() { return (await store.read()).schedules.map(item => ({ ...item })); }
  async function remove(id) { if (!name(id)) throw new Error('Schedule ID is invalid.'); return store.update(value => { const prior = value.schedules.length; value.schedules = value.schedules.filter(item => item.id !== id); return prior !== value.schedules.length; }); }
  async function setEnabled(id, enabled) { if (!name(id) || typeof enabled !== 'boolean') throw new Error('Schedule state is invalid.'); return store.update(value => { const item = value.schedules.find(item => item.id === id); if (!item) throw new Error('Schedule was not found.'); item.status = enabled ? 'enabled' : 'paused'; return { ...item }; }); }
  async function tick() {
    return store.update(async value => {
      const at = now(), queued = [];
      for (const schedule of value.schedules) {
        if (schedule.status !== 'enabled' || schedule.nextAt > at) continue;
        // Do not overlap distinct occurrences while the previous task is unfinished.
        const previous = value.occurrences.filter(item => item.scheduleId === schedule.id && item.status === 'queued').at(-1);
        if (previous && ['pending', 'assessing', 'running'].includes((await inbox.get(previous.taskId))?.status)) continue;
        const key = `schedule:${schedule.id}:${schedule.nextAt}`;
        let occurrence = value.occurrences.find(item => item.key === key);
        if (!occurrence) { occurrence = { key, scheduleId: schedule.id, at: schedule.nextAt, status: 'retrying', attempts: 0, nextAttemptAt: at }; value.occurrences.push(occurrence); }
        if (occurrence.nextAttemptAt > at || occurrence.status === 'failed') continue;
        try {
          occurrence.attempts++;
          const task = await inbox.submit({ prompt: schedule.prompt, source: `schedule:${schedule.id}`, idempotencyKey: key });
          occurrence.status = 'queued'; occurrence.taskId = task.id; queued.push(task);
          schedule.nextAt = schedule.intervalMs ? Math.max(schedule.nextAt + schedule.intervalMs, at + schedule.intervalMs) : schedule.nextAt;
          if (!schedule.intervalMs) schedule.status = 'completed';
        } catch {
          if (occurrence.attempts >= schedule.maxAttempts) { occurrence.status = 'failed'; schedule.status = 'paused'; }
          else { occurrence.status = 'retrying'; occurrence.nextAttemptAt = at + schedule.retryDelayMs * 2 ** (occurrence.attempts - 1); }
        }
      }
      return queued;
    });
  }
  return { path: store.path, add, list, remove, setEnabled, tick, reconcile: tick };
}
