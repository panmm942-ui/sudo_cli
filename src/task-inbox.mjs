import { constants } from 'node:fs';
import { mkdir, lstat, realpath, open, readdir, rename, rm } from 'node:fs/promises';
import { createHash, randomUUID } from 'node:crypto';
import { dirname, join, resolve } from 'node:path';
import { setTimeout as wait } from 'node:timers/promises';
import { defaultWorkStateDir } from './work-meter.mjs';
import { createRedactor } from './redactor.mjs';

export const TASK_STATES = Object.freeze(['pending', 'assessing', 'running', 'completed', 'blocked', 'failed']);
export const MAX_TASK_BYTES = 2 * 1024 * 1024;
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const taskName = /^task-([0-9a-f-]{36})\.json$/;
const validPath = value => typeof value === 'string' && value.length && !/[\u0000-\u001f\u007f]/.test(value);
const same = (a, b) => process.platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b;
const date = value => typeof value === 'string' && /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(value) && Number.isFinite(Date.parse(value));
const transitions = {
  pending: ['assessing', 'blocked', 'failed'], assessing: ['running', 'completed', 'blocked', 'failed'], running: ['completed', 'blocked', 'failed'],
  completed: ['pending'], blocked: ['pending'], failed: ['pending'],
};
const inboxQueues = new Map();
function deterministicId(hash) {
  const bytes = Buffer.from(hash.slice(0, 32), 'hex'); bytes[6] = (bytes[6] & 15) | 80; bytes[8] = (bytes[8] & 63) | 128;
  const value = bytes.toString('hex'); return `${value.slice(0, 8)}-${value.slice(8, 12)}-${value.slice(12, 16)}-${value.slice(16, 20)}-${value.slice(20)}`;
}
function id(value) { if (typeof value !== 'string' || !uuid.test(value)) throw new Error('Task identifier is invalid.'); return value; }
async function realDirectories(path) {
  let current = resolve(path);
  while (true) {
    let info;
    try { info = await lstat(current); } catch (error) { if (error.code !== 'ENOENT') throw new Error('Unable to inspect task storage.'); }
    if (info && (!info.isDirectory() || info.isSymbolicLink())) throw new Error('Task storage requires real directories without symbolic links.');
    const parent = dirname(current); if (parent === current) break; current = parent;
  }
}

/** A project-scoped inbox. Merely opening it never recovers or executes a job. */
export async function createTaskInbox({ stateDir = defaultWorkStateDir(), cwd = process.cwd(), secrets = () => [] } = {}) {
  if (!validPath(stateDir) || !validPath(cwd) || typeof secrets !== 'function') throw new Error('Task inbox requires valid project/storage directories and a secret supplier.');
  let project;
  try { project = await realpath(resolve(cwd)); if (!(await lstat(project)).isDirectory()) throw new Error('directory'); }
  catch { throw new Error('Task inbox project must be an existing directory.'); }
  const projectHash = createHash('sha256').update(process.platform === 'win32' ? project.toLowerCase() : project).digest('hex');
  const directory = join(resolve(stateDir), 'tasks', projectHash);
  await realDirectories(directory); await mkdir(directory, { recursive: true, mode: 0o700 }); await realDirectories(directory);
  const canonicalDirectory = await realpath(directory);
  const queues = inboxQueues;
  const knownSecrets = new Set();
  let warnings = [], workerToken;
  function redact(value) {
    const current = secrets();
    if (Array.isArray(current)) for (const item of current) if (typeof item === 'string' && item.length) knownSecrets.add(item);
    const filter = createRedactor({ secrets: () => [...knownSecrets] });
    return filter.write(value) + filter.flush();
  }
  function text(value, field, maximum, { optional = false } = {}) {
    if (value === undefined && optional) return undefined;
    if (typeof value !== 'string') throw new Error(`Task ${field} must be text.`);
    if (Buffer.byteLength(value) > maximum) throw new Error(`Task ${field} exceeds its size limit.`);
    return redact(value);
  }
  async function checkDirectory() {
    await realDirectories(directory);
    if (!same(await realpath(directory), canonicalDirectory)) throw new Error('Task storage directory changed; existing tasks were left unchanged.');
  }
  async function read(name, maximum = MAX_TASK_BYTES, attempt = 0) {
    await checkDirectory(); let file;
    try {
      const before = await lstat(join(directory, name));
      if (before.isSymbolicLink() || !before.isFile() || before.size > maximum) throw new Error('invalid');
      file = await open(join(directory, name), constants.O_RDONLY | (constants.O_NOFOLLOW || 0));
      const info = await file.stat();
      if (!info.isFile() || info.size > maximum) throw new Error('invalid');
      if (info.ino !== before.ino || info.dev !== before.dev) { const changed = new Error('changed'); changed.code = 'TASK_ATOMIC_GENERATION_CHANGED'; throw changed; }
      const chunks = []; let length = 0;
      while (true) {
        const buffer = Buffer.allocUnsafe(Math.min(65536, maximum + 1 - length));
        const { bytesRead } = await file.read(buffer, 0, buffer.length, null);
        if (!bytesRead) break;
        length += bytesRead; if (length > maximum) throw new Error('invalid'); chunks.push(buffer.subarray(0, bytesRead));
      }
      const after = await file.stat();
      if (after.size !== info.size || after.mtimeMs !== info.mtimeMs || length !== info.size) throw new Error('invalid');
      return JSON.parse(Buffer.concat(chunks, length).toString('utf8'));
    } catch (error) {
      if (error.code === 'TASK_ATOMIC_GENERATION_CHANGED' && attempt < 3) {
        await file?.close().catch(() => {}); file = undefined;
        return read(name, maximum, attempt + 1);
      }
      if (error.code === 'ENOENT') return undefined;
      throw new Error('Task storage data is invalid or unreadable; existing records were left unchanged.');
    } finally { await file?.close().catch(() => {}); }
  }
  function canonical(value, expectedId) {
    if (!value || value.version !== 1 || value.id !== expectedId || !uuid.test(value.id) || !validPath(value.cwd) || !same(value.cwd, project)
      || !TASK_STATES.includes(value.status) || !date(value.createdAt) || !date(value.updatedAt)) throw new Error('Task record is invalid; existing storage was left unchanged.');
    const prompt = text(value.prompt, 'prompt', 1024 * 1024);
    if (!prompt.trim()) throw new Error('Task prompt must be nonempty text.');
    const record = { version: 1, id: value.id, cwd: project, prompt, source: text(value.source ?? 'terminal', 'source', 2048), status: value.status, createdAt: value.createdAt, updatedAt: value.updatedAt };
    const reason = text(value.reason, 'reason', 65536, { optional: true });
    const result = text(value.result, 'result', 1024 * 1024, { optional: true });
    if (reason !== undefined) record.reason = reason;
    if (result !== undefined) record.result = result;
    if (value.idempotencyHash !== undefined) { if (!/^[0-9a-f]{64}$/.test(value.idempotencyHash) || deterministicId(value.idempotencyHash) !== value.id) throw new Error('Task idempotency record is invalid.'); record.idempotencyHash = value.idempotencyHash; }
    return record;
  }
  async function get(taskId) {
    id(taskId); const value = await read(`task-${taskId}.json`);
    return value === undefined ? undefined : canonical(value, taskId);
  }
  async function locked(name, operation) {
    const queueKey = `${canonicalDirectory}:${name}`;
    const previous = queues.get(queueKey) || Promise.resolve();
    const next = previous.catch(() => {}).then(async () => {
      await checkDirectory(); let lock;
      const path = join(directory, `${name}.lock`);
      try {
        try { lock = await open(path, 'wx', 0o600); }
        catch (error) { if (error.code === 'EEXIST') throw new Error('Task storage is being edited by another session or has an interrupted edit lock.'); throw new Error('Unable to lock task storage.'); }
        return await operation();
      } finally { if (lock) { await lock.close().catch(() => {}); await rm(path, { force: true }).catch(() => {}); } }
    });
    queues.set(queueKey, next);
    try { return await next; } finally { if (queues.get(queueKey) === next) queues.delete(queueKey); }
  }
  async function write(name, value, maximum = MAX_TASK_BYTES) {
    const serialized = JSON.stringify(value) + '\n';
    if (Buffer.byteLength(serialized) > maximum) throw new Error('Task record exceeds its storage size limit.');
    const target = join(directory, name), temporary = `${target}.${randomUUID()}.tmp`; let file;
    try {
      await checkDirectory(); file = await open(temporary, 'wx', 0o600);
      await file.writeFile(serialized); await file.sync(); await file.close(); file = undefined;
      for (let attempt = 0; ; attempt++) {
        await checkDirectory();
        try { await rename(temporary, target); break; }
        catch (error) {
          if (process.platform !== 'win32' || !['EPERM', 'EACCES', 'EBUSY'].includes(error.code) || attempt >= 10) throw error;
          await wait(10 + attempt * 5);
        }
      }
    } finally { await file?.close().catch(() => {}); await rm(temporary, { force: true }).catch(() => {}); }
  }
  async function list() {
    await checkDirectory(); warnings = []; const values = [];
    for (const name of (await readdir(directory)).filter(value => taskName.test(value))) {
      try { const job = await get(taskName.exec(name)[1]); if (job) values.push(job); }
      catch { warnings.push(`Task ${taskName.exec(name)[1]} is invalid or unreadable and was skipped.`); }
    }
    return values.sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id));
  }
  async function update(taskId, patch = {}) {
    id(taskId);
    if (!patch || typeof patch !== 'object' || !TASK_STATES.includes(patch.status)) throw new Error('Task update requires a valid status.');
    const reason = text(patch.reason, 'reason', 65536, { optional: true });
    const result = text(patch.result, 'result', 1024 * 1024, { optional: true });
    return locked(`task-${taskId}.json`, async () => {
      const previous = await get(taskId); if (!previous) throw new Error('Task was not found.');
      if (patch.status !== previous.status && !transitions[previous.status].includes(patch.status)) throw new Error('Task status transition is invalid.');
      const record = { ...previous, status: patch.status, updatedAt: new Date().toISOString() };
      if (patch.status === 'pending' && previous.status !== 'pending') { delete record.reason; delete record.result; }
      if (reason !== undefined) record.reason = reason;
      if (result !== undefined) record.result = result;
      await write(`task-${taskId}.json`, record); return record;
    });
  }
  async function workerRecord() {
    const value = await read('worker.json', 2048);
    if (value !== undefined && (!value || value.version !== 1 || !Number.isSafeInteger(value.pid) || value.pid <= 0 || value.pid > 2147483647 || !uuid.test(value.token) || !validPath(value.cwd) || !same(value.cwd, project))) throw new Error('Worker lease is invalid; existing storage was left unchanged.');
    return value;
  }
  return {
    directory, cwd: project, stateDir: resolve(stateDir), redact, warnings() { return [...warnings]; }, get, list, update,
    async submit({ prompt, source = 'terminal', idempotencyKey } = {}) {
      const value = text(prompt, 'prompt', 1024 * 1024);
      if (!value.trim()) throw new Error('Task prompt must be nonempty text.');
      if (idempotencyKey !== undefined && (typeof idempotencyKey !== 'string' || !idempotencyKey || Buffer.byteLength(idempotencyKey) > 2048 || /[\u0000-\u001f\u007f]/.test(idempotencyKey))) throw new Error('Task idempotency key must be nonempty bounded text.');
      const hash = idempotencyKey === undefined ? undefined : createHash('sha256').update(projectHash + '\n' + idempotencyKey).digest('hex');
      const record = { version: 1, id: hash ? deterministicId(hash) : randomUUID(), cwd: project, prompt: value, source: text(source, 'source', 2048), status: 'pending', createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), ...(hash ? { idempotencyHash: hash } : {}) };
      return locked(`task-${record.id}.json`, async () => {
        const existing = await get(record.id);
        if (existing) { if (hash && existing.idempotencyHash === hash && existing.prompt === record.prompt && existing.source === record.source) return existing; throw new Error('Task idempotency key was already used with different content.'); }
        await write(`task-${record.id}.json`, record); return record;
      });
    },
    async recoverInterrupted() {
      if (!workerToken || (await workerRecord())?.token !== workerToken) throw new Error('Interrupted task recovery requires the exclusive worker lease.');
      const recovered = [];
      for (const job of await list()) if (['assessing', 'running'].includes(job.status)) recovered.push(await update(job.id, { status: 'blocked', reason: 'The previous worker was interrupted. Review this task and explicitly retry it if needed.' }));
      return recovered;
    },
    async acquireWorker() {
      const token = randomUUID();
      await locked('worker-lease', async () => {
        const previous = await workerRecord();
        if (previous) {
          let alive = true;
          try { process.kill(previous.pid, 0); } catch (error) { if (error.code === 'ESRCH') alive = false; }
          if (alive) throw new Error('A worker already owns this project. Stop that worker before starting another session.');
        }
        await write('worker.json', { version: 1, pid: process.pid, token, cwd: project, startedAt: new Date().toISOString() }, 2048);
        workerToken = token;
      });
      let released = false;
      return { async release() {
        if (released) return;
        await locked('worker-lease', async () => {
          const current = await workerRecord();
          if (current?.token === token) await rm(join(directory, 'worker.json'));
          if (workerToken === token) workerToken = undefined;
          released = true;
        });
      } };
    },
  };
}
