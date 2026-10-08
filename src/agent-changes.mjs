import { constants } from 'node:fs';
import { lstat, realpath, open, mkdir, readdir, rename, unlink, link } from 'node:fs/promises';
import { resolve, join, dirname, relative, isAbsolute, sep } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { collectWorkspaceFiles, isExcludedWorkspacePath, redactWorkspaceText } from './workspace-tools.mjs';
import { privateDirectory, createPrivateRecord } from './private-state.mjs';
import { defaultWorkStateDir } from './work-meter.mjs';

const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const digest = /^[0-9a-f]{64}$/;
const abort = signal => { if (signal?.aborted) throw new DOMException('Agent changes were cancelled.', 'AbortError'); };
const within = (root, path) => { const rel = relative(root, path); return !rel || !isAbsolute(rel) && rel !== '..' && !rel.startsWith(`..${sep}`); };
const cleanPath = value => typeof value === 'string' && value.length > 0 && value.length <= 4096 && !isAbsolute(value) && !value.includes('\\')
  && !/[\u0000-\u001f\u007f:]/.test(value) && value.split('/').every(part => part && part !== '.' && part !== '..'
    && !/[. ]$/.test(part) && !/^(?:CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])(?:\.|$)/i.test(part));
const excluded = path => isExcludedWorkspacePath(path) || path.split('/').some(part => part === '.snapshot-owner' || part.toLowerCase() === '.source-agents.md' || /^\.sudocli-agent-.*\.tmp$/.test(part));
const integer = (value, fallback, maximum, name) => {
  value ??= fallback;
  if (!Number.isSafeInteger(value) || value < 1 || value > maximum) throw new Error(`${name} exceeds its bounded limit.`);
  return value;
};
const boundsFor = options => ({ maxFiles: integer(options.maxFiles, 500, 2000, 'Agent file count'),
  maxFileBytes: integer(options.maxFileBytes, 512 * 1024, 1024 * 1024, 'Agent file size'),
  maxTotalBytes: integer(options.maxTotalBytes, 8 * 1024 * 1024, 16 * 1024 * 1024, 'Agent total size'),
  maxEntries: integer(options.maxEntries, 10000, 20000, 'Agent entry count') });
const text = (value, maximum, name, fallback = '') => {
  value ??= fallback;
  if (typeof value !== 'string' || Buffer.byteLength(value) > maximum || value.includes('\0')) throw new Error(`${name} must be bounded text.`);
  return value;
};
function safeContent(bytes, secrets) {
  if (bytes.includes(0)) return false;
  let value;
  try { value = new TextDecoder('utf-8', { fatal: true }).decode(bytes); } catch { return false; }
  // Omit credential-bearing code instead of changing it into executable redacted code.
  const normalized = value.replace(/\r\n?/g, '\n');
  return !/\[redacted(?: private key)?\]/i.test(value)
    && redactWorkspaceText(normalized, secrets) === normalized;
}
async function rootFor(cwd) {
  if (typeof cwd !== 'string' || !cwd || /[\u0000-\u001f\u007f]/.test(cwd)) throw new Error('Agent workspace is invalid.');
  const root = await realpath(resolve(cwd));
  if (!(await lstat(root)).isDirectory()) throw new Error('Agent workspace must be a directory.');
  return root;
}
const absent = async path => lstat(path).catch(error => { if (error.code === 'ENOENT') return null; throw error; });
const sameIdentity = (a, b) => a.dev === b.dev && a.ino === b.ino;

/** Raw source bytes stay local. Credential-bearing, binary and placeholder code is omitted. */
export async function captureAgentWorkspace({ cwd = process.cwd(), secrets = () => [], sourcePartial = false, signal, excludePaths = [], ...options } = {}) {
  if (typeof secrets !== 'function' || typeof sourcePartial !== 'boolean') throw new Error('Agent capture options are invalid.');
  const bounds = boundsFor(options), captured = await collectWorkspaceFiles({ cwd, signal, excludePaths, ...bounds });
  const files = [], skipped = [...captured.skipped]; let totalBytes = 0;
  for (const file of captured.files) {
    abort(signal);
    if (excluded(file.path)) continue;
    const info = await absent(join(captured.cwd, file.path));
    if (!cleanPath(file.path) || redactWorkspaceText(file.path, secrets) !== file.path || !info?.isFile() || info.isSymbolicLink() || info.nlink !== 1) {
      skipped.push({ path: redactWorkspaceText(file.path, secrets), reason: 'unsafe-source' }); continue;
    }
    if (!safeContent(file.data, secrets)) { skipped.push({ path: file.path, reason: 'sensitive-or-binary-source' }); continue; }
    files.push({ path: file.path, hash: file.hash, bytes: file.bytes, mode: file.mode, content: file.data.toString('base64') });
    totalBytes += file.bytes;
  }
  return { files, skipped: skipped.slice(0, 1000).map(item => ({ path: redactWorkspaceText(item.path, secrets), reason: item.reason })),
    partial: captured.partial || skipped.length > 0, sourcePartial, totalBytes, limits: bounds };
}

function decodedFile(file, bounds, { change = false } = {}) {
  if (!object(file) || !cleanPath(file.path) || excluded(file.path) || !Number.isSafeInteger(file.bytes) || file.bytes < 0 || file.bytes > bounds.maxFileBytes
    || !Number.isSafeInteger(file.mode) || file.mode < 0 || file.mode > 0o777) throw new Error('Agent proposal contains invalid file metadata.');
  if (change && file.kind === 'deleted') {
    if (file.content !== null || file.afterHash !== null || file.bytes !== 0) throw new Error('Agent deletion metadata is invalid.');
    return null;
  }
  if (typeof file.content !== 'string' || file.content.length > Math.ceil(bounds.maxFileBytes / 3) * 4 || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(file.content)) throw new Error('Agent file content is invalid.');
  const bytes = Buffer.from(file.content, 'base64'), expected = change ? file.afterHash : file.hash;
  if (bytes.length !== file.bytes || !digest.test(expected) || hash(bytes) !== expected) throw new Error('Agent file integrity failed.');
  return bytes;
}
function snapshotMap(snapshot, bounds) {
  if (!object(snapshot) || !Array.isArray(snapshot.files) || snapshot.files.length > bounds.maxFiles || !Array.isArray(snapshot.skipped) || snapshot.skipped.length > 1000
    || typeof snapshot.partial !== 'boolean' || typeof snapshot.sourcePartial !== 'boolean') throw new Error('Agent snapshot is invalid.');
  const files = new Map(); let total = 0;
  for (const file of snapshot.files) {
    const bytes = decodedFile(file, bounds); total += bytes.length;
    const key = process.platform === 'win32' ? file.path.toLowerCase() : file.path;
    if (files.has(key) || total > bounds.maxTotalBytes) throw new Error('Agent snapshot exceeds its bounds or contains duplicate paths.');
    files.set(key, file);
  }
  return files;
}

/** A proposal is evidence only. Applying it is a separate caller-authorized action. */
export function diffAgentWorkspace(before, after) {
  const bounds = boundsFor(before?.limits ?? {}), previous = snapshotMap(before, bounds), next = snapshotMap(after, bounds);
  const skipped = [...before.skipped, ...after.skipped].slice(0, 1000), unknown = skipped.map(item => item.path), files = [];
  for (const key of [...new Set([...previous.keys(), ...next.keys()])].sort()) {
    const old = previous.get(key), current = next.get(key), path = current?.path ?? old.path;
    if (old?.hash === current?.hash || unknown.some(item => path === item || path.startsWith(`${item}/`))) continue;
    // A truncated source scan cannot prove that a missing file was deleted or newly added.
    if (skipped.some(item => /^(?:entry-count-limit|file-count-limit|total-size-limit)$/.test(item.reason)) && (!old || !current)) { skipped.push({ path, reason: 'partial-scan-unknown' }); continue; }
    if (files.length >= bounds.maxFiles) { skipped.push({ path, reason: 'change-count-limit' }); continue; }
    files.push({ path, kind: !old ? 'added' : !current ? 'deleted' : 'modified', beforeHash: old?.hash ?? null,
      beforeContent: old?.content ?? null, afterHash: current?.hash ?? null, content: current?.content ?? null, bytes: current?.bytes ?? 0, mode: current?.mode ?? old.mode });
  }
  return { files, skipped: skipped.slice(0, 1000), partial: before.partial || after.partial || before.sourcePartial || after.sourcePartial || skipped.length > 0,
    limits: bounds };
}

function validatedChanges(changes, bounds, secrets) {
  if (!object(changes) || !Array.isArray(changes.files) || changes.files.length > bounds.maxFiles || !Array.isArray(changes.skipped) || changes.skipped.length > 1000 || typeof changes.partial !== 'boolean') throw new Error('Agent changes are invalid.');
  const files = [], seen = new Set(), skipped = []; let total = 0;
  for (const file of changes.files) {
    const bytes = decodedFile(file, bounds, { change: true });
    if (!['added', 'modified', 'deleted'].includes(file.kind) || (file.kind === 'added' ? file.beforeHash !== null : !digest.test(file.beforeHash))
      || file.kind !== 'deleted' && !digest.test(file.afterHash)) throw new Error('Agent change hashes are invalid.');
    let beforeData = null;
    if (file.kind === 'added') { if (file.beforeContent !== null) throw new Error('Agent addition contains invalid previous bytes.'); }
    else {
      if (typeof file.beforeContent !== 'string' || file.beforeContent.length > Math.ceil(bounds.maxFileBytes / 3) * 4) throw new Error('Agent previous content exceeds its bounds.');
      beforeData = Buffer.from(file.beforeContent, 'base64');
      decodedFile({ path: file.path, mode: file.mode, bytes: beforeData.length, hash: file.beforeHash, content: file.beforeContent }, bounds);
    }
    const key = process.platform === 'win32' ? file.path.toLowerCase() : file.path;
    if (seen.has(key)) throw new Error('Agent changes contain duplicate paths.'); seen.add(key);
    total += (bytes?.length ?? 0) + (beforeData?.length ?? 0);
    if (total > bounds.maxTotalBytes * 2) throw new Error('Agent changes exceed the total size limit.');
    if (redactWorkspaceText(file.path, secrets) !== file.path || bytes && !safeContent(bytes, secrets) || beforeData && !safeContent(beforeData, secrets)) {
      skipped.push({ path: redactWorkspaceText(file.path, secrets), reason: 'sensitive-or-binary-source' }); continue;
    }
    files.push({ path: file.path, kind: file.kind, beforeHash: file.beforeHash, beforeContent: file.beforeContent,
      afterHash: file.afterHash, content: file.content, bytes: file.bytes, mode: file.mode, data: bytes, beforeData });
  }
  for (const item of changes.skipped) {
    if (!object(item) || typeof item.path !== 'string' || item.path.length > 4096 || typeof item.reason !== 'string' || item.reason.length > 100) throw new Error('Agent skipped-file metadata is invalid.');
    skipped.push({ path: redactWorkspaceText(item.path, secrets), reason: redactWorkspaceText(item.reason, secrets) });
  }
  return { files, skipped: skipped.slice(0, 1000), partial: changes.partial || skipped.length > 0 };
}

async function checkedPath(root, path, { createParents = false, expectedParents } = {}) {
  if (!cleanPath(path) || excluded(path)) throw new Error('Unsafe agent path.');
  const rootInfo = await lstat(root);
  if (!rootInfo.isDirectory() || rootInfo.isSymbolicLink() || await realpath(root) !== root) throw new Error('Agent workspace root changed.');
  const parents = [{ path: root, info: rootInfo }]; let current = root;
  for (const [index, part] of path.split('/').entries()) {
    current = join(current, part); let info = await absent(current);
    if (info?.isSymbolicLink() || info && info.nlink !== 1 && info.isFile()) throw new Error('Symbolic or linked agent targets are refused.');
    if (index < path.split('/').length - 1) {
      if (!info && createParents) {
        let created = false;
        await mkdir(current, { mode: 0o700 }).then(() => { created = true; }).catch(error => { if (error.code !== 'EEXIST') throw error; });
        info = await lstat(current);
        if (created && process.platform !== 'win32') {
          if (!info.isDirectory() || info.isSymbolicLink()) throw new Error('New agent parent was replaced.');
          let directory;
          try {
            directory = await open(current, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
            const actual = await directory.stat(), named = await lstat(current);
            if (!actual.isDirectory() || !sameIdentity(info, actual) || !sameIdentity(named, actual) || named.isSymbolicLink() || await realpath(current) !== current) throw new Error('New agent parent changed.');
            for (const parent of parents) {
              const now = await lstat(parent.path);
              if (!now.isDirectory() || now.isSymbolicLink() || !sameIdentity(parent.info, now)) throw new Error('Agent parent changed during apply.');
            }
            const owner = parents.at(-1).info; await directory.chown(owner.uid, owner.gid); info = await directory.stat();
          } finally { await directory?.close(); }
        }
      }
      if (info && (!info.isDirectory() || info.isSymbolicLink())) throw new Error('Agent parent is not a real directory.');
      if (info) parents.push({ path: current, info });
    } else if (info && !info.isFile()) throw new Error('Agent target is not a regular file.');
  }
  if (!within(root, current)) throw new Error('Agent path escapes the project.');
  if (expectedParents) for (const parent of expectedParents) {
    const now = await lstat(parent.path);
    if (!now.isDirectory() || now.isSymbolicLink() || !sameIdentity(parent.info, now)) throw new Error('Agent parent changed during apply.');
  }
  return { path: current, parents };
}
async function currentFile(path, maxBytes) {
  let handle;
  const before = await absent(path);
  if (!before) return null;
  if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1 || before.size > maxBytes) throw new Error('Agent target is unsafe or too large.');
  try {
    handle = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0)); const actual = await handle.stat();
    if (!sameIdentity(before, actual) || actual.nlink !== 1 || actual.size !== before.size) throw new Error('Agent target changed while opening.');
    const data = Buffer.alloc(maxBytes + 1); let length = 0;
    while (length < data.length) { const { bytesRead } = await handle.read(data, length, data.length - length, null); if (!bytesRead) break; length += bytesRead; }
    const after = await handle.stat();
    if (length > maxBytes || !sameIdentity(actual, after) || after.size !== actual.size || after.mtimeMs !== actual.mtimeMs || after.nlink !== 1) throw new Error('Agent target changed while reading.');
    return { hash: hash(data.subarray(0, length)), info: after };
  } finally { await handle?.close(); }
}

/** Apply only a bounded reviewed proposal. The caller must enforce current permission/approval policy. */
export async function applyAgentChanges({ cwd = process.cwd(), changes, secrets = () => [], signal, ...options } = {}) {
  if (typeof secrets !== 'function') throw new Error('Agent secret provider is invalid.');
  abort(signal); const root = await rootFor(cwd), bounds = boundsFor(options), prepared = validatedChanges(changes, bounds, secrets);
  // Validate every proposed path before writing any file; no malformed trailing path can cause partial apply.
  const safe = [], conflicts = [], applied = [];
  for (const file of prepared.files) {
    abort(signal);
    try { await checkedPath(root, file.path); safe.push(file); }
    catch { conflicts.push({ path: file.path, reason: 'unsafe-target-or-parent' }); }
  }
  for (const file of safe) {
    abort(signal); let temporary;
    try {
      const checked = await checkedPath(root, file.path), before = await currentFile(checked.path, bounds.maxFileBytes);
      if ((before?.hash ?? null) !== file.beforeHash) { conflicts.push({ path: file.path, reason: 'original-changed' }); continue; }
      if (file.kind === 'deleted') {
        await checkedPath(root, file.path, { expectedParents: checked.parents });
        const latest = await currentFile(checked.path, bounds.maxFileBytes);
        if (!latest || latest.hash !== file.beforeHash || !sameIdentity(before.info, latest.info)) { conflicts.push({ path: file.path, reason: 'original-changed' }); continue; }
        abort(signal); await unlink(checked.path); applied.push(file.path); continue;
      }
      const writable = await checkedPath(root, file.path, { createParents: true, expectedParents: checked.parents });
      temporary = join(dirname(writable.path), `.sudocli-agent-${randomUUID()}.tmp`);
      let handle;
      try {
        handle = await open(temporary, 'wx', 0o600); await handle.writeFile(file.data);
        // Disposable snapshots intentionally use private modes; preserve the original's
        // executable/read permissions and owner rather than copying snapshot metadata.
        if (process.platform !== 'win32') {
          const owner = before?.info ?? writable.parents.at(-1).info;
          await handle.chown(owner.uid, owner.gid);
          if (before) await handle.chmod(before.info.mode & 0o777);
        }
        await handle.sync();
      } finally { await handle?.close(); }
      await checkedPath(root, file.path, { expectedParents: writable.parents });
      const latest = await currentFile(writable.path, bounds.maxFileBytes);
      if ((latest?.hash ?? null) !== file.beforeHash || before && (!latest || !sameIdentity(before.info, latest.info))) {
        conflicts.push({ path: file.path, reason: 'original-changed' }); continue;
      }
      abort(signal);
      if (file.kind === 'added') {
        // An exclusive hard-link commit is atomic and cannot replace a human-created target.
        // The temporary link is removed below, leaving one private regular source file.
        await link(temporary, writable.path);
      } else await rename(temporary, writable.path);
      applied.push(file.path);
    } catch (error) {
      if (signal?.aborted) throw error;
      conflicts.push({ path: file.path, reason: error.code === 'EEXIST' ? 'original-changed' : 'unsafe-or-unwritable-target' });
    } finally { if (temporary) await unlink(temporary).catch(error => { if (error.code !== 'ENOENT') throw error; }); }
  }
  return { applied, conflicts, skipped: prepared.skipped, partial: prepared.partial || conflicts.length > 0 };
}

/** Private immutable reports and proposals; reading/saving never changes source files. */
export async function createAgentResults({ cwd = process.cwd(), stateDir = defaultWorkStateDir(), secrets = () => [], maxRuns = 20 } = {}) {
  if (typeof secrets !== 'function') throw new Error('Agent result secret provider is invalid.');
  maxRuns = integer(maxRuns, 20, 20, 'Saved agent run count');
  const root = await rootFor(cwd), storage = await privateDirectory(join(resolve(stateDir), 'agent-results', hash(root).slice(0, 32)));
  const info = await lstat(storage), maximumBytes = 16 * 1024 * 1024;
  async function assertStorage() {
    const current = await lstat(storage);
    if (!current.isDirectory() || current.isSymbolicLink() || !sameIdentity(info, current) || await realpath(storage) !== storage) throw new Error('Agent result storage changed.');
  }
  const record = async id => {
    if (!uuid.test(id)) throw new Error('Agent run identifier is invalid.');
    await assertStorage(); return createPrivateRecord({ directory: storage, filename: `${id}.json`, maxBytes: maximumBytes });
  };
  async function withLock(fn) {
    await assertStorage(); let handle;
    const lockPath = join(storage, '.store.lock');
    try { handle = await open(lockPath, 'wx', 0o600); await assertStorage(); return await fn(); }
    catch (error) { if (error.code === 'EEXIST') throw new Error('Agent results are locked by another or interrupted session.'); throw error; }
    finally { if (handle) { await handle.close(); await assertStorage(); await unlink(lockPath); } }
  }
  function normalize(value, { id, createdAt }) {
    if (!object(value)) throw new Error('Agent run is invalid.');
    const agents = value.agents ?? value.results;
    if (!Array.isArray(agents) || agents.length > 8) throw new Error('Agent run needs up to eight outcomes.');
    const bounds = boundsFor({}); let totalBytes = 0, partial = Boolean(value.partial);
    const outcomes = agents.map(item => {
      if (!object(item)) throw new Error('Agent outcome is invalid.');
      const outcome = { name: redactWorkspaceText(text(item.name, 200, 'Agent name', item.role ?? 'Agent'), secrets),
        role: redactWorkspaceText(text(item.role, 200, 'Agent role'), secrets), mode: redactWorkspaceText(text(item.mode, 100, 'Agent mode'), secrets),
        status: redactWorkspaceText(text(item.status, 100, 'Agent status', 'completed'), secrets),
        text: redactWorkspaceText(text(item.text, 128 * 1024, 'Agent output'), secrets),
        model: redactWorkspaceText(text(item.model, 500, 'Agent model'), secrets),
        partial: Boolean(item.partial), advisory: true, verified: false };
      if (item.threadId !== undefined) outcome.threadId = redactWorkspaceText(text(item.threadId, 200, 'Agent thread'), secrets);
      if (item.error !== undefined) outcome.error = redactWorkspaceText(text(item.error, 8192, 'Agent error'), secrets);
      if (item.files !== undefined) {
        if (!Number.isSafeInteger(item.files) || item.files < 0 || item.files > 2000) throw new Error('Agent source count is invalid.');
        outcome.files = item.files;
      }
      if (item.changes) {
        const clean = validatedChanges(item.changes, bounds, secrets), files = [], skipped = [...clean.skipped];
        for (const file of clean.files) {
          const bytes = file.bytes + (file.beforeData?.length ?? 0);
          if (totalBytes + bytes > bounds.maxTotalBytes) { skipped.push({ path: file.path, reason: 'saved-run-size-limit' }); outcome.partial = true; continue; }
          totalBytes += bytes;
          const { data, beforeData, ...saved } = file; files.push(saved);
        }
        outcome.changes = { files, skipped: skipped.slice(0, 1000), partial: clean.partial || skipped.length > 0 };
        outcome.partial ||= outcome.changes.partial;
      }
      partial ||= outcome.partial;
      return outcome;
    });
    return { version: 1, id, cwd: root, createdAt, task: redactWorkspaceText(text(value.task, 32768, 'Agent task'), secrets),
      mode: redactWorkspaceText(text(value.mode, 100, 'Agent run mode', 'team'), secrets), status: redactWorkspaceText(text(value.status, 100, 'Agent run status', 'completed'), secrets),
      partial, verified: false, agents: outcomes, results: outcomes };
  }
  async function get(id) {
    const value = await (await record(id)).read(); if (!value) throw new Error('Saved agent run was not found.');
    if (!object(value) || value.version !== 1 || value.id !== id || value.cwd !== root || typeof value.createdAt !== 'string' || value.createdAt.length > 40 || !Number.isFinite(Date.parse(value.createdAt))) throw new Error('Saved agent run is invalid.');
    return normalize(value, { id, createdAt: value.createdAt });
  }
  async function list() {
    await assertStorage(); const names = (await readdir(storage)).filter(name => uuid.test(name.slice(0, -5)) && name.endsWith('.json'));
    if (names.length > 100) throw new Error('Saved agent run storage exceeds its record limit.');
    const rows = [];
    for (const name of names) {
      const id = name.slice(0, -5);
      try { const value = await get(id); rows.push({ id, createdAt: value.createdAt, task: value.task, mode: value.mode, status: value.status, partial: value.partial,
        verified: false, agents: value.agents.map(item => ({ name: item.name, role: item.role, status: item.status, model: item.model, changes: item.changes?.files.length ?? 0 })),
        results: value.agents.map(item => ({ name: item.name, role: item.role, status: item.status, model: item.model, changes: item.changes?.files.length ?? 0 })) }); }
      catch { rows.push({ id, createdAt: '', task: 'Unreadable saved agent run', status: 'invalid', partial: true, agents: [] }); }
    }
    return rows.sort((a, b) => b.createdAt.localeCompare(a.createdAt) || b.id.localeCompare(a.id));
  }
  async function remove(id) { return withLock(async () => (await record(id)).remove()); }
  async function save(value) { return withLock(async () => {
    await assertStorage();
    const id = randomUUID(), createdAt = new Date().toISOString(), saved = normalize(value, { id, createdAt });
    // Keep one canonical copy of file bytes in JSON; agents is a compatibility alias in memory.
    const { agents, ...persisted } = saved;
    await (await record(id)).write(persisted);
    const entries = await list();
    for (const item of entries.filter(item => item.id !== id).slice(maxRuns - 1)) await (await record(item.id)).remove();
    return saved;
  }); }
  return { save, list, get, remove, cwd: root };
}
