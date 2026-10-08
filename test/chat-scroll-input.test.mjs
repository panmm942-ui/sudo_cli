import test from 'node:test';
import assert from 'node:assert/strict';
import {PassThrough} from 'node:stream';
import {setTimeout as delay} from 'node:timers/promises';
import {createChatScrollInput} from '../src/chat-scroll-input.mjs';
function fixture(t,initial={enabled:true,paused:false}){const input=new PassThrough(),actions=[];let state=initial,forwarded='',live=0;const stream=createChatScrollInput({input,getContext:()=>state,onScroll:name=>{actions.push(name);state={...state,paused:name!=='bottom'};},onLive:()=>{live++;state={...state,paused:false};}});stream.on('data',chunk=>forwarded+=chunk);t.after(()=>{stream.detach();stream.destroy();input.destroy();});return{input,actions,get forwarded(){return forwarded;},get live(){return live;},state:value=>{state=value;}};}
test('fragmented page keys scroll while normal Unicode input returns to the live prompt',t=>{const f=fixture(t);f.input.write('\x1b[');f.input.write('5~');assert.deepEqual(f.actions,['page-up']);assert.equal(f.forwarded,'');f.input.write('Hello λ');assert.equal(f.live,1);assert.equal(f.forwarded,'Hello λ');});
test('slash menu priority forwards page keys and hidden prompts cannot scroll',t=>{const f=fixture(t,{enabled:false,paused:false});f.input.write('\x1b[5~\x1b[6~');assert.deepEqual(f.actions,[]);assert.equal(f.forwarded,'\x1b[5~\x1b[6~');});
test('SGR wheel scrolls but click and release reports never become prompt text',t=>{const f=fixture(t);f.input.write('\x1b[<64;20;10M\x1b[<65;20;10M\x1b[<0;20;10M\x1b[<0;20;10m');assert.deepEqual(f.actions,['wheel-up','wheel-down']);assert.equal(f.forwarded,'');f.state({enabled:false,paused:false});f.input.write('\x1b[<64;20;10M');assert.equal(f.forwarded,'');});
test('modified navigation keys are explicit and ordinary history arrows retain readline behavior',t=>{const f=fixture(t);f.input.write('\x1b[1;2A\x1b[1;2B\x1b[1;5H\x1b[1;5F\x1b[A');assert.deepEqual(f.actions,['line-up','line-down','top','bottom']);assert.equal(f.forwarded,'\x1b[A');});
test('a bare Escape forwards promptly and detach removes the upstream pipe',async t=>{const f=fixture(t);f.input.write('\x1b');await delay(70);assert.equal(f.forwarded,'\x1b');f.input.end();});
