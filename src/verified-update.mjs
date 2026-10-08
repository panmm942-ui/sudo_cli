import {createHash,randomUUID} from 'node:crypto';
import {constants} from 'node:fs';
import {open,lstat,mkdtemp,mkdir,rename,rm,chmod,realpath} from 'node:fs/promises';
import {spawn} from 'node:child_process';
import {join,resolve,relative,isAbsolute,dirname,sep} from 'node:path';
import {fileURLToPath} from 'node:url';
import {inflateRawSync} from 'node:zlib';
import {createPrivateRecord,privateDirectory} from './private-state.mjs';
import {defaultWorkStateDir} from './work-meter.mjs';
import {CODEX_VERSION,platformRuntime} from './platforms.mjs';
import {isolatedEnvironment} from './permission-scope.mjs';

const MAX_PACKAGE=512*1024*1024,MAX_EXPANDED=1024*1024*1024;
const projectRoot=fileURLToPath(new URL('..',import.meta.url));
const queues=new Map(),semver=/^\d+\.\d+\.\d+$/;
const digest=bytes=>createHash('sha256').update(bytes).digest('hex');
const invalidArchive=()=>new Error('Invalid or unsupported update ZIP archive.');
function platformIdentity(value,arch){
  if(typeof value!=='string')throw new Error('Update runtime platform or architecture is invalid.');
  const match=/^(windows|win32|linux|darwin|macos)(?:-(x64|arm64))?$/.exec(value);
  if(!match||(arch&&match[2]&&arch!==match[2]))throw new Error('Update runtime platform or architecture is invalid.');
  return{platform:({windows:'win32',macos:'darwin'})[match[1]]||match[1],arch:arch||match[2]};
}
function secureUrl(value){
  let url;try{url=new URL(value);}catch{throw new Error('Update URL is invalid.');}
  if(url.protocol!=='https:'||url.username||url.password||url.hash||/[\u0000-\u0020\u007f]/.test(value))throw new Error('Update URL must use HTTPS without credentials or a fragment.');
  return url;
}
export function validateUpdateManifest(value,{platform=process.platform,arch=process.arch}={}){
  const identity=platformIdentity(value?.platform,value?.arch);
  if(!semver.test(value?.version||'')||identity.platform!==platform||identity.arch!==arch||!/^[a-f0-9]{64}$/.test(value?.sha256||''))throw new Error('Update version, platform, architecture or hash is invalid.');
  secureUrl(value.url);return{version:value.version,...identity,sha256:value.sha256,url:value.url};
}
async function operation(stateDir,fn){
  const directory=await privateDirectory(join(stateDir,'updates')),canonical=await realpath(directory),key=process.platform==='win32'?canonical.toLowerCase():canonical;
  const next=(queues.get(key)||Promise.resolve()).catch(()=>{}).then(async()=>{let lock;
    try{lock=await open(join(directory,'operation.lock'),'wx',0o600);}catch{throw new Error('Updates are locked by another or interrupted session. Existing state was preserved.');}
    try{return await fn(directory);}finally{await lock.close();await rm(join(directory,'operation.lock'),{force:true});}
  });queues.set(key,next);try{return await next;}finally{if(queues.get(key)===next)queues.delete(key);}
}
async function boundedFile(path,maxBytes){
  await realParents(path);
  const info=await lstat(path);if(!info.isFile()||info.isSymbolicLink()||info.nlink!==1||info.size>maxBytes)throw new Error('Update file must be a bounded regular file without links.');
  const file=await open(path,constants.O_RDONLY|(constants.O_NOFOLLOW||0));
  try{const current=await file.stat();if(current.ino!==info.ino||current.dev!==info.dev||current.size!==info.size)throw new Error('Update file changed while opening.');
    const bytes=Buffer.alloc(info.size+1);let position=0;while(position<bytes.length){const part=await file.read(bytes,position,bytes.length-position,null);if(!part.bytesRead)break;position+=part.bytesRead;}
    const after=await file.stat();if(position!==info.size||after.size!==info.size||after.mtimeMs!==current.mtimeMs||after.nlink!==1)throw new Error('Update file changed while reading.');return bytes.subarray(0,position);
  }finally{await file.close();}
}
export async function stageUpdate({source,sha256,stateDir=defaultWorkStateDir(),maxBytes=MAX_PACKAGE,signal,fetchImpl=fetch}={}){
  if(!/^[a-f0-9]{64}$/i.test(sha256||''))throw new Error('Supply a trusted SHA-256 checksum for this update.');
  if(typeof source!=='string'||!source||!Number.isSafeInteger(maxBytes)||maxBytes<1||maxBytes>MAX_PACKAGE)throw new Error('Update source or size limit is invalid.');
  sha256=sha256.toLowerCase();return operation(stateDir,async directory=>{
    signal?.throwIfAborted();const path=join(directory,sha256+'.zip'),temporary=join(directory,sha256+'.download-'+randomUUID());let file,input,size=0;
    try{
      if(/^[a-z]+:\/\//i.test(source)){const url=secureUrl(source),response=await fetchImpl(url,{redirect:'error',signal:signal?AbortSignal.any([signal,AbortSignal.timeout(120000)]):AbortSignal.timeout(120000)});
        if(!response.ok||!response.body){await response.body?.cancel();throw new Error('Update download failed.');}input=response.body;
      }else{const bytes=await boundedFile(resolve(source),maxBytes);input=[bytes];}
      file=await open(temporary,'wx',0o600);const hash=createHash('sha256');
      for await(const chunk of input){signal?.throwIfAborted();const buffer=Buffer.from(chunk);size+=buffer.length;if(size>maxBytes)throw new Error('Update package exceeds its size limit.');hash.update(buffer);
        let offset=0;while(offset<buffer.length){const result=await file.write(buffer.subarray(offset));if(!result.bytesWritten)throw new Error('Update package could not be written.');offset+=result.bytesWritten;}}
      await file.sync();await file.close();file=undefined;
      if(hash.digest('hex')!==sha256)throw new Error('Update package hash mismatch. The current installation is unchanged.');
      const existing=await lstat(path).catch(error=>{if(error.code!=='ENOENT')throw error;});
      if(existing){if(digest(await boundedFile(path,maxBytes))!==sha256)throw new Error('Existing staged package is invalid.');}else await rename(temporary,path);
      const record=await createPrivateRecord({directory,filename:'latest.json'});await record.write({version:1,path,sha256,size,stagedAt:new Date().toISOString()});return{path,sha256,size};
    }finally{await file?.close().catch(()=>{});await input?.cancel?.().catch(()=>{});await rm(temporary,{force:true});}
  });
}
export async function updateStatus({stateDir=defaultWorkStateDir()}={}){return(await createPrivateRecord({directory:join(stateDir,'updates'),filename:'latest.json'})).read();}

const crcTable=Uint32Array.from({length:256},(_,value)=>{for(let bit=0;bit<8;bit++)value=(value>>>1)^((value&1)?0xedb88320:0);return value>>>0;});
function crc32(bytes){let value=0xffffffff;for(const byte of bytes)value=(value>>>8)^crcTable[(value^byte)&255];return(value^0xffffffff)>>>0;}
function zipEntries(buffer){
  if(!Buffer.isBuffer(buffer)||buffer.length<22||buffer.length>MAX_PACKAGE)throw invalidArchive();
  const bounds=(offset,size,limit=buffer.length)=>{if(!Number.isSafeInteger(offset)||offset<0||size<0||offset+size>limit)throw invalidArchive();};
  let end=-1;for(let offset=buffer.length-22;offset>=Math.max(0,buffer.length-65557);offset--)if(buffer.readUInt32LE(offset)===0x06054b50&&offset+22+buffer.readUInt16LE(offset+20)===buffer.length){end=offset;break;}
  if(end<0)throw invalidArchive();
  const count=buffer.readUInt16LE(end+10),directorySize=buffer.readUInt32LE(end+12),directoryOffset=buffer.readUInt32LE(end+16);
  if(buffer.readUInt16LE(end+4)||buffer.readUInt16LE(end+6)||buffer.readUInt16LE(end+8)!==count||!count||count>10000||directorySize===0xffffffff||directoryOffset===0xffffffff||directoryOffset+directorySize!==end)throw invalidArchive();
  bounds(directoryOffset,directorySize,end);let position=directoryOffset,total=0;const entries=[],names=new Map(),ranges=[];
  for(let index=0;index<count;index++){
    bounds(position,46,end);if(buffer.readUInt32LE(position)!==0x02014b50)throw invalidArchive();
    const needed=buffer.readUInt16LE(position+6),flags=buffer.readUInt16LE(position+8),method=buffer.readUInt16LE(position+10),crc=buffer.readUInt32LE(position+16),packed=buffer.readUInt32LE(position+20),size=buffer.readUInt32LE(position+24),length=buffer.readUInt16LE(position+28),extra=buffer.readUInt16LE(position+30),comment=buffer.readUInt16LE(position+32),mode=buffer.readUInt32LE(position+38)>>>16,local=buffer.readUInt32LE(position+42);
    bounds(position,46+length+extra+comment,end);
    if(needed>20||![0,8].includes(method)||(flags&~0x080e)||method===0&&((flags&6)||packed!==size)||buffer.readUInt16LE(position+34)||[packed,size,local].includes(0xffffffff)||size>MAX_PACKAGE||(total+=size)>MAX_EXPANDED)throw invalidArchive();
    const extras=(start,length)=>{const limit=start+length;for(let offset=start;offset<limit;){bounds(offset,4,limit);const id=buffer.readUInt16LE(offset),size=buffer.readUInt16LE(offset+2);if(id===1)throw invalidArchive();bounds(offset+4,size,limit);offset+=4+size;}};extras(position+46+length,extra);
    const nameBytes=buffer.subarray(position+46,position+46+length);let name;
    try{if(!(flags&0x800)&&nameBytes.some(byte=>byte>127))throw invalidArchive();name=new TextDecoder('utf-8',{fatal:true}).decode(nameBytes);}catch{throw invalidArchive();}
    const directory=name.endsWith('/'),parts=name.replace(/\/$/,'').split('/'),key=name.replace(/\/$/,'').normalize('NFC').toLowerCase(),type=mode&0xf000;
    if(!name||parts[0]!=='codexcli'||!directory&&parts.length<2||/[\\:\u0000-\u001f\u007f]/.test(name)||parts.some(part=>!part||part==='.'||part==='..'||/[. ]$/.test(part)||/^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(part))||names.has(key)||type&&type!==(directory?0x4000:0x8000)||directory&&(size||packed))throw new Error('Update archive contains unsafe paths, links or duplicate names.');
    names.set(key,directory);bounds(local,30,directoryOffset);
    if(buffer.readUInt32LE(local)!==0x04034b50||buffer.readUInt16LE(local+4)!==needed||buffer.readUInt16LE(local+6)!==flags||buffer.readUInt16LE(local+8)!==method)throw new Error('Update ZIP local header does not match its central directory.');
    const localLength=buffer.readUInt16LE(local+26),localExtra=buffer.readUInt16LE(local+28);bounds(local,30+localLength+localExtra,directoryOffset);
    extras(local+30+localLength,localExtra);
    if(localLength!==length||!buffer.subarray(local+30,local+30+localLength).equals(nameBytes))throw new Error('Update ZIP local filename does not match its central directory.');
    for(const [offset,value] of [[14,crc],[18,packed],[22,size]]){const actual=buffer.readUInt32LE(local+offset);if(actual!==value&&(!(flags&8)||actual!==0))throw new Error('Update ZIP local sizes or CRC do not match.');}
    const data=local+30+localLength+localExtra;bounds(data,packed,directoryOffset);let recordEnd=data+packed;
    if(flags&8){bounds(recordEnd,12,directoryOffset);if(buffer.readUInt32LE(recordEnd)===0x08074b50){recordEnd+=4;bounds(recordEnd,12,directoryOffset);}
      if(buffer.readUInt32LE(recordEnd)!==crc||buffer.readUInt32LE(recordEnd+4)!==packed||buffer.readUInt32LE(recordEnd+8)!==size)throw invalidArchive();recordEnd+=12;}
    ranges.push([local,recordEnd]);entries.push({name,directory,mode,data,packed,size,crc,method});position+=46+length+extra+comment;
  }
  if(position!==end)throw invalidArchive();ranges.sort((a,b)=>a[0]-b[0]);for(let index=1;index<ranges.length;index++)if(ranges[index][0]<ranges[index-1][1])throw new Error('Update ZIP contains overlapping local records.');
  for(const entry of entries){const parts=entry.name.replace(/\/$/,'').normalize('NFC').toLowerCase().split('/');while(parts.length>1){parts.pop();if(names.get(parts.join('/'))===false)throw new Error('Update archive contains conflicting file and directory paths.');}}
  if(!entries.some(entry=>entry.name==='codexcli/package.json'&&!entry.directory)||!entries.some(entry=>entry.name==='codexcli/bin/sudocli.mjs'&&!entry.directory))throw new Error('Update has no compatible codexcli application.');return entries;
}
export function inspectZip(buffer){return zipEntries(buffer).map(entry=>entry.name);}
async function extractZip(buffer,destination,signal){
  for(const entry of zipEntries(buffer)){signal?.throwIfAborted();const path=join(destination,...entry.name.split('/'));if(entry.directory){await mkdir(path,{recursive:true,mode:0o700});continue;}
    let bytes;try{bytes=entry.method===0?buffer.subarray(entry.data,entry.data+entry.packed):inflateRawSync(buffer.subarray(entry.data,entry.data+entry.packed),{maxOutputLength:Math.max(1,entry.size+1)});}catch{throw new Error('Update archive payload could not be decoded within its limit.');}
    if(bytes.length!==entry.size||crc32(bytes)!==entry.crc)throw new Error('Update archive payload failed size or CRC integrity verification.');
    await mkdir(dirname(path),{recursive:true,mode:0o700});const file=await open(path,'wx',(entry.mode&0o111)?0o700:0o600);try{await file.writeFile(bytes);}finally{await file.close();}
  }
}

async function execute(command,args,{cwd,env,signal,timeoutMs=120000,maxBytes=1024*1024}={}){
  return new Promise((resolvePromise,reject)=>{let done=false,bytes=0,stdout='',stderr='';signal?.throwIfAborted();
    const child=spawn(command,args,{cwd,env,stdio:['ignore','pipe','pipe'],shell:false,windowsHide:true});
    const fail=()=>{if(!done){done=true;child.kill();clearTimeout(timer);signal?.removeEventListener('abort',fail);reject(new Error('Update verification command failed, timed out or was interrupted.'));}};
    const timer=setTimeout(fail,timeoutMs);signal?.addEventListener('abort',fail,{once:true});
    for(const [stream,key] of [[child.stdout,'stdout'],[child.stderr,'stderr']])stream.on('data',chunk=>{bytes+=chunk.length;if(bytes>maxBytes)return fail();if(key==='stdout')stdout+=chunk.toString();else stderr+=chunk.toString();});
    child.once('error',fail);child.once('close',code=>{if(!done){done=true;clearTimeout(timer);signal?.removeEventListener('abort',fail);resolvePromise({code,stdout,stderr});}});
  });
}
async function runChecked(runner,command,args,options,label){let result;try{result=await runner(command,args,options);}catch{throw new Error('Update '+label+' verification failed.');}if(result?.code!==0||typeof result.stdout!=='string')throw new Error('Update '+label+' verification failed.');return result.stdout.trim();}
function inside(parent,path){const value=relative(resolve(parent),resolve(path));return value===''||value!=='..'&&!value.startsWith('..'+sep)&&!isAbsolute(value);}
async function realParents(path){let parent=dirname(resolve(path));for(;;){const info=await lstat(parent);if(!info.isDirectory()||info.isSymbolicLink())throw new Error('Update paths require real directories without links.');const next=dirname(parent);if(next===parent)break;parent=next;}}
async function realFile(path){await realParents(path);const info=await lstat(path);if(!info.isFile()||info.isSymbolicLink()||info.nlink!==1)throw new Error('Update runtime requires regular files without links.');return resolve(path);}
async function jsonFile(path){return JSON.parse((await boundedFile(path,1024*1024)).toString('utf8'));}
async function verifyRelease(root,{nodePath=process.execPath,runtimePath,commandRunner=execute,signal,allowRuntimeSetup=false}={}){
  root=resolve(root);await realParents(join(root,'package.json'));
  const pkg=await jsonFile(join(root,'package.json'));if(pkg.name!=='codexcli'||!semver.test(pkg.version||'')||pkg.type!=='module')throw new Error('Update does not contain a compatible codexcli release.');
  const bundledNode=join(root,'runtime',process.platform==='win32'?'node.exe':'node');if(await lstat(bundledNode).catch(error=>{if(error.code!=='ENOENT')throw error;}))nodePath=bundledNode;
  nodePath=await realFile(nodePath);if(process.platform!=='win32'&&inside(root,nodePath))await chmod(nodePath,0o700);
  const env=isolatedEnvironment();let manifest;
  const metadata=await lstat(join(root,'runtime','manifest.json')).catch(error=>{if(error.code!=='ENOENT')throw error;});
  if(metadata){manifest=await jsonFile(join(root,'runtime','manifest.json'));
    if(manifest.platform){const identity=platformIdentity(manifest.platform,manifest.arch);if(identity.platform!==process.platform||identity.arch&&identity.arch!==process.arch)throw new Error('Update runtime targets a different platform or architecture.');}
    if(manifest.arch&&manifest.arch!==process.arch||manifest.codexVersion&&manifest.codexVersion!==CODEX_VERSION)throw new Error('Update runtime does not match the pinned native version or architecture.');
    if(manifest.files!==undefined){if(!Array.isArray(manifest.files)||manifest.files.length>10000)throw new Error('Update runtime file manifest is invalid.');const names=new Set();for(const item of manifest.files){const name=item?.file??item?.path;
      if(typeof name!=='string'||item.file&&item.path&&item.file!==item.path||/[\\:\u0000-\u001f\u007f]/.test(name)||name.split('/').some(part=>!part||part==='.'||part==='..')||names.has(name.toLowerCase())||!Number.isSafeInteger(item.bytes)||item.bytes<0||!/^[a-f0-9]{64}$/.test(item.sha256||''))throw new Error('Update runtime file manifest is invalid.');names.add(name.toLowerCase());
      const file=join(root,'runtime',name);if(!inside(join(root,'runtime'),file))throw new Error('Update runtime file manifest is invalid.');const bytes=await boundedFile(file,MAX_PACKAGE);if(bytes.length!==item.bytes||digest(bytes)!==item.sha256)throw new Error('Update runtime file failed its manifest integrity check.');}}
  }
  const nodeVersion=await runChecked(commandRunner,nodePath,['--version'],{cwd:root,env,signal,timeoutMs:10000},'Node');
  const parsedNode=/^v(\d+)\.(\d+)\.(\d+)$/.exec(nodeVersion),parsedMinimum=/^>=\s*(\d+)(?:\.(\d+)(?:\.(\d+))?)?$/.exec(pkg.engines?.node??'>=22');
  const nodeParts=parsedNode?.slice(1).map(Number),minimum=parsedMinimum?.slice(1).map(value=>Number(value??0));
  if(!nodeParts||!minimum||[...nodeParts,...minimum].some(value=>!Number.isSafeInteger(value))||nodeParts[0]<22||nodeParts.some((value,index)=>nodeParts.slice(0,index).every((part,prior)=>part===minimum[prior])&&value<minimum[index]))throw new Error('Update Node version does not satisfy Node 22 or its package engine requirement.');
  if(manifest?.nodeVersion&&inside(root,nodePath)&&manifest.nodeVersion!==nodeVersion.slice(1))throw new Error('Update Node runtime version does not match its manifest.');
  const target=platformRuntime();let nativePath=runtimePath;const runtimeDirectory=runtimePath&&!inside(root,runtimePath)?dirname(dirname(resolve(runtimePath))):join(root,'runtime',target.id);
  if(!nativePath||inside(root,nativePath)){nativePath=nativePath||join(runtimeDirectory,'bin',target.executable);
    if(!await lstat(nativePath).catch(error=>{if(error.code!=='ENOENT')throw error;})){if(!allowRuntimeSetup)throw new Error('Retained update has no verified native runtime.');await realFile(join(root,'scripts','setup-runtime.mjs'));await runChecked(commandRunner,nodePath,[join(root,'scripts','setup-runtime.mjs')],{cwd:root,env,signal,timeoutMs:300000},'pinned runtime setup');}
  }
  {
    const pin=await jsonFile(join(runtimeDirectory,'sudo-runtime.json'));if(pin.codexVersion!==CODEX_VERSION||pin.platform!==target.id||pin.archiveBytes!==target.bytes||pin.archiveSha256!==target.sha256||pin.source!==target.url)throw new Error('Update native runtime does not match its pinned official package.');
    if(resolve(nativePath)!==join(runtimeDirectory,'bin',target.executable))throw new Error('Update native executable is outside the pinned runtime package.');
    const layout=await jsonFile(join(runtimeDirectory,'codex-package.json'));if(layout.layoutVersion!==1||layout.version!==CODEX_VERSION||layout.target!==target.triple||layout.variant!=='codex'||layout.entrypoint!==`bin/${target.executable}`||layout.resourcesDir!=='codex-resources'||layout.pathDir!=='codex-path')throw new Error('Update native runtime package layout is invalid.');
    for(const helper of [join(runtimeDirectory,'bin',process.platform==='win32'?'codex-code-mode-host.exe':'codex-code-mode-host'),join(runtimeDirectory,'codex-path',process.platform==='win32'?'rg.exe':'rg'),...(process.platform==='linux'?[join(runtimeDirectory,'codex-resources','bwrap')]:process.platform==='win32'?[join(runtimeDirectory,'codex-resources','codex-command-runner.exe'),join(runtimeDirectory,'codex-resources','codex-windows-sandbox-setup.exe')]:[])])await realFile(helper);
  }
  nativePath=await realFile(nativePath);if(process.platform!=='win32'&&inside(root,nativePath))await chmod(nativePath,0o700);
  const nativeVersion=await runChecked(commandRunner,nativePath,['--version'],{cwd:root,env,signal,timeoutMs:10000},'native runtime');if(nativeVersion!==`codex-cli ${CODEX_VERSION}`)throw new Error('Update native runtime version does not match the pinned version.');
  await realFile(join(root,'bin','sudocli.mjs'));
  const doctor=await runChecked(commandRunner,nodePath,[join(root,'bin','sudocli.mjs'),'doctor'],{cwd:root,env:{...env,SUDO_CLI_CODEX:nativePath},signal,timeoutMs:30000},'doctor');
  if(!doctor.includes(`codexcli ${pkg.version} | sudocli`)||!doctor.includes(`Engine: codex-cli ${CODEX_VERSION}`)||!doctor.includes('Ready.'))throw new Error('Update doctor did not verify the expected release and native runtime.');
  return{projectRoot:root,nodePath,runtimePath:nativePath,version:pkg.version};
}
function validateInstallation(value,stateDir){
  if(!value)return;
  const releases=join(resolve(stateDir),'releases');if(value.version!==1||!semver.test(value.releaseVersion||''))throw new Error('Retained update state is invalid.');
  for(const path of [value.originalRoot,value.current,value.previous,value.currentNodePath,value.currentRuntimePath,value.previousNodePath,value.previousRuntimePath])if(typeof path!=='string'||!isAbsolute(path)||/[\u0000-\u001f\u007f]/.test(path))throw new Error('Retained update state is invalid.');
  for(const hash of [value.sha256,value.previousSha256])if(hash!==undefined&&!/^[a-f0-9]{64}$/.test(hash))throw new Error('Retained update state is invalid.');
  for(const root of [value.current,value.previous])if(resolve(root)!==resolve(value.originalRoot)&&(!inside(releases,root)||!/^verified-[a-z0-9]+[\\/]codexcli$/i.test(relative(releases,resolve(root)))))throw new Error('Retained update state points outside its protected release directory.');return value;
}
async function switchCommand(register,next,previous,record,value,oldValue){
  try{await register(next);await record.write(value);}catch{
    if(!previous)throw Object.assign(new Error('Update registration failed and the active release did not pass recovery verification. Retained releases remain available for manual command repair.'),{code:'UPDATE_REGISTRATION_UNCERTAIN'});
    try{await register(previous);if(oldValue)await record.write(oldValue);else await record.remove();}catch{throw Object.assign(new Error('Update command registration and recovery failed. Retained releases remain available for manual command repair.'),{code:'UPDATE_REGISTRATION_UNCERTAIN'});}
    throw new Error('Update command registration failed. The verified previous command was restored.');
  }
}
export async function installStagedUpdate({stateDir=defaultWorkStateDir(),currentRoot=projectRoot,register,nodePath=process.execPath,runtimePath,commandRunner=execute,signal}={}){
  if(runtimePath&&!register)throw new Error('An external runtime path requires explicit command registration.');
  return operation(stateDir,async directory=>{
    const staged=await updateStatus({stateDir});if(!staged||!/^[a-f0-9]{64}$/.test(staged.sha256||''))throw new Error('Stage a verified update first.');
    const path=join(directory,staged.sha256+'.zip');if(typeof staged.path!=='string'||resolve(staged.path)!==path)throw new Error('Update state points outside its protected directory.');
    const bytes=await boundedFile(path,MAX_PACKAGE);if(bytes.length!==staged.size||digest(bytes)!==staged.sha256)throw new Error('Staged update hash or size changed.');zipEntries(bytes);
    const record=await createPrivateRecord({directory,filename:'installation.json'}),old=validateInstallation(await record.read(),stateDir);
    if(old?.currentRuntimePath&&!inside(old.current,old.currentRuntimePath)&&!register)throw new Error('An external runtime path requires explicit command registration.');
    const originalRoot=old?.originalRoot||resolve(currentRoot),previous=await verifyRelease(old?.current||originalRoot,{nodePath:old?.currentNodePath||nodePath,runtimePath:old?.currentRuntimePath||runtimePath,commandRunner,signal});
    if(old?.sha256===staged.sha256)return{installed:previous.projectRoot,version:previous.version,rollback:old.previous,alreadyInstalled:true,restart:'Run the registered sudocli command.'};
    const releases=await privateDirectory(join(stateDir,'releases')),release=await mkdtemp(join(releases,'verified-'));let keep=false;
    try{await extractZip(bytes,release,signal);const next=await verifyRelease(join(release,'codexcli'),{nodePath,runtimePath,commandRunner,signal,allowRuntimeSetup:true});
      const registerFn=register||(await import('./command-setup.mjs')).registerCommand;
      signal?.throwIfAborted();await switchCommand(registerFn,next,previous,record,{version:1,originalRoot,current:next.projectRoot,previous:previous.projectRoot,currentNodePath:next.nodePath,currentRuntimePath:next.runtimePath,previousNodePath:previous.nodePath,previousRuntimePath:previous.runtimePath,releaseVersion:next.version,sha256:staged.sha256,previousSha256:old?.sha256},old);
      keep=true;return{installed:next.projectRoot,version:next.version,rollback:previous.projectRoot,restart:'Close this session and run the registered sudocli command.'};
    }catch(error){if(error.code==='UPDATE_REGISTRATION_UNCERTAIN')keep=true;throw error;}
    finally{if(!keep){if(!inside(releases,release)||resolve(release)===resolve(releases))throw new Error('Update cleanup target is invalid.');await rm(release,{recursive:true,force:true});}}
  });
}
export async function rollbackUpdate({stateDir=defaultWorkStateDir(),register,nodePath=process.execPath,runtimePath,commandRunner=execute,signal}={}){
  if(runtimePath&&!register)throw new Error('An external runtime path requires explicit command registration.');
  return operation(stateDir,async directory=>{
    const record=await createPrivateRecord({directory,filename:'installation.json'}),value=validateInstallation(await record.read(),stateDir);if(!value?.previous)throw new Error('No retained update is available for rollback.');
    if(!register&&[value.currentRuntimePath,value.previousRuntimePath].some((path,index)=>path&&!inside(index?value.previous:value.current,path)))throw new Error('An external runtime path requires explicit command registration.');
    const next=await verifyRelease(value.previous,{nodePath:value.previousNodePath||nodePath,runtimePath:value.previousRuntimePath||runtimePath,commandRunner,signal});
    let previous;try{previous=await verifyRelease(value.current,{nodePath:value.currentNodePath||nodePath,runtimePath:value.currentRuntimePath||runtimePath,commandRunner,signal});}catch{signal?.throwIfAborted();}
    const registerFn=register||(await import('./command-setup.mjs')).registerCommand;
    signal?.throwIfAborted();await switchCommand(registerFn,next,previous,record,{...value,current:next.projectRoot,previous:value.current,currentNodePath:next.nodePath,currentRuntimePath:next.runtimePath,previousNodePath:previous?.nodePath||value.currentNodePath,previousRuntimePath:previous?.runtimePath||value.currentRuntimePath,releaseVersion:next.version,sha256:value.previousSha256,previousSha256:value.sha256},value);
    return{installed:next.projectRoot,version:next.version,restart:'Restart the registered sudocli command.'};
  });
}
