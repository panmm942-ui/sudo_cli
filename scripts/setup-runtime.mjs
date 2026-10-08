#!/usr/bin/env node
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { platformRuntime, installRuntime, CODEX_VERSION } from '../src/platforms.mjs';
import { localCodex } from '../src/local-engine.mjs';

const help = `sudo cli runtime setup

Usage: node scripts/setup-runtime.mjs [--help | --check | --print-target]

Downloads the official Codex ${CODEX_VERSION} native package for the current
operating system and architecture into this project's runtime directory.
Requires Node.js 22 or newer. Existing app installations and settings are untouched.
The archive is verified against its pinned SHA-256 digest before extraction.
`;

const args = process.argv.slice(2);
try {
  if (args.length > 1 || (args.length && !['--help', '-h', '--check', '--print-target'].includes(args[0]))) throw new Error('Unknown setup argument. Run with --help for usage.');
  if (['--help', '-h'].includes(args[0])) {
    console.log(help);
  } else if (args[0] === '--print-target') {
    console.log(JSON.stringify(platformRuntime(), null, 2));
  } else if (args[0] === '--check') {
    const executable = localCodex();
    const result = spawnSync(executable, ['--version'], { encoding: 'utf8', shell: false, windowsHide: true, timeout: 10000 });
    if (result.status !== 0 || !/^codex-cli \S+/m.test(result.stdout ?? '')) throw new Error('The selected runtime did not pass its version check.');
    console.log(`Software System: ${process.platform}-${process.arch}`);
    console.log((result.stdout ?? '').trim());
  } else {
    if (Number(process.versions.node.split('.')[0]) < 22) throw new Error('sudo cli runtime setup requires Node.js 22 or newer.');
    const target = platformRuntime();
    console.log(`Installing Codex ${CODEX_VERSION} for ${target.id} locally.`);
    const controller = new AbortController();
    const stop = () => controller.abort();
    process.once('SIGINT', stop);
    process.once('SIGTERM', stop);
    let last = -1;
    try {
      const result = await installRuntime({
        projectRoot: fileURLToPath(new URL('../', import.meta.url)),
        signal: AbortSignal.any([controller.signal, AbortSignal.timeout(300000)]),
        onProgress(bytes, total) {
          const value = Math.floor(bytes / total * 10) * 10;
          if (value !== last) { last = value; console.log(`Download: ${value}%`); }
        },
      });
      console.log(result.installed ? 'Runtime installed and SHA-256 verified.' : 'The pinned runtime is already installed.');
      console.log('Run node bin/sudo-cli.mjs doctor, then start sudo cli in your terminal.');
    } finally {
      process.removeListener('SIGINT', stop);
      process.removeListener('SIGTERM', stop);
    }
  }
} catch (error) {
  const message = error?.message?.replace(/[\u0000-\u001f\u007f]/g, ' ') || 'Runtime setup failed.';
  console.error(`sudo cli: ${message}`);
  process.exitCode = 1;
}
