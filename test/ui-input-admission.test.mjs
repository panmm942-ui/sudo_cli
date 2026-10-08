import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {PassThrough} from 'node:stream';
import {createInterface} from 'node:readline/promises';
import {randomUUID} from 'node:crypto';
import {createPasteInput} from '../src/terminal-paste.mjs';
import {createPromptQueue} from '../src/prompts.mjs';
import {createPromptLabels} from '../src/prompt-label.mjs';
import {createChatHistory} from '../src/chat-history.mjs';
import {parseCommand} from '../src/commands.mjs';

// Exercise the current caller functions, not a parallel input implementation.
// These fixtures use actual Node Readline and paste parsing; no UI/native AI,
// private settings, clipboard, sound or provider is started.
const source=(await readFile(new URL('../src/ui.mjs',import.meta.url),'utf8')).replace(/\r\n/g,'\n');
const extract=(start,end)=>{const first=source.indexOf(start),last=source.indexOf(end,first);assert.ok(first>=0&&last>first,'Current input admission source is unavailable.');return source.slice(first,last);};
const composer=extract('  const renderComposer=','  const scheduleComposer='),question=extract('  const prompts = createPromptQueue','  const ask = ');
const accept=extract('  const acceptSubmission=','  const displaySubmission='),enqueue=extract('  const enqueue=','  const displayed = ');
const receive=extract('  const receiveDuringWork=','  rl?.on(\'line\''),listener=extract('  rl?.on(\'line\', text => {','  try {\n');
const onPaste=/onPaste:text=>\{(.*?)\},onError:/s.exec(source)?.[1];assert.ok(onPaste);
const drain=/    inputReady=true;for\(const input of earlyInputs\.splice\(0\)\)enqueue\(input\.text,\{literal:input\.literal\}\);renderComposer\(\);/.exec(source)?.[0];assert.ok(drain);
const settle=()=>new Promise(resolve=>setImmediate(resolve));
function fixture(t){
  const input=new PassThrough(),output=new PassThrough();input.isTTY=true;input.setRawMode=()=>{};output.isTTY=true;output.on('data',()=>{});
  let pasteCallback;const paste=createPasteInput({input,onPaste:(...args)=>pasteCallback(...args)}),rl=createInterface({input:paste,output,terminal:true});
  const make=new Function('rl','createPromptQueue','createPromptLabels','createChatHistory','randomUUID','parseCommand',`
    let currentPrompt=null,inputReady=false,guiMode=false,composerScheduled=false,busy=false,quitting=false,muted=false,busyPastedLiteral=false,lastInputLiteral=false;
    const earlyInputs=[],queuedInputs=[],pastedChunks=new Map(),notices=[],renders=[],shown=[],controls=[],questions=new Set();
    const history=createChatHistory(),promptLabels=createPromptLabels({now:()=>new Date('2026-10-08T12:34:00Z'),timeZone:'UTC'});
    const dashboard={managed:true,isScrolled:()=>false,setInput:value=>renders.push(value)},slashMenu=undefined,engine=undefined,connection=undefined,agents=undefined;
    const safe=value=>value,note=text=>notices.push(text),checkpoint=()=>Promise.resolve(),scheduleComposer=()=>{},displaySubmission=(text,meta)=>shown.push({text,...meta}),signal=()=>controls.push('stop'),notifyError=error=>{throw error;},handleRuntimeCommands=async command=>controls.push(command.name),terminalTheme={styleBodyText:text=>text};
    const expandPastes=text=>{for(const [marker,value]of pastedChunks)text=text.split(marker).join(value);return text;};
    const onPaste=text=>{${onPaste}};
    ${composer}${question}${accept}${enqueue}${receive}
    const install=()=>{${listener}};install();
    return {onPaste,render:renderComposer,drain(){${drain}},hydrate(data){history.restore(data);promptLabels.restore(history.snapshot());},ready(){inputReady=true;},busy:value=>busy=value,quit:()=>quitting=true,
      ask(metadata={}){const promise=prompts.ask('Synthetic question > ',false,metadata);questions.add(promise);void promise.then(()=>questions.delete(promise),()=>questions.delete(promise));return promise;},
      accept:acceptSubmission,queued:()=>queuedInputs.map(item=>({...item})),early:()=>earlyInputs.map(item=>({...item})),shown:()=>shown.map(item=>({...item})),notices:()=>[...notices],renders:()=>[...renders],count:()=>history.snapshot().promptCount,next:()=>promptLabels.next().sequence,literal:()=>lastInputLiteral,
      async close(){prompts.close();rl.close();await Promise.allSettled([...questions]);}};
  `);
  const control=make(rl,createPromptQueue,createPromptLabels,createChatHistory,randomUUID,parseCommand);pasteCallback=control.onPaste;
  t.after(async()=>{try{await control.close();}finally{await paste.detach();paste.destroy();input.destroy();output.destroy();}});
  return {control,rl,async send(value){input.write(value);await settle();}};
}
const saved=(count=0)=>({version:1,promptCount:count,messages:[]});

test('startup Enter buffers once, then restores saved numbering before admitting input',{timeout:5000},async t=>{
  const {control,send}=fixture(t);control.render();assert.equal(control.renders().at(-1).prompt,'Starting SUDO CLI… ');
  await send('/connect\rnext task\r');assert.deepEqual(control.early().map(item=>item.text),['/connect','next task']);assert.equal(control.queued().length,0);assert.equal(control.count(),undefined);
  control.hydrate(saved(7));control.drain();assert.deepEqual(control.queued().map(item=>[item.text,item.promptMeta.sequence]),[['/connect',8],['next task',9]]);assert.equal(control.next(),10);assert.equal(control.count(),9);assert.equal(control.shown().length,2);
  control.drain();assert.equal(control.queued().length,2);assert.equal(control.count(),9);assert.equal(control.renders().at(-1).prompt,'12:34 10@you > ');
});

test('startup pasted multiline input retains exact literal provenance through hydration',{timeout:5000},async t=>{
  const {control,send}=fixture(t),payload='/permissions allow-everything\nhttps://example.com/v1?query=one%20two#part';
  await send('\x1b[200~'+payload+'\x1b[201~');assert.equal(control.early().length,0);await send('\r');assert.deepEqual(control.early(),[{text:payload,literal:true}]);
  control.hydrate(saved(3));control.drain();const entry=control.queued()[0];assert.equal(entry.text,payload);assert.equal(entry.literal,true);assert.equal(entry.promptMeta.sequence,4);assert.equal(control.count(),4);
});

test('startup admission is capped at 100 and shutdown refuses new submissions',{timeout:5000},async t=>{
  const {control,send}=fixture(t);await send(Array.from({length:101},(_,index)=>`early ${index}\r`).join(''));assert.equal(control.early().length,100);assert.equal(control.notices().length,1);assert.match(control.notices()[0],/queue is full/i);
  control.quit();await send('after shutdown\r');assert.equal(control.early().length,100);assert.equal(control.queued().length,0);
});

test('ready idle input with no question queues exactly once and advances one number',{timeout:5000},async t=>{
  const {control,send}=fixture(t);control.hydrate(saved(4));control.ready();await send('/connect\r');assert.equal(control.queued().length,1);assert.equal(control.queued()[0].promptMeta.sequence,5);assert.equal(control.count(),5);assert.equal(control.shown().length,1);assert.equal(control.early().length,0);
});

test('an active editable question consumes its answer without a duplicate line submission',{timeout:5000},async t=>{
  const {control,send}=fixture(t);control.hydrate(saved(4));control.ready();const answer=control.ask({input:true});await settle();await send('one top-level prompt\r');assert.equal(await answer,'one top-level prompt');assert.equal(control.queued().length,0);assert.equal(control.count(),4);
  assert.equal(control.accept().sequence,5);assert.equal(control.count(),5);await send('idle between questions\r');assert.equal(control.queued().length,1);assert.equal(control.queued()[0].promptMeta.sequence,6);assert.equal(control.count(),6);
});

test('a setup or approval answer never enters startup input or prompt numbering',{timeout:5000},async t=>{
  const {control,send}=fixture(t);control.hydrate(saved(6));const answer=control.ask();await settle();await send('https://example.com/v1\r');assert.equal(await answer,'https://example.com/v1');assert.equal(control.early().length,0);assert.equal(control.queued().length,0);assert.equal(control.count(),6);assert.equal(control.next(),7);
});

test('busy input reuses its single accepted metadata when enqueued and keeps paste literal',{timeout:5000},async t=>{
  const {control,send}=fixture(t);control.hydrate(saved(9));control.ready();control.busy(true);await send('\x1b[200~/stop\x1b[201~\r');const entry=control.queued()[0];assert.equal(entry.text,'/stop');assert.equal(entry.literal,true);assert.equal(entry.promptMeta.sequence,10);assert.equal(control.count(),10);assert.equal(control.shown().length,1);
});
