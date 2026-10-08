import test from 'node:test';
import assert from 'node:assert/strict';
import {PassThrough} from 'node:stream';
import {once} from 'node:events';
import {createInterface} from 'node:readline/promises';
import {COMMANDS} from '../src/commands.mjs';
import {createPasteInput} from '../src/terminal-paste.mjs';
import {createSlashMenuInput} from '../src/slash-menu.mjs';

function terminal({commands=COMMANDS,size={columns:100,rows:10},source}={}) {
  const input=source||new PassThrough(),rawModes=[],renders=[],closes=[],errors=[],output=[],submitted=[];
  input.isTTY=true;input.setRawMode=value=>rawModes.push(value);
  const context={enabled:true,line:'',cursor:0};
  const stream=createSlashMenuInput({input,getContext:()=>context,getSize:()=>size,commands,
    onRender:view=>renders.push(view),onError:error=>errors.push(error),onClose:record=>{
      closes.push(record);
      if(record.selected!==undefined)context.line=record.selected;
      else if(record.restore)context.line='/'+record.query;
      context.cursor=context.line.length;
    }});
  stream.on('data',chunk=>{
    const text=chunk.toString();output.push(text);
    for(const character of text) {
      if(character==='\r'||character==='\n'){submitted.push(context.line);context.line='';}
      else if(character==='\x7f'||character==='\b')context.line=[...context.line].slice(0,-1).join('');
      else if(character>=' ')context.line+=character;
    }
    context.cursor=context.line.length;
  });
  return {input,stream,context,size,rawModes,renders,closes,errors,output,submitted,
    send:text=>input.write(text),close:()=>{stream.detach();input.destroy();stream.destroy();}};
}

test('an isolated slash opens immediately and Enter selects without submitting a command',t=>{
  const term=terminal();t.after(term.close);
  term.send('/');assert.equal(term.stream.snapshot().active,true);assert.equal(term.context.line,'/');
  assert.equal(term.renders.length,1);assert.equal(term.stream.snapshot().total,COMMANDS.length);
  term.send('local');assert.equal(term.stream.snapshot().selected.name,'/local');
  term.send('\r');assert.equal(term.context.line,'/local ');assert.equal(term.stream.snapshot().active,false);
  assert.deepEqual(term.submitted,[]);assert.equal(term.closes.at(-1).reason,'select');
  term.send('\r');assert.deepEqual(term.submitted,['/local ']);
});

test('complete command chunks and slashes inside ordinary input pass through unchanged',t=>{
  const term=terminal();t.after(term.close);
  term.send('/local\n');term.send('Review ');term.send('/');term.send('tmp/project\n');
  assert.equal(term.renders.length,0);assert.equal(term.output.join(''),'/local\nReview /tmp/project\n');
  assert.deepEqual(term.submitted,['/local','Review /tmp/project']);
});

test('pagination and split ANSI keys reach every registered command',t=>{
  const term=terminal({size:{columns:80,rows:7}});t.after(term.close);term.send('/');
  const seen=new Set([term.stream.snapshot().selected.name]);
  for(let index=1;index<COMMANDS.length;index++){term.send('\x1b');term.send('[');term.send('B');seen.add(term.stream.snapshot().selected.name);}
  assert.equal(seen.size,COMMANDS.length);assert.ok(term.stream.snapshot().page>1);
  term.send('\x1b[H');assert.equal(term.stream.snapshot().index,0);
  term.send('\x1b[6~');assert.ok(term.stream.snapshot().index>0);
  term.send('\x1b[5~');assert.equal(term.stream.snapshot().index,0);
  term.send('\x1b[F');assert.equal(term.stream.snapshot().index,COMMANDS.length-1);
  term.send('\x1b[A');assert.equal(term.stream.snapshot().index,COMMANDS.length-2);
  assert.equal(term.output.join(''),'/');
});

test('no-match filter never selects or submits anything and backspace recovers it',t=>{
  const term=terminal();t.after(term.close);term.send('/');term.send('zz-no-such-command');
  assert.equal(term.stream.snapshot().total,0);assert.ok(term.stream.snapshot().lines.some(line=>line.includes('No commands')));
  term.send('\r');assert.equal(term.stream.snapshot().active,true);assert.equal(term.closes.length,0);
  for(const _ of 'zz-no-such-command')term.send('\x7f');
  assert.equal(term.stream.snapshot().total,COMMANDS.length);
  term.send('\x7f');assert.equal(term.stream.snapshot().active,false);assert.equal(term.context.line,'');
});

test('Escape restores the typed query while Ctrl+C is forwarded unchanged',async t=>{
  const term=terminal();t.after(term.close);term.send('/');term.send('voice');term.send('\x1b');
  await new Promise(resolve=>setTimeout(resolve,65));
  assert.equal(term.stream.snapshot().active,false);assert.equal(term.context.line,'/voice');
  assert.equal(term.closes.at(-1).reason,'escape');assert.equal(term.closes.at(-1).restore,true);
  term.context.line='';term.context.cursor=0;term.send('/');term.send('\x03');
  assert.equal(term.stream.snapshot().active,false);assert.ok(term.output.join('').endsWith('/\x03'));
  assert.equal(term.closes.at(-1).restore,false);
});

test('hidden/raw/setup/busy contexts bypass the picker and context changes never restore secret input',t=>{
  const term=terminal();t.after(term.close);term.context.enabled=false;term.send('/');
  assert.equal(term.renders.length,0);assert.equal(term.output.join(''),'/');
  term.context.enabled=true;term.context.line='';term.context.cursor=0;term.send('/');term.send('credentials');
  term.context.enabled=false;term.context.line='hidden-key';term.context.cursor=10;term.stream.refresh();
  assert.equal(term.stream.snapshot().active,false);assert.equal(term.context.line,'hidden-key');
  assert.equal(term.closes.at(-1).reason,'context');assert.equal(term.closes.at(-1).restore,false);
  term.send('/secret');assert.ok(term.output.join('').endsWith('/secret'));
});

test('resizing clips every menu row and safely redraws even in a one-cell terminal',t=>{
  const term=terminal();t.after(term.close);term.send('/');term.send('\x1b[F');
  term.size.columns=28;term.size.rows=5;term.stream.refresh();let view=term.stream.snapshot();
  assert.ok(view.lines.length<=5);assert.ok(view.lines.every(line=>line.length<=27));assert.equal(view.selected.name,COMMANDS.at(-1).name);
  assert.ok(view.lines.every(line=>!line.includes('\x1b')));
  term.size.columns=1;term.size.rows=1;term.stream.refresh();view=term.stream.snapshot();
  assert.ok(view.lines.length<=1);assert.deepEqual(view.lines,['']);
});

test('bracketed slash paste stays literal and never opens the menu',async()=>{
  const input=new PassThrough(),pastes=[];
  const paste=createPasteInput({input,onPaste:text=>{pastes.push(text);return '';}}),term=terminal({source:paste});
  input.end('\x1b[200~/permissions allow-everything\r\n/quit\x1b[201~');await once(term.stream,'end');
  assert.deepEqual(pastes,['/permissions allow-everything\n/quit']);assert.equal(term.renders.length,0);assert.deepEqual(term.submitted,[]);
  term.close();paste.detach();
});

test('a split CRLF selection consumes one Enter and cannot execute the filled command',t=>{
  const term=terminal();t.after(term.close);term.send('/');term.send('local');term.send('\r');term.send('\n');
  assert.equal(term.context.line,'/local ');assert.deepEqual(term.submitted,[]);
});

test('a delayed split CRLF cannot execute the command selected by its CR',async t=>{
  const term=terminal();t.after(term.close);term.send('/');term.send('local');term.send('\r');
  await new Promise(resolve=>setTimeout(resolve,35));term.send('\n');
  assert.equal(term.context.line,'/local ');assert.deepEqual(term.submitted,[]);
});

test('split UTF-8 filter input and backspace retain full Unicode characters',t=>{
  const term=terminal({commands:[{name:'/planet',usage:'',description:'λ research'},{name:'/voice',usage:'',description:'Live voice'}]});t.after(term.close);
  term.send('/');for(const byte of Buffer.from('λ'))term.send(Buffer.from([byte]));
  assert.equal(term.stream.snapshot().query,'λ');assert.equal(term.stream.snapshot().selected.name,'/planet');
  term.send('\x7f');assert.equal(term.stream.snapshot().query,'');assert.equal(term.stream.snapshot().total,2);
});

test('a space after an exact command starts ordinary arguments while other multiword queries still filter',t=>{
  const term=terminal();t.after(term.close);term.send('/');term.send('local');term.send(' info example.weights');
  assert.equal(term.stream.snapshot().active,false);assert.equal(term.context.line,'/local info example.weights');
  assert.equal(term.closes.at(-1).reason,'arguments');assert.deepEqual(term.submitted,[]);term.send('\r');
  assert.deepEqual(term.submitted,['/local info example.weights']);
  term.send('/');term.send('reasoning request');assert.equal(term.stream.snapshot().active,true);
  assert.equal(term.stream.snapshot().selected.name,'/effort');assert.equal(term.stream.snapshot().query,'reasoning request');
});

test('menu rendering strips command descriptions that contain terminal controls',t=>{
  const term=terminal({commands:[{name:'/example',usage:'FILE\nPATH',description:'safe\x1b[31m red\x1b[0m\rhidden\ttext'}]});t.after(term.close);term.send('/');
  assert.ok(term.stream.snapshot().lines.every(line=>!/[\x1b\r\n\t]/.test(line)));
  assert.equal(term.stream.snapshot().selected.description,'safe red hidden text');
});

test('a failing render callback reports the error and restores ordinary input',()=>{
  const input=new PassThrough(),context={enabled:true,line:'',cursor:0},closes=[],errors=[],output=[];
  const stream=createSlashMenuInput({input,getContext:()=>context,onRender:()=>{throw new Error('display failed');},onError:error=>errors.push(error),onClose:record=>closes.push(record)});
  stream.on('data',chunk=>{output.push(chunk.toString());context.line+=chunk.toString();context.cursor=context.line.length;});input.write('/');
  assert.equal(errors.length,1);assert.equal(stream.snapshot().active,false);assert.equal(closes.at(-1).reason,'render');
  input.write('status\n');assert.equal(output.join(''),'/status\n');stream.detach();input.destroy();stream.destroy();
});

test('TTY forwarding, explicit close and detach leave ordinary input untouched',t=>{
  const term=terminal();t.after(term.close);assert.equal(term.stream.isTTY,true);term.stream.setRawMode(true);assert.deepEqual(term.rawModes,[true]);
  term.send('/');term.stream.closeMenu();assert.equal(term.stream.snapshot().active,false);assert.equal(term.closes.at(-1).restore,false);
  const before=term.output.join('');term.stream.detach();term.send('unattached');assert.equal(term.output.join(''),before);
});

test('real Readline receives Enter after Escape through both terminal input filters',async t=>{
  const input=new PassThrough(),output=new PassThrough(),controller=new AbortController();
  input.isTTY=true;input.setRawMode=()=>{};output.isTTY=true;output.columns=100;output.resume();
  const paste=createPasteInput({input,onPaste:()=>''});let rl,resolveEscape;
  const escaped=new Promise(resolve=>{resolveEscape=resolve;});
  const menu=createSlashMenuInput({input:paste,getContext:()=>({enabled:true,line:rl?.line||'',cursor:rl?.cursor||0}),
    onClose:record=>{
      rl.prompt(true);
      if(record.selected!==undefined||record.restore){rl.write(null,{ctrl:true,name:'u'});rl.write(record.selected??'/'+record.query);}
      if(record.reason==='escape')resolveEscape();
    }});
  rl=createInterface({input:menu,output,terminal:true});
  t.after(()=>{controller.abort();rl.close();menu.detach();paste.detach();input.destroy();menu.destroy();paste.destroy();output.destroy();});
  const question=rl.question('you › ',{signal:controller.signal});
  question.catch(()=>{});
  for(const command of COMMANDS){input.write('\x15');input.write('/');input.write(command.name.slice(1));input.write('\r');assert.equal(rl.line,command.name+(command.usage?' ':''));}
  input.write('\x15');input.write('/');input.write('status');input.write('\x1b');
  let timeout;
  try{await Promise.race([escaped,new Promise((_,reject)=>{timeout=setTimeout(()=>reject(new Error('Bare Escape never reached the picker')),500);})]);}
  finally{clearTimeout(timeout);}
  assert.equal(menu.snapshot().active,false);assert.equal(rl.line,'/status');input.write('\r');
  try{assert.equal(await Promise.race([question,new Promise((_,reject)=>{timeout=setTimeout(()=>reject(new Error('Restored command did not receive Enter')),500);})]),'/status');}
  finally{clearTimeout(timeout);}
});

test('real Readline supports per-key command arguments with one final Enter through both input filters',async t=>{
  const input=new PassThrough(),output=new PassThrough(),controller=new AbortController();let rl,resolved=false;
  input.isTTY=true;input.setRawMode=()=>{};output.isTTY=true;output.columns=100;output.resume();
  const paste=createPasteInput({input,onPaste:()=>''});
  const menu=createSlashMenuInput({input:paste,getContext:()=>({enabled:true,line:rl?.line||'',cursor:rl?.cursor||0}),onClose:record=>{
    rl.prompt(true);
    if(record.selected!==undefined||record.restore){rl.write(null,{ctrl:true,name:'u'});rl.write(record.selected??'/'+record.query);}
  }});
  rl=createInterface({input:menu,output,terminal:true});
  t.after(()=>{controller.abort();rl.close();menu.detach();paste.detach();input.destroy();menu.destroy();paste.destroy();output.destroy();});
  const question=rl.question('you › ',{signal:controller.signal}).then(answer=>{resolved=true;return answer;});
  question.catch(()=>{});
  for(const character of '/local info example.weights')input.write(character);
  await Promise.resolve();assert.equal(resolved,false);assert.equal(menu.snapshot().active,false);assert.equal(rl.line,'/local info example.weights');
  input.write('\r');let timeout;
  try{assert.equal(await Promise.race([question,new Promise((_,reject)=>{timeout=setTimeout(()=>reject(new Error('Typed arguments did not reach Readline')),500);})]),'/local info example.weights');}
  finally{clearTimeout(timeout);}
});

for(const key of ['\r','\x15'])test(`real Readline handles Escape immediately followed by ${key==='\r'?'Enter':'Ctrl+U'}`,async t=>{
  const input=new PassThrough(),output=new PassThrough(),controller=new AbortController();let rl;
  input.isTTY=true;input.setRawMode=()=>{};output.isTTY=true;output.columns=100;output.resume();
  const paste=createPasteInput({input,onPaste:()=>''});
  const menu=createSlashMenuInput({input:paste,getContext:()=>({enabled:true,line:rl?.line||'',cursor:rl?.cursor||0}),onClose:record=>{
    rl.prompt(true);if(record.selected!==undefined||record.restore){rl.write(null,{ctrl:true,name:'u'});rl.write(record.selected??'/'+record.query);}
  }});
  rl=createInterface({input:menu,output,terminal:true});
  t.after(()=>{controller.abort();rl.close();menu.detach();paste.detach();input.destroy();menu.destroy();paste.destroy();output.destroy();});
  const question=rl.question('you › ',{signal:controller.signal});question.catch(()=>{});
  input.write('/');input.write('status');input.write('\x1b');input.write(key);
  if(key==='\x15'){assert.equal(rl.line,'');input.write('/status\r');}
  let timeout;try{assert.equal(await Promise.race([question,new Promise((_,reject)=>{timeout=setTimeout(()=>reject(new Error('Fast Escape retained an Alt/control sequence')),500);})]),'/status');}
  finally{clearTimeout(timeout);}
});
