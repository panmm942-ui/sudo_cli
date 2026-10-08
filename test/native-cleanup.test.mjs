import test from 'node:test';
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {once} from 'node:events';
import {mkdtemp,mkdir,access,rm,writeFile} from 'node:fs/promises';
import {spawn} from 'node:child_process';
import {join} from 'node:path';
import {tmpdir} from './fixtures/temp-root.mjs';
import {cleanupNativeFixture} from './fixtures/native-cleanup.mjs';
import {isolatedEnvironment} from '../src/permission-scope.mjs';

test('one tracked after-hook closes a later server even when earlier registered storage cleanup fails',{timeout:10000},async t=>{
  const base=await mkdtemp(join(tmpdir(),'sudo-native-hooks-test-'));t.after(()=>rm(base,{recursive:true,force:true}));
  const file=join(base,'fixture.mjs'),helper=new URL('./fixtures/native-cleanup.mjs',import.meta.url).href;
  await writeFile(file,`import test from 'node:test';import {createServer} from 'node:http';import {once} from 'node:events';import {trackNativeFixture} from ${JSON.stringify(helper)};process.channel?.unref();test('tracked teardown',async t=>{const server=createServer();server.listen(0,'127.0.0.1');await once(server,'listening');server.once('close',()=>process.send?.('HTTP_CLOSED'));trackNativeFixture(t,{cleanup:()=>{process.send?.('STORAGE_FAILURE');throw new Error('Synthetic storage cleanup failure.');}});trackNativeFixture(t,{server});process.send?.('HTTP_STARTED');});\n`);
  const child=spawn(process.execPath,[file],{env:isolatedEnvironment(process.env),windowsHide:true,stdio:['ignore','pipe','pipe','ipc']});
  child.stdout.resume();child.stderr.resume();const events=[];child.on('message',message=>events.push(message));
  let timedOut=false;const timer=setTimeout(()=>{timedOut=true;child.kill();},3000);
  try{const [code]=await once(child,'close');assert.equal(timedOut,false,'A rejected after-hook must not keep the fixture process alive');assert.equal(code,1,'Cleanup rejection remains a real test failure');assert.deepEqual(events,['HTTP_STARTED','HTTP_CLOSED','STORAGE_FAILURE']);}finally{clearTimeout(timer);child.kill();}
});

test('native fixture always closes its loopback server and other resources after engine cleanup rejects',async t=>{
  const base=await mkdtemp(join(tmpdir(),'sudo-native-cleanup-test-')),workspace=join(base,'workspace');await mkdir(workspace);
  const server=createServer();server.listen(0,'127.0.0.1');await once(server,'listening');
  t.after(async()=>{server.closeAllConnections();if(server.listening)await new Promise(resolve=>server.close(resolve));await rm(base,{recursive:true,force:true});});
  const failure=Object.assign(new Error('Owned engine cleanup failed.'),{code:'EBUSY'});let bridgeClosed=false,homeClosed=false;
  await assert.rejects(()=>cleanupNativeFixture({engine:{async close(){throw failure;}},bridge:{async close(){bridgeClosed=true;}},server,home:{async cleanup(){homeClosed=true;}},workspace}),error=>error===failure);
  assert.equal(server.listening,false,'Cleanup failure must not retain a live loopback server');
  assert.equal(bridgeClosed,true);assert.equal(homeClosed,true);await assert.rejects(access(workspace),{code:'ENOENT'});
});

test('native fixture preserves a home cleanup failure after closing the server and removing its workspace',async t=>{
  const base=await mkdtemp(join(tmpdir(),'sudo-native-cleanup-test-')),workspace=join(base,'workspace');await mkdir(workspace);
  const server=createServer();server.listen(0,'127.0.0.1');await once(server,'listening');
  t.after(async()=>{server.closeAllConnections();if(server.listening)await new Promise(resolve=>server.close(resolve));await rm(base,{recursive:true,force:true});});
  const failure=Object.assign(new Error('Owned home cleanup failed.'),{code:'EBUSY'});
  await assert.rejects(()=>cleanupNativeFixture({server,home:{async cleanup(){throw failure;}},workspace}),error=>error===failure);
  assert.equal(server.listening,false);await assert.rejects(access(workspace),{code:'ENOENT'});
});
