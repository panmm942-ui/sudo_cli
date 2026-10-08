import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm, symlink, realpath } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
async function root(t) {
  // macOS commonly exposes its temporary root through a system symlink. Test
  // the collector against canonical owned paths, not that OS alias.
  const path = await realpath(await mkdtemp(join(tmpdir(), 'codexcli-attachment-test-')));
  t.after(() => rm(path, { recursive: true, force: true }));
  return path;
}
test('collects files with spaces and folders as bounded, attributed untrusted context', async t => {
  const cwd = await root(t);
  await mkdir(join(cwd, 'source'));
  await writeFile(join(cwd, 'source', 'file with spaces.txt'), 'project context');
  const { collectAttachments } = await import('../src/attachments.mjs');
  const result = await collectAttachments(['source'], { cwd });
  assert.equal(result.files.length, 1);
  assert.equal(result.files[0].path, join(cwd, 'source', 'file with spaces.txt'));
  assert.equal(result.inputItems[0].type, 'text');
  assert.deepEqual(result.inputItems[0].text_elements, []);
  assert.match(result.inputItems[0].text, /untrusted/i);
  assert.match(result.inputItems[0].text, /project context/);
  assert.match(result.summary, /1 file/);
});
test('folder traversal excludes secret files, dependency trees and common credential contents', async t => {
  const cwd = await root(t);
  await mkdir(join(cwd, 'node_modules'));
  await mkdir(join(cwd, '.git'));
  await writeFile(join(cwd, 'node_modules', 'module.js'), 'dependency');
  await writeFile(join(cwd, '.git', 'config'), 'private git metadata');
  await writeFile(join(cwd, '.env'), 'API_KEY=private-environment-secret');
  await writeFile(join(cwd, 'credentials.json'), '{"token":"private-credential"}');
  await writeFile(join(cwd, 'settings.txt'), 'api_key = "sk-actual-private-secret-key-123456789012"');
  await writeFile(join(cwd, 'safe.txt'), 'Only safe project data.');
  const { collectAttachments } = await import('../src/attachments.mjs');
  const result = await collectAttachments([cwd], { cwd });
  assert.deepEqual(result.files.map(file => file.path), [join(cwd, 'safe.txt')]);
  assert.ok(result.warnings.length >= 5);
  const body = JSON.stringify(result);
  for (const secret of ['private-environment-secret', 'private-credential', 'actual-private-secret-key']) assert.ok(!body.includes(secret));
});
test('explicit secret files remain excluded, binary files and invalid UTF-8 receive warnings', async t => {
  const cwd = await root(t);
  await writeFile(join(cwd, '.env.example'), 'sample');
  await writeFile(join(cwd, 'file.bin'), Buffer.from([0, 1, 2, 3]));
  await writeFile(join(cwd, 'file.txt'), Buffer.from([0xc3, 0x28]));
  const { collectAttachments } = await import('../src/attachments.mjs');
  const result = await collectAttachments(['.env.example', 'file.bin', 'file.txt'], { cwd });
  assert.equal(result.inputItems.length, 0);
  assert.equal(result.warnings.length, 3);
});
test('file and byte limits exclude complete files and report every omitted item', async t => {
  const cwd = await root(t);
  await writeFile(join(cwd, 'large.txt'), 'large content exceeds budget');
  await writeFile(join(cwd, 'small.txt'), 'ok');
  const { collectAttachments } = await import('../src/attachments.mjs');
  const byteLimit = await collectAttachments(['large.txt', 'small.txt'], { cwd, maxBytes: 5 });
  assert.deepEqual(byteLimit.files.map(file => file.path), [join(cwd, 'small.txt')]);
  assert.match(byteLimit.warnings[0].reason, /limit|budget|large/i);
  const countLimit = await collectAttachments(['small.txt', 'large.txt'], { cwd, maxFiles: 1 });
  assert.equal(countLimit.files.length, 1);
  assert.equal(countLimit.warnings.length, 1);
});
test('images are validated and captured as data URIs; fake image extensions are not accepted', async t => {
  const cwd = await root(t);
  const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aWQAAAABJRU5ErkJggg==', 'base64');
  await writeFile(join(cwd, 'image.png'), png);
  await writeFile(join(cwd, 'fake.png'), 'not a PNG');
  const { collectAttachments } = await import('../src/attachments.mjs');
  const result = await collectAttachments(['image.png', 'fake.png'], { cwd });
  assert.equal(result.files.length, 1);
  const image = result.inputItems.find(item => item.type === 'image');
  assert.equal(image.url, `data:image/png;base64,${png.toString('base64')}`);
  assert.equal(result.warnings.length, 1);
});
test('duplicates, missing paths and unsupported selections are explicit and never queued twice', async t => {
  const cwd = await root(t);
  await writeFile(join(cwd, 'file.txt'), 'context');
  const { collectAttachments } = await import('../src/attachments.mjs');
  const result = await collectAttachments(['file.txt', join(cwd, 'file.txt'), 'missing.txt'], { cwd });
  assert.equal(result.files.length, 1);
  assert.equal(result.warnings.length, 2);
});
test('symbolic links and paths through a symbolic link are excluded', { skip: process.platform === 'win32' }, async t => {
  const cwd = await root(t);
  const outside = await root(t);
  await writeFile(join(outside, 'outside.txt'), 'must not enter queued context');
  await symlink(outside, join(cwd, 'linked'));
  const { collectAttachments } = await import('../src/attachments.mjs');
  for (const selected of [cwd, join(cwd, 'linked', 'outside.txt')]) {
    const result = await collectAttachments([selected], { cwd });
    assert.equal(result.files.length, 0);
    assert.ok(result.warnings.some(warning => /link/i.test(warning.reason)));
  }
});

test('explicit children of credential/dependency folders and unquoted credential assignments are excluded', async t => {
  const cwd = await root(t);
  await mkdir(join(cwd, '.ssh'));
  await writeFile(join(cwd, '.ssh', 'config'), 'user account data');
  await writeFile(join(cwd, 'local-settings.txt'), 'API_KEY=private-local-key-value-0123456789');
  const { collectAttachments } = await import('../src/attachments.mjs');
  const result = await collectAttachments(['.ssh/config', 'local-settings.txt'], { cwd });
  assert.equal(result.files.length, 0);
  assert.equal(result.warnings.length, 2);
  assert.ok(!JSON.stringify(result).includes('private-local-key-value'));
});
test('unsupported document formats and bounded directory traversal give explicit exclusions', async t => {
  const cwd = await root(t);
  await writeFile(join(cwd, 'document.pdf'), '%PDF-1.7 raw bytes are not extracted text');
  await mkdir(join(cwd, 'one'));
  await mkdir(join(cwd, 'one', 'two'));
  await writeFile(join(cwd, 'one', 'two', 'safe.txt'), 'deep file');
  const { collectAttachments } = await import('../src/attachments.mjs');
  const documents = await collectAttachments(['document.pdf'], { cwd });
  assert.match(documents.warnings[0].reason, /Unsupported/);
  const depth = await collectAttachments(['one'], { cwd, maxDepth: 1 });
  assert.equal(depth.files.length, 0);
  assert.ok(depth.warnings.some(warning => /depth limit/.test(warning.reason)));
});

test('explicit child selections cannot bypass exclusion of secret-named directories', async t => {
  const cwd = await root(t);
  await mkdir(join(cwd, '.env.local'));
  await writeFile(join(cwd, '.env.local', 'details.txt'), 'private environment material');
  await mkdir(join(cwd, 'secrets'));
  await writeFile(join(cwd, 'secrets', 'details.txt'), 'private secret material');
  const { collectAttachments } = await import('../src/attachments.mjs');
  const result = await collectAttachments(['.env.local/details.txt', 'secrets/details.txt'], { cwd });
  assert.equal(result.files.length, 0);
  assert.equal(result.warnings.length, 2);
  assert.ok(!JSON.stringify(result).includes('private environment material'));
});
