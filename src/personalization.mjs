import { mkdir, open, lstat, rename, rm, chmod } from 'node:fs/promises';
import { constants } from 'node:fs';
import { createHash, randomUUID } from 'node:crypto';
import { dirname, join, resolve } from 'node:path';
import { validateConnection } from './runtime.mjs';
import { defaultWorkStateDir } from './work-meter.mjs';
import { createRedactor } from './redactor.mjs';

const preferenceLimits = Object.freeze({ language: 128, tone: 512, length: 512, format: 512, instructions: 8192 });
const invalidControls = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]/;
const maximumRecordBytes = 65536;
const storageError = () => new Error('Personalization storage is invalid or corrupted; existing records were left unchanged.');

function text(value, limit, label) {
  if (typeof value !== 'string' || value.length > limit || invalidControls.test(value)) throw new Error(`${label} must be text within its length limit and contain no terminal control characters.`);
  return value;
}

function identity(connection) {
  // Deliberately omit credentials, profile names, context limits and policies.
  const validated = validateConnection({ baseUrl: connection?.baseUrl, model: connection?.model, transport: connection?.transport });
  if (validated.baseUrl.length > 4096 || validated.model.length > 512) throw new Error('AI connection identity exceeds its length limit.');
  const url = new URL(validated.baseUrl);
  url.pathname = url.pathname.replace(/\/+$/, '') || '/';
  return createHash('sha256').update(JSON.stringify([url.toString(), validated.model, validated.transport])).digest('hex');
}

function sanitize(input, secrets = []) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('Personalization requires an object of selected preferences.');
  const { enabled = false, persona = '', preferences = {} } = input;
  if (typeof enabled !== 'boolean') throw new Error('Personalization enabled must be true or false.');
  if (!preferences || typeof preferences !== 'object' || Array.isArray(preferences)) throw new Error('Preferences must be an object of supported text fields.');
  const sensitive = [...new Set(secrets.filter(value => typeof value === 'string' && value))].sort((a, b) => b.length - a.length);
  const redact = value => {
    const redactor = createRedactor({ secrets: () => sensitive });
    return redactor.write(value) + redactor.flush();
  };
  const selected = {};
  for (const [key, value] of Object.entries(preferences)) {
    if (!Object.hasOwn(preferenceLimits, key)) throw new Error('Preferences contain an unsupported field.');
    selected[key] = text(redact(text(value, preferenceLimits[key], 'Preference')), preferenceLimits[key], 'Redacted preference');
  }
  const record = { enabled, persona: text(redact(text(persona, 8192, 'Persona')), 8192, 'Redacted persona'), preferences: selected };
  if (Buffer.byteLength(JSON.stringify(record)) > maximumRecordBytes - 256) throw new Error('Personalization exceeds its storage size limit.');
  return record;
}

/** Developer instructions are generated only for explicitly enabled records. */
export function personalizationInstructions(record) {
  if (record === undefined || record === null) return '';
  const value = sanitize(record);
  if (!value.enabled) return '';
  const lines = ['User-selected personalization for this AI connection:', 'Apply these preferences where compatible with the current task and higher-priority instructions.'];
  if (value.persona.trim()) lines.push(`Persona:\n${value.persona}`);
  const labels = { language: 'Language', tone: 'Tone', length: 'Response length', format: 'Response format', instructions: 'Additional preferences' };
  for (const key of Object.keys(preferenceLimits)) if (value.preferences[key]?.trim()) lines.push(`${labels[key]}:\n${value.preferences[key]}`);
  return lines.length > 2 ? lines.join('\n\n') : '';
}

async function realDirectory(path, create = false) {
  const parent = dirname(path);
  if (parent !== path) await realDirectory(parent, create);
  let info;
  try { info = await lstat(path); }
  catch (error) {
    if (!create || error?.code !== 'ENOENT') throw storageError();
    try { await mkdir(path, { mode: 0o700 }); } catch (error) { if (error?.code !== 'EEXIST') throw storageError(); }
    try { info = await lstat(path); } catch { throw storageError(); }
  }
  if (!info.isDirectory() || info.isSymbolicLink()) throw storageError();
}

/** Optional per-AI private records. API keys and runtime policies are never serialized. */
export async function createPersonalization({ stateDir = defaultWorkStateDir(), secrets = () => [] } = {}) {
  if (typeof stateDir !== 'string' || !stateDir || /[\u0000-\u001f\u007f]/.test(stateDir) || typeof secrets !== 'function') throw new Error('Personalization storage requires a valid state directory and secret source.');
  const directory = join(resolve(stateDir), 'personalization');
  await realDirectory(directory, true);
  if (process.platform !== 'win32') await chmod(directory, 0o700);
  function knownSecrets(connection) {
    const values = secrets();
    if (!Array.isArray(values)) throw new Error('Personalization secret source must return an array.');
    return [...values, connection?.apiKey];
  }
  const filename = id => `ai-${id}.json`;

  async function read(id, connection) {
    await realDirectory(directory);
    const path = join(directory, filename(id));
    let info;
    try { info = await lstat(path); } catch (error) { if (error?.code === 'ENOENT') return undefined; throw storageError(); }
    if (!info.isFile() || info.isSymbolicLink() || info.size > maximumRecordBytes) throw storageError();
    let file;
    try {
      file = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
      const actual = await file.stat();
      if (!actual.isFile() || actual.ino !== info.ino || actual.dev !== info.dev || actual.size !== info.size) throw storageError();
      const bytes = Buffer.alloc(info.size + 1);
      const { bytesRead } = await file.read(bytes, 0, bytes.length, 0);
      const after = await file.stat();
      if (bytesRead !== info.size || after.size !== info.size || after.mtimeMs !== actual.mtimeMs) throw storageError();
      const record = JSON.parse(bytes.subarray(0, bytesRead).toString('utf8'));
      if (record?.version !== 1 || record.id !== id || !Object.hasOwn(record, 'value')) throw storageError();
      return sanitize(record.value, knownSecrets(connection));
    } catch { throw storageError(); }
    finally { await file?.close().catch(() => {}); }
  }

  async function locked(id, operation) {
    await realDirectory(directory);
    const lockPath = join(directory, `${filename(id)}.lock`);
    let lock;
    try {
      try { lock = await open(lockPath, 'wx', 0o600); }
      catch (error) { if (error?.code === 'EEXIST') throw new Error('This AI personalization is locked by another session or an interrupted edit. Retry after that edit finishes.'); throw storageError(); }
      return await operation();
    } finally {
      if (lock) { await lock.close(); await rm(lockPath, { force: true }); }
    }
  }

  return {
    directory,
    async get(connection) { return read(identity(connection), connection); },
    async save(connection, input) {
      const id = identity(connection);
      const value = sanitize(input, knownSecrets(connection));
      const serialized = JSON.stringify({ version: 1, id, value }) + '\n';
      if (Buffer.byteLength(serialized) > maximumRecordBytes) throw new Error('Personalization exceeds its storage size limit.');
      return locked(id, async () => {
        await read(id, connection); // Refuse to replace corrupt records or symbolic links.
        const destination = join(directory, filename(id));
        const temporary = `${destination}.${randomUUID()}.tmp`;
        let file;
        try {
          file = await open(temporary, 'wx', 0o600);
          await file.writeFile(serialized, 'utf8');
          await file.sync();
          await file.close(); file = undefined;
          await realDirectory(directory);
          await rename(temporary, destination);
          return value;
        } finally {
          await file?.close().catch(() => {});
          await rm(temporary, { force: true });
        }
      });
    },
    async remove(connection) {
      const id = identity(connection);
      return locked(id, async () => {
        if (await read(id, connection) === undefined) return false;
        await rm(join(directory, filename(id)));
        return true;
      });
    },
  };
}
