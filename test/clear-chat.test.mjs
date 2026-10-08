import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from './fixtures/temp-root.mjs';
import {createChatHistory} from '../src/chat-history.mjs';
import {createChatStore} from '../src/chat-store.mjs';
import {createChatSession} from '../src/chat-session.mjs';
import {createAssistantFeatures} from '../src/assistant-features.mjs';
import {fileURLToPath} from 'node:url';
import {runFixtureProcess} from './fixtures/native-process.mjs';

async function fixture(t,{answers=[],ask}={}) {
  const cwd=await mkdtemp(join(tmpdir(),'sudocli-clear-chat-'));
  t.after(()=>rm(cwd,{recursive:true,force:true}));
  const store=await createChatStore({cwd,stateDir:cwd}),history=createChatHistory();
  const chatSession=createChatSession({store,history});
  await chatSession.ensure();await chatSession.rename('Keep this chat');
  history.recordSubmission({sequence:1});history.addUser('Remember the blue bicycle.',{sequence:1});
  history.finishAssistant('old-reply','The bicycle is blue.');
  await chatSession.checkpoint();
  const questions=[],changes=[],notes=[];
  const api=createAssistantFeatures({cwd,stateDir:cwd,settings:{},chatSession,
    getConnection:()=>undefined,note:text=>notes.push(text),
    ask:async prompt=>{questions.push(prompt);return ask?ask(prompt):answers.shift()??'';},
    onChatChange:async change=>changes.push(change)});
  return {api,store,history,chatSession,questions,changes,notes};
}

test('/clear No clears both visible roles in the same saved chat while keeping AI context',async t=>{
  const f=await fixture(t,{answers:['n']}),before=f.chatSession.current();
  assert.equal(await f.api.handle({name:'/clear'}),true);
  assert.match(f.questions[0],/forget.*previous messages.*y\/N/i);
  assert.deepEqual(f.history.snapshot().messages,[]);
  assert.equal(f.chatSession.current().id,before.id);assert.equal(f.chatSession.current().title,before.title);
  assert.equal(f.history.snapshot().promptCount,1);
  assert.deepEqual(f.chatSession.contextSnapshot().messages.map(message=>message.content),['Remember the blue bicycle.','The bicycle is blue.']);
  assert.deepEqual((await f.store.get(before.id)).history.messages,[]);
  assert.equal(f.changes.length,1);assert.equal(f.changes[0].reason,'clear');assert.equal(f.changes[0].forget,false);
  assert.match(f.notes.at(-1),/cleared.*memory kept/i);
});

test('/clear Yes forgets prior AI context as well as clearing the same visible chat',async t=>{
  const f=await fixture(t,{answers:['YES']}),id=f.chatSession.current().id;
  assert.equal(await f.api.handle({name:'/clear'}),true);
  assert.deepEqual(f.history.snapshot().messages,[]);assert.deepEqual(f.chatSession.contextSnapshot().messages,[]);
  assert.equal(f.chatSession.current().id,id);assert.equal(f.changes[0].forget,true);
  assert.match(f.notes.at(-1),/cleared.*memory forgotten/i);
});

test('/clear asks again after invalid input and defaults Enter to keeping AI memory',async t=>{
  const f=await fixture(t,{answers:['maybe','']});
  assert.equal(await f.api.handle({name:'/clear'}),true);
  assert.equal(f.questions.length,2);assert.equal(f.changes.length,1);assert.equal(f.changes[0].forget,false);
  assert.equal(f.chatSession.contextSnapshot().messages.length,2);
});

test('canceling /clear keeps both conversation and AI memory unchanged',async t=>{
  const f=await fixture(t,{ask:async()=>{throw new DOMException('Canceled','AbortError');}}),before=f.history.snapshot();
  await assert.rejects(f.api.handle({name:'/clear'}),{name:'AbortError'});
  assert.deepEqual(f.history.snapshot(),before);assert.deepEqual(f.changes,[]);
});

test('/clear storage failure does not report success or clear the UI',async t=>{
  const f=await fixture(t,{answers:['y']}),before=f.history.snapshot();
  const original=f.store.save;f.store.save=async()=>{throw new Error('Synthetic storage failure');};
  t.after(()=>{f.store.save=original;});
  await assert.rejects(f.api.handle({name:'/clear'}),/storage failure/i);
  assert.deepEqual(f.history.snapshot(),before);assert.deepEqual(f.changes,[]);
  assert.ok(!f.notes.some(note=>/Chat cleared/.test(note)));
});

test('a committed clear that cannot save new arrivals still updates its UI before reporting the error',async t=>{
  const f=await fixture(t,{answers:['y']});
  const clear=f.chatSession.clear.bind(f.chatSession);
  f.chatSession.clear=async options=>{
    const record=await clear(options);
    throw Object.assign(new Error('Synthetic save of new arrivals failed after clear committed.'),{code:'CHAT_CLEAR_COMMITTED',record});
  };
  await assert.rejects(f.api.handle({name:'/clear'}),{code:'CHAT_CLEAR_COMMITTED'});
  assert.deepEqual(f.history.snapshot().messages,[]);
  assert.equal(f.changes.length,1);assert.equal(f.changes[0].reason,'clear');assert.equal(f.changes[0].forget,true);
  assert.equal(f.changes[0].record.id,f.chatSession.current().id);
  assert.ok(!f.notes.some(note=>note.startsWith('Chat cleared.')));
});

for(const scenario of ['yes','no','cancel','voice-stop-failure'])test(`/clear ${scenario} drains foreground activity safely before changing saved chat`,{timeout:20000},async()=>{
  const fixturePath=fileURLToPath(new URL('./fixtures/clear-active-background.mjs',import.meta.url));
  const result=await runFixtureProcess(process.execPath,['--experimental-test-module-mocks',fixturePath,'--clear-background-scenario',scenario],{timeoutMs:15000});
  const proof=JSON.parse(result.stdout.trim());
  assert.equal(proof.scenario,scenario);assert.equal(proof.passed,true);
});
