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
