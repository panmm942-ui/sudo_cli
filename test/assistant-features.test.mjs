import test from 'node:test';import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createAssistantFeatures,parseLocalDecision} from '../src/assistant-features.mjs';
import {createChatStore} from '../src/chat-store.mjs';
import {createChatHistory} from '../src/chat-history.mjs';
import {createChatSession} from '../src/chat-session.mjs';
const connection={model:'fixture',baseUrl:'http://localhost/v1',transport:'chat-completions'};
function fixture(extra={}){const notes=[],answers=[];let value;const calls=[];const settings={};const api=createAssistantFeatures({settings,cwd:process.cwd(),note:s=>notes.push(s),ask:async()=>answers.shift()||'',getConnection:()=>connection,personalization:{get:async()=>value,save:async(c,v)=>value=v,remove:async()=>{value=undefined;}},reconnect:async(c,o)=>calls.push(o),chatSession:{list:async()=>[{id:'one',title:'First',updatedAt:'now'}],current:()=>({id:'one'}),newChat:async o=>{calls.push(o);return{id:'two'};},open:async id=>{calls.push(id);return{id};},rename:async()=>{},checkpoint:async()=>{},remove:async()=>{}},onChatChange:async change=>calls.push(change),...extra});return{api,notes,answers,calls,settings,get value(){return value;}};}
async function savedFixture(t,extra={}){
  const stateDir=await mkdtemp(join(tmpdir(),'sudocli-chat-commands-'));t.after(()=>rm(stateDir,{recursive:true,force:true}));
  const store=await createChatStore({stateDir,cwd:stateDir}),history=createChatHistory(),changes=[];
  const chatSession=createChatSession({store,history,getConnection:()=>connection});await chatSession.ensure();
  const f=fixture({cwd:stateDir,stateDir,chatSession,onChatChange:async change=>changes.push(change),...extra});
  return{...f,store,history,chatSession,changes};
}
test('preferences are optional per model and changes reconnect with visible history',async()=>{const f=fixture();f.answers.push('Helpful concise coder','English','calm','short','Markdown','');await f.api.handle({name:'/personalize',args:['setup']});assert.equal(f.value.enabled,true);assert.equal(f.value.preferences.language,'English');assert.deepEqual(f.calls,[{carryHistory:true}]);await f.api.handle({name:'/personalize',args:['off']});assert.equal(f.value.enabled,false);assert.equal(f.value.persona,'Helpful concise coder');});
test('new chat notifies the UI with its record after the save choice succeeds',async()=>{const f=fixture();f.answers.push('n');assert.equal(await f.api.handle({name:'/new',args:[]}),true);assert.deepEqual(f.calls,[{keep:false},{reason:'new',record:{id:'two'}}]);});
test('canonical chat command and compatibility aliases open saved chat selections',async()=>{for(const name of ['/chat','/chatt','/chats']){const f=fixture();f.answers.push('1');assert.equal(await f.api.handle({name,args:[]}),true);assert.deepEqual(f.calls,['one',{reason:'open',record:{id:'one'}}]);}});
test('chat new creates empty history and keeps the previous saved transcript by default',async t=>{
  const f=await savedFixture(t),previous=f.chatSession.current().id;f.history.addUser('previous task');f.history.finishAssistant('reply','previous response',{model:'fixture'});
  assert.equal(await f.api.handle({name:'/chat',args:['new']}),true);
  const current=f.chatSession.current();assert.notEqual(current.id,previous);assert.deepEqual(f.history.snapshot().messages,[]);
  assert.deepEqual((await f.store.get(previous)).history.messages.map(message=>message.content),['previous task','previous response']);
  assert.equal(f.changes.length,1);assert.equal(f.changes[0].reason,'new');assert.equal(f.changes[0].record.id,current.id);
  assert.deepEqual(f.changes[0].record.history.messages,[]);
});
test('new chat can explicitly discard the previous saved record',async t=>{
  const f=await savedFixture(t),previous=f.chatSession.current().id;f.history.addUser('discard this task');f.answers.push('n');
  await f.api.handle({name:'/new'});assert.equal(await f.store.get(previous),undefined);assert.notEqual(f.chatSession.current().id,previous);assert.deepEqual(f.history.snapshot().messages,[]);assert.equal(f.changes.length,1);assert.equal(f.changes[0]?.reason,'new');
});
test('opening a saved chat restores its history and identifies an open transition',async t=>{
  const f=await savedFixture(t),previous=f.chatSession.current().id;f.history.addUser('saved task');f.history.finishAssistant('saved-reply','saved response',{model:'fixture'});
  await f.chatSession.newChat();f.history.addUser('other task');
  await f.api.handle({name:'/chat',args:['open',previous]});
  assert.deepEqual(f.history.snapshot().messages.map(message=>message.content),['saved task','saved response']);
  assert.equal(f.changes.length,1);assert.equal(f.changes[0].reason,'open');assert.equal(f.changes[0].record.id,previous);
});
test('canceling the keep question leaves the chat and UI unchanged',async t=>{
  const aborted=new DOMException('Canceled','AbortError'),f=await savedFixture(t,{ask:async()=>{throw aborted;}}),previous=f.chatSession.current().id;
  f.history.addUser('keep current history');
  await assert.rejects(f.api.handle({name:'/new'}),{name:'AbortError'});
  assert.equal(f.chatSession.current().id,previous);assert.deepEqual(f.history.snapshot().messages.map(message=>message.content),['keep current history']);assert.deepEqual(f.changes,[]);
});
test('a failed new chat does not notify the UI to clear its transcript',async()=>{
  const changes=[],f=fixture({chatSession:{newChat:async()=>{throw new Error('Save failed');}},onChatChange:async change=>changes.push(change)});
  await assert.rejects(f.api.handle({name:'/new'}),/Save failed/);assert.deepEqual(changes,[]);assert.ok(!f.notes.includes('New chat started.'));
});
test('saved chat delete usage names the canonical command',async()=>{const f=fixture();await assert.rejects(f.api.handle({name:'/chat',args:['delete']}),/Use \/chat delete CHAT_ID/);});
test('live voice requires explicit compatible services and never starts implicitly',async()=>{const f=fixture();await assert.rejects(f.api.handle({name:'/voice',args:['live']}),/voice setup/);assert.equal(await f.api.handle({name:'/voice',args:['record','10']}),false);assert.equal(await f.api.handle({name:'/permissions',args:['allow-everything']}),false);f.settings.voiceService={baseUrl:'http://localhost/v1',model:'asr'};assert.equal(await f.api.handle({name:'/voice',args:['off']}),true);assert.equal(f.settings.voiceService.model,'asr');assert.equal(f.settings.microphone,false);await f.api.stop();});
test('coordinator cannot claim local completion without a result',()=>{assert.throws(()=>parseLocalDecision('{"action":"local","reason":"Need approval"}'),/invalid decision/);assert.throws(()=>parseLocalDecision('{"action":"cloud","reason":123}'),/invalid decision/);assert.equal(parseLocalDecision('```json\n{"action":"local","result":"Completed"}\n```').result,'Completed');});
