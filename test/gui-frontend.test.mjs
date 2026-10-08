import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {runInNewContext} from 'node:vm';

// A small browser-boundary fixture, not a second application. The real app source
// runs unchanged; events, fetch, timers and DOM text setters are observed here.
class Element{
  constructor(tag='div'){this.tagName=tag;this.children=[];this.listeners={};this.value='';this.hidden=false;this.disabled=false;this.dataset={};this.scrollHeight=100;this.scrollTop=0;this.clientHeight=100;this.properties={};this.style={setProperty:(name,value)=>this.properties[name]=value};this.classes=new Set();this.classList={add:name=>this.classes.add(name),toggle:(name,on)=>on?this.classes.add(name):this.classes.delete(name)};}
  set textContent(value){this.content=String(value);this.children=[];}get textContent(){return(this.content||'')+this.children.map(child=>child.textContent).join('');}
  append(...children){this.children.push(...children);}replaceChildren(...children){this.content='';this.children=children;}
  addEventListener(name,callback){(this.listeners[name]??=[]).push(callback);}
  async dispatch(name,event={}){for(const callback of this.listeners[name]||[])await callback({preventDefault(){},target:this,...event});}
  focus(){this.focused=true;}showModal(){this.open=true;}close(){this.open=false;}requestSubmit(){return this.dispatch('submit');}
}
const source=await readFile(new URL('../src/gui/app.js',import.meta.url),'utf8');
const html=await readFile(new URL('../src/gui/index.html',import.meta.url),'utf8');
const settle=()=>new Promise(resolve=>setImmediate(resolve));
async function view(state,onAction=()=>({accepted:true})){
  const elements=new Map([...html.matchAll(/\bid="([^"]+)"/g)].map(match=>[match[1],new Element()])),calls=[],navigation=[],timers=new Map();let tick=0;
  const document={hidden:false,documentElement:new Element('html'),getElementById:id=>elements.get(id),createElement:tag=>new Element(tag),addEventListener(){}};
  runInNewContext(source,{document,location:{hash:'#token='+'a'.repeat(64),pathname:'/'},history:{replaceState:(_state,_title,path)=>navigation.push(path)},URLSearchParams,TextEncoder,Date,Intl,Number,JSON,Error,setTimeout:callback=>{timers.set(++tick,callback);return tick;},clearTimeout:id=>timers.delete(id),fetch:async(path,options)=>{
    calls.push({path,...options});if(path==='/api/state')return{ok:true,status:200,json:async()=>state};
    const action=JSON.parse(options.body);return{ok:true,status:200,json:async()=>({result:await onAction(action)})};
  }});
  await settle();return{get:id=>elements.get(id),document,calls,navigation,timers,refresh:async()=>{const callback=[...timers.values()].at(-1);callback?.();await settle();}};
}

test('frontend removes the fragment, displays real numeric status and treats model markup as text',async()=>{
  const state={session:{connectionState:'connected',context:{used:500,limit:1000,percent:50},health:{percent:99,latencyMs:42},worked:{sessionMs:65000,totalMs:125000},network:{wifi:'Unknown',downloadBps:1024,uploadBps:0}},chat:{messages:[{role:'assistant',content:'<script>private()</script>'}]},theme:{bgcolor:'#0b0f14',bodyForeground:'#abcdef'}};
  const ui=await view(state);assert.deepEqual(ui.navigation,['/']);assert.equal(ui.calls[0].path,'/api/state');assert.equal(ui.calls[0].headers.authorization,'Bearer '+'a'.repeat(64));
  assert.match(ui.get('session-fields').textContent,/500 \/ 1K · 50%/);assert.match(ui.get('session-fields').textContent,/99% · 42 ms/);assert.match(ui.get('session-fields').textContent,/1m 5s/);assert.match(ui.get('session-fields').textContent,/1.0 KB\/s/);
  assert.match(ui.get('chat').textContent,/<script>private\(\)<\/script>/);assert.equal(ui.get('chat').children[0].children.at(-1).children.length,0);assert.equal(ui.document.documentElement.properties['--chat-text'],'#abcdef');
  state.theme.bodyForeground='url(https://evil.invalid)';state.session.connectionState='offline';await ui.refresh();assert.equal(ui.document.documentElement.properties['--chat-text'],'#abcdef');assert.equal(ui.get('connection-dot').classes.has('offline'),true);
});

test('frontend clears a hidden answer before settling and prevents duplicate current-question submission',async()=>{
  const state={currentPrompt:{id:'current-question',prompt:'Synthetic hidden setup answer',hidden:true,input:false}};let release;const answers=[];
  const ui=await view(state,action=>{answers.push(action);return new Promise(resolve=>release=()=>{state.currentPrompt=null;resolve({accepted:true});});});ui.get('secret-input').value='synthetic-answer';
  const submitted=ui.get('composer').dispatch('submit');await settle();assert.equal(ui.get('secret-input').value,'');assert.equal(ui.get('send').disabled,true);await ui.get('composer').dispatch('submit');assert.equal(answers.length,1);assert.deepEqual(answers[0],{type:'answer',promptId:'current-question',text:'synthetic-answer'});
  release();await submitted;assert.equal(ui.get('question').hidden,true);assert.equal(ui.get('secret-input').value,'');
});

test('a settled visible answer preserves the draft restored by an intervening poll and its literal provenance',async()=>{
  const state={chat:{promptCount:5,messages:[]}},actions=[];let release;
  const ui=await view(state,action=>{actions.push(action);return action.type==='answer'?new Promise(resolve=>{release=resolve;}):{accepted:true};});
  const draft='/stop\nUnsent next task';ui.get('input').value=draft;await ui.get('input').dispatch('paste');
  state.currentPrompt={id:'permission-1',prompt:'Allow once?',hidden:false,input:false};await ui.refresh();
  ui.get('input').value='yes';const submitted=ui.get('composer').dispatch('submit');await settle();
  assert.equal(ui.get('send').disabled,true);assert.deepEqual(actions,[{type:'answer',promptId:'permission-1',text:'yes'}]);
  state.currentPrompt=null;await ui.refresh();assert.equal(ui.get('input').value,draft);
  release({accepted:true});await submitted;assert.equal(ui.get('input').value,draft);assert.equal(ui.get('send').disabled,false);
  await ui.get('composer').dispatch('submit');assert.deepEqual(actions.at(-1),{type:'submit',text:draft,literal:true});
});

test('frontend keeps pasted slash input literal while command selection requires deliberate send',async()=>{
  const actions=[],ui=await view({commands:[{name:'/status',usage:'',description:'Session status'}]},action=>actions.push(action));ui.get('input').value='/delete\nhttps://demo.invalid/v1';await ui.get('input').dispatch('paste');await ui.get('composer').dispatch('submit');assert.deepEqual(actions,[{type:'submit',text:'/delete\nhttps://demo.invalid/v1',literal:true}]);
  await ui.get('commands').dispatch('click');assert.equal(ui.get('command-dialog').open,true);await ui.get('command-list').children[0].dispatch('click');assert.equal(ui.get('input').value,'/status');assert.equal(actions.length,1);await ui.get('composer').dispatch('submit');assert.deepEqual(actions.at(-1),{type:'submit',text:'/status'});
});

test('frontend routes safe changes and disables the stale view after return',async()=>{
  const actions=[],ui=await view({changes:{files:[{path:'file.mjs',status:'modified'}],partial:true,reason:'Bounded scan'}},action=>{actions.push(action);return action.type==='changes'?'<img src=x>':{accepted:true};});assert.match(ui.get('changes-note').textContent,/Partial scan: Bounded scan/);await ui.get('changes').children[0].dispatch('click');assert.equal(ui.get('diff-content').textContent,'<img src=x>');assert.equal(ui.get('diff-content').children.length,0);
  await ui.get('return').dispatch('click');assert.equal(ui.get('send').disabled,true);assert.equal(ui.get('input').disabled,true);assert.equal(ui.timers.size,0);const count=actions.length;await ui.get('composer').dispatch('submit');assert.equal(actions.length,count);assert.deepEqual(actions.at(-1),{type:'return'});
});

test('frontend keeps effective user and assistant colors independent across saved theme changes',async()=>{
  const state={theme:{bgcolor:'#0b0f14',txtcolor:'#112233',effectiveTxtcolor:'#00ff00',bodyForeground:'#dce3eb'},chat:{messages:[{role:'user',content:'User demo'},{role:'assistant',content:'Assistant demo'}]}};
  const ui=await view(state),colors=ui.document.documentElement.properties;
  assert.equal(colors['--chat-text'],'#dce3eb');assert.equal(colors['--user-text'],'#00ff00');assert.equal(colors['--chat-bg'],'#0b0f14');
  state.theme={bgcolor:'#ffffff',effectiveTxtcolor:'#000000',bodyForeground:'#000000'};await ui.refresh();
  assert.equal(colors['--user-text'],'#000000');assert.equal(colors['--chat-text'],'#000000');assert.equal(colors['--chat-bg'],'#ffffff');
  state.theme={bgcolor:'url(https://evil.invalid)',effectiveTxtcolor:'url(https://evil.invalid)',bodyForeground:'url(https://evil.invalid)'};await ui.refresh();
  assert.equal(colors['--user-text'],'#000000');assert.equal(colors['--chat-text'],'#000000');assert.equal(colors['--chat-bg'],'#ffffff');
});

test('frontend honors explicit health percentage off without hiding measured latency',async()=>{
  const state={session:{healthPercent:false,health:{percent:97,latencyMs:24}}},ui=await view(state);
  assert.doesNotMatch(ui.get('session-fields').textContent,/97%/);assert.match(ui.get('session-fields').textContent,/24 ms/);
  state.session.healthPercent=true;await ui.refresh();assert.match(ui.get('session-fields').textContent,/97% · 24 ms/);
  state.session.healthPercent=false;state.session.health={percent:97};await ui.refresh();assert.doesNotMatch(ui.get('session-fields').textContent,/97%/);assert.match(ui.get('session-fields').textContent,/HealthUnknown/);
  state.session.health.pending=true;await ui.refresh();assert.match(ui.get('session-fields').textContent,/HealthMeasuring/);
});
