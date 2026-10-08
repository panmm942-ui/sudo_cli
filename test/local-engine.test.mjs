import test from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';

test('sudo cli selects its bundled engine without requiring ChatGPT app runtime lookup', async (t) => {
  const { localCodex } = await import('../src/local-engine.mjs');
  const expected = fileURLToPath(new URL('../runtime/codex.exe', import.meta.url));
  if (process.platform !== 'win32' || !existsSync(expected)) { t.skip('Windows bundled engine not present in source-only distribution'); return; }
  const result = localCodex({ env: { PATH: '' } });
  if (process.platform === 'win32') assert.equal(result, expected);
  const probe = spawnSync(result, ['--version'], { encoding: 'utf8', shell: false, windowsHide: true });
  assert.equal(probe.status, 0);
  assert.match(probe.stdout, /codex-cli/);
});

test('empty explicit engine overrides are rejected rather than hidden by bundle fallback', async () => {
  const { localCodex } = await import('../src/local-engine.mjs');
  assert.throws(() => localCodex({ env: { SUDO_CLI_CODEX: '', PATH: '' } }), /override/);
});

test('an explicit engine override never silently falls back to the bundled engine', async () => {
  const { localCodex } = await import('../src/local-engine.mjs');
  assert.throws(() => localCodex({ env: { SUDO_CLI_CODEX: 'not-a-real-engine', PATH: '' } }), /override/);
});
