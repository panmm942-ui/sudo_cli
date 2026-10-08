import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, readdir, rm, chmod } from 'node:fs/promises';
import { tmpdir } from './fixtures/temp-root.mjs';
import { join } from 'node:path';
import { gzipSync } from 'node:zlib';
import { createHash } from 'node:crypto';
import { Readable } from 'node:stream';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'sudo-platform-test-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  return root;
}

function tar(entries) {
  const blocks = [];
  for (const entry of entries) {
    const body = Buffer.from(entry.body ?? '');
    const header = Buffer.alloc(512);
    header.write(entry.path, 0, 100);
    header.write('0000755\0', 100);
    header.write('0000000\0', 108);
    header.write('0000000\0', 116);
    header.write(body.length.toString(8).padStart(11, '0') + '\0', 124);
    header.write('00000000000\0', 136);
    header.fill(32, 148, 156);
    header.write(entry.type ?? '0', 156);
    header.write('ustar\0', 257);
    const checksum = header.reduce((sum, byte) => sum + byte, 0);
    header.write(checksum.toString(8).padStart(6, '0') + '\0 ', 148);
    blocks.push(header, body, Buffer.alloc((512 - body.length % 512) % 512));
  }
  return Buffer.concat([...blocks, Buffer.alloc(1024)]);
}

test('platform matrix pins official Codex packages for all six supported targets', async () => {
  const { platformRuntime, CODEX_VERSION } = await import('../src/platforms.mjs');
  assert.equal(CODEX_VERSION, '0.160.1');
  for (const platform of ['linux', 'darwin', 'win32']) {
    for (const arch of ['x64', 'arm64']) {
      const target = platformRuntime(platform, arch);
      assert.match(target.id, new RegExp(`${arch}$`));
      assert.match(target.asset, /^codex-package-(x86_64|aarch64)-.*\.tar\.gz$/);
      assert.match(target.sha256, /^[0-9a-f]{64}$/);
      assert.equal(new URL(target.url).hostname, 'github.com');
      assert.ok(target.url.includes('/rust-v0.160.1/'));
      assert.equal(target.executable, platform === 'win32' ? 'codex.exe' : 'codex');
      assert.ok(target.bytes > 0);
    }
  }
  for (const pair of [['freebsd', 'x64'], ['linux', 'ia32'], ['darwin', 'riscv64']]) {
    assert.throws(() => platformRuntime(...pair), /Unsupported/);
  }
});

test('archive extraction preserves package layout and marks executable files', async t => {
  const { extractPackage } = await import('../src/platforms.mjs');
  const root = await fixture(t);
  const archive = tar([
    { path: 'bin/', type: '5' },
    { path: 'bin/codex', body: 'native engine fixture' },
    { path: 'codex-package.json', body: '{"version":"0.160.1"}' },
  ]);
  await extractPackage(Readable.from([archive.subarray(0, 331), archive.subarray(331)]), root);
  assert.equal(await readFile(join(root, 'bin', 'codex'), 'utf8'), 'native engine fixture');
  if (process.platform !== 'win32') {
    const { stat } = await import('node:fs/promises');
    assert.ok((await stat(join(root, 'bin', 'codex'))).mode & 0o100);
  }
});

test('archive extraction rejects traversal, absolute paths, Windows alternate streams and links', async t => {
  const { extractPackage } = await import('../src/platforms.mjs');
  for (const entry of [
    { path: '../outside', body: 'bad' },
    { path: 'bin/../../outside', body: 'bad' },
    { path: '/outside', body: 'bad' },
    { path: 'C:/outside', body: 'bad' },
    { path: 'bin\\outside', body: 'bad' },
    { path: 'bin/codex:stream', body: 'bad' },
    { path: 'bin/link', type: '2' },
    { path: 'bin/link', type: '1' },
  ]) {
    const root = await fixture(t);
    await assert.rejects(extractPackage(Readable.from([tar([entry])]), root), /archive|package/i);
    assert.deepEqual(await readdir(root), []);
  }
});

test('archive extraction rejects truncated files, duplicate entries and checksum corruption', async t => {
  const { extractPackage } = await import('../src/platforms.mjs');
  const valid = tar([{ path: 'bin/codex', body: 'engine' }]);
  const broken = Buffer.from(valid);
  broken[0] = 42;
  const archives = [valid.subarray(0, 514), broken, tar([{ path: 'file', body: 'one' }, { path: 'file', body: 'two' }])];
  for (const archive of archives) {
    const root = await fixture(t);
    await assert.rejects(extractPackage(Readable.from([archive]), root), /archive|package/i);
  }
});

test('download follows approved HTTPS release redirects and verifies bytes before installation', async t => {
  const { downloadVerified } = await import('../src/platforms.mjs');
  const root = await fixture(t);
  const data = gzipSync(tar([{ path: 'bin/codex', body: 'engine' }]));
  const digest = createHash('sha256').update(data).digest('hex');
  const calls = [];
  const fetchImpl = async url => {
    calls.push(String(url));
    if (calls.length === 1) return new Response(null, { status: 302, headers: { location: 'https://release-assets.githubusercontent.com/fixture' } });
    return new Response(data);
  };
  const out = join(root, 'archive.gz');
  await downloadVerified({ url: 'https://github.com/openai/codex/releases/download/rust-v0.160.1/fixture.tar.gz', sha256: digest, bytes: data.length }, out, { fetchImpl });
  assert.deepEqual(await readFile(out), data);
  assert.equal(calls.length, 2);
});

test('failed or corrupted downloads remove their partial file and never replace an existing destination', async t => {
  const { downloadVerified } = await import('../src/platforms.mjs');
  const root = await fixture(t);
  const out = join(root, 'archive.gz');
  const metadata = { url: 'https://github.com/openai/codex/releases/download/rust-v0.160.1/fixture.tar.gz', sha256: '0'.repeat(64), bytes: 3 };
  await assert.rejects(downloadVerified(metadata, out, { fetchImpl: async () => new Response('bad') }), /digest|verification/i);
  assert.deepEqual(await readdir(root), []);
  await writeFile(out, 'keep');
  await assert.rejects(downloadVerified(metadata, out, { fetchImpl: async () => new Response('bad') }));
  assert.equal(await readFile(out, 'utf8'), 'keep');
});

test('download rejects downgrade, untrusted hosts, redirect loops and unexpected size', async t => {
  const { downloadVerified } = await import('../src/platforms.mjs');
  const root = await fixture(t);
  const metadata = { url: 'https://github.com/openai/codex/releases/download/rust-v0.160.1/fixture.tar.gz', sha256: '0'.repeat(64), bytes: 3 };
  for (const location of ['http://github.com/file', 'https://example.com/file', 'https://user:pass@github.com/file']) {
    await assert.rejects(downloadVerified(metadata, join(root, 'archive.gz'), { fetchImpl: async () => new Response(null, { status: 302, headers: { location } }) }), /redirect|URL/i);
  }
  await assert.rejects(downloadVerified(metadata, join(root, 'archive.gz'), { fetchImpl: async () => new Response(null, { status: 302, headers: { location: metadata.url } }) }), /redirect/i);
  await assert.rejects(downloadVerified(metadata, join(root, 'archive.gz'), { fetchImpl: async () => new Response('too long') }), /size|length/i);
  assert.deepEqual(await readdir(root), []);
});

test('local engine selection prefers architecture-specific runtime before legacy bundle', async t => {
  const { localCodex } = await import('../src/local-engine.mjs');
  const root = await fixture(t);
  const name = process.platform === 'win32' ? 'codex.exe' : 'codex';
  const id = `${process.platform}-${process.arch}`;
  const target = join(root, 'runtime', id, 'bin', name);
  await mkdir(join(root, 'runtime', id, 'bin'), { recursive: true });
  await writeFile(target, 'fixture executable');
  await chmod(target, 0o700);
  assert.equal(localCodex({ env: { PATH: '' }, projectRoot: root }), target);
});

test('a Windows legacy x64 runtime is not offered as a native arm64 bundle', async t => {
  const { bundledCandidates } = await import('../src/local-engine.mjs');
  const root = await fixture(t);
  assert.deepEqual(bundledCandidates({ projectRoot: root, platform: 'win32', arch: 'arm64' }), [join(root, 'runtime', 'win32-arm64', 'bin', 'codex.exe')]);
  assert.deepEqual(bundledCandidates({ projectRoot: root, platform: 'darwin', arch: 'arm64' }), [join(root, 'runtime', 'darwin-arm64', 'bin', 'codex'), join(root, 'runtime', 'codex')]);
});

test('archive accepts release packager PAX timestamps but rejects path overrides and trailing payloads', async t => {
  const { extractPackage } = await import('../src/platforms.mjs');
  function pax(record) {
    let size = record.length + 3;
    while (`${size} ${record}\n`.length !== size) size = `${size} ${record}\n`.length;
    return `${size} ${record}\n`;
  }
  const root = await fixture(t);
  await extractPackage(Readable.from([tar([{ path: 'metadata', type: 'x', body: pax('mtime=123.45') }, { path: 'file', body: 'safe' }])]), root);
  assert.equal(await readFile(join(root, 'file'), 'utf8'), 'safe');
  const unsafe = await fixture(t);
  await assert.rejects(extractPackage(Readable.from([tar([{ path: 'metadata', type: 'x', body: pax('path=../escape') }])]), unsafe), /metadata/i);
  const trailing = await fixture(t);
  await assert.rejects(extractPackage(Readable.from([Buffer.concat([tar([{ path: 'file', body: 'safe' }]), Buffer.from('payload')])]), trailing), /trailing/i);
});

test('failed runtime installation cleans only its staging directory and preserves all existing bundles', async t => {
  const { installRuntime } = await import('../src/platforms.mjs');
  const root = await fixture(t);
  await mkdir(join(root, 'runtime'));
  await writeFile(join(root, 'runtime', 'codex.exe'), 'Windows bundle sentinel');
  await assert.rejects(installRuntime({ projectRoot: root, fetchImpl: async () => new Response(null, { status: 503 }) }), /download/i);
  assert.deepEqual(await readdir(join(root, 'runtime')), ['codex.exe']);
  assert.equal(await readFile(join(root, 'runtime', 'codex.exe'), 'utf8'), 'Windows bundle sentinel');
});

test('installer refuses an existing incomplete destination instead of merging or replacing it', async t => {
  const { installRuntime } = await import('../src/platforms.mjs');
  const root = await fixture(t);
  const runtime = join(root, 'runtime', `${process.platform}-${process.arch}`);
  await mkdir(runtime, { recursive: true });
  await writeFile(join(runtime, 'keep.txt'), 'keep');
  let fetched = false;
  await assert.rejects(installRuntime({ projectRoot: root, fetchImpl: async () => { fetched = true; return new Response(''); } }), /metadata|package/i);
  assert.equal(fetched, false);
  assert.deepEqual(await readdir(runtime), ['keep.txt']);
  assert.equal(await readFile(join(runtime, 'keep.txt'), 'utf8'), 'keep');
});

test('installer refuses a concurrent setup and removes only its own lock', async t => {
  const { installRuntime } = await import('../src/platforms.mjs');
  const root = await fixture(t);
  let started;
  const enteredFetch = new Promise(resolve => { started = resolve; });
  let finish;
  const paused = new Promise(resolve => { finish = resolve; });
  const first = installRuntime({ projectRoot: root, fetchImpl: async () => { started(); await paused; return new Response(null, { status: 503 }); } });
  await enteredFetch;
  await assert.rejects(installRuntime({ projectRoot: root }), /already running|lock/i);
  finish();
  await assert.rejects(first, /download/i);
  assert.deepEqual(await readdir(join(root, 'runtime')), []);
});

test('setup help and target selection work without changing configuration or contacting a model', () => {
  const setup = fileURLToPath(new URL('../scripts/setup-runtime.mjs', import.meta.url));
  const help = spawnSync(process.execPath, [setup, '--help'], { encoding: 'utf8', shell: false, windowsHide: true });
  assert.equal(help.status, 0);
  assert.match(help.stdout, /runtime setup/);
  const target = spawnSync(process.execPath, [setup, '--print-target'], { encoding: 'utf8', shell: false, windowsHide: true });
  assert.equal(target.status, 0);
  assert.equal(JSON.parse(target.stdout).id, `${process.platform}-${process.arch}`);
});

test('Unix launcher preserves spaced paths and literal arguments', { skip: process.platform === 'win32' }, async t => {
  const { copyFile } = await import('node:fs/promises');
  const root = await fixture(t);
  const directory = join(root, 'launcher with spaces');
  await mkdir(join(directory, 'bin'), { recursive: true });
  await copyFile(fileURLToPath(new URL('../sudocli', import.meta.url)), join(directory, 'sudocli'));
  await writeFile(join(directory, 'bin', 'sudocli.mjs'), 'console.log(JSON.stringify(process.argv.slice(2)))');
  const args = ['argument with spaces', '$(printf should-not-run)', 'single\'quote', 'semi;colon'];
  const direct = spawnSync('/bin/sh', [join(directory, 'sudocli'), ...args], { encoding: 'utf8', shell: false });
  assert.equal(direct.status, 0);
  assert.deepEqual(JSON.parse(direct.stdout), args);
});
