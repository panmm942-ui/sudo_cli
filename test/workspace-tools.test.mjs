import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile, rm, readdir, symlink } from 'node:fs/promises';
import { tmpdir } from './fixtures/temp-root.mjs';
import { join } from 'node:path';
import {createRequire,syncBuiltinESMExports} from 'node:module';
import {execFile} from 'node:child_process';
import {isolatedEnvironment} from '../src/permission-scope.mjs';

async function stillRunning(pid) {
  if (process.platform === 'linux') {
    try { const stat = await readFile(`/proc/${pid}/stat`, 'utf8'); return !['Z','X'].includes(stat.slice(stat.lastIndexOf(')') + 2).split(' ')[0]); }
    catch (error) { if (error.code === 'ENOENT') return false; throw error; }
  }
  if(process.platform==='darwin'){
    const state=await new Promise((success,failure)=>execFile('/bin/ps',['-p',String(pid),'-o','stat='],{shell:false,encoding:'utf8',timeout:1000,maxBuffer:4096,env:isolatedEnvironment(process.env,{LC_ALL:'C'})},(error,stdout)=>{
      if(error&&!(error.code===1&&!stdout.trim()))failure(error);else success(stdout.trim());
    }));
    if(!state)return false;
    assert.match(state,/^[A-Za-z+<>]+$/,'The owned descendant must have a readable process state');
    return state[0]!=='Z';
  }
  try { process.kill(pid, 0); return true; } catch (error) { if (error.code === 'ESRCH') return false; throw error; }
}

async function waitUntilStopped(pid, timeoutMs = 1000) {
  const deadline = performance.now() + timeoutMs;
  while (await stillRunning(pid)) {
    if (performance.now() >= deadline) return false;
    await new Promise(resolve => setTimeout(resolve, 20));
  }
  return true;
}

async function fixture(t, options = {}) {
  const root = await mkdtemp(join(tmpdir(), 'codexcli-workspace-test-'));
  const cwd = join(root, 'project'); await mkdir(cwd);
  t.after(() => rm(root, { recursive: true, force: true }));
  const { createWorkspaceTools } = await import('../src/workspace-tools.mjs');
  return { root, cwd, stateDir: join(root, 'state'), workspace: await createWorkspaceTools({ cwd, stateDir: join(root, 'state'), ...options }) };
}

test('checkpoint survives reopening and undo restores changed/deleted files and removes only recorded new files', async t => {
  const { cwd, stateDir, workspace } = await fixture(t);
  await writeFile(join(cwd, 'changed.txt'), 'before\n');
  await writeFile(join(cwd, 'deleted.txt'), 'keep\n');
  const { id } = await workspace.beginCheckpoint('task');
  await writeFile(join(cwd, 'changed.txt'), 'after\n');
  await rm(join(cwd, 'deleted.txt'));
  await writeFile(join(cwd, 'new.txt'), 'new\n');
  await workspace.completeCheckpoint(id);
  const { createWorkspaceTools } = await import('../src/workspace-tools.mjs');
  const reopened = await createWorkspaceTools({ cwd, stateDir });
  assert.equal((await reopened.listCheckpoints())[0].id, id);
  const changes = await reopened.reviewCheckpoint(id);
  assert.deepEqual(changes.changes.map(item => [item.path, item.kind]), [['changed.txt', 'modified'], ['deleted.txt', 'deleted'], ['new.txt', 'added']]);
  assert.match(changes.diff, /before/);
  assert.match(changes.diff, /after/);
  const result = await reopened.undoCheckpoint(id);
  assert.equal(result.conflicts.length, 0);
  assert.equal(await readFile(join(cwd, 'changed.txt'), 'utf8'), 'before\n');
  assert.equal(await readFile(join(cwd, 'deleted.txt'), 'utf8'), 'keep\n');
  assert.deepEqual((await readdir(cwd)).sort(), ['changed.txt', 'deleted.txt']);
});

test('undo preserves intervening human edits and human-created replacements', async t => {
  const { cwd, workspace } = await fixture(t);
  await writeFile(join(cwd, 'one.txt'), 'before'); await writeFile(join(cwd, 'two.txt'), 'before');
  const { id } = await workspace.beginCheckpoint();
  await writeFile(join(cwd, 'one.txt'), 'AI'); await rm(join(cwd, 'two.txt'));
  await workspace.completeCheckpoint(id);
  await writeFile(join(cwd, 'one.txt'), 'human'); await writeFile(join(cwd, 'two.txt'), 'replacement');
  const undone = await workspace.undoCheckpoint(id);
  assert.deepEqual(undone.conflicts.map(item => item.path), ['one.txt', 'two.txt']);
  assert.equal(await readFile(join(cwd, 'one.txt'), 'utf8'), 'human');
  assert.equal(await readFile(join(cwd, 'two.txt'), 'utf8'), 'replacement');
});

test('checkpoints exclude selected state inside the project, secrets and runtime folders', async t => {
  const { root, cwd } = await fixture(t);
  for (const folder of ['runtime', '.git', 'secrets']) { await mkdir(join(cwd, folder)); await writeFile(join(cwd, folder, 'x.txt'), 'private'); }
  await writeFile(join(cwd, '.env'), 'API_KEY=private'); await writeFile(join(cwd, 'key.pem'), 'private');
  const { createWorkspaceTools } = await import('../src/workspace-tools.mjs');
  const workspace = await createWorkspaceTools({ cwd, stateDir: join(cwd, 'custom-state') });
  const { id } = await workspace.beginCheckpoint(); await writeFile(join(cwd, 'good.txt'), 'ok'); await workspace.completeCheckpoint(id);
  assert.deepEqual((await workspace.reviewCheckpoint(id)).changes.map(item => item.path), ['good.txt']);
  assert.ok(root);
});

test('checkpoint bounds and redacted diff report skipped oversized files without storing them', async t => {
  const { cwd, workspace } = await fixture(t, { maxFileBytes: 128, secrets: () => ['synthetic-private-token'] });
  await writeFile(join(cwd, 'big.txt'), 'x'.repeat(129));
  await writeFile(join(cwd, 'code.js'), 'let value=1;');
  const { id } = await workspace.beginCheckpoint();
  await writeFile(join(cwd, 'code.js'), 'let value="synthetic-private-token";'); await workspace.completeCheckpoint(id);
  const result = await workspace.reviewCheckpoint(id);
  assert.equal(result.partial, true);
  assert.ok(result.skipped.some(item => item.path === 'big.txt'));
  assert.ok(!result.diff.includes('synthetic-private-token'));
});

test('symlink entries cannot be checkpointed or restored over a replaced parent directory', async t => {
  const { root, cwd, workspace } = await fixture(t);
  await mkdir(join(cwd, 'nested')); await writeFile(join(cwd, 'nested', 'file.txt'), 'before');
  await mkdir(join(root, 'outside')); await writeFile(join(root, 'outside', 'file.txt'), 'outside');
  const { id } = await workspace.beginCheckpoint(); await writeFile(join(cwd, 'nested', 'file.txt'), 'after'); await workspace.completeCheckpoint(id);
  await rm(join(cwd, 'nested'), { recursive: true });
  try { await symlink(join(root, 'outside'), join(cwd, 'nested'), process.platform === 'win32' ? 'junction' : 'dir'); }
  catch (error) { if (error.code === 'EPERM') { t.skip('Symbolic links require host support'); return; } throw error; }
  const result = await workspace.undoCheckpoint(id);
  assert.equal(result.conflicts[0].path, 'nested/file.txt');
  assert.equal(await readFile(join(root, 'outside', 'file.txt'), 'utf8'), 'outside');
});

test('explicit real checks record stdout stderr and failed exit without trusting completion text', async t => {
  const { workspace } = await fixture(t);
  const result = await workspace.acceptWork({ checks: [{ command: process.execPath, args: ['-e', 'console.log("verified by model"); console.error("failure");process.exit(7)'] }] });
  assert.equal(result.status, 'Failed'); assert.equal(result.verified, false);
  assert.equal(result.checks[0].exitCode, 7); assert.match(result.checks[0].stdout, /verified by model/); assert.match(result.checks[0].stderr, /failure/);
  assert.equal((await workspace.acceptWork({ checks: [] })).status, 'Needs review');
  assert.equal((await workspace.acceptWork({ checks: [{ command: process.execPath, args: ['-e', 'console.log("actual check")'] }] })).status, 'Verified');
});

test('checks bound duration output and cancellation and never call shell for argv checks', async t => {
  const { cwd, workspace } = await fixture(t);
  const timed = await workspace.runChecks([{ command: process.execPath, args: ['-e', 'setInterval(()=>{},1000)'] }], { timeoutMs: 80 });
  assert.equal(timed[0].status, 'timed-out');
  const limited = await workspace.runChecks([{ command: process.execPath, args: ['-e', 'process.stdout.write("x".repeat(20000))'] }], { maxOutputBytes: 1024 });
  assert.equal(limited[0].status, 'output-limit'); assert.ok(Buffer.byteLength(limited[0].stdout) <= 1024);
  const controller = new AbortController(); const timer = setTimeout(() => controller.abort(), 80); t.after(() => clearTimeout(timer));
  const cancelled = await workspace.runChecks([{ command: process.execPath, args: ['-e', 'setInterval(()=>{},1000)'] }], { signal: controller.signal });
  assert.equal(cancelled[0].status, 'cancelled');
  const literal = await workspace.runChecks([{ command: process.execPath, args: ['-e', 'console.log(process.argv[1])', 'literal; touch dangerous'] }]);
  assert.match(literal[0].stdout, /literal; touch dangerous/); assert.deepEqual(await readdir(cwd), []);
});

test('explicit shellCommand checks execute the selected text and invalid requests fail before spawning', async t => {
  const { workspace } = await fixture(t);
  const command = process.platform === 'win32' ? 'Write-Output "literal-check"' : 'printf "literal-check"';
  assert.equal((await workspace.runChecks([{ shellCommand: command }]))[0].status, 'passed');
  await assert.rejects(workspace.runChecks([{ command: process.execPath, args: [], shellCommand: command }]), /check/i);
  await assert.rejects(workspace.runChecks(new Array(17).fill({ command: process.execPath, args: [] })), /check/i);
});

test('isolated source snapshots exclude private files and clean only owned copies', async t => {
  const { root, cwd } = await fixture(t);
  await mkdir(join(cwd, 'src')); await writeFile(join(cwd, 'src', 'file.mjs'), 'export const value=1;'); await writeFile(join(cwd, '.env'), 'private');
  const { createWorkspaceSnapshot } = await import('../src/workspace-tools.mjs');
  const snapshot = await createWorkspaceSnapshot({ cwd, baseDir: join(root, 'copies') });
  assert.notEqual(snapshot.cwd, cwd); assert.equal(snapshot.files.length, 1); assert.equal(await readFile(join(snapshot.cwd, 'src', 'file.mjs'), 'utf8'), 'export const value=1;');
  await snapshot.cleanup(); assert.deepEqual(await readdir(join(root, 'copies')), []); assert.equal(await readFile(join(cwd, '.env'), 'utf8'), 'private');
});

test('timeout terminates a selected check subprocess tree including descendants holding output pipes', { timeout: 5000 }, async t => {
  const { workspace } = await fixture(t);
  const script = 'const {spawn}=require("node:child_process");const c=spawn(process.execPath,["-e","setInterval(()=>{},1000)"],{stdio:["ignore","inherit","inherit"]});console.log(c.pid);setInterval(()=>{},1000)';
  const result = await workspace.runChecks([{ command: process.execPath, args: ['-e', script] }], { timeoutMs: 200 });
  assert.equal(result[0].status, 'timed-out');
  const pid = Number(result[0].stdout.trim()); assert.ok(pid > 0); assert.equal(await waitUntilStopped(pid), true);
});

for (const reason of ['timed-out','cancelled']) test(`${reason} checks stop a SIGTERM-ignoring owned descendant even after it closes captured output`, { skip: process.platform === 'win32', timeout: 5000 }, async t => {
  const { workspace } = await fixture(t);
  let pid;
  t.after(async () => { if (pid > 0 && await stillRunning(pid)) try { process.kill(pid, 'SIGKILL'); } catch (error) { if (error.code !== 'ESRCH') throw error; } });
  const descendant = 'process.on("SIGTERM",()=>{});process.send("ready");process.disconnect();setInterval(()=>{},1000)';
  const script = `const {spawn}=require("node:child_process");const c=spawn(process.execPath,["-e",${JSON.stringify(descendant)}],{stdio:["ignore","ignore","ignore","ipc"]});c.once("message",()=>console.log(c.pid));setInterval(()=>{},1000)`;
  const controller = new AbortController();
  const timer = reason === 'cancelled' ? setTimeout(() => controller.abort(), 1000) : undefined;
  t.after(() => clearTimeout(timer));
  const [result] = await workspace.runChecks([{ command: process.execPath, args: ['-e', script] }], { timeoutMs: reason === 'timed-out' ? 1000 : 4000, signal: controller.signal });
  assert.equal(result.status, reason);
  pid = Number(result.stdout.trim()); assert.ok(pid > 0, 'The owned descendant must report readiness before the timeout');
  assert.equal(await stillRunning(pid), false, 'runChecks must finish terminating the owned process group before returning');
});

for (const observation of ['zombie','live','invalid','unavailable']) test(`Darwin group EPERM requires bounded ${observation} process-state evidence before cancellation is accepted`,{skip:process.platform==='win32',timeout:5000},async t=>{
  const {workspace}=await fixture(t),childProcess=createRequire(import.meta.url)('node:child_process');
  const platform=Object.getOwnPropertyDescriptor(process,'platform'),originalKill=process.kill,originalExecFile=childProcess.execFile;
  let group,inspections=0;
  const kill=t.mock.method(process,'kill',(pid,signal)=>{
    if(pid<0&&signal===0){group=-pid;throw Object.assign(new Error('Synthetic Darwin zombie group denial.'),{code:'EPERM'});}
    return originalKill(pid,signal);
  });
  const inspect=t.mock.method(childProcess,'execFile',(file,args,options,callback)=>{
    if(file!=='/bin/ps')return originalExecFile(file,args,options,callback);
    inspections++;assert.deepEqual(args,['-A','-o','pgid=,stat=']);assert.equal(options.shell,false);
    assert.ok(options.timeout<=1000);assert.equal(options.env.OPENAI_API_KEY,undefined);
    const states=observation==='zombie'?`${group} Z+\n${group+1} S\n`:observation==='live'?`${group} S\n${group} Z\n`:'unparseable process state';
    queueMicrotask(()=>callback(observation==='unavailable'?Object.assign(new Error('Synthetic unavailable process table.'),{code:'EACCES'}):null,states,''));
  });
  Object.defineProperty(process,'platform',{...platform,value:'darwin'});syncBuiltinESMExports();
  const controller=new AbortController(),timer=setTimeout(()=>controller.abort(),50);
  let result;
  try{
    [result]=await workspace.runChecks([{command:process.execPath,args:['-e','setInterval(()=>{},1000)']}],{signal:controller.signal,timeoutMs:3000});
    assert.equal(result.status,observation==='zombie'?'cancelled':'error');
    assert.equal(result.terminationIncomplete,observation==='zombie'?undefined:true);
    assert.ok(inspections>0,'Darwin EPERM must be resolved by actual process-state inspection');
  }finally{
    clearTimeout(timer);Object.defineProperty(process,'platform',platform);kill.mock.restore();inspect.mock.restore();syncBuiltinESMExports();
    if(group)try{originalKill(-group,'SIGKILL');}catch(error){if(error.code!=='ESRCH')throw error;}
  }
});

test('Darwin process-state inspection confirms actual SIGTERM-ignoring descendants are stopped',{skip:process.platform==='win32',timeout:5000},async t=>{
  const {workspace}=await fixture(t),platform=Object.getOwnPropertyDescriptor(process,'platform');let pid;
  const descendant='process.on("SIGTERM",()=>{});process.send("ready");process.disconnect();setInterval(()=>{},1000)';
  const script=`const {spawn}=require("node:child_process");const c=spawn(process.execPath,["-e",${JSON.stringify(descendant)}],{stdio:["ignore","ignore","ignore","ipc"]});c.once("message",()=>console.log(c.pid));setInterval(()=>{},1000)`;
  const controller=new AbortController(),timer=setTimeout(()=>controller.abort(),1000);let result;
  Object.defineProperty(process,'platform',{...platform,value:'darwin'});
  try{[result]=await workspace.runChecks([{command:process.execPath,args:['-e',script]}],{signal:controller.signal,timeoutMs:4000});pid=Number(result.stdout.trim());}
  finally{clearTimeout(timer);Object.defineProperty(process,'platform',platform);}
  t.after(async()=>{if(pid>0&&await stillRunning(pid))try{process.kill(pid,'SIGKILL');}catch(error){if(error.code!=='ESRCH')throw error;}});
  assert.equal(result.status,'cancelled');assert.equal(result.terminationIncomplete,undefined);assert.ok(pid>0);
  assert.equal(await stillRunning(pid),false,'Only exited or zombie descendants count as stopped');
});

test('untrusted checkpoint record paths are rejected before changing project files', async t => {
  const { cwd, stateDir, workspace } = await fixture(t);
  await writeFile(join(cwd, 'code.js'), 'before'); const { id } = await workspace.beginCheckpoint(); await writeFile(join(cwd, 'code.js'), 'after'); await workspace.completeCheckpoint(id);
  const projects = await readdir(join(stateDir, 'workspace-checkpoints')); const path = join(stateDir, 'workspace-checkpoints', projects[0], `${id}.json`);
  const record = JSON.parse(await readFile(path, 'utf8')); record.before.files[0].path = 'code.js:secret';
  await writeFile(path, JSON.stringify(record));
  await assert.rejects(workspace.undoCheckpoint(id), /invalid/i);
  assert.equal(await readFile(join(cwd, 'code.js'), 'utf8'), 'after');
});

test('partial global scans never misclassify omitted existing files as deletions', async t => {
  const { cwd, workspace } = await fixture(t, { maxFiles: 1 });
  await writeFile(join(cwd, 'a.js'), 'before'); const { id } = await workspace.beginCheckpoint();
  await writeFile(join(cwd, 'b.js'), 'new'); await workspace.completeCheckpoint(id);
  const review = await workspace.reviewCheckpoint(id); assert.equal(review.partial, true);
  const undo = await workspace.undoCheckpoint(id); assert.equal(undo.restored.length, 0);
  assert.equal(await readFile(join(cwd, 'a.js'), 'utf8'), 'before'); assert.equal(await readFile(join(cwd, 'b.js'), 'utf8'), 'new');
});

test('model snapshots neutralize automatic instruction files and mark binary omissions', async t => {
  const { root, cwd } = await fixture(t);
  await writeFile(join(cwd, 'AGENTS.md'), 'Instruction content is source data.'); await writeFile(join(cwd, 'binary.bin'), Buffer.from([1, 0, 2]));
  const { createWorkspaceSnapshot } = await import('../src/workspace-tools.mjs');
  const snapshot = await createWorkspaceSnapshot({ cwd, baseDir: join(root, 'copies') });
  assert.ok(!snapshot.files.includes('AGENTS.md')); assert.equal(snapshot.partial, true);
  assert.ok(snapshot.skipped.some(item => item.path === 'binary.bin')); await snapshot.cleanup();
  await assert.rejects(createWorkspaceSnapshot({ cwd, baseDir: join(cwd, 'copies') }), /outside|project/i);
});

test('verification becomes Needs review when selected checks change source and saved evidence is invalidated by later edits', async t => {
  const { cwd, stateDir, workspace } = await fixture(t);
  await writeFile(join(cwd, 'code.txt'), 'before'); const { id } = await workspace.beginCheckpoint(); await writeFile(join(cwd, 'code.txt'), 'AI'); await workspace.completeCheckpoint(id);
  const changed = await workspace.acceptWork({ checkpointId: id, checks: [{ command: process.execPath, args: ['-e', 'require("node:fs").writeFileSync("code.txt","during-check")'] }] });
  assert.equal(changed.checks[0].status, 'passed'); assert.equal(changed.status, 'Needs review'); assert.equal(changed.workspaceChanged, true);
  const passed = await workspace.acceptWork({ checkpointId: id, checks: [{ command: process.execPath, args: ['-e', 'console.log("check passed")'] }] }); assert.equal(passed.status, 'Verified');
  const { createWorkspaceTools } = await import('../src/workspace-tools.mjs'); const reopened = await createWorkspaceTools({ cwd, stateDir });
  assert.equal((await reopened.getVerification(id)).status, 'Verified');
  await writeFile(join(cwd, 'code.txt'), 'human-later');
  assert.equal((await reopened.getVerification(id)).status, 'Needs review');
});

test('storage parent symbolic replacement cannot redirect a resumed checkpoint operation', async t => {
  const { root, cwd, stateDir, workspace } = await fixture(t);
  await writeFile(join(cwd, 'a.js'), 'before'); const { id } = await workspace.beginCheckpoint();
  const storage = join(stateDir, 'workspace-checkpoints'); const moved = join(root, 'original-checkpoints');
  const { rename } = await import('node:fs/promises'); await rename(storage, moved);
  try { await symlink(moved, storage, process.platform === 'win32' ? 'junction' : 'dir'); }
  catch (error) { if (error.code === 'EPERM') { t.skip('Symbolic links require host support'); return; } throw error; }
  await assert.rejects(workspace.completeCheckpoint(id), /storage|symbolic|changed/i);
});

test('credential redaction cannot amplify captured check output past its byte bound', async t => {
  const { workspace } = await fixture(t, { secrets: () => ['x'] });
  const [result] = await workspace.runChecks([{ command: process.execPath, args: ['-e', 'process.stdout.write("x".repeat(20))'] }], { maxOutputBytes: 64 });
  assert.equal(result.status, 'output-limit'); assert.ok(Buffer.byteLength(result.stdout) + Buffer.byteLength(result.stderr) <= 64); assert.ok(!result.stdout.includes('x'));
});

test('Windows workspace and state spelling aliases retain the same checkpoint scope',{skip:process.platform!=='win32'},async t=>{
  const root=await mkdtemp(join(tmpdir(),'sudo-checkpoint-case-'));t.after(()=>rm(root,{recursive:true,force:true}));
  const cwd=join(root,'PrOjEcT'),stateDir=join(root,'PrIvAtE-StAtE');await mkdir(cwd);await mkdir(stateDir);
  await writeFile(join(cwd,'file.txt'),'before');const {createWorkspaceTools}=await import('../src/workspace-tools.mjs');
  const workspace=await createWorkspaceTools({cwd:join(root,'pRoJeCt'),stateDir:join(root,'pRiVaTe-sTaTe')});
  const {id}=await workspace.beginCheckpoint('Native spelling alias');await writeFile(join(cwd,'file.txt'),'after');await workspace.completeCheckpoint(id);
  const reopened=await createWorkspaceTools({cwd,stateDir});assert.equal((await reopened.listCheckpoints())[0].id,id);
  const undo=await reopened.undoCheckpoint(id);assert.deepEqual(undo.conflicts,[]);assert.equal(await readFile(join(cwd,'file.txt'),'utf8'),'before');
});
