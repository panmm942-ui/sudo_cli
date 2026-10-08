import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, readdir, rm, symlink, stat } from 'node:fs/promises';
import { createHash, randomUUID } from 'node:crypto';
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { tmpdir } from './fixtures/temp-root.mjs';
import { join, win32 } from 'node:path';
import {runFixtureProcess} from './fixtures/native-process.mjs';

async function directory(t) {
  const dir = await mkdtemp(join(tmpdir(), 'codexcli-agent-control-test-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  return dir;
}
function recordName(cwd) {
  return `worker-${createHash('sha256').update(process.platform === 'win32' ? cwd.toLowerCase() : cwd).digest('hex')}.json`;
}
async function closeFixtureServer(server,cleanup){
  try{await cleanup?.();}
  finally{server.closeAllConnections();await new Promise(resolve=>server.close(resolve));}
}
async function fixture(t, handler, {cleanup}={}) {
  const server = createServer(handler);
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => closeFixtureServer(server,cleanup));
  return server.address().port;
}
test('fixture server closes even when worker storage cleanup rejects',async t=>{
  const server=createServer((_req,res)=>res.end('fixture'));
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  t.after(()=>new Promise(resolve=>{server.closeAllConnections();server.close(resolve);}));
  await assert.rejects(()=>closeFixtureServer(server,async()=>{throw new Error('Synthetic worker storage cleanup failure.');}),/Synthetic worker storage/);
  assert.equal(server.listening,false);
});

test('Windows project and private state spelling aliases identify the existing exact worker record',{skip:process.platform!=='win32'},async t=>{
  const {workerLocation,getAgentWorker}=await import('../src/agent-control.mjs');const {mkdir}=await import('node:fs/promises');
  const root=await directory(t),cwd=join(root,'PrOjEcT'),stateDir=join(root,'PrIvAtE-StAtE');await mkdir(cwd);await mkdir(stateDir);
  const location=await workerLocation({cwd,stateDir,create:true}),id=randomUUID();
  await writeFile(location.path,JSON.stringify({version:1,id,cwd:location.cwd,pid:2147483647,port:1,token:'a'.repeat(64),startedAt:new Date().toISOString()}));
  assert.deepEqual(await getAgentWorker({cwd:join(root,'pRoJeCt'),stateDir:join(root,'pRiVaTe-sTaTe')}),{running:false,stale:true,id,pid:2147483647});
});
async function waitFor(predicate, timeoutMs = 10000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) { if (await predicate()) return; await new Promise(resolve => setTimeout(resolve, 50)); }
  assert.fail('Expected detached worker behavior did not occur.');
}
function tokenMarker(stdout){
  const marker=typeof stdout==='string'?stdout.trim():'';
  if(marker==='SUDO_CLI_TOKEN_ELEVATED')return true;
  if(marker==='SUDO_CLI_TOKEN_STANDARD')return false;
  throw Object.assign(new Error('Native parent token classification is unavailable.'),{code:'FIXTURE_TOKEN_UNKNOWN'});
}
async function nativeWindowsToken(signal){
  const executable=win32.join(process.env.SystemRoot||'C:\\Windows','System32','WindowsPowerShell','v1.0','powershell.exe');
  const script="if(([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)){[Console]::WriteLine('SUDO_CLI_TOKEN_ELEVATED')}else{[Console]::WriteLine('SUDO_CLI_TOKEN_STANDARD')}";
  const {stdout}=await runFixtureProcess(executable,['-NoLogo','-NoProfile','-NonInteractive','-Command',script],{timeoutMs:30000,maxBytes:4096,signal});
  return tokenMarker(stdout);
}
function receiptReason(reason){
  if(typeof reason!=='string')return 'unspecified';
  if(/initializ.*(?:timeout|timed out)|(?:timeout|timed out).*initializ/i.test(reason))return 'initialization-timeout';
  if(/duration(?:Ms)? budget|budget cannot admit/i.test(reason))return 'task-budget';
  if(/permission|approval/i.test(reason))return 'approval';
  if(/provider|model request/i.test(reason))return 'provider';
  return 'worker-failure';
}
async function taskReceipt({inbox,id,requests,timeoutMs=35000,workerStatus}){
  if(!Number.isInteger(timeoutMs)||timeoutMs<1||timeoutMs>35000)throw Object.assign(new Error('Detached receipt observation limit is invalid.'),{code:'FIXTURE_RECEIPT_LIMIT'});
  let active=true,phase='unobserved',reason='unspecified',deadlineTimer,pollTimer;
  const failure=code=>Object.assign(new Error(`Detached receipt failed: phase=${phase}; reason=${reason}; requests=${requests.length}.`),{code});
  const poll=async()=>{
    while(active){
      let record;try{record=await inbox.get(id);}catch{reason='storage-read';throw failure('FIXTURE_TASK_OBSERVATION');}
      if(!active)return;
      phase=['pending','assessing','running','completed','blocked','failed'].includes(record?.status)?record.status:'unknown';
      if(phase==='completed')return record;
      if(phase==='blocked'||phase==='failed'){reason=receiptReason(record.reason);throw failure('FIXTURE_TASK_TERMINAL');}
      if(phase==='unknown')throw failure('FIXTURE_TASK_OBSERVATION');
      await new Promise(resolve=>{pollTimer=setTimeout(resolve,50);});
    }
  };
  try{
    return await Promise.race([poll(),new Promise((_,reject)=>{deadlineTimer=setTimeout(()=>reject(failure('FIXTURE_TASK_DEADLINE')),timeoutMs);})]);
  }catch(error){
    active=false;clearTimeout(pollTimer);
    if(workerStatus){
      let timer;
      try{
        const status=await Promise.race([Promise.resolve().then(workerStatus),new Promise(resolve=>{timer=setTimeout(()=>resolve(undefined),5000);})]);
        const state=['idle','working','assessing','stopped','error'].includes(status?.status?.state)?status.status.state:'unavailable';
        error.message+=` worker=${state}.`;
      }catch{error.message+=' worker=unavailable.';}
      finally{clearTimeout(timer);}
    }
    throw error;
  }finally{active=false;clearTimeout(deadlineTimer);clearTimeout(pollTimer);}
}

test('native token classification accepts only explicit elevated and standard markers',()=>{
  assert.equal(tokenMarker('SUDO_CLI_TOKEN_ELEVATED\r\n'),true);
  assert.equal(tokenMarker('SUDO_CLI_TOKEN_STANDARD\n'),false);
  for(const value of ['', 'private fixture detail', 'SUDO_CLI_TOKEN_STANDARD\nextra'])assert.throws(()=>tokenMarker(value),error=>error.code==='FIXTURE_TOKEN_UNKNOWN'&&(!value||!error.message.includes(value)));
});
test('detached receipt diagnostics recognize known initialization and admission failures without exposing their text',()=>{
  assert.equal(receiptReason('Codex app-server request timed out (initialize)'),'initialization-timeout');
  assert.equal(receiptReason('The task durationMs budget cannot admit this request.'),'task-budget');
});
test('detached receipts fail early on terminal failure and keep diagnostics bounded',async()=>{
  const reason='private fixture detail';const requests=[{model:'guardian-fixture'}];
  for(const status of ['failed','blocked'])await assert.rejects(()=>taskReceipt({inbox:{get:async()=>({status,reason})},id:'fixture',requests,timeoutMs:50,workerStatus:async()=>({running:true,status:{state:'idle',events:[{error:reason}]}})}),error=>error.code==='FIXTURE_TASK_TERMINAL'&&error.message.includes(`phase=${status}`)&&error.message.includes('requests=1')&&error.message.includes('worker=idle')&&!error.message.includes(reason));
});
test('detached receipts enforce their observation cap before polling and bound a hanging observation',async()=>{
  let calls=0;const inbox={get:async()=>{calls++;return new Promise(()=>{});}};
  await assert.rejects(()=>taskReceipt({inbox,id:'fixture',requests:[],timeoutMs:35001}),{code:'FIXTURE_RECEIPT_LIMIT'});assert.equal(calls,0);
  await assert.rejects(()=>taskReceipt({inbox,id:'fixture',requests:[],timeoutMs:50}),error=>error.code==='FIXTURE_TASK_DEADLINE'&&error.message.length<256);assert.equal(calls,1);
});
test('missing worker status is offline without creating a control record', async t => {
  const { getAgentWorker, stopAgentWorker } = await import('../src/agent-control.mjs');
  const cwd = await directory(t), stateDir = join(cwd, 'state');
  assert.deepEqual(await getAgentWorker({ stateDir, cwd }), { running: false });
  assert.deepEqual(await stopAgentWorker({ stateDir, cwd }), { running: false });
  assert.deepEqual(await readdir(cwd), []);
});
test('invalid worker records and symbolic storage are refused without modifying existing data', async t => {
  const { getAgentWorker } = await import('../src/agent-control.mjs');
  const cwd = await directory(t), stateDir = join(cwd, 'state'), agents = join(stateDir, 'agents');
  const { mkdir } = await import('node:fs/promises'); await mkdir(agents, { recursive: true });
  const path = join(agents, recordName(cwd));
  const value = '{"token":"private-secret","pid":123,"port":1}';
  await writeFile(path, value);
  await assert.rejects(getAgentWorker({ stateDir, cwd }), error => !error.message.includes('private-secret') && /record|storage/i.test(error.message));
  assert.equal(await readFile(path, 'utf8'), value);
});
test('a linked control storage path cannot expose an unrelated directory', { skip: process.platform === 'win32' }, async t => {
  const { getAgentWorker } = await import('../src/agent-control.mjs');
  const cwd = await directory(t), target = await directory(t), stateDir = join(cwd, 'state');
  await symlink(target, stateDir, 'dir');
  await assert.rejects(getAgentWorker({ stateDir, cwd }), /storage|symbolic/i);
  assert.deepEqual(await readdir(target), []);
});
test('controller never trusts an unauthenticated or mismatched server to identify a worker', async t => {
  const { getAgentWorker, stopAgentWorker } = await import('../src/agent-control.mjs');
  const cwd = await directory(t), stateDir = join(cwd, 'state'), agents = join(stateDir, 'agents');
  const { mkdir } = await import('node:fs/promises'); await mkdir(agents, { recursive: true });
  let calls = 0;
  const port = await fixture(t, (req, res) => { calls++; res.setHeader('content-type', 'application/json'); res.end(JSON.stringify({ running: true, id: randomUUID(), pid: process.pid })); });
  const id = randomUUID();
  const value = { version: 1, id, cwd, pid: process.pid, port, token: 'a'.repeat(64), startedAt: new Date().toISOString() };
  const path = join(agents, recordName(cwd)); await writeFile(path, JSON.stringify(value));
  await assert.rejects(getAgentWorker({ stateDir, cwd }), /identity|authenticate|unavailable/i);
  await assert.rejects(stopAgentWorker({ stateDir, cwd }), /identity|authenticate|unavailable/i);
  assert.equal(calls, 2);
  assert.equal(JSON.parse(await readFile(path, 'utf8')).id, id);
  process.kill(process.pid, 0); // No arbitrary PID termination occurred.
});
test('a dead worker is reported stale without deleting records or contacting a different process', async t => {
  const { getAgentWorker, stopAgentWorker } = await import('../src/agent-control.mjs');
  const cwd = await directory(t), stateDir = join(cwd, 'state'), agents = join(stateDir, 'agents');
  const { mkdir } = await import('node:fs/promises'); await mkdir(agents, { recursive: true });
  let requests = 0;
  const port = await fixture(t, (req, res) => { requests++; res.end('{}'); });
  const id = randomUUID(), path = join(agents, recordName(cwd));
  await writeFile(path, JSON.stringify({ version: 1, id, cwd, pid: 2147483647, port, token: 'a'.repeat(64), startedAt: new Date().toISOString() }));
  assert.deepEqual(await getAgentWorker({ stateDir, cwd }), { running: false, stale: true, id, pid: 2147483647 });
  assert.deepEqual(await stopAgentWorker({ stateDir, cwd }), { running: false, stale: true, id, pid: 2147483647 });
  assert.equal(JSON.parse(await readFile(path, 'utf8')).id, id);
  assert.equal(requests, 0);
});
test('standard Windows launch refuses to create a detached worker rather than bypassing elevation', { skip: process.platform !== 'win32',timeout:40000 }, async t => {
  if (await nativeWindowsToken(t.signal)) return t.skip('This process already has an elevated administrator token.');
  const { startAgentWorker } = await import('../src/agent-control.mjs');
  const cwd = await directory(t), stateDir = join(cwd, 'state');
  await assert.rejects(startAgentWorker({ stateDir, cwd, config: { localConnection: { baseUrl: 'http://localhost:1234/v1', model: 'local', transport: 'chat-completions' }, cloudConnection: { baseUrl: 'https://example.com/v1', model: 'cloud', transport: 'chat-completions' } } }), /administrator|root/i);
  assert.deepEqual(await readdir(cwd), []);
});
test('worker configuration rejects implicit permission toggles and unsafe lifecycle secrets before startup', async () => {
  const { validateAgentConfig } = await import('../src/agent-control.mjs');
  const connection = { baseUrl: 'http://localhost:1234/v1', model: 'local', transport: 'chat-completions' };
  const config = { localConnection: connection, cloudConnection: connection };
  assert.throws(() => validateAgentConfig({ ...config, settings: { computerUse: 'off' } }), /Computer|computer/i);
  assert.throws(() => validateAgentConfig({ ...config, settings: { computerServers: 'browser' } }), /computer/i);
  for (const url of ['http://remote.example/wake', 'https://example.com/wake?', 'https://example.com/wake#', 'https://user:private-secret@example.com/wake']) {
    assert.throws(() => validateAgentConfig({ ...config, wake: { url } }), error => !error.message.includes('private-secret'));
  }
  assert.throws(() => validateAgentConfig({ ...config, wake: { url: 'https://example.com/wake', apiKey: 'private-secret\r\nheader' } }), error => !error.message.includes('private-secret'));
  assert.throws(() => validateAgentConfig({ ...config, localDeveloperInstructions: '\u001bunsafe local preference' }), /instructions/i);
});

test('worker validation binds capabilities to each connection and retains scoped tool and folder permissions', async t => {
  const { validateAgentConfig } = await import('../src/agent-control.mjs');
  const base = { baseUrl: 'http://localhost:1234/v1', model: 'local', transport: 'chat-completions' };
  const root = await directory(t);
  const settings = { capabilities: { tools: false, reasoning: false }, toolAllowlist: ['first.run'], writableRoots: [root] };
  const value = validateAgentConfig({ localConnection: base, cloudConnection: { ...base, model: 'cloud', capabilities: { tools: true } }, settings });
  assert.deepEqual(value.localConnection.capabilities, {}, 'local unknown support must not inherit cloud settings');
  assert.deepEqual(value.cloudConnection.capabilities, { tools: true }, 'connection declarations take precedence');
  assert.deepEqual(value.settings.capabilities, { tools: true });
  assert.deepEqual(value.settings.toolAllowlist, ['first.run']);
  assert.deepEqual(value.settings.writableRoots, [root]);
  settings.toolAllowlist.push('second.run');
  assert.deepEqual(value.settings.toolAllowlist, ['first.run']);
  for (const settings of [{ toolAllowlist: ['run', 'run'] }, { toolAllowlist: 'run' }, { writableRoots: ['relative'] }, { capabilities: { reasoning: false }, effort: 'high' }]) assert.throws(() => validateAgentConfig({ localConnection: base, cloudConnection: base, settings }), /permission|folder|reasoning/i);
});

test('worker validation preserves only explicit bounded acceptance check fields', async () => {
  const { validateAgentConfig } = await import('../src/agent-control.mjs');
  const base = { baseUrl: 'http://localhost:1234/v1', model: 'local', transport: 'chat-completions' };
  const checks = [{ shellCommand: 'npm test\nnode --version', label: 'project tests', privateKey: 'discard-this' }, { command: process.execPath, args: ['--version'], label: 'runtime', env: { secret: 'discard-this' } }];
  const config = { localConnection: base, cloudConnection: base, settings: { checks } };
  const value = validateAgentConfig(config);
  assert.deepEqual(value.settings.checks, [{ shellCommand: checks[0].shellCommand, label: 'project tests' }, { command: process.execPath, args: ['--version'], label: 'runtime' }]);
  checks[1].args.push('changed');
  assert.deepEqual(value.settings.checks[1].args, ['--version']);
  for (const checks of [Array(17).fill({ shellCommand: 'true' }), [{ shellCommand: 'x'.repeat(32769) }], [{ shellCommand: '🙂'.repeat(17000) }], [{ shellCommand: 'true', command: 'false' }], [{ command: 'node', args: ['bad\0argument'] }], [{ shellCommand: 'true', label: 'x'.repeat(201) }]]) assert.throws(() => validateAgentConfig({ ...config, settings: { checks } }), /check/i);
});
test('native elevated detached worker remains idle, authenticates control, refuses duplicates, and stops cleanly', { skip: process.platform === 'win32' || process.geteuid?.() !== 0 }, async t => {
  const { startAgentWorker, getAgentWorker, stopAgentWorker } = await import('../src/agent-control.mjs');
  const cwd = await mkdtemp(join(tmpdir(), 'codexcli-agent-idle-test-')), stateDir = join(cwd, 'state');
  let modelCalls = 0;
  const port = await fixture(t, (req, res) => { modelCalls++; res.end('{}'); },{cleanup:async()=>{try{await stopAgentWorker({stateDir,cwd});}finally{await rm(cwd,{recursive:true,force:true});}}});
  const connection = { baseUrl: `http://127.0.0.1:${port}/v1`, model: 'fixture', transport: 'chat-completions', apiKey: 'model-secret-only-in-ipc' };
  const config = { localConnection: connection, cloudConnection: connection, settings: { permissions: 'ask', webAccess: false }, watchPaths: [] };
  const started = await startAgentWorker({ stateDir, cwd, config });
  assert.equal(started.running, true);
  assert.notEqual(started.pid, process.pid);
  assert.ok(!JSON.stringify(started).includes('model-secret'));
  const status = await getAgentWorker({ stateDir, cwd }); assert.equal(status.pid, started.pid);
  const again = await startAgentWorker({ stateDir, cwd, config }); assert.equal(again.pid, started.pid);
  const recordPath = join(stateDir, 'agents', recordName(cwd));
  const bytes = await readFile(recordPath, 'utf8');
  assert.ok(!bytes.includes('model-secret-only-in-ipc') && !bytes.includes(connection.baseUrl));
  assert.equal((await stat(recordPath)).mode & 0o777, 0o600);
  const record = JSON.parse(bytes);
  const unauthorized = await fetch(`http://127.0.0.1:${record.port}/status`); assert.equal(unauthorized.status, 401);
  assert.equal(modelCalls, 0);
  await stopAgentWorker({ stateDir, cwd });
  assert.deepEqual(await getAgentWorker({ stateDir, cwd }), { running: false });
  assert.throws(() => process.kill(started.pid, 0), error => error.code === 'ESRCH');
});
test('detached worker survives its launching process and processes an explicit task through native local and working AI sessions', { skip: process.platform === 'win32' || process.geteuid?.() !== 0,timeout:45000 }, async t => {
  const { getAgentWorker, stopAgentWorker } = await import('../src/agent-control.mjs');
  const { createTaskInbox } = await import('../src/task-inbox.mjs');
  const cwd = await mkdtemp(join(tmpdir(), 'codexcli-agent-detached-test-')), stateDir = join(cwd, 'state');
  const requests = [];
  const port = await fixture(t, async (req, res) => {
    const chunks = []; for await (const chunk of req) chunks.push(chunk);
    const body = JSON.parse(Buffer.concat(chunks).toString('utf8')); requests.push(body);
    const content = body.model === 'guardian-fixture' ? JSON.stringify({ action: 'cloud', prompt: 'Reply with the fixture completion text.', reason: 'This explicit task needs the working model.' }) : 'Fixture background task completed.';
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify({ id: 'fixture-chat', object: 'chat.completion', model: body.model, choices: [{ index: 0, message: { role: 'assistant', content }, finish_reason: 'stop' }], usage: { prompt_tokens: 20, completion_tokens: 10, total_tokens: 30 } }));
  },{cleanup:async()=>{try{await stopAgentWorker({stateDir,cwd});}finally{await rm(cwd,{recursive:true,force:true});}}});
  const baseUrl = `http://127.0.0.1:${port}/v1`;
  const config = { localConnection: { baseUrl, model: 'guardian-fixture', transport: 'chat-completions', apiKey: 'guardian-private-fixture' }, cloudConnection: { baseUrl, model: 'working-fixture', transport: 'chat-completions', apiKey: 'working-private-fixture' }, settings: { permissions: 'ask', webAccess: false }, budget:{task:{durationMs:30000}}, pollMs: 100, localDeveloperInstructions: 'Guardian-specific preference: be concise.', developerInstructions: 'Working-model preference: show results.' };
  const moduleUrl = new URL('../src/agent-control.mjs', import.meta.url).href;
  const launch = `const {startAgentWorker}=await import(${JSON.stringify(moduleUrl)});const chunks=[];for await(const b of process.stdin)chunks.push(b);const result=await startAgentWorker(JSON.parse(Buffer.concat(chunks).toString()));process.stdout.write(JSON.stringify(result));`;
  const launcher = spawn(process.execPath, ['--input-type=module', '-e', launch], { shell: false, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
  const output = [], errors = []; launcher.stdout.on('data', chunk => output.push(chunk)); launcher.stderr.on('data', chunk => errors.push(chunk));
  launcher.stdin.end(JSON.stringify({ cwd, stateDir, config }));
  const code = await new Promise(resolve => launcher.once('close', resolve));
  assert.equal(code, 0, Buffer.concat(errors).toString());
  const started = JSON.parse(Buffer.concat(output).toString());
  assert.equal((await getAgentWorker({ cwd, stateDir })).pid, started.pid);
  assert.equal(requests.length, 0, 'Empty inbox makes no local or cloud model request.');
  const inbox = await createTaskInbox({ cwd, stateDir });
  const job = await inbox.submit({ prompt: 'Run the fixture explanation task.', source: 'user' });
  const completion=await taskReceipt({inbox,id:job.id,requests,workerStatus:()=>getAgentWorker({cwd,stateDir})});
  assert.match(completion.result,/^Fixture background task completed\.\n\nAcceptance: Needs review\. Checkpoint: [a-f0-9-]{36}\.$/);
  const {createWorkspaceTools}=await import('../src/workspace-tools.mjs');
  const checkpoints=await (await createWorkspaceTools({cwd,stateDir})).listCheckpoints();
  assert.ok(checkpoints.some(checkpoint=>completion.result.endsWith(`Checkpoint: ${checkpoint.id}.`)&&checkpoint.status==='completed'));
  assert.deepEqual(requests.map(request => request.model), ['guardian-fixture', 'working-fixture']);
  assert.ok(JSON.stringify(requests[0].messages).includes('Guardian-specific preference'));
  assert.ok(!JSON.stringify(requests[0].messages).includes('Working-model preference'));
  assert.ok(JSON.stringify(requests[1].messages).includes('Working-model preference'));
  assert.ok(!JSON.stringify(requests[1].messages).includes('Guardian-specific preference'));
  await stopAgentWorker({ cwd, stateDir });
  assert.deepEqual(await getAgentWorker({ cwd, stateDir }), { running: false });
});
test('detached native approval requests are declined and block the job instead of reporting completion', { skip: process.platform === 'win32' || process.geteuid?.() !== 0 }, async t => {
  const { startAgentWorker, stopAgentWorker } = await import('../src/agent-control.mjs');
  const { createTaskInbox } = await import('../src/task-inbox.mjs');
  const cwd = await mkdtemp(join(tmpdir(), 'codexcli-agent-approval-test-')), stateDir = join(cwd, 'state');
  let toolRequested = false, failAfterDenial = false;
  const port = await fixture(t, async (req, res) => {
    const chunks = []; for await (const chunk of req) chunks.push(chunk); const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    if (failAfterDenial && body.model !== 'guardian-fixture' && body.messages.some(item => item.role === 'tool')) { res.writeHead(400); res.end('provider-private-error'); return; }
    let message, finish = 'stop';
    if (body.model === 'guardian-fixture') message = { role: 'assistant', content: '{"action":"cloud","prompt":"Run the permission fixture."}' };
    else if (body.messages.some(item => item.role === 'tool')) message = { role: 'assistant', content: 'Permission was declined; this must not be treated as a completed job.' };
    else {
      toolRequested = true; finish = 'tool_calls';
      message = { role: 'assistant', content: null, tool_calls: [{ id: 'background-approval-fixture', type: 'function', function: { name: 'exec_command', arguments: JSON.stringify({ cmd: "printf 'this must never run' > permission-proof.txt", workdir: cwd, login: false, sandbox_permissions: 'require_escalated', justification: 'Fixture explicitly requires human approval.', max_output_tokens: 1000 }) } }] };
    }
    res.setHeader('content-type', 'application/json'); res.end(JSON.stringify({ id: 'fixture-chat', object: 'chat.completion', model: body.model, choices: [{ index: 0, message, finish_reason: finish }] }));
  },{cleanup:async()=>{try{await stopAgentWorker({stateDir,cwd});}finally{await rm(cwd,{recursive:true,force:true});}}});
  const baseUrl = `http://127.0.0.1:${port}/v1`;
  await startAgentWorker({ cwd, stateDir, config: { localConnection: { baseUrl, model: 'guardian-fixture', transport: 'chat-completions' }, cloudConnection: { baseUrl, model: 'working-fixture', transport: 'chat-completions' }, settings: { permissions: 'ask', webAccess: false }, pollMs: 100 } });
  const inbox = await createTaskInbox({ cwd, stateDir }), job = await inbox.submit({ prompt: 'Perform the approval fixture only.', source: 'user' });
  await waitFor(async () => ['blocked', 'failed', 'completed'].includes((await inbox.get(job.id)).status), 15000);
  const result = await inbox.get(job.id);
  assert.equal(toolRequested, true);
  assert.equal(result.status, 'blocked');
  assert.match(result.reason, /(?:permission.*approval|approval.*permission)/i);
  await assert.rejects(readFile(join(cwd, 'permission-proof.txt')), error => error.code === 'ENOENT');
  failAfterDenial = true;
  const interrupted = await inbox.submit({ prompt: 'Perform the failing-after-denial fixture only.', source: 'user' });
  await waitFor(async () => ['blocked', 'failed', 'completed'].includes((await inbox.get(interrupted.id)).status), 15000);
  const afterFailure = await inbox.get(interrupted.id);
  assert.equal(afterFailure.status, 'blocked');
  assert.match(afterFailure.reason, /(?:permission.*approval|approval.*permission)/i);
  await assert.rejects(readFile(join(cwd, 'permission-proof.txt')), error => error.code === 'ENOENT');
});
