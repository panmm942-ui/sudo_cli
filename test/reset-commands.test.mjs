import test from 'node:test';
import assert from 'node:assert/strict';
import {createResetCommands} from '../src/reset-commands.mjs';

function fixture({answers=[],actions}={}){
  const calls=[],notes=[],questions=[];
  actions??={bgcolor:{description:'Restore the conversation background.',includeInAll:false,reset:async()=>calls.push('bgcolor')},txtcolor:{description:'Restore user text color.',includeInAll:false,reset:async()=>calls.push('txtcolor')},colors:{description:'Restore both conversation colors.',reset:async()=>calls.push('colors')},scope:{description:'Restore project permission scope.',reset:async()=>calls.push('scope')},updates:{description:'Enable startup GitHub checks and restore the release repository.',reset:async()=>calls.push('updates')},memory:{description:'Clear the selected project memory.',includeInAll:false,reset:async()=>calls.push('memory')},preferences:{description:'Clear selected AI preferences.',includeInAll:false,reset:async()=>calls.push('preferences')},ai:{description:'Disconnect the current AI.',includeInAll:false,reset:async()=>calls.push('ai')}};
  const commands=createResetCommands({actions,ask:async text=>{questions.push(text);return answers.shift()??'';},note:text=>notes.push(text)});
  return{commands,calls,notes,questions};
}
const reset=(value,args=[])=>value.commands.handle({name:'/reset',args});

test('commands unrelated to reset are left to the caller',async()=>{const f=fixture();assert.equal(await f.commands.handle({name:'/help',args:[]}),false);assert.deepEqual(f.calls,[]);});

test('an explicit target resets only that setting and reports completion after its callback',async()=>{
  let completed=false;const notes=[];const commands=createResetCommands({actions:{txtcolor:{description:'Restore user text.',reset:async()=>{await Promise.resolve();completed=true;}}},note:text=>{assert.equal(completed,true);notes.push(text);}});
  assert.equal(await commands.handle({name:'/reset',args:['TXTCOLOR']}),true);assert.match(notes.at(-1),/reset.*txtcolor/i);
});

test('list shows every available target and all without asking or mutating',async()=>{
  const f=fixture();assert.equal(await reset(f,['list']),true);assert.match(f.notes.join('\n'),/1\. bgcolor/);assert.match(f.notes.join('\n'),/txtcolor.*user text/i);assert.match(f.notes.join('\n'),/all.*settings/i);assert.deepEqual(f.calls,[]);assert.deepEqual(f.questions,[]);
});

test('no-argument reset accepts one numbered selection or a case-insensitive named target',async()=>{
  for(const answer of ['2','TxTcOlOr']){const f=fixture({answers:[answer]});assert.equal(await reset(f),true);assert.deepEqual(f.calls,['txtcolor']);assert.equal(f.questions.length,1);assert.match(f.questions[0],/number.*name.*cancel/i);}
});

test('canceling target selection or selecting an unknown target changes nothing',async()=>{
  for(const answer of ['',undefined,'   ']){const f=fixture({answers:[answer]});assert.equal(await reset(f),true);assert.deepEqual(f.calls,[]);assert.match(f.notes.at(-1),/cancel/i);}
  for(const answer of ['999','0','01','missing','txtcolor --yes']){const f=fixture({answers:[answer]});await assert.rejects(reset(f),/unknown|invalid/i);assert.deepEqual(f.calls,[]);}
});

test('unknown targets, extra arguments and invalid flags are rejected before asking or mutating',async()=>{
  for(const args of [['missing'],['txtcolor','--yes'],['all','y'],['--force'],['list','anything']]){const f=fixture();await assert.rejects(reset(f,args),/unknown|usage|invalid/i);assert.deepEqual(f.calls,[]);assert.deepEqual(f.questions,[]);}
});

test('reset all describes its concrete effects before approval and declines without changes',async()=>{
  for(const answer of ['','n','no','maybe']){const f=fixture({answers:[answer]});assert.equal(await reset(f,['all']),true);assert.deepEqual(f.calls,[]);assert.equal(f.questions.length,1);assert.match(f.questions[0],/y\/n/i);const details=f.notes.slice(0,-1).join('\n');assert.match(details,/colors: Restore both/);assert.match(details,/scope: Restore project/);assert.match(details,/updates: Enable startup/);assert.doesNotMatch(details,/memory:|preferences:|ai:|bgcolor:|txtcolor:/);assert.match(f.notes.at(-1),/cancel|unchanged/i);}
});

test('reset all runs each included setting once and excludes duplicate color targets and data resets',async()=>{
  for(const answer of ['y','YES',' Yes ']){const f=fixture({answers:[answer]});assert.equal(await reset(f,['all']),true);assert.deepEqual(f.calls,['colors','scope','updates']);assert.match(f.notes.at(-1),/colors.*scope.*updates/i);assert.doesNotMatch(f.notes.at(-1),/memory|preferences|ai/);}
});

test('memory, AI preferences and connections can be reset explicitly but never through all even if misconfigured',async()=>{
  const calls=[];const actions={colors:{description:'Restore colors.',reset:async()=>calls.push('colors')},memory:{description:'Delete memory.',includeInAll:true,reset:async()=>calls.push('memory')},preferences:{description:'Delete preferences.',includeInAll:true,reset:async()=>calls.push('preferences')},ai:{description:'Disconnect AI.',includeInAll:true,reset:async()=>calls.push('ai')}};
  const f=fixture({actions,answers:['yes']});await reset(f,['all']);assert.deepEqual(calls,['colors']);await reset(f,['memory']);await reset(f,['preferences']);await reset(f,['ai']);assert.deepEqual(calls,['colors','memory','preferences','ai']);
});

test('partial bulk failure reports completed and failed targets and continues later independent resets',async()=>{
  const calls=[];const f=fixture({answers:['y'],actions:{colors:{description:'Restore colors.',reset:async()=>calls.push('colors')},scope:{description:'Restore scope.',reset:async()=>{calls.push('scope');throw new Error('fixture private detail');}},updates:{description:'Restore updates.',reset:async()=>calls.push('updates')}}});
  await assert.rejects(reset(f,['all']),error=>error instanceof AggregateError&&/scope/.test(error.message)&&/colors.*updates/.test(error.message)&&!error.message.includes('private detail'));
  assert.deepEqual(calls,['colors','scope','updates']);assert.match(f.notes.join('\n'),/completed.*colors.*updates/i);assert.match(f.notes.at(-1),/failed.*scope/i);assert.doesNotMatch(f.notes.at(-1),/all.*success/i);
});

test('individual callback failure never reports a successful reset',async()=>{
  const f=fixture({actions:{scope:{description:'Restore scope.',reset:async()=>{throw new Error('fixture private detail');}}}});
  await assert.rejects(reset(f,['scope']),error=>/failed.*scope/i.test(error.message)&&!error.message.includes('private detail'));assert.match(f.notes.at(-1),/failed.*scope/i);assert.doesNotMatch(f.notes.at(-1),/completed|success/i);
});

test('unavailable targets are omitted and never called, including availability lost while confirming',async()=>{
  let available=false,calls=0;const actions={scope:{description:'Restore scope.',available:()=>available,reset:async()=>calls++}};
  const f=fixture({actions});await reset(f,['list']);assert.doesNotMatch(f.notes.join('\n'),/1\. scope/);await assert.rejects(reset(f,['scope']),/unavailable/i);assert.equal(calls,0);
  available=true;const notes=[];const commands=createResetCommands({actions,note:text=>notes.push(text),ask:async()=>{available=false;return'y';}});
  await assert.rejects(commands.handle({name:'/reset',args:['all']}),AggregateError);assert.equal(calls,0);assert.match(notes.at(-1),/failed.*scope/i);
});

test('all with no eligible settings does not ask for approval or mutate data',async()=>{
  const f=fixture({actions:{memory:{description:'Clear memory.',reset:async()=>assert.fail('bulk data deletion')}}});assert.equal(await reset(f,['all']),true);assert.equal(f.questions.length,0);assert.match(f.notes.at(-1),/no.*settings/i);
});

test('factory rejects invalid action definitions and bounds names, descriptions and counts',()=>{
  const valid={description:'Restore colors.',reset:async()=>{}};
  for(const actions of [null,[],{'all':valid},{'list':valid},{'bad name':valid},{'colors':{description:'Invalid\u001b[31m',reset:async()=>{}}},{'colors':{description:'x'.repeat(501),reset:async()=>{}}},{'colors':{description:'Missing callback'}},{'colors':{...valid,includeInAll:'yes'}},{'colors':{...valid,available:true}},Object.fromEntries(Array.from({length:65},(_,i)=>[`setting-${i}`,valid]))])assert.throws(()=>createResetCommands({actions}),/invalid|reset|target|action|description/i);
});
