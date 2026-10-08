import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from './fixtures/temp-root.mjs';
import {createAssistantFeatures} from '../src/assistant-features.mjs';
import {parseCommand} from '../src/commands.mjs';
import {createTaskInbox} from '../src/task-inbox.mjs';

test('24.7 queues and inspects durable work without connecting or calling a model',async t=>{
  const stateDir=await mkdtemp(join(tmpdir(),'sudocli-background-command-'));
  t.after(()=>rm(stateDir,{recursive:true,force:true}));
  const notes=[];
  const api=createAssistantFeatures({cwd:stateDir,stateDir,settings:{},note:message=>notes.push(message),getConnection:()=>undefined,ask:async()=>{throw new Error('No setup or model prompt expected.');}});
  t.after(()=>api.stop());
  assert.equal(await api.handle(parseCommand('/24.7 add Check the build when ready.')),true);
  const inbox=await createTaskInbox({cwd:stateDir,stateDir}),jobs=await inbox.list();
  assert.equal(jobs.length,1);assert.equal(jobs[0].prompt,'Check the build when ready.');assert.equal(jobs[0].status,'pending');
  assert.equal(await api.handle(parseCommand('/24.7 list')),true);
  assert.ok(notes.some(note=>note.includes(jobs[0].id)&&note.includes('pending')));
  assert.equal(await api.handle(parseCommand('/247 status')),true);
  assert.ok(notes.at(-1).startsWith('24/7: Off'));
  assert.equal((await inbox.get(jobs[0].id)).status,'pending');
});

test('24.7 usage errors guide users to the new command',async t=>{
  const stateDir=await mkdtemp(join(tmpdir(),'sudocli-background-usage-'));
  t.after(()=>rm(stateDir,{recursive:true,force:true}));
  const api=createAssistantFeatures({cwd:stateDir,stateDir,settings:{},note:()=>{},getConnection:()=>undefined});
  t.after(()=>api.stop());
  await assert.rejects(api.handle(parseCommand('/24.7 add')),/Use \/24\.7 add TASK/);
  await assert.rejects(api.handle(parseCommand('/24.7 retry')),/Use \/24\.7 retry TASK_ID/);
});
