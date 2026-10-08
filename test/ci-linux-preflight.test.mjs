import test from 'node:test';
import assert from 'node:assert/strict';
import {chmod,chown,copyFile,mkdir,mkdtemp,readFile,rm,symlink,writeFile} from 'node:fs/promises';
import {join} from 'node:path';
import {createHash} from 'node:crypto';
import {createServer} from 'node:net';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {tmpdir} from './fixtures/temp-root.mjs';
import {BWRAP_PINS,ciInvocation,conditionalUsernsPreflight,dmesgTimestamp,pinnedBwrap,probeBwrap,provedAppArmorDenial,usernsProfile} from '../scripts/ci/linux-native-preflight.mjs';
import {CODEX_VERSION,platformRuntime} from '../src/platforms.mjs';

test('a proved AppArmor userns denial admits only the named paths and reprobes both native copies',async()=>{
  const paths=['/workspace/runtime/linux-x64/codex-resources/bwrap','/tmp/sudo-cli-sandbox-runtime-Ab1cD2/codex-resources/bwrap'];
  const calls=[];let installed=false;
  const result=await conditionalUsernsPreflight({paths,probe:async path=>{calls.push(['probe',path]);if(!installed)throw new Error('bwrap: loopback: Failed RTM_NEWADDR: Operation not permitted');},appArmorEvidence:async()=>{calls.push(['evidence']);return true;},installAllowance:async actual=>{calls.push(['install',actual]);installed=true;}});
  assert.deepEqual(result,{profileInstalled:true,probes:2});
  assert.deepEqual(calls,[['probe',paths[0]],['evidence'],['install',paths],['probe',paths[0]],['probe',paths[1]]]);
});

test('Linux CI proves pinned native enforcement before sudo native tests',async()=>{
  const workflow=await readFile(new URL('../.github/workflows/test.yml',import.meta.url),'utf8');
  const preflight=workflow.indexOf('scripts/ci/linux-native-preflight.mjs');
  assert.ok(preflight>=0,'Linux CI has no native user-namespace enforcement preflight.');
  assert.ok(preflight<workflow.indexOf('Test Unix root admission'));
  assert.match(workflow,/--test-timeout=120000/);
  assert.ok(workflow.includes('if: always() && runner.os == \'Linux\''));
  assert.ok(workflow.includes('scripts/ci/linux-native-preflight.mjs --cleanup'));
});

test('CI allowance is unreachable outside root Linux GitHub Actions and the exact canonical checkout',()=>{
  const projectRoot='/home/runner/work/sudo_cli/sudo_cli',env={CI:'true',GITHUB_ACTIONS:'true',GITHUB_WORKSPACE:projectRoot};
  assert.equal(ciInvocation({env,projectRoot,platform:'linux',uid:0}),projectRoot);
  for(const override of [{platform:'win32'},{uid:1001},{env:{...env,CI:'false'}},{env:{...env,GITHUB_ACTIONS:'false'}},{env:{...env,GITHUB_WORKSPACE:'/another'}},{projectRoot:'/home/runner/../runner/work/sudo_cli/sudo_cli'},{projectRoot:'/tmp/profile" injection'}])assert.throws(()=>ciInvocation({env,projectRoot,platform:'linux',uid:0,...override}),/restricted/);
});

test('working native sandbox changes no AppArmor policy',async()=>{
  const seen=[];
  const result=await conditionalUsernsPreflight({paths:['installed','staged'],probe:async path=>seen.push(path),appArmorEvidence:async()=>assert.fail('no evidence requested'),installAllowance:async()=>assert.fail('no profile installed')});
  assert.deepEqual(result,{profileInstalled:false,probes:2});assert.deepEqual(seen,['installed','staged']);
});

test('generic sandbox failure cannot trigger an AppArmor allowance',async()=>{
  const error=new Error('unrelated native mount failure');let installed=false;
  await assert.rejects(conditionalUsernsPreflight({paths:['installed','staged'],probe:async()=>{throw error;},appArmorEvidence:async actual=>{assert.equal(actual,error);return false;},installAllowance:async()=>{installed=true;}}),/without proved AppArmor/);
  assert.equal(installed,false);
});

test('post-allowance failed enforcement fails closed and removes the owned allowance',async()=>{
  let installed=false,cleaned=false,calls=0;
  await assert.rejects(conditionalUsernsPreflight({paths:['installed','staged'],probe:async()=>{calls++;if(!installed||calls===3)throw new Error('sandbox failed');},appArmorEvidence:async()=>true,installAllowance:async()=>{installed=true;return async()=>{cleaned=true;};}}),/still fails/);
  assert.equal(calls,3);assert.equal(cleaned,true);
});

test('AppArmor denial must match a probe PID, operation and enabled policy, rather than an unrelated EPERM',()=>{
  const error={probePids:[100,101]},line='audit: apparmor="DENIED" operation="capable" profile="unprivileged_userns" pid=101 comm="bwrap" capability=12 capname="net_admin"';
  const proof={restricted:'1',enabled:'Y',log:line};assert.equal(provedAppArmorDenial(error,proof),true);
  assert.equal(provedAppArmorDenial(error,{...proof,log:line.replace('pid=101','pid=100')}),true);
  assert.equal(provedAppArmorDenial(error,{...proof,log:'apparmor="DENIED" operation="userns_create" profile="unconfined" pid=100 comm="bwrap"'}),true);
  for(const replacement of [{restricted:'0'},{enabled:'N'},{log:line.replace('pid=101','pid=102')},{log:line.replace('DENIED','ALLOWED')},{log:line.replace('unprivileged_userns','another-app')},{log:line.replace('capable','file_write')},{log:line.replace('comm="bwrap"','comm="sh"')},{log:line+' '.repeat(256*1024)}])assert.equal(provedAppArmorDenial(error,{...proof,...replacement}),false);
  assert.equal(provedAppArmorDenial({probePids:[]},proof),false);
});

test('fresh denial cutoff uses the absolute UTC-local syntax accepted by util-linux dmesg',async()=>{
  const timestamp=dmesgTimestamp(Date.parse('2026-10-08T00:00:00.125Z'));assert.equal(timestamp,'2026-10-08 00:00:00.125');
  for(const value of [NaN,-1,1.5,Infinity,'2026-10-08',253402300800000])assert.throws(()=>dmesgTimestamp(value),/Invalid native probe timestamp/);
  if(process.platform==='linux'&&process.getuid?.()===0){
    try{await promisify(execFile)('/usr/bin/dmesg',['--since',dmesgTimestamp(Date.now()+60000),'--time-format','iso'],{shell:false,timeout:3000,maxBuffer:256*1024,env:{PATH:'/usr/bin',TZ:'UTC',LC_ALL:'C'}});}
    catch(error){assert.doesNotMatch(error.stderr||'',/invalid time value/);if(!/Operation not permitted|Permission denied/i.test(error.stderr||''))throw error;}
  }
});

test('CI profile admits only fixed executable attachments and user namespaces',()=>{
  const source='/home/runner/work/sudo_cli/sudo_cli/runtime/linux-x64/codex-resources/bwrap',stage='/tmp/sudo-cli-sandbox-runtime-Ab1cD2/codex-resources/bwrap';
  const profile=usernsProfile(source,stage);
  assert.equal((profile.match(/userns,/g)||[]).length,2);assert.equal((profile.match(/flags=\(unconfined\)/g)||[]).length,2);
  assert.ok(profile.includes('"'+source+'"'));assert.ok(profile.includes('"/tmp/sudo-cli-sandbox-runtime-??????/codex-resources/bwrap"'));
  assert.doesNotMatch(profile,/\/tmp\/\*\*|capability |network |\/bin\/sh|sysctl/);
  for(const [installed,staged] of [[source+'/other',stage],[source.replace('/linux-x64/','/darwin-x64/'),stage],[source.replace('/runtime/','/../runtime/'),stage],[source,stage.replace('Ab1cD2','*')],[source,stage.replace('/tmp/','/home/')],[source,stage.replace('bwrap','shell')]])assert.throws(()=>usernsProfile(installed,staged),/Invalid trusted/);
});

async function metadataFixture(root,arch){
  const target=platformRuntime('linux',arch),packageRoot=join(root,'runtime',target.id);await mkdir(join(packageRoot,'codex-resources'),{recursive:true});
  await writeFile(join(packageRoot,'codex-package.json'),JSON.stringify({layoutVersion:1,version:CODEX_VERSION,target:target.triple,variant:'codex',entrypoint:'bin/codex',resourcesDir:'codex-resources',pathDir:'codex-path'}),{mode:0o600});
  await writeFile(join(packageRoot,'sudo-runtime.json'),JSON.stringify({codexVersion:CODEX_VERSION,platform:target.id,source:target.url,archiveBytes:target.bytes,archiveSha256:target.sha256}),{mode:0o600});
  return {packageRoot,path:join(packageRoot,'codex-resources','bwrap')};
}

test('pinned architecture resources refuse changed bytes, unpinned provenance and resource links',{skip:process.platform!=='linux'},async()=>{
  const root=await mkdtemp(join(tmpdir(),'sudo-cli-ci-pin-test-'));
  try{
    const fixture=await metadataFixture(root,process.arch);
    try{
      await copyFile(join(import.meta.dirname,'..','runtime','linux-'+process.arch,'codex-resources','bwrap'),fixture.path);await chmod(fixture.path,0o755);
      const trusted=await pinnedBwrap(root);assert.equal(trusted.path,fixture.path);assert.equal(trusted.value.length,BWRAP_PINS[process.arch].bytes);
    }catch(error){if(error.code!=='ENOENT')throw error;}
    await writeFile(fixture.path,Buffer.alloc(BWRAP_PINS[process.arch].bytes),{mode:0o755});
    await assert.rejects(pinnedBwrap(root),/pinned digest/);
    await writeFile(join(fixture.packageRoot,'sudo-runtime.json'),'{}');await assert.rejects(pinnedBwrap(root),/pinned official/);
    await metadataFixture(root,process.arch);await rm(fixture.path);await symlink('/usr/bin/true',fixture.path);await assert.rejects(pinnedBwrap(root));
  }finally{await rm(root,{recursive:true,force:true});}
});

test('actual pinned Bubblewrap enforces owned project/scratch, denied outside writes and network in installed and neutral locations',{skip:process.platform!=='linux'||process.getuid?.()!==0,timeout:30000},async t=>{
  const accounts=(await readFile('/etc/passwd','utf8')).split('\n').map(line=>line.split(':')).filter(parts=>Number(parts[2])>=1000&&Number(parts[2])<65534&&Number(parts[3])<0xffffffff);
  const account=accounts.find(parts=>parts[0]===process.env.SUDO_USER)||accounts[0];if(!account){t.skip('No normal account for an admitted native CI fixture.');return;}
  const source=join(import.meta.dirname,'..','runtime','linux-'+process.arch,'codex-resources','bwrap');let bytes;
  try{bytes=await readFile(source);}catch(error){if(error.code==='ENOENT'){t.skip('Pinned project-local native Linux runtime is not installed.');return;}throw error;}
  assert.equal(bytes.length,BWRAP_PINS[process.arch].bytes);assert.equal(createHash('sha256').update(bytes).digest('hex'),BWRAP_PINS[process.arch].sha256);
  const root=await mkdtemp(join(tmpdir(),'sudo-cli-ci-real-test-')),stage=await mkdtemp('/tmp/sudo-cli-sandbox-runtime-'),uid=Number(account[2]),gid=Number(account[3]),server=createServer(socket=>socket.end());
  try{
    await chmod(root,0o700);await chown(root,uid,gid);await chmod(stage,0o700);await chown(stage,uid,gid);
    const directories=Object.fromEntries(['project','scratch','outside'].map(name=>[name,join(root,name)]));
    for(const path of Object.values(directories)){await mkdir(path,{mode:0o700});await chown(path,uid,gid);}
    await mkdir(join(stage,'codex-resources'),{mode:0o755});const staged=join(stage,'codex-resources','bwrap');await writeFile(staged,bytes,{mode:0o755});
    await new Promise((resolve,reject)=>{server.once('error',reject);server.listen(0,'127.0.0.1',resolve);});
    const settings={...directories,identity:{uid,gid},port:server.address().port,env:{PATH:process.env.PATH,OPENAI_API_KEY:'synthetic-must-not-be-inherited',AWS_SECRET_ACCESS_KEY:'synthetic-cloud-key',SUDO_CLI_SESSION_KEY:'synthetic-session-key'}};
    // Direct probes cannot load or remove any host profile, including on CI.
    const receipt={modelRequests:0,profileInstalled:false,probes:2,baseline:await probeBwrap({...settings,baseline:true}),proofs:[]};
    for(const [location,path] of [['installed',source],['staged',staged]])receipt.proofs.push({location,...await probeBwrap({...settings,path})});
    assert.deepEqual(receipt.baseline,{projectWrite:true,scratchWrite:true,outsideWrite:true,network:true,credentialsInherited:false});
    assert.deepEqual(receipt.proofs,[{location:'installed',projectWrite:true,scratchWrite:true,outsideWrite:false,network:false,credentialsInherited:false},{location:'staged',projectWrite:true,scratchWrite:true,outsideWrite:false,network:false,credentialsInherited:false}]);
    t.diagnostic(JSON.stringify(receipt));
  }finally{if(server.listening)await new Promise(resolve=>server.close(resolve));await rm(root,{recursive:true,force:true});await rm(stage,{recursive:true,force:true});}
});
