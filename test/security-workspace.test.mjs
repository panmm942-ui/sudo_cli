import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from './fixtures/temp-root.mjs';
import { join } from 'node:path';

async function fixture(t) {
  const cwd = await mkdtemp(join(tmpdir(), 'codexcli-security-test-')); t.after(() => rm(cwd, { recursive: true, force: true }));
  return { cwd, ...await import('../src/security-workspace.mjs') };
}
test('defensive local scan reports credential/source/dependency heuristics without disclosing credential values', async t => {
  const { cwd, scanWorkspace } = await fixture(t);
  const token = 'sk-abcdefghijklmnopqrstuv012345';
  await writeFile(join(cwd, 'unsafe.mjs'), `const apiKey="${token}";\nconst result=eval(userInput);\nexec(userCommand);\n`);
  await writeFile(join(cwd, 'package.json'), JSON.stringify({ dependencies: { unsafe: '*', remote: 'http://example.test/archive.tgz' } }));
  await writeFile(join(cwd, '.env'), `API_KEY=${token}`);
  const result = await scanWorkspace({ cwd });
  assert.equal(result.defensive, true); assert.equal(result.verified, false);
  assert.ok(result.findings.some(item => item.category === 'secrets'));
  assert.ok(result.findings.some(item => item.category === 'source'));
  assert.ok(result.findings.some(item => item.category === 'dependencies'));
  assert.ok(!JSON.stringify(result).includes(token)); assert.ok(!result.findings.some(item => item.path === '.env'));
});
test('scan bounds file bytes and marks partial coverage rather than claiming a clean audit', async t => {
  const { cwd, scanWorkspace } = await fixture(t);
  await writeFile(join(cwd, 'large.js'), 'x'.repeat(1000));
  const result = await scanWorkspace({ cwd, maxFileBytes: 32 });
  assert.equal(result.partial, true); assert.equal(result.filesScanned, 0); assert.equal(result.findings.length, 0);
});
test('approved security target creates an isolated local source lab and rejects escape/secret/unapproved paths', async t => {
  const { cwd, resolveSecurityTarget, createSecurityLab } = await fixture(t);
  await mkdir(join(cwd, 'src')); await writeFile(join(cwd, 'src', 'app.js'), 'const result=eval(input);'); await writeFile(join(cwd, '.env'), 'SECRET=private');
  await assert.rejects(resolveSecurityTarget({ cwd, path: 'src' }), /approv/i);
  for (const path of ['../outside', '.env', 'https://example.test', '/absolute']) await assert.rejects(resolveSecurityTarget({ cwd, path, approved: true }));
  const target = await resolveSecurityTarget({ cwd, path: 'src', approved: true });
  const lab = await createSecurityLab({ target });
  assert.notEqual(lab.cwd, cwd); assert.equal(await readFile(join(lab.cwd, 'app.js'), 'utf8'), 'const result=eval(input);');
  await lab.cleanup(); assert.equal(await readFile(join(cwd, 'src', 'app.js'), 'utf8'), 'const result=eval(input);');
});
test('local scan cancellation does not inspect further files', async t => {
  const { cwd, scanWorkspace } = await fixture(t); const controller = new AbortController(); controller.abort();
  await assert.rejects(scanWorkspace({ cwd, signal: controller.signal }), { name: 'AbortError' });
});

test('security omissions and model source filenames do not expose known credentials', async t => {
  const { cwd, scanWorkspace } = await fixture(t); const token = 'opaque-private-key-fixture';
  await writeFile(join(cwd, `${token}.js`), 'x'.repeat(200));
  const result = await scanWorkspace({ cwd, maxFileBytes: 32, secrets: () => [token] });
  assert.ok(!JSON.stringify(result).includes(token));
  const { createWorkspaceSnapshot } = await import('../src/workspace-tools.mjs');
  const snapshot = await createWorkspaceSnapshot({ cwd, secrets: () => [token] });
  assert.equal(snapshot.files.length, 0); assert.equal(snapshot.partial, true); await snapshot.cleanup();
});
