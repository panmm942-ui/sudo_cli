import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,readdir,rm} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from './fixtures/temp-root.mjs';
import {fork,execFile} from 'node:child_process';
import {randomUUID} from 'node:crypto';
import {fileURLToPath} from 'node:url';
import {isolatedEnvironment} from '../src/permission-scope.mjs';
import {createTaskInbox} from '../src/task-inbox.mjs';
import {createNotifications} from '../src/notifications.mjs';
import {playDetachedNotification,createDetachedTaskReporter} from '../src/detached-notifications.mjs';

async function fixture(t){
  const stateDir=await mkdtemp(join(tmpdir(),'codexcli-detached-sounds-'));
  t.after(()=>rm(stateDir,{recursive:true,force:true}));
  return stateDir;
}

test('each detached outcome reads the current saved preference and closes its fresh controller',async t=>{
  const stateDir=await fixture(t),directory=join(stateDir,'preferences'),played=[],controllers=[];
  const notificationsFactory=options=>{
    assert.equal(options.directory,directory);assert.equal(options.interactive,true);
    assert.equal(options.output.isTTY,false);assert.equal(options.maxQueue,1);
    const controller=createNotifications({...options,play:async value=>played.push(value.event)});
    controllers.push(controller);return controller;
  };
  assert.equal((await playDetachedNotification({stateDir,event:'done',id:'first',notificationsFactory})).status,'disabled');
  assert.deepEqual(await readdir(directory),[]);assert.deepEqual(played,[]);
  const current=createNotifications({directory,interactive:false});await current.on();await current.close();
  assert.equal((await playDetachedNotification({stateDir,event:'approval',id:'second',notificationsFactory})).status,'played');
  assert.deepEqual(played,['approval']);assert.equal(controllers.length,2);
  assert.ok(controllers.every(controller=>controller.get().closed));
  assert.deepEqual(await readdir(directory),['notifications.json']);
});

test('failed or missing audio produces one generic message, never a terminal bell or private error',async t=>{
  const stateDir=await fixture(t),logs=[],writes=[];
  const preference=createNotifications({directory:join(stateDir,'preferences'),interactive:false});await preference.on();await preference.close();
  const value=await playDetachedNotification({stateDir,event:'error',id:'failure',log:(...args)=>logs.push(args),notificationsFactory:options=>createNotifications({...options,platform:'linux',output:{...options.output,write:value=>writes.push(value)},execute:async()=>{throw Object.assign(new Error('SECRET private audio path'),{code:'ENOENT'});}})});
  assert.equal(value.status,'unavailable');assert.deepEqual(writes,[]);assert.equal(logs.length,1);
  assert.ok(!JSON.stringify(logs).includes('SECRET'));assert.deepEqual(await readdir(join(stateDir,'preferences')),['notifications.json']);
});

test('factory, playback and cleanup failures do not escape or include their private details',async t=>{
  const stateDir=await fixture(t);
  for(const phase of ['factory','playback','cleanup']){
    let closed=0;const logs=[];
    const result=await playDetachedNotification({stateDir,event:'interrupted',id:phase,log:(...args)=>logs.push(args),notificationsFactory:()=>{
      if(phase==='factory')throw new Error('SECRET factory');
      return {notify:async()=>{if(phase==='playback')throw new Error('SECRET playback');return {status:'played',event:'interrupted'};},close:async()=>{closed++;if(phase==='cleanup')throw new Error('SECRET cleanup');}};
    }});
    assert.ok(['played','unavailable'].includes(result.status));assert.equal(closed,phase==='factory'?0:1);
    assert.equal(logs.length,1);assert.ok(!JSON.stringify(logs).includes('SECRET'));
  }
});

test('an uncooperative player is bounded and private WAV files are removed on close',async t=>{
  const stateDir=await fixture(t),logs=[];let controller;
  const preference=createNotifications({directory:join(stateDir,'preferences'),interactive:false});await preference.on();await preference.close();
  const started=Date.now();
  const result=await playDetachedNotification({stateDir,event:'done',id:'timeout',timeoutMs:25,log:(...args)=>logs.push(args),notificationsFactory:options=>(controller=createNotifications({...options,play:()=>new Promise(()=>{})}))});
  assert.equal(result.status,'unavailable');assert.ok(Date.now()-started<2000);
  assert.equal(controller.get().closed,true);assert.equal(logs.length,1);
  assert.deepEqual(await readdir(join(stateDir,'preferences')),['notifications.json']);
});

test('detached reporter shutdown drains a coordinator error already in flight and closes its controller',async t=>{
  const stateDir=await fixture(t);let finish,closed=0,finished=false;
  const reporter=createDetachedTaskReporter({stateDir,work:{result:async(_job,patch)=>patch},notificationsFactory:()=>({notify:()=>new Promise(resolve=>{finish=()=>resolve({status:'played',event:'error'});}),close:async()=>{closed++;}})});
  const notification=reporter.error(new Error('Fixture coordinator error'));
  while(!finish)await new Promise(resolve=>setTimeout(resolve,1));
  const cleanup=reporter.close().then(()=>{finished=true;});await new Promise(resolve=>setTimeout(resolve,10));assert.equal(finished,false);
  finish();await notification;await cleanup;assert.equal(closed,1);assert.equal(finished,true);
});

test('the detached task reporter emits exactly one terminal sound per real attempt, including reason-only outcomes',async t=>{
  const stateDir=await fixture(t),played=[];
  const preference=createNotifications({directory:join(stateDir,'preferences'),interactive:false});await preference.on();await preference.close();
  const reporter=createDetachedTaskReporter({stateDir,work:{result:async(_job,patch)=>patch},notificationsFactory:options=>createNotifications({...options,play:async value=>played.push(value.event)})});
  const scenarios=[{status:'completed',result:'completed result'},{status:'blocked',code:'APPROVAL_REQUIRED',reason:'Permission required.'},{status:'failed',reason:'A task failed.'},{status:'cancelled',reason:'Stopped before completion.'},{status:'blocked',reason:'Need more information.'}];
  for(const [index,patch] of scenarios.entries()){
    const job={id:String(index),prompt:'SECRET task prompt'};reporter.begin(job.id);
    assert.deepEqual(await reporter.result(job,patch),patch);await reporter.result(job,patch);
  }
  assert.deepEqual(played,['done','approval','error','interrupted','error']);
  reporter.begin('0');await reporter.result({id:'0'},{status:'completed',result:'retry'});
  assert.deepEqual(played,['done','approval','error','interrupted','error','done']);
});

test('worker IPC fixture is harmless when normal test discovery launches it without IPC',async()=>{
  const fixturePath=fileURLToPath(new URL('./fixtures/detached-worker-sounds.mjs',import.meta.url));
  await new Promise((resolve,reject)=>execFile(process.execPath,['--test','--test-reporter=tap',fixturePath],{env:isolatedEnvironment(process.env),windowsHide:true,timeout:5000,maxBuffer:8192},(error,stdout,stderr)=>{
    if(error){reject(new Error('Standalone fixture discovery failed: '+stdout+stderr));return;}
    assert.match(stdout,/# fail 0/);assert.ok(!stderr.includes('Module mocking is not enabled'));resolve();
  }));
});

test('actual detached worker stays quiet when idle or Off, refreshes On, and awaits its stop outcome',async t=>{
  const cwd=await mkdtemp(join(tmpdir(),'codexcli-worker-sounds-')),stateDir=join(cwd,'state');
  const preferences=()=>createNotifications({directory:join(stateDir,'preferences'),interactive:false});
  let preference=preferences();await preference.off();await preference.close();
  const child=fork(fileURLToPath(new URL('./fixtures/detached-worker-sounds.mjs',import.meta.url)),[],{execArgv:['--experimental-test-module-mocks'],env:isolatedEnvironment(process.env),windowsHide:true,stdio:['ignore','ignore','pipe','ipc']});
  const messages=[],errors=[];let exitCode,port;
  const id=randomUUID(),token='a'.repeat(64);
  child.on('message',value=>messages.push(value));child.stderr.on('data',value=>errors.push(value));
  const exited=new Promise(resolve=>child.once('exit',code=>{exitCode=code;resolve();}));
  async function waitFor(predicate){
    const end=Date.now()+10000;
    while(Date.now()<end){if(await predicate())return;if(exitCode!==undefined)assert.fail('Synthetic worker exited: '+Buffer.concat(errors).toString());await new Promise(resolve=>setTimeout(resolve,20));}
    assert.fail('Expected worker outcome did not occur: '+JSON.stringify(messages));
  }
  async function stop(){if(port&&exitCode===undefined)await fetch(`http://127.0.0.1:${port}/stop`,{method:'POST',headers:{authorization:`Bearer ${token}`},signal:AbortSignal.timeout(2000)}).catch(()=>{});}
  t.after(async()=>{try{await stop();if(exitCode===undefined){await Promise.race([exited,new Promise(resolve=>setTimeout(resolve,3000))]);if(exitCode===undefined){child.kill();await exited;}}}finally{await rm(cwd,{recursive:true,force:true});}});
  const connection={baseUrl:'http://127.0.0.1:1/v1',model:'fixture',transport:'chat-completions'};
  child.send({type:'initialize',id,token,cwd,stateDir,config:{localConnection:connection,cloudConnection:connection,settings:{permissions:'ask',webAccess:false},watchPaths:[],pollMs:100,idleSleepMs:100}});
  await waitFor(()=>messages.some(value=>value.type==='ready'));port=messages.find(value=>value.type==='ready').port;
  child.send({type:'registered',id});await waitFor(()=>messages.some(value=>value.type==='started'));
  await new Promise(resolve=>setTimeout(resolve,150));
  assert.equal(messages.filter(value=>value.type==='fixture-request').length,0);assert.equal(messages.filter(value=>value.type==='fixture-sound').length,0);
  const inbox=await createTaskInbox({cwd,stateDir});
  async function submit(prompt,status){const job=await inbox.submit({prompt,source:'user'});await waitFor(async()=>(await inbox.get(job.id)).status===status);return job;}
  await submit('done','completed');assert.equal(messages.filter(value=>value.type==='fixture-sound').length,0);
  preference=preferences();await preference.on();await preference.close();
  await submit('done','completed');await submit('approval','blocked');await submit('error','failed');await submit('information','blocked');
  assert.deepEqual(messages.filter(value=>value.type==='fixture-sound').map(value=>value.event),['done','approval','error','error']);
  await inbox.submit({prompt:'stop',source:'user'});await waitFor(()=>messages.some(value=>value.type==='fixture-waiting'));
  await stop();await exited;assert.equal(exitCode,0);
  assert.deepEqual(messages.filter(value=>value.type==='fixture-sound').map(value=>value.event),['done','approval','error','error','interrupted']);
  assert.ok(messages.filter(value=>value.type==='fixture-sound').every(value=>value.nonTTY));
  const files=await readdir(join(stateDir,'preferences'));assert.deepEqual(files,['notifications.json']);
});
