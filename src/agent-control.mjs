import { spawn } from 'node:child_process';
import { mkdir, lstat, realpath, open, rename, rm, chmod } from 'node:fs/promises';
import { constants } from 'node:fs';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { requireElevated } from './privileges.mjs';
import { validateConnection, validateCapabilities, validateRuntimeOptions, validateReasoningEffort } from './runtime.mjs';
import { createToolPolicy } from './provider-capabilities.mjs';
import { defaultWorkStateDir } from './work-meter.mjs';
import { normalizeBudgetPolicy, normalizePricing } from './budget.mjs';
import { validateGpuHook } from './gpu-control.mjs';
import { permissionPolicy } from './permission-scope.mjs';

const recordLimit = 16384;
const controls = /[\u0000-\u001f\u007f]/;
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const same = (a, b) => process.platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b;
const storageError = () => new Error('Detached worker control storage or record is invalid; existing data was left untouched.');

async function realDirectory(path, create = false) {
  const parent = dirname(path);
  if (parent !== path) await realDirectory(parent, create);
  let info;
  try { info = await lstat(path); }
  catch (error) {
    if (error.code === 'ENOENT' && !create) return false;
    if (error.code !== 'ENOENT' || !create) throw storageError();
    try { await mkdir(path, { mode: 0o700 }); } catch (error) { if (error.code !== 'EEXIST') throw storageError(); }
    info = await lstat(path);
  }
  if (!info.isDirectory() || info.isSymbolicLink()) throw storageError();
  return true;
}

export async function workerLocation({ stateDir = defaultWorkStateDir(), cwd = process.cwd(), create = false } = {}) {
  if (typeof stateDir !== 'string' || !stateDir || controls.test(stateDir) || typeof cwd !== 'string' || !cwd || controls.test(cwd)) throw new Error('Detached worker requires valid state and project directories.');
  let project;
  try { project = await realpath(resolve(cwd)); if (!(await lstat(project)).isDirectory()) throw storageError(); }
  catch { throw new Error('Detached worker project must be an existing directory.'); }
  const directory = join(resolve(stateDir), 'agents');
  const exists = await realDirectory(directory, create);
  if (create && process.platform !== 'win32') await chmod(directory, 0o700);
  const projectKey = createHash('sha256').update(process.platform === 'win32' ? project.toLowerCase() : project).digest('hex');
  return { cwd: project, stateDir: resolve(stateDir), directory, projectKey, path: join(directory, `worker-${projectKey}.json`), lockPath: join(directory, `worker-${projectKey}.lock`), exists };
}

function validateRecord(record, location) {
  if (!record || record.version !== 1 || !uuid.test(record.id ?? '') || !same(record.cwd ?? '', location.cwd)
    || !Number.isSafeInteger(record.pid) || record.pid < 1 || !Number.isSafeInteger(record.port) || record.port < 1 || record.port > 65535
    || typeof record.token !== 'string' || !/^[0-9a-f]{64}$/.test(record.token) || typeof record.startedAt !== 'string' || !Number.isFinite(Date.parse(record.startedAt))) throw storageError();
  return { version: 1, id: record.id, cwd: record.cwd, pid: record.pid, port: record.port, token: record.token, startedAt: record.startedAt };
}
export async function readWorkerRecord(location) {
  if (!(await realDirectory(location.directory))) return undefined;
  let file;
  try {
    const before = await lstat(location.path);
    if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1 || before.size > recordLimit) throw storageError();
    file = await open(location.path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
    const info = await file.stat();
    if (info.ino !== before.ino || info.dev !== before.dev || info.size !== before.size || !info.isFile()) throw storageError();
    const bytes = Buffer.alloc(info.size + 1), result = await file.read(bytes, 0, bytes.length, 0), after = await file.stat();
    if (result.bytesRead !== info.size || after.mtimeMs !== info.mtimeMs || after.size !== info.size) throw storageError();
    await realDirectory(location.directory);
    return validateRecord(JSON.parse(bytes.subarray(0, result.bytesRead).toString('utf8')), location);
  } catch (error) { if (error.code === 'ENOENT') return undefined; throw storageError(); }
  finally { await file?.close().catch(() => {}); }
}
export async function removeWorkerRecord(location, expectedId) {
  const record = await readWorkerRecord(location);
  if (record?.id === expectedId) await rm(location.path, { force: true });
}
async function writeWorkerRecord(location, record) {
  await realDirectory(location.directory);
  const temporary = `${location.path}.${randomUUID()}.tmp`;
  let file;
  try {
    file = await open(temporary, 'wx', 0o600);
    await file.writeFile(JSON.stringify(validateRecord(record, location)) + '\n'); await file.sync(); await file.close(); file = undefined;
    if (await readWorkerRecord(location)) throw new Error('A detached worker control record appeared during startup.');
    await rename(temporary, location.path);
  } finally { await file?.close().catch(() => {}); await rm(temporary, { force: true }).catch(() => {}); }
}

function hook(value) {
  return validateGpuHook(value);
}
/** Allowlisted startup data travels over IPC and is never written to the control record. */
export function validateAgentConfig(config) {
  if (!config || typeof config !== 'object') throw new Error('Configure a local guardian and working AI before starting 24/7 mode.');
  const localConnection = validateConnection(config.localConnection), cloudConnection = validateConnection(config.cloudConnection);
  if (!['localhost', '127.0.0.1', '[::1]'].includes(new URL(localConnection.baseUrl).hostname)) throw new Error('The 24/7 guardian must use a local loopback AI endpoint.');
  const settings = validateRuntimeOptions(config.settings);
  const selected = config.settings ?? {};
  // A local guardian must never inherit another model's capability declarations.
  localConnection.capabilities = localConnection.capabilities ?? {};
  cloudConnection.capabilities = validateCapabilities(cloudConnection.capabilities ?? selected.capabilities) ?? {};
  settings.capabilities = { ...cloudConnection.capabilities };
  const policy = permissionPolicy({ ...settings, scope: selected.scope ?? (settings.permissions === 'allow-everything' ? 'full' : 'project'), writableRoots: selected.writableRoots });
  settings.scope = policy.scope;
  settings.writableRoots = policy.writableRoots;
  createToolPolicy({ toolsAllowed: cloudConnection.capabilities.tools !== false, toolAllowlist: selected.toolAllowlist });
  if (selected.toolAllowlist !== undefined) settings.toolAllowlist = [...selected.toolAllowlist];
  if (cloudConnection.capabilities.reasoning === false && selected.effort !== undefined) throw new Error('The working model declares reasoning unavailable; omit the explicit reasoning effort.');
  if (selected.effort !== undefined) settings.effort = validateReasoningEffort(selected.effort, { supportedEfforts: cloudConnection.supportedEfforts });
  const entries = selected.mcp instanceof Map ? [...selected.mcp] : Object.entries(selected.mcp ?? {});
  settings.mcp = Object.fromEntries(entries.map(([name, value]) => {
    if (!/^[A-Za-z][A-Za-z0-9_-]{0,63}$/.test(name)) throw new Error('Worker MCP server name is invalid.');
    const validated = validateConnection({ transport: 'chat-completions', model: 'mcp', baseUrl: value });
    return [name, validated.baseUrl];
  }));
  if (selected.computerUse !== undefined && typeof selected.computerUse !== 'boolean') throw new Error('Computer Use must be a boolean.');
  settings.computerUse = selected.computerUse ?? true;
  if (selected.computerServers !== undefined && !(selected.computerServers instanceof Set) && !Array.isArray(selected.computerServers)) throw new Error('Worker computer servers must be a list of selected names.');
  settings.computerServers = Array.from(selected.computerServers ?? []);
  if (settings.computerServers.some(name => typeof name !== 'string' || !/^[A-Za-z][A-Za-z0-9_-]{0,63}$/.test(name))) throw new Error('Worker computer server selection is invalid.');
  const disabled = selected.disabledComputerTools instanceof Map ? [...selected.disabledComputerTools] : Object.entries(selected.disabledComputerTools ?? {});
  settings.disabledComputerTools = Object.fromEntries(disabled.map(([name, tools]) => {
    if (!/^[A-Za-z][A-Za-z0-9_-]{0,63}$/.test(name) || !Array.isArray(tools) || tools.length > 1000 || tools.some(tool => typeof tool !== 'string' || !tool || tool.length > 512 || controls.test(tool))) throw new Error('Worker disabled computer tool selection is invalid.');
    return [name, [...tools]];
  }));
  if (!Array.isArray(selected.checks ?? []) || (selected.checks ?? []).length > 16) throw new Error('Worker acceptance checks must be a list of up to 16 explicit commands.');
  settings.checks = (selected.checks ?? []).map(check => {
    if (!check || typeof check !== 'object' || Array.isArray(check) || (check.command === undefined) === (check.shellCommand === undefined) || check.label !== undefined && (typeof check.label !== 'string' || check.label.length > 200 || controls.test(check.label))) throw new Error('Worker acceptance check requires bounded command text and label.');
    const result = check.label === undefined ? {} : { label: check.label };
    if (check.shellCommand !== undefined) {
      if (typeof check.shellCommand !== 'string' || !check.shellCommand.trim() || check.shellCommand.length > 32768 || Buffer.byteLength(check.shellCommand) > 65536 || check.shellCommand.includes('\0') || check.args !== undefined) throw new Error('Worker shell acceptance check is invalid.');
      result.shellCommand = check.shellCommand;
    } else {
      if (typeof check.command !== 'string' || !check.command.trim() || check.command.length > 4096 || controls.test(check.command) || !Array.isArray(check.args ?? []) || (check.args ?? []).length > 256 || (check.args ?? []).some(arg => typeof arg !== 'string' || arg.length > 32768 || arg.includes('\0'))) throw new Error('Worker argv acceptance check is invalid.');
      result.command = check.command; result.args = [...(check.args ?? [])];
    }
    if (Buffer.byteLength(JSON.stringify(result)) > 128 * 1024) throw new Error('Worker acceptance check is too large.');
    return result;
  });
  const value = { localConnection, cloudConnection, settings, watchPaths: [] };
  for (const name of ['developerInstructions', 'localDeveloperInstructions', 'standingGoal']) if (config[name] !== undefined) {
    if (typeof config[name] !== 'string' || Buffer.byteLength(config[name]) > 65536 || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(config[name])) throw new Error('Worker instructions and standing goal must be bounded text without terminal controls.');
    value[name] = config[name];
  }
  if (!Array.isArray(config.watchPaths ?? []) || (config.watchPaths ?? []).length > 20 || (config.watchPaths ?? []).some(path => typeof path !== 'string' || !path || controls.test(path))) throw new Error('Worker watch paths must be a bounded list of selected directories.');
  value.watchPaths = [...(config.watchPaths ?? [])];
  for (const name of ['wake', 'sleep', 'gpuStatus']) { const selectedHook = hook(config[name]); if (selectedHook) value[name] = selectedHook; }
  if (config.budget !== undefined || selected.budget !== undefined) value.budget = normalizeBudgetPolicy(config.budget ?? selected.budget);
  if (config.pricing !== undefined) value.pricing = normalizePricing(config.pricing);
  if (config.localPricing !== undefined) value.localPricing = normalizePricing(config.localPricing);
  if (config.maxOutputTokens !== undefined) { if (!Number.isSafeInteger(config.maxOutputTokens) || config.maxOutputTokens < 1 || config.maxOutputTokens > 1000000) throw new Error('Worker maximum output tokens are invalid.'); value.maxOutputTokens = config.maxOutputTokens; }
  for (const [name, minimum, maximum] of [['pollMs', 100, 60000], ['idleSleepMs', 100, 3600000], ['heartbeatMs', 1000, 3600000]]) if (config[name] !== undefined) {
    if (!Number.isSafeInteger(config[name]) || config[name] < minimum || config[name] > maximum) throw new Error('Worker scheduling interval is outside its supported range.');
    value[name] = config[name];
  }
  if (Buffer.byteLength(JSON.stringify(value)) > 256 * 1024) throw new Error('Worker startup configuration is too large.');
  return value;
}

function alive(pid) { try { process.kill(pid, 0); return true; } catch (error) { return error.code !== 'ESRCH'; } }
function publicRecord(record, status) { return { running: true, id: record.id, cwd: record.cwd, pid: record.pid, port: record.port, startedAt: record.startedAt, status }; }
async function controlRequest(record, path, method = 'GET') {
  // A port can be reused after a worker exits. Do not send its old capability
  // token to whichever unrelated process happens to own that port now.
  if (!alive(record.pid)) return undefined;
  try {
    const response = await fetch(`http://127.0.0.1:${record.port}${path}`, { method, headers: { authorization: `Bearer ${record.token}` }, redirect: 'error', signal: AbortSignal.timeout(3000) });
    if (!response.ok) { await response.body?.cancel(); throw new Error('Control authentication failed.'); }
    const chunks = []; let size = 0;
    for await (const chunk of response.body ?? []) { size += chunk.length; if (size > 65536) throw new Error('Control response too large.'); chunks.push(Buffer.from(chunk)); }
    const value = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    if (value?.id !== record.id || value?.pid !== record.pid || value?.cwd !== record.cwd) throw new Error('Detached worker control identity could not be authenticated.');
    return value;
  } catch (error) {
    if (!alive(record.pid)) return undefined;
    throw new Error('Detached worker control is unavailable or its identity could not be authenticated. Its process was left untouched.');
  }
}
export async function getAgentWorker(options = {}) {
  const location = await workerLocation(options), record = await readWorkerRecord(location);
  if (!record) return { running: false };
  const value = await controlRequest(record, '/status');
  if (!value) return { running: false, stale: true, id: record.id, pid: record.pid };
  return publicRecord(record, value.status);
}
export async function stopAgentWorker(options = {}) {
  const location = await workerLocation(options), record = await readWorkerRecord(location);
  if (!record) return { running: false };
  const response = await controlRequest(record, '/stop', 'POST');
  if (!response) return { running: false, stale: true, id: record.id, pid: record.pid };
  const deadline = Date.now() + 30000;
  while (Date.now() < deadline) {
    if (!alive(record.pid)) { await removeWorkerRecord(location, record.id); return { running: false }; }
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  throw new Error('Detached worker accepted stop but is still shutting down. Check /247 status; its process was not forcibly killed.');
}

export async function startAgentWorker({ stateDir = defaultWorkStateDir(), cwd = process.cwd(), config } = {}) {
  await requireElevated();
  const selected = validateAgentConfig(config), location = await workerLocation({ stateDir, cwd, create: true });
  let lock, child, record, succeeded = false;
  try {
    try { lock = await open(location.lockPath, 'wx', 0o600); }
    catch (error) { throw new Error(error.code === 'EEXIST' ? 'Another worker startup is in progress or has an interrupted startup lock. Existing workers were left untouched.' : 'Unable to lock detached worker startup.'); }
    const existing = await readWorkerRecord(location);
    if (existing) {
      const status = await controlRequest(existing, '/status');
      if (status) return publicRecord(existing, status.status);
      await removeWorkerRecord(location, existing.id);
    }
    const id = randomUUID(), token = randomBytes(32).toString('hex');
    const executable = fileURLToPath(new URL('./agent-worker.mjs', import.meta.url));
    child = spawn(process.execPath, [executable], { cwd: location.cwd, shell: false, windowsHide: true, detached: true, stdio: ['ignore', 'ignore', 'ignore', 'ipc'] });
    const result = await new Promise((resolveStart, reject) => {
      let finished = false;
      const finish = (error, status) => { if (finished) return; finished = true; clearTimeout(timer); error ? reject(error) : resolveStart(status); };
      const timer = setTimeout(() => finish(new Error('Detached worker startup timed out.')), 20000);
      child.once('error', () => finish(new Error('Unable to launch the native detached worker.')));
      child.once('exit', () => finish(new Error('Detached worker stopped before startup completed.')));
      child.on('message', async message => {
        if (finished || message?.id !== id) return;
        if (message.type === 'failed') { finish(new Error(typeof message.message === 'string' ? message.message.slice(0, 1000) : 'Detached worker startup failed.')); return; }
        if (message.type === 'ready') {
          try {
            record = validateRecord({ version: 1, id, token, cwd: location.cwd, pid: child.pid, port: message.port, startedAt: message.startedAt }, location);
            await writeWorkerRecord(location, record);
            child.send({ type: 'registered', id });
          } catch { finish(new Error('Unable to register the detached worker control record.')); }
        } else if (message.type === 'started' && record) finish(undefined, publicRecord(record, message.status));
      });
      child.once('spawn', () => { child.send({ type: 'initialize', id, token, cwd: location.cwd, stateDir: location.stateDir, config: selected }, error => { if (error) finish(new Error('Unable to deliver worker startup data securely.')); }); });
    });
    succeeded = true;
    child.removeAllListeners('message'); child.disconnect(); child.unref();
    return result;
  } finally {
    if (!succeeded && child) {
      child.kill();
      const timer = setTimeout(() => child.kill('SIGKILL'), 2000); timer.unref?.();
      await new Promise(resolveClose => { if (child.exitCode !== null || child.signalCode !== null) resolveClose(); else child.once('exit', resolveClose); });
      clearTimeout(timer);
      if (record) await removeWorkerRecord(location, record.id).catch(() => {});
    }
    if (lock) { await lock.close().catch(() => {}); await rm(location.lockPath, { force: true }).catch(() => {}); }
  }
}
