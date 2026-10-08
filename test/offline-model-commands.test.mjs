import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm,writeFile} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {createFeatureCommands} from '../src/features.mjs';
import {createUpgradeCommands} from '../src/upgrades.mjs';
import {createModelProfiles} from '../src/model-profiles.mjs';
import {createChatHistory} from '../src/chat-history.mjs';
import * as runtime from '../src/runtime.mjs';

async function fixture(t){
  const cwd=await mkdtemp(join(tmpdir(),'sudocli-offline-model-'));t.after(()=>rm(cwd,{recursive:true,force:true}));
  const stateDir=join(cwd,'state'),profiles=await createModelProfiles({stateDir});
  const settings={permissions:'ask',webAccess:false},notes=[];
  let connection;
  const commands=createFeatureCommands({cwd,settings,profiles,history:createChatHistory(),note:message=>notes.push(message),ask:async()=>'',getConnection:()=>connection,getEngine:()=>undefined,reconnect:async selected=>{connection=selected;},configure:async()=>({model:'fixture',baseUrl:'http://127.0.0.1:8000/v1',transport:'chat-completions'}),rememberSecret:()=>{},getSnapshot:()=>({})});
  return {cwd,stateDir,profiles,settings,notes,commands,setConnection:value=>{connection=value;},getConnection:()=>connection};
}

test('offline uploads remain queued until one prompt after connecting',async t=>{
  const f=await fixture(t),path=join(f.cwd,'source.txt');await writeFile(path,'offline original contents');
  assert.equal(await f.commands.handle({name:'/upload',args:[path]}),true);
  assert.equal(f.settings.attachments.length,1);assert.equal(f.getConnection(),undefined);
  await writeFile(path,'modified after attachment');await f.commands.handle({name:'/connect'});
  const preflight=f.commands.prepareTurn('inspect',{consume:false});
  assert.ok(preflight.some(item=>item.text?.includes('offline original contents')));
  assert.ok(!preflight.some(item=>item.text?.includes('modified after attachment')));
  assert.equal(f.settings.attachments.length,1);
  assert.deepEqual(f.commands.prepareTurn('inspect'),preflight);
  assert.equal(f.commands.prepareTurn('next').length,1);
});

test('offline effort status and default reset work while overrides require a selected AI',async t=>{
  const f=await fixture(t);f.settings.effort='high';
  assert.equal(await f.commands.handle({name:'/effort'}),true);
  assert.match(f.notes.join('\n'),/no AI|not selected|select an AI/i);
  assert.equal(await f.commands.handle({name:'/effort',args:['default']}),true);
  assert.equal(f.settings.effort,undefined);
  await assert.rejects(f.commands.handle({name:'/effort',args:['high']}),/connect/i);
});

test('switching away from a declared custom effort clears the incompatible override',async t=>{
  const f=await fixture(t);
  f.setConnection({model:'adaptive-model',baseUrl:'http://127.0.0.1:8000/v1',transport:'chat-completions',supportedEfforts:['adaptive']});f.settings.effort='adaptive';
  await f.commands.handle({name:'/model',args:['other-model']});
  assert.equal(f.settings.effort,undefined);assert.equal(f.getConnection().supportedEfforts,undefined);
});

test('effort compatibility keeps unknown native levels and declared custom levels only',()=>{
  assert.equal(typeof runtime.resolveReasoningEffort,'function');
  const cases=[
    ['high',{},'high'],['adaptive',{supportedEfforts:['adaptive']},'adaptive'],
    ['adaptive',{},undefined],['high',{supportedEfforts:['low']},undefined],
    ['high',{capabilities:{reasoning:false}},undefined],[undefined,{supportedEfforts:['low']},undefined],
  ];
  for(const [effort,connection,want] of cases)assert.equal(runtime.resolveReasoningEffort(effort,connection),want);
});

test('offline credential status and profile listing do not read protected keys',async t=>{
  const f=await fixture(t);await f.profiles.save({name:'Saved local AI',model:'fixture',baseUrl:'http://127.0.0.1:8000/v1',transport:'chat-completions',apiKey:'must-not-be-listed'});
  const vault={backend:'fixture OS vault',load(){throw Error('status must not decrypt credentials');},save(){throw Error('not authorized');},remove(){throw Error('not authorized');}};
  const upgrades=await createUpgradeCommands({cwd:f.cwd,stateDir:f.stateDir,settings:f.settings,profiles:f.profiles,vault,note:message=>f.notes.push(message),getConnection:f.getConnection});
  for(const args of [[],['status'],['help'],['list']])assert.equal(await upgrades.handle({name:'/credentials',args}),true);
  assert.match(f.notes.join('\n'),/fixture OS vault/);assert.match(f.notes.join('\n'),/Saved local AI/);
  assert.doesNotMatch(f.notes.join('\n'),/must-not-be-listed/);
  for(const args of [['save'],['forget']])await assert.rejects(upgrades.handle({name:'/credentials',args}),/connect/i);
  await assert.rejects(upgrades.handle({name:'/credentials',args:['misspelled']}),/credentials/i);
});

test('clearing queued skills stays local while skill discovery requires an AI',async t=>{
  const f=await fixture(t);f.settings.skills.push({type:'skill',name:'fixture',path:join(f.cwd,'SKILL.md')});
  assert.equal(await f.commands.handle({name:'/skills',args:['clear']}),true);
  assert.deepEqual(f.settings.skills,[]);assert.equal(f.getConnection(),undefined);
  await assert.rejects(f.commands.handle({name:'/skills',args:['list']}),/connect/i);
});

test('offline MCP list shows configured servers without calling a native engine',async t=>{
  const f=await fixture(t);f.settings.webAccess=true;f.settings.mcp.set('fixture-server','http://127.0.0.1:8001/mcp');
  assert.equal(await f.commands.handle({name:'/mcp',args:['list']}),true);
  assert.match(f.notes.join('\n'),/fixture-server/);assert.match(f.notes.join('\n'),/connect.*AI/i);
  assert.equal(f.settings.mcp.size,1);assert.equal(f.getConnection(),undefined);
});

test('offline MCP and computer discovery return a connection instruction instead of a TypeError',async t=>{
  const f=await fixture(t);f.settings.webAccess=true;
  for(const command of [{name:'/mcp',args:['tools']},{name:'/computer-use'}]){
    await assert.rejects(f.commands.handle(command),error=>error instanceof Error&&!(error instanceof TypeError)&&/connect.*AI/i.test(error.message));
  }
});
