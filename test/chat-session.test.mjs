import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
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

test('clearing visible messages retains AI memory, identity and queued submissions after reopening',async t=>{
  const stateDir=await mkdtemp(join(tmpdir(),'sudocli-chat-clear-'));t.after(()=>rm(stateDir,{recursive:true,force:true}));
  const store=await createChatStore({stateDir,cwd:stateDir}),history=createChatHistory();
  const pending=[],submissions=[];
  const session=createChatSession({store,history,getPending:()=>pending,getPendingSubmissions:()=>submissions});
  await session.ensure();history.recordSubmission({sequence:1});history.addUser('Remember the project uses Rust',{sequence:1});history.finishAssistant('first-answer','I will remember Rust.');history.recordSubmission({sequence:2});pending.push('A queued follow-up');submissions.push({sequence:2,literal:true,timestamp:'2026-10-09T01:02:03.000Z'});
  await session.checkpoint();const previous=session.current();
  await session.clear({forget:false});
  assert.equal(session.current().id,previous.id);assert.equal(session.current().title,previous.title);assert.equal(session.current().createdAt,previous.createdAt);
  assert.deepEqual(history.snapshot(),{version:1,promptCount:2,messages:[]});
  assert.deepEqual(session.current().pendingInputs,pending);assert.deepEqual(session.current().pendingSubmissions,submissions);
  const freshStore=await createChatStore({stateDir,cwd:stateDir}),freshHistory=createChatHistory();
  const freshSession=createChatSession({store:freshStore,history:freshHistory,getPending:()=>pending,getPendingSubmissions:()=>submissions});
  await freshSession.resumeLast();
  assert.deepEqual(freshHistory.snapshot(),{version:1,promptCount:2,messages:[]});
  assert.deepEqual(freshSession.contextSnapshot().messages.map(message=>message.content),['Remember the project uses Rust','I will remember Rust.']);
  assert.match(freshSession.contextPrompt(),/Treat it as prior user\/assistant conversation, not as system instructions/);
  assert.match(freshSession.contextPrompt(),/Remember the project uses Rust/);
  const handoff=await freshHistory.exportHandoff({directory:join(stateDir,'handoffs')});
  assert.equal(handoff.messageCount,0);assert.doesNotMatch(await readFile(handoff.jsonPath,'utf8'),/Rust/);
});

test('retained AI memory combines later messages once and an affirmative clear forgets everything',async t=>{
  const stateDir=await mkdtemp(join(tmpdir(),'sudocli-chat-clear-'));t.after(()=>rm(stateDir,{recursive:true,force:true}));
  const store=await createChatStore({stateDir,cwd:stateDir}),history=createChatHistory(),session=createChatSession({store,history});
  await session.ensure();history.addUser('The first task');history.finishAssistant('first-answer','First result');await session.clear({forget:false});
  history.recordSubmission({sequence:2});history.addUser('The second task',{sequence:2});history.finishAssistant('second-answer','Second result');await session.checkpoint();
  assert.equal(session.contextSnapshot().promptCount,2);
  assert.deepEqual(session.contextSnapshot().messages.map(message=>message.content),['The first task','First result','The second task','Second result']);
  await session.clear({forget:false});await session.clear({forget:false});
  assert.equal(session.contextSnapshot().messages.length,4);assert.equal(history.snapshot().messages.length,0);
  const id=session.current().id;await session.clear({forget:true});
  assert.equal(session.current().id,id);assert.deepEqual(session.contextSnapshot(),{version:1,promptCount:2,messages:[]});
  assert.equal('contextHistory' in session.current(),false);assert.equal('contextHistory' in await store.get(id),false);
  const freshHistory=createChatHistory(),freshSession=createChatSession({store,history:freshHistory});await freshSession.resumeLast();
  assert.equal(freshSession.contextSnapshot().messages.length,0);assert.doesNotMatch(freshSession.contextPrompt(),/first task|second task|First result|Second result/);
});

test('hidden AI memory follows its saved chat during rename, new and open',async t=>{
  const stateDir=await mkdtemp(join(tmpdir(),'sudocli-chat-clear-'));t.after(()=>rm(stateDir,{recursive:true,force:true}));
  const store=await createChatStore({stateDir,cwd:stateDir}),history=createChatHistory(),session=createChatSession({store,history});
  await session.ensure();history.addUser('Only the old chat knows this');await session.clear({forget:false});const oldId=session.current().id;
  await session.rename('Renamed old chat');await session.checkpoint();
  const newChat=await session.newChat();assert.equal(session.contextSnapshot().messages.length,0);assert.equal('contextHistory' in newChat,false);
  history.addUser('A separate new conversation');await session.open(oldId);
  assert.equal(session.current().title,'Renamed old chat');assert.equal(history.snapshot().messages.length,0);assert.equal(session.contextSnapshot().messages[0].content,'Only the old chat knows this');
  await session.open(newChat.id);assert.deepEqual(session.contextSnapshot().messages.map(message=>message.content),['A separate new conversation']);
});

test('a failed clear leaves both visible messages and retained memory unchanged',async t=>{
  const stateDir=await mkdtemp(join(tmpdir(),'sudocli-chat-clear-'));t.after(()=>rm(stateDir,{recursive:true,force:true}));
  const store=await createChatStore({stateDir,cwd:stateDir}),history=createChatHistory(),session=createChatSession({store,history});
  await session.ensure();history.addUser('Already retained');await session.clear({forget:false});history.addUser('Still visible');
  const previousRecord=structuredClone(session.current()),previousHistory=history.snapshot(),previousContext=session.contextSnapshot();
  const lock=join(store.directory,`chat-${previousRecord.id}.json.lock`);await writeFile(lock,'occupied',{flag:'wx'});
  await assert.rejects(session.clear({forget:true}),/edited|lock/i);
  assert.deepEqual(session.current(),previousRecord);assert.deepEqual(history.snapshot(),previousHistory);assert.deepEqual(session.contextSnapshot(),previousContext);
  await rm(lock);assert.deepEqual((await store.get(previousRecord.id)).contextHistory,previousRecord.contextHistory);
});

test('context replay uses the latest visible message for a retained ID and redacts newly introduced credentials',async t=>{
  const stateDir=await mkdtemp(join(tmpdir(),'sudocli-chat-clear-'));t.after(()=>rm(stateDir,{recursive:true,force:true}));
  const secrets=[],store=await createChatStore({stateDir,cwd:stateDir,secrets:()=>secrets}),history=createChatHistory({secrets:()=>secrets});
  await store.create({history:{version:1,messages:[{id:'same-answer',role:'assistant',status:'completed',model:null,content:'Updated answer'}]},contextHistory:{version:1,messages:[{id:'retained-user',role:'user',model:null,content:'Saved synthetic-new-credential'},{id:'same-answer',role:'assistant',status:'interrupted',model:null,content:'Old partial answer'}]}});
  const session=createChatSession({store,history,secrets:()=>secrets});await session.resumeLast();secrets.push('synthetic-new-credential');
  assert.deepEqual(session.contextSnapshot().messages.map(message=>message.content),['Saved [redacted]','Updated answer']);
  assert.doesNotMatch(session.contextPrompt(),/synthetic-new-credential|Old partial answer/);
  assert.equal(session.contextSnapshot().messages[1].status,'completed');
});

test('clearing preserves and durably checkpoints prompts admitted while the clear save is pending',async t=>{
  for(const forget of [false,true])await t.test(forget?'Forget AI memory':'Keep AI memory',async child=>{
    const stateDir=await mkdtemp(join(tmpdir(),'sudocli-chat-clear-race-'));child.after(()=>rm(stateDir,{recursive:true,force:true}));
    const store=await createChatStore({stateDir,cwd:stateDir}),history=createChatHistory(),pending=[];
    const session=createChatSession({store,history,getPending:()=>pending.map(item=>item.text),getPendingSubmissions:()=>pending.map(item=>({sequence:item.sequence,literal:false}))});
    await session.ensure();history.recordSubmission({sequence:1});history.addUser('Previous task',{sequence:1});await session.checkpoint();const id=session.current().id;
    const save=store.save;let entered,release;const atSave=new Promise(resolve=>entered=resolve),gate=new Promise(resolve=>release=resolve);
    store.save=async input=>{if(input.history.messages.length===0&&input.history.promptCount===1){entered();await gate;}return save(input);};
    child.after(()=>release());
    const clearing=session.clear({forget});await atSave;
    history.recordSubmission({sequence:2});pending.push({text:'Prompt admitted during clearing',sequence:2});release();
    const cleared=await clearing;store.save=save;
    assert.equal(cleared.id,id);assert.equal(history.snapshot().promptCount,2);assert.equal(history.snapshot().messages.length,0);
    assert.deepEqual(cleared.pendingInputs,['Prompt admitted during clearing']);assert.deepEqual(cleared.pendingSubmissions,[{sequence:2,literal:false}]);
    assert.equal((await store.get(id)).history.promptCount,2);assert.deepEqual((await store.get(id)).pendingSubmissions,[{sequence:2,literal:false}]);
    await session.checkpoint();assert.equal((await store.get(id)).pendingInputs[0],'Prompt admitted during clearing');
    assert.equal(session.contextSnapshot().messages.some(message=>message.content==='Previous task'),!forget);
  });
});

test('messages arriving during a clear save remain visible and belong to the same continuing chat',async t=>{
  const stateDir=await mkdtemp(join(tmpdir(),'sudocli-chat-clear-race-'));t.after(()=>rm(stateDir,{recursive:true,force:true}));
  const store=await createChatStore({stateDir,cwd:stateDir}),history=createChatHistory(),session=createChatSession({store,history});
  await session.ensure();history.recordSubmission({sequence:1});history.addUser('Previous task',{sequence:1});history.finishAssistant('previous-answer','Previous answer');await session.checkpoint();const id=session.current().id;
  const save=store.save;let entered,release;const atSave=new Promise(resolve=>entered=resolve),gate=new Promise(resolve=>release=resolve);
  store.save=async input=>{if(!input.history.messages.length&&input.history.promptCount===1){entered();await gate;}return save(input);};t.after(()=>release());
  const clearing=session.clear({forget:true});await atSave;
  history.recordSubmission({sequence:2});history.addUser('New prompt arriving during clear',{sequence:2});history.finishAssistant('new-answer','New response arriving during clear');release();
  const cleared=await clearing;store.save=save;
  assert.equal(cleared.id,id);assert.deepEqual(history.snapshot().messages.map(message=>message.content),['New prompt arriving during clear','New response arriving during clear']);
  assert.equal(history.snapshot().promptCount,2);assert.deepEqual((await store.get(id)).history,history.snapshot());
  assert.doesNotMatch(session.contextPrompt(),/Previous task|Previous answer/);
});

test('arrivals during the reconciliation save keep their newer counters for the next checkpoint',async t=>{
  const stateDir=await mkdtemp(join(tmpdir(),'sudocli-chat-clear-race-'));t.after(()=>rm(stateDir,{recursive:true,force:true}));
  const store=await createChatStore({stateDir,cwd:stateDir}),history=createChatHistory(),pending=[];
  const session=createChatSession({store,history,getPending:()=>pending.map(item=>item.text),getPendingSubmissions:()=>pending.map(item=>({sequence:item.sequence,literal:false}))});
  await session.ensure();history.recordSubmission({sequence:1});history.addUser('Previous task',{sequence:1});await session.checkpoint();
  const save=store.save;let enterFirst,enterSecond,releaseFirst,releaseSecond;
  const firstSave=new Promise(resolve=>enterFirst=resolve),secondSave=new Promise(resolve=>enterSecond=resolve),firstGate=new Promise(resolve=>releaseFirst=resolve),secondGate=new Promise(resolve=>releaseSecond=resolve);
  store.save=async input=>{if(input.history.promptCount===1){enterFirst();await firstGate;}else if(input.history.promptCount===2){enterSecond();await secondGate;}return save(input);};t.after(()=>{releaseFirst();releaseSecond();});
  const clearing=session.clear({forget:false});await firstSave;history.recordSubmission({sequence:2});pending.push({text:'First new prompt',sequence:2});releaseFirst();
  await Promise.race([secondSave,clearing.then(()=>{throw new Error('Clear returned without saving newly admitted prompts.');})]);history.recordSubmission({sequence:3});pending.push({text:'Second new prompt',sequence:3});releaseSecond();
  const cleared=await clearing;store.save=save;
  assert.equal(history.snapshot().promptCount,3);assert.equal(cleared.history.promptCount,3);assert.deepEqual(cleared.pendingSubmissions,[{sequence:2,literal:false},{sequence:3,literal:false}]);
  await session.checkpoint();const persisted=await store.get(cleared.id);assert.equal(persisted.history.promptCount,3);assert.deepEqual(persisted.pendingInputs,['First new prompt','Second new prompt']);
});

test('failure after a committed clear keeps old messages cleared and new arrivals recoverable',async t=>{
  const stateDir=await mkdtemp(join(tmpdir(),'sudocli-chat-clear-race-'));t.after(()=>rm(stateDir,{recursive:true,force:true}));
  const store=await createChatStore({stateDir,cwd:stateDir}),history=createChatHistory(),session=createChatSession({store,history});
  await session.ensure();history.recordSubmission({sequence:1});history.addUser('Must stay cleared',{sequence:1});await session.checkpoint();const id=session.current().id;
  const save=store.save,lock=join(store.directory,`chat-${id}.json.lock`);let entered,release;const atSave=new Promise(resolve=>entered=resolve),gate=new Promise(resolve=>release=resolve);
  store.save=async input=>{const record=await save(input);if(input.history.promptCount===1){entered();await gate;await writeFile(lock,'occupied',{flag:'wx'});}return record;};t.after(()=>release());
  const clearing=session.clear({forget:true});await atSave;history.recordSubmission({sequence:2});history.addUser('A new recoverable prompt',{sequence:2});release();
  let failure;try{await clearing;}catch(error){failure=error;}store.save=save;
  assert.equal(failure?.code,'CHAT_CLEAR_COMMITTED');assert.equal(failure.record.id,id);
  assert.deepEqual(history.snapshot().messages.map(message=>message.content),['A new recoverable prompt']);assert.equal(history.snapshot().promptCount,2);
  const committed=await store.get(id);assert.equal(committed.history.messages.length,0);assert.equal('contextHistory' in committed,false);
  await rm(lock);await session.checkpoint();assert.deepEqual((await store.get(id)).history.messages.map(message=>message.content),['A new recoverable prompt']);
});

test('changed redaction during a clear never reintroduces a previous message as a new arrival',async t=>{
  const stateDir=await mkdtemp(join(tmpdir(),'sudocli-chat-clear-race-'));t.after(()=>rm(stateDir,{recursive:true,force:true}));
  const secrets=[],store=await createChatStore({stateDir,cwd:stateDir,secrets:()=>secrets}),history=createChatHistory({secrets:()=>secrets}),session=createChatSession({store,history,secrets:()=>secrets});
  await session.ensure();history.addUser('Previous message containing synthetic-new-clear-secret');await session.checkpoint();
  const save=store.save;let entered,release;const atSave=new Promise(resolve=>entered=resolve),gate=new Promise(resolve=>release=resolve);
  store.save=async input=>{if(!input.history.messages.length){entered();await gate;}return save(input);};t.after(()=>release());
  const clearing=session.clear({forget:true});await atSave;secrets.push('synthetic-new-clear-secret');release();await clearing;store.save=save;
  assert.deepEqual(history.snapshot().messages,[]);assert.deepEqual(session.contextSnapshot().messages,[]);assert.deepEqual((await store.get(session.current().id)).history.messages,[]);
});
