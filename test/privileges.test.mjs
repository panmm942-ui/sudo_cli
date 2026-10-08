import test from 'node:test';
import assert from 'node:assert/strict';

test('Unix launch accepts only an effective root UID and never group membership', async () => {
  const { isElevated } = await import('../src/privileges.mjs');
  for (const platform of ['linux', 'darwin']) {
    assert.equal(await isElevated({ platform, geteuid: () => 0 }), true);
    for (const value of [1000, '0', undefined, NaN, -1]) assert.equal(await isElevated({ platform, geteuid: () => value }), false);
  }
});

test('missing, failing or unsupported privilege detection fails closed', async () => {
  const { isElevated } = await import('../src/privileges.mjs');
  assert.equal(await isElevated({ platform: 'linux', geteuid: undefined }), false);
  assert.equal(await isElevated({ platform: 'darwin', geteuid: () => { throw new Error('denied'); } }), false);
  assert.equal(await isElevated({ platform: 'unknown', geteuid: () => 0 }), false);
});

test('Windows verifies the elevated administrator token through hidden shell-free PowerShell', async () => {
  const { isElevated } = await import('../src/privileges.mjs');
  const probe = async (executable, args, options) => {
    assert.match(executable, /WindowsPowerShell[\\/]v1\.0[\\/]powershell\.exe$/i);
    assert.ok(args.includes('-NoProfile') && args.includes('-NonInteractive'));
    assert.match(args.at(-1), /WindowsPrincipal/);
    assert.match(args.at(-1), /IsInRole/);
    assert.equal(options.shell, false);
    assert.equal(options.windowsHide, true);
    assert.ok(options.timeout > 0 && options.timeout <= 10000);
    return { stdout: 'True\r\n' };
  };
  assert.equal(await isElevated({ platform: 'win32', probe }), true);
});

test('Windows standard or ambiguous token results never grant elevated launch', async () => {
  const { isElevated } = await import('../src/privileges.mjs');
  for (const stdout of ['False\r\n', '', 'True\nFalse', 'administrator', '1', 'True extra']) assert.equal(await isElevated({ platform: 'win32', probe: async () => ({ stdout }) }), false);
  assert.equal(await isElevated({ platform: 'win32', probe: async () => { throw new Error('cannot inspect private-token'); } }), false);
});

test('an unresponsive Windows privilege probe is bounded and fails closed', async () => {
  const { isElevated } = await import('../src/privileges.mjs');
  const started = performance.now();
  assert.equal(await isElevated({ platform: 'win32', timeoutMs: 20, probe: async () => new Promise(() => {}) }), false);
  assert.ok(performance.now() - started < 2000);
});

test('requireElevated gives actionable platform-specific instructions without escalation', async () => {
  const { requireElevated } = await import('../src/privileges.mjs');
  for (const platform of ['linux', 'darwin']) await assert.rejects(requireElevated({ platform, geteuid: () => 1000 }), error => error.code === 'ELEVATION_REQUIRED' && /sudo sudocli/.test(error.message));
  await assert.rejects(requireElevated({ platform: 'win32', probe: async () => ({ stdout: 'False' }) }), error => error.code === 'ELEVATION_REQUIRED' && /Run.*Administrator/i.test(error.message));
  assert.equal(await requireElevated({ platform: 'linux', geteuid: () => 0 }), true);
});

test('the actual local privilege probe returns a boolean without changing process privileges', async () => {
  const { isElevated } = await import('../src/privileges.mjs');
  const before = process.geteuid?.();
  const elevated = await isElevated();
  assert.equal(typeof elevated, 'boolean');
  if (process.platform !== 'win32') assert.equal(elevated, before === 0);
  assert.equal(process.geteuid?.(), before);
});
