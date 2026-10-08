import { spawn } from 'node:child_process';
import { lstat, open, mkdir, rm } from 'node:fs/promises';
import { constants } from 'node:fs';
import { join, resolve, isAbsolute } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { validateAgentConfig, startAgentWorker, getAgentWorker, stopAgentWorker } from './agent-control.mjs';
import { requireElevated } from './privileges.mjs';

const pathText = value => typeof value === 'string' && value.length > 0 && value.length <= 4096 && !/[\u0000-\u001f\u007f]/.test(value);
const envName = value => typeof value === 'string' && /^[A-Za-z_][A-Za-z0-9_]{0,127}$/.test(value);
const xml = value => value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&apos;');
const systemdArg = value => '"' + value.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/%/g, '%%').replace(/\$/g, '$$') + '"';
const windowsArg = value => '"' + value.replace(/(\\*)"/g, '$1$1\\"').replace(/(\\+)$/g, '$1$1') + '"';

export function createAutostartPlan({ platform = process.platform, name = 'codexcli-agent', installDir, nodePath = process.execPath, entryPath = fileURLToPath(import.meta.url), configPath, cwd = process.cwd() } = {}) {
  if (!['linux', 'darwin', 'win32'].includes(platform) || !/^[A-Za-z][A-Za-z0-9_.-]{0,63}$/.test(name) || ![installDir, nodePath, entryPath, configPath, cwd].every(pathText)) throw new Error('Startup platform, name or paths are invalid.');
  installDir = resolve(installDir);
  let filename, content, installCommands, removeCommands;
  const args = [entryPath, 'run', '--config', configPath];
  if (platform === 'linux') {
    filename = `${name}.service`;
    content = `[Unit]\nDescription=Codex CLI explicit background assistant\nAfter=network-online.target\nWants=network-online.target\n\n[Service]\nType=simple\nUser=root\nWorkingDirectory=${systemdArg(cwd)}\nExecStart=${[nodePath, ...args].map(systemdArg).join(' ')}\nRestart=on-failure\nRestartSec=10\nUMask=0077\nKillMode=control-group\nTimeoutStopSec=45\n\n[Install]\nWantedBy=multi-user.target\n`;
    installCommands = [{ file: 'systemctl', args: ['link', join(installDir, filename)] }, { file: 'systemctl', args: ['enable', '--now', filename] }];
    removeCommands = [{ file: 'systemctl', args: ['disable', '--now', filename] }, { file: 'systemctl', args: ['daemon-reload'] }];
  } else if (platform === 'darwin') {
    filename = `${name}.plist`;
    content = `<?xml version="1.0" encoding="UTF-8"?>\n<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">\n<plist version="1.0"><dict><key>Label</key><string>${xml(name)}</string><key>ProgramArguments</key><array>${[nodePath, ...args].map(value => `<string>${xml(value)}</string>`).join('')}</array><key>WorkingDirectory</key><string>${xml(cwd)}</string><key>UserName</key><string>root</string><key>RunAtLoad</key><true/><key>KeepAlive</key><dict><key>SuccessfulExit</key><false/></dict><key>ThrottleInterval</key><integer>10</integer><key>ProcessType</key><string>Background</string></dict></plist>\n`;
    const systemPath = `/Library/LaunchDaemons/${filename}`;
    installCommands = [{ file: '/bin/test', args: ['!', '-e', systemPath] }, { file: '/bin/cp', args: ['-n', join(installDir, filename), systemPath] }, { file: '/bin/launchctl', args: ['bootstrap', 'system', systemPath] }];
    removeCommands = [{ file: '/bin/launchctl', args: ['bootout', `system/${name}`] }, { file: '/bin/rm', args: ['--', systemPath] }];
  } else {
    filename = `${name}.xml`;
    content = `<?xml version="1.0" encoding="UTF-16"?>\n<Task version="1.4" xmlns="http://schemas.microsoft.com/windows/2004/02/mit/task"><RegistrationInfo><Description>Codex CLI explicitly installed startup worker</Description></RegistrationInfo><Triggers><BootTrigger><Enabled>true</Enabled></BootTrigger></Triggers><Principals><Principal id="Author"><UserId>S-1-5-18</UserId><LogonType>ServiceAccount</LogonType><RunLevel>HighestAvailable</RunLevel></Principal></Principals><Settings><MultipleInstancesPolicy>IgnoreNew</MultipleInstancesPolicy><DisallowStartIfOnBatteries>false</DisallowStartIfOnBatteries><StopIfGoingOnBatteries>false</StopIfGoingOnBatteries><AllowHardTerminate>false</AllowHardTerminate><StartWhenAvailable>true</StartWhenAvailable><Enabled>true</Enabled><Hidden>true</Hidden><ExecutionTimeLimit>PT0S</ExecutionTimeLimit></Settings><Actions Context="Author"><Exec><Command>${xml(nodePath)}</Command><Arguments>${xml(args.map(windowsArg).join(' '))}</Arguments><WorkingDirectory>${xml(cwd)}</WorkingDirectory></Exec></Actions></Task>\n`;
    installCommands = [{ file: 'schtasks.exe', args: ['/Create', '/TN', name, '/XML', join(installDir, filename)] }];
    removeCommands = [{ file: 'schtasks.exe', args: ['/End', '/TN', name], allowFailure: true }, { file: 'schtasks.exe', args: ['/Delete', '/TN', name, '/F'] }];
  }
  return { version: 1, platform, name, installDir, filename, content, installCommands, removeCommands, configPath, cwd, nodePath, entryPath, credentials: 'runtime environment or explicit credential loader; no saved API keys', supported: true };
}

/** Argument-vector execution only. Credential loader output is bounded and never logged. */
export function executeStartupCommand(file, args, { env = process.env, timeoutMs = 15000, maxBytes = 65536 } = {}) {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(file, args, { shell: false, windowsHide: true, env, stdio: ['ignore', 'pipe', 'pipe'] });
    const chunks = []; let size = 0, settled = false;
    const finish = (error, value) => { if (settled) return; settled = true; clearTimeout(timer); error ? reject(error) : resolvePromise(value); };
    const timer = setTimeout(() => { child.kill(); finish(new Error('Startup command timed out.')); }, timeoutMs);
    child.stdout.on('data', chunk => { size += chunk.length; if (size > maxBytes) { child.kill(); finish(new Error('Startup command output exceeded its limit.')); } else chunks.push(chunk); });
    child.stderr.resume(); child.once('error', () => finish(new Error('Startup command could not execute.')));
    child.once('close', code => finish(undefined, { code, stdout: Buffer.concat(chunks).toString('utf8') }));
  });
}
function checkPlan(plan) { if (!plan || plan.version !== 1 || !['linux', 'darwin', 'win32'].includes(plan.platform) || !pathText(plan.installDir) || !/^[A-Za-z][A-Za-z0-9_.-]{0,63}\.(?:service|plist|xml)$/.test(plan.filename ?? '') || typeof plan.content !== 'string' || !Array.isArray(plan.installCommands) || !Array.isArray(plan.removeCommands)) throw new Error('Startup installation plan is invalid.'); }
async function commands(values, execute) { for (const value of values) { const result = await execute(value.file, value.args); if (result?.code !== 0 && !value.allowFailure) throw new Error('Operating-system startup registration failed. Review the explicit installation plan.'); } }
export async function installAutostart(plan, { execute = executeStartupCommand } = {}) {
  checkPlan(plan); if (execute === executeStartupCommand) await requireElevated();
  await mkdir(plan.installDir, { recursive: true, mode: 0o700 });
  if ((await lstat(plan.installDir)).isSymbolicLink()) throw new Error('Startup installation requires a real protected directory.');
  const path = join(plan.installDir, plan.filename); let file;
  try { file = await open(path, 'wx', 0o600); }
  catch (error) { throw new Error(error.code === 'EEXIST' ? 'Startup template already exists; remove it explicitly before replacing it.' : 'Startup template could not be saved.'); }
  try { await file.writeFile(plan.platform === 'win32' ? Buffer.from('\ufeff' + plan.content, 'utf16le') : plan.content); await file.sync(); }
  finally { await file.close(); }
  await commands(plan.installCommands, execute);
  return { installed: true, path, platform: plan.platform, name: plan.name };
}
export async function removeAutostart(plan, { execute = executeStartupCommand } = {}) {
  checkPlan(plan); if (execute === executeStartupCommand) await requireElevated();
  await commands(plan.removeCommands, execute);
  const path = join(plan.installDir, plan.filename), info = await lstat(path).catch(error => { if (error.code === 'ENOENT') return; throw error; });
  if (info && (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1)) throw new Error('Startup template changed; existing file was preserved.');
  if (info) await rm(path);
  return { installed: false, platform: plan.platform, name: plan.name };
}

export function validateStartupConfig(input) {
  if (!input || input.version !== 1 || !pathText(input.cwd) || !pathText(input.stateDir) || !input.agent || typeof input.agent !== 'object') throw new Error('Startup configuration is invalid.');
  // All inline API keys are forbidden, including unused fields, so config cannot become a secret backup.
  const visit = value => { if (value && typeof value === 'object') for (const [key, child] of Object.entries(value)) { if (/^(apiKey|token|password|secret)$/i.test(key) && child !== undefined && child !== '') throw new Error('Startup configuration must use credential environment references, never plaintext secrets.'); visit(child); } };
  visit(input);
  const result = structuredClone(input);
  for (const entry of [result.agent.localConnection, result.agent.cloudConnection, result.agent.wake, result.agent.sleep, result.agent.gpuStatus].filter(Boolean)) if (entry.apiKeyEnv !== undefined && !envName(entry.apiKeyEnv)) throw new Error('Startup credential environment reference is invalid.');
  if (result.credentialProvider !== undefined) {
    const provider = result.credentialProvider;
    if (!provider || !pathText(provider.file) || !isAbsolute(provider.file) || !Array.isArray(provider.args ?? []) || provider.args.length > 20 || provider.args.some(value => !pathText(value))) throw new Error('Startup credential loader requires an explicit absolute executable and bounded arguments.');
    result.credentialProvider = { file: provider.file, args: [...(provider.args ?? [])] };
  }
  return result;
}
export async function loadStartupConfig(path, { env = process.env, execute = executeStartupCommand } = {}) {
  if (!pathText(path)) throw new Error('Startup configuration path is invalid.');
  let file, parsed;
  try {
    const before = await lstat(path); if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1 || before.size > 256 * 1024 || process.platform !== 'win32' && (before.mode & 0o077)) throw new Error('private');
    file = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0)); const info = await file.stat(); if (info.ino !== before.ino || info.dev !== before.dev || info.size !== before.size) throw new Error('changed');
    parsed = validateStartupConfig(JSON.parse(await file.readFile('utf8')));
  } catch { throw new Error('Startup configuration is invalid, linked, insecure or unreadable. No worker was started.'); }
  finally { await file?.close().catch(() => {}); }
  let credentials = { ...env };
  if (parsed.credentialProvider) {
    try {
      const output = await execute(parsed.credentialProvider.file, parsed.credentialProvider.args, { env, maxBytes: 65536 });
      if (output?.code !== 0 || typeof output.stdout !== 'string' || Buffer.byteLength(output.stdout) > 65536) throw new Error('loader');
      const values = JSON.parse(output.stdout); if (!values || typeof values !== 'object' || Array.isArray(values) || Object.entries(values).some(([key, value]) => !envName(key) || typeof value !== 'string' || !value || value.length > 16384 || /[\u0000-\u001f\u007f]/.test(value))) throw new Error('credentials');
      credentials = { ...credentials, ...values };
    } catch { throw new Error('Startup credential loader failed or returned invalid credentials. No worker was started.'); }
  }
  for (const entry of [parsed.agent.localConnection, parsed.agent.cloudConnection, parsed.agent.wake, parsed.agent.sleep, parsed.agent.gpuStatus].filter(Boolean)) if (entry.apiKeyEnv !== undefined) {
    const value = credentials[entry.apiKeyEnv]; if (typeof value !== 'string' || !value) throw new Error('A referenced startup credential is unavailable. No worker was started.'); entry.apiKey = value; delete entry.apiKeyEnv;
  }
  return { cwd: parsed.cwd, stateDir: parsed.stateDir, config: validateAgentConfig(parsed.agent) };
}

/** Foreground OS-service owner for the IPC-configured detached worker. Startup requires elevation again. */
export async function runStartupService({ configPath, signal, env, execute, start = startAgentWorker, status = getAgentWorker, stop = stopAgentWorker } = {}) {
  await requireElevated();
  const options = await loadStartupConfig(configPath, { env, execute });
  if ((await status(options)).running) throw new Error('An existing project worker already owns this project. Startup service did not take it over.');
  const worker = await start(options);
  try {
    while (!signal?.aborted) {
      await new Promise(resolvePromise => { const done = () => { clearTimeout(timer); signal?.removeEventListener('abort', done); resolvePromise(); }; const timer = setTimeout(done, 1000); signal?.addEventListener('abort', done, { once: true }); });
      if (signal?.aborted) break;
      const current = await status(options);
      if (!current.running || current.id !== worker.id) throw new Error('Startup worker exited or changed identity. Interrupted tasks require review.');
    }
  } finally { const current = await status(options).catch(() => ({})); if (current.running && current.id === worker.id) await stop(options); }
}
if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  const args = process.argv.slice(2);
  if (args.length !== 3 || args[0] !== 'run' || args[1] !== '--config') { process.stderr.write('Use autostart.mjs run --config ABSOLUTE_CONFIG_PATH\n'); process.exitCode = 2; }
  else {
    const controller = new AbortController(); process.once('SIGTERM', () => controller.abort()); process.once('SIGINT', () => controller.abort());
    runStartupService({ configPath: args[2], signal: controller.signal }).catch(() => { process.stderr.write('Startup service failed. Review its protected configuration and worker status.\n'); process.exitCode = 1; });
  }
}
