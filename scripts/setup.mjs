#!/usr/bin/env node
// Only Node built-ins may load before the publisher signature and bootstrap hashes.
import {createHash, verify} from 'node:crypto';
import {constants} from 'node:fs';
import {lstat, open, realpath} from 'node:fs/promises';
import {dirname, resolve} from 'node:path';
import {fileURLToPath} from 'node:url';

const EXPECTED_VERSION = '0.6.5';
const PUBLIC_KEY = `-----BEGIN PUBLIC KEY-----
MCowBQYDK2VwAyEA4K479LYZa8nbL423kpLOKjpMlsLwXTiGGaqESDeZYRM=
-----END PUBLIC KEY-----
`;
const root = fileURLToPath(new URL('..', import.meta.url));
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const samePath = (a,b) => process.platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b;
const unchanged = (a,b) => a.dev === b.dev && a.ino === b.ino && a.size === b.size && a.mtimeMs === b.mtimeMs && a.ctimeMs === b.ctimeMs && b.nlink === 1;
function regular(info,max) {
  if(!info.isFile() || info.isSymbolicLink() || info.nlink !== 1 || !Number.isSafeInteger(info.size) || info.size < 0 || info.size > max) throw new Error('Release source must be bounded regular files without links.');
}
async function readTrustedFile(name,max) {
  const path = resolve(root,name);
  for(let parent = dirname(path);;) {
    const info = await lstat(parent);
    if(!info.isDirectory() || info.isSymbolicLink() || !samePath(resolve(parent),await realpath(parent))) throw new Error('Release source must use real directories without links.');
    const next = dirname(parent); if(next === parent) break; parent = next;
  }
  const before = await lstat(path); regular(before,max);
  const file = await open(path,constants.O_RDONLY | (constants.O_NOFOLLOW || 0));
  try {
    const opened = await file.stat(); regular(opened,max);
    if(!unchanged(before,opened)) throw new Error('Release source changed while opening.');
    const bytes = Buffer.alloc(opened.size + 1); let position = 0;
    while(position < bytes.length) {const part = await file.read(bytes,position,bytes.length-position,null);if(!part.bytesRead)break;position += part.bytesRead;}
    if(position !== opened.size || !unchanged(opened,await file.stat()) || !unchanged(opened,await lstat(path))) throw new Error('Release source changed while reading.');
    return bytes.subarray(0,position);
  } finally {await file.close();}
}
async function boot() {
  const manifestBytes = await readTrustedFile('release-integrity.json',4*1024*1024);
  const signature = await readTrustedFile('release-integrity.sig',64);
  if(!manifestBytes.length || signature.length !== 64 || !verify(null,manifestBytes,PUBLIC_KEY,signature)) throw new Error('Publisher signature is missing or invalid.');
  const manifest = JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(manifestBytes));
  if(manifest.format !== 'codexcli-release-integrity' || manifest.schemaVersion !== 1 || manifest.version !== EXPECTED_VERSION || !Array.isArray(manifest.files) || manifest.files.length > 10000) throw new Error('Signed release identity is invalid.');
  // Verify our loaded entry and both helper modules before importing release code.
  for(const name of ['scripts/setup.mjs','bin/sudocli.mjs','src/release-integrity.mjs','src/release-public-key.mjs']) {
    const entries = manifest.files.filter(file => file?.path === name);
    if(entries.length !== 1 || !Number.isSafeInteger(entries[0].bytes) || entries[0].bytes < 0 || entries[0].bytes > 128*1024*1024 || !/^[a-f0-9]{64}$/.test(entries[0].sha256 || '')) throw new Error('Signed bootstrap metadata is invalid.');
    const bytes = await readTrustedFile(name,128*1024*1024);
    if(bytes.length !== entries[0].bytes || hash(bytes) !== entries[0].sha256) throw new Error('Signed release file changed: '+name+'.');
  }
  const {verifyReleaseIntegrity} = await import('../src/release-integrity.mjs');
  await verifyReleaseIntegrity({root,expectedVersion:EXPECTED_VERSION});
  await import('../src/setup-cli.mjs');
}
await boot().catch(error => {
  const detail = String(error?.message || 'Verification failed.').replace(/[\u0000-\u001f\u007f]/g,' ');
  process.stderr.write('codexcli setup: Release integrity check failed. Restore the original official release. '+detail+'\n');
  process.exitCode = 1;
});
