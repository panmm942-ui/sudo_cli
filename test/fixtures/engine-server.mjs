import { createInterface } from 'node:readline';
import {spawn} from 'node:child_process';

// node --test discovers helper files under test/; serve only when spawned as the fake Codex command.
if (!process.argv.slice(2).includes('app-server')) process.exit(0);

const scenario = process.env.ENGINE_SCENARIO ?? process.argv[2] ?? 'normal';
const input = createInterface({ input: process.stdin });
let initialized = false;
let threadParams;
let turnsStarted = 0;
const background = new Set(['background-commands', 'background-race'].includes(scenario) ? ['23', '24'] : []);
const commandTerminations = [];
const approvalResponses = {};
const approvalMethods = [
  'item/commandExecution/requestApproval', 'item/fileChange/requestApproval', 'item/permissions/requestApproval',
  'execCommandApproval', 'applyPatchApproval', 'account/chatgptAuthTokens/refresh',
  'item/tool/requestUserInput', 'mcpServer/elicitation/request', 'item/tool/call', 'attestation/generate', 'currentTime/read',
];
const response = (id, result) => process.stdout.write(`${JSON.stringify({ id, result })}\n`);
const event = (method, params) => process.stdout.write(`${JSON.stringify({ method, params })}\n`);
const turn = (status = 'completed', items = []) => ({
  id: 'turn-1', status, items, startedAt: 1, completedAt: status === 'inProgress' ? null : 2,
  durationMs: status === 'inProgress' ? null : 1000, error: status === 'failed' ? { message: 'fixture failure', codexErrorInfo: 'other', additionalDetails: null } : null,
});
if (scenario === 'exit-startup') process.exit(7);
const descendantReady = scenario.startsWith('owned-') ? new Promise(resolve => {
  const worker=spawn(process.execPath,['-e',"process.on('SIGTERM',()=>{});process.send({ready:true});setInterval(()=>{},1000);"],{detached:process.platform==='win32',stdio:['ignore','ignore','ignore','ipc']});
  worker.once('message',()=>{event('fixture/descendant',{pid:worker.pid});resolve();});
}) : Promise.resolve();

input.on('line', async (line) => {
  const message = JSON.parse(line);
  if (!message.method && approvalMethods.includes(message.id)) {
    approvalResponses[message.id] = message.result ?? { error: message.error };
    if (Object.keys(approvalResponses).length === approvalMethods.length) {
      event('turn/completed', { threadId: 'thread-1', turn: turn('completed', [{ id: 'approval-audit', type: 'agentMessage', text: JSON.stringify(approvalResponses), phase: 'final_answer' }]) });
    }
    return;
  }
  if (message.method === 'initialize') {
    await descendantReady;
    if (scenario === 'hang-startup' || scenario==='owned-hang-startup') return;
    if (scenario === 'wrong-id') response(String(message.id), { misleading: true });
    response(message.id, { userAgent: 'fixture/1', codexHome: process.env.CODEX_HOME, platformFamily: 'windows', platformOs: 'windows' });
  } else if (message.method === 'initialized') {
    initialized = true;
  } else if (message.method === 'thread/start') {
    if (!initialized) return process.exit(9);
    threadParams = message.params;
    if (scenario === 'persistent-thread') return response(message.id, { thread: { id: 'thread-1', ephemeral: false } });
    if (scenario === 'bad-thread' || scenario==='owned-bad-thread') return response(message.id, { thread: null });
    let sandbox = message.params.sandbox === 'danger-full-access' ? { type: 'dangerFullAccess' } :message.params.sandbox==='read-only'?{type:'readOnly',networkAccess:false}: { type: 'workspaceWrite', networkAccess: message.params.config?.['sandbox_workspace_write.network_access'] === true,excludeTmpdirEnvVar:message.params.config?.['sandbox_workspace_write.exclude_tmpdir_env_var']===true,excludeSlashTmp:message.params.config?.['sandbox_workspace_write.exclude_slash_tmp']===true };
    if(scenario==='wrong-temp')sandbox={...sandbox,excludeTmpdirEnvVar:false,excludeSlashTmp:false};
    if (scenario === 'wrong-permissions') sandbox = { type: 'dangerFullAccess' };
    if (scenario === 'wrong-network') sandbox = { type: 'workspaceWrite', networkAccess: true };
    if (scenario === 'ignored-network') sandbox = { type: 'workspaceWrite', networkAccess: false };
    if (scenario === 'read-only-fallback') sandbox = { type: 'readOnly', networkAccess: false };
    response(message.id, { thread: { id: 'thread-1', turns: [], ephemeral: true }, model: message.params.model, modelProvider: 'fixture', cwd: message.params.cwd, approvalPolicy: message.params.approvalPolicy, sandbox });
  } else if (message.method === 'model/list') {
    response(message.id, { data: [{ id: 'fixture-model', model: 'fixture-model', supportedReasoningEfforts: [{ reasoningEffort: 'high', description: 'High' }] }], nextCursor: null, received: message.params });
  } else if (message.method === 'thread/backgroundTerminals/list') {
    const data = [...background].map(processId => ({ itemId: 'command-'+processId, processId, command: 'fixture sleep', cwd: process.cwd(), osPid: null }));
    if (scenario === 'background-race') setTimeout(() => response(message.id, { data, nextCursor: null }), 80);
    else response(message.id, { data, nextCursor: null });
  } else if (message.method === 'thread/backgroundTerminals/terminate') {
    commandTerminations.push(message.params);
    response(message.id, { terminated: background.delete(message.params.processId) });
  } else if (message.method === 'skills/list') {
    response(message.id, { data: [{ cwd: message.params.cwds[0], skills: [], errors: [] }], received: message.params });
  } else if (message.method === 'mcpServerStatus/list') {
    response(message.id, { data: [{ name: 'browser', runtimeStatus: 'connected', tools: { click: { name: 'click', description: 'Click a button', inputSchema: { type: 'object' } } } }], nextCursor: null, received: message.params });
  } else if (message.method === 'modelProvider/capabilities/read') {
    response(message.id, { namespaceTools: true, imageGeneration: false, webSearch: false });
  } else if (message.method === 'thread/compact/start') {
    const compactTurn = { ...turn('inProgress'), id: 'compact-turn' };
    const started = () => event('turn/started', { threadId: 'thread-1', turn: compactTurn });
    const completed = () => event('turn/completed', { threadId: 'thread-1', turn: { ...compactTurn, status: 'completed', items: [{ type: 'contextCompaction', id: 'compact-item' }] } });
    if (scenario === 'compact-early') { started(); completed(); return setTimeout(() => response(message.id, {}), 20); }
    response(message.id, {});
    if (scenario === 'compact-no-start') return;
    if (scenario === 'compact-interrupt') return setTimeout(started, 25);
    started();
    event('turn/completed', { threadId: 'other-thread', turn: { ...compactTurn, status: 'completed' } });
    event('turn/completed', { threadId: 'thread-1', turn: { ...compactTurn, id: 'wrong-turn', status: 'completed' } });
    setTimeout(completed, 30);
  } else if (message.method === 'turn/start') {
    turnsStarted++;
    const audit = { argv: process.argv.slice(2), home: process.env.CODEX_HOME, keyPresent: process.env.SUDO_CLI_SESSION_KEY === 'fixture-only', thread: threadParams, params: message.params, commandTerminations };
    const completed = turn('completed', [{ id: 'assistant-1', type: 'agentMessage', text: JSON.stringify(audit), phase: 'final_answer' }]);
    if (scenario === 'exit-turn') return process.exit(6);
    if (scenario === 'oversized-line') return process.stdout.write('x'.repeat(8 * 1024 * 1024 + 1));
    if (scenario === 'request-timeout') return;
    if (scenario === 'bad-turn') return response(message.id, { turn: null });
    if (scenario === 'retry-turn' && turnsStarted === 1) return process.stdout.write(`${JSON.stringify({ id: message.id, error: { code: -32000, message: 'fixture rejected' } })}\n`);
    if (scenario === 'turn-error') return process.stdout.write(`${JSON.stringify({ id: message.id, error: { code: -32000, message: 'fixture rejected' } })}\n`);
    if (scenario === 'early-completion') {
      event('turn/completed', { threadId: 'thread-1', turn: completed });
      return setTimeout(() => response(message.id, { turn: turn('inProgress') }), 20);
    }
    response(message.id, { turn: turn('inProgress') });
    event('turn/started', { threadId: 'thread-1', turn: turn('inProgress') });
    if (['background-commands', 'background-race'].includes(scenario) && turnsStarted === 1) return;
    if (scenario === 'approvals') {
      const common = { threadId: 'thread-1', turnId: 'turn-1', itemId: 'approval-item', startedAtMs: 1000 };
      const permissions = { network: { enabled: true }, fileSystem: { read: [process.cwd()], write: [process.cwd()] } };
      for (const method of approvalMethods) {
        let params = { ...common };
        if (method === 'item/commandExecution/requestApproval') params = { ...common, approvalId: null, availableDecisions: ['accept', 'acceptForSession', 'decline', 'cancel'], command: 'echo fixture', commandActions: [], cwd: process.cwd(), reason: null, environmentId: null };
        if (method === 'item/fileChange/requestApproval') params = { ...common, grantRoot: null, reason: null };
        if (method === 'item/permissions/requestApproval') params = { ...common, cwd: process.cwd(), permissions, reason: 'fixture', environmentId: null };
        if (method === 'execCommandApproval') params = { conversationId: 'thread-1', callId: 'legacy-command', command: ['echo', 'fixture'], cwd: process.cwd(), parsedCmd: [], reason: null, approvalId: null };
        if (method === 'applyPatchApproval') params = { conversationId: 'thread-1', callId: 'legacy-patch', fileChanges: {}, reason: null, grantRoot: null };
        if (method === 'item/tool/requestUserInput') params = { ...common, isBlocking: true, questions: [{ id: 'secret', header: 'Secret', question: 'Token?', isSecret: true, isOther: false, options: null }] };
        if (method === 'mcpServer/elicitation/request') params = { threadId: 'thread-1', turnId: 'turn-1', serverName: 'fixture', mode: 'form', message: 'sensitive details', requestedSchema: { type: 'object' } };
        process.stdout.write(`${JSON.stringify({ id: method, method, params })}\n`);
      }
      return;
    }
    if (scenario === 'hang-turn' || scenario === 'interrupt' || scenario === 'close-turn') return;
    if (scenario === 'failed-turn') return event('turn/completed', { threadId: 'thread-1', turn: turn('failed') });
    process.stdout.write('not json\nnull\n[]\n');
    event('turn/completed', { threadId: 'other-thread', turn: completed });
    const delta = Buffer.from(`${JSON.stringify({ method: 'item/agentMessage/delta', params: { threadId: 'thread-1', turnId: 'turn-1', itemId: 'assistant-1', delta: 'Hello 🌍' } })}\r\n`);
    const cut = delta.indexOf(Buffer.from('🌍')) + 1;
    process.stdout.write(delta.subarray(0, cut));
    setTimeout(() => { process.stdout.write(delta.subarray(cut)); event('turn/completed', { threadId: 'thread-1', turn: completed }); }, 5);
  } else if (message.method === 'turn/steer') {
    response(message.id, { turnId: message.params.expectedTurnId, received: message.params });
  } else if (message.method === 'turn/interrupt') {
    event('turn/completed', { threadId: 'thread-1', turn: { ...turn('interrupted'), id: message.params.turnId } });
    response(message.id, {});
  }
});
input.on('close', () => process.exit(0));
