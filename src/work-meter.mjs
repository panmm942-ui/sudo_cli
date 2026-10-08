import { mkdir, open, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises';
import { realpathSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, posix, win32 } from 'node:path';
import { randomUUID } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import { setTimeout as wait } from 'node:timers/promises';

const recordName = /^session-[A-Za-z0-9_-]{1,80}\.json$/;
const duration = (value) => Number.isSafeInteger(value) && value >= 0;

export function defaultWorkStateDir({ platform = process.platform, env = process.env, home } = {}) {
  // Canonicalize only the OS-derived default, including macOS /var/root.
  // Explicit state roots and injected homes retain private-directory checks.
  if(home===undefined)home=realpathSync(homedir());
  if (platform === 'win32') return win32.join(env.LOCALAPPDATA || win32.join(home, 'AppData', 'Local'), 'codexcli');
  if (platform === 'darwin') return posix.join(home, 'Library', 'Application Support', 'codexcli');
  const stateRoot = env.XDG_STATE_HOME && posix.isAbsolute(env.XDG_STATE_HOME) ? env.XDG_STATE_HOME : posix.join(home, '.local', 'state');
  return posix.join(stateRoot, 'codexcli');
}

/**
 * Active AI time only. Each launch owns one unique, atomically replaced scalar
 * record, so concurrent launches never overwrite each other's lifetime usage.
 * A synchronous snapshot has live local time and other sessions' latest cached
 * checkpoints; flush refreshes that cache. A crash can lose at most the active
 * time since the last successful checkpoint (normally five seconds).
 * No prompts, models, credentials, connection settings, or wall-clock dates are
 * persisted. Each record contains numeric {version, activeMs} only.
 */
export async function createWorkMeter({
  stateDir = defaultWorkStateDir(), clock = () => performance.now(),
  sessionId = randomUUID(), checkpointMs = 5000,
} = {}) {
  if (typeof clock !== 'function' || !Number.isSafeInteger(checkpointMs) || checkpointMs < 0
    || typeof sessionId !== 'string' || !/^[A-Za-z0-9_-]{1,80}$/.test(sessionId)) {
    throw new Error('Work meter requires a clock, valid session identifier, and nonnegative checkpoint interval.');
  }
  let lastTime = 0;
  const now = () => {
    const time = clock();
    if (!Number.isFinite(time) || time < 0) throw new Error('Work meter clock must return finite nonnegative milliseconds.');
    lastTime = Math.max(lastTime, time);
    return lastTime;
  };
  now();
  let accumulatedMs = 0, startedAt = null, otherMs = 0, persistedMs = 0;
  let closed = false, closing, timer, storageStatus = 'ok', writes = Promise.resolve();
  const filename = `session-${sessionId}.json`;
  const path = join(stateDir, filename);
  const currentMs = () => Math.min(Number.MAX_SAFE_INTEGER, Math.floor(accumulatedMs + (startedAt === null ? 0 : now() - startedAt)));

  async function refreshOthers() {
    const names = (await readdir(stateDir)).filter((name) => name !== filename && recordName.test(name));
    const values = await Promise.all(names.map(async (name) => {
      try {
        const record = JSON.parse(await readFile(join(stateDir, name), 'utf8'));
        return record?.version === 1 && duration(record.activeMs) ? record.activeMs : 0;
      } catch (error) {
        if (error instanceof SyntaxError || error.code === 'ENOENT') return 0;
        throw error;
      }
    }));
    otherMs = values.reduce((total, value) => Math.min(Number.MAX_SAFE_INTEGER, total + value), 0);
  }

  await mkdir(stateDir, { recursive: true, mode: 0o700 });
  let initial;
  try {
    initial = await open(path, 'wx', 0o600);
    await initial.writeFile(JSON.stringify({ version: 1, activeMs: 0 }));
  } catch (error) {
    if (error.code === 'EEXIST') throw new Error('Work meter session identifier already exists.');
    throw new Error('Unable to initialize work-duration storage.');
  } finally { await initial?.close(); }
  await refreshOthers();

  function snapshot() {
    const sessionMs = currentMs();
    return { sessionMs, totalMs: Math.min(Number.MAX_SAFE_INTEGER, otherMs + sessionMs), active: startedAt !== null, persistedMs, storageStatus };
  }

  function flush() {
    if (closed) return Promise.resolve(snapshot());
    const operation = writes.catch(() => {}).then(async () => {
      const activeMs = currentMs();
      const temporary = `${path}.${randomUUID()}.tmp`;
      try {
        await writeFile(temporary, JSON.stringify({ version: 1, activeMs }), { mode: 0o600, flag: 'wx' });
        // On Windows another meter's refreshOthers read handle can temporarily
        // prevent replacing this session's record. Keep the complete temporary
        // record and retry only the rename, within the existing store bound.
        for (let attempt = 0; ; attempt++) {
          try { await rename(temporary, path); break; }
          catch (error) {
            if (process.platform !== 'win32' || !['EPERM', 'EACCES', 'EBUSY'].includes(error.code) || attempt >= 10) throw error;
            await wait(10 + attempt * 5);
          }
        }
        persistedMs = activeMs;
        await refreshOthers();
        storageStatus = 'ok';
        return snapshot();
      } catch (error) {
        storageStatus = 'error';
        throw new Error('Unable to save active work duration.', { cause: error });
      } finally { await rm(temporary, { force: true }).catch(() => {}); }
    });
    writes = operation;
    return operation;
  }

  function start() {
    if (closed || closing) throw new Error('Work meter is closed.');
    if (startedAt === null) startedAt = now();
  }
  function pause() {
    if (startedAt !== null) {
      accumulatedMs = Math.min(Number.MAX_SAFE_INTEGER, accumulatedMs + now() - startedAt);
      startedAt = null;
    }
  }
  function close() {
    if (closing) return closing;
    pause();
    clearInterval(timer);
    closing = flush().finally(() => { closed = true; });
    return closing;
  }

  if (checkpointMs > 0) {
    timer = setInterval(() => { void flush().catch(() => {}); }, checkpointMs);
    timer.unref();
  }
  return { start, pause, snapshot, flush, close };
}
