import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { win32 } from 'node:path';

const execute = promisify(execFile);
const windowsProbe = '[Console]::WriteLine(([Security.Principal.WindowsPrincipal] [Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator))';

/** Inspect the current process token. This never starts or requests elevated execution. */
export async function isElevated(options = {}) {
  const platform = options.platform ?? process.platform;
  if (platform === 'linux' || platform === 'darwin') {
    const geteuid = Object.hasOwn(options, 'geteuid') ? options.geteuid : process.geteuid?.bind(process);
    try { return typeof geteuid === 'function' && geteuid() === 0; } catch { return false; }
  }
  if (platform !== 'win32') return false;
  const probe = options.probe ?? execute;
  const timeoutMs = options.timeoutMs ?? 5000;
  if (typeof probe !== 'function' || !Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 10000) return false;
  const executable = win32.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
  let timer;
  try {
    const result = await Promise.race([
      probe(executable, ['-NoProfile', '-NonInteractive', '-Command', windowsProbe], { timeout: timeoutMs, windowsHide: true, shell: false, encoding: 'utf8', maxBuffer: 4096 }),
      new Promise(resolve => { timer = setTimeout(() => resolve(undefined), timeoutMs); }),
    ]);
    return typeof result?.stdout === 'string' && result.stdout.trim().toLowerCase() === 'true';
  } catch { return false; }
  finally { clearTimeout(timer); }
}

export async function requireElevated(options = {}) {
  if (await isElevated(options)) return true;
  const platform = options.platform ?? process.platform;
  const instruction = platform === 'win32'
    ? 'Run your terminal as Administrator, then run sudocli again.'
    : platform === 'linux' || platform === 'darwin'
      ? 'Run sudo sudocli from a terminal, or run sudo with the full path to the sudocli launcher if it is outside the root PATH.'
      : 'Launch requires a verified administrator or root process on Windows, Linux or macOS.';
  const error = new Error(`sudocli requires administrator/root privileges at launch. ${instruction}`);
  error.code = 'ELEVATION_REQUIRED';
  throw error;
}
