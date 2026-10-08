import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from './fixtures/temp-root.mjs';
import {createPersonalization} from '../src/personalization.mjs';
import {createAssistantFeatures} from '../src/assistant-features.mjs';

test('editing one preference preserves other settings and keeps each model independent',async t=>{
  const stateDir=await mkdtemp(join(tmpdir(),'sudocli-per-ai-command-'));t.after(()=>rm(stateDir,{recursive:true,force:true}));
  const a={model:'a',baseUrl:'http://localhost:8081/v1',transport:'chat-completions'},b={...a,model:'b'};
  let selected=a;const settings={permissions:'ask',webAccess:false},calls=[];
  const personalization=await createPersonalization({stateDir});
  const api=createAssistantFeatures({settings,cwd:stateDir,stateDir,personalization,getConnection:()=>selected,ask:async()=>{throw new Error('No wizard prompt expected');},note:()=>{},reconnect:async(connection,options)=>calls.push({model:connection.model,options})});
  await api.handle({name:'/preferences',args:['set','language','Greek']});
  await api.handle({name:'/preferences',args:['set','tone','calm']});
  selected=b;await api.handle({name:'/personalize',args:['set','persona','Careful reviewer']});
  assert.deepEqual((await personalization.get(a)).preferences,{language:'Greek',tone:'calm'});
  assert.equal((await personalization.get(b)).persona,'Careful reviewer');assert.deepEqual((await personalization.get(b)).preferences,{});
  selected=a;await api.handle({name:'/preferences',args:['unset','language']});assert.deepEqual((await personalization.get(a)).preferences,{tone:'calm'});
  assert.deepEqual(settings,{permissions:'ask',webAccess:false});assert.equal(calls.length,4);assert.ok(calls.every(call=>call.options.carryHistory));
});
