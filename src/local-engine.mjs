import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { resolveCodex } from './runtime.mjs';

export function localCodex({ env = process.env } = {}) {
  const override = Object.keys(env).find(name => process.platform === 'win32' ? name.toUpperCase() === 'SUDO_CLI_CODEX' : name === 'SUDO_CLI_CODEX');
  if (override !== undefined) return resolveCodex({ env });
  const bundled = fileURLToPath(new URL(process.platform === 'win32' ? '../runtime/codex.exe' : '../runtime/codex', import.meta.url));
  if (existsSync(bundled)) return resolveCodex({ env: { ...env, SUDO_CLI_CODEX: bundled } });
  return resolveCodex({ env });
}
