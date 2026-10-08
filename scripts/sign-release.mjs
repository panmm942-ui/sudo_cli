#!/usr/bin/env node
import {generateKeyPairSync} from 'node:crypto';
import {lstat, open, realpath, unlink} from 'node:fs/promises';
import {dirname, isAbsolute, relative, resolve, sep} from 'node:path';
import {fileURLToPath} from 'node:url';
import {createSignedReleaseManifest} from '../src/release-integrity.mjs';

const defaultRoot = fileURLToPath(new URL('..',import.meta.url));
const help = 'Usage: node scripts/sign-release.mjs --root PATH --version VERSION --key PATH\n       node scripts/sign-release.mjs --generate-key PATH [--root PATH]\nThe private key must stay outside the release. Key creation uses only the explicit path and never prints key material.';
function inside(root,path) {const name=relative(resolve(root),resolve(path));return name===''||name!=='..'&&!name.startsWith('..'+sep)&&!isAbsolute(name);}
async function realParents(path) {
  let parent=dirname(resolve(path));
  for (;;) {
    const info=await lstat(parent), actual=await realpath(parent), expected=resolve(parent);
    if (!info.isDirectory() || info.isSymbolicLink() || (process.platform==='win32'?actual.toLowerCase()!==expected.toLowerCase():actual!==expected)) throw new Error('Key location must use real directories without links.');
    const next=dirname(parent); if(next===parent) return; parent=next;
  }
}
async function generateKey(path,root) {
  path=resolve(path); await realParents(path);
  if(inside(root,path)) throw new Error('Generate the publisher private key outside the release tree.');
  const publicPath=path+'.pub';
  if(await lstat(path).catch(error=>{if(error.code!=='ENOENT')throw error;})||await lstat(publicPath).catch(error=>{if(error.code!=='ENOENT')throw error;})) throw new Error('Key destination already exists; existing files were preserved.');
  const {privateKey,publicKey}=generateKeyPairSync('ed25519');
  const bytes=Buffer.from(privateKey.export({type:'pkcs8',format:'pem'}));
  let written=false;
  try {
    const file=await open(path,'wx',0o600); written=true;
    try {await file.writeFile(bytes);await file.sync();} finally {await file.close();}
    const publicFile=await open(publicPath,'wx',0o644);
    try {await publicFile.writeFile(publicKey.export({type:'spki',format:'pem'}));await publicFile.sync();} finally {await publicFile.close();}
  } catch(error) {if(written)await unlink(path);throw error;}
  finally {bytes.fill(0);}
  console.log('Publisher key created at the explicit path. Public key saved to '+publicPath+'. Protect the private key with owner-only OS permissions.');
}
async function main(args) {
  if(args.includes('--help')||args.includes('-h')) {console.log(help);return;}
  const options={};
  for(let index=0;index<args.length;index+=2) {
    const flag=args[index], value=args[index+1];
    if(!['--root','--version','--key','--generate-key'].includes(flag)||typeof value!=='string'||!value||value.startsWith('--')||Object.hasOwn(options,flag)) throw new Error(help);
    options[flag]=value;
  }
  const root=resolve(options['--root']||defaultRoot);
  if(options['--generate-key']) {
    if(options['--key']||options['--version'])throw new Error('Key generation and release signing are separate commands.');
    await generateKey(options['--generate-key'],root); return;
  }
  if(!options['--key']||!options['--version'])throw new Error(help);
  const receipt=await createSignedReleaseManifest({root,expectedVersion:options['--version'],privateKeyPath:resolve(options['--key'])});
  console.log('Signed codexcli '+receipt.version+' source manifest: '+receipt.files+' files; SHA-256 '+receipt.sha256+'.');
}
await main(process.argv.slice(2)).catch(error=>{console.error(error.message);process.exitCode=1;});
