import { constants } from 'node:fs';
import { mkdir, open, lstat, realpath, readdir, rename, rm } from 'node:fs/promises';
import { createHash, randomUUID } from 'node:crypto';
import { dirname, join, resolve } from 'node:path';
import { setTimeout as wait } from 'node:timers/promises';
import { createChatHistory } from './chat-history.mjs';
import { createRedactor } from './redactor.mjs';
import { validateConnection } from './runtime.mjs';
import { defaultWorkStateDir } from './work-meter.mjs';

export const MAX_CHAT_BYTES = 50 * 1024 * 1024;
const identifier = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const recordName = /^chat-([0-9a-f-]{36})\.json$/;
const validString = value => typeof value === 'string' && value.length && !/[\u0000-\u001f\u007f]/.test(value);
const timestamp = value => typeof value === 'string' && /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(value) && Number.isFinite(Date.parse(value));
const sameProject = (a, b) => process.platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b;
function validId(id) {
  if (typeof id !== 'string' || !identifier.test(id)) throw new Error('Saved chat identifier is invalid.');
  return id;
}

async function assertDirectoryPath(path) {
  // Refuse symlinks in the storage directory or any existing ancestor. This
  // also catches Windows junctions instead of following them to another user.
  let current = resolve(path);
  while (true) {
    let info;
    try { info = await lstat(current); } catch (error) { if (error.code !== 'ENOENT') throw new Error('Unable to inspect saved chat storage.'); }
    if (info && (info.isSymbolicLink() || !info.isDirectory())) throw new Error('Saved chat storage must use real directories without symbolic links.');
    const parent = dirname(current);
    if (parent === current) break;
    current = parent;
  }
}

/** Atomic, credential-free visible transcripts, with a last-chat pointer per project. */
export async function createChatStore({ stateDir = defaultWorkStateDir(), cwd = process.cwd(), secrets = () => [] } = {}) {
  if (!validString(stateDir) || !validString(cwd) || typeof secrets !== 'function') throw new Error('Saved chats require a valid storage directory, project directory and secret supplier.');
  let project;
  try { project = await realpath(resolve(cwd)); if (!(await lstat(project)).isDirectory()) throw new Error('directory'); }
  catch { throw new Error('Saved chat project must be an existing directory.'); }
  const directory = join(resolve(stateDir), 'chats');
  await assertDirectoryPath(directory);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  await assertDirectoryPath(directory);
  const canonicalDirectory = await realpath(directory);
  const projectKey = createHash('sha256').update(process.platform === 'win32' ? project.toLowerCase() : project).digest('hex');
  const pointerName = `last-${projectKey}.json`;
  const queues = new Map();
  let warnings = [];
  const knownSecrets = new Set();

  function clean(value) {
    const current = secrets();
    if (Array.isArray(current)) for (const secret of current) if (typeof secret === 'string' && secret.length) knownSecrets.add(secret);
    const redactor = createRedactor({ secrets: () => [...knownSecrets] });
    return redactor.write(value) + redactor.flush();
  }
  async function checkDirectory() {
    await assertDirectoryPath(directory);
    if (!sameProject(await realpath(directory), canonicalDirectory)) throw new Error('Saved chat storage directory changed; existing records were left untouched.');
  }
  function sanitizeConnection(value) {
    if (value === undefined || value === null) return undefined;
    if (typeof value.apiKey === 'string' && value.apiKey.length) knownSecrets.add(value.apiKey);
    const selected = validateConnection({ transport: value.transport, model: value.model, baseUrl: value.baseUrl, apiKeyEnv: value.apiKeyEnv, contextWindow: value.contextWindow, supportedEfforts: value.supportedEfforts });
    for (const [key, item] of Object.entries(selected)) if (typeof item === 'string') selected[key] = clean(item);
    return validateConnection(selected);
  }
  function sanitizeHistory(value = { version: 1, messages: [] }) {
    // Refuse obviously oversized visible transcripts before running the
    // streaming redactor across tens of megabytes of text.
    let estimatedBytes = 64;
    if (Array.isArray(value?.messages)) for (const message of value.messages) {
      estimatedBytes += 128;
      for (const key of ['id', 'content', 'model']) if (typeof message?.[key] === 'string') estimatedBytes += Buffer.byteLength(message[key]);
      if (estimatedBytes > MAX_CHAT_BYTES) throw new Error('Saved chat exceeds the storage size limit of 50 MiB.');
    }
    const history = createChatHistory({ secrets: () => { clean(''); return [...knownSecrets]; } });
    return history.restore(value);
  }
  function sanitizePending(value = []) {
    if (!Array.isArray(value) || value.length > 1000 || value.some(item => typeof item !== 'string')) throw new Error('Queued chat inputs must be a bounded list of text prompts.');
    let bytes = 64;
    for (const item of value) { bytes += Buffer.byteLength(item) + 4; if (bytes > MAX_CHAT_BYTES) throw new Error('Queued chat inputs exceed the saved chat storage size limit.'); }
    return value.map(clean);
  }
  function sanitizeSubmissions(value,inputs,history) {
    if(value===undefined)return undefined;
    if(!Array.isArray(value)||value.length!==inputs.length||(value.length&&!Number.isSafeInteger(history.promptCount)))throw new Error('Queued submission metadata must match the saved pending inputs.');
    let previous=0;
    return value.map(item=>{
      if(!item||!Number.isSafeInteger(item.sequence)||item.sequence<=previous||item.sequence>history.promptCount||typeof item.literal!=='boolean'||(item.timestamp!==undefined&&!timestamp(item.timestamp)))throw new Error('Queued prompt submission metadata is invalid.');
      previous=item.sequence;return {sequence:item.sequence,literal:item.literal,...(item.timestamp?{timestamp:item.timestamp}:{})};
    });
  }
  function title(value, history) {
    if (value !== undefined && (typeof value !== 'string' || value.length > 1000)) throw new Error('Saved chat title must be at most 1000 characters.');
    const selected = value ?? history.messages.find(message => message.role === 'user')?.content ?? 'New chat';
    return Array.from(clean(selected).replace(/\s+/g, ' ').trim()).slice(0, 160).join('') || 'New chat';
  }
  function sanitizeRecord(value, expectedId) {
    if (!value || typeof value !== 'object' || value.version !== 1 || value.id !== expectedId || !identifier.test(value.id)
      || !validString(value.cwd) || !timestamp(value.createdAt) || !timestamp(value.updatedAt) || typeof value.title !== 'string' || value.history === undefined) throw new Error('invalid');
    const history = sanitizeHistory(value.history);
    const result = { version: 1, id: value.id, title: title(value.title, history), cwd: value.cwd, createdAt: value.createdAt, updatedAt: value.updatedAt, history, pendingInputs: sanitizePending(value.pendingInputs) };
    const submissions=sanitizeSubmissions(value.pendingSubmissions,result.pendingInputs,history);if(submissions)result.pendingSubmissions=submissions;
    const connection = sanitizeConnection(value.connection);
    if (connection) result.connection = connection;
    return result;
  }
  async function readJson(name, limit, attempt = 0) {
    await checkDirectory();
    const path = join(directory, name);
    let file;
    try {
      const before = await lstat(path);
      if (!before.isFile() || before.isSymbolicLink() || before.size > limit) throw new Error('invalid');
      file = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW || 0));
      const info = await file.stat();
      if (!info.isFile() || info.size > limit) throw new Error('invalid');
      if (info.dev !== before.dev || info.ino !== before.ino) { const changed = new Error('changed'); changed.code = 'CHAT_ATOMIC_GENERATION_CHANGED'; throw changed; }
      const chunks = [];
      let bytes = 0;
      while (true) {
        const buffer = Buffer.allocUnsafe(Math.min(65536, limit + 1 - bytes));
        const result = await file.read(buffer, 0, buffer.length, null);
        if (!result.bytesRead) break;
        bytes += result.bytesRead;
        if (bytes > limit) throw new Error('invalid');
        chunks.push(buffer.subarray(0, result.bytesRead));
      }
      const after = await file.stat();
      if (after.size !== info.size || after.mtimeMs !== info.mtimeMs || bytes !== info.size) throw new Error('invalid');
      return JSON.parse(Buffer.concat(chunks, bytes).toString('utf8'));
    } catch (error) {
      if (error.code === 'CHAT_ATOMIC_GENERATION_CHANGED' && attempt < 3) {
        await file?.close().catch(() => {}); file = undefined;
        return readJson(name, limit, attempt + 1);
      }
      if (error.code === 'ENOENT') return undefined;
      throw new Error('Saved chat data is invalid or unreadable; existing storage was left unchanged.');
    } finally { await file?.close().catch(() => {}); }
  }
  async function get(id) {
    validId(id);
    const value = await readJson(`chat-${id}.json`, MAX_CHAT_BYTES);
    if (value === undefined) return undefined;
    try { return sanitizeRecord(value, id); } catch { throw new Error('Saved chat data is invalid; existing storage was left unchanged.'); }
  }
  async function locked(name, operation) {
    const previous = queues.get(name) || Promise.resolve();
    const next = previous.catch(() => {}).then(async () => {
      await checkDirectory();
      const path = join(directory, `${name}.lock`);
      let lock;
      try {
        try { lock = await open(path, 'wx', 0o600); }
        catch (error) {
          if (error.code === 'EEXIST') throw new Error('This saved chat is being edited by another session or has an interrupted edit lock.');
          throw new Error('Unable to lock saved chat storage.');
        }
        return await operation();
      } finally {
        if (lock) { await lock.close().catch(() => {}); await rm(path, { force: true }).catch(() => {}); }
      }
    });
    queues.set(name, next);
    try { return await next; } finally { if (queues.get(name) === next) queues.delete(name); }
  }
  async function atomicWrite(name, value, limit) {
    const serialized = JSON.stringify(value) + '\n';
    if (Buffer.byteLength(serialized) > limit) throw new Error('Saved chat exceeds the storage size limit of 50 MiB.');
    const destination = join(directory, name);
    const temporary = `${destination}.${randomUUID()}.tmp`;
    let file;
    try {
      await checkDirectory();
      file = await open(temporary, 'wx', 0o600);
      await file.writeFile(serialized, 'utf8');
      await file.sync();
      await file.close(); file = undefined;
      for (let attempt = 0; ; attempt++) {
        await checkDirectory();
        try { await rename(temporary, destination); break; }
        catch (error) {
          if (process.platform !== 'win32' || !['EPERM', 'EACCES', 'EBUSY'].includes(error.code) || attempt >= 10) throw error;
          await wait(10 + attempt * 5);
        }
      }
    } finally { await file?.close().catch(() => {}); await rm(temporary, { force: true }).catch(() => {}); }
  }
  async function readPointer() {
    const pointer = await readJson(pointerName, 1024);
    if (pointer !== undefined && (!pointer || pointer.version !== 1 || !identifier.test(pointer.id) || !validString(pointer.cwd) || !sameProject(pointer.cwd, project))) throw new Error('Last saved chat pointer is invalid; existing storage was left unchanged.');
    return pointer;
  }
  async function setLast(id) {
    validId(id);
    return locked(pointerName, async () => {
      const record = await get(id);
      if (!record) throw new Error('Saved chat was not found.');
      if (!sameProject(record.cwd, project)) throw new Error('Saved chat belongs to another project; open that project before resuming.');
      await readPointer(); // Do not silently replace corrupt pointers or links.
      await atomicWrite(pointerName, { version: 1, id, cwd: project }, 1024);
      return record;
    });
  }
  return {
    directory,
    warnings() { return [...warnings]; },
    get,
    async create({ title: selectedTitle, connection, history: suppliedHistory, pendingInputs,pendingSubmissions } = {}) {
      await readPointer();
      const metadata = sanitizeConnection(connection);
      const history = sanitizeHistory(suppliedHistory);
      const record = { version: 1, id: randomUUID(), title: title(selectedTitle, history), cwd: project, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), history, pendingInputs: sanitizePending(pendingInputs) };
      const submissions=sanitizeSubmissions(pendingSubmissions,record.pendingInputs,history);if(submissions)record.pendingSubmissions=submissions;
      if (metadata) record.connection = metadata;
      await locked(`chat-${record.id}.json`, async () => {
        if (await get(record.id)) throw new Error('Saved chat identifier already exists.');
        await atomicWrite(`chat-${record.id}.json`, record, MAX_CHAT_BYTES);
      });
      await setLast(record.id);
      return record;
    },
    async save({ id, title: selectedTitle, connection, history: suppliedHistory, pendingInputs,pendingSubmissions } = {}) {
      validId(id);
      if (suppliedHistory === undefined) throw new Error('Saving a chat requires an explicit history snapshot.');
      const metadata = connection === undefined ? undefined : sanitizeConnection(connection);
      const history = sanitizeHistory(suppliedHistory);
      const pending = pendingInputs === undefined ? undefined : sanitizePending(pendingInputs);
      return locked(`chat-${id}.json`, async () => {
        const previous = await get(id);
        if (!previous) throw new Error('Saved chat was not found. Create a chat before saving it.');
        if (!sameProject(previous.cwd, project)) throw new Error('Saved chat belongs to another project; existing chat was left unchanged.');
        const record = { version: 1, id, title: title(selectedTitle ?? (previous.title === 'New chat' ? undefined : previous.title), history), cwd: project, createdAt: previous.createdAt, updatedAt: new Date().toISOString(), history, pendingInputs: pending ?? previous.pendingInputs };
        const submissions=sanitizeSubmissions(pendingSubmissions??(pending===undefined?previous.pendingSubmissions:undefined),record.pendingInputs,history);if(submissions)record.pendingSubmissions=submissions;
        const selectedConnection = connection === undefined ? previous.connection : metadata;
        if (selectedConnection) record.connection = selectedConnection;
        await atomicWrite(`chat-${id}.json`, record, MAX_CHAT_BYTES);
        return record;
      });
    },
    async list({ allProjects = false } = {}) {
      if (typeof allProjects !== 'boolean') throw new Error('Saved chat listing options are invalid.');
      await checkDirectory();
      warnings = [];
      const records = [];
      for (const name of (await readdir(directory)).filter(value => recordName.test(value))) {
        const id = recordName.exec(name)[1];
        try {
          const record = await get(id);
          if (record && (allProjects || sameProject(record.cwd, project))) records.push(record);
        } catch { warnings.push(`Saved chat ${id} is invalid or unreadable and was skipped.`); }
      }
      return records.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt) || b.createdAt.localeCompare(a.createdAt) || b.id.localeCompare(a.id));
    },
    async last() {
      const pointer = await readPointer();
      if (!pointer) return undefined;
      const record = await get(pointer.id);
      if (record && !sameProject(record.cwd, project)) throw new Error('Last saved chat belongs to another project.');
      return record;
    },
    setLast,
    async remove(id) {
      validId(id);
      return locked(`chat-${id}.json`, async () => {
        const record = await get(id);
        if (!record) return false;
        if (!sameProject(record.cwd, project)) throw new Error('Saved chat belongs to another project; existing chat was left unchanged.');
        await locked(pointerName, async () => {
          const pointer = await readPointer();
          await rm(join(directory, `chat-${id}.json`));
          if (pointer?.id === id) await rm(join(directory, pointerName));
        });
        return true;
      });
    },
  };
}
