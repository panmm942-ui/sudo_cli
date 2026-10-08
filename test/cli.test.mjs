import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const cli = fileURLToPath(new URL('../bin/sudocli.mjs', import.meta.url));
const run = (args, env = {}) => spawnSync(process.execPath, [cli, ...args], {
  encoding: 'utf8', env: { ...process.env, NO_COLOR: '1', ...env }, timeout: 10000,
});

test('branded help works without connecting a model or modifying app settings', () => {
  const result = run(['--help'], { SUDO_CLI_CODEX: 'missing-runtime' });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /sudo cli/);
  assert.match(result.stdout, /--base-url/);
  assert.match(result.stdout, /--once/);
});

test('version works with no runtime installed', () => {
  const result = run(['--version'], { SUDO_CLI_CODEX: 'missing-runtime' });
  assert.equal(result.status, 0);
  assert.match(result.stdout, /0\.4\.0/);
});

test('missing settings in noninteractive mode are actionable and do not initiate a model request', () => {
  const result = run(['--once', 'hello']);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /--model.*--base-url|interactive terminal/);
});

test('unknown options fail rather than silently turning into a prompt', () => {
  const result = run(['--base-urll', 'https://example.test/v1']);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /Unknown option/);
});

test('keys embedded in URLs never appear in validation errors', () => {
  const result = run(['--once', 'hello', '--model', 'future-model', '--base-url', 'https://secretvalue@example.test/v1']);
  assert.equal(result.status, 1);
  assert.doesNotMatch(result.stdout + result.stderr, /secretvalue/);
});

test('missing key environment variable is named without leaking other variables', () => {
  const result = run(['--once', 'hello', '--model', 'future-model', '--base-url', 'https://example.test/v1', '--api-key-env', 'SUDO_TEST_MISSING_KEY'], { SUDO_TEST_MISSING_KEY: '' });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /SUDO_TEST_MISSING_KEY/);
});

test('doctor reports missing engine without connecting or exposing environment secrets', () => {
  const result = run(['doctor'], { SUDO_CLI_CODEX: 'missing-runtime', SUDO_CLI_API_KEY: 'never-print-this' });
  assert.equal(result.status, 1);
  assert.match(result.stdout + result.stderr, /engine|Codex/i);
  assert.doesNotMatch(result.stdout + result.stderr, /never-print-this/);
});

test('piped launch prints the ASCII art and exits without initializing an engine', () => {
  const result = run([], { SUDO_CLI_CODEX: 'missing-runtime' });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /____/);
  assert.doesNotMatch(result.stdout, /\x1b|API key|\?/);
});

test('permissions and web flags reject invalid values with actionable errors', () => {
  for (const [flag, value] of [['--permissions', 'always'], ['--web', 'maybe']]) {
    const result = run([flag, value]);
    assert.equal(result.status, 1);
    assert.match(result.stderr, /Use --permissions|Use --web/);
  }
});

test('reasoning flag validates before connecting or saving state', () => {
  const result=run(['--effort','invented-level']);
  assert.equal(result.status,1);assert.match(result.stderr,/effort|reasoning/i);
});
