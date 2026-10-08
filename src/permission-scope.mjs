import {resolve,relative,isAbsolute,dirname,join,delimiter,basename} from 'node:path';
import {lstat,realpath,readFile,mkdtemp,mkdir,open,chmod,chown,rm} from 'node:fs/promises';
import {constants,createReadStream,createWriteStream} from 'node:fs';
import {createHash} from 'node:crypto';
import {pipeline} from 'node:stream/promises';
import {tmpdir} from 'node:os';
import {CODEX_VERSION} from './platforms.mjs';
export function permissionPolicy({permissions='ask',webAccess=false,scope='project',writableRoots=[]}={}){
  if(!['ask','allow-everything'].includes(permissions)||typeof webAccess!=='boolean'||!['read-only','project','full'].includes(scope))throw new Error('Invalid permission scope.');
  const unrestricted=permissions==='allow-everything'&&scope==='full'&&webAccess;
  if(!Array.isArray(writableRoots)||writableRoots.length>32||writableRoots.some(path=>typeof path!=='string'||!isAbsolute(path)||/[\p{Cc}\p{Cf}]/u.test(path)))throw new Error('Write folders must be up to 32 absolute paths.');
  return {permissions,scope,webAccess,writableRoots:scope==='read-only'?[]:[...new Set(writableRoots.map(path=>resolve(path)))],sandbox:scope==='read-only'?'read-only':unrestricted?'danger-full-access':'workspace-write',approvalPolicy:permissions==='ask'?'on-request':'never',networkAccess:webAccess&&scope!=='read-only',unrestricted};
}
export function approvalWithinScope({method,params={}},settings){
  const scope=settings.scope||'project';if(scope==='read-only')return false;
  // Native command approval may bypass its sandbox. With Web Off, no such grant
  // is accepted, even when an explanation describes the command as harmless.
  if(!settings.webAccess&&method!=='item/fileChange/requestApproval'&&method!=='applyPatchApproval')return false;
  if(method==='item/permissions/requestApproval')return scope==='full'&&settings.webAccess;
  if(scope==='full')return true;
  const root=resolve(settings.cwd||process.cwd());const paths=[params.cwd,params.grantRoot,...Object.keys(params.fileChanges||{})].filter(Boolean);
  if(paths.some(path=>![root,...(settings.writableRoots||[])].some(folder=>{const rel=relative(resolve(folder),resolve(root,path));return rel!== '..'&&!rel.startsWith('..'+(process.platform==='win32'?'\\':'/'))&&!isAbsolute(rel);})))return false;
  if(method==='item/commandExecution/requestApproval'||method==='execCommandApproval')return false; // Project scope never unsandboxes commands.
  return true;
}
export function isolatedEnvironment(env=process.env,overrides={}){
  const allowed=new Set(['PATH','PATHEXT','SYSTEMROOT','WINDIR','COMSPEC','TEMP','TMP','TMPDIR','HOME','USERPROFILE','LOCALAPPDATA','APPDATA','LANG','LC_ALL','LC_CTYPE','TERM','TZ','XDG_RUNTIME_DIR']);
  const result={};for(const [name,value] of Object.entries(env))if(allowed.has(name.toUpperCase()))result[name]=value;
  return {...result,...overrides};
}

async function traversable(path,uid,groups){
  for(let current=await realpath(path);;current=dirname(current)){
    const info=await lstat(current);
    if(!(info.mode&(info.uid===uid?0o100:groups.has(info.gid)?0o010:0o001)))return false;
    if(dirname(current)===current)return true;
  }
}

/** Root keeps the UI/provider proxy. Scoped native tools use only an admitted
 * sudo account, never an inferred arbitrary project owner or root groups.
 */
export async function sandboxExecutionIdentity({cwd=process.cwd(),policy={},env=process.env,platform=process.platform}={}){
  if(platform!=='linux'||process.getuid?.()!==0||policy.unrestricted)return undefined;
  const project=await realpath(cwd),info=await lstat(project);
  if(!info.isDirectory())throw new Error('Sandbox project must be a directory.');
  let identity;
  if(/^[1-9][0-9]{0,9}$/.test(env.SUDO_UID||'')&&/^(?:0|[1-9][0-9]{0,9})$/.test(env.SUDO_GID||'')){
    const uid=Number(env.SUDO_UID),gid=Number(env.SUDO_GID);
    if(uid<0xffffffff&&gid<0xffffffff&&info.uid===uid){
      const passwdInfo=await lstat('/etc/passwd');
      if(passwdInfo.isFile()&&passwdInfo.size<=1024*1024){
        const passwd=await readFile('/etc/passwd','utf8');
        const account=passwd.split('\n').map(line=>line.split(':')).find(parts=>parts.length>=7&&Number(parts[2])===uid&&Number(parts[3])===gid&&(!env.SUDO_USER||parts[0]===env.SUDO_USER));
        if(account)identity={uid,gid};
      }
    }
  }
  if(identity){if(!await traversable(project,identity.uid,new Set([identity.gid])))throw new Error('The invoking sudo account cannot traverse the selected project. Choose an accessible project.');return identity;}
  if(!await traversable(project,0,new Set([process.getgid(),...process.getgroups()])))throw new Error('Private Linux project requires sudo from a normal account that owns the selected project.');
  return undefined;
}

export function sandboxChildEnvironment(env,identity,providerArgs=[]){
  if(!identity)return env;
  const result=isolatedEnvironment(env,{HOME:env.CODEX_HOME,CODEX_HOME:env.CODEX_HOME});
  if(typeof env.SUDO_CLI_SESSION_KEY==='string')result.SUDO_CLI_SESSION_KEY=env.SUDO_CLI_SESSION_KEY;
  for(const argument of providerArgs){const name=/^mcp_servers\.[A-Za-z0-9_-]+\.bearer_token_env_var\s*=\s*"(SUDO_MCP_[A-Z0-9_]{1,128})"\s*$/.exec(argument)?.[1];if(name&&typeof env[name]==='string')result[name]=env[name];}
  return result;
}

/** Compilers and test tools receive one disposable scratch root, rather than a
 * write grant for global /tmp or the private configuration/credential home.
 */
export async function createSandboxScratch({identity}={}){
  if(identity&&(process.platform!=='linux'||process.getuid?.()!==0||!Number.isSafeInteger(identity.uid)||identity.uid<=0||identity.uid>=0xffffffff||!Number.isSafeInteger(identity.gid)||identity.gid<0||identity.gid>=0xffffffff))throw new Error('Invalid sandbox scratch identity.');
  const base=await realpath(process.platform==='linux'?'/tmp':tmpdir());
  const directory=await mkdtemp(join(base,'sudo-cli-sandbox-scratch-'));
  const cleanup=async()=>{const target=resolve(directory);if(dirname(target)!==base||!basename(target).startsWith('sudo-cli-sandbox-scratch-'))throw new Error('Unsafe native scratch cleanup path.');await rm(target,{recursive:true,force:true});};
  try{if(identity)await chown(directory,identity.uid,identity.gid);return {path:directory,cleanup};}catch(error){await cleanup();throw error;}
}

/** Native bwrap drops DAC capabilities before reexecuting Codex. A root caller
 * can initially read a runner-owned private home but cannot traverse it after
 * that drop. Relocate only the installed runtime files, never the home itself.
 */
export async function prepareSandboxRuntime(executable,{platform=process.platform,cwd=process.cwd(),env=process.env,identity}={}){
  const unchanged={path:executable,cleanup:async()=>{}};
  if(platform!=='linux')return unchanged;
  if(identity&&(process.getuid?.()!==0||!Number.isSafeInteger(identity.uid)||identity.uid<=0||identity.uid>=0xffffffff||!Number.isSafeInteger(identity.gid)||identity.gid<0||identity.gid>=0xffffffff))throw new Error('Invalid sandbox runtime identity.');
  if(typeof executable!=='string'||!executable)return unchanged;
  let source;
  const candidates=isAbsolute(executable)||executable.includes('/')?[resolve(cwd,executable)]
    :String(env.PATH||'').split(delimiter).filter(Boolean).map(directory=>resolve(cwd,directory,executable));
  for(const candidate of candidates){try{const info=await lstat(candidate);if(info.isFile()||info.isSymbolicLink()){source=await realpath(candidate);break;}}catch{}}
  if(!source)return unchanged; // Keep the native spawn error for unavailable commands.
  const uid=identity?.uid??process.getuid(),groups=new Set(identity?[identity.gid]:[process.getgid(),...process.getgroups()]);
  const canExecute=info=>Boolean(info.mode&(info.uid===uid?0o100:groups.has(info.gid)?0o010:0o001));
  let blocked=false;
  for(let path=source;;path=dirname(path)){
    if(!canExecute(await lstat(path)))blocked=true;
    if(dirname(path)===path)break;
  }
  if(!blocked)return unchanged;
  const packageRoot=resolve(dirname(source),'..');
  const metadataPath=join(packageRoot,'codex-package.json');
  const metadataInfo=await lstat(metadataPath);
  if(!metadataInfo.isFile()||metadataInfo.isSymbolicLink()||metadataInfo.size>2048)throw new Error('Private native runtime package metadata is invalid.');
  let metadata;try{metadata=JSON.parse(await readFile(metadataPath,'utf8'));}catch{throw new Error('Private native runtime package metadata is invalid.');}
  if(metadata?.layoutVersion!==1||metadata.version!==CODEX_VERSION||metadata.variant!=='codex'||metadata.entrypoint!=='bin/codex'||metadata.resourcesDir!=='codex-resources'||metadata.pathDir!=='codex-path'||!['x86_64-unknown-linux-musl','aarch64-unknown-linux-musl'].includes(metadata.target)||source!==join(packageRoot,'bin','codex'))throw new Error('Private native runtime is not the pinned installed Linux package.');
  const directories=new Set();
  const inspectDirectory=async directory=>{
    if(directories.has(directory))return;
    const info=await lstat(join(packageRoot,directory));
    if(!info.isDirectory()||info.isSymbolicLink())throw new Error('Private native runtime package directories are invalid.');
    directories.add(directory);
  };
  for(const directory of ['bin','codex-path','codex-resources'])await inspectDirectory(directory);
  const optionalExists=async path=>{try{await lstat(join(packageRoot,path));return true;}catch(error){if(error.code==='ENOENT')return false;throw error;}};
  const files=new Map(['codex-package.json','bin/codex','bin/codex-code-mode-host','codex-path/rg','codex-resources/bwrap'].map(file=>[file,{executable:file!=='codex-package.json'}]));
  if(await optionalExists('codex-resources/zsh'))files.set('codex-resources/zsh/bin/zsh',{executable:true});
  if(await optionalExists('codex-resources/voice')){
    await inspectDirectory('codex-resources/voice');
    const manifestFile='codex-resources/voice/manifest.json',manifestPath=join(packageRoot,manifestFile),info=await lstat(manifestPath);
    if(!info.isFile()||info.isSymbolicLink()||info.size>64*1024)throw new Error('Private native runtime voice manifest is invalid.');
    let manifest,manifestBytes;try{manifestBytes=await readFile(manifestPath);manifest=JSON.parse(manifestBytes.toString('utf8'));}catch{throw new Error('Private native runtime voice manifest is invalid.');}
    const hashes=manifest?.sha256,entries=hashes&&typeof hashes==='object'&&!Array.isArray(hashes)?Object.entries(hashes):[];
    if(manifest?.schemaVersion!==1||manifest.appVersion!==metadata.version||manifest.appTarget!==metadata.target||!entries.length||entries.length>128||!Object.hasOwn(hashes,'bin/codex'))throw new Error('Private native runtime voice manifest is invalid.');
    for(const [file,digest] of entries){
      const parts=file.split('/');
      if(typeof digest!=='string'||!/^[a-f0-9]{64}$/i.test(digest)||parts.length>8||parts.some(part=>!part||part==='.'||part==='..'||!/^[a-zA-Z0-9_.-]+$/.test(part))||(file!=='bin/codex'&&!file.startsWith('codex-resources/voice/'))||file===manifestFile)throw new Error('Private native runtime voice manifest paths or hashes are invalid.');
      files.set(file,{...files.get(file),digest});
    }
    files.set(manifestFile,{digest:createHash('sha256').update(manifestBytes).digest('hex')});
  }
  const inspected=[];let bytes=0;
  for(const [file,options] of files){
    const components=file.split('/');for(let index=1;index<components.length;index++)await inspectDirectory(components.slice(0,index).join('/'));
    const path=join(packageRoot,file),info=await lstat(path);bytes+=info.size;
    if(!info.isFile()||info.isSymbolicLink()||info.size>512*1024*1024||bytes>1024*1024*1024||(options.executable&&!(info.mode&0o111)))throw new Error('Private native runtime package files are invalid.');
    inspected.push({file,path,info,...options});
  }
  // Ignore TMPDIR: it can itself be behind the inaccessible home. The owned
  // directory contains public runtime artifacts only and stays mode 0700.
  const base=await realpath('/tmp');
  if(!await traversable(base,uid,groups))throw new Error('No traversable neutral native runtime directory is available.');
  const directory=await mkdtemp(join(base,'sudo-cli-sandbox-runtime-'));
  let cleaned=false;
  const cleanup=async()=>{
    if(cleaned)return;
    const target=resolve(directory);
    if(dirname(target)!==base||!basename(target).startsWith('sudo-cli-sandbox-runtime-'))throw new Error('Unsafe native runtime cleanup path.');
    await rm(target,{recursive:true,force:true});cleaned=true;
  };
  try{
    for(const {file,path,info,digest} of inspected){
      const destination=join(directory,file);await mkdir(dirname(destination),{recursive:true,mode:0o755});
      const handle=await open(path,constants.O_RDONLY|constants.O_NOFOLLOW);
      try{
        const opened=await handle.stat();
        if(opened.ino!==info.ino||opened.dev!==info.dev||opened.size!==info.size||opened.mtimeMs!==info.mtimeMs||await realpath(path)!==path)throw new Error('Native runtime changed while preparing its sandbox copy.');
        await pipeline(handle.createReadStream({autoClose:false,end:Math.max(0,info.size-1)}),createWriteStream(destination,{flags:'wx',mode:info.mode&0o111?0o755:0o644}));
      }finally{await handle.close();}
      await chmod(destination,info.mode&0o111?0o755:0o644);
      const after=await lstat(path);
      if(after.isSymbolicLink()||after.ino!==info.ino||after.dev!==info.dev||after.size!==info.size||after.mtimeMs!==info.mtimeMs)throw new Error('Native runtime changed while preparing its sandbox copy.');
      if(digest){const hash=createHash('sha256');for await(const chunk of createReadStream(destination))hash.update(chunk);if(hash.digest('hex')!==digest.toLowerCase())throw new Error('Private native runtime voice resource hash does not match its manifest.');}
    }
    if(identity)await chown(directory,identity.uid,identity.gid);
    return {path:join(directory,'bin','codex'),cleanup};
  }catch(error){await cleanup();throw error;}
}
