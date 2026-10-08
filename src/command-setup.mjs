import { access, chmod, lstat, mkdir, open, readFile, realpath, rename, rm } from 'node:fs/promises';
import { constants } from 'node:fs';
import { homedir } from 'node:os';
import { basename, join, resolve } from 'node:path';
import { randomBytes } from 'node:crypto';
import { spawnSync } from 'node:child_process';

const marker = 'CODEXCLI_MANAGED_COMMAND_V1';
const startMarker = '# >>> codexcli sudocli PATH >>>';
const endMarker = '# <<< codexcli sudocli PATH <<<';

function safePath(value) {
  if (typeof value !== 'string' || !value || /[\u0000-\u001f\u007f]/.test(value)) throw new Error('Command setup requires a valid directory or executable path.');
  return resolve(value);
}
function envValue(env, name) {
  const key = Object.keys(env).find(key => key.toUpperCase() === name.toUpperCase());
  return key === undefined ? undefined : env[key];
}
function shellQuote(value) { return `'${value.replace(/'/g, `'"'"'`)}'`; }
function fishQuote(value) { return `'${value.replace(/\\/g, '\\\\').replace(/'/g, "\\'")}'`; }
function batchQuote(value) {
  if (/["\r\n]/.test(value)) throw new Error('Windows command paths cannot contain quotes or control characters.');
  return `"${value.replace(/%/g, '%%')}"`;
}

export function startupFile({ homeDir = homedir(), platform = process.platform, env = process.env } = {}) {
  const shell = basename(env.SHELL ?? (platform === 'darwin' ? '/bin/zsh' : '/bin/bash'));
  if (shell === 'zsh') return { filename: '.zshrc', path: join(homeDir, '.zshrc'), shell: 'posix' };
  if (shell === 'fish') {
    const config = env.XDG_CONFIG_HOME ? safePath(env.XDG_CONFIG_HOME) : join(homeDir, '.config');
    return { filename: 'fish/config.fish', path: join(config, 'fish', 'config.fish'), shell: 'fish' };
  }
  const filename = shell === 'bash' ? (platform === 'darwin' ? '.bash_profile' : '.bashrc') : '.profile';
  return { filename, path: join(homeDir, filename), shell: 'posix' };
}

function pathBlock(binDirectory, shell) {
  if (shell === 'fish') return `${startMarker}\nif not contains -- ${fishQuote(binDirectory)} $PATH\n    set -gx PATH ${fishQuote(binDirectory)} $PATH\nend\n${endMarker}`;
  return `${startMarker}\ncase ":\${PATH-}:" in\n    *${shellQuote(`:${binDirectory}:`)}*) ;;\n    *) export PATH=${shellQuote(binDirectory)}\${PATH:+:"$PATH"} ;;\nesac\n${endMarker}`;
}

async function existingFile(path) {
  try {
    const info = await lstat(path);
    if (info.isSymbolicLink()) throw new Error('Command setup will not modify a symbolic link destination.');
    if (!info.isFile()) throw new Error('Command setup destination exists and is not a regular file.');
    return { text: await readFile(path, 'utf8'), mode: info.mode & 0o777 };
  } catch (error) {
    if (error?.code === 'ENOENT') return { text: undefined, mode: undefined };
    throw error;
  }
}

function updatedProfile(current, block) {
  const text = current ?? '';
  const starts = text.split(startMarker).length - 1;
  const ends = text.split(endMarker).length - 1;
  if (!starts && !ends) return text + (text && !text.endsWith('\n') ? '\n' : '') + '\n' + block + '\n';
  if (starts !== 1 || ends !== 1 || text.indexOf(endMarker) < text.indexOf(startMarker)) throw new Error('Shell startup file has an incomplete or duplicate codexcli PATH block.');
  const begin = text.indexOf(startMarker);
  const end = text.indexOf(endMarker) + endMarker.length;
  // Only replace our own bounded block; retain all other user settings verbatim.
  return text.slice(0, begin) + block + text.slice(end);
}

function normalizeWindowsPath(value, env) {
  return value.replace(/^"|"$/g, '').replace(/%([^%]+)%/g, (all, name) => envValue(env, name) ?? all).replace(/\//g, '\\').replace(/\\+$/g, '').toLowerCase();
}
export function prependWindowsPath(current, binDirectory, env = process.env) {
  const value = current ?? '';
  if (typeof value !== 'string' || /[\r\n\u0000]/.test(value)) throw new Error('The existing user PATH is invalid.');
  const normalized = normalizeWindowsPath(binDirectory, env);
  if (value.split(';').some(entry => normalizeWindowsPath(entry.trim(), env) === normalized)) return value;
  return binDirectory + (value ? `;${value}` : '');
}

function runPowerShell(script, extraEnv = {}) {
  if (process.platform !== 'win32') throw new Error('Windows PATH registration requires Windows or an injected PATH store.');
  const executable = join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
  const utf8Script = '[Console]::OutputEncoding=[System.Text.UTF8Encoding]::new($false); $OutputEncoding=[Console]::OutputEncoding; ' + script;
  const result = spawnSync(executable, ['-NoProfile', '-NonInteractive', '-Command', utf8Script], { env: { ...process.env, ...extraEnv }, encoding: 'utf8', shell: false, windowsHide: true, timeout: 20000, maxBuffer: 2 * 1024 * 1024 });
  if (result.status !== 0 || result.error) throw new Error('Unable to update the current user PATH. The project launcher is still available locally.');
  return result.stdout.replace(/^\uFEFF/, '').trim();
}

export const windowsUserPathStore = {
  async read() {
    const value = runPowerShell(`$ErrorActionPreference='Stop'; $key=[Microsoft.Win32.Registry]::CurrentUser.OpenSubKey('Environment'); try { $value=if($null -eq $key){''}else{[string]$key.GetValue('Path','',[Microsoft.Win32.RegistryValueOptions]::DoNotExpandEnvironmentNames)}; ConvertTo-Json -InputObject $value -Compress } finally { if($null -ne $key){$key.Dispose()} }`);
    try { return JSON.parse(value); } catch { throw new Error('Unable to read the current user PATH.'); }
  },
  async write(value) {
    runPowerShell(`$ErrorActionPreference='Stop'; $key=[Microsoft.Win32.Registry]::CurrentUser.CreateSubKey('Environment'); try { $kind=[Microsoft.Win32.RegistryValueKind]::ExpandString; if($key.GetValueNames() -contains 'Path'){$kind=$key.GetValueKind('Path')}; if($kind -notin @([Microsoft.Win32.RegistryValueKind]::String,[Microsoft.Win32.RegistryValueKind]::ExpandString)){throw 'Unsupported PATH registry type'}; $key.SetValue('Path',$env:CODEXCLI_REGISTER_PATH,$kind) } finally { $key.Dispose() }; Add-Type -Namespace Codexcli -Name EnvironmentBroadcast -MemberDefinition '[System.Runtime.InteropServices.DllImport("user32.dll", CharSet=System.Runtime.InteropServices.CharSet.Unicode, SetLastError=true)] public static extern System.IntPtr SendMessageTimeout(System.IntPtr hWnd, uint msg, System.UIntPtr wParam, string lParam, uint flags, uint timeout, out System.UIntPtr result);'; $result=[UIntPtr]::Zero; [Codexcli.EnvironmentBroadcast]::SendMessageTimeout([IntPtr]65535,26,[UIntPtr]::Zero,'Environment',2,5000,[ref]$result) | Out-Null`, { CODEXCLI_REGISTER_PATH: value });
  },
};

async function atomicUpdate(path, previous, text, mode) {
  if (previous.text === text) return false;
  await mkdir(resolve(path, '..'), { recursive: true });
  const temporary = join(resolve(path, '..'), `.codexcli-${process.pid}-${randomBytes(8).toString('hex')}.tmp`);
  let file;
  try {
    file = await open(temporary, 'wx', mode);
    await file.writeFile(text, 'utf8');
    await file.close(); file = undefined;
    await chmod(temporary, mode);
    const now = await existingFile(path);
    if (now.text !== previous.text) throw new Error('Command setup destination changed while registration was running.');
    if (previous.text === undefined) {
      // Claim an absent filename without replacing a concurrently created foreign file.
      const { copyFile } = await import('node:fs/promises');
      await copyFile(temporary, path, constants.COPYFILE_EXCL);
      await chmod(path, mode);
    } else await rename(temporary, path);
    return true;
  } finally {
    await file?.close().catch(() => {});
    await rm(temporary, { force: true });
  }
}

/** Register only a wrapper and PATH entry; never serialize model/session settings. */
export async function registerCommand({ projectRoot, homeDir = homedir(), platform = process.platform, env = process.env, nodePath = process.execPath, windowsPathStore = windowsUserPathStore } = {}) {
  if (!['win32', 'linux', 'darwin'].includes(platform)) throw new Error('Command setup supports Windows, Linux and macOS.');
  const project = await realpath(safePath(projectRoot));
  const home = safePath(homeDir);
  const entry = join(project, 'bin', 'sudocli.mjs');
  await access(entry, constants.F_OK);
  const bundled = join(project, 'runtime', platform === 'win32' ? 'node.exe' : 'node');
  let node = safePath(nodePath);
  try {
    const info = await lstat(bundled);
    if (info.isFile() && !info.isSymbolicLink()) { await access(bundled, platform === 'win32' ? constants.F_OK : constants.X_OK); node = bundled; }
  } catch (error) { if (!['ENOENT', 'EACCES'].includes(error?.code)) throw error; }
  const appData = envValue(env, 'LOCALAPPDATA') ?? join(home, 'AppData', 'Local');
  const binDirectory = platform === 'win32' ? join(safePath(appData), 'codexcli', 'bin') : join(home, '.local', 'bin');
  if (platform !== 'win32' && process.platform !== 'win32' && binDirectory.includes(':')) throw new Error('A Unix command directory cannot contain the PATH separator.');
  const commandPath = join(binDirectory, platform === 'win32' ? 'sudocli.cmd' : 'sudocli');
  const wrapper = platform === 'win32'
    ? `@echo off\r\nrem ${marker}\r\nsetlocal DisableDelayedExpansion\r\n${batchQuote(node)} ${batchQuote(entry)} %*\r\n`
    : `#!/bin/sh\n# ${marker}\nexec ${shellQuote(node)} ${shellQuote(entry)} "$@"\n`;
  const commandPrevious = await existingFile(commandPath);
  const managedPrefix = platform === 'win32' ? `@echo off\r\nrem ${marker}\r\n` : `#!/bin/sh\n# ${marker}\n`;
  if (commandPrevious.text !== undefined && !commandPrevious.text.startsWith(managedPrefix)) throw new Error('An existing sudocli command is not managed by codexcli. It will not be overwritten.');
  let profile;
  let profilePrevious;
  let profileText;
  let userPath;
  let newUserPath;
  if (platform === 'win32') {
    userPath = await windowsPathStore.read();
    newUserPath = prependWindowsPath(userPath, binDirectory, env);
  } else {
    profile = startupFile({ homeDir: home, platform, env });
    profilePrevious = await existingFile(profile.path);
    profileText = updatedProfile(profilePrevious.text, pathBlock(binDirectory, profile.shell));
  }
  await mkdir(binDirectory, { recursive: true });
  const info = await lstat(binDirectory);
  if (info.isSymbolicLink() || !info.isDirectory()) throw new Error('The command directory must be a real directory.');
  const lockPath = join(binDirectory, '.codexcli-setup.lock');
  let lock;
  try {
    try { lock = await open(lockPath, 'wx', 0o600); }
    catch (error) { if (error?.code === 'EEXIST') throw new Error('Command registration is already running or has an interrupted setup lock.'); throw error; }
    const commandChanged = await atomicUpdate(commandPath, commandPrevious, wrapper, platform === 'win32' ? 0o644 : 0o755);
    let pathChanged = false;
    if (platform === 'win32') {
      if (newUserPath !== userPath) {
        if (await windowsPathStore.read() !== userPath) throw new Error('The user PATH changed during setup. Retry registration to preserve that change.');
        await windowsPathStore.write(newUserPath); pathChanged = true;
      }
    } else pathChanged = await atomicUpdate(profile.path, profilePrevious, profileText, profilePrevious.mode ?? 0o644);
    return { platform, commandPath, binDirectory, profilePath: profile?.path, commandChanged, pathChanged, requiresNewTerminal: true };
  } finally {
    if (lock) { try { await lock.close(); } finally { await rm(lockPath, { force: true }); } }
  }
}
