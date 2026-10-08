import {constants} from 'node:fs';
import {lstat,realpath,opendir,open,mkdtemp,mkdir,writeFile,rm} from 'node:fs/promises';
import {resolve,join,relative,isAbsolute,sep,dirname,basename} from 'node:path';
import {tmpdir} from 'node:os';
import {createHash} from 'node:crypto';
import {execFile} from 'node:child_process';
import {isolatedEnvironment} from './permission-scope.mjs';
import {isExcludedWorkspacePath,redactWorkspaceText} from './workspace-tools.mjs';

const PREVIEW_BYTES=64*1024, CONTENT_BYTES=16*1024*1024;
const within=(root,path)=>{const value=relative(root,path);return !value||!isAbsolute(value)&&value!=='..'&&!value.startsWith(`..${sep}`);};
const cleanPath=path=>typeof path==='string'&&path.length>0&&path.length<=4096&&!isAbsolute(path)&&!/[\\\u0000-\u001f\u007f-\u009f:]/.test(path)
  &&path.split('/').every(part=>part&&part!=='.'&&part!=='..'&&!/[. ]$/.test(part)&&!/^(CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])(?:\.|$)/i.test(part));
const same=(a,b)=>a.dev===b.dev&&a.ino===b.ino;
const stable=(a,b)=>same(a,b)&&a.size===b.size&&a.mtimeNs===b.mtimeNs&&a.ctimeNs===b.ctimeNs&&a.mode===b.mode&&b.nlink===1n;
const fingerprint=info=>[info.size,info.mtimeNs,info.ctimeNs,info.mode].join(':');
const cap=(value,fallback,max)=>{value??=fallback;if(!Number.isSafeInteger(value)||value<1||value>max)throw new Error('Project change limits must be positive bounded integers.');return value;};
const unavailable=()=>new Error('Project change path is excluded, outside the project or unavailable.');

/** Read-only, session-local inventory. Public state contains relative paths and status only. */
export function createProjectChanges({cwd=process.cwd(),secrets=()=>[],excludePaths=[],maxFiles=10000,maxEntries=20000}={}){
  maxFiles=cap(maxFiles,10000,20000);maxEntries=cap(maxEntries,20000,50000);
  if(!Array.isArray(excludePaths)||excludePaths.some(path=>typeof path!=='string'))throw new Error('Project change exclusions must be paths.');
  const excluded=excludePaths.map(path=>resolve(path));
  let root,rootIdentity,baseline,latest,gitView,closing,gitFallback=false,gitUntracked=new Set(),mode='scan',initialized=false,closed=false,tail=Promise.resolve(),pendingRefresh;
  let state={files:[],partial:false,updatedAt:null};const controller=new AbortController();
  const safeText=text=>redactWorkspaceText(String(text),secrets).replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]/g,'�');
  const allowed=path=>cleanPath(path)&&!isExcludedWorkspacePath(path)&&safeText(path)===path&&(!root||!excluded.some(directory=>within(directory,join(root,...path.split('/')))));
  const check=()=>{if(closed)throw new Error('Project changes service is closed.');controller.signal.throwIfAborted();};
  const snapshot=()=>({...state,files:state.files.filter(file=>allowed(file.path)).map(file=>({...file}))});
  const queue=fn=>{const result=tail.then(()=>{check();return fn();});tail=result.catch(()=>{});return result;};
  async function checkRoot(){check();const info=await lstat(root,{bigint:true});if(info.isSymbolicLink()||!info.isDirectory()||!same(rootIdentity,info)||await realpath(root)!==root)throw unavailable();}
  async function inspect(path){
    if(!allowed(path))throw unavailable();await checkRoot();let current=root;const parts=path.split('/');
    for(const [index,part] of parts.entries()){
      current=join(current,part);if(!within(root,current))throw unavailable();
      let info;try{info=await lstat(current,{bigint:true});}catch(error){if(error.code==='ENOENT')return null;throw unavailable();}
      if(info.isSymbolicLink()||index<parts.length-1&&!info.isDirectory())throw unavailable();
      if(index===parts.length-1){if(!info.isFile()||info.nlink!==1n)throw unavailable();return{absolute:current,info};}
    }
  }
  async function content(path,budget){
    const entry=await inspect(path);if(!entry)return null;const {absolute,info}=entry;
    const record={fingerprint:fingerprint(info),size:Number(info.size),mode:Number(info.mode&0o777n)};
    if(info.size>1024n*1024n||Number(info.size)>budget.bytes)return record;
    let handle;
    try{
      handle=await open(absolute,constants.O_RDONLY|(constants.O_NOFOLLOW||0));const opened=await handle.stat({bigint:true});if(!stable(info,opened))throw unavailable();
      const buffer=Buffer.alloc(Number(info.size)+1);let offset=0;
      while(offset<buffer.length){check();const {bytesRead}=await handle.read(buffer,offset,buffer.length-offset,offset);if(!bytesRead)break;offset+=bytesRead;}
      if(offset!==Number(info.size)||!stable(info,await handle.stat({bigint:true}))||!stable(info,(await inspect(path))?.info||{}))throw unavailable();
      const data=buffer.subarray(0,offset);record.hash=createHash('sha256').update(data).digest('hex');budget.bytes-=offset;
      if(offset<=PREVIEW_BYTES)record.data=data;return record;
    }finally{await handle?.close();}
  }
  async function scan(){
    await checkRoot();const files=new Map(),budget={bytes:CONTENT_BYTES};let entries=0,partial=false,stopped=false;
    async function visit(directory,prefix,depth){
      check();if(depth>32){partial=true;return;}let stream;
      try{
        const original=await lstat(directory,{bigint:true});if(original.isSymbolicLink()||!original.isDirectory())throw unavailable();
        stream=await opendir(directory);const verified=await lstat(directory,{bigint:true});if(!same(original,verified)||verified.isSymbolicLink())throw unavailable();
        for await(const entry of stream){
          check();if(++entries>maxEntries){partial=true;stopped=true;break;}
          const path=prefix?`${prefix}/${entry.name}`:entry.name;
          if(!allowed(path))continue;
          const absolute=join(directory,entry.name);let info;
          try{info=await lstat(absolute,{bigint:true});}catch{partial=true;continue;}
          if(info.isSymbolicLink()){partial=true;continue;}
          if(info.isDirectory())await visit(absolute,path,depth+1);
          else if(info.isFile()){
            if(files.size>=maxFiles){partial=true;stopped=true;break;}
            try{const file=await content(path,budget);if(file)files.set(path,file);else partial=true;}catch{check();partial=true;}
          }
          if(stopped)break;
        }
      }catch{check();partial=true;}finally{await stream?.close().catch(()=>{});}
    }
    await visit(root,'',0);return{files,partial};
  }
  function git(args,maxBuffer=2*1024*1024,original=false){
    check();const view=original?null:gitView;
    return new Promise((success,failure)=>execFile('git',['--no-pager','--no-optional-locks',...(view?['--git-dir='+view.directory,'--work-tree='+root]:[]),'-c','core.fsmonitor=false','-c','core.hooksPath=','-c','color.ui=false','-c','status.renames=false','-c',`safe.directory=${root}`,...args],{
      cwd:root,windowsHide:true,shell:false,encoding:'buffer',timeout:5000,maxBuffer,signal:controller.signal,
      env:isolatedEnvironment(process.env,{GIT_CONFIG_NOSYSTEM:'1',GIT_CONFIG_GLOBAL:process.platform==='win32'?'NUL':'/dev/null',GIT_ATTR_NOSYSTEM:'1',GIT_TERMINAL_PROMPT:'0',GIT_OPTIONAL_LOCKS:'0',LC_ALL:'C',...(view?{GIT_OBJECT_DIRECTORY:view.objects,GIT_INDEX_FILE:join(view.directory,'index')}:{})})
    },(error,stdout)=>error?failure(new Error('Git project inspection is unavailable.')):success(stdout)));
  }
  async function metadata(path,limit){
    let info;try{info=await lstat(path,{bigint:true});}catch(error){if(error.code==='ENOENT')return null;throw unavailable();}
    if(!info.isFile()||info.isSymbolicLink()||info.nlink!==1n||info.size>BigInt(limit))throw unavailable();let handle;
    try{handle=await open(path,constants.O_RDONLY|(constants.O_NOFOLLOW||0));if(!stable(info,await handle.stat({bigint:true})))throw unavailable();const buffer=Buffer.alloc(Number(info.size)+1);let offset=0;while(offset<buffer.length){check();const {bytesRead}=await handle.read(buffer,offset,buffer.length-offset,offset);if(!bytesRead)break;offset+=bytesRead;}if(offset!==Number(info.size)||!stable(info,await handle.stat({bigint:true}))||!stable(info,await lstat(path,{bigint:true})))throw unavailable();return buffer.subarray(0,offset);}
    finally{await handle?.close();}
  }
  async function plainDirectory(path){const info=await lstat(path);if(!info.isDirectory()||info.isSymbolicLink()||await realpath(path)!==path)throw unavailable();}
  async function checkViewIdentity(view){
    try{if(!isAbsolute(view.directory)||dirname(view.directory)!==view.tempRoot||!/^sudo-cli-git-view-[a-z0-9]{6}$/i.test(basename(view.directory)))throw unavailable();
      const parent=await lstat(view.tempRoot,{bigint:true}),directory=await lstat(view.directory,{bigint:true});
      if(!parent.isDirectory()||parent.isSymbolicLink()||!same(parent,view.tempIdentity)||await realpath(view.tempRoot)!==view.tempRoot||!directory.isDirectory()||directory.isSymbolicLink()||!same(directory,view.identity)||await realpath(view.directory)!==view.directory)throw unavailable();
    }catch{throw new Error('Project change temporary metadata identity changed; cleanup refused.');}
  }
  async function ordinaryObjects(objects){
    await plainDirectory(objects);let count=0;
    async function visit(path,depth){let stream;try{stream=await opendir(path);for await(const entry of stream){check();if(++count>50000||entry.isSymbolicLink())throw unavailable();const child=join(path,entry.name);if(entry.isDirectory()){if(depth>1)throw unavailable();await plainDirectory(child);await visit(child,depth+1);}else if(!entry.isFile())throw unavailable();}}finally{await stream?.close().catch(()=>{});}}
    await visit(objects,0);
    for(const name of ['alternates','http-alternates']){try{await lstat(join(objects,'info',name));throw unavailable();}catch(error){if(error.code!=='ENOENT')throw unavailable();}}
  }
  async function checkObjects(){
    try{await checkViewIdentity(gitView);const info=await lstat(gitView.objects,{bigint:true});if(!info.isDirectory()||info.isSymbolicLink()||!same(info,gitView.objectIdentity))throw unavailable();await ordinaryObjects(gitView.objects);}
    catch{check();throw unavailable();}
  }
  async function safeGit(){
    gitFallback=false;
    try{const source=join(root,'.git');let info;try{info=await lstat(source);}catch(error){if(error.code==='ENOENT')return false;throw error;}
      gitFallback=true;if(!info.isDirectory()||info.isSymbolicLink())return false;await plainDirectory(source);
      const top=(await git(['rev-parse','--show-toplevel'],8192,true)).toString('utf8').trim();if(await realpath(top)!==root)return false;
      if((await git(['rev-parse','--show-object-format'],128,true)).toString('utf8').trim()!=='sha1')return false;
      const objects=join(source,'objects');await ordinaryObjects(objects);
      for(const name of ['commondir','config.worktree']){try{await lstat(join(source,name));return false;}catch(error){if(error.code!=='ENOENT')throw unavailable();}}
      const head=await metadata(join(source,'HEAD'),4096),index=await metadata(join(source,'index'),8*1024*1024);if(!head)return false;
      let commit;try{commit=(await git(['rev-parse','--verify','HEAD'],128,true)).toString('utf8').trim();if(!/^[a-f0-9]{40}$/.test(commit))return false;}catch{check();if(!/^ref: refs\/[^\r\n]+\r?\n?$/.test(head.toString('utf8')))return false;}
      if(!gitView){const tempRoot=await realpath(tmpdir()),tempIdentity=await lstat(tempRoot,{bigint:true});if(!tempIdentity.isDirectory()||tempIdentity.isSymbolicLink())throw unavailable();const directory=await mkdtemp(join(tempRoot,'sudo-cli-git-view-'));gitView={directory,objects,tempRoot,tempIdentity};gitView.identity=await lstat(directory,{bigint:true});await checkViewIdentity(gitView);await mkdir(join(directory,'refs'));await mkdir(join(directory,'objects'));}
      gitView.objects=objects;gitView.objectIdentity=await lstat(objects,{bigint:true});let filemode=false;try{filemode=(await git(['config','--bool','core.filemode'],128,true)).toString('utf8').trim()==='true';}catch{check();}
      // No repository/global driver config is copied. Attribute filter names are
      // inert in this private view, including drivers added during inspection.
      await checkViewIdentity(gitView);
      await writeFile(join(gitView.directory,'config'),`[core]\nrepositoryformatversion=0\nbare=false\nfilemode=${filemode}\n`);
      await writeFile(join(gitView.directory,'HEAD'),commit?commit+'\n':'ref: refs/heads/read-only-view\n');
      if(index)await writeFile(join(gitView.directory,'index'),index);else await rm(join(gitView.directory,'index'),{force:true});
      gitFallback=false;return true;
    }catch{check();return false;}
  }
  async function gitChanges(){
    const raw=await git(['status','--porcelain=v1','-z','--untracked-files=all','--ignore-submodules=all']);const files=new Map(),untracked=new Set();let partial=false;
    for(const entry of new TextDecoder('utf-8',{fatal:true}).decode(raw).split('\0').filter(Boolean)){
      if(entry.length<4||entry[2]!==' '||!/^[ MADRCTU?!]{2}$/.test(entry.slice(0,2)))throw new Error('Git project inspection is unavailable.');
      const path=entry.slice(3);if(!allowed(path))continue;
      if(entry.slice(0,2)==='??')untracked.add(path);
      try{
        const current=await inspect(path);let status=!current?'deleted':entry.slice(0,2)==='??'||entry.slice(0,2).includes('A')?'added':'modified';
        if(files.has(path)&&files.get(path)!==status)status='modified';files.set(path,status);
      }catch{check();partial=true;}
      if(files.size>=maxFiles){partial=true;break;}
    }
    return{files:[...files].sort(([a],[b])=>a.localeCompare(b)).map(([path,status])=>({path,status})),partial,untracked};
  }
  async function reconcile(){
    const current=await scan();let files=[],partial=current.partial||baseline.partial,reason;gitUntracked=new Set();
    if(await safeGit()){
      try{const changes=await gitChanges();mode='git';files=changes.files;partial=changes.partial;gitUntracked=changes.untracked;}
      catch{check();mode='scan';reason='Git inspection unavailable; showing changes since this session opened.';}
    }else mode='scan';
    if(mode==='scan'){
      if(gitFallback){partial=true;reason='Git metadata is unsupported or unsafe; showing only session-baseline changes. Staged changes are unavailable.';}
      reason??='Showing project changes since this session opened; Git is optional.';
      const recoveryBudget={bytes:CONTENT_BYTES};
      for(const [path,before] of baseline.files){
        let after=current.files.get(path);
        if(!after){try{const found=await inspect(path);if(!found){files.push({path,status:'deleted'});continue;}after=await content(path,recoveryBudget);if(!after){files.push({path,status:'deleted'});continue;}}catch{check();partial=true;continue;}}
        if(before.mode!==after.mode||(before.hash&&after.hash?before.hash!==after.hash:before.fingerprint!==after.fingerprint))files.push({path,status:'modified'});
      }
      if(!baseline.partial)for(const path of current.files.keys())if(!baseline.files.has(path))files.push({path,status:'added'});
      files.sort((a,b)=>a.path.localeCompare(b.path));
    }
    latest=current;state={files,partial,...(partial?{reason:reason||'Some paths could not be inspected safely or exceeded inventory limits.'}:reason?{reason}:{}),updatedAt:new Date().toISOString()};return snapshot();
  }
  async function initialize(){return queue(async()=>{if(initialized)return snapshot();root=await realpath(resolve(cwd));rootIdentity=await lstat(root,{bigint:true});if(!rootIdentity.isDirectory())throw unavailable();baseline=await scan();initialized=true;return reconcile();});}
  function refresh(){if(pendingRefresh)return pendingRefresh;pendingRefresh=queue(async()=>{if(!initialized)throw new Error('Initialize project changes before refreshing.');return reconcile();}).finally(()=>{pendingRefresh=undefined;});return pendingRefresh;}
  function diff(path){return queue(async()=>{
    if(!initialized||!allowed(path)||!state.files.some(file=>file.path===path))throw unavailable();await inspect(path);
    let text;
    if(mode==='git'){
      await checkObjects();
      const literal=`:(literal)${path}`;let staged,working;
      try{staged=(await git(['diff','--cached','--no-ext-diff','--no-textconv','--no-renames','--',literal],256*1024)).toString('utf8');await checkObjects();working=(await git(['diff','--no-ext-diff','--no-textconv','--no-renames','--',literal],256*1024)).toString('utf8');await checkObjects();}
      catch{check();return 'Diff unavailable: Git preview failed or exceeded its output limit.';}
      text=[staged?`Staged changes\n${staged}`:'',working?`Working tree changes\n${working}`:''].filter(Boolean).join('\n');
      if(gitUntracked.has(path))text+=`\nUntracked working file\n${textPreview(undefined,await content(path,{bytes:CONTENT_BYTES}),path)}`;
      if(text)return boundedDiff(text);
    }
    const before=mode==='git'?undefined:baseline.files.get(path),after=await content(path,{bytes:CONTENT_BYTES});
    return boundedDiff(textPreview(before,after,path));
  });}
  function textPreview(before,after,path){
    if([before,after].some(file=>file&&!file.data))return 'Diff unavailable: file exceeds the bounded preview limit.';
    if([before,after].some(file=>file?.data?.includes(0)))return 'Binary file changed; text preview unavailable.';
    let text=`--- ${before?'a/'+path:'/dev/null'}\n+++ ${after?'b/'+path:'/dev/null'}\n`;
    if(before)text+=before.data.toString('utf8').split('\n').map(line=>`-${line}\n`).join('');if(after)text+=after.data.toString('utf8').split('\n').map(line=>`+${line}\n`).join('');return text;
  }
  function boundedDiff(text){const safe=safeText(text),bytes=Buffer.from(safe);if(bytes.length<=PREVIEW_BYTES)return safe;return new TextDecoder().decode(bytes.subarray(0,PREVIEW_BYTES-64),{stream:true})+'\n[Diff preview truncated at 64 KiB.]\n';}
  function close(){if(!closing){closed=true;controller.abort();closing=(async()=>{await tail;try{if(gitView){await checkViewIdentity(gitView);await rm(gitView.directory,{recursive:true,force:true});}}finally{gitView=undefined;for(const record of [baseline,latest])for(const file of record?.files.values()||[])file.data?.fill(0);baseline=latest=undefined;state={files:[],partial:false,updatedAt:null};}})();}return closing;}
  return{initialize,refresh,snapshot,diff,close};
}
