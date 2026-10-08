import test from 'node:test';
import assert from 'node:assert/strict';
import {PassThrough} from 'node:stream';
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
