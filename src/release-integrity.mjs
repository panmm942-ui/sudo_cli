import {createHash, createPrivateKey, createPublicKey, sign, verify, randomUUID} from 'node:crypto';
import {constants} from 'node:fs';
import {lstat, open, readdir, realpath, rename, unlink} from 'node:fs/promises';
import {dirname, isAbsolute, join, relative, resolve, sep} from 'node:path';
import {RELEASE_PUBLIC_KEY} from './release-public-key.mjs';

export const RELEASE_MANIFEST_FILE = 'release-integrity.json';
export const RELEASE_SIGNATURE_FILE = 'release-integrity.sig';
export const RELEASE_INTEGRITY_LIMITS = Object.freeze({manifestBytes:4*1024*1024, files:10000, pathLength:1024, depth:32, fileBytes:128*1024*1024, totalBytes:256*1024*1024});
export const REQUIRED_RELEASE_FILES = Object.freeze(['package.json', 'bin/sudocli.mjs', 'src/cli.mjs', 'src/setup-cli.mjs', 'src/setup-runtime-cli.mjs', 'src/ui.mjs', 'src/version.mjs', 'src/platforms.mjs', 'src/release-integrity.mjs', 'src/release-public-key.mjs', 'scripts/setup.mjs', 'scripts/setup-runtime.mjs', 'README.md', 'LICENSE', 'THIRD_PARTY.md', 'licenses/CODEX-APACHE-2.0.txt', 'licenses/CODEX-NOTICE.txt', 'licenses/NODE-LICENSE.txt', 'sudocli', 'sudocli.cmd', 'setup', 'setup.cmd']);
const sourceDirectories = new Set(['.github', 'bin', 'src', 'scripts', 'docs', 'test', 'tests', 'licenses', 'upstream']);
const excludedDirectories = new Set(['runtime', '.git', 'node_modules']);
const metadataFiles = new Set([RELEASE_MANIFEST_FILE, RELEASE_SIGNATURE_FILE]);
const semver = /^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)$/;
const hexHash = /^[a-f0-9]{64}$/;
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const cacheFile = name => /\.(?:pyc|pyo)$/.test(name);

function failure(message, cause) {
  const error = new Error('Release integrity: ' + message, cause ? {cause} : undefined);
  error.code = 'RELEASE_INTEGRITY_FAILED';
  return error;
}
function version(value) {
  if (typeof value !== 'string' || value.length > 64 || !semver.test(value)) throw failure('expected version is invalid or missing.');
  return value;
}
function samePath(left, right) {
  return process.platform === 'win32' ? left.toLowerCase() === right.toLowerCase() : left === right;
}
function inside(root, path) {
  const name = relative(resolve(root), resolve(path));
  return name === '' || name !== '..' && !name.startsWith('..' + sep) && !isAbsolute(name);
}
function validPath(name) {
  if (typeof name !== 'string' || !name || name.length > RELEASE_INTEGRITY_LIMITS.pathLength || name.normalize('NFC') !== name || /[\\:\u0000-\u001f\u007f]/.test(name)) throw failure('manifest path is unsafe.');
  const parts = name.split('/');
  if (parts.length > RELEASE_INTEGRITY_LIMITS.depth || parts.some(part => !part || part === '.' || part === '..' || /[. ]$/.test(part) || /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(part))) throw failure('manifest path is unsafe.');
  if (parts.length > 1 && !sourceDirectories.has(parts[0]) || parts.length === 1 && (metadataFiles.has(name) || excludedDirectories.has(name)) || parts.some(part => part === '__pycache__') || cacheFile(parts.at(-1))) throw failure('manifest path is outside the signed source inventory.');
  return name;
}
function exactFields(object, keys, label) {
  if (!object || typeof object !== 'object' || Array.isArray(object) || Object.keys(object).length !== keys.length || keys.some(key => !Object.hasOwn(object,key))) throw failure(label + ' schema is invalid.');
}
function publicKeyObject(value) {
  let key;
  try { key = value?.type === 'public' ? value : createPublicKey(value); } catch (error) { throw failure('publisher public key is invalid.',error); }
  if (key.asymmetricKeyType !== 'ed25519') throw failure('publisher public key must use Ed25519.');
  return key;
}
export function releasePublicKeyId(publicKey = RELEASE_PUBLIC_KEY) {
  return hash(publicKeyObject(publicKey).export({type:'spki',format:'der'}));
}
function canonicalManifest(manifest) {
  return Buffer.from(JSON.stringify({format:manifest.format, schemaVersion:manifest.schemaVersion, version:manifest.version, algorithm:manifest.algorithm, digest:manifest.digest, keyId:manifest.keyId, files:manifest.files.map(file=>({path:file.path,bytes:file.bytes,sha256:file.sha256}))}) + '\n');
}

// Authenticate the exact bytes before parsing any attacker-controlled manifest fields.
export function validateSignedReleaseManifest({manifestBytes, signatureBytes, expectedVersion, publicKey = RELEASE_PUBLIC_KEY} = {}) {
  version(expectedVersion);
  if (!Buffer.isBuffer(manifestBytes) || !manifestBytes.length || manifestBytes.length > RELEASE_INTEGRITY_LIMITS.manifestBytes) throw failure('manifest exceeds its bounds or is missing.');
  if (!Buffer.isBuffer(signatureBytes) || signatureBytes.length !== 64) throw failure('detached signature must contain exactly 64 bytes.');
  const key = publicKeyObject(publicKey);
  if (!verify(null,manifestBytes,key,signatureBytes)) throw failure('publisher signature is invalid.');
  let manifest;
  try { manifest = JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(manifestBytes)); } catch (error) { throw failure('manifest is not valid UTF-8 JSON.',error); }
  exactFields(manifest,['format','schemaVersion','version','algorithm','digest','keyId','files'],'Manifest');
  if (manifest.format !== 'codexcli-release-integrity' || manifest.schemaVersion !== 1 || manifest.algorithm !== 'ed25519' || manifest.digest !== 'sha256' || manifest.keyId !== releasePublicKeyId(key)) throw failure('manifest format or publisher key is invalid.');
  if (version(manifest.version) !== expectedVersion) throw failure('manifest version does not match the expected release.');
  if (!Array.isArray(manifest.files) || !manifest.files.length || manifest.files.length > RELEASE_INTEGRITY_LIMITS.files) throw failure('manifest file count exceeds its bounds.');
  let total = 0, previous = '';
  const names = new Set();
  for (const file of manifest.files) {
    exactFields(file,['path','bytes','sha256'],'Manifest file');
    validPath(file.path);
    const insensitive = file.path.toLowerCase();
    if (names.has(insensitive) || file.path <= previous) throw failure('manifest contains duplicate paths or invalid path order.');
    names.add(insensitive); previous = file.path;
    if (!Number.isSafeInteger(file.bytes) || file.bytes < 0 || file.bytes > RELEASE_INTEGRITY_LIMITS.fileBytes || !hexHash.test(file.sha256 || '') || (total += file.bytes) > RELEASE_INTEGRITY_LIMITS.totalBytes) throw failure('manifest file metadata exceeds its bounds.');
  }
  for (const required of REQUIRED_RELEASE_FILES) if (!names.has(required.toLowerCase())) throw failure('manifest is missing required source or license file ' + required + '.');
  if (!canonicalManifest(manifest).equals(manifestBytes)) throw failure('manifest bytes are not canonical JSON.');
  return manifest;
}

async function realDirectory(path) {
  const info = await lstat(path);
  if (!info.isDirectory() || info.isSymbolicLink() || !samePath(resolve(path), await realpath(path))) throw failure('source paths require real directories without links.');
}
async function realParents(path) {
  let current = dirname(resolve(path));
  for (;;) {
    await realDirectory(current);
    const parent = dirname(current);
    if (parent === current) return;
    current = parent;
  }
}
function regularFile(info, bound) {
  if (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1) throw failure('source files must be regular files without symbolic or hard links.');
  if (!Number.isSafeInteger(info.size) || info.size < 0 || info.size > bound) throw failure('file exceeds its byte bound.');
}
function unchanged(before, after) {
  return before.dev === after.dev && before.ino === after.ino && before.size === after.size && before.mtimeMs === after.mtimeMs && before.ctimeMs === after.ctimeMs && after.nlink === 1;
}
async function readSourceFile(path, {maxBytes=RELEASE_INTEGRITY_LIMITS.fileBytes, retainBytes=false, rejectPrivateMaterial=false} = {}) {
  await realParents(path);
  const before = await lstat(path);
  regularFile(before,maxBytes);
  const file = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW || 0));
  try {
    const opened = await file.stat();
    regularFile(opened,maxBytes);
    if (!unchanged(before,opened)) throw failure('source file changed while opening.');
    const digest = createHash('sha256'), chunks = [], chunk = Buffer.alloc(64*1024);
    let bytes = 0, tail = '';
    for (;;) {
      const result = await file.read(chunk,0,chunk.length,null);
      if (!result.bytesRead) break;
      bytes += result.bytesRead;
      if (bytes > maxBytes || bytes > before.size) throw failure('source file changed or exceeded its bound while reading.');
      const part = chunk.subarray(0,result.bytesRead);
      digest.update(part);
      if (retainBytes) chunks.push(Buffer.from(part));
      if (rejectPrivateMaterial) {
        const text = tail + part.toString('latin1');
        if (/-----BEGIN (?:[A-Z0-9]+ )*PRIVATE KEY-----/.test(text)) throw failure('private key material cannot be included in release source.');
        tail = text.slice(-128);
      }
    }
    if (bytes !== before.size || !unchanged(opened,await file.stat()) || !unchanged(before,await lstat(path))) throw failure('source file changed while reading.');
    return {bytes,sha256:digest.digest('hex'), ...(retainBytes ? {content:Buffer.concat(chunks,bytes)} : {})};
  } finally { await file.close(); }
}
async function sourceInventory(root) {
  root = resolve(root);
  await realParents(join(root,'package.json'));
  const paths = [], names = new Set();
  let visited = 0;
  async function walk(directory, prefix = '') {
    await realDirectory(directory);
    const entries = await readdir(directory,{withFileTypes:true});
    for (const entry of entries) {
      if (++visited > RELEASE_INTEGRITY_LIMITS.files * 2) throw failure('source inventory traversal exceeds its bounds.');
      if (!prefix && (excludedDirectories.has(entry.name) || metadataFiles.has(entry.name))) continue;
      const path = join(directory,entry.name), info = await lstat(path);
      if (entry.name === '__pycache__') {
        await realDirectory(path);
        continue;
      }
      if (cacheFile(entry.name)) {
        regularFile(info,RELEASE_INTEGRITY_LIMITS.fileBytes);
        continue;
      }
      const name = prefix + entry.name;
      validPath(name);
      const collision = name.toLowerCase();
      if (names.has(collision)) throw failure('source inventory contains duplicate or case-conflicting paths.');
      names.add(collision);
      if (info.isDirectory()) {
        if (!prefix && !sourceDirectories.has(entry.name)) throw failure('unexpected root source directory ' + entry.name + '.');
        if (name.split('/').length >= RELEASE_INTEGRITY_LIMITS.depth) throw failure('source directory depth exceeds its bounds.');
        await walk(path,name+'/');
      } else {
        regularFile(info,RELEASE_INTEGRITY_LIMITS.fileBytes);
        paths.push(name);
        if (paths.length > RELEASE_INTEGRITY_LIMITS.files) throw failure('source inventory file count exceeds its bounds.');
      }
    }
  }
  await walk(root);
  return paths.sort();
}
async function metadata(root,name,maxBytes) {
  try { return (await readSourceFile(join(root,name),{maxBytes,retainBytes:true})).content; }
  catch (error) { throw failure(name === RELEASE_SIGNATURE_FILE ? 'signature is missing, unsafe or corrupt.' : 'manifest is missing, unsafe or exceeds its bounds.',error); }
}
async function packageVersion(root, expectedVersion) {
  let pkg;
  try { pkg = JSON.parse((await readSourceFile(join(root,'package.json'),{maxBytes:1024*1024,retainBytes:true})).content.toString('utf8')); }
  catch (error) { throw failure('package metadata is invalid.',error); }
  if (pkg?.name !== 'codexcli' || pkg?.type !== 'module' || pkg.version !== expectedVersion) throw failure('package version does not match the signed release.');
}

export async function verifyReleaseIntegrity({root, expectedVersion, publicKey = RELEASE_PUBLIC_KEY} = {}) {
  version(expectedVersion);
  if (typeof root !== 'string' || !root) throw failure('release root is invalid.');
  root = resolve(root);
  const manifestBytes = await metadata(root,RELEASE_MANIFEST_FILE,RELEASE_INTEGRITY_LIMITS.manifestBytes);
  const signatureBytes = await metadata(root,RELEASE_SIGNATURE_FILE,64);
  const manifest = validateSignedReleaseManifest({manifestBytes,signatureBytes,expectedVersion,publicKey});
  const inventory = await sourceInventory(root);
  if (inventory.length !== manifest.files.length || inventory.some((path,index)=>path!==manifest.files[index].path)) throw failure('source inventory contains added, missing or unsigned files.');
  for (const entry of manifest.files) {
    const result = await readSourceFile(join(root,...entry.path.split('/')));
    if (result.bytes !== entry.bytes || result.sha256 !== entry.sha256) throw failure('source hash integrity mismatch for ' + entry.path + '.');
  }
  await packageVersion(root,expectedVersion);
  const finalInventory = await sourceInventory(root);
  if (finalInventory.length !== inventory.length || finalInventory.some((path,index)=>path!==inventory[index])) throw failure('source inventory changed during verification.');
  return Object.freeze({version:manifest.version, files:manifest.files.length, sha256:hash(manifestBytes), keyId:manifest.keyId});
}

async function writeMetadata(root,name,bytes) {
  const target = join(root,name), temporary = join(root,name + '.writing-' + randomUUID());
  const existing = await lstat(target).catch(error=>{if(error.code!=='ENOENT')throw error;});
  if (existing) regularFile(existing,RELEASE_INTEGRITY_LIMITS.manifestBytes);
  const file = await open(temporary,'wx',0o644);
  try { await file.writeFile(bytes); await file.sync(); }
  finally { await file.close(); }
  try { await rename(temporary,target); }
  finally { await unlink(temporary).catch(error=>{if(error.code!=='ENOENT')throw error;}); }
}

// Publisher tooling only: callers must supply a private key stored outside the entire release tree.
export async function createSignedReleaseManifest({root, expectedVersion, privateKeyPath} = {}) {
  version(expectedVersion);
  if (typeof root !== 'string' || !root || typeof privateKeyPath !== 'string' || !privateKeyPath) throw failure('release root and explicit private key path are required.');
  root = resolve(root); privateKeyPath = resolve(privateKeyPath);
  await realDirectory(root);
  await realParents(privateKeyPath);
  if (inside(root,privateKeyPath) || inside(root,await realpath(privateKeyPath))) throw failure('publisher private key must be outside the release tree.');
  const privateBytes = (await readSourceFile(privateKeyPath,{maxBytes:16*1024,retainBytes:true})).content;
  let key;
  try { key = createPrivateKey(privateBytes); } catch (error) { throw failure('publisher private key could not be loaded.',error); }
  finally { privateBytes.fill(0); }
  if (key.asymmetricKeyType !== 'ed25519') throw failure('publisher private key must use Ed25519.');
  await packageVersion(root,expectedVersion);
  const files = [];
  let total = 0;
  for (const path of await sourceInventory(root)) {
    if (/(?:^|\/)(?:\.env(?:\..*)?|.*\.(?:key|p12|pfx)|.*private.*\.pem)$/i.test(path)) throw failure('credential or private key files cannot be included in release source.');
    const result = await readSourceFile(join(root,...path.split('/')),{rejectPrivateMaterial:true});
    if ((total += result.bytes) > RELEASE_INTEGRITY_LIMITS.totalBytes) throw failure('source inventory exceeds its total byte bound.');
    files.push({path,bytes:result.bytes,sha256:result.sha256});
  }
  const manifest = {format:'codexcli-release-integrity',schemaVersion:1,version:expectedVersion,algorithm:'ed25519',digest:'sha256',keyId:releasePublicKeyId(createPublicKey(key)),files};
  const bytes = canonicalManifest(manifest), signatureBytes = sign(null,bytes,key);
  validateSignedReleaseManifest({manifestBytes:bytes,signatureBytes,expectedVersion,publicKey:createPublicKey(key)});
  await writeMetadata(root,RELEASE_MANIFEST_FILE,bytes);
  await writeMetadata(root,RELEASE_SIGNATURE_FILE,signatureBytes);
  return verifyReleaseIntegrity({root,expectedVersion,publicKey:createPublicKey(key)});
}
