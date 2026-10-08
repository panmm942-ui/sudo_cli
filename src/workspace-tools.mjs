import { constants } from 'node:fs';
import { lstat, stat, realpath, open, opendir, readFile, writeFile, mkdir, mkdtemp, rename, unlink, rm, readdir } from 'node:fs/promises';
import { resolve, relative, join, dirname, basename, isAbsolute, sep } from 'node:path';
import { tmpdir } from 'node:os';
import { createHash, randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { performance } from 'node:perf_hooks';
import { defaultWorkStateDir } from './work-meter.mjs';
import { createRedactor } from './redactor.mjs';

const excludedDirectories = new Set(['.git', '.sudocli', '.codex', '.ssh', '.aws', '.azure', '.config', '.gnupg', '.docker', '.kube', '.cache', 'node_modules', 'runtime', 'upstream', 'secrets', 'credentials']);
const sensitiveFile = /^(?:\.env(?:\..*)?|\.npmrc|\.netrc|\.pypirc|\.pgpass|\.my\.cnf|kubeconfig|credentials(?:\..*)?|id_(?:rsa|ed25519|ecdsa)|.*\.(?:pem|key|pfx|p12|kdbx))$/i;
const recordName = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\.json$/;
const hash = value => createHash('sha256').update(value).digest('hex');
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const abortError = () => new DOMException('Workspace operation was cancelled.', 'AbortError');
const checkAbort = signal => { if (signal?.aborted) throw abortError(); };
const cleanRelative = value => typeof value === 'string' && value.length > 0 && value.length <= 4096 && !isAbsolute(value)
  && !/[\u0000-\u001f\u007f:]/.test(value) && value.split(/[\\/]/).every(part => part && part !== '.' && part !== '..'
    && !/[. ]$/.test(part) && !/^(?:CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])(?:\.|$)/i.test(part));
const within = (root, path) => { const rel = relative(root, path); return !rel || !isAbsolute(rel) && rel !== '..' && !rel.startsWith(`..${sep}`); };
const slash = value => value.split(sep).join('/');
const boundedUtf8 = (value, bytes) => new TextDecoder().decode(Buffer.from(value).subarray(0, bytes), { stream: true });
const limit = (value, fallback, maximum, name) => {
  const result = value ?? fallback;
  if (!Number.isSafeInteger(result) || result < 1 || result > maximum) throw new Error(`${name} must be a positive bounded integer.`);
  return result;
};
function limits(options) {
  return { maxFiles: limit(options.maxFiles, 2000, 5000, 'Workspace file count'), maxFileBytes: limit(options.maxFileBytes, 1024 * 1024, 4 * 1024 * 1024, 'Workspace file size'),
    maxTotalBytes: limit(options.maxTotalBytes, 16 * 1024 * 1024, 64 * 1024 * 1024, 'Workspace total size'), maxEntries: limit(options.maxEntries, 20000, 50000, 'Workspace entry count') };
}
async function projectRoot(cwd) {
  if (typeof cwd !== 'string' || !cwd || /[\u0000-\u001f\u007f]/.test(cwd)) throw new Error('Workspace directory is invalid.');
  const root = await realpath(resolve(cwd));
  if (!(await stat(root)).isDirectory()) throw new Error('Workspace must be a directory.');
  return root;
}
export function isExcludedWorkspacePath(path) {
  const parts = String(path).split(/[\\/]/);
  return parts.some(part => excludedDirectories.has(part.toLowerCase())) || sensitiveFile.test(parts.at(-1));
}
/** Model-bound source/diff text removes known keys and obvious credential assignments. */
export function redactWorkspaceText(text, secrets = () => []) {
  const redactor = createRedactor({ secrets });
  return (redactor.write(String(text)) + redactor.flush())
    .replace(/\b(?:sk-[A-Za-z0-9_-]{20,}|gh[pousr]_[A-Za-z0-9]{20,}|AKIA[A-Z0-9]{16})\b/g, '[redacted]')
    .replace(/((?:api[_-]?key|access[_-]?token|secret|password|authorization)\s*[:=]\s*["'])([^"'\r\n]{8,})(["'])/gi, '$1[redacted]$3')
    .replace(/-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----[\s\S]*?-----END (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/g, '[redacted private key]');
}

async function safePath(root, path, { createParents = false } = {}) {
  if (!cleanRelative(path) || isExcludedWorkspacePath(path)) throw new Error('Workspace path is excluded or outside the project.');
  const parts = path.split(/[\\/]/); let current = root;
  if (await realpath(root) !== root || !(await lstat(root)).isDirectory()) throw new Error('Workspace root changed.');
  for (let index = 0; index < parts.length; index++) {
    current = join(current, parts[index]); let info = await lstat(current).catch(error => { if (error.code === 'ENOENT') return null; throw error; });
    if (info?.isSymbolicLink()) throw new Error('Symbolic workspace paths are refused.');
    if (index < parts.length - 1) {
      if (!info && createParents) { await mkdir(current, { mode: 0o700 }).catch(error => { if (error.code !== 'EEXIST') throw error; }); info = await lstat(current); }
      if (info && !info.isDirectory() || !info && createParents) throw new Error('Workspace parent is not a directory.');
    } else if (info && !info.isFile()) throw new Error('Workspace target is not a regular file.');
  }
  if (!within(root, current)) throw new Error('Workspace path escapes the project.');
  return current;
}
async function boundedFile(path, maxBytes) {
  let handle;
  try {
    const info = await lstat(path);
    if (!info.isFile() || info.isSymbolicLink()) throw new Error('not-regular-file');
    if (info.size > maxBytes) throw new Error('file-size-limit');
    handle = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
    const actual = await handle.stat();
    if (!actual.isFile() || actual.size > maxBytes) throw new Error('file-size-limit');
    const data = Buffer.alloc(Math.min(actual.size + 1, maxBytes + 1));
    let length = 0;
    while (length < data.length) { const { bytesRead } = await handle.read(data, length, data.length - length, null); if (!bytesRead) break; length += bytesRead; }
    const after = await handle.stat();
    if (length > maxBytes || after.size > maxBytes) throw new Error('file-size-limit');
    if (after.size !== actual.size || after.mtimeMs !== actual.mtimeMs) throw new Error('file-changed-during-read');
    const content = data.subarray(0, length);
    return { data: content, bytes: length, hash: hash(content), mode: actual.mode & 0o777 };
  } finally { await handle?.close(); }
}

/** Bounded defensive source walk. Raw bytes stay local; model copies use redactWorkspaceText. */
export async function collectWorkspaceFiles({ cwd = process.cwd(), path = '.', excludePaths = [], signal, ...options } = {}) {
  checkAbort(signal); const root = await projectRoot(cwd), bounds = limits(options);
  if (path !== '.' && (!cleanRelative(path) || isExcludedWorkspacePath(path))) throw new Error('Workspace target is excluded or outside the project.');
  const excluded = excludePaths.map(value => resolve(value));
  const files = [], skipped = []; let entries = 0, totalBytes = 0, stopped = false;
  const skip = (path, reason) => { if (skipped.length < 1000) skipped.push({ path, reason }); };
  async function visit(current, display, depth = 0) {
    checkAbort(signal);
    if (stopped) return;
    if (++entries > bounds.maxEntries) { skip(display || '.', 'entry-count-limit'); stopped = true; return; }
    if (depth > 32) { skip(display, 'directory-depth-limit'); return; }
    if (display && (isExcludedWorkspacePath(display) || excluded.some(item => within(item, current)))) return;
    const info = await lstat(current).catch(error => { if (error.code === 'ENOENT') return null; throw error; });
    if (!info) { skip(display, 'missing'); return; }
    if (info.isSymbolicLink()) { skip(display, 'symbolic-link'); return; }
    if (info.isDirectory()) {
      const directory = await opendir(current);
      for await (const entry of directory) { await visit(join(current, entry.name), display ? `${display}/${entry.name}` : entry.name, depth + 1); if (stopped) break; }
      return;
    }
    if (!info.isFile()) { skip(display, 'not-regular-file'); return; }
    if (!cleanRelative(display)) { skip('(invalid filename)', 'invalid-path'); return; }
    if (files.length >= bounds.maxFiles) { skip(display, 'file-count-limit'); stopped = true; return; }
    try {
      await safePath(root, slash(relative(root, current)));
      const file = await boundedFile(current, bounds.maxFileBytes);
      if (totalBytes + file.bytes > bounds.maxTotalBytes) { skip(display, 'total-size-limit'); return; }
      totalBytes += file.bytes; files.push({ path: display, ...file });
    } catch (error) { skip(display, ['file-size-limit', 'file-changed-during-read'].includes(error.message) ? error.message : 'unreadable-or-unsafe'); }
  }
  const target = path === '.' ? root : resolve(root, path);
  if (!within(root, target)) throw new Error('Workspace target escapes the project.');
  // Inspect every target parent before traversing, including directory targets.
  if (path !== '.') {
    let current = root;
    for (const part of path.split(/[\\/]/)) { current = join(current, part); if ((await lstat(current)).isSymbolicLink()) throw new Error('Symbolic workspace targets are refused.'); }
  }
  await visit(target, path === '.' ? '' : slash(relative(root, target)));
  files.sort((left, right) => left.path.localeCompare(right.path)); skipped.sort((left, right) => left.path.localeCompare(right.path));
  return { cwd: root, files, skipped, totalBytes, partial: skipped.length > 0, limits: bounds };
}

/** An owned, credential-filtered copy, never an enforcement claim about the OS sandbox. */
export async function createWorkspaceSnapshot({ cwd = process.cwd(), path = '.', baseDir = tmpdir(), secrets = () => [], signal, excludePaths = [], ...options } = {}) {
  const root = await projectRoot(cwd), copyBase = resolve(baseDir);
  if (within(root, copyBase)) throw new Error('Source snapshots must be stored outside the original project.');
  const source = await collectWorkspaceFiles({ cwd: root, path, signal, excludePaths: [...excludePaths, ...(within(root, copyBase) && copyBase !== root ? [copyBase] : [])], ...options });
  await mkdir(baseDir, { recursive: true, mode: 0o700 });
  if ((await lstat(baseDir)).isSymbolicLink()) throw new Error('Snapshot storage cannot be symbolic.');
  const base = await realpath(baseDir), directory = await mkdtemp(join(base, 'codexcli-review-'));
  const marker = randomUUID(); await writeFile(join(directory, '.snapshot-owner'), marker, { flag: 'wx', mode: 0o600 });
  let cleaned = false;
  async function cleanup() {
    if (cleaned) return;
    if (!within(base, directory) || directory === base || (await lstat(directory)).isSymbolicLink() || await realpath(directory) !== directory
      || await readFile(join(directory, '.snapshot-owner'), 'utf8') !== marker) throw new Error('Snapshot ownership changed; cleanup was refused.');
    await rm(directory, { recursive: true, force: true }); cleaned = true;
  }
  try {
    const relativeTarget = path === '.' ? '' : slash(relative(source.cwd, resolve(source.cwd, path)));
    const targetIsFile = path !== '.' && (await lstat(resolve(source.cwd, path))).isFile();
    const files = [], omitted = [];
    for (const file of source.files) {
      checkAbort(signal);
      if (redactWorkspaceText(file.path, secrets) !== file.path) { omitted.push({ path: redactWorkspaceText(file.path, secrets), reason: 'sensitive-path' }); continue; }
      if (file.data.includes(0)) { omitted.push({ path: file.path, reason: 'binary-file' }); continue; }
      let destination = targetIsFile ? basename(file.path) : relativeTarget ? file.path.slice(relativeTarget.length + 1) : file.path;
      // The native engine discovers AGENTS.md automatically. Preserve it as evidence,
      // without installing its contents as instructions in an independent session.
      if (basename(destination).toLowerCase() === 'agents.md') destination = join(dirname(destination), '.source-AGENTS.md');
      if (!cleanRelative(destination)) continue;
      const filename = join(directory, destination); await mkdir(dirname(filename), { recursive: true, mode: 0o700 });
      await writeFile(filename, redactWorkspaceText(file.data.toString('utf8'), secrets), { flag: 'wx', mode: 0o600 }); files.push(destination);
    }
    return { cwd: directory, sourceCwd: source.cwd, files, skipped: [...source.skipped, ...omitted].map(item => ({ ...item, path: redactWorkspaceText(item.path, secrets) })), partial: source.partial || omitted.length > 0, totalBytes: source.totalBytes, cleanup };
  } catch (error) { await cleanup().catch(() => {}); throw error; }
}

function encodeSnapshot(snapshot) { return { files: snapshot.files.map(file => ({ path: file.path, hash: file.hash, bytes: file.bytes, mode: file.mode, content: file.data.toString('base64') })), skipped: snapshot.skipped, partial: snapshot.partial }; }
const snapshotSignature = snapshot => hash(JSON.stringify(snapshot.files.map(file => [file.path, file.hash, file.mode])));
function validateSnapshot(snapshot, bounds) {
  if (!object(snapshot) || !Array.isArray(snapshot.files) || snapshot.files.length > bounds.maxFiles || !Array.isArray(snapshot.skipped) || snapshot.skipped.length > 1000 || typeof snapshot.partial !== 'boolean') throw new Error('Workspace checkpoint is invalid.');
  let total = 0; const paths = new Set();
  for (const file of snapshot.files) {
    if (!object(file) || !cleanRelative(file.path) || file.path.includes('\\') || isExcludedWorkspacePath(file.path) || paths.has(file.path) || !Number.isSafeInteger(file.bytes) || file.bytes < 0 || file.bytes > bounds.maxFileBytes
      || !Number.isSafeInteger(file.mode) || file.mode < 0 || file.mode > 0o777 || typeof file.content !== 'string' || file.content.length > Math.ceil(bounds.maxFileBytes / 3) * 4 || !/^[A-Za-z0-9+/]*={0,2}$/.test(file.content)) throw new Error('Workspace checkpoint contains invalid file data.');
    const data = Buffer.from(file.content, 'base64'); total += data.length;
    if (data.length !== file.bytes || hash(data) !== file.hash || total > bounds.maxTotalBytes) throw new Error('Workspace checkpoint integrity failed.'); paths.add(file.path);
  }
  if (snapshot.skipped.some(item => !object(item) || typeof item.path !== 'string' || item.path.length > 4096 || typeof item.reason !== 'string' || item.reason.length > 100)) throw new Error('Workspace checkpoint skipped paths are invalid.');
}
function changedFiles(record) {
  const before = new Map(record.before.files.map(file => [file.path, file])), after = new Map(record.after.files.map(file => [file.path, file]));
  // Files omitted by either bounded scan are unknown, never recorded deletions/additions.
  const unknown = new Set([...record.before.skipped, ...record.after.skipped].map(item => item.path));
  return [...new Set([...before.keys(), ...after.keys()])].sort().flatMap(path => {
    if ([...unknown].some(item => path === item || path.startsWith(`${item}/`)) || before.get(path)?.hash === after.get(path)?.hash
      || (record.before.partial || record.after.partial) && (!before.has(path) || !after.has(path))) return [];
    return [{ path, kind: !before.has(path) ? 'added' : !after.has(path) ? 'deleted' : 'modified', before: before.get(path), after: after.get(path) }];
  });
}

export async function createWorkspaceTools({ cwd = process.cwd(), stateDir = defaultWorkStateDir(), secrets = () => [], maxCheckpoints = 20, ...options } = {}) {
  const root = await projectRoot(cwd), bounds = limits(options);
  if (typeof secrets !== 'function') throw new Error('Workspace secret provider must be a function.');
  maxCheckpoints = limit(maxCheckpoints, 20, 100, 'Workspace checkpoint count');
  stateDir = resolve(stateDir); await mkdir(stateDir, { recursive: true, mode: 0o700 });
  if ((await lstat(stateDir)).isSymbolicLink()) throw new Error('Workspace state storage cannot be symbolic.');
  const canonicalState = await realpath(stateDir), storage = join(canonicalState, 'workspace-checkpoints', hash(root).slice(0, 32));
  await mkdir(join(canonicalState, 'workspace-checkpoints'), { mode: 0o700 }).catch(error => { if (error.code !== 'EEXIST') throw error; });
  if ((await lstat(join(canonicalState, 'workspace-checkpoints'))).isSymbolicLink()) throw new Error('Workspace checkpoint storage cannot be symbolic.');
  await mkdir(storage, { mode: 0o700 }).catch(error => { if (error.code !== 'EEXIST') throw error; });
  if ((await lstat(storage)).isSymbolicLink()) throw new Error('Workspace checkpoint storage cannot be symbolic.');
  const maximumRecordBytes = Math.ceil(bounds.maxTotalBytes * 8 / 3) + 2 * 1024 * 1024;
  const capture = () => collectWorkspaceFiles({ cwd: root, excludePaths: [canonicalState], ...bounds });
  const filename = id => { if (typeof id !== 'string' || !recordName.test(`${id}.json`)) throw new Error('Workspace checkpoint identifier is invalid.'); return join(storage, `${id}.json`); };
  async function assertStorage() {
    if ((await lstat(storage)).isSymbolicLink() || await realpath(storage) !== storage) throw new Error('Workspace checkpoint storage changed.');
  }
  async function readRecord(id) {
    await assertStorage(); const file = await boundedFile(filename(id), maximumRecordBytes); let record;
    try { record = JSON.parse(file.data.toString('utf8')); } catch { throw new Error('Workspace checkpoint is unreadable.'); }
    if (!object(record) || record.version !== 1 || record.id !== id || record.cwd !== root || typeof record.label !== 'string' || record.label.length > 200 || typeof record.createdAt !== 'string'
      || !['started', 'completed', 'undone', 'partially-undone'].includes(record.status)) throw new Error('Workspace checkpoint is invalid.');
    validateSnapshot(record.before, bounds); if (record.after) validateSnapshot(record.after, bounds);
    return record;
  }
  async function save(record, initial = false) {
    await assertStorage(); const data = JSON.stringify(record); if (Buffer.byteLength(data) > maximumRecordBytes) throw new Error('Workspace checkpoint storage size limit exceeded.');
    const path = filename(record.id);
    if (initial) { await writeFile(path, data, { flag: 'wx', mode: 0o600 }); return; }
    const temporary = join(storage, `${record.id}.${randomUUID()}.tmp`);
    try { await writeFile(temporary, data, { flag: 'wx', mode: 0o600 }); await assertStorage(); await rename(temporary, path); }
    finally { await unlink(temporary).catch(error => { if (error.code !== 'ENOENT') throw error; }); }
  }
  async function listCheckpoints() {
    await assertStorage(); const names = (await readdir(storage)).filter(name => recordName.test(name));
    if (names.length > 100) throw new Error('Workspace checkpoint storage exceeds its record limit.');
    const records = [];
    for (const name of names) { try { const record = await readRecord(name.slice(0, -5)); records.push({ id: record.id, label: redactWorkspaceText(record.label, secrets), status: record.status, createdAt: record.createdAt, completedAt: record.completedAt ?? null, partial: record.before.partial || record.after?.partial || false, changes: record.after ? changedFiles(record).length : null }); }
      catch { records.push({ id: name.slice(0, -5), status: 'invalid', label: 'Unreadable checkpoint', createdAt: '', partial: true, changes: null }); } }
    return records.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }
  async function beginCheckpoint(label = 'AI task') {
    if (typeof label !== 'string' || label.length > 200 || /[\u0000-\u001f\u007f]/.test(label)) throw new Error('Workspace checkpoint label is invalid.');
    const records = await listCheckpoints();
    if (records.length >= maxCheckpoints) {
      const obsolete = [...records].reverse().find(record => ['completed', 'undone', 'partially-undone'].includes(record.status));
      if (!obsolete) throw new Error('Workspace checkpoint limit reached; finish an active checkpoint first.');
      await readRecord(obsolete.id); await unlink(filename(obsolete.id));
    }
    const record = { version: 1, id: randomUUID(), cwd: root, label, status: 'started', createdAt: new Date().toISOString(), before: encodeSnapshot(await capture()) };
    await save(record, true); return { id: record.id, status: record.status, partial: record.before.partial };
  }
  async function completeCheckpoint(id) {
    const record = await readRecord(id); if (record.status !== 'started') throw new Error('Workspace checkpoint is already completed.');
    record.after = encodeSnapshot(await capture()); record.status = 'completed'; record.completedAt = new Date().toISOString(); await save(record);
    return { id, status: record.status, changes: changedFiles(record).length, partial: record.before.partial || record.after.partial };
  }
  async function reviewCheckpoint(id, { maxDiffBytes = 64 * 1024 } = {}) {
    maxDiffBytes = limit(maxDiffBytes, 64 * 1024, 1024 * 1024, 'Workspace diff size');
    const record = await readRecord(id); if (!record.after) throw new Error('Complete the workspace checkpoint before reviewing it.');
    const actual = changedFiles(record); let diff = '', truncated = false;
    const changes = actual.map(({ path, kind, before, after }) => ({ path, kind, beforeBytes: before?.bytes ?? 0, afterBytes: after?.bytes ?? 0 }));
    for (const change of actual) {
      const before = change.before ? Buffer.from(change.before.content, 'base64') : Buffer.alloc(0), after = change.after ? Buffer.from(change.after.content, 'base64') : Buffer.alloc(0);
      let part = `--- ${change.before ? 'a/' + change.path : '/dev/null'}\n+++ ${change.after ? 'b/' + change.path : '/dev/null'}\n`;
      if (before.includes(0) || after.includes(0)) part += '(binary file changed)\n';
      else {
        const a = before.toString('utf8').split('\n'), b = after.toString('utf8').split('\n'); let prefix = 0, suffix = 0;
        while (prefix < a.length && prefix < b.length && a[prefix] === b[prefix]) prefix++;
        while (suffix < a.length - prefix && suffix < b.length - prefix && a[a.length - 1 - suffix] === b[b.length - 1 - suffix]) suffix++;
        const start = Math.max(0, prefix - 3), aEnd = Math.min(a.length, a.length - suffix + 3), bEnd = Math.min(b.length, b.length - suffix + 3);
        part += `@@ -${start + 1},${aEnd - start} +${start + 1},${bEnd - start} @@\n`;
        part += a.slice(start, prefix).map(line => ` ${line}\n`).join('') + a.slice(prefix, a.length - suffix).map(line => `-${line}\n`).join('')
          + b.slice(prefix, b.length - suffix).map(line => `+${line}\n`).join('') + b.slice(b.length - suffix, bEnd).map(line => ` ${line}\n`).join('');
      }
      part = redactWorkspaceText(part, secrets);
      if (Buffer.byteLength(diff + part) > maxDiffBytes) { truncated = true; break; } diff += part;
    }
    return { id, status: record.status, changes, diff, truncated, partial: record.before.partial || record.after.partial, skipped: [...record.before.skipped, ...record.after.skipped] };
  }
  async function undoCheckpoint(id) {
    const record = await readRecord(id); if (!record.after) throw new Error('An unfinished checkpoint cannot be undone.');
    const restored = [], conflicts = [];
    for (const change of changedFiles(record)) {
      try {
        let path = await safePath(root, change.path); const info = await lstat(path).catch(error => { if (error.code === 'ENOENT') return null; throw error; });
        if (change.after ? !info || (await boundedFile(path, bounds.maxFileBytes)).hash !== change.after.hash : info !== null) throw new Error('File changed after the AI checkpoint.');
        if (!change.before) { await unlink(path); restored.push({ path: change.path, action: 'removed' }); continue; }
        path = await safePath(root, change.path, { createParents: true }); const data = Buffer.from(change.before.content, 'base64');
        if (!change.after) await writeFile(path, data, { flag: 'wx', mode: change.before.mode & 0o700 | 0o600 });
        else {
          const temporary = join(dirname(path), `.sudocli-restore-${randomUUID()}.tmp`);
          try { await writeFile(temporary, data, { flag: 'wx', mode: change.before.mode & 0o700 | 0o600 });
            await safePath(root, change.path); if ((await boundedFile(path, bounds.maxFileBytes)).hash !== change.after.hash) throw new Error('File changed while preparing undo.');
            await rename(temporary, path);
          } finally { await unlink(temporary).catch(error => { if (error.code !== 'ENOENT') throw error; }); }
        }
        restored.push({ path: change.path, action: 'restored' });
      } catch { conflicts.push({ path: change.path, reason: 'Current file or parent differs from the recorded AI checkpoint, is unsafe, or cannot be restored.' }); }
    }
    record.status = conflicts.length ? 'partially-undone' : 'undone'; record.verification = null; await save(record); return { id, status: record.status, restored, conflicts, partial: record.before.partial || record.after.partial };
  }
  async function runChecks(checks, { signal, timeoutMs = 120000, maxOutputBytes = 256 * 1024, env, commandWrapper } = {}) {
    if (!Array.isArray(checks) || checks.length > 16) throw new Error('Select at most 16 explicit checks.');
    if (signal !== undefined && !(signal instanceof AbortSignal) || env !== undefined && (!object(env) || Object.entries(env).some(([key, value]) => /[\u0000=]/.test(key) || typeof value !== 'string' || value.includes('\0'))) || commandWrapper !== undefined && typeof commandWrapper !== 'function') throw new Error('Check signal, environment or command wrapper is invalid.');
    timeoutMs = limit(timeoutMs, 120000, 600000, 'Check timeout'); maxOutputBytes = limit(maxOutputBytes, 256 * 1024, 4 * 1024 * 1024, 'Check output size');
    const normalized = checks.map(check => {
      if (!object(check) || (check.command === undefined) === (check.shellCommand === undefined) || check.label !== undefined && (typeof check.label !== 'string' || check.label.length > 200)) throw new Error('Check requires command/args or an explicit shellCommand.');
      if (check.shellCommand !== undefined) {
        if (typeof check.shellCommand !== 'string' || !check.shellCommand.trim() || check.shellCommand.length > 32768 || check.shellCommand.includes('\0') || check.args !== undefined) throw new Error('Explicit shell check is invalid.');
        return { label: check.label ?? check.shellCommand.slice(0, 200), command: process.platform === 'win32' ? 'powershell.exe' : '/bin/sh', args: process.platform === 'win32' ? ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', check.shellCommand] : ['-c', check.shellCommand] };
      }
      if (typeof check.command !== 'string' || !check.command.trim() || check.command.length > 4096 || /[\u0000-\u001f\u007f]/.test(check.command) || !Array.isArray(check.args ?? []) || (check.args ?? []).length > 256
        || (check.args ?? []).some(arg => typeof arg !== 'string' || arg.length > 32768 || arg.includes('\0')) || Buffer.byteLength(JSON.stringify(check)) > 128 * 1024) throw new Error('Explicit argv check is invalid.');
      return { label: check.label ?? check.command, command: check.command, args: check.args ?? [] };
    });
    const results = [];
    for (const check of normalized) {
      const started = performance.now(); let stopReason = null, child, timer, killer, bytes = 0; const output = { stdout: [], stderr: [] };
      if (signal?.aborted) { results.push({ label: redactWorkspaceText(check.label, secrets), status: 'cancelled', exitCode: null, signal: null, elapsedMs: 0, stdout: '', stderr: '' }); break; }
      const execution = commandWrapper ? await commandWrapper({ ...check, cwd: root, env, signal }) : { ...check, env };
      if (!object(execution) || typeof execution.command !== 'string' || !execution.command || execution.command.length > 4096 || /[\u0000-\u001f\u007f]/.test(execution.command) || !Array.isArray(execution.args) || execution.args.length > 1024 || execution.args.some(arg => typeof arg !== 'string' || arg.length > 65536 || arg.includes('\0')) || execution.env !== undefined && (!object(execution.env) || Object.entries(execution.env).some(([key, value]) => /[\u0000=]/.test(key) || typeof value !== 'string' || value.includes('\0')))) throw new Error('Wrapped check execution is invalid.');
      const result = await new Promise(resolveResult => {
        let settled = false;
        const finish = (code, processSignal, error = false) => {
          if (settled) return; settled = true; clearTimeout(timer); clearTimeout(killer); signal?.removeEventListener('abort', aborted);
          const safeStdout = redactWorkspaceText(Buffer.concat(output.stdout).toString('utf8'), secrets), safeStderr = redactWorkspaceText(Buffer.concat(output.stderr).toString('utf8'), secrets);
          const stdout = boundedUtf8(safeStdout, maxOutputBytes), stderr = boundedUtf8(safeStderr, Math.max(0, maxOutputBytes - Buffer.byteLength(stdout)));
          if (!stopReason && Buffer.byteLength(safeStdout) + Buffer.byteLength(safeStderr) > maxOutputBytes) stopReason = 'output-limit';
          resolveResult({ label: redactWorkspaceText(check.label, secrets), status: stopReason ?? (error ? 'error' : code === 0 ? 'passed' : 'failed'), exitCode: code ?? null, signal: processSignal ?? null,
            elapsedMs: Math.round(performance.now() - started), stdout, stderr });
        };
        const terminate = force => {
          if (!child?.pid) return;
          if (process.platform === 'win32') {
            // Fixed OS utility and the PID of this owned child only. Kill the tree
            // before the parent so descendants cannot orphan their output pipes.
            const terminator = spawn('taskkill.exe', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true, shell: false, stdio: 'ignore' });
            terminator.on('error', () => { child.kill(force ? 'SIGKILL' : 'SIGTERM'); }); terminator.unref();
          } else { try { process.kill(-child.pid, force ? 'SIGKILL' : 'SIGTERM'); } catch { child.kill(force ? 'SIGKILL' : 'SIGTERM'); } }
        };
        const stop = reason => { if (stopReason) return; stopReason = reason; terminate(false); killer = setTimeout(() => terminate(true), 500); killer.unref(); };
        const aborted = () => stop('cancelled');
        try {
          child = spawn(execution.command, execution.args, { cwd: root, windowsHide: true, shell: false, detached: process.platform !== 'win32', stdio: ['ignore', 'pipe', 'pipe'], ...(execution.env ? { env: execution.env } : {}) });
          for (const stream of ['stdout', 'stderr']) child[stream].on('data', chunk => { const remaining = maxOutputBytes - bytes; bytes += chunk.length; if (remaining > 0) output[stream].push(chunk.subarray(0, remaining)); if (bytes > maxOutputBytes) stop('output-limit'); });
          child.once('error', () => finish(null, null, true)); child.once('close', (code, processSignal) => finish(code, processSignal));
          signal?.addEventListener('abort', aborted, { once: true }); timer = setTimeout(() => stop('timed-out'), timeoutMs); timer.unref(); if (signal?.aborted) aborted();
        } catch { finish(null, null, true); }
      });
      results.push(result); if (result.status === 'cancelled') break;
    }
    return results;
  }
  async function acceptWork({ checks = [], checkpointId, ...checkOptions } = {}) {
    if (checkpointId) await readRecord(checkpointId);
    const before = await capture(), results = await runChecks(checks, checkOptions), after = await capture();
    const workspaceSignature = snapshotSignature(after), workspaceChanged = snapshotSignature(before) !== workspaceSignature, partial = before.partial || after.partial;
    const verified = results.length > 0 && results.length === checks.length && results.every(check => check.status === 'passed') && !workspaceChanged && !partial;
    const result = { verified, status: verified ? 'Verified' : results.some(check => ['failed', 'error'].includes(check.status)) ? 'Failed' : 'Needs review', checks: results, checkedAt: new Date().toISOString(), checkpointId: checkpointId ?? null, workspaceChanged, workspaceSignature, partial };
    if (checkpointId) {
      const record = await readRecord(checkpointId);
      // Persistent previews are bounded separately from the live process result.
      record.verification = { ...result, checks: results.map(check => ({ ...check, stdout: check.stdout.slice(0, 1024), stderr: check.stderr.slice(0, 1024), outputPreviewTruncated: check.stdout.length > 1024 || check.stderr.length > 1024 })) };
      await save(record);
    }
    return result;
  }
  async function getVerification(checkpointId) {
    const record = await readRecord(checkpointId), result = record.verification;
    if (!object(result) || !['Verified', 'Failed', 'Needs review'].includes(result.status) || !Array.isArray(result.checks) || result.checks.length > 16) return { status: 'Needs review', verified: false, checks: [], checkpointId };
    const current = await capture(), workspaceChanged = result.workspaceSignature !== snapshotSignature(current);
    const verified = result.verified === true && result.status === 'Verified' && result.checks.length > 0 && result.checks.every(check => check.status === 'passed' && check.exitCode === 0) && !workspaceChanged && !current.partial;
    return { ...result, verified, status: workspaceChanged || current.partial ? 'Needs review' : verified ? 'Verified' : result.status === 'Verified' ? 'Needs review' : result.status, workspaceChanged, partial: current.partial || result.partial };
  }
  return { cwd: root, stateDir: canonicalState, beginCheckpoint, completeCheckpoint, listCheckpoints, reviewCheckpoint, undoCheckpoint, runChecks, acceptWork, getVerification };
}
