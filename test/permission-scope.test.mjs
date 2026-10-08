import test from 'node:test';
import assert from 'node:assert/strict';
import {resolve,join,dirname} from 'node:path';
import {mkdtemp,mkdir,copyFile,chmod,chown,writeFile,readFile,readdir,lstat,rm,unlink,symlink,truncate} from 'node:fs/promises';
import {tmpdir} from './fixtures/temp-root.mjs';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {createHash} from 'node:crypto';
import {CODEX_VERSION} from '../src/platforms.mjs';
import {permissionPolicy,approvalWithinScope,isolatedEnvironment} from '../src/permission-scope.mjs';
import * as scopeModule from '../src/permission-scope.mjs';
import {localCodex} from '../src/local-engine.mjs';
test('Web Off full access is reduced to a sandbox and never grants network escalation',()=>{
  const policy=permissionPolicy({permissions:'allow-everything',webAccess:false,scope:'full'});
  assert.equal(policy.sandbox,'workspace-write');assert.equal(policy.networkAccess,false);
  assert.equal(approvalWithinScope({method:'item/commandExecution/requestApproval',params:{command:'curl example.com'}},{webAccess:false,scope:'project'}),false);
});
test('read-only mode denies writes and scope refuses outside project roots',()=>{
  assert.equal(permissionPolicy({scope:'read-only',webAccess:false}).sandbox,'read-only');
  assert.equal(approvalWithinScope({method:'item/fileChange/requestApproval',params:{grantRoot:resolve('elsewhere')}},{cwd:resolve('project'),scope:'project',webAccess:true}),false);
});
test('engine child receives required runtime environment but unrelated secrets are dropped',()=>{
  const env=isolatedEnvironment({PATH:'runtime',SystemRoot:'C:/Windows',HOME:'/tmp/home',AWS_SECRET_ACCESS_KEY:'secret',OPENAI_API_KEY:'secret',SUDO_CLI_MODEL:'model',ENGINE_SCENARIO:'test'},{CODEX_HOME:'/private',SUDO_CLI_SESSION_KEY:'bridge'});
  assert.equal(env.AWS_SECRET_ACCESS_KEY,undefined);assert.equal(env.OPENAI_API_KEY,undefined);
  assert.equal(env.PATH,'runtime');assert.equal(env.CODEX_HOME,'/private');assert.equal(env.SUDO_CLI_SESSION_KEY,'bridge');
});

test('admitted model environment drops provider secrets and preserves only explicitly configured bridge tokens',()=>{
  const env={PATH:'/usr/bin',HOME:'/root',CODEX_HOME:'/tmp/owned-home',OPENAI_API_KEY:'synthetic-secret',AWS_SECRET_ACCESS_KEY:'synthetic-cloud-secret',SUDO_CLI_SESSION_KEY:'synthetic-bridge',SUDO_MCP_ALLOWED:'explicit-mcp',SUDO_MCP_UNDECLARED:'unapproved-mcp',SUDO_UID:'1001'};
  const child=scopeModule.sandboxChildEnvironment(env,{uid:1001,gid:1001},['-c','mcp_servers.allowed.bearer_token_env_var="SUDO_MCP_ALLOWED"']);
  assert.deepEqual(child,{PATH:'/usr/bin',HOME:'/tmp/owned-home',CODEX_HOME:'/tmp/owned-home',SUDO_CLI_SESSION_KEY:'synthetic-bridge',SUDO_MCP_ALLOWED:'explicit-mcp'});assert.equal(env.HOME,'/root');
});

test('ordinary traversable executables keep their original path and unsupported platforms are untouched',async()=>{
  assert.equal(typeof scopeModule.prepareSandboxRuntime,'function');
  const original=await scopeModule.prepareSandboxRuntime(process.execPath);assert.equal(original.path,process.execPath);await original.cleanup();
  const foreign=await scopeModule.prepareSandboxRuntime('/private/not-installed/codex',{platform:'win32'});assert.equal(foreign.path,'/private/not-installed/codex');await foreign.cleanup();
});

test('private runtime staging preserves optional zsh and only bounded, hashed manifest voice resources',{skip:process.platform!=='linux'||process.getuid?.()!==0},async t=>{
  const root=await mkdtemp(join(tmpdir(),'sudocli-private-resources-test-'));await chmod(root,0o755);t.after(()=>rm(root,{recursive:true,force:true}));
  const runner=join(root,'runner');await mkdir(runner,{mode:0o750});await chown(runner,1001,1001);
  const runtime=join(runner,'runtime'),entrypoint=join(runtime,'bin/codex');
  const contents={'bin/codex':'core executable','bin/codex-code-mode-host':'code host','codex-path/rg':'search','codex-resources/bwrap':'sandbox','codex-resources/zsh/bin/zsh':'optional shell','codex-resources/voice/bin/codex-voice-host':'voice host','codex-resources/voice/lib/libvoice.so':'voice library','codex-resources/voice/runtime.json':'{}'};
  for(const [file,content] of Object.entries(contents)){const target=join(runtime,file);await mkdir(dirname(target),{recursive:true,mode:0o755});await writeFile(target,content,{mode:file.endsWith('.json')||file.endsWith('.so')?0o644:0o755});}
  const metadata={layoutVersion:1,version:CODEX_VERSION,variant:'codex',entrypoint:'bin/codex',resourcesDir:'codex-resources',pathDir:'codex-path',target:'x86_64-unknown-linux-musl'};
  await writeFile(join(runtime,'codex-package.json'),JSON.stringify(metadata));
  const hash=content=>createHash('sha256').update(content).digest('hex');
  const manifest={schemaVersion:1,appVersion:CODEX_VERSION,appTarget:metadata.target,sha256:Object.fromEntries(Object.entries(contents).filter(([file])=>file==='bin/codex'||file.startsWith('codex-resources/voice/')).map(([file,content])=>[file,hash(content)]))};
  const manifestPath=join(runtime,'codex-resources/voice/manifest.json');await writeFile(manifestPath,JSON.stringify(manifest));await writeFile(join(runtime,'codex-resources/voice/private-neighbor'),'not admitted');
  const staged=await scopeModule.prepareSandboxRuntime(entrypoint,{identity:{uid:65534,gid:65534}});t.after(()=>staged.cleanup());const stagedRoot=resolve(dirname(staged.path),'..');assert.equal((await lstat(stagedRoot)).uid,65534);assert.equal((await lstat(stagedRoot)).mode&0o777,0o700);
  for(const [file,content] of Object.entries(contents))assert.equal(await readFile(join(stagedRoot,file),'utf8'),content,`${file} must retain its relative resource layout`);
  assert.equal(await readFile(join(stagedRoot,'codex-resources/voice/manifest.json'),'utf8'),JSON.stringify(manifest));
  await assert.rejects(readFile(join(stagedRoot,'codex-resources/voice/private-neighbor')),{code:'ENOENT'});
  assert.equal((await lstat(join(stagedRoot,'codex-resources/voice/lib/libvoice.so'))).mode&0o777,0o644);
  await staged.cleanup();
  await truncate(join(runtime,'codex-resources/voice/lib/libvoice.so'),512*1024*1024+1);await assert.rejects(()=>scopeModule.prepareSandboxRuntime(entrypoint),/files.*invalid/i);await writeFile(join(runtime,'codex-resources/voice/lib/libvoice.so'),contents['codex-resources/voice/lib/libvoice.so']);
  await writeFile(join(runtime,'codex-resources/voice/lib/libvoice.so'),'tampered');
  await assert.rejects(()=>scopeModule.prepareSandboxRuntime(entrypoint),/hash|digest/i);
  await writeFile(join(runtime,'codex-resources/voice/lib/libvoice.so'),contents['codex-resources/voice/lib/libvoice.so']);
  for(const invalid of [
    {...manifest,sha256:{'codex-resources/voice/../private-neighbor':'0'.repeat(64)}},
    {...manifest,sha256:{'unrelated-home-file':'0'.repeat(64)}},
    {...manifest,sha256:{'codex-resources/voice/lib/libvoice.so':'invalid digest'}},
    {...manifest,appVersion:'0.0.0'},
    {...manifest,sha256:Object.fromEntries(Array.from({length:129},(_,index)=>[`codex-resources/voice/lib/file${index}`,'0'.repeat(64)]))},
  ]){await writeFile(manifestPath,JSON.stringify(invalid));await assert.rejects(()=>scopeModule.prepareSandboxRuntime(entrypoint),/voice.*invalid/i);}
  await writeFile(manifestPath,JSON.stringify(manifest));await unlink(join(runtime,'codex-resources/voice/lib/libvoice.so'));await symlink(join(runtime,'codex-resources/voice/runtime.json'),join(runtime,'codex-resources/voice/lib/libvoice.so'));
  await assert.rejects(()=>scopeModule.prepareSandboxRuntime(entrypoint),/files.*invalid/i);
  await unlink(join(runtime,'codex-resources/voice/lib/libvoice.so'));await writeFile(join(runtime,'codex-resources/voice/lib/libvoice.so'),contents['codex-resources/voice/lib/libvoice.so']);
  await rm(join(runtime,'codex-resources/voice/lib'),{recursive:true});await symlink(join(root,'outside-resources'),join(runtime,'codex-resources/voice/lib'));
  await assert.rejects(()=>scopeModule.prepareSandboxRuntime(entrypoint),/directories.*invalid/i);
});

test('native Linux sandbox can reexecute a runtime behind a runner-owned private ancestor without opening that home',{skip:process.platform!=='linux'||process.getuid?.()!==0,timeout:45000},async t=>{
  let native;
  try{native=localCodex();}catch{t.skip('Install the pinned native Linux runtime.');return;}
  const packageRoot=resolve(dirname(native),'..');
  const root=await mkdtemp(join(tmpdir(),'sudocli-private-runtime-test-'));await chmod(root,0o755);
  t.after(()=>rm(root,{recursive:true,force:true}));
  const runnerHome=join(root,'runner');await mkdir(runnerHome,{mode:0o750});await chown(runnerHome,1001,1001);
  const runtime=join(runnerHome,'checkout','runtime'),project=join(root,'project'),home=join(root,'session');
  await mkdir(project,{mode:0o755});await mkdir(home,{mode:0o700});
  const files=['codex-package.json','bin/codex','bin/codex-code-mode-host','codex-path/rg','codex-resources/bwrap'];
  try{await lstat(join(packageRoot,'codex-resources/zsh/bin/zsh'));files.push('codex-resources/zsh/bin/zsh');}catch(error){if(error.code!=='ENOENT')throw error;}
  try{const manifest=JSON.parse(await readFile(join(packageRoot,'codex-resources/voice/manifest.json'),'utf8'));files.push('codex-resources/voice/manifest.json',...Object.keys(manifest.sha256).filter(file=>file.startsWith('codex-resources/voice/')));}catch(error){if(error.code!=='ENOENT')throw error;}
  for(const relative of files){const target=join(runtime,relative),info=await lstat(join(packageRoot,relative));await mkdir(dirname(target),{recursive:true,mode:0o755});await copyFile(join(packageRoot,relative),target);await chmod(target,info.mode&0o111?0o755:0o644);}
  await writeFile(join(runnerHome,'private-home-marker'),'must remain private');await writeFile(join(runtime,'not-a-runtime-secret'),'must not be staged');
  const original=join(runtime,'bin','codex');
  // Before the feature exists, exercise the original path so the regression
  // fails with the actual bwrap Permission denied error, not a missing export.
  const prepare=scopeModule.prepareSandboxRuntime|| (async path=>({path,cleanup:async()=>{}}));
  const prepared=await prepare(original);t.after(()=>prepared.cleanup());
  const execute=promisify(execFile);let outcome;
  try{outcome=await execute(prepared.path,['sandbox','-c','sandbox_mode="workspace-write"','-c','sandbox_workspace_write.network_access=false','-c','sandbox_workspace_write.exclude_slash_tmp=true','-c','sandbox_workspace_write.exclude_tmpdir_env_var=true','--','/bin/sh','-c','test ! -r "$1" || exit 93; printf permitted > allowed.txt; if touch "$2" 2>/dev/null; then exit 94; fi; printf PRIVATE_ANCESTOR_SANDBOX_PASS','fixture-check',join(runnerHome,'private-home-marker'),join(root,'outside-must-not-exist')],{cwd:project,env:{PATH:'/usr/bin:/bin',HOME:home,CODEX_HOME:home},timeout:15000,maxBuffer:8192});}
  catch(error){outcome={stdout:error.stdout,stderr:error.stderr,code:error.code};}
  assert.equal(outcome.code,undefined,outcome.stderr);assert.equal(outcome.stdout,'PRIVATE_ANCESTOR_SANDBOX_PASS');
  assert.notEqual(prepared.path,original);assert.equal((await lstat(runnerHome)).mode&0o777,0o750);assert.equal((await lstat(runnerHome)).uid,1001);
  const staged=resolve(dirname(prepared.path),'..');assert.deepEqual((await readdir(staged)).sort(),['bin','codex-package.json','codex-path','codex-resources']);
  for(const file of files)assert.equal((await lstat(join(staged,file))).size,(await lstat(join(runtime,file))).size,`${file} must be staged`);
  t.diagnostic(`Actual pinned native runtime staged ${files.length} declared/core files, including available shell and voice resources.`);
  await assert.rejects(readFile(join(staged,'not-a-runtime-secret')),{code:'ENOENT'});assert.equal(await readFile(join(runnerHome,'private-home-marker'),'utf8'),'must remain private');
  assert.equal(await readFile(join(project,'allowed.txt'),'utf8'),'permitted');await assert.rejects(lstat(join(root,'outside-must-not-exist')),{code:'ENOENT'});
  const readOnly=await execute(prepared.path,['sandbox','-c','sandbox_mode="read-only"','--','/bin/sh','-c','cat allowed.txt; if touch readonly-must-not-exist 2>/dev/null; then exit 95; fi'],{cwd:project,env:{PATH:'/usr/bin:/bin',HOME:home,CODEX_HOME:home},timeout:15000,maxBuffer:8192});assert.equal(readOnly.stdout,'permitted');await assert.rejects(lstat(join(project,'readonly-must-not-exist')),{code:'ENOENT'});
  await prepared.cleanup();await assert.rejects(lstat(staged),{code:'ENOENT'});assert.equal(await readFile(join(runnerHome,'private-home-marker'),'utf8'),'must remain private');
  const metadataPath=join(runtime,'codex-package.json'),metadata=JSON.parse(await readFile(metadataPath,'utf8'));
  await writeFile(metadataPath,JSON.stringify({...metadata,version:'0.0.0'}));await assert.rejects(()=>scopeModule.prepareSandboxRuntime(original),/pinned installed/i);
  await writeFile(metadataPath,JSON.stringify(metadata));await unlink(join(runtime,'codex-resources','bwrap'));await symlink(join(runnerHome,'private-home-marker'),join(runtime,'codex-resources','bwrap'));
  await assert.rejects(()=>scopeModule.prepareSandboxRuntime(original),/package files.*invalid/i);
});
