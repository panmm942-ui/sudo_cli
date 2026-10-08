import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {syncBuiltinESMExports} from 'node:module';
import { mkdtemp, mkdir, writeFile, readFile, rm, symlink } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from './fixtures/temp-root.mjs';
import { createTaskInbox } from '../src/task-inbox.mjs';
import { createAlwaysOn } from '../src/always-on.mjs';

const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(predicate, ms = 4000) {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) { if (await predicate()) return; await delay(10); }
  assert.fail('Coordinator did not reach its expected state in time.');
}
async function fixture(t, options = {}) {
  const {inboxSecrets,...coordinatorOptions}=options;
  const root = await mkdtemp(join(tmpdir(), 'codexcli-always-on-'));
  const cwd = join(root, 'project'); await mkdir(cwd);
  const inbox = await createTaskInbox({ cwd, stateDir: join(root, 'state'), ...(inboxSecrets?{secrets:inboxSecrets}:{}) });
  const agent = createAlwaysOn({ inbox, pollMs: 10, idleSleepMs: 40, ...coordinatorOptions });
  t.after(async () => { await agent.stop(); await rm(root, { recursive: true, force: true }); });
  return { root, cwd, inbox, agent };
}

test('an idle coordinator makes no model calls and submits work only when explicitly requested', async t => {
  let assessed = 0, cloud = 0;
  const { agent, inbox } = await fixture(t, { assess: async () => { assessed++; return { action: 'cloud' }; }, runCloud: async () => { cloud++; return 'Completed'; } });
  await agent.start(); await delay(90);
  assert.equal(assessed, 0); assert.equal(cloud, 0);
  const job = await agent.submit({ prompt: 'Explicit task' });
  await until(async () => (await inbox.get(job.id)).status === 'completed');
  assert.equal(assessed, 1); assert.equal(cloud, 1);
  assert.equal((await inbox.get(job.id)).result, 'Completed');
});

test('local and wait decisions never invoke cloud and wait does not retry automatically', async t => {
  let assessed = 0, cloud = 0;
  const { agent, inbox } = await fixture(t, { assess: async job => { assessed++; return job.prompt === 'Local' ? { action: 'local', result: 'Handled locally' } : { action: 'wait', reason: 'Need more input' }; }, runCloud: async () => { cloud++; } });
  await agent.start();
  const local = await agent.submit({ prompt: 'Local' });
  const wait = await agent.submit({ prompt: 'Wait' });
  await until(async () => (await inbox.get(wait.id)).status === 'blocked');
  assert.equal((await inbox.get(local.id)).result, 'Handled locally');
  await delay(80);
  assert.equal(assessed, 2); assert.equal(cloud, 0);
});

test('malformed local decisions block the task without invoking a costly worker', async t => {
  let cloud = 0;
  const { agent, inbox } = await fixture(t, { assess: async () => ({ action: 'launch anything', instructions: 'private payload' }), runCloud: async () => { cloud++; } });
  await agent.start(); const job = await agent.submit({ prompt: 'Task' });
  await until(async () => (await inbox.get(job.id)).status === 'blocked');
  assert.equal(cloud, 0);
  assert.match((await inbox.get(job.id)).reason, /invalid decision/i);
});

test('wake hooks run before cloud, sleep after idle, and failed wake prevents the cloud call', async t => {
  const events = [];
  const { agent, inbox } = await fixture(t, { assess: async () => ({ action: 'cloud', prompt: 'Assessed task' }), wake: async () => events.push('wake'), sleep: async () => events.push('sleep'), runCloud: async job => { events.push(job.prompt); return 'Done'; } });
  await agent.start(); const job = await agent.submit({ prompt: 'Task' });
  await until(async () => (await inbox.get(job.id)).status === 'completed');
  const runIndex = events.indexOf('Assessed task');
  await until(() => events.slice(runIndex + 1).includes('sleep'));
  assert.equal(events[runIndex - 1], 'wake', 'Wake must precede the cloud call even when an initial idle sleep already occurred.');
  const failures = [];
  const failed = await fixture(t, { assess: async () => ({ action: 'cloud' }), wake: async () => { throw new Error('Wake failed'); }, runCloud: async () => failures.push('cloud'), onError: error => failures.push(error.message) });
  await failed.agent.start(); const other = await failed.agent.submit({ prompt: 'Task' });
  await until(async () => (await failed.inbox.get(other.id)).status === 'blocked');
  assert.equal(failures.includes('cloud'), false); assert.ok(failures.some(value => /Wake failed/.test(value)));
});

test('stop aborts a running worker and leaves its task blocked for explicit recovery', async t => {
  let aborted = false;
  const { agent, inbox } = await fixture(t, { assess: async () => ({ action: 'cloud' }), runCloud: async (_job, { signal }) => new Promise((resolve, reject) => {
    signal.addEventListener('abort', () => { aborted = true; reject(signal.reason); }, { once: true });
  }) });
  await agent.start(); const job = await agent.submit({ prompt: 'Long task' });
  await until(() => agent.snapshot().state === 'working');
  await agent.stop();
  assert.equal(aborted, true);
  assert.equal((await inbox.get(job.id)).status, 'blocked');
  assert.equal(agent.snapshot().state, 'stopped');
  await agent.start(); await delay(60);
  assert.equal((await inbox.get(job.id)).status, 'blocked');
});

test('sleep failure is reported once and does not trigger a busy retry loop', async t => {
  const errors = [];
  let slept = 0;
  const { agent } = await fixture(t, { assess: async () => ({ action: 'wait' }), runCloud: async () => '', sleep: async () => { slept++; throw new Error('Sleep failed'); }, onError: error => errors.push(error.message) });
  await agent.start(); await until(() => errors.length === 1); await delay(90);
  assert.equal(slept, 1); assert.equal(agent.snapshot().cloudState, 'error');
});

test('explicit standing goals assess locally on a heartbeat and waiting never wakes cloud', async t => {
  let assessed = 0, cloud = 0;
  const { agent, inbox } = await fixture(t, { standingGoal: 'Watch for assigned tasks', heartbeatMs: 30, assess: async () => { assessed++; return { action: 'wait', reason: 'Nothing to do' }; }, runCloud: async () => { cloud++; } });
  await agent.start(); await until(() => assessed >= 2); await agent.stop();
  assert.equal(cloud, 0); assert.deepEqual(await inbox.list(), []);
});

test('folder watches create one task for external changes and ignore worker feedback and metadata', async t => {
  let processed = 0;
  const root = await mkdtemp(join(tmpdir(), 'codexcli-always-on-watch-'));
  const cwd = join(root, 'project'); await mkdir(cwd);
  await mkdir(join(cwd, '.git')); await mkdir(join(cwd, 'node_modules'));
  const inbox = await createTaskInbox({ cwd, stateDir: join(cwd, '.sudocli-state') });
  const agent = createAlwaysOn({ inbox, pollMs: 10, idleSleepMs: 40, watchDebounceMs: 25, watchPaths: [cwd], assess: async () => ({ action: 'cloud' }), runCloud: async () => { processed++; await writeFile(join(cwd, 'worker-output.txt'), 'worker feedback'); return 'Done'; } });
  t.after(async () => { await agent.stop(); await rm(root, { recursive: true, force: true }); }); await agent.start();
  await writeFile(join(cwd, '.git', 'ignored'), 'ignore');
  await writeFile(join(cwd, 'node_modules', 'ignored'), 'ignore');
  await writeFile(join(cwd, 'source.txt'), 'External task');
  await until(() => processed === 1);
  await delay(250);
  assert.equal(processed, 1);
  assert.equal((await inbox.list()).length, 1);
});

function interceptedWatches(t,{failAt=Infinity}={}) {
  const streams=[];
  const replacement=t.mock.method(fs,'watch',(root,_options,callback)=>{
    if(streams.length===failAt)throw new Error('Fixture watch installation failed');
    const stream={root,callback,closed:false,close(){this.closed=true;},on(){return this;}};
    streams.push(stream);return stream;
  });
  syncBuiltinESMExports();
  return {streams,restore(){replacement.mock.restore();syncBuiltinESMExports();}};
}

test('closed task watch streams reject delayed own writes while a fresh stream admits later external edits',async t=>{
  const watches=interceptedWatches(t);let processed=0;
  const {agent,inbox,cwd}=await fixture(t,{watchPaths:['.'],watchDebounceMs:10,assess:async()=>({action:'cloud'}),runCloud:async()=>{processed++;await writeFile(join(cwd,'worker-output.txt'),'worker feedback');return 'Done';}});
  t.after(()=>watches.restore());await agent.start();const first=watches.streams[0];
  await writeFile(join(cwd,'source.txt'),'external first edit');first.callback('change','source.txt');
  await until(()=>processed===1&&agent.snapshot().state==='idle');await delay(60);
  first.callback('change','worker-output.txt');await delay(60);
  assert.equal(processed,1,'a delayed unchanged task-owned write cannot enqueue more model work');
  assert.equal(first.closed,true);assert.equal(watches.streams.length,2);
  assert.equal((await inbox.list()).length,1);assert.equal((await inbox.list())[0].status,'completed');
  const fresh=watches.streams[1];
  fresh.callback('change','worker-output.txt');await delay(150);
  assert.equal((await inbox.list()).length,1,'unchanged own writes replayed through the fresh stream remain suppressed');
  await writeFile(join(cwd,'worker-output.txt'),'later external edit');fresh.callback('change','worker-output.txt');
  await until(()=>processed===2&&agent.snapshot().state==='idle');
  assert.equal((await inbox.list()).length,2,'a later external edit of the same path is accepted');
  await agent.stop();assert.ok(watches.streams.every(stream=>stream.closed));
});

test('unchanged startup events and duplicate current versions do not admit extra watch tasks',async t=>{
  const watches=interceptedWatches(t);let processed=0;
  const {agent,inbox,cwd}=await fixture(t,{watchPaths:['.'],watchDebounceMs:10,assess:async()=>({action:'cloud'}),runCloud:async()=>{processed++;return 'Done';}});
  t.after(()=>watches.restore());await writeFile(join(cwd,'source.txt'),'already present');await agent.start();
  const stream=watches.streams.at(-1);stream.callback('change','source.txt');stream.callback('change','source.txt');await delay(150);
  assert.equal((await inbox.list()).length,0,'a startup replay is unchanged from the initial baseline');
  await writeFile(join(cwd,'source.txt'),'real external edit');stream.callback('change','source.txt');stream.callback('change','source.txt');
  await until(()=>processed===1&&agent.snapshot().state==='idle');await delay(100);
  assert.equal((await inbox.list()).length,1);assert.equal(processed,1);
});

test('later deletion and recreation of the same file are admitted while missing-path replays stay quiet',async t=>{
  const watches=interceptedWatches(t);let processed=0;
  const {agent,inbox,cwd}=await fixture(t,{watchPaths:['.'],watchDebounceMs:10,assess:async()=>({action:'cloud'}),runCloud:async()=>{processed++;return 'Done';}});
  t.after(()=>watches.restore());await writeFile(join(cwd,'source.txt'),'before deletion');await agent.start();
  watches.streams.at(-1).callback('rename','never-present.txt');await delay(100);assert.equal((await inbox.list()).length,0);
  await rm(join(cwd,'source.txt'));watches.streams.at(-1).callback('rename','source.txt');await until(()=>processed===1&&agent.snapshot().state==='idle');
  watches.streams.at(-1).callback('rename','source.txt');await delay(100);assert.equal((await inbox.list()).length,1);
  await writeFile(join(cwd,'source.txt'),'after recreation');watches.streams.at(-1).callback('rename','source.txt');await until(()=>processed===2&&agent.snapshot().state==='idle');
  assert.equal((await inbox.list()).length,2);
});

test('an event pending canonical validation cannot cross the task watch generation',{timeout:5000},async t=>{
  const watches=interceptedWatches(t);let release,entered;
  const waiting=new Promise(resolve=>{release=resolve;}),started=new Promise(resolve=>{entered=resolve;});
  t.after(()=>release());
  const {agent,inbox,cwd}=await fixture(t,{watchPaths:['.'],watchDebounceMs:10,assess:async()=>({action:'local',result:'Done'}),runCloud:async()=>''});
  await agent.start();await writeFile(join(cwd,'source.txt'),'external event before task');
  const original=fs.promises.realpath;
  const replacement=t.mock.method(fs.promises,'realpath',async(...args)=>{if(args[0]===join(cwd,'source.txt')){entered();await waiting;}return original(...args);});
  syncBuiltinESMExports();t.after(()=>{release();replacement.mock.restore();syncBuiltinESMExports();watches.restore();});
  watches.streams[0].callback('change','source.txt');await started;
  await agent.submit('Actual task');await until(()=>agent.snapshot().completed===1&&agent.snapshot().state==='idle');
  await delay(60);release();await delay(120);assert.equal((await inbox.list()).length,1);
  await agent.stop();assert.ok(watches.streams.every(stream=>stream.closed));
});

test('stopping during asynchronous watch validation cannot reinstall a stream',{timeout:5000},async t=>{
  const watches=interceptedWatches(t);let hold=false,release,entered;
  const waiting=new Promise(resolve=>{release=resolve;}),started=new Promise(resolve=>{entered=resolve;});
  t.after(()=>release());
  const {agent,cwd}=await fixture(t,{watchPaths:['.'],assess:async()=>({action:'cloud'}),runCloud:async()=>{hold=true;return 'Done';}});
  await agent.start();const original=fs.promises.realpath;
  const replacement=t.mock.method(fs.promises,'realpath',async(...args)=>{if(hold&&args[0]===cwd){entered();await waiting;}return original(...args);});
  syncBuiltinESMExports();t.after(()=>{release();replacement.mock.restore();syncBuiltinESMExports();watches.restore();});
  await agent.submit('Actual task');await started;
  const stopped=agent.stop();release();await stopped;
  assert.equal(agent.snapshot().state,'stopped');assert.equal(watches.streams.length,1);
  assert.ok(watches.streams.every(stream=>stream.closed));
});

test('changed watch-root validation fails closed without corrupting a completed task',async t=>{
  const watches=interceptedWatches(t),errors=[];
  const {agent,inbox,cwd}=await fixture(t,{watchPaths:['watched'],onError:error=>errors.push(error),assess:async()=>({action:'cloud'}),runCloud:async()=>{await rm(join(cwd,'watched'),{recursive:true,force:true});return 'Done';}});
  await mkdir(join(cwd,'watched'));t.after(()=>watches.restore());await agent.start();
  await agent.submit('Actual task');await until(()=>agent.snapshot().completed===1&&agent.snapshot().state==='idle');
  assert.equal(watches.streams.length,1);assert.equal(watches.streams[0].closed,true);assert.equal(errors.length,1);
  assert.equal((await inbox.list())[0].status,'completed');await agent.stop();
});

test('a partial initial watch installation closes its streams and releases its worker lease',async t=>{
  const watches=interceptedWatches(t,{failAt:1});
  const {agent,inbox,cwd}=await fixture(t,{watchPaths:['one','two'],assess:async()=>({action:'wait'}),runCloud:async()=>''});
  await mkdir(join(cwd,'one'));await mkdir(join(cwd,'two'));t.after(()=>watches.restore());
  await assert.rejects(agent.start(),/Fixture watch installation failed/);
  assert.equal(agent.snapshot().state,'stopped');assert.equal(watches.streams.length,1);assert.equal(watches.streams[0].closed,true);
  const lease=await inbox.acquireWorker();await lease.release();
});

test('a standing-goal heartbeat and its nested cloud task leave one fresh watch stream',async t=>{
  const watches=interceptedWatches(t);let cloud=0;
  const {agent,inbox,cwd}=await fixture(t,{watchPaths:['.'],standingGoal:'Explicit standing goal',heartbeatMs:1000,watchDebounceMs:10,assess:async job=>job.source==='standing-goal'?{action:'cloud'}:{action:'local',result:'External edit assessed'},runCloud:async()=>{cloud++;return 'Done';}});
  t.after(()=>watches.restore());await agent.start();
  await until(()=>agent.snapshot().completed===1&&agent.snapshot().state==='idle');
  assert.equal(cloud,1);assert.equal(watches.streams.length,2);assert.equal(watches.streams.filter(stream=>!stream.closed).length,1);
  await writeFile(join(cwd,'external.txt'),'later external edit');watches.streams.at(-1).callback('change','external.txt');
  await until(()=>agent.snapshot().completed===2&&agent.snapshot().state==='idle');
  assert.equal((await inbox.list()).length,2);assert.equal(watches.streams.filter(stream=>!stream.closed).length,1);
  await agent.stop();assert.ok(watches.streams.every(stream=>stream.closed));
});

test('an eligible-entry cap disables replay admission without changing a completed task',async t=>{
  const watches=interceptedWatches(t),errors=[];
  const {agent,inbox,cwd}=await fixture(t,{watchPaths:['.'],watchEntryLimit:2,onError:error=>errors.push(error.message),assess:async()=>({action:'cloud'}),runCloud:async()=>{await writeFile(join(cwd,'new.txt'),'task-owned');return 'Done';}});
  await writeFile(join(cwd,'existing.txt'),'baseline');t.after(()=>watches.restore());await agent.start();await agent.submit('Actual task');
  await until(()=>agent.snapshot().completed===1&&agent.snapshot().state==='idle');
  assert.equal(errors.length,1);assert.match(errors[0],/fewer eligible entries/);assert.equal(watches.streams.length,1);assert.equal(watches.streams[0].closed,true);
  assert.equal((await inbox.list())[0].status,'completed');watches.streams[0].callback('change','new.txt');await delay(100);assert.equal((await inbox.list()).length,1);
});

test('a baseline scan deadline disables watching, preserves completion, and closes a directory that arrives late',{timeout:5000},async t=>{
  const watches=interceptedWatches(t),errors=[];let hold=false,release,lateClosed=false;
  const gate=new Promise(resolve=>{release=resolve;});t.after(()=>release());
  const {agent,inbox,cwd}=await fixture(t,{watchPaths:['.'],watchScanTimeoutMs:200,onError:error=>errors.push(error.message),assess:async()=>({action:'cloud'}),runCloud:async()=>{hold=true;return 'Done';}});
  await agent.start();const original=fs.promises.opendir;
  const replacement=t.mock.method(fs.promises,'opendir',async(...args)=>{if(hold&&args[0]===cwd){await gate;const directory=await original(...args),close=directory.close.bind(directory);directory.close=async()=>{await close();lateClosed=true;};return directory;}return original(...args);});
  syncBuiltinESMExports();t.after(()=>{release();replacement.mock.restore();syncBuiltinESMExports();watches.restore();});
  await agent.submit('Actual task');await until(()=>errors.length===1&&agent.snapshot().state==='idle');
  assert.match(errors[0],/scan deadline/);assert.equal((await inbox.list())[0].status,'completed');assert.equal(watches.streams.length,1);assert.equal(watches.streams[0].closed,true);
  release();await until(()=>lateClosed);await agent.stop();
});

test('stop aborts a pending baseline scan without waiting for its directory read or installing a new stream',{timeout:5000},async t=>{
  const watches=interceptedWatches(t);let hold=false,release,entered,lateClosed=false;
  const gate=new Promise(resolve=>{release=resolve;}),pending=new Promise(resolve=>{entered=resolve;});t.after(()=>release());
  const {agent,cwd}=await fixture(t,{watchPaths:['.'],assess:async()=>({action:'cloud'}),runCloud:async()=>{hold=true;return 'Done';}});
  await agent.start();const original=fs.promises.opendir;
  const replacement=t.mock.method(fs.promises,'opendir',async(...args)=>{if(hold&&args[0]===cwd){entered();await gate;const directory=await original(...args),close=directory.close.bind(directory);directory.close=async()=>{await close();lateClosed=true;};return directory;}return original(...args);});
  syncBuiltinESMExports();t.after(()=>{release();replacement.mock.restore();syncBuiltinESMExports();watches.restore();});
  await agent.submit('Actual task');await pending;await agent.stop();
  assert.equal(agent.snapshot().state,'stopped');assert.equal(watches.streams.length,1);assert.equal(watches.streams[0].closed,true);
  release();await until(()=>lateClosed);assert.equal(watches.streams.length,1);
});

test('child links are never traversed and a watched-root substitution leaves completed work intact',async t=>{
  const watches=interceptedWatches(t),errors=[];
  const {agent,inbox,cwd,root}=await fixture(t,{watchPaths:['watched'],onError:error=>errors.push(error.message),assess:async()=>({action:'cloud'}),runCloud:async()=>{await rm(join(cwd,'watched'),{recursive:true,force:true});await symlink(join(root,'outside'),join(cwd,'watched'),process.platform==='win32'?'junction':'dir');return 'Done';}});
  const outside=join(root,'outside');await mkdir(outside);await writeFile(join(outside,'private.txt'),'outside fixture');await mkdir(join(cwd,'watched'));
  await symlink(outside,join(cwd,'watched','linked'),process.platform==='win32'?'junction':'dir');
  const original=fs.promises.opendir,opened=[];
  const replacement=t.mock.method(fs.promises,'opendir',(...args)=>{opened.push(args[0]);return original(...args);});syncBuiltinESMExports();
  t.after(()=>{replacement.mock.restore();syncBuiltinESMExports();watches.restore();});await agent.start();
  assert.equal(opened.includes(outside),false);assert.equal(opened.includes(join(cwd,'watched','linked')),false);
  watches.streams.at(-1).callback('change','linked/private.txt');await delay(100);assert.equal((await inbox.list()).length,0);
  await agent.submit('Actual task');await until(()=>agent.snapshot().completed===1&&agent.snapshot().state==='idle');
  assert.equal(errors.length,1);assert.equal((await inbox.list())[0].status,'completed');assert.equal(watches.streams.length,1);assert.equal(watches.streams[0].closed,true);
});

test('watch admission bounds canonical reads before any path validation and fails closed on a burst',{timeout:5000},async t=>{
  const watches=interceptedWatches(t),errors=[];let release,pending=0,maximum=0;
  const gate=new Promise(resolve=>{release=resolve;});t.after(()=>release());
  const {agent,inbox,cwd}=await fixture(t,{watchPaths:['.'],onError:error=>errors.push(error.message),assess:async()=>({action:'cloud'}),runCloud:async()=> 'Done'});
  await agent.start();const original=fs.promises.realpath;
  const replacement=t.mock.method(fs.promises,'realpath',async(...args)=>{if(args[0].startsWith(join(cwd,'burst-'))){pending++;maximum=Math.max(maximum,pending);try{await gate;return await original(...args);}finally{pending--;}}return original(...args);});
  syncBuiltinESMExports();t.after(()=>{release();replacement.mock.restore();syncBuiltinESMExports();watches.restore();});
  const stream=watches.streams.at(-1);for(let index=0;index<99;index++)stream.callback('change',`burst-${index}.txt`);await until(()=>pending===99);
  for(let index=99;index<500;index++)stream.callback('change',`burst-${index}.txt`);await delay(30);
  assert.ok(maximum<=100,`actual pending canonical reads reached ${maximum}`);assert.equal(errors.length,1);assert.equal(stream.closed,true);assert.equal((await inbox.list()).length,0);
  release();await until(()=>pending===0);await agent.stop();
});

test('same-path bursts share one pending validation and a later edit is re-read before task admission',{timeout:5000},async t=>{
  const watches=interceptedWatches(t),observed=[];let release,pending=0,maximum=0,reads=0;
  const gate=new Promise(resolve=>{release=resolve;});t.after(()=>release());
  const {agent,inbox,cwd}=await fixture(t,{watchPaths:['.'],watchDebounceMs:10,assess:async()=>({action:'cloud'}),runCloud:async()=>{observed.push(await readFile(join(cwd,'source.txt'),'utf8'));return 'Done';}});
  await writeFile(join(cwd,'source.txt'),'initial');await agent.start();const original=fs.promises.lstat;
  const replacement=t.mock.method(fs.promises,'lstat',async(...args)=>{if(args[0]===join(cwd,'source.txt')){const index=++reads;pending++;maximum=Math.max(maximum,pending);try{const value=await original(...args);if(index===1)await gate;return value;}finally{pending--;}}return original(...args);});
  syncBuiltinESMExports();t.after(()=>{release();replacement.mock.restore();syncBuiltinESMExports();watches.restore();});
  const stream=watches.streams.at(-1);await writeFile(join(cwd,'source.txt'),'earlier edit');stream.callback('change','source.txt');await until(()=>pending===1);
  await writeFile(join(cwd,'source.txt'),'latest genuine edit');for(let index=0;index<500;index++)stream.callback('change','source.txt');await delay(30);
  assert.equal(maximum,1,'repeated callbacks cannot start parallel version reads');release();
  await until(()=>agent.snapshot().completed===1&&agent.snapshot().state==='idle');
  assert.ok(reads>=2,'the dirty pending version is checked again');assert.deepEqual(observed,['latest genuine edit']);assert.equal((await inbox.list()).length,1);
  watches.streams.at(-1).callback('change','source.txt');await delay(100);assert.equal((await inbox.list()).length,1);
});

test('physical watch reads remain bounded across suspension, reinstallation and stop',{timeout:5000},async t=>{
  const watches=interceptedWatches(t),errors=[];let release,pending=0,maximum=0;
  const gate=new Promise(resolve=>{release=resolve;});t.after(()=>release());
  const {agent,inbox,cwd}=await fixture(t,{watchPaths:['.'],onError:error=>errors.push(error.message),assess:async()=>({action:'cloud'}),runCloud:async()=> 'Done'});
  await agent.start();const original=fs.promises.realpath;
  const replacement=t.mock.method(fs.promises,'realpath',async(...args)=>{if(args[0].startsWith(join(cwd,'burst-'))){pending++;maximum=Math.max(maximum,pending);try{await gate;return await original(...args);}finally{pending--;}}return original(...args);});
  syncBuiltinESMExports();t.after(()=>{release();replacement.mock.restore();syncBuiltinESMExports();watches.restore();});
  const prior=watches.streams.at(-1);for(let index=0;index<99;index++)prior.callback('change',`burst-${index}.txt`);await until(()=>pending===99);
  await agent.submit('Actual inbox task');await until(()=>agent.snapshot().completed===1&&agent.snapshot().state==='idle');
  assert.equal(prior.closed,true);assert.equal(pending,99);assert.equal(errors.length,0);
  const fresh=watches.streams.at(-1);assert.notEqual(fresh,prior);fresh.callback('change','burst-new.txt');await until(()=>pending===100);
  fresh.callback('change','burst-overflow.txt');await until(()=>errors.length===1);
  assert.equal(maximum,100);assert.equal(fresh.closed,true);assert.equal((await inbox.list())[0].status,'completed');
  await agent.stop();assert.equal(agent.snapshot().state,'stopped');assert.equal(pending,100);
  release();await until(()=>pending===0);assert.equal((await inbox.list()).length,1);
});

test('outside-project watch paths are rejected before starting a worker', async t => {
  const { root, agent } = await fixture(t, { assess: async () => ({ action: 'wait' }), runCloud: async () => '', watchPaths: [tmpdir()] });
  await assert.rejects(agent.start(), /project|watch/i);
  assert.equal(agent.snapshot().state, 'stopped');
});

test('permissions requiring human approval block cloud jobs instead of granting permissions or retrying', async t => {
  let runs = 0;
  const { agent, inbox } = await fixture(t, { assess: async () => ({ action: 'cloud' }), runCloud: async () => { runs++; const error = new Error('Human approval is required'); error.code = 'APPROVAL_REQUIRED'; throw error; } });
  await agent.start(); const job = await agent.submit({ prompt: 'Privileged action' });
  await until(async () => (await inbox.get(job.id)).status === 'blocked');
  await delay(70);
  assert.equal(runs, 1); assert.match((await inbox.get(job.id)).reason, /approval/i);
});

test('cloud failures are durable failed tasks and never retry by themselves', async t => {
  let runs = 0;
  const { agent, inbox } = await fixture(t, { assess: async () => ({ action: 'cloud' }), runCloud: async () => { runs++; throw new Error('Backend unavailable'); } });
  await agent.start(); const job = await agent.submit({ prompt: 'Task' });
  await until(async () => (await inbox.get(job.id)).status === 'failed');
  await delay(70);
  assert.equal(runs, 1); assert.match((await inbox.get(job.id)).reason, /Backend unavailable/);
});

test('standing goal does not repeatedly schedule the same cloud task without a fresh local decision', async t => {
  let runs = 0;
  const { agent, inbox } = await fixture(t, { standingGoal: 'Watch for jobs', heartbeatMs: 35, assess: async () => ({ action: 'cloud', prompt: 'Same assigned task' }), runCloud: async () => { runs++; return 'Done'; } });
  await agent.start(); await until(() => runs === 1); await delay(160);
  assert.equal(runs, 1); assert.equal((await inbox.list()).length, 1);
});

test('a local completion decision requires a nonempty result instead of silently claiming success', async t => {
  const { agent, inbox } = await fixture(t, { assess: async () => ({ action: 'local', reason: 'Looks easy' }), runCloud: async () => assert.fail('Invalid local decision must never invoke cloud') });
  await agent.start(); const job = await agent.submit({ prompt: 'Task' });
  await until(async () => (await inbox.get(job.id)).status === 'blocked');
  assert.match((await inbox.get(job.id)).reason, /invalid decision/i);
});

test('GPU acknowledgements leave coordinator power and billing unknown while verified status is displayed', async t => {
  const { agent, inbox } = await fixture(t, { assess: async () => ({ action: 'cloud' }), wake: async () => ({ ok: true }), sleep: async () => ({ ok: true }), runCloud: async () => 'Done' });
  await agent.start(); const job = await agent.submit('Work');
  await until(async () => (await inbox.get(job.id)).status === 'completed');
  assert.equal(agent.snapshot().cloudState, 'unknown');
  assert.equal(agent.snapshot().cloudBilling, 'unknown');
  const verified = await fixture(t, { assess: async () => ({ action: 'cloud' }), wake: async () => ({ verified: true, state: 'running', billing: 'active' }), sleep: async () => ({ verified: true, state: 'stopped', billing: 'storage-only' }), runCloud: async () => 'Done' });
  await verified.agent.start(); const other = await verified.agent.submit('Work');
  await until(async () => (await verified.inbox.get(other.id)).status === 'completed');
  await until(() => verified.agent.snapshot().cloudState === 'asleep');
  assert.equal(verified.agent.snapshot().cloudBilling, 'storage-only');
});

test('coordinator closes task budget lifecycle after a provider failure', async t => {
  const lifecycle = [];
  const { agent, inbox } = await fixture(t, { assess: async () => ({ action: 'cloud' }), runCloud: async () => { throw new Error('Provider failed'); }, beginTask: async id => lifecycle.push(`begin:${id}`), endTask: async id => lifecycle.push(`end:${id}`) });
  await agent.start(); const job = await agent.submit('Work');
  await until(async () => (await inbox.get(job.id)).status === 'failed');
  await until(() => lifecycle.length === 2);
  assert.deepEqual(lifecycle, [`begin:${job.id}`, `end:${job.id}`]);
});

test('coordinator ticks durable schedules without idle model requests', async t => {
  let assessments = 0;
  const { agent, inbox } = await fixture(t, { assess: async () => { assessments++; return { action: 'local', result: 'Scheduled task completed' }; }, runCloud: async () => assert.fail('Local scheduled work should not use cloud') });
  const { createScheduler } = await import('../src/scheduler.mjs');
  const scheduler = await createScheduler({ inbox });
  const scheduled = createAlwaysOn({ inbox, scheduler, pollMs: 10, idleSleepMs: 40, assess: async () => { assessments++; return { action: 'local', result: 'Scheduled task completed' }; }, runCloud: async () => assert.fail('Cloud should remain idle') });
  // Stop this additional worker before the fixture removes its inbox. Registered
  // after-hooks run in order, so a later stop hook races earlier directory cleanup.
  try {
    await scheduler.add({ id: 'scheduled-proof', prompt: 'Explicit local work', at: Date.now() + 40 });
    await scheduled.start();
    await until(async () => (await inbox.list())[0]?.status === 'completed');
    await delay(50); assert.equal(assessments, 1);
  } finally { await scheduled.stop(); }
});

test('stop between durable running status and dispatch prevents an already cancelled cloud call', async t => {
  let calls = 0, stopping;
  const { agent, inbox } = await fixture(t, { assess: async () => ({ action: 'cloud' }), runCloud: async () => { calls++; return 'Unexpected dispatch'; } });
  const update = inbox.update;
  inbox.update = async (id, patch) => { const result = await update(id, patch); if (patch.status === 'running') stopping = agent.stop(); return result; };
  await agent.start(); const job = await agent.submit('Work');
  await until(() => stopping !== undefined); await stopping;
  assert.equal(calls, 0);
  assert.equal((await inbox.get(job.id)).status, 'blocked');
});

test('whole task duration budget interrupts native work between provider requests', { timeout: 3000 }, async t => {
  const { agent, inbox } = await fixture(t, { beginTask: async () => ({ timeoutMs: 100 }), endTask: async () => {}, assess: async () => ({ action: 'cloud' }), runCloud: async (_job, { signal }) => new Promise((resolve, reject) => { if (signal.aborted) reject(signal.reason); else signal.addEventListener('abort', () => reject(signal.reason), { once: true }); }) });
  await agent.start(); const job = await agent.submit('Bounded native work');
  await until(async () => (await inbox.get(job.id)).status === 'blocked', 1500);
  await until(() => agent.snapshot().state === 'idle');
  assert.match((await inbox.get(job.id)).reason, /duration|budget/i);
});
test('durable background completion waits for acceptance and records its failure',async t=>{
  let checking=false,release;
  const gate=new Promise(resolve=>{release=resolve;});
  t.after(()=>release());
  const {agent,inbox}=await fixture(t,{assess:async()=>({action:'local',result:'Model claims success.'}),runCloud:async()=>assert.fail('Local completion should not call cloud'),onTaskResult:async(_job,patch)=>{checking=true;await gate;return {...patch,status:'failed',reason:'Selected acceptance check failed.'};}});
  try{
    await agent.start();const job=await agent.submit('Check the actual work');
    await until(()=>checking);assert.notEqual((await inbox.get(job.id)).status,'completed');
    release();await until(async()=>(await inbox.get(job.id)).status==='failed');
    assert.equal(agent.snapshot().completed,0);assert.match((await inbox.get(job.id)).reason,/acceptance check failed/);
  }finally{release();}
});

test('cancelled and timed out wake operations emit only their terminal attention sound',async t=>{
  const {createBackgroundResultReporter,backgroundNotificationEvent}=await import('../src/assistant-features.mjs');
  for(const mode of ['stop','timeout'])await t.test(mode,async t=>{
    let agent,waking=false,cloudCalls=0;const tones=[],outcomes=[],errors=[];
    const reporter=createBackgroundResultReporter({work:{result:async(_job,patch)=>patch},onAttention:outcome=>tones.push(backgroundNotificationEvent(outcome)),onResult:outcome=>{outcomes.push(outcome);if(!outcome.notificationSuppressed)tones.push(backgroundNotificationEvent(outcome));}});
    const created=await fixture(t,{beginTask:id=>{reporter.begin(id);return mode==='timeout'?{timeoutMs:500}:{};},onTaskResult:reporter.result,
      onError:error=>{errors.push(error);void reporter.error(error,agent.snapshot().activeJobId);},assess:async()=>({action:'cloud'}),
      wake:async({signal})=>new Promise((resolve,reject)=>{waking=true;if(signal.aborted)reject(signal.reason);else signal.addEventListener('abort',()=>reject(signal.reason),{once:true});}),
      runCloud:async()=>{cloudCalls++;assert.fail('Cancelled wake must never dispatch cloud work.');}});
    agent=created.agent;await agent.start();const job=await agent.submit('Explicit wake fixture');await until(()=>waking);
    if(mode==='stop')await agent.stop();else await until(async()=>(await created.inbox.get(job.id)).status==='blocked');
    const result=await created.inbox.get(job.id);
    assert.equal(result.status,'blocked');assert.equal(cloudCalls,0);assert.deepEqual(errors,[]);
    assert.deepEqual(tones,[mode==='stop'?'interrupted':'error']);assert.equal(outcomes.length,1);assert.equal(outcomes[0].notificationSuppressed,false);
    assert.match(result.reason,mode==='stop'?/Stopped before/:/duration budget/);
  });
});

test('unverified cleanup outranks stop and duration aborts, releases the lease and preserves pending work',{timeout:20000},async t=>{
  for(const code of ['ENGINE_CLEANUP_UNVERIFIED','SESSION_CLEANUP_FAILED'])for(const stage of ['assess','wake','worker'])for(const mode of ['stop','duration'])await t.test(`${code} ${stage} ${mode}`,async t=>{
    const watches=interceptedWatches(t),errors=[],outcomes=[];let reached,dispatches=0,releases=0,ended=0,schedulerTicks=0,firstId,wakeFailed=false;
    const ready=new Promise(resolve=>reached=resolve),secret='synthetic-cleanup-cause-secret';
    const failAfterAbort=signal=>new Promise((resolve,reject)=>{const fail=()=>reject(Object.assign(new Error('Native session cleanup needs review.'),{code,cause:new Error(`Safe primary failure ${secret}`)}));reached();if(signal.aborted)fail();else signal.addEventListener('abort',fail,{once:true});});
    const created=await fixture(t,{inboxSecrets:()=>[secret],watchPaths:['.'],idleSleepMs:10000,scheduler:{tick:async()=>{schedulerTicks++;}},beginTask:async()=>mode==='duration'?{timeoutMs:200}:{},endTask:async()=>{ended++;},
      onError:error=>errors.push(error),onTaskResult:async(job,patch)=>{outcomes.push({id:job.id,status:patch.status});return patch;},
      assess:async(job,{signal})=>job.id===firstId&&stage==='assess'?failAfterAbort(signal):{action:'cloud'},
      wake:async({signal})=>{if(stage==='wake'&&!wakeFailed){wakeFailed=true;return failAfterAbort(signal);}},
      runCloud:async(job,{signal})=>{dispatches++;if(job.id===firstId&&stage==='worker')return failAfterAbort(signal);return 'Explicit later task completed';}});
    t.after(()=>watches.restore());
    const originalAcquire=created.inbox.acquireWorker;created.inbox.acquireWorker=async()=>{const lease=await originalAcquire();return{release:async()=>{releases++;await lease.release();}};};
    const first=await created.inbox.submit({prompt:'First explicit task'});firstId=first.id;await delay(10);const pending=await created.inbox.submit({prompt:'Pending explicit task'});
    await created.agent.start();await ready;
    if(mode==='stop')await created.agent.stop();else await until(async()=>['failed','blocked'].includes((await created.inbox.get(first.id)).status));
    const record=await created.inbox.get(first.id);assert.equal(record.status,'failed');assert.match(record.reason,/cleanup needs review/);assert.doesNotMatch(record.reason,/stopped|duration budget/i);
    await until(()=>created.agent.snapshot().state==='stopped');assert.equal(releases,1);assert.equal(ended,1);
    assert.equal((await created.inbox.get(pending.id)).status,'pending');assert.equal(errors.length,1);assert.equal(errors[0].code,code);assert.match(errors[0].cause.message,/Safe primary failure/);assert.equal(errors[0].cause.message.includes(secret),false);
    assert.deepEqual(outcomes,[{id:first.id,status:'failed'}]);assert.ok(watches.streams.every(stream=>stream.closed));const ticks=schedulerTicks,streams=watches.streams.length;
    await writeFile(join(created.cwd,'later.txt'),'Later external edit');watches.streams[0].callback('change','later.txt');await delay(40);
    assert.equal(schedulerTicks,ticks);assert.equal(watches.streams.length,streams);assert.equal((await created.inbox.list()).length,2);
    // The real durable lease is released, but only explicit restart admits
    // pending work. The failed task remains failed and is never retried.
    const otherLease=await originalAcquire();await otherLease.release();
    await created.agent.start();await until(async()=>(await created.inbox.get(pending.id)).status==='completed');assert.equal((await created.inbox.get(first.id)).status,'failed');
  });
});

test('heartbeat cleanup attention survives cancellation and duration limits without scheduling new work',{timeout:10000},async t=>{
  for(const code of ['ENGINE_CLEANUP_UNVERIFIED','SESSION_CLEANUP_FAILED'])for(const mode of ['stop','duration'])await t.test(`${code} ${mode}`,async t=>{
    const errors=[];let reached,assessments=0,releases=0;const ready=new Promise(resolve=>reached=resolve);
    const created=await fixture(t,{standingGoal:'Explicit standing goal',heartbeatMs:10,beginTask:async()=>mode==='duration'?{timeoutMs:100}:{},assess:async(_job,{signal})=>{assessments++;return new Promise((resolve,reject)=>{const fail=()=>reject(Object.assign(new Error('Heartbeat session cleanup needs review.'),{code}));reached();if(signal.aborted)fail();else signal.addEventListener('abort',fail,{once:true});});},runCloud:async()=>assert.fail('Unverified heartbeat cannot launch cloud work.'),onError:error=>errors.push(error)});
    const originalAcquire=created.inbox.acquireWorker;created.inbox.acquireWorker=async()=>{const lease=await originalAcquire();return{release:async()=>{releases++;await lease.release();}};};
    await created.agent.start();await ready;if(mode==='stop')await created.agent.stop();else await until(()=>errors.length>0);
    assert.equal(errors.length,1);assert.equal(errors[0].code,code);await until(()=>created.agent.snapshot().state==='stopped');assert.equal(releases,1);assert.ok(created.agent.snapshot().lastError);
    await delay(40);assert.equal(assessments,1);assert.deepEqual(await created.inbox.list(),[]);
  });
});

test('cancelled sleep cleanup is reported once and never retried during stop',async t=>{
  for(const code of ['ENGINE_CLEANUP_UNVERIFIED','SESSION_CLEANUP_FAILED'])await t.test(code,async t=>{
    let reached,sleepCalls=0;const ready=new Promise(resolve=>reached=resolve),errors=[];
    const {agent}=await fixture(t,{idleSleepMs:1,assess:async()=>({action:'wait'}),runCloud:async()=>assert.fail('Idle cleanup cannot launch work.'),onError:error=>errors.push(error),sleep:async({signal})=>{sleepCalls++;return new Promise((resolve,reject)=>{reached();const fail=()=>reject(Object.assign(new Error('Sleep session cleanup needs review.'),{code}));if(signal.aborted)fail();else signal.addEventListener('abort',fail,{once:true});});}});
    await agent.start();await ready;await agent.stop();assert.equal(agent.snapshot().state,'stopped');assert.equal(errors.length,1);assert.equal(errors[0].code,code);assert.equal(sleepCalls,1);
  });
});

test('cleanup stop publishes a restartable state only after its own teardown is finished',{timeout:5000},async t=>{
  let agent,firstId,reached,restart,allowRestart=false;const ready=new Promise(resolve=>reached=resolve);
  const created=await fixture(t,{assess:async()=>({action:'cloud'}),runCloud:async(job,{signal})=>job.id===firstId?new Promise((resolve,reject)=>{reached();signal.addEventListener('abort',()=>reject(Object.assign(new Error('Native cleanup needs review.'),{code:'ENGINE_CLEANUP_UNVERIFIED'})),{once:true});}):'Explicit restart completed',onState:snapshot=>{if(allowRestart&&snapshot.state==='stopped'&&!restart)restart=agent.start();}});
  agent=created.agent;const first=await agent.submit('First task');firstId=first.id;await delay(10);const pending=await agent.submit('Pending task');await agent.start();await ready;
  allowRestart=true;await agent.stop();assert.ok(restart);await restart;
  await until(async()=>(await created.inbox.get(pending.id)).status==='completed');assert.equal((await created.inbox.get(first.id)).status,'failed');
  allowRestart=false;
});
