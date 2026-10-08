import test,{after} from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { readFile, access, rm } from 'node:fs/promises';
import {mkdtempSync} from 'node:fs';
import {join} from 'node:path';
import { createEngine } from '../src/engine.mjs';
import {runFixtureProcess} from './fixtures/native-process.mjs';

async function descendantRunning(pid){
  if(process.platform==='linux')try{const text=await readFile(`/proc/${pid}/stat`,'utf8');return !['Z','X','x'].includes(text.slice(text.lastIndexOf(')')+2).split(' ')[0]);}catch(error){if(error.code==='ENOENT')return false;throw error;}
  try{process.kill(pid,0);return true;}catch(error){if(error.code==='ESRCH')return false;throw error;}
}
function ownedDescendant(t){let pid; t.after(async()=>{if(pid&&await descendantRunning(pid))try{process.kill(pid,'SIGKILL');}catch{}});return {event:e=>{if(e.method==='fixture/descendant')pid=e.params.pid;},pid:()=>pid};}

const fixture = fileURLToPath(new URL('./fixtures/engine-server.mjs', import.meta.url));
// Protocol mocks do not have a real disposable home. Keep their cwd owned by
// this test runner so a sudo checkout owner cannot trigger production admission.
const fixtureCwd=process.platform==='linux'&&process.getuid?.()===0?mkdtempSync(join('/tmp','sudo-engine-protocol-')):process.cwd();
if(fixtureCwd!==process.cwd())after(()=>rm(fixtureCwd,{recursive:true,force:true}));
const options = (scenario = 'normal', extra = {}) => ({
  codexPath: [process.execPath, fixture], cwd: fixtureCwd, model: 'fixture-model',
  providerArgs: ['-c', 'model_provider="fixture"'],
  env: { ...process.env, ENGINE_SCENARIO: scenario, CODEX_HOME: 'fixture-home', SUDO_CLI_SESSION_KEY: 'fixture-only' },
  requestTimeoutMs: 2000, ...extra,
});
test('per-AI personalization is passed as native developer instructions',async t=>{
  const engine=await createEngine(options('normal',{developerInstructions:'Reply concisely in English.'}));t.after(()=>engine.close());
  const audit=JSON.parse((await engine.startTurn('test personalization')).items[0].text);
  assert.equal(audit.thread.developerInstructions,'Reply concisely in English.');
});

test('engine custom catalog preserves declared capabilities while exposing native capability lookup', async t => {
  const engine = await createEngine(options('normal', { providerArgs: ['-c', 'model_provider="sudo_session"'], capabilities: { vision: false }, supportedEfforts: ['high'] }));
  t.after(() => engine.close());
  const audit = JSON.parse((await engine.startTurn('Inspect exact model metadata')).items[0].text);
  const path = JSON.parse(audit.argv.find(argument => argument.startsWith('model_catalog_json=')).slice('model_catalog_json='.length));
  const entry = JSON.parse(await readFile(path, 'utf8')).models[0];
  assert.equal(entry.slug, 'fixture-model');
  assert.deepEqual(entry.input_modalities, ['text']);
  assert.deepEqual(entry.supported_reasoning_levels.map(item => item.effort), ['high']);
  assert.equal(typeof engine.capabilities, 'function');
  await engine.close();
  await assert.rejects(access(path));
});
test('aborting native startup closes a hung child promptly',async()=>{
  const controller=new AbortController();const pending=createEngine(options('hang-startup',{signal:controller.signal,requestTimeoutMs:10000}));
  setTimeout(()=>controller.abort(),50);await assert.rejects(within(pending,20000),{name:'AbortError'});
});
async function within(promise, ms = 1000) {
  let timeout;
  try {
    return await Promise.race([promise, new Promise((_, reject) => {
      timeout = setTimeout(() => reject(new Error('test deadline expired')), ms);
    })]);
  } finally { clearTimeout(timeout); }
}

test('runs an isolated ephemeral thread and streams intact UTF-8 notifications', async (t) => {
  const events = [];
  const engine = await createEngine(options('normal', { onEvent: (event) => events.push(event) }));
  t.after(() => engine.close());
  assert.equal(engine.threadId, 'thread-1');
  const completed = await engine.startTurn('Hello', { model: 'changed-model' });
  assert.equal(completed.status, 'completed');
  const audit = JSON.parse(completed.items[0].text);
  assert.deepEqual(audit.argv, ['--no-daemon', 'app-server', '--listen', 'stdio://', '-c', 'model_provider="fixture"']);
  assert.equal(audit.home, 'fixture-home');
  assert.equal(audit.keyPresent, true);
  assert.equal(audit.thread.ephemeral, true);
  assert.equal(audit.thread.sandbox, 'workspace-write');
  assert.equal(audit.thread.approvalPolicy, 'on-request');
  assert.equal(audit.thread.config['sandbox_workspace_write.network_access'], false);
  assert.equal(audit.thread.config.web_search, 'disabled');
  assert.equal(audit.thread.cwd, fixtureCwd);
  assert.equal(audit.thread.model, 'fixture-model');
  assert.deepEqual(audit.params.input, [{ type: 'text', text: 'Hello', text_elements: [] }]);
  assert.equal(audit.params.threadId, 'thread-1');
  assert.equal(audit.params.model, 'changed-model');
  assert.equal(events.find(({ method }) => method === 'item/agentMessage/delta').params.delta, 'Hello 🌍');
  assert.equal(events.filter(({ method }) => method === 'turn/completed').length, 2);
});

test('Web Off full access remains sandboxed and disables hosted search', async (t) => {
  const engine = await createEngine(options('normal', { permissions: 'allow-everything', webAccess: false }));
  t.after(() => engine.close());
  const audit = JSON.parse((await engine.startTurn('Audit full access')).items[0].text);
  assert.equal(audit.thread.approvalPolicy, 'never');
  assert.equal(audit.thread.sandbox, 'workspace-write');
  assert.equal(audit.thread.config.web_search, 'disabled');
  assert.equal(audit.thread.config['sandbox_workspace_write.network_access'], false);
  assert.equal(engine.runtimePolicy.sandbox.type, 'workspaceWrite');
});

test('web on enables sandboxed command networking without changing ask permissions', async (t) => {
  const engine = await createEngine(options('normal', { webAccess: true }));
  t.after(() => engine.close());
  const audit = JSON.parse((await engine.startTurn('Audit networking')).items[0].text);
  assert.equal(audit.thread.approvalPolicy, 'on-request');
  assert.equal(audit.thread.sandbox, 'workspace-write');
  assert.equal(audit.thread.config['sandbox_workspace_write.network_access'], true);
  assert.equal(engine.runtimePolicy.sandbox.networkAccess, true);
});

test('a stricter read-only platform fallback is exposed rather than described as full workspace access', async (t) => {
  const engine = await createEngine(options('read-only-fallback', { webAccess: true }));
  t.after(() => engine.close());
  assert.deepEqual(engine.runtimePolicy.sandbox, { type: 'readOnly', networkAccess: false });
  assert.equal(engine.runtimePolicy.approvalPolicy, 'on-request');
});

test('invalid runtime permissions fail before spawning an engine without exposing option values', async () => {
  for (const patch of [{ permissions: 'secret-permission' }, { webAccess: 'on' }]) {
    await assert.rejects(createEngine({ codexPath: 'missing-engine', ...patch }), error => /Permissions|Web Access/.test(error.message) && !error.message.includes('secret-permission'));
  }
});

test('an engine cannot silently replace ask mode with full access or enable networking while web is off', async (t) => {
  for (const scenario of ['wrong-permissions', 'wrong-network']) {
    let engine;
    t.after(() => engine?.close());
    await assert.rejects(async () => { engine = await createEngine(options(scenario)); }, scenario === 'wrong-permissions' ? /requested permission policy/ : /requested network policy/);
  }
});

test('a workspace sandbox cannot silently ignore enabled command networking', async (t) => {
  let engine;
  t.after(() => engine?.close());
  await assert.rejects(async () => { engine = await createEngine(options('ignored-network', { webAccess: true })); }, /requested network policy/);
});

test('a workspace sandbox cannot silently grant global temporary folders',async()=>{
  let engine;try{await assert.rejects(()=>createEngine(options('wrong-temp')).then(value=>{engine=value;return value;}),/temporary folder policy/i);}finally{await engine?.close();}
});

test('explicit full access handles recognized approvals without showing permission prompts', async (t) => {
  let prompted = false;
  const engine = await createEngine(options('approvals', { permissions: 'allow-everything', scope:'full',webAccess:true,onApproval: async () => { prompted = true; return false; } }));
  t.after(() => engine.close());
  const responses = JSON.parse((await within(engine.startTurn('full access approvals'))).items[0].text);
  assert.equal(prompted, false);
  assert.deepEqual(responses['item/commandExecution/requestApproval'], { decision: 'accept' });
  assert.deepEqual(responses['item/fileChange/requestApproval'], { decision: 'accept' });
  assert.deepEqual(responses.execCommandApproval, { decision: 'approved' });
  assert.deepEqual(responses.applyPatchApproval, { decision: 'approved' });
  assert.equal(responses['item/permissions/requestApproval'].permissions.network.enabled, true);
  assert.equal(responses['account/chatgptAuthTokens/refresh'].error.code, -32601);
});

test('does not lose completion sent before the turn/start response', async (t) => {
  const engine = await createEngine(options('early-completion'));
  t.after(() => engine.close());
  assert.equal((await within(engine.startTurn('fast'))).status, 'completed');
});

test('rejects failed turns and request errors without exposing server diagnostics', async (t) => {
  for (const scenario of ['failed-turn', 'turn-error']) {
    const engine = await createEngine(options(scenario));
    t.after(() => engine.close());
    await assert.rejects(within(engine.startTurn('failure')), /Codex.*(failed|rejected)/);
  }
});

test('interrupts an active turn while its completion is pending', async (t) => {
  const engine = await createEngine(options('interrupt'));
  t.after(() => engine.close());
  const completed = engine.startTurn('long running');
  await within(engine.interrupt());
  assert.equal((await within(completed)).status, 'interrupted');
});

test('interrupt terminates native background commands and the same thread can continue', async t => {
  const engine = await createEngine(options('background-commands'));
  t.after(() => engine.close());
  assert.equal((await engine.listBackgroundCommands()).length, 2);
  const active = engine.startTurn('run the fixture command');
  await engine.interrupt();
  assert.equal((await active).status, 'interrupted');
  assert.deepEqual(await engine.listBackgroundCommands(), []);
  const next = await engine.startTurn('continue');
  const audit = JSON.parse(next.items[0].text);
  assert.deepEqual(audit.commandTerminations, [{ threadId: 'thread-1', processId: '23' }, { threadId: 'thread-1', processId: '24' }]);
});

test('idle interrupt still terminates a previously yielded native command', async t => {
  const engine = await createEngine(options('background-commands'));
  t.after(() => engine.close());
  const result = await engine.terminateBackgroundCommands();
  assert.equal(result.terminated, 2);
  await engine.interrupt();
  assert.deepEqual(await engine.listBackgroundCommands(), []);
});

test('a follow-up turn waits until interrupt command cleanup has finished', async t => {
  const engine = await createEngine(options('background-race'));
  t.after(() => engine.close());
  const first = engine.startTurn('run fixture');
  const stopping = engine.interrupt();
  assert.equal((await first).status, 'interrupted');
  const next = await engine.startTurn('continue immediately');
  const audit = JSON.parse(next.items[0].text);
  assert.equal(audit.commandTerminations.length, 2, 'Continuation must not race command termination');
  await stopping;
});

test('refuses overlapping turns instead of replacing an active completion', async (t) => {
  const engine = await createEngine(options('interrupt'));
  t.after(() => engine.close());
  const first = engine.startTurn('first');
  const firstHandled = first.catch(() => null);
  await assert.rejects(within(engine.startTurn('second')), /already active/);
  await engine.interrupt();
  assert.equal((await within(firstHandled)).status, 'interrupted');
});

test('rejects active work when the child exits', async (t) => {
  const engine = await createEngine(options('exit-turn'));
  t.after(() => process.platform==='win32'?assert.rejects(engine.close(),{code:'ENGINE_CLEANUP_UNVERIFIED'}):engine.close());
  await assert.rejects(within(engine.startTurn('exit')), /exited|stream closed/);
});

test('times out startup and rejects a failed child startup', async () => {
  await assert.rejects(within(createEngine(options('hang-startup', { requestTimeoutMs: 150 })),20000), /timed out/);
  await assert.rejects(within(createEngine(options('exit-startup')),20000), /exited|stream closed/);
});

test('close rejects active work and is safe to call twice', async () => {
  const engine = await createEngine(options('close-turn'));
  const active = assert.rejects(within(engine.startTurn('pending')), /closed/);
  await engine.close();
  await engine.close();
  await active;
  await assert.rejects(engine.startTurn('after close'), /closed/);
});

test('maps approvals to one-time protocol decisions and declines unsupported sensitive requests', async (t) => {
  const reviewed = [];
  const notifications = [];
  const engine = await createEngine(options('approvals', {
    scope:'full',webAccess:true,
    onEvent: (event) => notifications.push(event),
    onApproval: async (request) => {
      reviewed.push(request);
      if (request.method === 'item/commandExecution/requestApproval') {
        await new Promise((resolve) => setTimeout(resolve, 20));
        return true;
      }
      return ['item/permissions/requestApproval', 'execCommandApproval'].includes(request.method);
    },
  }));
  t.after(() => engine.close());
  const completed = await within(engine.startTurn('approval test'));
  const responses = JSON.parse(completed.items[0].text);
  assert.deepEqual(responses['item/commandExecution/requestApproval'], { decision: 'accept' });
  assert.deepEqual(responses['item/fileChange/requestApproval'], { decision: 'decline' });
  assert.deepEqual(responses.execCommandApproval, { decision: 'approved' });
  assert.deepEqual(responses.applyPatchApproval, { decision: { denied: { rejection: 'Declined by user.' } } });
  assert.deepEqual(responses['item/permissions/requestApproval'], {
    permissions: { network: { enabled: true }, fileSystem: { read: [fixtureCwd], write: [fixtureCwd] } }, scope: 'turn',
  });
  assert.deepEqual(responses['item/tool/requestUserInput'], { answers: {} });
  assert.deepEqual(responses['mcpServer/elicitation/request'], { action: 'decline' });
  for (const method of ['account/chatgptAuthTokens/refresh', 'item/tool/call', 'attestation/generate']) {
    assert.equal(responses[method].error.code, -32601);
  }
  assert.equal(Number.isInteger(responses['currentTime/read'].currentTimeAt), true);
  assert.deepEqual(reviewed.map(({ method }) => method).sort(), [
    'item/commandExecution/requestApproval', 'item/fileChange/requestApproval', 'item/permissions/requestApproval', 'execCommandApproval', 'applyPatchApproval',
  ].sort());
  assert.equal(notifications.some(({ method }) => method.includes('requestApproval')), false);
});

test('approval callback errors decline requests instead of hanging or approving', async (t) => {
  const engine = await createEngine(options('approvals', { onApproval: async () => { throw new Error('UI unavailable'); } }));
  t.after(() => engine.close());
  const completed = await within(engine.startTurn('approval failure'));
  const responses = JSON.parse(completed.items[0].text);
  assert.deepEqual(responses['item/commandExecution/requestApproval'], { decision: 'decline' });
  assert.deepEqual(responses['item/fileChange/requestApproval'], { decision: 'decline' });
  assert.deepEqual(responses['item/permissions/requestApproval'], { permissions: {}, scope: 'turn' });
});

test('matches JSON-RPC response ids by type and recovers after a rejected turn request', async (t) => {
  const matched = await createEngine(options('wrong-id'));
  t.after(() => matched.close());
  assert.equal((await matched.startTurn('right request')).status, 'completed');
  const retry = await createEngine(options('retry-turn'));
  t.after(() => retry.close());
  await assert.rejects(retry.startTurn('rejected'), /rejected/);
  assert.equal((await retry.startTurn('retry')).status, 'completed');
});

test('fails safely when the executable is missing', async () => {
  await assert.rejects(within(createEngine(options('normal', { codexPath: 'sudo-fixture-does-not-exist.exe' }))), /Unable to start/);
});

test('rejects invalid thread startup responses with a safe error', async () => {
  await assert.rejects(within(createEngine(options('bad-thread')),20000), /invalid thread response/);
});

test('requires ephemeral thread confirmation instead of using a persisted thread', async () => {
  await assert.rejects(within(createEngine(options('persistent-thread')).then(async (engine) => { await engine.close(); return engine; }),20000), /ephemeral/);
});

test('rejects malformed turn responses without retaining an active turn', async (t) => {
  const engine = await createEngine(options('bad-turn'));
  t.after(() => engine.close());
  await assert.rejects(engine.startTurn('bad turn'), /invalid turn response/);
  await assert.rejects(engine.startTurn('retry'), /invalid turn response/);
});

test('rejects a runtime request when the app-server stops responding', async (t) => {
  const timeout = await createEngine(options('request-timeout', { requestTimeoutMs: 750 }));
  t.after(() => timeout.close());
  await assert.rejects(within(timeout.startTurn('timeout')), /timed out/);
});

test('bounds incomplete JSON lines instead of retaining unlimited server output', async (t) => {
  const engine = await createEngine(options('oversized-line'));
  t.after(() => engine.close());
  // The outer harness must outlast the engine's own 2-second request bound
  // while the child transfers this 8 MiB fixture under concurrent CI load.
  await assert.rejects(within(engine.startTurn('large output'),5000), /output exceeded/);
});

test('rejects empty input before sending a model request', async (t) => {
  const engine = await createEngine(options('normal'));
  t.after(() => engine.close());
  for (const text of ['', '  ', null]) await assert.rejects(engine.startTurn(text), /non-empty text/);
  assert.equal((await engine.startTurn('valid after invalid')).status, 'completed');
});

test('typed skill and image inputs reach native turns together with explicit reasoning', async (t) => {
  const engine = await createEngine(options('normal', { supportedEfforts: ['high', 'adaptive'] }));
  t.after(() => engine.close());
  const input = [{ type: 'skill', name: 'review', path: '/workspace/.agents/skills/review/SKILL.md' }, { type: 'localImage', path: '/workspace/shot.png', detail: 'high' }, { type: 'text', text: 'Review this' }];
  const audit = JSON.parse((await engine.startTurn(input, { effort: 'adaptive' })).items[0].text);
  assert.deepEqual(audit.params.input, [input[0], input[1], { ...input[2], text_elements: [] }]);
  assert.equal(audit.params.effort, 'adaptive');
  await assert.rejects(engine.startTurn('Unsupported profile effort', { effort: 'low' }), /model profile/);
  const next = JSON.parse((await engine.startTurn('Default')).items[0].text);
  assert.equal(Object.hasOwn(next.params, 'effort'), false);
  for (const input of [[], [{ type: 'skill', path: '/x' }], [{ type: 'tool', name: 'fake' }], [{ type: 'text', text: 'x', sandbox: 'danger-full-access' }]]) await assert.rejects(engine.startTurn(input), /input/);
});

test('native discovery uses documented methods and current thread scope', async (t) => {
  const engine = await createEngine(options());
  t.after(() => engine.close());
  const models = await engine.listModels({ limit: 2, includeHidden: true });
  assert.deepEqual(models.received, { limit: 2, includeHidden: true });
  assert.equal(models.data[0].supportedReasoningEfforts[0].reasoningEffort, 'high');
  assert.deepEqual((await engine.listSkills({ cwd: '/workspace', forceReload: true })).received, { cwds: ['/workspace'], forceReload: true });
  assert.deepEqual((await engine.listMcpServers({ serverName: 'browser' })).received, { threadId: 'thread-1', detail: 'toolsAndAuthOnly', serverName: 'browser' });
  const tools = await engine.listMcpTools();
  assert.equal(tools[0].serverName, 'browser');
  assert.equal(tools[0].name, 'click');
  assert.equal(tools[0].tool.description, 'Click a button');
  assert.deepEqual(await engine.capabilities(), { namespaceTools: true, imageGeneration: false, webSearch: false });
});

test('compaction waits for matching native completion after acknowledgement and supports early notifications', async (t) => {
  for (const scenario of ['compact-normal', 'compact-early']) {
    const engine = await createEngine(options(scenario));
    t.after(() => engine.close());
    const completed = engine.compact();
    await assert.rejects(engine.startTurn('Overlap'), /already active/);
    assert.equal((await within(completed)).id, 'compact-turn');
    assert.equal((await engine.startTurn('Continue')).status, 'completed');
  }
});

test('compaction can be interrupted before its native turn id arrives', async (t) => {
  const engine = await createEngine(options('compact-interrupt'));
  t.after(() => engine.close());
  const completed = engine.compact();
  await within(engine.interrupt());
  assert.equal((await within(completed)).status, 'interrupted');
});

test('missing compaction start notifications time out instead of hanging an operation', async (t) => {
  const engine = await createEngine(options('compact-no-start', { requestTimeoutMs: 250 }));
  t.after(() => engine.close());
  await assert.rejects(within(engine.compact()), /compaction.*timed out/i);
});

test('steering waits for the active native turn and includes its required id precondition', async (t) => {
  const engine = await createEngine(options('interrupt'));
  t.after(() => engine.close());
  await assert.rejects(engine.steer('Before any turn'), /active turn/);
  const turn = engine.startTurn('Initial task');
  const result = await engine.steer([{ type: 'text', text: 'Focus on tests' }]);
  assert.equal(result.turnId, 'turn-1');
  assert.deepEqual(result.received, { threadId: 'thread-1', expectedTurnId: 'turn-1', input: [{ type: 'text', text: 'Focus on tests', text_elements: [] }] });
  await engine.interrupt();
  assert.equal((await turn).status, 'interrupted');
  await assert.rejects(engine.steer('After completion'), /active turn/);
});

test('compaction cannot accept same-turn steering', async (t) => {
  const engine = await createEngine(options('compact-interrupt'));
  t.after(() => engine.close());
  const compaction = engine.compact();
  void compaction.catch(() => {}); // A failing assertion still closes the pending operation safely.
  await assert.rejects(engine.steer('Additional task'), /compaction/);
  await engine.interrupt();
  await compaction;
});

test('engine close stops an actual private helper tree and leaves a concurrent engine usable',{timeout:30000},async t=>{
  const descendant=ownedDescendant(t);
  const foreign=await createEngine(options());t.after(()=>foreign.close());
  const engine=await createEngine(options('owned-normal',{onEvent:descendant.event}));t.after(()=>engine.close());
  assert.equal(await descendantRunning(descendant.pid()),true);
  const a=engine.close(),b=engine.close();assert.equal(a,b);await a;
  assert.equal(await descendantRunning(descendant.pid()),false);
  assert.equal((await foreign.startTurn('Still alive')).status,'completed');
});
test('startup validation failure cleans its real helper tree',{timeout:20000},async t=>{
  const descendant=ownedDescendant(t);
  await assert.rejects(createEngine(options('owned-bad-thread',{onEvent:descendant.event})),/invalid thread response/);
  assert.ok(descendant.pid());assert.equal(await descendantRunning(descendant.pid()),false);
});
test('aborted initialization cleans its real helper tree',{timeout:20000},async t=>{
  const controller=new AbortController(),descendant=ownedDescendant(t);
  await assert.rejects(createEngine(options('owned-hang-startup',{requestTimeoutMs:10000,signal:controller.signal,onEvent:event=>{descendant.event(event);if(descendant.pid())controller.abort();}})),{name:'AbortError'});
  assert.ok(descendant.pid());assert.equal(await descendantRunning(descendant.pid()),false);
});
test('failed initial Unix ownership metadata still attempts owned teardown and reports unverified cleanup',{skip:process.platform==='win32',timeout:20000},async()=>{
  const engineUrl=new URL('../src/engine.mjs',import.meta.url).href,ownedUrl=new URL('../src/owned-process.mjs',import.meta.url).href;
  const script=`import {mock} from 'node:test';let closed=0;mock.module(${JSON.stringify(ownedUrl)},{namedExports:{ownProcess(child){return {capture:async()=>{throw Error('fixture metadata unavailable')},close:async()=>{closed++;if(child.exitCode===null&&child.signalCode===null){const exit=new Promise(r=>child.once('exit',r));child.kill('SIGKILL');await exit;}child.stdin.destroy();child.stdout.destroy();child.stderr.destroy();}}}}});const {createEngine}=await import(${JSON.stringify(engineUrl)});try{await createEngine({codexPath:[process.execPath,${JSON.stringify(fixture)}],cwd:${JSON.stringify(fixtureCwd)},model:'fixture-model',permissions:'allow-everything',scope:'full',webAccess:true,env:process.env});throw Error('unexpected success')}catch(e){if(e.code!=='ENGINE_CLEANUP_UNVERIFIED'||closed!==1)throw e;console.log('OWNED_CLEANUP_ATTEMPTED');}`;
  const result=await runFixtureProcess(process.execPath,['--experimental-test-module-mocks','--input-type=module','-e',script],{timeoutMs:15000});
  assert.equal(result.stdout.trim(),'OWNED_CLEANUP_ATTEMPTED');
});
