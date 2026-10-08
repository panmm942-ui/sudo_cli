import {mkdir,lstat,realpath,open,rename,rm} from 'node:fs/promises';
import {constants} from 'node:fs';
import {resolve,join,parse,relative} from 'node:path';
import {randomUUID} from 'node:crypto';

async function directoryPath(path,create){
  const root=resolve(path),parts=relative(parse(root).root,root).split(/[\\/]/).filter(Boolean);
  const checked=[];let current=parse(root).root;
  for(const part of parts){current=join(current,part);if(create)try{await mkdir(current,{mode:0o700});}catch(error){if(error.code!=='EEXIST')throw error;}
    const info=await lstat(current);if(!info.isDirectory()||info.isSymbolicLink())throw new Error('Private state requires real directories; symbolic links are refused.');checked.push({path:current,info});}
  // Resolve case/8.3 spelling only after refusing links, then recheck every
  // original ancestor so native canonicalization cannot conceal a replacement.
  const canonical=await realpath(root);
  for(const entry of checked){const actual=await lstat(entry.path);if(!actual.isDirectory()||actual.isSymbolicLink()||actual.dev!==entry.info.dev||actual.ino!==entry.info.ino)throw new Error('Private state directory changed while resolving.');}
  const before=checked.at(-1)?.info||await lstat(root),actual=await lstat(canonical);
  if(!actual.isDirectory()||actual.isSymbolicLink()||actual.dev!==before.dev||actual.ino!==before.ino)throw new Error('Private state directory changed while resolving.');
  return canonical;
}
export const privateDirectory=path=>directoryPath(path,true);
export const canonicalRealDirectory=path=>directoryPath(path,false);
export async function createPrivateRecord({directory,filename,maxBytes=65536}){
  if(!/^[a-zA-Z0-9._-]+$/.test(filename)||filename==='.'||filename==='..')throw new Error('Invalid state record name.');
  const root=await privateDirectory(directory),path=join(root,filename);
  async function read(){
    let file;try{const info=await lstat(path);if(!info.isFile()||info.isSymbolicLink()||info.nlink!==1||info.size>maxBytes)throw new Error('Private state record is invalid.');
      file=await open(path,constants.O_RDONLY|(constants.O_NOFOLLOW||0));const current=await file.stat();if(current.ino!==info.ino||current.dev!==info.dev||current.size!==info.size)throw new Error('Private state changed while opening.');
      const bytes=Buffer.alloc(maxBytes+1);let count=0;while(count<bytes.length){const result=await file.read(bytes,count,bytes.length-count,null);if(!result.bytesRead)break;count+=result.bytesRead;}if(count>maxBytes)throw new Error('Private state exceeds its limit.');const after=await file.stat();if(after.size!==current.size||after.mtimeMs!==current.mtimeMs||after.nlink!==1)throw new Error('Private state changed while reading.');return JSON.parse(bytes.subarray(0,count).toString('utf8'));
    }catch(error){if(error.code==='ENOENT')return undefined;throw error;}finally{await file?.close();}
  }
  async function lock(fn){let file;const lockPath=path+'.lock';try{file=await open(lockPath,'wx',0o600);return await fn();}
    catch(error){if(error.code==='EEXIST')throw new Error('State is locked by another or interrupted session.');throw error;}
    finally{if(file){await file.close();await rm(lockPath,{force:true});}}}
  return {path,read,write:async value=>lock(async()=>{await read();const text=JSON.stringify(value);if(Buffer.byteLength(text)>maxBytes)throw new Error('State exceeds its size limit.');const temporary=path+'.'+randomUUID()+'.tmp';let file;
    try{file=await open(temporary,'wx',0o600);await file.writeFile(text);await file.sync();await file.close();file=undefined;await rename(temporary,path);}finally{await file?.close();await rm(temporary,{force:true});}}),remove:async()=>lock(async()=>{await read();await rm(path,{force:true});})};
}
