import test from 'node:test';
import assert from 'node:assert/strict';
import {PassThrough} from 'node:stream';
import {readFile,writeFile,mkdtemp,rm} from 'node:fs/promises';
import {join} from 'node:path';
import {pathToFileURL} from 'node:url';
import {setTimeout as delay} from 'node:timers/promises';
import {tmpdir} from './fixtures/temp-root.mjs';
import {resetStartupGate,setStartupGate,startupView} from './fixtures/performance-startup.mjs';

async function until(predicate,message){
  const deadline=Date.now()+2000;
  while(!predicate()&&Date.now()<deadline)await delay(5);
  assert.ok(predicate(),message);
}
async function withPendingScan(t,run){
  const directory=await mkdtemp(join(tmpdir(),'sudo-ui-startup-'));
  t.after(()=>rm(directory,{recursive:true,force:true,maxRetries:5,retryDelay:100}));
  const original=new URL('../src/ui.mjs',import.meta.url),fixture=new URL('./fixtures/performance-startup.mjs',import.meta.url).href;
  const boundaries=new Set(['./privileges.mjs','./system-performance.mjs','./network-status.mjs','./project-changes.mjs','./dashboard.mjs','./notifications.mjs','./github-releases.mjs']);
  const source=(await readFile(original,'utf8')).replace(/from\s+(['"])(\.[^'"]+)\1/g,(_match,_quote,path)=>'from '+JSON.stringify(boundaries.has(path)?fixture:new URL(path,original).href));
  const target=join(directory,'ui.mjs');await writeFile(target,source);
  const module=await import(pathToFileURL(target));
  const input=new PassThrough();input.isTTY=true;input.setRawMode=()=>{};
  const descriptor=Object.getOwnPropertyDescriptor(process,'stdin'),write=process.stdout.write,state=process.env.SUDO_CLI_STATE_DIR;
  const gate=resetStartupGate();setStartupGate(gate);let running,settled=false;
  try{
    process.env.SUDO_CLI_STATE_DIR=join(directory,'state');Object.defineProperty(process,'stdin',{configurable:true,value:input});process.stdout.write=()=>true;
    const startedAt=performance.now();running=module.runUI({cwd:directory});running.then(()=>{settled=true;},()=>{settled=true;});
    await gate.started;
    await run({input,gate,directory,running,startedAt,isSettled:()=>settled});
  }finally{
    process.emit('SIGTERM');gate.stop();await running?.catch(()=>{});input.destroy();process.stdout.write=write;Object.defineProperty(process,'stdin',descriptor);
    if(state===undefined)delete process.env.SUDO_CLI_STATE_DIR;else process.env.SUDO_CLI_STATE_DIR=state;
  }
}

// Regression: awaiting the full inventory before readiness blocks both setup
// commands and /quit. Hardware, GitHub and elevation are isolated; all other
// UI initialization, prompt dispatch and private state operate normally.
test('interactive prompt and configuration commands remain usable during a slow project scan',{timeout:10000},async t=>{
  await withPendingScan(t,async({input,running,startedAt,isSettled})=>{
    await until(()=>startupView().input?.prompt?.includes('01@you >'),'The normal prompt must appear without waiting for the project inventory.');
    t.diagnostic(`Prompt ready while inventory is pending: ${Math.ceil(performance.now()-startedAt)} ms (isolated hardware/elevation/GitHub).`);
    assert.equal(startupView().session.working,false,'File indexing must not start the AI activity indicator.');
    input.write('/notify status\r');
    await until(()=>startupView().events.some(text=>/Notifications: Off/.test(text)),'Configuration commands must execute while indexing is pending.');
    input.write('/quit\r');
    await until(isSettled,'Quitting must cancel and drain the pending inventory.');
    await running;
  });
});

for(const command of ['/verify','/undo','/agents apply fixture coder','/24.7 start','/startup install','/autostart install'])test(`${command} waits for the initial baseline and its wait can be cancelled`,{timeout:10000},async t=>{
  await withPendingScan(t,async({input})=>{
    await until(()=>startupView().input?.prompt?.includes('01@you >'),'Prompt must become ready during inventory.');
    input.write(command+'\r');
    await until(()=>startupView().events.some(text=>/Preparing project files/.test(text)),'Workspace work must report its wait for a baseline.');
    assert.equal(startupView().session.working,false,'No AI activity should be reported during inventory.');
    input.write('\x03');
    await until(()=>startupView().input?.prompt?.includes('02@you >'),'Cancelling the baseline wait must return to the same usable session.');
    input.write('/notify status\r');
    await until(()=>startupView().events.some(text=>/Notifications: Off/.test(text)),'The scan must not hold input after cancellation.');
  });
});
