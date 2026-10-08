import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { spawn } from 'node:child_process';
import { mkdtemp, rm, readFile, readdir, mkdir, writeFile, chmod, chown, lstat } from 'node:fs/promises';
import { tmpdir } from './fixtures/temp-root.mjs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { localCodex } from '../src/local-engine.mjs';
import { startBridge } from '../src/bridge.mjs';
import { createEngine } from '../src/engine.mjs';
import { providerArgs, createSessionHome } from '../src/runtime.mjs';
import { createWorkMeter } from '../src/work-meter.mjs';

test('native MCP disabled_tools removes computer actions while retaining other server tools', { timeout: 45000 }, async (t) => {
  let enginePath;
  try { enginePath = localCodex(); } catch { t.skip('Install Codex engine to run its real integration'); return; }
  const workspace = await mkdtemp(join(tmpdir(), 'codexcli-mcp-policy-'));
  const requests = [];
  const server = createServer(async (req, res) => {
    let raw = '';
    for await (const chunk of req) raw += chunk;
    requests.push(JSON.parse(raw));
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ id: 'chatcmpl-mcp-policy', object: 'chat.completion', model: 'fixture-model', choices: [{ index: 0, message: { role: 'assistant', content: 'Native tool policy checked.' }, finish_reason: 'stop' }] }));
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const home = await createSessionHome();
  let engine, bridge;
  t.after(async () => { await engine?.close(); await bridge?.close(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); await home.cleanup(); await rm(workspace, { recursive: true, force: true }); });
  const connection = { model: 'fixture-model', baseUrl: `http://127.0.0.1:${server.address().port}/v1`, transport: 'chat-completions' };
  bridge = await startBridge(connection);
  const fixture = fileURLToPath(new URL('./fixtures/mcp-server.mjs', import.meta.url));
  engine = await createEngine({ codexPath: enginePath, cwd: workspace, model: connection.model,
    providerArgs: [...providerArgs(connection, { baseUrl: bridge.baseUrl }), '-c', `mcp_servers.fixture.command=${JSON.stringify(process.execPath)}`, '-c', `mcp_servers.fixture.args=${JSON.stringify([fixture, '--serve-mcp'])}`, '-c', 'mcp_servers.fixture.disabled_tools=["browser_click"]'],
    env: { ...process.env, CODEX_HOME: home.path, SUDO_CLI_SESSION_KEY: bridge.token } });
  assert.equal((await engine.startTurn('List available tools without calling them.')).status, 'completed');
  const tools = await engine.listMcpTools();
  assert.ok(tools.some(tool => tool.tool?.name === 'add_numbers'));
  assert.ok(!tools.some(tool => tool.tool?.name === 'browser_click'));
  const declarations = JSON.stringify(requests[0].tools);
  assert.ok(declarations.includes('add_numbers'));
  assert.ok(!declarations.includes('browser_click'));
});

test('native engine discovers workspace skills, loads typed skill input, propagates reasoning and completes manual compaction', { timeout: 60000 }, async (t) => {
  let enginePath;
  try { enginePath = localCodex(); } catch { t.skip('Install Codex engine to run its real integration'); return; }
  const workspace = await mkdtemp(join(tmpdir(), 'codexcli-native-features-'));
  const skillPath = join(workspace, '.agents', 'skills', 'fixture-review', 'SKILL.md');
  await mkdir(join(workspace, '.agents', 'skills', 'fixture-review'), { recursive: true });
  await writeFile(skillPath, '---\nname: fixture-review\ndescription: Review local fixture content.\n---\nFixture native skill instruction: use a short response.\n');
  await writeFile(join(workspace, 'AGENTS.md'), 'Fixture workspace instruction: be concise.\n');
  const requests = [];
  const server = createServer(async (req, res) => {
    let raw = '';
    for await (const chunk of req) raw += chunk;
    requests.push(JSON.parse(raw));
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ id: `chatcmpl-native-${requests.length}`, object: 'chat.completion', model: 'fixture-model', choices: [{ index: 0, message: { role: 'assistant', content: 'Native feature fixture summary.' }, finish_reason: 'stop' }], usage: { prompt_tokens: 50, completion_tokens: 5, total_tokens: 55 } }));
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const home = await createSessionHome();
  const nativeEvents = [];
  let engine, bridge;
  t.after(async () => { await engine?.close(); await bridge?.close(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); await home.cleanup(); await rm(workspace, { recursive: true, force: true }); });
  const connection = { model: 'fixture-model', baseUrl: `http://127.0.0.1:${server.address().port}/v1`, transport: 'chat-completions', supportedEfforts: ['high'] };
  bridge = await startBridge(connection);
  engine = await createEngine({ codexPath: enginePath, cwd: workspace, model: connection.model, supportedEfforts: connection.supportedEfforts, onEvent: event => nativeEvents.push(event),
    providerArgs: providerArgs(connection, { baseUrl: bridge.baseUrl }), env: { ...process.env, CODEX_HOME: home.path, SUDO_CLI_SESSION_KEY: bridge.token } });
  const skills = await engine.listSkills({ forceReload: true });
  const skill = skills.data.flatMap(group => group.skills).find(skill => skill.name === 'fixture-review');
  assert.ok(skill, 'The native engine must discover the workspace SKILL.md');
  assert.ok(engine.instructionSources.some(path => path.endsWith('AGENTS.md')));
  assert.ok(Array.isArray((await engine.listModels({ limit: 1 })).data));
  assert.ok(Array.isArray((await engine.listMcpServers()).data));
  assert.equal(typeof (await engine.capabilities()).namespaceTools, 'boolean');
  const completed = await engine.startTurn([{ type: 'skill', name: skill.name, path: skill.path }, { type: 'text', text: 'Review this native fixture.' }], { effort: 'high' });
  assert.equal(completed.status, 'completed');
  assert.equal(requests[0].reasoning_effort, 'high');
  assert.ok(JSON.stringify(requests[0].messages).includes('Fixture native skill instruction'));
  const compacted = await engine.compact();
  assert.equal(compacted.status, 'completed');
  assert.ok(nativeEvents.some(event => event.method === 'item/completed' && event.params?.item?.type === 'contextCompaction'), 'Native compaction must emit its completed item');
  assert.ok(requests.length >= 2, 'Compaction must actually call the model');
  assert.equal((await engine.startTurn('Continue after compaction.')).status, 'completed');
  assert.ok(JSON.stringify(requests.at(-1).messages).includes('Native feature fixture summary.'));
});

test('actual Codex app-server runs a sudo cli task through the compatibility bridge', { timeout: 45000 }, async (t) => {
  const {isElevated}=await import('../src/privileges.mjs');if(!await isElevated()){t.skip('A verified Administrator/root token is required for CLI model sessions.');return;}
  let enginePath;
  try { enginePath = localCodex(); } catch { t.skip('Install Codex engine to run its real integration'); return; }
  const workspace = await mkdtemp(join(tmpdir(), 'sudo-cli-e2e-'));
  const requests = [];
  const server = createServer(async (req, res) => {
    let body = '';
    for await (const chunk of req) body += chunk;
    requests.push({ path: req.url, body: JSON.parse(body), authorization: req.headers.authorization });
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ id: 'chatcmpl-local-fixture', object: 'chat.completion', created: 1, model: 'fixture-model', choices: [{ index: 0, message: { role: 'assistant', content: 'sudo cli integration verified' }, finish_reason: 'stop' }], usage: { prompt_tokens: 50, completion_tokens: 5, total_tokens: 55 } }));
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  let child;
  t.after(async () => { child?.kill(); server.closeAllConnections(); await new Promise(r => server.close(r)); await rm(workspace, { recursive: true, force: true }); });
  child = spawn(process.execPath, [fileURLToPath(new URL('../bin/sudo-cli.mjs', import.meta.url)), '--once', 'Reply with the integration confirmation.', '--model', 'fixture-model', '--base-url', `http://127.0.0.1:${server.address().port}/v1`, '--cwd', workspace], {
    env: { ...process.env, SUDO_CLI_CODEX: enginePath, SUDO_CLI_API_KEY: 'test-key-not-real', SUDO_CLI_STATE_DIR: join(workspace, 'state'), NO_COLOR: '1' }, shell: false, windowsHide: true,
  });
  let stdout = '', stderr = '';
  child.stdout.on('data', chunk => stdout += chunk);
  child.stderr.on('data', chunk => stderr += chunk);
  const [code] = await once(child, 'exit');
  assert.equal(code, 0, stderr);
  assert.match(stdout, /sudo cli integration verified/);
  assert.doesNotMatch(stdout + stderr, /test-key-not-real/);
  assert.equal(requests.length, 1);
  assert.equal(requests[0].path, '/v1/chat/completions');
  assert.equal(requests[0].authorization, 'Bearer test-key-not-real');
  assert.equal(requests[0].body.model, 'fixture-model');
  assert.ok(requests[0].body.messages.some(msg => typeof msg.content === 'string' && msg.content.includes('integration confirmation')));
  assert.ok(requests[0].body.tools.length > 0, 'The real engine must expose execution tools');
});

test('actual Codex engine executes a model tool call inside the selected workspace', { timeout: 45000 }, async (t) => {
  let enginePath;
  try { enginePath = localCodex(); } catch { t.skip('Install Codex engine to run its real integration'); return; }
  const workspace = await mkdtemp(join(tmpdir(), 'sudo-cli-tool-e2e-'));
  const requests = [];
  const server = createServer(async (req, res) => {
    let raw = '';
    for await (const chunk of req) raw += chunk;
    const body = JSON.parse(raw);
    requests.push(body);
    const tool = body.messages.findLast(msg => msg.role === 'tool');
    const message = tool ? { role: 'assistant', content: 'Workspace file created.' } : {
      role: 'assistant', content: null, tool_calls: [{ id: 'call_workspace_test', type: 'function', function: {
        name: 'exec_command', arguments: JSON.stringify({
          cmd: process.platform === 'win32' ? "Set-Content -LiteralPath proof.txt -Value 'sudo tool verified'; Set-Content -LiteralPath env-proof.txt -Value (-not (Test-Path env:SUDO_CLI_SESSION_KEY) -and -not (Test-Path env:SUDO_MCP_FIXTURE))" : "printf 'sudo tool verified\\n' > proof.txt; if test -z \"${SUDO_CLI_SESSION_KEY-}\" && test -z \"${SUDO_MCP_FIXTURE-}\"; then printf 'True' > env-proof.txt; else printf 'False' > env-proof.txt; fi",
          workdir: workspace, login: false, max_output_tokens: 1000,
        }),
      } }],
    };
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ id: `chatcmpl-tool-${requests.length}`, object: 'chat.completion', created: 1, model: 'fixture-model', choices: [{ index: 0, message, finish_reason: tool ? 'stop' : 'tool_calls' }] }));
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const home = await createSessionHome();
  let engine, bridge;
  t.after(async () => { await engine?.close(); await bridge?.close(); server.closeAllConnections(); await new Promise(r => server.close(r)); await home.cleanup(); await rm(workspace, { recursive: true, force: true }); });
  const connection = { model: 'fixture-model', baseUrl: `http://127.0.0.1:${server.address().port}/v1`, transport: 'chat-completions' };
  bridge = await startBridge(connection);
  const approvals = [];
  engine = await createEngine({ codexPath: enginePath, cwd: workspace, model: connection.model,
    scope:'full',webAccess:true,
    providerArgs: providerArgs(connection, { baseUrl: bridge.baseUrl,scope:'full',webAccess:true }),
    env: { ...process.env, CODEX_HOME: home.path, SUDO_CLI_SESSION_KEY: bridge.token,SUDO_MCP_FIXTURE:'fixture-bearer-not-for-tools' },
    onApproval: async ({ method, params }) => {
      approvals.push({ method, command: params.command });
      // This local fixture is explicitly allowed to perform only its known workspace write.
      return method === 'item/commandExecution/requestApproval' && String(params.command).includes('proof.txt') && String(params.command).includes('sudo tool verified');
    },
  });
  const completed = await engine.startTurn('Create proof.txt in this workspace.');
  assert.equal(completed.status, 'completed');
  assert.equal(requests.length, 2);
  assert.ok(completed.items.some(item => item.type === 'agentMessage' && item.text.includes('Workspace file created')));
  const proof = await readFile(join(workspace, 'proof.txt'), 'utf8').catch(error => { throw new Error(`${error.code}: ${JSON.stringify(requests[1].messages.filter(msg => msg.role === 'tool'))}`); });
  assert.match(proof, /sudo tool verified/);
  assert.match(await readFile(join(workspace,'env-proof.txt'),'utf8'),/True/);
  assert.ok(requests[1].messages.some(msg => msg.role === 'tool' && msg.tool_call_id === 'call_workspace_test'));
});

test('sudo native model tools use the admitted private project owner and disposable resources',{skip:process.platform!=='linux'||process.getuid?.()!==0,timeout:45000},async t=>{
  let enginePath;try{enginePath=localCodex();}catch{t.skip('Install the pinned native Linux runtime.');return;}
  const account=(await readFile('/etc/passwd','utf8')).split('\n').map(line=>line.split(':')).find(parts=>Number(parts[2])>=1000&&Number(parts[2])<65534)||['nobody','x','65534','65534'];const uid=Number(account[2]),gid=Number(account[3]);
  const root=await mkdtemp(join(tmpdir(),'sudo-native-private-project-'));await chmod(root,0o755);
  const ownerHome=join(root,'owner'),workspace=join(ownerHome,'project'),other=join(root,'other-private');await mkdir(ownerHome,{mode:0o750});await chown(ownerHome,uid,gid);await mkdir(workspace,{mode:0o755});await chown(workspace,uid,gid);await mkdir(other,{mode:0o700});await writeFile(join(other,'secret'),'private root marker');
  const names=['SUDO_UID','SUDO_GID','SUDO_USER'],saved=Object.fromEntries(names.map(name=>[name,process.env[name]]));Object.assign(process.env,{SUDO_UID:String(uid),SUDO_GID:String(gid),SUDO_USER:account[0]});
  const requests=[],outside=join(ownerHome,'outside.txt');
  const script=`const fs=require('node:fs'),path=require('node:path');const report={uid:process.getuid(),gid:process.getgid(),groups:process.getgroups(),rawKey:!!process.env.OPENAI_API_KEY,bridgeKey:!!process.env.SUDO_CLI_SESSION_KEY,scratch:process.env.TMPDIR,outside:false,otherHome:false};fs.writeFileSync(path.join(report.scratch,'compiler-temporary'),'permitted');try{fs.writeFileSync(${JSON.stringify(outside)},'escaped');report.outside=true}catch{}try{fs.readFileSync(${JSON.stringify(join(other,'secret'))});report.otherHome=true}catch{}fs.writeFileSync('proof.json',JSON.stringify(report));console.log('PRIVATE_PROJECT_MODEL_PASS');`;
  const quoted=script.replaceAll("'","'\"'\"'"),nodeQuoted=process.execPath.replaceAll("'","'\"'\"'");
  const server=createServer(async(req,res)=>{let raw='';for await(const chunk of req)raw+=chunk;const body=JSON.parse(raw);requests.push({body,authorization:req.headers.authorization});const tool=body.messages.findLast(message=>message.role==='tool');const message=tool?{role:'assistant',content:'Private project verified.'}:{role:'assistant',content:null,tool_calls:[{id:'call_private_project',type:'function',function:{name:'exec_command',arguments:JSON.stringify({cmd:`'${nodeQuoted}' -e '${quoted}'`,workdir:workspace,login:false,max_output_tokens:1000})}}]};res.writeHead(200,{'content-type':'application/json'});res.end(JSON.stringify({id:`chat-private-${requests.length}`,object:'chat.completion',created:1,model:'private-sudo-fixture',choices:[{index:0,message,finish_reason:tool?'stop':'tool_calls'}]}));});
  server.listen(0,'127.0.0.1');await once(server,'listening');const home=await createSessionHome();let engine,bridge;
  t.after(async()=>{await engine?.close();await bridge?.close();server.closeAllConnections();await new Promise(resolve=>server.close(resolve));await home.cleanup();await rm(root,{recursive:true,force:true});for(const name of names)if(saved[name]===undefined)delete process.env[name];else process.env[name]=saved[name];});
  const connection={model:'private-sudo-fixture',baseUrl:`http://127.0.0.1:${server.address().port}/v1`,transport:'chat-completions',apiKey:'synthetic-provider-key-root-only'};bridge=await startBridge(connection);
  engine=await createEngine({codexPath:enginePath,cwd:workspace,model:connection.model,providerArgs:providerArgs(connection,{baseUrl:bridge.baseUrl,scope:'project',webAccess:false}),scope:'project',webAccess:false,env:{...process.env,CODEX_HOME:home.path,SUDO_CLI_SESSION_KEY:bridge.token,OPENAI_API_KEY:'synthetic-root-secret'},onApproval:async()=>false});
  const completed=await engine.startTurn('Verify this private project.');assert.equal(completed.status,'completed');assert.equal(requests.length,2);assert.ok(requests.every(request=>request.authorization==='Bearer synthetic-provider-key-root-only'));
  const toolResult=String(requests.at(-1).body.messages.findLast(message=>message.role==='tool')?.content||'');assert.match(toolResult,/^Process exited with code 0$/m,toolResult.slice(0,2000));assert.match(toolResult,/^PRIVATE_PROJECT_MODEL_PASS$/m,toolResult.slice(0,2000));
  const report=JSON.parse(await readFile(join(workspace,'proof.json'),'utf8'));assert.equal(report.uid,uid);assert.equal(report.gid,gid);assert.ok(report.groups.every(group=>group===gid));assert.deepEqual({...report,uid:0,gid:0,groups:[],scratch:null},{uid:0,gid:0,groups:[],scratch:null,rawKey:false,bridgeKey:false,outside:false,otherHome:false});assert.equal((await lstat(home.path)).uid,uid);assert.equal((await lstat(ownerHome)).mode&0o777,0o750);assert.equal((await lstat(join(workspace,'proof.json'))).uid,uid);assert.notEqual(report.scratch,home.path);assert.equal((await lstat(report.scratch)).uid,uid);await engine.close();await assert.rejects(lstat(report.scratch),{code:'ENOENT'});
  await assert.rejects(lstat(outside),{code:'ENOENT'});t.diagnostic('Two loopback model requests; zero paid requests. Root proxy retained provider key, native model/tool processes used admitted UID.');
});

test('native Responses monitoring passes through real engine output and retains numeric work totals across launches', { timeout: 45000 }, async (t) => {
  const {isElevated}=await import('../src/privileges.mjs');if(!await isElevated()){t.skip('A verified Administrator/root token is required for CLI model sessions.');return;}
  let enginePath;
  try { enginePath = localCodex(); } catch { t.skip('Install Codex engine to run its real integration'); return; }
  const workspace = await mkdtemp(join(tmpdir(), 'sudo-cli-responses-e2e-'));
  const stateDir = join(workspace, 'state');
  const key = 'fixture-stream-key-do-not-print';
  const requests = [];
  const records = async () => Promise.all((await readdir(stateDir)).filter(name => name.endsWith('.json')).map(async name => ({ name, value: JSON.parse(await readFile(join(stateDir, name), 'utf8')) })));
  let stateAtSecondRequest;
  const server = createServer(async (req, res) => {
    let raw = '';
    for await (const chunk of req) raw += chunk;
    requests.push({ path: req.url, body: JSON.parse(raw), auth: req.headers.authorization });
    if (requests.length === 2) stateAtSecondRequest = await records();
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    const content = `Native stream ${key} verified.`;
    const item = { type: 'message', id: 'msg_native', role: 'assistant', content: [{ type: 'output_text', text: content, annotations: [] }] };
    const events = [
      { type: 'response.created', response: { id: 'resp_native', status: 'in_progress', output: [] } },
      { type: 'response.output_item.added', output_index: 0, item: { ...item, content: [] } },
      ...['Native stream fixture-stream-', 'key-do-not-print verified.'].map(delta => ({ type: 'response.output_text.delta', item_id: item.id, output_index: 0, content_index: 0, delta })),
      { type: 'response.output_item.done', output_index: 0, item },
      { type: 'response.completed', response: { id: 'resp_native', status: 'completed', output: [item], usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 } } },
    ];
    for (const event of events) res.write(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`);
    res.end();
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  let child;
  t.after(async () => { child?.kill(); server.closeAllConnections(); await new Promise(r => server.close(r)); await rm(workspace, { recursive: true, force: true }); });
  const run = async () => {
    child = spawn(process.execPath, [fileURLToPath(new URL('../bin/sudo-cli.mjs', import.meta.url)), '--once', 'Test the native stream.', '--model', 'fixture-model', '--context-window','131072','--transport', 'responses', '--base-url', `http://127.0.0.1:${server.address().port}/v1`, '--cwd', workspace], {
      env: { ...process.env, SUDO_CLI_CODEX: enginePath, SUDO_CLI_API_KEY: key, SUDO_CLI_STATE_DIR: stateDir, NO_COLOR: '1' }, shell: false, windowsHide: true,
    });
    let stdout = '', stderr = '';
    child.stdout.on('data', chunk => stdout += chunk);
    child.stderr.on('data', chunk => stderr += chunk);
    const [code] = await once(child, 'exit');
    assert.equal(code, 0, stderr);
    assert.match(stdout, /Native stream \[redacted\] verified\./);
    assert.doesNotMatch(stdout + stderr, /fixture-stream-key-do-not-print/);
  };
  await run();
  assert.equal(requests.length, 1);
  assert.equal(requests[0].path, '/v1/responses');
  assert.equal(requests[0].auth, `Bearer ${key}`);
  const first = await records();
  assert.equal(first.length, 1);
  assert.ok(first[0].value.activeMs > 0, 'The first launch must checkpoint real active work');
  await run();
  assert.equal(requests.length, 2);
  const replay=JSON.stringify(requests[1].body);
  assert.match(replay,/prior conversation/);
  assert.match(replay,/Native stream \[redacted\] verified/);
  const {createChatStore}=await import('../src/chat-store.mjs');const chats=await createChatStore({stateDir,cwd:workspace});const saved=await chats.last();
  assert.equal(saved.history.messages.length,4,'Both launches must append to the same automatically saved chat.');
  assert.doesNotMatch(JSON.stringify(saved),/fixture-stream-key-do-not-print/);
  assert.equal(stateAtSecondRequest.length, 2);
  assert.equal(stateAtSecondRequest.find(record => record.name !== first[0].name).value.activeMs, 0, 'The new session must start from zero while the first duration remains stored');
  const final = await records();
  assert.equal(final.length, 2);
  assert.deepEqual(final.find(record => record.name === first[0].name).value, first[0].value, 'A new launch must not overwrite previous active time');
  for (const { value } of final) {
    assert.deepEqual(Object.keys(value).sort(), ['activeMs', 'version']);
    assert.ok(Object.values(value).every(number => typeof number === 'number'));
    assert.ok(value.activeMs > 0);
  }
  const totals = await createWorkMeter({ stateDir, checkpointMs: 0 });
  try {
    assert.equal(totals.snapshot().sessionMs, 0);
    assert.equal(totals.snapshot().totalMs, final[0].value.activeMs + final[1].value.activeMs);
  } finally { await totals.close(); }
});
