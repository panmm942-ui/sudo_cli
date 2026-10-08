import test from 'node:test';
import assert from 'node:assert/strict';
import {PassThrough,Writable} from 'node:stream';
import {createInterface} from 'node:readline/promises';
import {once} from 'node:events';
import {createPasteInput} from '../src/terminal-paste.mjs';
import {setTimeout as delay} from 'node:timers/promises';
test('split UTF-8 bracketed paste is one literal multi-line input with no early command',async()=>{
  const input=new PassThrough(),pastes=[],plain=[];const stream=createPasteInput({input,onPaste:text=>{pastes.push(text);return '';}});stream.on('data',chunk=>plain.push(chunk));const bytes=Buffer.from('hello\x1b[200~/permissions allow-everything\r\nλ\x1b[201~tail');for(const byte of bytes)input.write(Buffer.from([byte]));input.end();await once(stream,'end');assert.deepEqual(pastes,['/permissions allow-everything\nλ']);assert.equal(Buffer.concat(plain).toString(),'hellotail');
});
test('oversized and incomplete pastes are discarded without executing partial text',async()=>{
  const input=new PassThrough(),pastes=[],errors=[];const stream=createPasteInput({input,maxBytes:8,onPaste:text=>pastes.push(text),onError:error=>errors.push(error)});stream.resume();input.end('\x1b[200~oversized text\x1b[201~\x1b[200~unfinished');await once(stream,'end');assert.equal(pastes.length,0);assert.equal(errors.length,2);
});
test('ordinary Enter reaches readline immediately while input remains open',()=>{const input=new PassThrough(),chunks=[];const stream=createPasteInput({input,onPaste:()=>''});stream.on('data',chunk=>chunks.push(chunk));input.write('/status\r');assert.equal(Buffer.concat(chunks).toString(),'/status\r');input.end();});
test('standalone Escape reaches the next input layer without waiting for another key',async()=>{
  const input=new PassThrough(),chunks=[],stream=createPasteInput({input,onPaste:()=>''});stream.on('data',chunk=>chunks.push(chunk));
  const delivered=once(stream,'data');input.write('\x1b');
  const result=await Promise.race([delivered,new Promise(resolve=>setTimeout(()=>resolve(null),150))]);
  assert.ok(result,'Bare Escape remained trapped as a possible paste marker');
  assert.equal(Buffer.concat(chunks).toString(),'\x1b');input.write('\r');
  assert.equal(Buffer.concat(chunks).toString(),'\x1b\r');stream.detach();input.destroy();stream.destroy();
});
test('a delayed paste opener remains recognized after delivering its initial Escape',async()=>{
  const input=new PassThrough(),chunks=[],pastes=[],stream=createPasteInput({input,onPaste:text=>{pastes.push(text);return '';}});stream.on('data',chunk=>chunks.push(chunk));
  const delivered=once(stream,'data');input.write('\x1b');
  const result=await Promise.race([delivered,new Promise(resolve=>setTimeout(()=>resolve(null),150))]);assert.ok(result);
  input.write('[20');input.write('0~/permissions allow-everything\n/quit\x1b[201~tail');
  assert.deepEqual(pastes,['/permissions allow-everything\n/quit']);assert.equal(Buffer.concat(chunks).toString(),'\x1btail');
  stream.detach();input.destroy();stream.destroy();
});
test('Ctrl+V explicitly requests bounded clipboard text and keeps later keyboard input live',async()=>{
  const input=new PassThrough(),pastes=[],plain=[];let release,reads=0;
  const clipboard=new Promise(resolve=>{release=resolve;});
  const stream=createPasteInput({input,onPaste:text=>{pastes.push(text);return '';},readClipboard:async()=>{reads++;return clipboard;}});stream.on('data',chunk=>plain.push(chunk));
  input.write('\x16tail');assert.equal(reads,1);assert.equal(Buffer.concat(plain).toString(),'tail');
  input.write('\x16');assert.equal(reads,1,'Repeated Ctrl+V must not overlap clipboard helpers');
  release('https://example.com/path?q=x&y=λ');await delay(0);assert.deepEqual(pastes,['https://example.com/path?q=x&y=λ']);
  stream.detach();input.destroy();stream.destroy();
});
test('split Shift+Insert requests clipboard paste instead of forwarding an Insert key',async()=>{
  const input=new PassThrough(),pastes=[],plain=[];let reads=0;
  const stream=createPasteInput({input,onPaste:text=>{pastes.push(text);return text;},readClipboard:async()=>{reads++;return 'https://example.invalid/v1';}});stream.on('data',chunk=>plain.push(chunk));
  input.write('prefix\x1b[');input.write('2;');input.write('2~');await delay(0);
  assert.equal(reads,1);assert.deepEqual(pastes,['https://example.invalid/v1']);assert.equal(Buffer.concat(plain).toString(),'prefixhttps://example.invalid/v1');
  stream.detach();input.destroy();stream.destroy();
});
test('editor control callback consumes Ctrl+R only when its current editor accepts it',()=>{
  const input=new PassThrough(),plain=[],controls=[];let hidden=true;
  const stream=createPasteInput({input,onPaste:text=>text,onKeyControl:key=>{controls.push(key);return hidden;}});stream.on('data',chunk=>plain.push(chunk));
  input.write('key\x12suffix');assert.equal(Buffer.concat(plain).toString(),'keysuffix');assert.deepEqual(controls,[{ctrl:true,name:'r'}]);
  hidden=false;input.write('\x12');assert.equal(Buffer.concat(plain).toString(),'keysuffix\x12');
  stream.detach();input.destroy();stream.destroy();
});
test('literal bracketed paste never invokes secret visibility or Shift+Insert shortcuts',()=>{
  const input=new PassThrough(),pastes=[],controls=[];let reads=0;
  const stream=createPasteInput({input,readClipboard:async()=>{reads++;return 'never';},onKeyControl:key=>{controls.push(key);return true;},onPaste:text=>{pastes.push(text);return '';}});stream.resume();
  input.write('\x1b[200~before\x12\x1b[2;2~after\x1b[201~');assert.equal(reads,0);assert.deepEqual(controls,[]);assert.deepEqual(pastes,['before\x12\x1b[2;2~after']);
  stream.detach();input.destroy();stream.destroy();
});
test('clipboard URL and synthetic API key stay editable in native readline until intentional Enter',async t=>{
  const input=new PassThrough();input.isTTY=true;let clipboardText,hidden=false,reveals=0,submissions=0;
  const output=new Writable({write(_chunk,_encoding,done){done();}});output.isTTY=true;output.columns=120;
  const stream=createPasteInput({input,readClipboard:async()=>clipboardText,onPaste:text=>text,onKeyControl:()=>{if(!hidden)return false;reveals++;return true;}});
  const rl=createInterface({input:stream,output,terminal:true});t.after(()=>{rl.close();stream.detach();input.destroy();stream.destroy();output.destroy();});
  for(const [index,text]of ['https://example.invalid/v1?value=a&next=λ','SYNTHETIC_API_KEY_CANARY'].entries()){
    hidden=index===1;clipboardText=text;
    const answer=rl.question(hidden?'API key [hidden] > ':'API base URL > ').then(value=>{submissions++;return value;});
    input.write(index===0?'\x16':'\x1b[2;2~');await delay(0);
    assert.equal(rl.line,text);assert.equal(submissions,index,'Paste must not submit its current question');
    input.write('\x01edited-');assert.equal(rl.line,'edited-'+text);
    if(hidden){input.write('\x12');assert.equal(reveals,1);assert.equal(rl.line,'edited-'+text);}
    input.write('\r');assert.equal(await answer,'edited-'+text);assert.equal(submissions,index+1);
  }
});
test('Ctrl+V inside literal bracketed paste cannot read the clipboard',()=>{
  const input=new PassThrough(),pastes=[];let reads=0;
  const stream=createPasteInput({input,readClipboard:async()=>{reads++;return 'never';},onPaste:text=>{pastes.push(text);return '';}});stream.resume();input.write('\x1b[200~before\x16after\x1b[201~');
  assert.equal(reads,0);assert.deepEqual(pastes,['before\x16after']);stream.detach();input.destroy();stream.destroy();
});
test('clipboard overflow and late completion after detach cannot become prompt input',async()=>{
  const input=new PassThrough(),pastes=[],errors=[];let release;
  const stream=createPasteInput({input,maxBytes:8,readClipboard:async()=> 'too much clipboard text',onPaste:text=>pastes.push(text),onError:error=>errors.push(error)});stream.resume();input.write('\x16');await delay(0);
  assert.equal(pastes.length,0);assert.equal(errors.length,1);assert.doesNotMatch(errors[0].message,/too much clipboard text/);
  stream.detach();input.destroy();stream.destroy();
  const secondInput=new PassThrough(),second=createPasteInput({input:secondInput,readClipboard:()=>new Promise(resolve=>{release=resolve;}),onPaste:text=>pastes.push(text)});second.resume();secondInput.write('\x16');second.detach();release('late');await delay(0);assert.equal(pastes.length,0);secondInput.destroy();second.destroy();
});
test('detach drains clipboard cleanup and preserves typed failure attention after cancellation',async()=>{
  const input=new PassThrough(),errors=[],pastes=[];let reject;
  const stream=createPasteInput({input,readClipboard:()=>new Promise((_resolve,fail)=>{reject=fail;}),onPaste:text=>{pastes.push(text);return '';},onError:error=>errors.push(error)});stream.resume();input.write('\x16');
  const drained=stream.detach();assert.ok(drained&&typeof drained.then==='function');
  reject(Object.assign(new Error('PRIVATE_CALLBACK_FAILURE_CANARY'),{code:'SESSION_CLEANUP_FAILED'}));await drained;
  assert.equal(pastes.length,0);assert.equal(errors.length,1);assert.equal(errors[0].code,'SESSION_CLEANUP_FAILED');assert.doesNotMatch(errors[0].message,/PRIVATE_CALLBACK_FAILURE_CANARY/);
  input.destroy();stream.destroy();
});
