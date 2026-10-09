import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,realpath,symlink,rm} from 'node:fs/promises';
import {tmpdir} from './fixtures/temp-root.mjs';
import {join} from 'node:path';
import {createUpgradeCommands} from '../src/upgrades.mjs';
import {createProjectMemory} from '../src/project-memory.mjs';
import {credentialIdentity} from '../src/credential-vault.mjs';
import {createPrivateRecord} from '../src/private-state.mjs';

test('capabilities can declare and persist parallel calls unavailable for one AI while keeping tools on',async t=>{
  const root=await mkdtemp(join(tmpdir(),'sudocli-capability-command-'));t.after(()=>rm(root,{recursive:true,force:true}));
  const selected={model:'fixture-model',baseUrl:'http://127.0.0.1:1/v1',transport:'responses',capabilities:{tools:true}};
  const settings={capabilities:{tools:true}},notes=[];
  const record=await createPrivateRecord({directory:join(root,'configuration'),filename:'fixture.json'});
  const commands=await createUpgradeCommands({cwd:root,stateDir:join(root,'state'),settings,note:text=>notes.push(text),ask:async()=>'',getConnection:()=>selected,
    reconfigureBudget:async budget=>record.write({budget,capabilityByIdentity:settings.capabilityByIdentity}),reconnect:async()=>{}});
  assert.equal(await commands.handle({name:'/capabilities',args:['declare','parallelToolCalls','off']}),true);
  const persisted=await record.read();
  assert.deepEqual(persisted.capabilityByIdentity[credentialIdentity(selected)],{tools:true,parallelToolCalls:false});
  const report=JSON.parse(notes.at(-1));
  assert.equal(report.capabilities.parallelToolCalls.declared,false);
  assert.equal(report.capabilities.tools.declared,true);
});
test('offline upgrade commands keep memory and readable preferences usable without a model',async()=>{
  const root=await mkdtemp(join(tmpdir(),'sudocli-upgrade-command-')),settings={},notes=[];
  const memory=await createProjectMemory({cwd:root,stateDir:join(root,'state')});
  const commands=await createUpgradeCommands({cwd:root,stateDir:join(root,'state'),settings,memory,note:text=>notes.push(text),ask:async()=>'',getConnection:()=>undefined,reconnect:async()=>{throw Error('must stay offline');},history:{snapshot:()=>({messages:[]})}});
  assert.equal(await commands.handle({name:'/readability',args:['on']}),true);assert.equal(settings.clearReading,true);
  assert.equal(await commands.handle({name:'/memory',args:['show']}),true);assert.match(notes.at(-1),/empty/i);
  await assert.rejects(commands.handle({name:'/test-connection',args:[]}),/connect/i);
});
test('a newer narrowed scope survives leaving a read-only planning workflow',async()=>{const root=await mkdtemp(join(tmpdir(),'sudocli-workflow-scope-'));const settings={scope:'full'},workflow={mode:'edit',setMode(mode){this.mode=mode;},snapshot(){return {mode:this.mode};}};const commands=await createUpgradeCommands({cwd:root,stateDir:join(root,'state'),settings,workflow,note:()=>{},ask:async()=>'',getConnection:()=>undefined,stopBackground:async()=>{}});await commands.handle({name:'/workflow',args:['plan']});assert.equal(settings.scope,'read-only');await commands.handle({name:'/permissions',args:['scope','project']});assert.equal(settings.scope,'read-only');await commands.handle({name:'/workflow',args:['edit']});assert.equal(settings.scope,'project');});

test('Windows write-folder spelling aliases are canonicalized while junction ancestors remain refused',{skip:process.platform!=='win32'},async t=>{
  const root=await mkdtemp(join(tmpdir(),'sudo-write-folder-case-'));t.after(()=>rm(root,{recursive:true,force:true}));
  const folder=join(root,'WrItE-FoLdEr'),alias=join(root,'wRiTe-fOlDeR');await mkdir(folder);
  const settings={},commands=await createUpgradeCommands({cwd:root,stateDir:join(root,'state'),settings,note:()=>{},ask:async()=>'',getConnection:()=>undefined,stopBackground:async()=>{}});
  await commands.handle({name:'/permissions',args:['folders','add',alias]});
  assert.deepEqual(settings.writableRoots,[await realpath(folder)]);
  const outside=join(root,'outside'),junction=join(root,'junction');await mkdir(outside);await mkdir(join(outside,'nested'));await symlink(outside,junction,'junction');
  await assert.rejects(commands.handle({name:'/permissions',args:['folders','add',join(junction,'nested')]}),/real folder/);
  assert.deepEqual(settings.writableRoots,[await realpath(folder)]);
});
