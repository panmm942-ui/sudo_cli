import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {syncBuiltinESMExports} from 'node:module';
import {mkdtemp,rm} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from './fixtures/temp-root.mjs';
import {createTaskInbox} from '../src/task-inbox.mjs';
import {observeTaskUpdates} from './fixtures/task-update-observer.mjs';

test('terminal receipts wait for a real durable write and preserve the saved task',{timeout:5000},async t=>{
  const root=await mkdtemp(join(tmpdir(),'sudo-task-receipt-'));
  const inbox=await createTaskInbox({stateDir:root,cwd:root}),job=await inbox.submit({prompt:'Explicit receipt task'});
  await inbox.update(job.id,{status:'assessing'});
  let entered,release;const writing=new Promise(resolve=>entered=resolve),gate=new Promise(resolve=>release=resolve);
  const original=fs.promises.open;
  const replacement=t.mock.method(fs.promises,'open',async(...args)=>{
    const file=await original(...args);
    if(String(args[0]).startsWith(inbox.directory)&&String(args[0]).endsWith('.tmp')){
      const write=file.writeFile.bind(file),sync=file.sync.bind(file);let value;
      file.writeFile=async(text,...rest)=>{value=JSON.parse(String(text));return write(text,...rest);};
      file.sync=async()=>{if(value.id===job.id&&value.status==='blocked'){entered();await gate;}return sync();};
    }
    return file;
  });syncBuiltinESMExports();
  const observer=observeTaskUpdates(inbox);let settled=false,update;
  try{
    const receipt=observer.waitFor(job.id,'blocked',{signal:t.signal});receipt.then(()=>settled=true,()=>settled=true);
    update=inbox.update(job.id,{status:'blocked',reason:'Human approval is required'});
    await writing;assert.equal(settled,false);assert.equal((await inbox.get(job.id)).status,'assessing');
    release();const saved=await receipt;await update;
    assert.equal(saved.id,job.id);assert.equal(saved.status,'blocked');assert.equal(saved.reason,'Human approval is required');
    assert.deepEqual(await inbox.get(job.id),saved);assert.equal(saved.result,undefined);
  }finally{release();await update;observer.close();replacement.mock.restore();syncBuiltinESMExports();await rm(root,{recursive:true,force:true});}
});

test('a receipt rejects a wrong returned identity or an unexpected terminal status',async()=>{
  for(const record of [{id:'other',status:'completed'},{id:'task',status:'failed'},{id:'task',status:'assessing'}]){
    const inbox={update:async()=>record},observer=observeTaskUpdates(inbox);
    try{const receipt=observer.waitFor('task','completed');const rejected=assert.rejects(receipt,/returned identity|returned status|terminal status/);await inbox.update('task',{status:record.status==='assessing'?'completed':record.status});await rejected;}finally{observer.close();}
  }
});

test('rejected writes reject only their matching receipt and preserve the original error',async()=>{
  const failure=new Error('Fixture durable write rejected'),inbox={update:async()=>{throw failure;}},observer=observeTaskUpdates(inbox);
  try{
    const receipt=observer.waitFor('task','completed'),rejected=assert.rejects(receipt,error=>error===failure);
    await assert.rejects(inbox.update('task',{status:'completed'}),error=>error===failure);await rejected;
  }finally{observer.close();}
});

test('a missing transition aborts under its owning test bound and prior success cannot satisfy a retry',{timeout:2000},async()=>{
  const inbox={update:async(id,patch)=>({id,status:patch.status})},original=inbox.update,observer=observeTaskUpdates(inbox);
  try{
    await inbox.update('task',{status:'completed'});
    const controller=new AbortController(),error=new DOMException('Fixture observation canceled','AbortError');
    const receipt=observer.waitFor('task','completed',{signal:controller.signal}),rejected=assert.rejects(receipt,value=>value===error);
    await inbox.update('other',{status:'completed'});controller.abort(error);await rejected;
    const retried=observer.waitFor('task','completed');await inbox.update('task',{status:'assessing'});await inbox.update('task',{status:'completed'});
    assert.deepEqual(await retried,{id:'task',status:'completed'});
  }finally{observer.close();assert.equal(inbox.update,original);}
});

test('observer teardown rejects pending waits, restores the inbox and bounds registrations',async()=>{
  const inbox={update:async(id,patch)=>({id,status:patch.status})},original=inbox.update,observer=observeTaskUpdates(inbox);
  const pending=Array.from({length:128},(_,index)=>observer.waitFor('task-'+index,'completed'));
  const results=Promise.allSettled(pending);
  assert.throws(()=>observer.waitFor('overflow','completed'),/registration limit/);
  observer.close();const settled=await results;assert.ok(settled.every(value=>value.status==='rejected'));
  assert.equal(inbox.update,original);assert.throws(()=>observer.waitFor('closed','completed'),/closed/);
});

test('an absent matching transition rejects on the owning signal instead of claiming completion',{timeout:2000},async()=>{
  const inbox={update:async(id,patch)=>({id,status:patch.status})},observer=observeTaskUpdates(inbox),controller=new AbortController();
  const failure=new DOMException('Fixture completion observation expired','TimeoutError');
  let timer;try{
    const receipt=observer.waitFor('task','completed',{signal:controller.signal}),rejected=assert.rejects(receipt,error=>error===failure);
    await inbox.update('other',{status:'completed'});timer=setTimeout(()=>controller.abort(failure),20);await rejected;
  }finally{clearTimeout(timer);observer.close();}
});
