import test from 'node:test';
import assert from 'node:assert/strict';
import {PassThrough} from 'node:stream';
import {once} from 'node:events';
import {createPasteInput} from '../src/terminal-paste.mjs';
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
