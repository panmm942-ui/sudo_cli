import {execFile} from 'node:child_process';
import {createHash} from 'node:crypto';
import {constants} from 'node:fs';
import {chmod,chown,lstat,mkdir,mkdtemp,open,readFile,realpath,rm} from 'node:fs/promises';
import {createServer} from 'node:net';
import {basename,dirname,join,resolve,posix} from 'node:path';
import {fileURLToPath} from 'node:url';
import {CODEX_VERSION,platformRuntime} from '../../src/platforms.mjs';
import {isolatedEnvironment,sandboxExecutionIdentity} from '../../src/permission-scope.mjs';

const defaultRoot=resolve(dirname(fileURLToPath(import.meta.url)),'../..');
const profileFile='/etc/apparmor.d/sudo-cli-ci-native-userns';
const profileNames=['sudo-cli-ci-native-installed','sudo-cli-ci-native-staged'];
export const BWRAP_PINS=Object.freeze({
  x64:Object.freeze({bytes:529776,sha256:'77360cb751ccedc5971391444ac86a8a33c15b04d6b4a6fe45f5d25496e62c4c'}),
  arm64:Object.freeze({bytes:529168,sha256:'c547cbdc762a70ed216789ffaa4c6c0e7d2beabe32245a498f8e365a9fc8dab4'})
});

export function ciInvocation({env=process.env,platform=process.platform,uid=process.getuid?.(),projectRoot=defaultRoot}={}){
  if(platform!=='linux'||uid!==0||env.CI!=='true'||env.GITHUB_ACTIONS!=='true'||env.GITHUB_WORKSPACE!==projectRoot||!/^\/[A-Za-z0-9_./-]+$/.test(projectRoot)||posix.resolve(projectRoot)!==projectRoot)throw new Error('Native preflight is restricted to root Linux GitHub Actions in its canonical checkout.');
  return projectRoot;
}

/** This orchestrator never treats a generic EPERM or a failed enforcement check
 * as permission to change the host. The real evidence callback requires fresh
 * AppArmor records belonging to the probe's launcher or reported child PID. */
export async function conditionalUsernsPreflight({paths,probe,appArmorEvidence,installAllowance}){
  try{for(const path of paths)await probe(path);return {profileInstalled:false,probes:paths.length};}
  catch(error){
    if(!await appArmorEvidence(error))throw new Error('Native sandbox preflight failed without proved AppArmor userns denial.',{cause:error});
    const cleanup=await installAllowance(paths);
    try{for(const path of paths)await probe(path);return {profileInstalled:true,probes:paths.length};}
    catch(error){await cleanup?.();throw new Error('Native sandbox enforcement still fails after the CI userns allowance.',{cause:error});}
  }
}

export function usernsProfile(installed,staged){
  if(!/^\/[A-Za-z0-9_./-]+\/runtime\/linux-(?:x64|arm64)\/codex-resources\/bwrap$/.test(installed)||posix.resolve(installed)!==installed||!/^\/tmp\/sudo-cli-sandbox-runtime-[A-Za-z0-9]{6}\/codex-resources\/bwrap$/.test(staged))throw new Error('Invalid trusted CI Bubblewrap attachment paths.');
  // Only the exact installed executable and the product's fixed six-character
  // mkdtemp prefix. No recursive /tmp wildcard, neighboring binary or shell.
  const attachment='/tmp/sudo-cli-sandbox-runtime-??????/codex-resources/bwrap';
  return `# Generated only by the guarded SUDO CLI GitHub Actions preflight.\nabi <abi/4.0>,\ninclude <tunables/global>\n\nprofile ${profileNames[0]} "${installed}" flags=(unconfined) {\n  userns,\n}\n\nprofile ${profileNames[1]} "${attachment}" flags=(unconfined) {\n  userns,\n}\n`;
}

export function provedAppArmorDenial(error,{restricted,enabled,log}={}){
  if(restricted!=='1'||enabled!=='Y'||typeof log!=='string'||log.length>256*1024||!Array.isArray(error?.probePids)||!error.probePids.length)return false;
  return log.split('\n').some(line=>{
    const pid=Number(/\bpid=(\d+)\b/.exec(line)?.[1]);
    return error.probePids.includes(pid)&&/apparmor="DENIED"/.test(line)&&/comm="bwrap"/.test(line)&&/operation="(?:capable|userns_create)"/.test(line)&&(/profile="unprivileged_userns"/.test(line)||/operation="userns_create"/.test(line)&&/profile="unconfined"/.test(line));
  });
}

export function dmesgTimestamp(value=Date.now()){
  if(!Number.isSafeInteger(value)||value<0||value>253402300799999)throw new Error('Invalid native probe timestamp.');
  // util-linux --since accepts a local absolute timestamp, not JS's trailing Z.
  // freshAppArmorEvidence fixes TZ=UTC, so this UTC text denotes the same instant.
  return new Date(value).toISOString().replace('T',' ').replace(/Z$/,'');
}

async function regularBytes(path,{maximum,bytes,sha256,rootOwned=false,executable=false}={}){
  const file=await open(path,constants.O_RDONLY|constants.O_NOFOLLOW);
  try{
    const info=await file.stat();
    if(!info.isFile()||info.nlink!==1||info.size>maximum||bytes!==undefined&&info.size!==bytes||info.mode&0o022||rootOwned&&info.uid!==0||executable&&!(info.mode&0o111))throw new Error('Untrusted CI native resource or system file.');
    const value=await file.readFile(),after=await file.stat();
    if(after.size!==info.size||after.mtimeMs!==info.mtimeMs||after.ctimeMs!==info.ctimeMs||sha256&&createHash('sha256').update(value).digest('hex')!==sha256)throw new Error('CI native resource changed or failed its pinned digest.');
    return value;
  }finally{await file.close();}
}

async function canonicalDirectories(path){
  for(let current=path;;current=dirname(current)){
    const info=await lstat(current);if(!info.isDirectory()||info.isSymbolicLink()||await realpath(current)!==current)throw new Error('CI native paths must have real canonical directory ancestors.');
    if(dirname(current)===current)break;
  }
}

export async function pinnedBwrap(projectRoot,arch=process.arch){
  const pin=BWRAP_PINS[arch];if(!pin)throw new Error('Unsupported Linux CI native architecture.');
  const target=platformRuntime('linux',arch),packageRoot=join(projectRoot,'runtime',target.id);
  await canonicalDirectories(join(packageRoot,'codex-resources'));
  let metadata,provenance;try{
    metadata=JSON.parse((await regularBytes(join(packageRoot,'codex-package.json'),{maximum:4096})).toString());
    provenance=JSON.parse((await regularBytes(join(packageRoot,'sudo-runtime.json'),{maximum:4096})).toString());
  }catch(error){if(error.code==='ENOENT')throw error;throw new Error('CI native package metadata is not a safe pinned record.');}
  if(metadata.layoutVersion!==1||metadata.version!==CODEX_VERSION||metadata.target!==target.triple||metadata.variant!=='codex'||metadata.entrypoint!=='bin/codex'||metadata.resourcesDir!=='codex-resources'||metadata.pathDir!=='codex-path'||provenance.codexVersion!==CODEX_VERSION||provenance.platform!==target.id||provenance.source!==target.url||provenance.archiveBytes!==target.bytes||provenance.archiveSha256!==target.sha256)throw new Error('CI native runtime is not the pinned official Linux package.');
  const path=join(packageRoot,'codex-resources','bwrap'),value=await regularBytes(path,{maximum:1024*1024,...pin,executable:true});
  return {path,value,pin};
}

function execute(file,args,options={}){
  return new Promise((resolve,reject)=>{
    const child=execFile(file,args,{shell:false,windowsHide:true,timeout:12000,maxBuffer:256*1024,...options},(error,stdout,stderr)=>{
      const probePids=[child.pid,...Array.from((String(stdout)+'\n'+String(stderr)).matchAll(/"child-pid"\s*:\s*(\d+)/g),match=>Number(match[1]))].filter(pid=>Number.isSafeInteger(pid)&&pid>0);
      if(error){const failure=new Error('CI native subprocess failed.');Object.assign(failure,{probePids,stderr:String(stderr).slice(0,4096),code:error.code});reject(failure);}else resolve({stdout:String(stdout),stderr:String(stderr),probePids});
    });
  });
}

const probeScript=`const fs=require('node:fs'),net=require('node:net');const [project,scratch,outside,port,baseline]=process.argv.slice(1);let projectWrite=false,scratchWrite=false,outsideWrite=false;for(const [path,key] of [[project,'project'],[scratch,'scratch'],[outside,'outside']]){try{fs.writeFileSync(path+'/probe-'+(baseline?'host':'sandbox'),'bounded native preflight');if(key==='project')projectWrite=true;if(key==='scratch')scratchWrite=true;if(key==='outside')outsideWrite=true;}catch{}}const credentialsInherited=['OPENAI_API_KEY','AWS_SECRET_ACCESS_KEY','SUDO_CLI_SESSION_KEY'].some(name=>process.env[name]!==undefined);const socket=net.connect({host:'127.0.0.1',port:Number(port)});let finished=false;function finish(network){if(finished)return;finished=true;socket.destroy();console.log(JSON.stringify({projectWrite,scratchWrite,outsideWrite,network,credentialsInherited}));}socket.setTimeout(1500,()=>finish(false));socket.once('connect',()=>finish(true));socket.once('error',()=>finish(false));`;

export async function probeBwrap({path,identity,project,scratch,outside,port,env={},baseline=false}){
  const args=['-e',probeScript,project,scratch,outside,String(port),baseline?'host':''];
  const common={uid:identity.uid,gid:identity.gid,cwd:project,env:isolatedEnvironment(env,{HOME:project,TMPDIR:scratch,TMP:scratch,TEMP:scratch})};
  const result=baseline?await execute(process.execPath,args,common):await execute(path,['--info-fd','2','--unshare-user','--uid','0','--gid','0','--unshare-net','--unshare-pid','--new-session','--die-with-parent','--ro-bind','/','/','--bind',project,project,'--bind',scratch,scratch,'--proc','/proc','--dev','/dev','--cap-drop','ALL','--chdir',project,'--',process.execPath,...args],common);
  let proof;try{proof=JSON.parse(result.stdout.trim().split('\n').at(-1));}catch{const error=new Error('Native preflight produced no valid enforcement receipt.');error.probeOutput=result.stdout.slice(0,4096);throw error;}
  if(proof.projectWrite!==true||proof.scratchWrite!==true||proof.outsideWrite!==baseline||proof.network!==baseline||proof.credentialsInherited!==false)throw new Error('Native preflight failed filesystem, network or environment enforcement.');
  return proof;
}

async function systemExecutable(path){
  await canonicalDirectories(dirname(path));await regularBytes(path,{maximum:16*1024*1024,rootOwned:true,executable:true});return path;
}

async function freshAppArmorEvidence(error,since){
  try{
    const restricted=(await readFile('/proc/sys/kernel/apparmor_restrict_unprivileged_userns','utf8')).trim(),enabled=(await readFile('/sys/module/apparmor/parameters/enabled','utf8')).trim();
    if(restricted!=='1'||enabled!=='Y')return false;
    const dmesg=await systemExecutable('/usr/bin/dmesg');
    const {stdout}=await execute(dmesg,['--since',since,'--time-format','iso'],{timeout:3000,env:isolatedEnvironment(process.env,{TZ:'UTC',LC_ALL:'C'})});
    return provedAppArmorDenial(error,{restricted,enabled,log:stdout});
  }catch{return false;}
}

async function checkedProfileDirectory(){
  await canonicalDirectories(dirname(profileFile));const info=await lstat(dirname(profileFile));if(info.uid!==0||info.mode&0o022)throw new Error('Untrusted AppArmor profile directory.');
}

async function removeAllowance(content){
  await checkedProfileDirectory();
  try{const existing=await regularBytes(profileFile,{maximum:8192,rootOwned:true});if(existing.toString()!==content)throw new Error('Refusing to remove an unrelated AppArmor profile.');}catch(error){if(error.code==='ENOENT')return false;throw error;}
  const parser=await systemExecutable('/usr/sbin/apparmor_parser');
  await execute(parser,['-R',profileFile],{timeout:5000,env:isolatedEnvironment(process.env)});
  await rm(profileFile);return true;
}

async function installAllowance(paths){
  const content=usernsProfile(...paths);await checkedProfileDirectory();
  const parser=await systemExecutable('/usr/sbin/apparmor_parser');let created=false;
  try{
    const file=await open(profileFile,constants.O_WRONLY|constants.O_CREAT|constants.O_EXCL|constants.O_NOFOLLOW,0o644);created=true;
    try{await file.writeFile(content);await file.sync();}finally{await file.close();}
  }catch(error){if(error.code!=='EEXIST')throw error;const existing=await regularBytes(profileFile,{maximum:8192,rootOwned:true});if(existing.toString()!==content)throw new Error('Refusing to replace an unrelated AppArmor profile.');}
  try{
    await execute(parser,['-r',profileFile],{timeout:5000,env:isolatedEnvironment(process.env)});
    const loaded=await readFile('/sys/kernel/security/apparmor/profiles','utf8');
    if(!profileNames.every(name=>loaded.split('\n').some(line=>line===name+' (unconfined)')))throw new Error('CI userns profiles were not loaded in the expected mode.');
  }catch(error){if(created){await execute(parser,['-R',profileFile],{timeout:5000,env:isolatedEnvironment(process.env)}).catch(()=>{});await rm(profileFile);}throw error;}
  return ()=>removeAllowance(content);
}

export async function runLinuxCiPreflight({projectRoot=defaultRoot,env=process.env,cleanup=false,arch=process.arch}={}){
  ciInvocation({projectRoot,env});await canonicalDirectories(projectRoot);
  const identity=await sandboxExecutionIdentity({cwd:projectRoot,env});if(!identity)throw new Error('CI preflight requires the verified non-root sudo checkout owner.');
  const source=await pinnedBwrap(projectRoot,arch),base=await realpath('/tmp');if(base!=='/tmp')throw new Error('CI staged native prefix requires canonical /tmp.');
  if(cleanup)return {removed:await removeAllowance(usernsProfile(source.path,'/tmp/sudo-cli-sandbox-runtime-Ab1cD2/codex-resources/bwrap'))};
  const fixture=await mkdtemp('/tmp/sudo-cli-ci-native-'),stage=await mkdtemp('/tmp/sudo-cli-sandbox-runtime-');
  const server=createServer(socket=>socket.end());
  try{
    await chmod(fixture,0o700);await chown(fixture,identity.uid,identity.gid);await chmod(stage,0o700);await chown(stage,identity.uid,identity.gid);
    const directories=Object.fromEntries(['project','scratch','outside'].map(name=>[name,join(fixture,name)]));
    for(const path of Object.values(directories)){await mkdir(path,{mode:0o700});await chown(path,identity.uid,identity.gid);}
    await mkdir(join(stage,'codex-resources'),{mode:0o755});
    const staged=join(stage,'codex-resources','bwrap'),file=await open(staged,'wx',0o755);try{await file.writeFile(source.value);await file.sync();}finally{await file.close();}
    await regularBytes(staged,{maximum:1024*1024,...source.pin,rootOwned:true,executable:true});
    await new Promise((resolve,reject)=>{server.once('error',reject);server.listen(0,'127.0.0.1',resolve);});
    const settings={...directories,identity,port:server.address().port,env};
    const baseline=await probeBwrap({...settings,baseline:true});
    const proofs=[];
    const result=await conditionalUsernsPreflight({paths:[source.path,staged],probe:async path=>{
      const since=dmesgTimestamp(Date.now()-1000);try{proofs.push({location:path===source.path?'installed':'staged',...await probeBwrap({...settings,path})});}catch(error){error.probeSince=since;throw error;}
    },appArmorEvidence:error=>freshAppArmorEvidence(error,error.probeSince),installAllowance});
    return {...result,architecture:arch,baseline,proofs,modelRequests:0};
  }finally{
    if(server.listening)await new Promise(resolve=>server.close(resolve));
    for(const [path,prefix] of [[fixture,'sudo-cli-ci-native-'],[stage,'sudo-cli-sandbox-runtime-']])if(dirname(path)==='/tmp'&&basename(path).startsWith(prefix))await rm(path,{recursive:true,force:true});
  }
}

if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url)){
  try{if(process.argv.length>3||process.argv[2]&&process.argv[2]!=='--cleanup')throw new Error('Only --cleanup is accepted.');console.log(JSON.stringify(await runLinuxCiPreflight({cleanup:process.argv[2]==='--cleanup'})));}
  catch(error){console.error(error.message);process.exitCode=1;}
}
