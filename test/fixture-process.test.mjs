import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,writeFile,rm,access} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from './fixtures/temp-root.mjs';
import {runFixtureProcess} from './fixtures/native-process.mjs';

test('fixture completion follows owned process exit while a bounded descendant retains stdout',{timeout:10000},async t=>{
  const base=await mkdtemp(join(tmpdir(),'sudo-fixture-process-'));t.after(()=>rm(base,{recursive:true,force:true}));
  const release=join(base,'release'),done=join(base,'done'),worker=join(base,'worker.mjs'),main=join(base,'main.mjs');
  await writeFile(worker,`import {existsSync,writeFileSync} from 'node:fs';const deadline=Date.now()+5000;const timer=setInterval(()=>{if(existsSync(${JSON.stringify(release)})||Date.now()>deadline){clearInterval(timer);writeFileSync(${JSON.stringify(done)},'stopped');process.exit(0);}},20);\n`);
  await writeFile(main,`import {spawn} from 'node:child_process';const child=spawn(process.execPath,[${JSON.stringify(worker)}],{windowsHide:true,detached:true,stdio:['ignore',process.stdout,process.stderr]});child.once('spawn',()=>{process.stderr.write('MAIN_READY\\n');process.stdout.write('{"fixture":"complete"}\\n',()=>process.exit(0));});child.once('error',()=>process.exit(2));\n`);
  let readyResolve;const ready=new Promise(resolve=>readyResolve=resolve);const outcome=runFixtureProcess(process.execPath,[main],{onStderr:chunk=>{if(chunk.includes('MAIN_READY'))readyResolve();}});
  let readyTimer,completionTimer;
  try{
    await Promise.race([ready,new Promise((_,reject)=>readyTimer=setTimeout(()=>reject(new Error('Fixture main process did not start.')),5000))]);clearTimeout(readyTimer);
    const completed=await Promise.race([outcome.then(()=>true),new Promise(resolve=>completionTimer=setTimeout(()=>resolve(false),1500))]);clearTimeout(completionTimer);
    assert.equal(completed,true,'Inherited stdout must not delay completion after the owned process has exited');
    const result=await outcome;assert.equal(result.exitCode,0);assert.deepEqual(JSON.parse(result.stdout),{fixture:'complete'});await assert.rejects(access(done),{code:'ENOENT'});
  }finally{clearTimeout(readyTimer);clearTimeout(completionTimer);await writeFile(release,'release');await outcome;const deadline=Date.now()+3000;while(Date.now()<deadline){try{await access(done);break;}catch{await new Promise(resolve=>setTimeout(resolve,20));}}await access(done);}
});

test('fixture process strips provider credentials even when a caller supplies its environment',async()=>{
  const result=await runFixtureProcess(process.execPath,['-e',"process.stdout.write(JSON.stringify({key:process.env.OPENAI_API_KEY??null}));"],{env:{...process.env,OPENAI_API_KEY:'fixture'}});
  assert.deepEqual(JSON.parse(result.stdout),{key:null});
});

test('fixture process times out and returns only a fixed bounded diagnostic',async()=>{
  await assert.rejects(()=>runFixtureProcess(process.execPath,['-e',"process.stderr.write('fixture-private-diagnostic');setInterval(()=>{},1000);"],{timeoutMs:200}),error=>error.code==='TIMEOUT'&&error.phase==='execution'&&!error.message.includes('fixture-private-diagnostic')&&error.message.length<200);
});

test('fixture process rejects excess output and observer failures without retaining the child',async()=>{
  await assert.rejects(()=>runFixtureProcess(process.execPath,['-e',"process.stdout.write('x'.repeat(10000));setInterval(()=>{},1000);"],{maxBytes:64}),{code:'OUTPUT_LIMIT'});
  await assert.rejects(()=>runFixtureProcess(process.execPath,['-e',"process.stderr.write('stage');setInterval(()=>{},1000);"],{onStderr(){throw new Error('private observer diagnostic');}}),error=>error.code==='OBSERVER_FAILED'&&!error.message.includes('private observer diagnostic'));
});

test('fixture process honors cancellation during execution and before any child starts',async t=>{
  const controller=new AbortController();
  await assert.rejects(()=>runFixtureProcess(process.execPath,['-e',"process.stderr.write('READY');setInterval(()=>{},1000);"],{signal:controller.signal,onStderr:()=>controller.abort()}),{name:'AbortError'});
  const base=await mkdtemp(join(tmpdir(),'sudo-fixture-abort-'));t.after(()=>rm(base,{recursive:true,force:true}));const marker=join(base,'started');
  await assert.rejects(()=>runFixtureProcess(process.execPath,['-e',`require('node:fs').writeFileSync(${JSON.stringify(marker)},'started')`],{signal:controller.signal}),{name:'AbortError'});
  await assert.rejects(access(marker),{code:'ENOENT'});
});
