import test from 'node:test';
import assert from 'node:assert/strict';
import {createLocalFileCommands} from '../src/local-file-commands.mjs';

function fixture({answers=[],kind='gguf',runners=['ollama'],importError}={}){
  const notes=[],calls=[],saved=[],connected=[],questions=[];const settings={permissions:'ask'};
  const commands=createLocalFileCommands({cwd:process.cwd(),settings,note:text=>notes.push(text),ask:async prompt=>{questions.push(prompt);return answers.shift()||'';},profiles:{save:async profile=>saved.push(profile)},reconnect:async connection=>connected.push(connection),runOperation:async(_label,fn)=>fn(new AbortController().signal),inspect:async path=>({path,kind,label:kind==='gguf'?'GGUF model':'Unsupported format',bytes:256,supportedRunners:runners,requirements:['A compatible runner is required.']}),importModel:async options=>{calls.push(options);if(importError)throw importError;return {connection:{model:options.name,transport:'chat-completions',baseUrl:'http://localhost:11434/v1'},instructions:['Local registry created.']};}});
  return {commands,notes,calls,saved,connected,questions};
}
test('local file inspection accepts an unusual extension without importing or asking for an API',async()=>{
  const f=fixture();assert.equal(await f.commands.handle({name:'/local',args:['info','renamed.weights']}),true);
  assert.match(f.notes.join('\n'),/GGUF/);assert.equal(f.calls.length,0);assert.equal(f.questions.length,0);
});
test('declining local import never starts a runner or changes the selected AI',async()=>{
  const f=fixture({answers:['1','my-model','no']});await f.commands.handle({name:'/local',args:['file','weights.weird']});assert.equal(f.calls.length,0);assert.equal(f.connected.length,0);assert.equal(f.saved.length,0);
});
test('confirmed local import saves a keyless compatible connection with user-selected capacity',async()=>{
  const f=fixture({answers:['1','my-model','yes','131072','Saved local']});await f.commands.handle({name:'/local',args:['file','weights.weird']});
  assert.equal(f.calls.length,1);assert.equal(f.calls[0].runner,'ollama');assert.equal(f.connected[0].model,'my-model');assert.equal(f.connected[0].apiKey,undefined);assert.equal(f.connected[0].contextWindow,131072);assert.equal(f.saved[0].name,'Saved local');assert.equal(f.questions.some(p=>/API key/i.test(p)),false);
});
test('unsupported model files get truthful guidance and never execute their content',async()=>{
  const f=fixture({kind:'unknown',runners:[]});await f.commands.handle({name:'/local',args:['file','arbitrary.file']});assert.equal(f.calls.length,0);assert.equal(f.connected.length,0);assert.match(f.notes.join('\n'),/compatible|unsupported|format/i);
});
test('a runner failure leaves the selected AI and saved profiles untouched without claiming success',async()=>{
  const f=fixture({answers:['1','my-model','yes'],importError:new Error('Unsupported model architecture')});
  await assert.rejects(f.commands.handle({name:'/local',args:['file','weights.weird']}),/Unsupported model architecture/);
  assert.equal(f.calls.length,1);assert.equal(f.saved.length,0);assert.equal(f.connected.length,0);
  assert.doesNotMatch(f.notes.join('\n'),/import completed|Saved local AI/);
});
test('model inspection is a cancellable operation and cancellation never proceeds to a loader',async()=>{
  const controller=new AbortController(),notes=[],operations=[];let inspections=0,imports=0,questions=0;
  const commands=createLocalFileCommands({cwd:process.cwd(),settings:{permissions:'ask'},note:text=>notes.push(text),
    ask:async()=>{questions++;return '';},profiles:{save:async()=>assert.fail('Cancelled inspection must not save a profile')},
    reconnect:async()=>assert.fail('Cancelled inspection must not change the AI'),
    runOperation:async(label,fn)=>{operations.push(label);controller.abort();return fn(controller.signal);},
    inspect:async(_path,{signal}={})=>{inspections++;assert.equal(signal,controller.signal);if(signal.aborted)throw new Error('Local model operation cancelled.');return {label:'GGUF',supportedRunners:['ollama']};},
    importModel:async()=>{imports++;assert.fail('Cancelled inspection must not start a loader');},
  });
  await assert.rejects(commands.handle({name:'/local',args:['file','weights.other']}),/cancelled/);
  assert.deepEqual(operations,['Inspecting local model']);assert.equal(inspections,1);assert.equal(imports,0);assert.equal(questions,0);assert.equal(notes.length,0);
});
