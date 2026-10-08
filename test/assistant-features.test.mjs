import test from 'node:test';import assert from 'node:assert/strict';
import fs from 'node:fs';import {syncBuiltinESMExports} from 'node:module';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from './fixtures/temp-root.mjs';
import {join} from 'node:path';
import {createAssistantFeatures,parseLocalDecision} from '../src/assistant-features.mjs';
import {createChatStore} from '../src/chat-store.mjs';
import {createChatHistory} from '../src/chat-history.mjs';
import {createChatSession} from '../src/chat-session.mjs';
import {observeTaskUpdates} from './fixtures/task-update-observer.mjs';
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

async function backgroundFixture(t,{assess,runCloud,observeUpdates=false}={}){
  const module=await import('../src/assistant-features.mjs');
  assert.equal(typeof module.createBackgroundResultReporter,'function','background terminal outcomes require the shared result reporter');
  const [{createTaskInbox},{createAlwaysOn},{createNotifications}]=await Promise.all([import('../src/task-inbox.mjs'),import('../src/always-on.mjs'),import('../src/notifications.mjs')]);
  const root=await mkdtemp(join(tmpdir(),'sudo-background-notifications-'));
  const inbox=await createTaskInbox({cwd:root,stateDir:root}),events=[],outcomes=[],deliveries=[];
  const updates=observeUpdates?observeTaskUpdates(inbox):undefined;
  const notifications=createNotifications({directory:join(root,'preferences'),interactive:true,cooldownMs:0,play:async({event})=>events.push(event)});
  async function delivered(){
    let timer;try{
      // Audio has its existing 4s bound; preparation/receipt checks get a separate 1s allowance.
      const receipts=await Promise.race([Promise.all(deliveries),new Promise((_resolve,reject)=>{timer=setTimeout(()=>reject(new Error('Background notification receipts did not settle')),5000);})]);
      for(const receipt of receipts)assert.equal(receipt.error,undefined,'Background notification delivery rejected');
      return receipts.map(receipt=>receipt.value);
    }finally{clearTimeout(timer);}
  }
  const reporter=module.createBackgroundResultReporter({work:{result:async(_job,patch)=>patch},modelFor:()=>connection.model,onResult:outcome=>{
    outcomes.push(outcome);
    // The UI fires audio without delaying the durable terminal task transition.
    deliveries.push(notifications.notify(module.backgroundNotificationEvent(outcome),{id:outcome.notificationId}).then(value=>({value}),error=>({error})));
  }});
  const agent=createAlwaysOn({inbox,pollMs:10,idleSleepMs:40,assess:assess||(async()=>({action:'local',result:'Actual task result'})),runCloud:runCloud||(async()=>''),beginTask:async id=>reporter.begin(id),onTaskResult:reporter.result});
  t.after(async()=>{try{await agent.stop();await notifications.close();await delivered();}finally{updates?.close();await rm(root,{recursive:true,force:true});}});
  return{agent,inbox,events,outcomes,reporter,notifications,delivered,updates};
}
async function untilBackground(predicate){const deadline=Date.now()+2000;while(!await predicate()){if(Date.now()>deadline)assert.fail('Background fixture did not finish');await new Promise(resolve=>setTimeout(resolve,5));}}

test('real coordinator reason-only failures and blocked outcomes notify once without fake assistant results',{timeout:20000},async t=>{
  const scenarios=[
    {name:'assessment failure',assess:async()=>{throw new Error('Fixture assessor failed');},status:'blocked',event:'error'},
    {name:'approval required',assess:async()=>({action:'wait',reason:'Human approval is required'}),status:'blocked',event:'approval'},
    {name:'information missing',assess:async()=>({action:'wait',reason:'The task needs more information.'}),status:'blocked',event:'error'},
    {name:'cloud failure',assess:async()=>({action:'cloud'}),runCloud:async()=>{throw new Error('Fixture worker failed');},status:'failed',event:'error'},
  ];
  for(const scenario of scenarios)await t.test(scenario.name,async t=>{
    const f=await backgroundFixture(t,{...scenario,observeUpdates:true});const job=await f.agent.submit({prompt:'Explicit fixture task'});
    const completed=f.updates.waitFor(job.id,scenario.status,{signal:t.signal});await f.agent.start();await completed;
    assert.equal((await f.inbox.get(job.id)).status,scenario.status);
    await f.delivered();
    assert.deepEqual(f.events,[scenario.event]);assert.equal(f.outcomes.length,1);assert.equal(f.outcomes[0].text,undefined);assert.ok(f.outcomes[0].reason);
    await f.reporter.result(job,{status:scenario.status,reason:'Repeated callback'});
    await f.delivered();
    assert.deepEqual(f.events,[scenario.event]);assert.equal(f.outcomes.length,1);
  });
});
test('durable blocked state does not wait for tone preparation and its delayed error still plays exactly once',{timeout:8000},async t=>{
  let release,entered;const gate=new Promise(resolve=>{release=resolve;}),writing=new Promise(resolve=>{entered=resolve;});t.after(()=>release());
  const f=await backgroundFixture(t,{assess:async()=>({action:'wait',reason:'The task needs more information.'})});
  const original=fs.promises.open,root=join(f.inbox.stateDir,'preferences');
  const replacement=t.mock.method(fs.promises,'open',async(...args)=>{const file=await original(...args);if(String(args[0]).startsWith(root)&&String(args[0]).endsWith('error.wav')){const write=file.writeFile.bind(file);file.writeFile=async(...values)=>{entered();await gate;return write(...values);};}return file;});
  syncBuiltinESMExports();t.after(()=>{release();replacement.mock.restore();syncBuiltinESMExports();});
  await f.agent.start();const job=await f.agent.submit({prompt:'Explicit fixture task'});await writing;
  await untilBackground(async()=>(await f.inbox.get(job.id)).status==='blocked');
  assert.deepEqual(f.events,[]);assert.equal(f.outcomes.length,1);assert.equal(f.outcomes[0].text,undefined);assert.equal(f.outcomes[0].reason,'The task needs more information.');
  release();await f.delivered();assert.deepEqual(f.events,['error']);
  await f.reporter.result(job,{status:'blocked',reason:'Repeated callback'});await f.delivered();assert.deepEqual(f.events,['error']);assert.equal(f.outcomes.length,1);
});
test('stopping an actual coordinator task emits interrupted, with no done tone for administrative or idle operations',async t=>{
  const f=await backgroundFixture(t,{assess:async()=>({action:'cloud'}),runCloud:async(_job,{signal})=>new Promise((resolve,reject)=>signal.addEventListener('abort',()=>reject(signal.reason),{once:true}))});
  await f.agent.start();await new Promise(resolve=>setTimeout(resolve,30));assert.deepEqual(f.events,[]);
  const job=await f.agent.submit({prompt:'Long fixture task'});await untilBackground(()=>f.agent.snapshot().state==='working');await f.agent.stop();
  await f.delivered();
  assert.equal((await f.inbox.get(job.id)).status,'blocked');assert.deepEqual(f.events,['interrupted']);assert.equal(f.outcomes[0].text,undefined);
  await f.agent.stop();assert.deepEqual(f.events,['interrupted']);
});
test('background retries have distinct notification identities and saved off preference stays silent',async t=>{
  const f=await backgroundFixture(t);await f.agent.start();const job=await f.agent.submit({prompt:'Complete fixture task'});
  await untilBackground(async()=>(await f.inbox.get(job.id)).status==='completed');await f.delivered();assert.deepEqual(f.events,['done']);
  const firstId=f.outcomes[0].notificationId;await untilBackground(()=>f.agent.snapshot().state==='idle');
  await f.inbox.update(job.id,{status:'pending'});await untilBackground(()=>f.outcomes.length===2);await f.delivered();assert.deepEqual(f.events,['done','done']);assert.notEqual(f.outcomes[1].notificationId,firstId);
  await f.notifications.off();await f.agent.stop();await f.agent.start();await f.inbox.update(job.id,{status:'pending'});
  await untilBackground(()=>f.outcomes.length===3);await f.delivered();assert.deepEqual(f.events,['done','done']);assert.equal(f.notifications.get().enabled,false);
});
test('background attention classification uses structured outcomes and never calls a blocked result done',async()=>{
  const {backgroundNotificationEvent}=await import('../src/assistant-features.mjs');assert.equal(typeof backgroundNotificationEvent,'function');
  for(const [outcome,event] of [[{status:'completed'},'done'],[{status:'failed'},'error'],[{status:'cancelled'},'interrupted'],[{status:'blocked',code:'APPROVAL_REQUIRED'},'approval'],[{status:'blocked',reason:'The worker was stopped during this task. Review and explicitly retry it if needed.'},'interrupted'],[{status:'blocked',reason:'The task reached its duration budget.'},'error'],[{status:'blocked',reason:'Selected checks could not verify this source state.'},'error']])assert.equal(backgroundNotificationEvent(outcome),event);
});

test('background cleanup errors override cancellation and approval while retaining one error per attempt',async()=>{
  const {createBackgroundResultReporter,backgroundNotificationEvent}=await import('../src/assistant-features.mjs');
  for(const code of ['ENGINE_CLEANUP_UNVERIFIED','SESSION_CLEANUP_FAILED']){
    for(const outcome of [{status:'cancelled',interrupted:true},{status:'blocked',reason:'Approval required.'},{status:'completed'}])assert.equal(backgroundNotificationEvent({...outcome,code}),'error');
    for(const order of ['error-first','result-first','signal-first','approval-first','interruption-first']){
      const notices=[],tones=[],reason=new Error('Redacted primary task failure.'),job={id:code+order};
      const record=outcome=>{notices.push(outcome);if(!outcome.notificationSuppressed)tones.push(backgroundNotificationEvent(outcome));};
      const reporter=createBackgroundResultReporter({work:{result:async(_job,patch)=>patch},onResult:record,onAttention:record});reporter.begin(job.id);
      const error=Object.assign(new Error('Cleanup needs attention.',{cause:reason}),{code});
      if(order==='result-first')await reporter.result(job,{status:'failed',code,cause:reason,reason:'Cleanup failed.'});
      if(order==='signal-first'){const controller=new AbortController();controller.abort(error);await reporter.result(job,{status:'cancelled',reason:'Stopped during task.'},{signal:controller.signal});}
      if(order==='approval-first')await reporter.result(job,{status:'blocked',reason:'Approval is required.'});
      if(order==='interruption-first')await reporter.result(job,{status:'cancelled',reason:'Stopped during task.'});
      await reporter.error(error,job.id);await reporter.error(error,job.id);
      if(order==='error-first')await reporter.result(job,{status:'failed',reason:'Cleanup failed.'});
      const cleanups=notices.filter(value=>value.code===code);assert.ok(cleanups.length);assert.ok(cleanups.every(value=>value.cause?.message===reason.message));assert.equal(tones.filter(value=>value==='error').length,1);assert.ok(cleanups.every(value=>value.notificationId===notices[0].notificationId));
    }
  }
});
test('background notification callback failures cannot fail or retry completed AI work',async()=>{
  const {createBackgroundResultReporter}=await import('../src/assistant-features.mjs');let reports=0;const errors=[];
  const reporter=createBackgroundResultReporter({work:{result:async(_job,patch)=>patch},onResult:async()=>{reports++;throw new Error('Fixture audio failed');},onReportError:error=>errors.push(error.message)});
  const job={id:'notification-fixture',prompt:'Actual task'};reporter.begin(job.id);
  assert.deepEqual(await reporter.result(job,{status:'completed',result:'Actual completed result'}),{status:'completed',result:'Actual completed result'});
  await reporter.result(job,{status:'completed',result:'Repeated callback'});assert.equal(reports,1);assert.deepEqual(errors,['Fixture audio failed']);
});

test('coordinator errors notify without task outcomes and suppress already reported attention per attempt',async()=>{
  const {createBackgroundResultReporter}=await import('../src/assistant-features.mjs');let now=0;const outcomes=[],attention=[];
  const reporter=createBackgroundResultReporter({work:{result:async(_job,patch)=>patch},now:()=>now,onResult:value=>outcomes.push(value),onAttention:value=>attention.push(value)});
  const error=new Error('SECRET coordination failure');
  await reporter.error(error);await reporter.error(error);assert.equal(attention.length,1);
  now=2000;await reporter.error(new Error('SECRET coordination failure'));assert.equal(attention.length,1);
  await reporter.error(new Error('Another coordination failure'));assert.equal(attention.length,2);
  reporter.begin('task');await reporter.result({id:'task'},{status:'failed',reason:'Failure'});await reporter.error(error,'task');assert.equal(attention.length,2);
  reporter.begin('task');await reporter.result({id:'task'},{status:'completed',result:'Actual result'});await reporter.error(error,'task');assert.equal(attention.length,3,'a failure after done still needs attention');
  await reporter.error(error,'task');assert.equal(attention.length,3);
  reporter.begin('task');await reporter.error(error,'task');assert.equal(attention.length,4);
  await reporter.result({id:'task'},{status:'blocked',reason:'The task failed.'});assert.equal(outcomes.at(-1).notificationSuppressed,true);
  assert.ok(!JSON.stringify(attention).includes('SECRET'));assert.ok(attention.every(value=>value.status==='failed'&&value.code==='COORDINATOR_ERROR'));
});

test('real heartbeat wait stays quiet while a heartbeat error needs one attention sound',async t=>{
  const {createBackgroundResultReporter}=await import('../src/assistant-features.mjs');
  const {createTaskInbox}=await import('../src/task-inbox.mjs'),{createAlwaysOn}=await import('../src/always-on.mjs');
  const root=await mkdtemp(join(tmpdir(),'sudo-heartbeat-notifications-')),inbox=await createTaskInbox({cwd:root,stateDir:root});
  const attention=[],results=[];let fail=false,assessed=0;
  const reporter=createBackgroundResultReporter({work:{result:async(_job,patch)=>patch},onResult:value=>results.push(value),onAttention:value=>attention.push(value)});
  let agent;
  agent=createAlwaysOn({inbox,pollMs:10,heartbeatMs:1000,idleSleepMs:40,standingGoal:'Explicit fixture goal',beginTask:id=>reporter.begin(id),onTaskResult:reporter.result,onError:error=>{void reporter.error(error,agent.snapshot().activeJobId);},assess:async()=>{assessed++;if(fail)throw new Error('Fixture heartbeat failure');return {action:'wait',reason:'No actionable work.'};},runCloud:async()=>''});
  t.after(async()=>{await agent.stop();await rm(root,{recursive:true,force:true});});
  await agent.start();await untilBackground(()=>assessed>0&&agent.snapshot().state==='idle');assert.deepEqual(attention,[]);assert.deepEqual(results,[]);
  await agent.stop();fail=true;await agent.start();await untilBackground(()=>attention.length===1);
  assert.deepEqual(results,[]);assert.equal(attention[0].code,'COORDINATOR_ERROR');
});
