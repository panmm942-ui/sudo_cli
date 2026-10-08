import { constants } from 'node:fs';
import { mkdir, lstat, realpath, open, rename, rm } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { setTimeout as wait } from 'node:timers/promises';

const queues = new Map();
export const operationStorageError = () => Object.assign(new Error('Operational storage is invalid, unavailable or locked. Existing records were preserved.'), { code: 'BUDGET_STORAGE_INVALID' });
async function directories(path) {
  const parent = dirname(path);
  if (parent !== path) await directories(parent);
  let info;
  try { info = await lstat(path); } catch (error) { if (error.code !== 'ENOENT') throw error; await mkdir(path, { mode: 0o700 }).catch(error => { if (error.code !== 'EEXIST') throw error; }); info = await lstat(path); }
  if (!info.isDirectory() || info.isSymbolicLink()) throw operationStorageError();
}

/** Atomic bounded records. Interrupted or foreign-process locks fail closed; no automatic lock takeover. */
export async function createOperationsStore({ directory, filename, initial, validate = value => value, maxBytes = 8 * 1024 * 1024 } = {}) {
  if (typeof directory !== 'string' || !directory || /[\u0000-\u001f\u007f]/.test(directory) || !/^[a-z][a-z0-9-]*\.json$/.test(filename ?? '') || typeof validate !== 'function' || !Number.isSafeInteger(maxBytes) || maxBytes < 1) throw new Error('Operational storage configuration is invalid.');
  directory = resolve(directory); await directories(directory);
  const canonical = await realpath(directory), path = join(directory, filename), queueKey = process.platform === 'win32' ? path.toLowerCase() : path;
  let initialized = false;
  async function check() { await directories(directory); if (await realpath(directory) !== canonical) throw operationStorageError(); }
  async function read() {
    await check(); let file;
    try {
      const before = await lstat(path);
      if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1 || before.size > maxBytes) throw operationStorageError();
      file = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
      const info = await file.stat();
      if (!info.isFile() || info.ino !== before.ino || info.dev !== before.dev || info.size !== before.size) throw operationStorageError();
      const bytes = Buffer.alloc(info.size + 1), result = await file.read(bytes, 0, bytes.length, 0), after = await file.stat();
      if (result.bytesRead !== info.size || after.size !== info.size || after.mtimeMs !== info.mtimeMs) throw operationStorageError();
      return validate(JSON.parse(bytes.subarray(0, result.bytesRead).toString('utf8')));
    } catch (error) { if (error.code === 'ENOENT' && !initialized) return validate(structuredClone(initial)); throw operationStorageError(); }
    finally { await file?.close().catch(() => {}); }
  }
  async function write(value) {
    const serialized = JSON.stringify(validate(value)) + '\n';
    if (Buffer.byteLength(serialized) > maxBytes) throw operationStorageError();
    const temporary = `${path}.${randomUUID()}.tmp`; let file;
    try {
      await check(); file = await open(temporary, 'wx', 0o600); await file.writeFile(serialized); await file.sync(); await file.close(); file = undefined;
      for (let attempt = 0; ; attempt++) {
        await check();
        try { await rename(temporary, path); break; }
        catch (error) { if (process.platform !== 'win32' || !['EPERM', 'EACCES', 'EBUSY'].includes(error.code) || attempt >= 10) throw error; await wait(10 + attempt * 5); }
      }
    } catch { throw operationStorageError(); }
    finally { await file?.close().catch(() => {}); await rm(temporary, { force: true }).catch(() => {}); }
  }
  async function update(operation) {
    const prior = queues.get(queueKey) ?? Promise.resolve();
    const next = prior.catch(() => {}).then(async () => {
      await check(); let lock;
      try { lock = await open(`${path}.lock`, 'wx', 0o600); }
      catch { throw operationStorageError(); }
      try { const value = await read(), result = await operation(value); await write(value); return result; }
      finally { await lock.close().catch(() => {}); await rm(`${path}.lock`, { force: true }).catch(() => {}); }
    });
    queues.set(queueKey, next);
    try { return await next; } finally { if (queues.get(queueKey) === next) queues.delete(queueKey); }
  }
  // Initialization uses the same lock as all later edits.
  await update(() => {});
  initialized = true;
  return { path, read, update };
}
