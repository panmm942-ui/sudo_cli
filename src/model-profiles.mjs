import { mkdir, open, lstat, readFile, readdir, rename, rm } from 'node:fs/promises';
import { createHash, randomUUID } from 'node:crypto';
import { join, resolve } from 'node:path';
import { validateConnection } from './runtime.mjs';
import { defaultWorkStateDir } from './work-meter.mjs';

export const localEndpointPresets = Object.freeze([
  Object.freeze({ id: 'ollama', label: 'Ollama local server', baseUrl: 'http://localhost:11434/v1', transport: 'chat-completions', requiresRunningServer: true }),
  Object.freeze({ id: 'lmstudio', label: 'LM Studio local server', baseUrl: 'http://localhost:1234/v1', transport: 'chat-completions', requiresRunningServer: true }),
  Object.freeze({ id: 'customLocal', label: 'Custom local compatible server', baseUrl: 'http://localhost:8000/v1', transport: 'chat-completions', requiresRunningServer: true }),
]);

const recordPattern = /^model-[a-f0-9]{64}\.json$/;
function validName(value) {
  if (typeof value !== 'string' || !value.trim() || value.length > 120 || /[\p{Cc}\p{Cf}]/u.test(value)) throw new Error('Model profile name must be nonempty, at most 120 characters and contain no control characters.');
  return value.trim().normalize('NFC');
}
function filename(name) { return `model-${createHash('sha256').update(validName(name).toLowerCase()).digest('hex')}.json`; }
function sanitize(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('A named model profile is required.');
  const name = validName(input.name);
  // Copy metadata explicitly. Never pass a connection's apiKey or arbitrary fields
  // to JSON serialization, including nested values from callers.
  const connection = validateConnection({ model: input.model, transport: input.transport, baseUrl: input.baseUrl, apiKeyEnv: input.apiKeyEnv, contextWindow: input.contextWindow,capabilities:input.capabilities });
  const profile = { name, ...connection };
  if (input.supportedEfforts !== undefined) {
    if (!Array.isArray(input.supportedEfforts) || input.supportedEfforts.length > 32 || input.supportedEfforts.some(value => typeof value !== 'string' || !/^[a-z][a-z0-9_-]{0,31}$/.test(value))) throw new Error('Supported effort capabilities must be a bounded list of simple identifiers.');
    profile.supportedEfforts = [...new Set(input.supportedEfforts)];
  }
  return profile;
}

/** Dedicated profile records; no API keys, session policy or conversation content. */
export async function createModelProfiles({ stateDir = defaultWorkStateDir() } = {}) {
  if (typeof stateDir !== 'string' || !stateDir || /[\u0000-\u001f\u007f]/.test(stateDir)) throw new Error('Model profile state directory is invalid.');
  const directory = join(resolve(stateDir), 'models');
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const rootInfo = await lstat(directory);
  if (rootInfo.isSymbolicLink() || !rootInfo.isDirectory()) throw new Error('Model profile storage must be a real directory.');

  async function read(name) {
    const path = join(directory, name);
    let info;
    try { info = await lstat(path); } catch (error) { if (error?.code === 'ENOENT') return undefined; throw new Error('Unable to read model profile storage.'); }
    if (!info.isFile() || info.isSymbolicLink() || info.size > 16384) throw new Error('Saved model profile is invalid; existing storage was left unchanged.');
    try {
      const record = JSON.parse(await readFile(path, 'utf8'));
      if (record.version !== 1) throw new Error('version');
      const profile = sanitize(record.profile);
      if (filename(profile.name) !== name) throw new Error('identity');
      return profile;
    } catch (error) {
      if (error?.code === 'ENOENT') return undefined;
      throw new Error('Saved model profile is invalid; existing storage was left unchanged.');
    }
  }
  async function locked(name, operation) {
    const lockPath = join(directory, `${name}.lock`);
    let lock;
    try {
      try { lock = await open(lockPath, 'wx', 0o600); }
      catch (error) { if (error?.code === 'EEXIST') throw new Error('This model profile is being edited by another session or has an interrupted edit lock. Retry when that edit is finished.'); throw new Error('Unable to lock model profile storage.'); }
      return await operation();
    } finally {
      if (lock) { try { await lock.close(); } finally { await rm(lockPath, { force: true }); } }
    }
  }
  return {
    async list() {
      const names = (await readdir(directory)).filter(name => recordPattern.test(name));
      const values = await Promise.all(names.map(read));
      return values.filter(Boolean).sort((a, b) => a.name.localeCompare(b.name));
    },
    async get(name) { return read(filename(name)); },
    async save(input) {
      const profile = sanitize(input);
      const serialized = JSON.stringify({ version: 1, profile }) + '\n';
      if (Buffer.byteLength(serialized, 'utf8') > 16384) throw new Error('Model profile metadata exceeds its storage size limit.');
      const name = filename(profile.name);
      return locked(name, async () => {
        // Refuse to replace a corrupted record or symbolic link.
        await read(name);
        const destination = join(directory, name);
        const temporary = `${destination}.${randomUUID()}.tmp`;
        let file;
        try {
          file = await open(temporary, 'wx', 0o600);
          await file.writeFile(serialized, 'utf8');
          await file.close(); file = undefined;
          await rename(temporary, destination);
          return profile;
        } finally {
          await file?.close().catch(() => {});
          await rm(temporary, { force: true });
        }
      });
    },
    async remove(name) {
      const id = filename(name);
      return locked(id, async () => {
        if (await read(id) === undefined) return false;
        await rm(join(directory, id));
        return true;
      });
    },
    directory,
  };
}
