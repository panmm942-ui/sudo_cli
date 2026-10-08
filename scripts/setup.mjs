#!/usr/bin/env node
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { localCodex } from '../src/local-engine.mjs';
import { installRuntime, CODEX_VERSION } from '../src/platforms.mjs';
import { registerCommand } from '../src/command-setup.mjs';

const help = `codexcli first setup

Usage: node scripts/setup.mjs [--command-only | --help]

Checks the project runtime or installs pinned Codex ${CODEX_VERSION}, then registers
the sudocli command for the current user on Windows, Linux or macOS.
No administrator privileges are required. The command points to this project;
keep this directory, or rerun setup after moving it.

--command-only  Use an existing compatible engine; do not download a runtime.
--help          Show this help without changing anything.

Setup stores no model or key. In sudocli, choose a cloud AI or a local AI already
running on this PC (Ollama, LM Studio or another compatible server). Most local
servers need no API key. Optional AI profiles can be saved later with /switch;
profiles exclude API keys, which stay in memory or a chosen environment variable.
`;
const args = process.argv.slice(2);
const root = fileURLToPath(new URL('../', import.meta.url));
function pinnedRuntimeAvailable() {
  try {
    const engine = localCodex();
    const probe = spawnSync(engine, ['--version'], { encoding: 'utf8', shell: false, windowsHide: true, timeout: 10000 });
    return probe.status === 0 && (probe.stdout ?? '').trim() === `codex-cli ${CODEX_VERSION}`;
  } catch { return false; }
}
try {
  if (args.length > 1 || (args.length && !['--help', '-h', '--command-only'].includes(args[0]))) throw new Error('Unknown setup option. Run setup with --help for usage.');
  if (['--help', '-h'].includes(args[0])) {
    console.log(help);
  } else {
    if (Number(process.versions.node.split('.')[0]) < 22) throw new Error('codexcli setup requires Node.js 22 or newer.');
    if (!pinnedRuntimeAvailable()) {
      if (args[0] === '--command-only') throw new Error(`A compatible Codex ${CODEX_VERSION} runtime is required. Run setup without --command-only to install it locally.`);
      console.log(`Installing pinned Codex ${CODEX_VERSION} locally.`);
      const controller = new AbortController();
      const interrupt = () => controller.abort();
      process.once('SIGINT', interrupt);
      process.once('SIGTERM', interrupt);
      let last = -1;
      try {
        await installRuntime({ projectRoot: root, signal: AbortSignal.any([controller.signal, AbortSignal.timeout(300000)]), onProgress(bytes, total) {
          const value = Math.floor(bytes / total * 10) * 10;
          if (value !== last) { last = value; console.log(`Runtime download: ${value}%`); }
        } });
      } finally {
        process.removeListener('SIGINT', interrupt);
        process.removeListener('SIGTERM', interrupt);
      }
      if (!pinnedRuntimeAvailable()) throw new Error('The installed runtime did not pass its native version check.');
    }
    const result = await registerCommand({ projectRoot: root });
    console.log(`Registered sudocli for the current user${result.commandChanged || result.pathChanged ? '.' : ' (already configured).'}`);
    console.log(`Command: ${result.commandPath}`);
    if (result.profilePath) console.log(`PATH startup file: ${result.profilePath}`);
    console.log('Open a new terminal and run: sudocli');
    console.log('In sudocli, choose Cloud/API or Local AI on this PC. Use /local to connect an installed local model.');
  }
} catch (error) {
  console.error(`codexcli setup: ${error?.message?.replace(/[\u0000-\u001f\u007f]/g, ' ') || 'Setup failed.'}`);
  process.exitCode = 1;
}
