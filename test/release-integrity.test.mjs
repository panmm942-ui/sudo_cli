import test from 'node:test';
import assert from 'node:assert/strict';
import {generateKeyPairSync, sign, createHash} from 'node:crypto';
import {mkdtemp, mkdir, writeFile, readFile, rm, unlink, link, symlink, lstat, readdir} from 'node:fs/promises';
import {tmpdir} from './fixtures/temp-root.mjs';
import {join, dirname} from 'node:path';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';

const version = '0.6.4';
const required = ['package.json', 'bin/sudocli.mjs', 'src/cli.mjs', 'src/setup-cli.mjs', 'src/setup-runtime-cli.mjs', 'src/ui.mjs', 'src/version.mjs', 'src/platforms.mjs', 'src/release-integrity.mjs', 'src/release-public-key.mjs', 'scripts/setup.mjs', 'scripts/setup-runtime.mjs', 'README.md', 'LICENSE', 'THIRD_PARTY.md', 'licenses/CODEX-APACHE-2.0.txt', 'licenses/CODEX-NOTICE.txt', 'licenses/NODE-LICENSE.txt', 'sudocli', 'sudocli.cmd', 'setup', 'setup.cmd'];
const publicPem = key => key.export({type:'spki', format:'pem'});
const privatePem = key => key.export({type:'pkcs8', format:'pem'});
const keyId = key => createHash('sha256').update(key.export({type:'spki', format:'der'})).digest('hex');
const module = () => import('../src/release-integrity.mjs');

async function fixture(t) {
  const directory = await mkdtemp(join(tmpdir(), 'codexcli-integrity-'));
  t.after(() => rm(directory, {recursive:true, force:true}));
  const root = join(directory, 'release'), privateKeyPath = join(directory, 'publisher-key.pem');
  const keys = generateKeyPairSync('ed25519');
  for (const path of [...required, '.github/workflows/test.yml', 'test/example.test.mjs', 'upstream/source.zip', '.gitignore']) {
    await mkdir(dirname(join(root,path)), {recursive:true});
    await writeFile(join(root,path), path === 'package.json' ? JSON.stringify({name:'codexcli', version, type:'module'}) : path === 'README.md' ? 'Credits: OpenAI Codex; publisher: fixture.\n' : `fixture ${path}\n`);
  }
  await writeFile(privateKeyPath, privatePem(keys.privateKey), {mode:0o600});
  const api = await module();
  return {directory, root, privateKeyPath, keys, publicKey:publicPem(keys.publicKey), ...api};
}

async function signed(t) {
  const value = await fixture(t);
  await value.createSignedReleaseManifest({...value, expectedVersion:version});
  return value;
}

async function rewriteManifest(value, mutate, {canonical = true, privateKey = value.keys.privateKey} = {}) {
  const manifest = JSON.parse(await readFile(join(value.root, 'release-integrity.json'), 'utf8'));
  mutate(manifest);
  const bytes = Buffer.from(JSON.stringify(manifest, null, canonical ? undefined : 2) + '\n');
  await writeFile(join(value.root, 'release-integrity.json'), bytes);
  await writeFile(join(value.root, 'release-integrity.sig'), sign(null, bytes, privateKey));
}

test('a signed release verifies every distributed source file and returns authenticated version', async t => {
  const value = await signed(t);
  const receipt = await value.verifyReleaseIntegrity({...value, expectedVersion:version});
  assert.equal(receipt.version, version);
  assert.equal(receipt.files, required.length + 4);
  assert.equal(receipt.keyId, keyId(value.keys.publicKey));
  assert.match(receipt.sha256, /^[a-f0-9]{64}$/);
  const manifest = JSON.parse(await readFile(join(value.root, 'release-integrity.json'), 'utf8'));
  assert.deepEqual(manifest.files.find(file => file.path === 'README.md'), {path:'README.md', bytes:43, sha256:createHash('sha256').update('Credits: OpenAI Codex; publisher: fixture.\n').digest('hex')});
  assert.equal((await readFile(join(value.root, 'release-integrity.sig'))).length,64);
});

test('changed credits and changed source fail before a release receipt is produced', async t => {
  const value = await signed(t);
  for (const path of ['README.md', 'src/ui.mjs']) {
    const original = await readFile(join(value.root,path));
    await writeFile(join(value.root,path), 'changed credits or source');
    await assert.rejects(value.verifyReleaseIntegrity({...value, expectedVersion:version}), /integrity|hash|changed/i);
    await writeFile(join(value.root,path), original);
  }
});

test('added and removed source files invalidate the exact signed inventory', async t => {
  const value = await signed(t), added = join(value.root,'src','injected.mjs');
  await writeFile(added,'throw new Error("injected")');
  await assert.rejects(value.verifyReleaseIntegrity({...value,expectedVersion:version}), /inventory|unsigned|unexpected/i);
  await unlink(added);
  await unlink(join(value.root,'test','example.test.mjs'));
  await assert.rejects(value.verifyReleaseIntegrity({...value,expectedVersion:version}), /inventory|missing/i);
});

test('missing and corrupt signatures or manifests refuse verification', async t => {
  const value = await signed(t), manifestPath = join(value.root,'release-integrity.json'), signaturePath = join(value.root,'release-integrity.sig');
  const manifestBytes = await readFile(manifestPath), signatureBytes = await readFile(signaturePath);
  await unlink(manifestPath);
  await assert.rejects(value.verifyReleaseIntegrity({...value,expectedVersion:version}), /manifest|integrity/i);
  await writeFile(manifestPath,manifestBytes);
  await unlink(signaturePath);
  await assert.rejects(value.verifyReleaseIntegrity({...value,expectedVersion:version}), /signature|integrity/i);
  await writeFile(signaturePath,Buffer.alloc(64));
  await assert.rejects(value.verifyReleaseIntegrity({...value,expectedVersion:version}), /signature/i);
  await writeFile(signaturePath,signatureBytes);
  await writeFile(manifestPath,Buffer.from(manifestBytes.toString().replace('0.6.4','0.6.5')));
  await assert.rejects(value.verifyReleaseIntegrity({...value,expectedVersion:version}), /signature/i);
});

test('a different publisher key or expected version cannot authenticate a release', async t => {
  const value = await signed(t), other = generateKeyPairSync('ed25519');
  await assert.rejects(value.verifyReleaseIntegrity({...value,publicKey:publicPem(other.publicKey),expectedVersion:version}), /signature|key/i);
  await assert.rejects(value.verifyReleaseIntegrity({...value,expectedVersion:'0.6.5'}), /version/i);
  await assert.rejects(value.verifyReleaseIntegrity({...value,expectedVersion:undefined}), /version/i);
  await rewriteManifest(value, manifest => {manifest.version='0.6.5';});
  await assert.rejects(value.verifyReleaseIntegrity({...value,expectedVersion:version}), /version/i);
});

test('authenticated but unsafe paths, duplicate paths and noncanonical JSON are rejected', async t => {
  for (const path of ['../outside.mjs', 'src/../outside.mjs', 'src\\outside.mjs', '/outside.mjs', 'src/nul.mjs', 'src/bad. ', 'runtime/injected.mjs']) {
    const value = await signed(t);
    await rewriteManifest(value,manifest => {manifest.files[0].path=path;});
    await assert.rejects(value.verifyReleaseIntegrity({...value,expectedVersion:version}), /path|inventory|manifest/i);
  }
  const duplicate = await signed(t);
  await rewriteManifest(duplicate,manifest => {manifest.files[1].path=manifest.files[0].path;});
  await assert.rejects(duplicate.verifyReleaseIntegrity({...duplicate,expectedVersion:version}), /duplicate|order|manifest/i);
  const noncanonical = await signed(t);
  await rewriteManifest(noncanonical,() => {},{canonical:false});
  await assert.rejects(noncanonical.verifyReleaseIntegrity({...noncanonical,expectedVersion:version}), /canonical/i);
});

test('metadata bounds and required attribution files are enforced even for a valid signature', async t => {
  for (const mutate of [manifest=>{manifest.files[0].bytes=-1;},manifest=>{manifest.files[0].bytes=129*1024*1024;},manifest=>{manifest.files[0].sha256='f'.repeat(63);},manifest=>{manifest.unknown=true;},manifest=>{manifest.files[0].unknown=true;},manifest=>{manifest.files=Array(10001).fill(manifest.files[0]);},manifest=>{manifest.files=manifest.files.filter(file=>file.path!=='LICENSE');}]) {
    const value = await signed(t);
    await rewriteManifest(value,mutate);
    await assert.rejects(value.verifyReleaseIntegrity({...value,expectedVersion:version}), /manifest|bound|required|license/i);
  }
  const value = await signed(t);
  await writeFile(join(value.root,'release-integrity.json'),Buffer.alloc(4*1024*1024+1));
  await assert.rejects(value.verifyReleaseIntegrity({...value,expectedVersion:version}), /bound|manifest/i);
});

test('source symlinks, hardlinks and directory links are refused', async t => {
  const value = await signed(t), target = join(value.root,'src','ui.mjs');
  const contents = await readFile(target), outside = join(value.directory,'outside.mjs');
  await writeFile(outside,contents);
  await unlink(target);
  await link(outside,target);
  await assert.rejects(value.verifyReleaseIntegrity({...value,expectedVersion:version}), /link|regular/i);
  await unlink(target);
  await writeFile(target,contents);
  const directoryLink = join(value.root,'src','linked');
  await symlink(join(value.root,'docs'),directoryLink,process.platform==='win32'?'junction':'dir');
  await assert.rejects(value.verifyReleaseIntegrity({...value,expectedVersion:version}), /link|real director/i);
  await unlink(directoryLink);
  try { await unlink(target); await symlink(outside,target,'file'); }
  catch (error) { if (['EPERM','EACCES','ENOTSUP'].includes(error.code)) { t.diagnostic('file symlink needs an OS capability unavailable here'); return; } throw error; }
  await assert.rejects(value.verifyReleaseIntegrity({...value,expectedVersion:version}), /link|regular/i);
});

test('runtime files do not enter the source manifest while unknown source directories fail', async t => {
  const value = await signed(t);
  await mkdir(join(value.root,'runtime','new-platform'),{recursive:true});
  await writeFile(join(value.root,'runtime','new-platform','native.exe'),'pinned runtime is verified separately');
  await mkdir(join(value.root,'test','__pycache__'),{recursive:true});
  await writeFile(join(value.root,'test','__pycache__','example.cpython-314.pyc'),'generated Python cache');
  await writeFile(join(value.root,'test','example.pyo'),'generated Python cache');
  assert.equal((await value.verifyReleaseIntegrity({...value,expectedVersion:version})).version,version);
  await mkdir(join(value.root,'injected-source'));
  await writeFile(join(value.root,'injected-source','entry.mjs'),'injected');
  await assert.rejects(value.verifyReleaseIntegrity({...value,expectedVersion:version}), /directory|inventory|unexpected/i);
});

test('directories disguised as Python cache files cannot hide added executable source', async t => {
  const value=await signed(t), hidden=join(value.root,'src','injected.pyc');
  await mkdir(hidden);
  await writeFile(join(hidden,'entry.mjs'),'injected executable source');
  await assert.rejects(value.verifyReleaseIntegrity({...value,expectedVersion:version}), error=>error.code==='RELEASE_INTEGRITY_FAILED');
});

test('signature, source depth and source file sizes remain strictly bounded', async t => {
  const value=await signed(t), signature=join(value.root,'release-integrity.sig');
  const original=await readFile(signature);
  await writeFile(signature,Buffer.concat([original,Buffer.from('extra')]));
  await assert.rejects(value.verifyReleaseIntegrity({...value,expectedVersion:version}), /signature|bound/i);
  await writeFile(signature,original);
  const deep=join(value.root,'src',...Array(32).fill('nested'));
  await mkdir(deep,{recursive:true});
  await writeFile(join(deep,'entry.mjs'),'deep injected source');
  await assert.rejects(value.verifyReleaseIntegrity({...value,expectedVersion:version}), /depth|bound|path/i);
  const large=await fixture(t), path=join(large.root,'upstream','huge.zip');
  const file=await (await import('node:fs/promises')).open(path,'wx');
  try {await file.truncate(128*1024*1024+1);} finally {await file.close();}
  await assert.rejects(large.createSignedReleaseManifest({...large,expectedVersion:version}), /bound/i);
  assert.equal((await readdir(large.root)).includes('release-integrity.json'),false);
});

test('signing refuses source that contains a private key or credential filename', async t => {
  const value=await fixture(t);
  await mkdir(join(value.root,'docs'));
  await writeFile(join(value.root,'docs','publisher-copy.txt'),privatePem(value.keys.privateKey));
  await assert.rejects(value.createSignedReleaseManifest({...value,expectedVersion:version}), /private key material/i);
  await unlink(join(value.root,'docs','publisher-copy.txt'));
  await writeFile(join(value.root,'.env'),'TOKEN=fixture');
  await assert.rejects(value.createSignedReleaseManifest({...value,expectedVersion:version}), /credential|private key/i);
  assert.equal((await readdir(value.root)).includes('release-integrity.json'),false);
});

test('signing refuses private keys in the release and a package version disagreement', async t => {
  const value = await fixture(t), inRelease=join(value.root,'publisher-key.pem');
  await writeFile(inRelease,privatePem(value.keys.privateKey));
  await assert.rejects(value.createSignedReleaseManifest({...value,privateKeyPath:inRelease,expectedVersion:version}), /private key|outside/i);
  await unlink(inRelease);
  await assert.rejects(value.createSignedReleaseManifest({...value,expectedVersion:'0.6.5'}), /version/i);
  assert.equal((await readdir(value.root)).includes('release-integrity.json'),false);
});

test('the signing CLI creates a key only at the explicit external path and never prints key material', async t => {
  const value = await fixture(t), generated = join(value.directory,'generated-key.pem');
  const signer = new URL('../scripts/sign-release.mjs',import.meta.url);
  let result = spawnSync(process.execPath,[fileURLToPath(signer),'--generate-key',generated],{encoding:'utf8'});
  assert.equal(result.status,0,result.stderr);
  assert.equal((await lstat(generated)).isFile(),true);
  assert.doesNotMatch(result.stdout+result.stderr,/-----BEGIN .*KEY-----|MC[0-9a-z+/]{20}/i);
  result = spawnSync(process.execPath,[fileURLToPath(signer),'--generate-key',generated],{encoding:'utf8'});
  assert.notEqual(result.status,0);
  result = spawnSync(process.execPath,[fileURLToPath(signer),'--root',value.root,'--version',version,'--key',generated],{encoding:'utf8'});
  assert.equal(result.status,0,result.stderr);
  const generatedKey = (await import('node:crypto')).createPrivateKey(await readFile(generated));
  assert.equal((await value.verifyReleaseIntegrity({...value,expectedVersion:version,publicKey:publicPem((await import('node:crypto')).createPublicKey(generatedKey))})).version,version);
  assert.doesNotMatch(result.stdout+result.stderr,/-----BEGIN .*KEY-----|MC[0-9a-z+/]{20}/i);
});
