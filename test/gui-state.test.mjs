import test from 'node:test';
import assert from 'node:assert/strict';
import {buildGuiSnapshot} from '../src/gui-state.mjs';
import {COMMANDS} from '../src/commands.mjs';

test('GUI command menu exposes canonical dotted background work with usable arguments',()=>{
  const snapshot=buildGuiSnapshot({commands:COMMANDS});
  const background=snapshot.commands.find(command=>command.name==='/24.7');
  assert.ok(background);
  assert.match(background.usage,/add TASK/);
  assert.equal(snapshot.commands.some(command=>command.name==='/247'),false);
});

test('GUI snapshot excludes credentials, hardware identifiers and absolute project path',()=>{
  const snapshot=buildGuiSnapshot({session:{cwd:'C:/private/project',project:'Demo',version:'0.6.9',connectedAI:'demo',apiKey:'secret-one',connection:{apiKey:'secret-two'},performance:{groups:[{title:'GPU',pnpDeviceId:'private-hardware-id',fields:[{label:'VRAM',value:'8 GiB'}]}]}},history:{version:1,messages:[{id:'1',role:'user',content:'example secret-one',sequence:1}]},events:{entries:[{id:'e',timestamp:'2026-10-08T01:00:00Z',kind:'error',text:'failed secret-two'}]},prompt:{id:'p',prompt:'Key [hidden]',hidden:true,value:'secret-two'},changes:{files:[{path:'app.js',status:'modified',content:'secret-two'}]},commands:[],theme:{bgcolor:'#0b0f14'},secrets:()=>['secret-one','secret-two']});
  const text=JSON.stringify(snapshot);
  assert.equal(snapshot.session.project,'Demo');assert.equal(snapshot.currentPrompt.hidden,true);
  assert.equal(snapshot.chat.messages[0].content,'example [redacted]');
  assert.doesNotMatch(text,/secret-one|secret-two|private-hardware-id|C:\/private|apiKey|"value":"secret/);
  assert.deepEqual(snapshot.changes.files,[{path:'app.js',status:'modified'}]);
});

test('large GUI transcript is visibly truncated without changing canonical history',()=>{
  const messages=Array.from({length:40},(_,i)=>({id:String(i),role:'assistant',content:'🙂'.repeat(50000)}));
  const snapshot=buildGuiSnapshot({history:{version:1,messages},events:{entries:[]},session:{},changes:{files:[]},commands:[]});
  assert.equal(snapshot.chat.truncated,true);assert.ok(snapshot.chat.messages.length>0);
  assert.ok(Buffer.byteLength(JSON.stringify(snapshot))<1800000);
  assert.equal(messages[0].content.length,100000);
});

test('GUI changes remain bounded with visible truncation, including escaped long paths',()=>{
  const files=Array.from({length:3000},(_,i)=>({path:String(i)+'"'.repeat(4090),status:i===2999?'deleted':'modified'}));
  const state=buildGuiSnapshot({changes:{files,partial:false},history:{messages:[]},commands:[]});
  assert.equal(state.changes.partial,true);
  assert.match(state.changes.reason,/display|truncat|limit/i);
  assert.ok(state.changes.files.length<files.length);
  assert.ok(Buffer.byteLength(JSON.stringify(state))<1800000);
  assert.equal(state.chat.promptCount,0);
});
