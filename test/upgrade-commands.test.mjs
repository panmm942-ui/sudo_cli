import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createUpgradeCommands} from '../src/upgrades.mjs';
import {createProjectMemory} from '../src/project-memory.mjs';
test('offline upgrade commands keep memory and readable preferences usable without a model',async()=>{
  const root=await mkdtemp(join(tmpdir(),'sudocli-upgrade-command-')),settings={},notes=[];
  const memory=await createProjectMemory({cwd:root,stateDir:join(root,'state')});
  const commands=await createUpgradeCommands({cwd:root,stateDir:join(root,'state'),settings,memory,note:text=>notes.push(text),ask:async()=>'',getConnection:()=>undefined,reconnect:async()=>{throw Error('must stay offline');},history:{snapshot:()=>({messages:[]})}});
  assert.equal(await commands.handle({name:'/readability',args:['on']}),true);assert.equal(settings.clearReading,true);
  assert.equal(await commands.handle({name:'/memory',args:['show']}),true);assert.match(notes.at(-1),/empty/i);
  await assert.rejects(commands.handle({name:'/test-connection',args:[]}),/connect/i);
});
test('a newer narrowed scope survives leaving a read-only planning workflow',async()=>{const root=await mkdtemp(join(tmpdir(),'sudocli-workflow-scope-'));const settings={scope:'full'},workflow={mode:'edit',setMode(mode){this.mode=mode;},snapshot(){return {mode:this.mode};}};const commands=await createUpgradeCommands({cwd:root,stateDir:join(root,'state'),settings,workflow,note:()=>{},ask:async()=>'',getConnection:()=>undefined,stopBackground:async()=>{}});await commands.handle({name:'/workflow',args:['plan']});assert.equal(settings.scope,'read-only');await commands.handle({name:'/permissions',args:['scope','project']});assert.equal(settings.scope,'read-only');await commands.handle({name:'/workflow',args:['edit']});assert.equal(settings.scope,'project');});
