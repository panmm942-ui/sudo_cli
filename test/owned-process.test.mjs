import test from 'node:test';
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {readFile} from 'node:fs/promises';
import {ownProcess,sameProcess,ownedGroupMembers,parseDarwinProcessTable} from '../src/owned-process.mjs';
import {isolatedEnvironment} from '../src/permission-scope.mjs';

const worker = `process.on('SIGTERM',()=>{});process.send?.({ready:true});setInterval(()=>{},1000);`;
const parent = `const {spawn}=require('node:child_process');const c=spawn(process.execPath,['-e',${JSON.stringify(worker)}],{detached:process.platform==='win32',stdio:['ignore','ignore','ignore','ipc']});c.once('message',()=>{process.send({pid:c.pid});});process.on('message',m=>{if(m==='exit')process.exit(0);});process.on('SIGTERM',()=>{});setInterval(()=>{},1000);`;
const pause=ms=>new Promise(r=>setTimeout(r,ms));
async function running(pid){
  if(process.platform==='linux'){
    try{const text=await readFile(`/proc/${pid}/stat`,'utf8');return !['Z','X'].includes(text.slice(text.lastIndexOf(')')+2).split(' ')[0]);}
    catch(error){if(error.code==='ENOENT')return false;throw error;}
  }
  try{process.kill(pid,0);return true;}catch(error){if(error.code==='ESRCH')return false;throw error;}
}
async function fixture(t,{capture=true,escaped=false}={}){
  const code=escaped?parent.replace("detached:process.platform==='win32'","detached:true"):parent;
  const child=spawn(process.execPath,['-e',code],{detached:process.platform!=='win32',stdio:['ignore','ignore','ignore','ipc'],env:isolatedEnvironment(process.env)});
  let descendant;
  t.after(async()=>{for(const pid of [descendant,child.pid])if(pid&&await running(pid))try{process.kill(pid,'SIGKILL');}catch{};if(child.connected)child.disconnect();});
  const owned=ownProcess(child);
  const ready=new Promise((resolve,reject)=>{const timer=setTimeout(()=>reject(new Error('fixture readiness failed')),5000);child.once('message',m=>{clearTimeout(timer);resolve(m.pid);});child.once('error',reject);});
  if(capture)await owned.capture();
  descendant=await ready;
  return {child,descendant,owned};
}
test('stops real SIGTERM-ignoring descendants without stopping an unrelated same-name process',{timeout:20000},async t=>{
  const foreign=spawn(process.execPath,['-e',worker],{detached:process.platform!=='win32',stdio:['ignore','ignore','ignore','ipc'],env:isolatedEnvironment(process.env)});
  t.after(()=>{foreign.kill('SIGKILL');if(foreign.connected)foreign.disconnect();});
  const {child,descendant,owned}=await fixture(t);
  if(process.platform==='linux')process.kill(descendant,'SIGSTOP');
  const a=owned.close(),b=owned.close();assert.equal(a,b);
  await a;
  assert.equal(await running(child.pid),false);
  assert.equal(await running(descendant),false);
  assert.equal(await running(foreign.pid),true);
});
test('a captured descendant is stopped even when its direct parent has already exited',{timeout:20000},async t=>{
  const {child,descendant,owned}=await fixture(t);
  await owned.capture();
  const exit=new Promise(r=>child.once('exit',r));child.send('exit');await exit;
  assert.equal(await running(descendant),true);
  await owned.close();assert.equal(await running(descendant),false);
});

test('an unobserved Unix parent cannot verify an escaped helper after its original group becomes empty',{skip:process.platform==='win32',timeout:20000},async t=>{
  const {child,descendant,owned}=await fixture(t,{capture:false,escaped:true});
  const exit=new Promise(resolve=>child.once('exit',resolve));child.send('exit');await exit;
  assert.equal(child.exitCode,0);
  await assert.rejects(owned.capture(),/could not be verified/);
  await assert.rejects(owned.close(),/could not be verified/);
  assert.equal(await running(descendant),true);
});
test('an uncaptured orphan cannot re-anchor a numeric Unix process group',{skip:process.platform==='win32',timeout:20000},async t=>{
  const {child,descendant,owned}=await fixture(t);
  const exit=new Promise(r=>child.once('exit',r));child.send('exit');await exit;
  await assert.rejects(owned.close(),/could not be verified/);assert.equal(await running(descendant),true);
});
test('recycled root, descendant and orphan-group identities cannot authorize signals',()=>{
  const root={pid:11,birth:'101',group:11,session:11,state:'R'}, descendant={pid:12,birth:'102',group:11,session:11,state:'S'};
  const known=new Map([[11,root],[12,descendant]]);
  assert.equal(sameProcess(descendant,{...descendant,birth:'999'}),false);
  assert.equal(sameProcess({pid:11},{pid:11}),false);
  assert.throws(()=>ownedGroupMembers(new Map([[11,{...root,birth:'999'}]]),root,known,11),/could not be verified/);
  assert.throws(()=>ownedGroupMembers(new Map([[13,{pid:13,birth:'999',group:11,session:11,state:'S'}]]),root,known,11),/could not be verified/);
  assert.throws(()=>ownedGroupMembers(new Map([[12,{...descendant,birth:'999'}]]),root,known,11),/could not be verified/);
  assert.equal(ownedGroupMembers(new Map([[12,descendant]]),root,known,11).length,1);
  assert.equal(ownedGroupMembers(new Map([[12,{...descendant,state:'Z'}]]),root,known,11).length,1);
});
test('Darwin protected-process unknown state is parsed conservatively without hiding live owned members',()=>{
  const rows=parseDarwinProcessTable('  11 1 11 abc Ss Thu Oct  8 14:00:00 2026\n 12 11 11 abc ?N Thu Oct  8 14:00:01 2026\n 99 1 99 def ? Thu Oct  8 14:00:02 2026\n');
  assert.equal(rows[1].state,'?');assert.equal(rows[2].group,99);
  const table=new Map(rows.map(row=>[row.pid,row])),known=new Map([[11,rows[0]],[12,rows[1]]]);
  assert.equal(ownedGroupMembers(table,rows[0],known,11).length,2);
  assert.throws(()=>ownedGroupMembers(new Map([[12,rows[1]]]),rows[0],new Map(),11),/could not be verified/);
  assert.throws(()=>parseDarwinProcessTable('11 1 11 abc ? missing birth\n'),/could not be verified/);
});
test('a post-spawn error does not abandon ownership of real helpers',{timeout:20000},async t=>{
  const {child,descendant,owned}=await fixture(t);
  child.emit('error',new Error('synthetic post-spawn IPC error'));
  await owned.close();assert.equal(await running(descendant),false);
});
test('Linux birth-checked cleanup also stops a captured helper in a separate process group',{skip:process.platform!=='linux',timeout:20000},async t=>{
  const {descendant,owned}=await fixture(t,{escaped:true});await owned.capture();
  await owned.close();assert.equal(await running(descendant),false);
});
test('Darwin escaped PID cleanup fails safely when only second-precision birth metadata is available',{skip:process.platform!=='darwin',timeout:20000},async t=>{
  const {descendant,owned}=await fixture(t,{escaped:true});await owned.capture();
  await assert.rejects(owned.close(),/could not be verified/);assert.equal(await running(descendant),true);
});
test('Windows unexpected exit without captured ancestry is reported as unverified',{skip:process.platform!=='win32',timeout:20000},async t=>{
  const {child,descendant,owned}=await fixture(t,{capture:false});
  // Windows has no process-group anchor and no ancestry has been recorded.
  const exit=new Promise(r=>child.once('exit',r));child.send('exit');await exit;
  await assert.rejects(owned.close(),/unverified|could not be verified/i);
  assert.equal(await running(descendant),true);
});
