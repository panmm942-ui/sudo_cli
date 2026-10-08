import test from 'node:test';
import assert from 'node:assert/strict';
import {queueAgentContext} from '../src/agent-context.mjs';
import {createFeatureCommands} from '../src/features.mjs';
import {estimateContext} from '../src/context-manager.mjs';

test('saved agent findings reach the next main turn as advisory input and are consumed only at dispatch',()=>{
  const settings={pendingContext:'Prior chat',attachments:[],skills:[]};
  queueAgentContext(settings,{id:'run-fixture',task:'Inspect parser',results:[{name:'reviewer',model:'local-review',status:'completed',text:'Parser has an unchecked size.'}]});
  const features=createFeatureCommands({settings});
  const input=features.prepareTurn('Use the findings',{consume:false});const text=JSON.stringify(input);
  assert.match(text,/Parser has an unchecked size/);assert.match(text,/advisory|untrusted/i);assert.match(text,/run-fixture/);assert.match(text,/Prior chat/);assert.ok(settings.pendingAgentContext);
  assert.ok(estimateContext([{role:'user',content:text}]).tokens>estimateContext([{role:'user',content:'Use the findings'}]).tokens);
  features.prepareTurn('Use the findings');assert.equal(settings.pendingAgentContext,'');
  assert.doesNotMatch(JSON.stringify(features.prepareTurn('Next')),/unchecked size/);
});
test('multiple agent reports keep bounded UTF-8 context and explicitly report omitted text',()=>{
  const settings={};let truncated=false;
  for(let i=0;i<8;i++){const queued=queueAgentContext(settings,{id:'run-'+i,task:'Review',results:[{name:'reviewer',model:'fixture',status:'completed',text:'ε'.repeat(90000)}]});truncated ||= queued.truncated;}
  assert.ok(Buffer.byteLength(settings.pendingAgentContext)<=128*1024);assert.ok(truncated);assert.doesNotMatch(settings.pendingAgentContext,/�/);assert.match(settings.pendingAgentContext,/omitted|truncated/i);
});
test('reviewed full-history replay containing agent reports does not inject those reports twice',()=>{
  const settings={pendingContext:'Full history: reviewer finding UNIQUE_REPORT',pendingAgentContext:'Advisory finding UNIQUE_REPORT'};
  const features=createFeatureCommands({settings});const input=features.prepareTurn('Continue',{consume:false,agentReplayIncluded:true});
  assert.equal(JSON.stringify(input).split('UNIQUE_REPORT').length-1,1);assert.ok(settings.pendingAgentContext);
  features.prepareTurn('Continue',{agentReplayIncluded:true});assert.equal(settings.pendingAgentContext,'');
});
