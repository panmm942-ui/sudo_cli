import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { resolveCodex } from './runtime.mjs';

const defaultProjectRoot = fileURLToPath(new URL('../', import.meta.url));

export function bundledCandidates({ projectRoot = defaultProjectRoot, platform = process.platform, arch = process.arch } = {}) {
  const executable = platform === 'win32' ? 'codex.exe' : 'codex';
  const candidates = [join(projectRoot, 'runtime', `${platform}-${arch}`, 'bin', executable)];
  // The original portable Windows bundle is x64. Do not select it on ARM64.
  if (platform !== 'win32' || arch === 'x64') candidates.push(join(projectRoot, 'runtime', executable));
  return candidates;
}

export function localCodex({ env = process.env, projectRoot = defaultProjectRoot } = {}) {
  const override = Object.keys(env).find(name => process.platform === 'win32' ? name.toUpperCase() === 'SUDO_CLI_CODEX' : name === 'SUDO_CLI_CODEX');
  if (override !== undefined) return resolveCodex({ env });
  for (const bundled of bundledCandidates({ projectRoot })) {
    if (existsSync(bundled)) return resolveCodex({ env: { ...env, SUDO_CLI_CODEX: bundled } });
  }
  return resolveCodex({ env });
}
