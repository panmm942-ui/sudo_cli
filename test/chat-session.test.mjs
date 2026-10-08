import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from './fixtures/temp-root.mjs';
import { join } from 'node:path';
import { createChatStore } from '../src/chat-store.mjs';
import { createChatHistory } from '../src/chat-history.mjs';
import { createChatSession } from '../src/chat-session.mjs';

test('checkpoints and resumes the complete conversation and unexecuted prompts', async t => {
  const stateDir = await mkdtemp(join(tmpdir(),'sudocli-chat-session-'));t.after(()=>rm(stateDir,{recursive:true,force:true}));
  const store=await createChatStore({stateDir,cwd:stateDir});let pending=['queued prompt'];
  let history=createChatHistory();let session=createChatSession({store,history,getPending:()=>pending,getConnection:()=>({model:'fixture',baseUrl:'http://localhost/v1',transport:'chat-completions'})});
  await session.ensure();history.addUser('first');history.appendAssistant('a','partial reply');await session.checkpoint();await session.flush();
  history=createChatHistory();session=createChatSession({store,history});const resumed=await session.resumeLast();
  assert.deepEqual(history.snapshot().messages.map(m=>m.content),['first','partial reply']);assert.deepEqual(resumed.pendingInputs,pending);
  assert.equal(history.snapshot().messages[1].status,'interrupted');
});

test('queued writes cannot overwrite another chat during new/open and discard is explicit',async t=>{
  const stateDir=await mkdtemp(join(tmpdir(),'sudocli-chat-session-'));t.after(()=>rm(stateDir,{recursive:true,force:true}));
  const store=await createChatStore({stateDir,cwd:stateDir}),history=createChatHistory();const session=createChatSession({store,history});
  await session.ensure();const first=session.current().id;history.addUser('old');const writes=[session.checkpoint(),session.checkpoint()];
  const fresh=await session.newChat({keep:true});await Promise.all(writes);assert.notEqual(fresh.id,first);assert.equal(history.snapshot().messages.length,0);
  assert.deepEqual((await store.get(first)).history.messages.map(m=>m.content),['old']);
  history.addUser('new');await session.checkpoint();await session.open(first);assert.deepEqual(history.snapshot().messages.map(m=>m.content),['old']);
  await session.newChat({keep:false});assert.equal(await store.get(first),undefined);assert.equal((await store.get(fresh.id)).history.messages[0].content,'new');
});
