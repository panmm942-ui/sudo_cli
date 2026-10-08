import { createInterface } from 'node:readline';

// node --test discovers helper files under test/; serve only when spawned as the fake Codex command.
if (!process.argv.slice(2).includes('app-server')) process.exit(0);

const scenario = process.env.ENGINE_SCENARIO ?? 'normal';
const input = createInterface({ input: process.stdin });
let initialized = false;
let threadParams;
let turnsStarted = 0;
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
if (scenario === 'hang-startup') setTimeout(() => process.exit(0), 700);

input.on('line', (line) => {
  const message = JSON.parse(line);
  if (!message.method && approvalMethods.includes(message.id)) {
    approvalResponses[message.id] = message.result ?? { error: message.error };
    if (Object.keys(approvalResponses).length === approvalMethods.length) {
      event('turn/completed', { threadId: 'thread-1', turn: turn('completed', [{ id: 'approval-audit', type: 'agentMessage', text: JSON.stringify(approvalResponses), phase: 'final_answer' }]) });
    }
    return;
  }
  if (message.method === 'initialize') {
    if (scenario === 'hang-startup') return;
    if (scenario === 'wrong-id') response(String(message.id), { misleading: true });
    response(message.id, { userAgent: 'fixture/1', codexHome: process.env.CODEX_HOME, platformFamily: 'windows', platformOs: 'windows' });
  } else if (message.method === 'initialized') {
    initialized = true;
  } else if (message.method === 'thread/start') {
    if (!initialized) return process.exit(9);
    threadParams = message.params;
    if (scenario === 'persistent-thread') return response(message.id, { thread: { id: 'thread-1', ephemeral: false } });
    if (scenario === 'bad-thread') return response(message.id, { thread: null });
    let sandbox = message.params.sandbox === 'danger-full-access' ? { type: 'dangerFullAccess' } : { type: 'workspaceWrite', networkAccess: message.params.config?.['sandbox_workspace_write.network_access'] === true };
    if (scenario === 'wrong-permissions') sandbox = { type: 'dangerFullAccess' };
    if (scenario === 'wrong-network') sandbox = { type: 'workspaceWrite', networkAccess: true };
    if (scenario === 'ignored-network') sandbox = { type: 'workspaceWrite', networkAccess: false };
    if (scenario === 'read-only-fallback') sandbox = { type: 'readOnly', networkAccess: false };
    response(message.id, { thread: { id: 'thread-1', turns: [], ephemeral: true }, model: message.params.model, modelProvider: 'fixture', cwd: message.params.cwd, approvalPolicy: message.params.approvalPolicy, sandbox });
  } else if (message.method === 'turn/start') {
    turnsStarted++;
    const audit = { argv: process.argv.slice(2), home: process.env.CODEX_HOME, keyPresent: process.env.SUDO_CLI_SESSION_KEY === 'fixture-only', thread: threadParams, params: message.params };
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
  } else if (message.method === 'turn/interrupt') {
    event('turn/completed', { threadId: 'thread-1', turn: turn('interrupted') });
    response(message.id, {});
  }
});
input.on('close', () => process.exit(0));
