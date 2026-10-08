// The harness replaces only external model/audio boundaries. Coordinator,
// accounting, workspace checkpoints and saved chat storage remain real.
// Ordinary Node test discovery has no scenario flag and starts no activity.
import assert from 'node:assert/strict';
import {mock} from 'node:test';
import {mkdtemp,rm} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from './temp-root.mjs';

if(process.argv.includes('--clear-background-scenario')){
  const scenario=process.argv.at(-1);
  assert.ok(['yes','no','cancel','voice-stop-failure'].includes(scenario));
  let entered,voiceStopFailure=false;
  const working=new Promise(resolve=>{entered=resolve;});
  mock.module(new URL('../../src/agent-runtime.mjs',import.meta.url).href,{namedExports:{runAgentTask:async options=>{
    if(options.connection.model==='guardian-fixture')return{text:JSON.stringify({action:'cloud',reason:'The explicit task needs the working AI.'})};
    entered();
    return new Promise((_resolve,reject)=>{if(options.signal.aborted)reject(options.signal.reason);else options.signal.addEventListener('abort',()=>reject(options.signal.reason),{once:true});});
  }}});
  mock.module(new URL('../../src/live-voice.mjs',import.meta.url).href,{namedExports:{createLiveVoice:()=>({
    snapshot:()=>({running:true}),start:async()=>{},stop:async()=>{if(voiceStopFailure)throw new Error('Synthetic voice stop failure.');},
  })}});
  const [{createAssistantFeatures},{createChatHistory},{createChatStore},{createChatSession}]=await Promise.all([
    import('../../src/assistant-features.mjs'),import('../../src/chat-history.mjs'),import('../../src/chat-store.mjs'),import('../../src/chat-session.mjs'),
  ]);
  const cwd=await mkdtemp(join(tmpdir(),'sudocli-clear-foreground-'));
  let api;
  try{
    const stateDir=join(cwd,'state'),store=await createChatStore({cwd,stateDir}),history=createChatHistory(),chatSession=createChatSession({store,history});
    await chatSession.ensure();history.recordSubmission({sequence:1});history.addUser('Original visible message',{sequence:1});history.finishAssistant('original-answer','Original assistant answer');await chatSession.checkpoint();
    const before=history.snapshot(),id=chatSession.current().id,notes=[],changes=[];
    const local={name:'Guardian',model:'guardian-fixture',baseUrl:'http://127.0.0.1:1/v1',transport:'chat-completions'};
    const main={model:'working-fixture',baseUrl:'http://127.0.0.1:1/v1',transport:'chat-completions'};
    const settings={permissions:'ask',webAccess:false,scope:'project',mcp:new Map()};
    api=createAssistantFeatures({cwd,stateDir,settings,chatSession,profiles:{list:async()=>[local]},personalization:{get:async()=>undefined},getConnection:()=>main,note:message=>notes.push(message),ask:async prompt=>{
      if(prompt.includes('Local coordinator AI'))return '1';
      if(prompt.includes('Clear this chat')){if(scenario==='cancel')throw new DOMException('Canceled','AbortError');return scenario==='no'?'n':'y';}
      return '';
    },onBackgroundResult:async outcome=>{
      // This is the UI caller's real result-to-chat behavior on coordinator stop.
      history.addUser(`[24/7 task ${outcome.job.id}] ${outcome.job.prompt}`);
      if(outcome.text)history.finishAssistant('background:'+outcome.job.id,outcome.text);
      await chatSession.checkpoint();
    },onChatChange:async change=>{
      // The UI currently stops auxiliary activity again after a Yes transition.
      if(change.forget)await api.stop();
      changes.push(change);
    }});
    if(scenario==='voice-stop-failure'){
      settings.voiceService={model:'asr',baseUrl:'http://127.0.0.1:1/v1'};
      settings.speechService={model:'speech',baseUrl:'http://127.0.0.1:1/v1',voice:'alloy'};
      await api.handle({name:'/voice',args:['live']});voiceStopFailure=true;
      await assert.rejects(api.handle({name:'/clear'}),/Synthetic voice stop failure/);
      assert.deepEqual(history.snapshot(),before);assert.deepEqual((await store.get(id)).history,before);
      assert.equal(changes.length,0);assert.ok(!notes.some(note=>note.startsWith('Chat cleared.')));
    }else{
      await api.handle({name:'/24.7',args:['add','Old foreground job'],rawArgs:'add Old foreground job'});
      await api.handle({name:'/24.7',args:['start']});await working;
      if(scenario==='cancel'){
        await assert.rejects(api.handle({name:'/clear'}),{name:'AbortError'});
        assert.equal(api.snapshot().agent.state,'working');assert.deepEqual(history.snapshot(),before);assert.deepEqual((await store.get(id)).history,before);assert.equal(changes.length,0);
      }else{
        await api.handle({name:'/clear'});
        assert.equal(chatSession.current().id,id);assert.deepEqual(history.snapshot().messages,[]);assert.deepEqual((await store.get(id)).history.messages,[]);
        assert.equal(api.snapshot().agent,undefined);assert.equal(changes.length,1);
        if(scenario==='yes')assert.deepEqual(chatSession.contextSnapshot().messages,[]);
        else assert.ok(chatSession.contextSnapshot().messages.some(message=>message.content.includes('Old foreground job')));
      }
    }
    console.log(JSON.stringify({scenario,passed:true}));
  }finally{voiceStopFailure=false;try{await api?.stop();}finally{await rm(cwd,{recursive:true,force:true});}}
}
