import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,writeFile,readFile,readdir,mkdir,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,dirname} from 'node:path';
import {createHash} from 'node:crypto';
import {deflateRawSync} from 'node:zlib';
import {stageUpdate,validateUpdateManifest,inspectZip,installStagedUpdate,rollbackUpdate,updateStatus} from '../src/verified-update.mjs';
import {localCodex} from '../src/local-engine.mjs';
import {platformRuntime,CODEX_VERSION} from '../src/platforms.mjs';

const digest=bytes=>createHash('sha256').update(bytes).digest('hex');
function crc(bytes){let sum=0xffffffff;for(const byte of bytes){sum^=byte;for(let i=0;i<8;i++)sum=(sum>>>1)^((sum&1)?0xedb88320:0);}return(sum^0xffffffff)>>>0;}
function zip(files,{deflate=false}={}){
  const locals=[],centrals=[];let offset=0;
  for(const file of files){const name=Buffer.from(file.path),bytes=Buffer.from(file.content),packed=deflate?deflateRawSync(bytes):bytes,checksum=crc(bytes);
    const local=Buffer.alloc(30);local.writeUInt32LE(0x04034b50);local.writeUInt16LE(20,4);local.writeUInt16LE(0x800,6);local.writeUInt16LE(deflate?8:0,8);local.writeUInt32LE(checksum,14);local.writeUInt32LE(packed.length,18);local.writeUInt32LE(bytes.length,22);local.writeUInt16LE(name.length,26);
    const central=Buffer.alloc(46);central.writeUInt32LE(0x02014b50);central.writeUInt16LE(0x314,4);central.writeUInt16LE(20,6);central.writeUInt16LE(0x800,8);central.writeUInt16LE(deflate?8:0,10);central.writeUInt32LE(checksum,16);central.writeUInt32LE(packed.length,20);central.writeUInt32LE(bytes.length,24);central.writeUInt16LE(name.length,28);central.writeUInt32LE(0x81a40000,38);central.writeUInt32LE(offset,42);
    locals.push(local,name,packed);centrals.push(central,name);offset+=30+name.length+packed.length;
  }
  const directory=Buffer.concat(centrals),end=Buffer.alloc(22);end.writeUInt32LE(0x06054b50);end.writeUInt16LE(files.length,8);end.writeUInt16LE(files.length,10);end.writeUInt32LE(directory.length,12);end.writeUInt32LE(offset,16);return Buffer.concat([...locals,directory,end]);
}
function application(version='0.6.1',{doctorFailure=false}={}){
  return [
    {path:'codexcli/package.json',content:JSON.stringify({name:'codexcli',version,type:'module',engines:{node:'>=22'}})},
    {path:'codexcli/bin/sudocli.mjs',content:`import {spawnSync} from 'node:child_process';import {writeFileSync} from 'node:fs';import {fileURLToPath} from 'node:url';
      if(process.argv[2]!=='doctor')process.exit(2);${doctorFailure?'process.exit(7);':''}
      const result=spawnSync(process.env.SUDO_CLI_CODEX,['--version'],{encoding:'utf8',shell:false,windowsHide:true});if(result.status!==0)process.exit(3);
      writeFileSync(fileURLToPath(new URL('../doctor-proof.txt',import.meta.url)),'doctor passed');
      console.log('codexcli ${version} | sudocli');console.log('Node '+process.versions.node);console.log('Engine: '+result.stdout.trim());console.log('Ready. Model configuration happens at launch; no connection was made.');`},
    {path:'codexcli/runtime/manifest.json',content:JSON.stringify({platform:`${process.platform==='win32'?'windows':process.platform}-${process.arch}`,codexVersion:'0.160.1'})},
  ];
}
async function fixture(t){const root=await mkdtemp(join(tmpdir(),'codexcli-update-'));t.after(()=>rm(root,{recursive:true,force:true}));return{root,stateDir:join(root,'state'),source:join(root,'bundle.zip')};}
async function installedFixture(t){
  const value=await fixture(t);let runtimePath;
  try{runtimePath=process.env.CODEXCLI_TEST_UPDATE_RUNTIME||localCodex();}catch{t.skip('A pinned native runtime is required for real update verification.');return;}
  const currentRoot=join(value.root,'original');for(const file of application('0.6.0')){const path=join(currentRoot,file.path.slice('codexcli/'.length));await mkdir(dirname(path),{recursive:true});await writeFile(path,file.content);}
  const registered=[],registrationPath=join(value.root,'fixture-command.json');
  const register=async options=>{assert.equal(await readFile(join(options.projectRoot,'doctor-proof.txt'),'utf8'),'doctor passed');registered.push(options);await writeFile(registrationPath,JSON.stringify(options));};
  return{...value,currentRoot,runtimePath,register,registered,registrationPath};
}
async function stage(value,bytes){await writeFile(value.source,bytes);return stageUpdate({source:value.source,sha256:digest(bytes),stateDir:value.stateDir});}

test('failed staging removes its download and retains the previous verified package',async t=>{
  const value=await fixture(t);await writeFile(value.source,'fixture package');
  await assert.rejects(stageUpdate({...value,sha256:'0'.repeat(64)}),/hash/i);
  assert.deepEqual((await readdir(join(value.stateDir,'updates'))).filter(name=>name.includes('.download-')),[]);
  const result=await stageUpdate({...value,sha256:digest('fixture package')});assert.equal(await readFile(result.path,'utf8'),'fixture package');
  await assert.rejects(stageUpdate({...value,sha256:'0'.repeat(64)}),/hash/i);assert.equal((await updateStatus(value)).sha256,result.sha256);
});
test('manifest accepts documented Windows platform aliases and refuses conflicting architecture or credential URLs',()=>{
  const manifest={version:'0.6.1',platform:'windows-x64',sha256:'a'.repeat(64),url:'https://example.com/release.zip'};
  assert.equal(validateUpdateManifest(manifest,{platform:'win32',arch:'x64'}).platform,'win32');
  assert.throws(()=>validateUpdateManifest({...manifest,arch:'arm64'},{platform:'win32',arch:'x64'}),/platform|architecture/i);
  assert.throws(()=>validateUpdateManifest({...manifest,url:'https://user:secret@example.com/release.zip'},{platform:'win32',arch:'x64'}),error=>/URL/.test(error.message)&&!error.message.includes('secret'));
});
test('ZIP validation compares local and central names before any extraction',()=>{
  const bytes=zip(application());assert.equal(inspectZip(bytes).length,3);Buffer.from('evilxxxx').copy(bytes,30);
  assert.throws(()=>inspectZip(bytes),/local|header|archive/i);
});
test('ZIP directory bounds, unsupported ZIP64 and overlapping local records fail with controlled errors',()=>{
  const bytes=zip(application()),end=bytes.length-22;
  const outside=Buffer.from(bytes);outside.writeUInt32LE(bytes.length+100,end+16);assert.throws(()=>inspectZip(outside),error=>!(error instanceof RangeError)&&/archive|ZIP|bounds/i.test(error.message));
  const zip64=Buffer.from(bytes);zip64.writeUInt16LE(0xffff,end+10);assert.throws(()=>inspectZip(zip64),/ZIP|files|archive/i);
  const overlap=Buffer.from(bytes),central=bytes.readUInt32LE(end+16),second=central+46+Buffer.byteLength(application()[0].path);overlap.writeUInt32LE(0,second+42);assert.throws(()=>inspectZip(overlap),/local|overlap|archive/i);
});
test('ZIP traversal, links, case collisions and conflicting parents are refused',()=>{
  for(const extra of [{path:'codexcli/../escape.txt',content:'x'},{path:'codexcli/PACKAGE.JSON',content:'x'},{path:'codexcli/bin/sudocli.mjs/child',content:'x'}])assert.throws(()=>inspectZip(zip([...application(),extra])),/unsafe|duplicate|conflict|archive/i);
  const bytes=zip(application()),central=bytes.readUInt32LE(bytes.length-6);bytes.writeUInt32LE(0xa1ff0000,central+38);assert.throws(()=>inspectZip(bytes),/links|unsafe/i);
});
test('real stage install and rollback run the selected Node, pinned native engine and new doctor before fixture registration',async t=>{
  const value=await installedFixture(t);if(!value)return;await stage(value,zip(application()));
  const installed=await installStagedUpdate(value);assert.equal(installed.version,'0.6.1');assert.equal(value.registered.length,1);assert.equal(JSON.parse(await readFile(value.registrationPath,'utf8')).projectRoot,installed.installed);
  const rolled=await rollbackUpdate(value);assert.equal(rolled.version,'0.6.0');assert.equal(rolled.installed,value.currentRoot);assert.equal(value.registered.length,2);
  assert.equal(JSON.parse(await readFile(join(installed.installed,'package.json'),'utf8')).version,'0.6.1');assert.equal(JSON.parse(await readFile(value.registrationPath,'utf8')).projectRoot,value.currentRoot);
});

test('an offered version must match the new archive and an already installed release before registration',async t=>{
  const value=await installedFixture(t);if(!value)return;await stage(value,zip(application('0.6.1')));
  await assert.rejects(installStagedUpdate({...value,expectedVersion:'0.6.2'}),/expected|offered|version/i);
  assert.equal(value.registered.length,0);assert.deepEqual(await readdir(join(value.stateDir,'releases')),[]);
  const installed=await installStagedUpdate({...value,expectedVersion:'0.6.1'});assert.equal(installed.version,'0.6.1');
  await assert.rejects(installStagedUpdate({...value,expectedVersion:'0.6.2'}),/expected|offered|version/i);
  assert.equal(value.registered.length,1);
  assert.equal((await installStagedUpdate({...value,expectedVersion:'0.6.1'})).alreadyInstalled,true);
});
test('deflated packages fail before registration when doctor or payload integrity fails and clean their release',async t=>{
  const value=await installedFixture(t);if(!value)return;await stage(value,zip(application('0.6.1',{doctorFailure:true}),{deflate:true}));
  await assert.rejects(installStagedUpdate(value),/doctor/i);assert.equal(value.registered.length,0);assert.deepEqual(await readdir(join(value.stateDir,'releases')),[]);
  const corrupt=zip(application(),{deflate:true}),central=corrupt.readUInt32LE(corrupt.length-6);corrupt.writeUInt32LE(123,14);corrupt.writeUInt32LE(123,central+16);await stage(value,corrupt);
  await assert.rejects(installStagedUpdate(value),/CRC|archive|integrity/i);assert.equal(value.registered.length,0);assert.deepEqual(await readdir(join(value.stateDir,'releases')),[]);
});
test('a registration failure compensates with the verified previous command and does not publish installation state',async t=>{
  const value=await installedFixture(t);if(!value)return;await stage(value,zip(application()));let calls=0;
  const register=async options=>{await value.register(options);if(++calls===1)throw new Error('fixture registration failed');};
  await assert.rejects(installStagedUpdate({...value,register}),/registration/i);assert.equal(calls,2);assert.equal(JSON.parse(await readFile(value.registrationPath,'utf8')).projectRoot,value.currentRoot);
  await assert.rejects(readFile(join(value.stateDir,'updates','installation.json')),error=>error.code==='ENOENT');assert.deepEqual(await readdir(join(value.stateDir,'releases')),[]);
});
test('Node versions below 22 or the release engine minimum are refused before native execution or registration',async t=>{
  const value=await installedFixture(t);if(!value)return;await stage(value,zip(application()));
  for(const [version,minimum] of [['v20.19.0','>=22'],['v24.19.0','>=24.20.0']]){const path=join(value.currentRoot,'package.json'),pkg=JSON.parse(await readFile(path,'utf8'));pkg.engines.node=minimum;await writeFile(path,JSON.stringify(pkg));const calls=[];
    const commandRunner=async(command,args)=>{calls.push({command,args});return{code:0,stdout:version};};
    await assert.rejects(installStagedUpdate({...value,commandRunner}),/Node version/i);assert.equal(calls.length,1);assert.deepEqual(calls[0].args,['--version']);assert.equal(value.registered.length,0);}
});
test('portable manifest file entries are checked before registration',async t=>{
  const value=await installedFixture(t);if(!value)return;const files=application(),payload='verified portable resource';files.push({path:'codexcli/runtime/resource.txt',content:payload});
  files[2].content=JSON.stringify({platform:`${process.platform==='win32'?'windows':process.platform}-${process.arch}`,codexVersion:'0.160.1',files:[{file:'resource.txt',bytes:Buffer.byteLength(payload),sha256:digest(payload)}]});
  await stage(value,zip(files,{deflate:true}));const installed=await installStagedUpdate(value);assert.equal(installed.version,'0.6.1');assert.equal(value.registered.length,1);
  files[2].content=JSON.stringify({...JSON.parse(files[2].content),files:[{file:'resource.txt',bytes:Buffer.byteLength(payload),sha256:'0'.repeat(64)}]});await stage(value,zip(files,{deflate:true}));
  await assert.rejects(installStagedUpdate(value),/manifest integrity/i);assert.equal(value.registered.length,1);assert.equal(JSON.parse(await readFile(value.registrationPath,'utf8')).projectRoot,installed.installed);
});
test('concurrent installation of the same verified package registers once and can reinstall after rollback',async t=>{
  const value=await installedFixture(t);if(!value)return;await stage(value,zip(application(),{deflate:true}));
  const [first,second]=await Promise.all([installStagedUpdate(value),installStagedUpdate(value)]);assert.equal(first.installed,second.installed);assert.equal([first,second].filter(result=>result.alreadyInstalled).length,1);assert.equal(value.registered.length,1);
  await rollbackUpdate(value);const third=await installStagedUpdate(value);assert.equal(third.version,'0.6.1');assert.equal(value.registered.length,3);
});
test('rollback rechecks the retained doctor and preserves the active command when it fails',async t=>{
  const value=await installedFixture(t);if(!value)return;await stage(value,zip(application()));const installed=await installStagedUpdate(value);
  await writeFile(join(value.currentRoot,'bin','sudocli.mjs'),'process.exit(7);');await assert.rejects(rollbackUpdate(value),/doctor/i);
  assert.equal(value.registered.length,1);assert.equal(JSON.parse(await readFile(value.registrationPath,'utf8')).projectRoot,installed.installed);assert.equal(JSON.parse(await readFile(join(value.stateDir,'updates','installation.json'),'utf8')).current,installed.installed);
});
test('a broken active doctor does not prevent rollback to a verified retained release',async t=>{
  const value=await installedFixture(t);if(!value)return;await stage(value,zip(application()));const installed=await installStagedUpdate(value);
  await writeFile(join(installed.installed,'bin','sudocli.mjs'),'process.exit(7);');const rolled=await rollbackUpdate(value);
  assert.equal(rolled.installed,value.currentRoot);assert.equal(value.registered.length,2);assert.equal(JSON.parse(await readFile(value.registrationPath,'utf8')).projectRoot,value.currentRoot);
});
test('failed rollback registration reports uncertainty when the active release cannot be verified',async t=>{
  const value=await installedFixture(t);if(!value)return;await stage(value,zip(application()));const installed=await installStagedUpdate(value);await writeFile(join(installed.installed,'bin','sudocli.mjs'),'process.exit(7);');
  let attempts=0;await assert.rejects(rollbackUpdate({...value,register:async options=>{attempts++;await value.register(options);throw new Error('fixture register failed');}}),error=>error.code==='UPDATE_REGISTRATION_UNCERTAIN');
  assert.equal(attempts,1);assert.equal(JSON.parse(await readFile(join(value.stateDir,'updates','installation.json'),'utf8')).current,installed.installed);assert.equal(JSON.parse(await readFile(join(installed.installed,'package.json'),'utf8')).version,'0.6.1');
});
test('retained update state cannot redirect rollback outside its recorded original or protected release roots',async t=>{
  const value=await fixture(t),originalRoot=join(value.root,'original'),runtimePath=join(value.root,'runtime','bin','codex');await mkdir(join(value.stateDir,'updates'),{recursive:true});
  const record={version:1,originalRoot,current:join(value.stateDir,'releases','verified-test','codexcli'),previous:join(value.root,'unrelated'),currentNodePath:process.execPath,previousNodePath:process.execPath,currentRuntimePath:runtimePath,previousRuntimePath:runtimePath,releaseVersion:'0.6.1'};
  const path=join(value.stateDir,'updates','installation.json');await writeFile(path,JSON.stringify(record));let calls=0;await assert.rejects(rollbackUpdate({...value,register:async()=>{calls++;}}),/outside/i);assert.equal(calls,0);assert.deepEqual(JSON.parse(await readFile(path,'utf8')),record);
});
test('interrupted update locks fail closed and do not enqueue command registration',async t=>{
  const value=await fixture(t);await stage(value,zip(application()));await writeFile(join(value.stateDir,'updates','operation.lock'),'interrupted');
  let registrations=0;await assert.rejects(installStagedUpdate({...value,register:async()=>{registrations++;}}),/locked/i);assert.equal(registrations,0);assert.equal(await readFile(join(value.stateDir,'updates','operation.lock'),'utf8'),'interrupted');
});
async function nativeFixture(root,{badPin=false}={}){
  const target=platformRuntime(),directory=join(root,'runtime',target.id),suffix=process.platform==='win32'?'.exe':'';
  const files=[`bin/${target.executable}`,`bin/codex-code-mode-host${suffix}`,`codex-path/rg${suffix}`,...(process.platform==='linux'?['codex-resources/bwrap']:process.platform==='win32'?['codex-resources/codex-command-runner.exe','codex-resources/codex-windows-sandbox-setup.exe']:[])];
  for(const file of files){const path=join(directory,file);await mkdir(dirname(path),{recursive:true});await writeFile(path,'runtime fixture');}
  await writeFile(join(directory,'sudo-runtime.json'),JSON.stringify({codexVersion:CODEX_VERSION,platform:target.id,source:target.url,archiveBytes:target.bytes,archiveSha256:badPin?'0'.repeat(64):target.sha256}));
  await writeFile(join(directory,'codex-package.json'),JSON.stringify({layoutVersion:1,version:CODEX_VERSION,target:target.triple,variant:'codex',entrypoint:`bin/${target.executable}`,resourcesDir:'codex-resources',pathDir:'codex-path'}));
}
test('runtime setup is followed by pin, layout, native and doctor verification before registration',async t=>{
  const value=await fixture(t),currentRoot=join(value.root,'original');for(const file of application('0.6.0')){const path=join(currentRoot,file.path.slice(9));await mkdir(dirname(path),{recursive:true});await writeFile(path,file.content);}await nativeFixture(currentRoot);
  const files=[...application(),{path:'codexcli/scripts/setup-runtime.mjs',content:'// injected runtime setup fixture'}];await stage(value,zip(files));const calls=[];
  const commandRunner=async(command,args,{cwd})=>{calls.push(args[0]==='--version'?(command===process.execPath?'node':'native'):args[0].endsWith('setup-runtime.mjs')?'setup':'doctor');
    if(args[0].endsWith('setup-runtime.mjs')){await nativeFixture(cwd);return{code:0,stdout:'fixture setup complete'};}
    if(args[0]==='--version')return{code:0,stdout:command===process.execPath?'v24.19.0':`codex-cli ${CODEX_VERSION}`};
    const pkg=JSON.parse(await readFile(join(cwd,'package.json'),'utf8'));return{code:0,stdout:`codexcli ${pkg.version} | sudocli\nEngine: codex-cli ${CODEX_VERSION}\nReady.`};};
  const register=async()=>calls.push('register');await installStagedUpdate({...value,currentRoot,commandRunner,register});assert.deepEqual(calls,['node','native','doctor','node','setup','native','doctor','register']);
  const bad=await fixture(t),badOriginal=join(bad.root,'original');for(const file of application('0.6.0')){const path=join(badOriginal,file.path.slice(9));await mkdir(dirname(path),{recursive:true});await writeFile(path,file.content);}await nativeFixture(badOriginal);await stage(bad,zip(files));let registered=false;
  const badRunner=async(command,args,options)=>{if(args[0].endsWith('setup-runtime.mjs')){await nativeFixture(options.cwd,{badPin:true});return{code:0,stdout:'setup acknowledged'};}return commandRunner(command,args,options);};
  await assert.rejects(installStagedUpdate({...bad,currentRoot:badOriginal,commandRunner:badRunner,register:async()=>{registered=true;}}),/pinned/i);assert.equal(registered,false);assert.deepEqual(await readdir(join(bad.stateDir,'releases')),[]);
});
