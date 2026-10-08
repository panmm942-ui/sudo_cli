import test from 'node:test';
import assert from 'node:assert/strict';
import {spawn,execFile} from 'node:child_process';
import {readFile,writeFile,mkdtemp,rm} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from './fixtures/temp-root.mjs';
import {ownProcess,sameProcess,ownedGroupMembers,parseDarwinProcessTable} from '../src/owned-process.mjs';
import {isolatedEnvironment} from '../src/permission-scope.mjs';

const pause=ms=>new Promise(resolve=>setTimeout(resolve,ms));
const live=row=>row&&!['Z','X','x'].includes(row.state);
async function row(pid){
  if(process.platform==='linux'){
    try{const text=await readFile(`/proc/${pid}/stat`,'utf8'),fields=text.slice(text.lastIndexOf(')')+2).trim().split(/\s+/);return{pid,ppid:Number(fields[1]),group:Number(fields[2]),session:Number(fields[3]),state:fields[0],birth:fields[19]};}
    catch(error){if(error.code==='ENOENT'||error.code==='ESRCH')return;throw error;}
  }
  const text=await new Promise((resolve,reject)=>execFile('/bin/ps',['-p',String(pid),'-o','pid=,ppid=,pgid=,sess=,stat=,lstart='],{env:isolatedEnvironment(process.env,{PATH:'/usr/bin:/bin',LC_ALL:'C'}),shell:false,timeout:2500,maxBuffer:4096,encoding:'utf8'},(error,stdout)=>error&&error.code!==1?reject(new Error('Fixture identity read failed.')):resolve(stdout)));
  return parseDarwinProcessTable(text)[0];
}
async function until(predicate,timeoutMs=5000){const deadline=Date.now()+timeoutMs;while(Date.now()<deadline){if(await predicate())return;await pause(10);}throw new Error('Owned fixture did not reach its required state.');}
async function marker(path){try{return await readFile(path,'utf8');}catch(error){if(error.code==='ENOENT')return'';throw error;}}
async function fixture(t,persistent=false){
  const directory=await mkdtemp(join(tmpdir(),'sudo-owned-eof-')),log=join(directory,'events'),stop=join(directory,'stop');
  const worker=`const fs=require('node:fs');const log=${JSON.stringify(log)},stop=${JSON.stringify(stop)};process.stdin.resume();process.stdin.once('end',()=>{fs.appendFileSync(log,'EOF\\n');${persistent?'':'process.exit(0);'}});process.on('SIGTERM',()=>fs.appendFileSync(log,'SIGNAL\\n'));process.send({ready:true});setInterval(()=>{if(fs.existsSync(stop)){fs.appendFileSync(log,'STOP\\n');process.exit(0);}},10);`;
  const parent=`const {spawn}=require('node:child_process');const child=spawn(process.execPath,['-e',${JSON.stringify(worker)}],{detached:true,stdio:['pipe','ignore','ignore','ipc']});child.once('message',()=>process.send({pid:child.pid}));setInterval(()=>{},1000);`;
  const child=spawn(process.execPath,['-e',parent],{detached:true,stdio:['ignore','ignore','ignore','ipc'],env:isolatedEnvironment(process.env),shell:false});
  let descendant,record;
  t.after(async()=>{
    // Private fixture stop channel, not a signal to a second-precision PID.
    await writeFile(stop,'stop');
    if(child.exitCode===null&&child.signalCode===null)child.kill('SIGKILL');
    await until(()=>child.exitCode!==null||child.signalCode!==null);
    if(record)await until(async()=>!sameProcess(record,await row(descendant))||!live(await row(descendant)));
    if(child.connected)child.disconnect();
    await rm(directory,{recursive:true,force:true});
  });
  descendant=await new Promise((resolve,reject)=>{
    const timer=setTimeout(()=>reject(new Error('Owned fixture readiness failed.')),5000);
    child.once('message',value=>{clearTimeout(timer);if(!Number.isSafeInteger(value?.pid)||value.pid<1)reject(new Error('Owned fixture identity invalid.'));else resolve(value.pid);});
    child.once('error',()=>{clearTimeout(timer);reject(new Error('Owned fixture startup failed.'));});
  });
  const owned=ownProcess(child),table=await owned.capture();record=table.get(descendant);
  assert.ok(record);assert.equal(record.ppid,child.pid);assert.notEqual(record.group,child.pid);
  return{child,descendant,record,owned,log};
}

test('exact Darwin signal phase defers an escaped known helper only for the existing graceful stop',async()=>{
  // Exact production function, deterministic Darwin platform API/table fixture.
  // This assertion is not an actual macOS process execution claim.
  const source=await readFile(new URL('../src/owned-process.mjs',import.meta.url),'utf8');
  const from=source.indexOf('  async function signalKnown(signal, table, deadline) {'),to=source.indexOf('  function stillRunning(table) {',from);assert.ok(from>0&&to>from);
  const root={pid:101,ppid:1,group:101,session:101,state:'R',birth:'root-birth'},escaped={pid:102,ppid:101,group:102,session:102,state:'?',birth:'escaped-birth'};
  const known=new Map([[101,root],[102,escaped]]),table=new Map([[101,root],[102,escaped]]),signals=[];
  const api={platform:'darwin',kill:(pid,signal)=>{signals.push({pid,signal});assert.notEqual(pid,escaped.pid,'Darwin escaped individual PID must never be signalled');}};
  const make=new Function('known','pid','root','process','processTable','ownedGroupMembers','sameProcess','failure','live','let groupGone=false;'+source.slice(from,to)+';return signalKnown;');
  const signalKnown=make(known,root.pid,root,api,async()=>table,ownedGroupMembers,sameProcess,()=>new Error('Owned engine process cleanup could not be verified.'),live);
  await signalKnown('SIGTERM',table,Date.now()+5000);
  assert.deepEqual(signals,[{pid:-root.pid,signal:'SIGTERM'}]);
  table.set(root.pid,{...root,state:'Z'});
  await assert.rejects(signalKnown('SIGKILL',table,Date.now()+5000),/could not be verified/);
  assert.deepEqual(signals,[{pid:-root.pid,signal:'SIGTERM'}]);
  table.delete(escaped.pid);await signalKnown('SIGKILL',table,Date.now()+5000);assert.equal(signals.length,1);
});

test('actual Unix escaped fixture exits naturally on stdin EOF after its private root group terminates',{skip:!['linux','darwin'].includes(process.platform),timeout:15000},async t=>{
  const {child,descendant,record,owned,log}=await fixture(t);
  process.kill(-child.pid,'SIGTERM');
  await until(async()=>!sameProcess(record,await row(descendant))||!live(await row(descendant)));
  assert.match(await marker(log),/^EOF\n$/);assert.equal(child.signalCode,'SIGTERM');
  await owned.close();
});

test('actual Darwin close verifies an escaped helper that exits on stdin EOF within the unchanged grace',{skip:process.platform!=='darwin',timeout:15000},async t=>{
  const {child,descendant,record,owned,log}=await fixture(t),signals=[],kill=process.kill;
  t.mock.method(process,'kill',function(pid,signal){if(signal!==0)signals.push({pid,signal});return kill.call(process,pid,signal);});
  await owned.close();
  const current=await row(descendant);assert.ok(!sameProcess(record,current)||!live(current));
  assert.match(await marker(log),/^EOF\n$/);assert.equal(child.signalCode,'SIGTERM');
  assert.ok(signals.some(value=>value.pid===-child.pid&&value.signal==='SIGTERM'));
  assert.equal(signals.some(value=>value.pid===descendant),false);
});

test('actual Darwin persistent escaped helper is rejected after grace without an individual PID signal',{skip:process.platform!=='darwin',timeout:15000},async t=>{
  const {child,descendant,record,owned,log}=await fixture(t,true),signals=[],kill=process.kill;
  t.mock.method(process,'kill',function(pid,signal){if(signal!==0)signals.push({pid,signal});return kill.call(process,pid,signal);});
  await assert.rejects(owned.close(),/could not be verified/);
  assert.equal(sameProcess(record,await row(descendant)),true);assert.equal(live(await row(descendant)),true);
  assert.match(await marker(log),/^EOF\n$/);assert.equal(child.signalCode,'SIGTERM');
  assert.ok(signals.some(value=>value.pid===-child.pid&&value.signal==='SIGTERM'));
  assert.equal(signals.some(value=>value.pid===descendant),false);
});
