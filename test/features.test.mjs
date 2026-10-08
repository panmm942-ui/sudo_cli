import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createChatHistory } from '../src/chat-history.mjs';
import { createModelProfiles } from '../src/model-profiles.mjs';

async function fixture(t, {engine = {}, answers = []} = {}) {
  const cwd = await mkdtemp(join(tmpdir(),'sudocli-features-')); t.after(()=>rm(cwd,{recursive:true,force:true}));
  const profiles = await createModelProfiles({stateDir:join(cwd,'state')});
  const history = createChatHistory({secrets:()=>['private-key']});
  const settings = {permissions:'ask',webAccess:false,mcp:new Map(),attachments:[],skills:[],effort:undefined};
  let connection = {model:'fixture',baseUrl:'http://localhost:8000/v1',transport:'chat-completions',apiKey:'private-key'};
  const messages = []; const calls = [];
  const { createFeatureCommands } = await import('../src/features.mjs');
  const features = createFeatureCommands({cwd,settings,profiles,history,note:message=>messages.push(message),ask:async()=>answers.shift()||'',getConnection:()=>connection,getEngine:()=>engine,reconnect:async(selected,options)=>{connection=selected;calls.push(options);},configure:async()=>connection,runTurn:async()=>{},runCompact:async()=>{},getSnapshot:()=>({}),rememberSecret:()=>{},stop:()=>{}});
  return {cwd,profiles,history,settings,features,messages,calls};
}

test('command routing saves nonsecret model metadata and exports the whole chat', async t => {
  const f=await fixture(t);
  await f.features.handle({name:'/switch',args:['save','My local AI']});
  assert.equal((await f.profiles.get('My local AI')).model,'fixture');
  assert.equal((await f.profiles.get('My local AI')).apiKey,undefined);
  f.history.addUser('whole question'); f.history.finishAssistant('one','whole answer private-key');
  await f.features.handle({name:'/handoff',args:[join(f.cwd,'handoff')]});
  const {readdir}=await import('node:fs/promises'); const files=await readdir(join(f.cwd,'handoff'));
  const text=await readFile(join(f.cwd,'handoff',files.find(name=>name.endsWith('.md'))),'utf8');
  assert.match(text,/whole question/);assert.match(text,/whole answer/);assert.doesNotMatch(text,/private-key/);
});

test('saving a selected profile under a new name does not overwrite its original name', async t => {
  const f=await fixture(t);
  await f.features.handle({name:'/switch',args:['save','Original']});
  await f.features.handle({name:'/switch',args:['Original']});
  await f.features.handle({name:'/switch',args:['save','New name']});
  assert.equal((await f.profiles.get('New name')).name,'New name');
  assert.equal((await f.profiles.get('Original')).name,'Original');
});

test('request preflight can inspect full switched history and attachments without losing them', async t => {
  const f=await fixture(t);const path=join(f.cwd,'source.txt');await writeFile(path,'saved contents');
  f.settings.pendingContext='Whole previous chat';
  await f.features.handle({name:'/upload',args:[path]});
  const first=f.features.prepareTurn('task',{consume:false});
  assert.deepEqual(f.features.prepareTurn('task',{consume:false}),first);
  assert.ok(first.some(item=>item.text==='Whole previous chat'));
  assert.ok(first.some(item=>item.text?.includes('saved contents')));
  assert.deepEqual(f.features.prepareTurn('task'),first);
  assert.equal(f.features.prepareTurn('next').length,1);
});

test('computer Off disables raw computer tools and new servers, preserving known noncomputer tools', async t => {
  const {enabledMcpEntries}=await import('../src/computer-policy.mjs');
  const f=await fixture(t,{engine:{listMcpTools:async()=>[
    {serverName:'mixed',name:'flattened_click',tool:{name:'browser_click'}},
    {serverName:'mixed',name:'add_numbers',tool:{name:'add_numbers'}},
    {serverName:'math',name:'add_numbers',tool:{name:'add_numbers'}},
  ]}});
  f.settings.webAccess=true;f.settings.mcp.set('mixed','http://localhost:8001/mcp');f.settings.mcp.set('math','http://localhost:8002/mcp');
  f.settings.mcp.set('connecting','http://localhost:8005/mcp');
  await f.features.handle({name:'/computer-use',args:['off']});
  assert.deepEqual(f.settings.disabledComputerTools.get('mixed'),['browser_click']);
  assert.deepEqual(enabledMcpEntries(f.settings).map(([name])=>name),['mixed','math']);
  await f.features.handle({name:'/mcp',args:['add','new','http://localhost:8003/mcp']});
  assert.ok(!enabledMcpEntries(f.settings).some(([name])=>name==='new'));
  await f.features.handle({name:'/computer-use',args:['setup','desktop','http://localhost:8004/mcp']});
  assert.ok(!enabledMcpEntries(f.settings).some(([name])=>name==='desktop'));
  await f.features.handle({name:'/computer-use',args:['on']});
  assert.equal(enabledMcpEntries(f.settings).length,5);
});

test('failed MCP discovery while switching Computer Off disables every unclassified server', async t => {
  const {enabledMcpEntries}=await import('../src/computer-policy.mjs');
  const f=await fixture(t,{engine:{listMcpTools:async()=>{throw new Error('unavailable');}}});
  f.settings.webAccess=true;f.settings.mcp.set('unknown','http://localhost:8001/mcp');
  await f.features.handle({name:'/computer-use',args:['off']});
  assert.deepEqual(enabledMcpEntries(f.settings),[]);
});

test('uploads queue immutable contents for one prompt and native options reconnect', async t => {
  const f=await fixture(t); const path=join(f.cwd,'source.txt');await writeFile(path,'original source');
  await f.features.handle({name:'/upload',args:[path]});await writeFile(path,'later change');
  const input=f.features.prepareTurn('please inspect');
  assert.ok(input.some(item=>item.text?.includes('original source')));
  assert.ok(!input.some(item=>item.text?.includes('later change')));
  assert.equal(f.features.prepareTurn('next task').length,1);
  await f.features.handle({name:'/web',args:['on']});assert.equal(f.settings.webAccess,true);assert.equal(f.calls.length,1);
});
