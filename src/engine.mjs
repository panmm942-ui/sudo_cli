import { spawn } from 'node:child_process';
import { VERSION } from './version.mjs';
import { validateRuntimeOptions, validateReasoningEffort, validateSupportedEfforts } from './runtime.mjs';

const MAX_LINE_CHARS = 8 * 1024 * 1024;
const isTurn = (turn) => typeof turn?.id === 'string' && turn.id.length > 0 && Array.isArray(turn.items)
  && ['inProgress', 'completed', 'interrupted', 'failed'].includes(turn.status);
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const identifier = value => typeof value === 'string' && value.trim().length > 0 && !/[\u0000-\u001f\u007f]/.test(value);
const only = (value, keys) => Object.keys(value).every(key => keys.includes(key));

/** Native v2 UserInput, without accepting settings or permissions inside input. */
export function normalizeTurnInput(value) {
  if (typeof value === 'string') {
    if (!value.trim()) throw new Error('A turn requires non-empty text or typed input.');
    return [{ type: 'text', text: value, text_elements: [] }];
  }
  if (!Array.isArray(value) || !value.length || value.length > 1024) throw new Error('A turn requires non-empty text or typed input.');
  const invalid = () => { throw new Error('A turn input item does not match the native input schema.'); };
  return value.map(item => {
    if (!object(item)) invalid();
    if (item.type === 'text') {
      if (!only(item, ['type', 'text', 'text_elements']) || typeof item.text !== 'string' || !item.text.trim()) invalid();
      const elements = item.text_elements ?? [];
      if (!Array.isArray(elements) || elements.length > 1024) invalid();
      const text_elements = elements.map(element => {
        const range = element?.byteRange;
        if (!object(element) || !only(element, ['byteRange', 'placeholder']) || !object(range) || !only(range, ['start', 'end'])
          || !Number.isSafeInteger(range.start) || !Number.isSafeInteger(range.end) || range.start < 0 || range.end < range.start || range.end > Buffer.byteLength(item.text)
          || (element.placeholder !== undefined && element.placeholder !== null && typeof element.placeholder !== 'string')) invalid();
        return { byteRange: { ...range }, ...(element.placeholder !== undefined ? { placeholder: element.placeholder } : {}) };
      });
      return { type: 'text', text: item.text, text_elements };
    }
    if (['skill', 'mention'].includes(item.type)) {
      if (!only(item, ['type', 'name', 'path']) || !identifier(item.name) || !identifier(item.path)) invalid();
      return { type: item.type, name: item.name, path: item.path };
    }
    if (['localImage', 'localAudio'].includes(item.type)) {
      if (!only(item, item.type === 'localImage' ? ['type', 'path', 'detail'] : ['type', 'path']) || !identifier(item.path)) invalid();
      if (item.detail !== undefined && !['auto', 'low', 'high', 'original'].includes(item.detail)) invalid();
      return { type: item.type, path: item.path, ...(item.detail !== undefined ? { detail: item.detail } : {}) };
    }
    if (item.type === 'image') {
      if (!only(item, ['type', 'url', 'fileId', 'detail']) || (item.url === undefined) === (item.fileId === undefined)) invalid();
      if (!identifier(item.url ?? item.fileId) || (item.detail !== undefined && !['auto', 'low', 'high', 'original'].includes(item.detail))) invalid();
      return { ...item };
    }
    if (item.type === 'audio' && only(item, ['type', 'url']) && identifier(item.url)) return { ...item };
    invalid();
  });
}

function pageOptions({ cursor, limit } = {}) {
  if (cursor !== undefined && !identifier(cursor)) throw new Error('Native catalog cursor must be a nonempty string.');
  if (limit !== undefined && (!Number.isSafeInteger(limit) || limit < 1 || limit > 1000)) throw new Error('Native catalog limit must be an integer from 1 to 1000.');
  return { ...(cursor !== undefined ? { cursor } : {}), ...(limit !== undefined ? { limit } : {}) };
}

/** Start a private app-server. The caller owns the supplied runtime environment. */
export async function createEngine({
  codexPath = 'codex', cwd = process.cwd(), model, providerArgs = [],
  env = process.env, onEvent = () => {}, onApproval = async () => false,
  requestTimeoutMs = 30_000, permissions = 'ask', webAccess = false, supportedEfforts,
} = {}) {
  const choices = validateRuntimeOptions({ permissions, webAccess });
  const modelEfforts = validateSupportedEfforts(supportedEfforts);
  const approvalPolicy = choices.permissions === 'ask' ? 'on-request' : 'never';
  const sandbox = choices.permissions === 'ask' ? 'workspace-write' : 'danger-full-access';
  let runtimePolicy;
  let instructionSources = [];
  const command = Array.isArray(codexPath) ? codexPath : [codexPath];
  const child = spawn(command[0], [...command.slice(1), '--no-daemon', 'app-server', '--listen', 'stdio://', ...providerArgs], {
    cwd, env, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true, shell: false,
  });
  const pending = new Map();
  let nextId = 1;
  let buffer = '';
  let threadId;
  let active;
  let closed = false;
  let terminalError;
  let closing;
  let exited = false;
  const ended = new Promise((resolve) => child.once('close', () => { exited = true; resolve(); }));

  function finish(record, turn, error) {
    if (record.done) return;
    record.done = true;
    clearTimeout(record.startTimer);
    record.identify();
    if (active === record) active = undefined;
    if (error) record.reject(error);
    else if (!isTurn(turn)) record.reject(new Error('Codex app-server returned an invalid turn response.'));
    else if (turn.status === 'failed') record.reject(new Error(record.effort ? 'Codex turn failed with the requested reasoning effort. Check model support or use Default.' : 'Codex turn failed.'));
    else record.resolve(turn);
  }

  function complete(record, turn) {
    if (!record.acknowledged) {
      if (typeof turn?.id === 'string' && record.early.size < 16) record.early.set(turn.id, turn);
    } else finish(record, turn);
  }

  function identify(record, turn) {
    record.id = turn.id;
    clearTimeout(record.startTimer);
    record.identify();
    if (record.acknowledged && record.early.has(turn.id)) finish(record, record.early.get(turn.id));
  }

  function fail(error) {
    terminalError ??= error;
    for (const call of pending.values()) { clearTimeout(call.timer); call.reject(terminalError); }
    pending.clear();
    if (active) finish(active, undefined, terminalError);
  }

  function send(message) {
    if (terminalError || closed) throw terminalError ?? new Error('Codex engine is closed.');
    child.stdin.write(`${JSON.stringify(message)}\n`, (error) => {
      if (error) fail(new Error('Codex app-server input stream failed.'));
    });
  }

  function request(method, params) {
    return new Promise((resolve, reject) => {
      const id = nextId++;
      const timer = setTimeout(() => {
        fail(new Error(`Codex app-server request timed out (${method}).`));
        child.kill();
      }, requestTimeoutMs);
      pending.set(id, { resolve, reject, timer });
      try { send({ id, method, params }); } catch (error) { fail(error); }
    });
  }

  async function respondToServer(message) {
    const { method, params, id } = message;
    const modern = method === 'item/commandExecution/requestApproval' || method === 'item/fileChange/requestApproval';
    const legacy = method === 'execCommandApproval' || method === 'applyPatchApproval';
    let result;
    if (modern || legacy || method === 'item/permissions/requestApproval') {
      let approved = choices.permissions === 'allow-everything';
      if (!approved) {
        try { approved = (await onApproval({ method, params })) === true; } catch { /* Failed UI means decline. */ }
      }
      if (modern) result = { decision: approved ? 'accept' : 'decline' };
      else if (legacy) result = { decision: approved ? 'approved' : { denied: { rejection: 'Declined by user.' } } };
      else result = { permissions: approved ? params.permissions : {}, scope: 'turn' };
    } else if (method === 'item/tool/requestUserInput') result = { answers: {} };
    else if (method === 'mcpServer/elicitation/request') result = { action: 'decline' };
    else if (method === 'currentTime/read') result = { currentTimeAt: Math.floor(Date.now() / 1000) };
    if (closed || terminalError) return;
    if (result !== undefined) send({ id, result });
    else send({ id, error: { code: -32601, message: 'Unsupported client request.' } });
  }

  child.stdout.setEncoding('utf8');
  child.stdout.on('data', (chunk) => {
    if (terminalError) return;
    buffer += chunk;
    let newline;
    while ((newline = buffer.indexOf('\n')) !== -1) {
      const line = buffer.slice(0, newline);
      buffer = buffer.slice(newline + 1);
      if (line.length > MAX_LINE_CHARS) {
        fail(new Error('Codex app-server output exceeded the message limit.'));
        buffer = '';
        child.kill();
        return;
      }
      let message;
      try { message = JSON.parse(line); } catch { continue; }
      if (!message || Array.isArray(message) || typeof message !== 'object') continue;
      if (typeof message.method === 'string') {
        if (Object.hasOwn(message, 'id')) {
          void respondToServer(message).catch(() => fail(new Error('Codex client response failed.')));
          continue;
        }
        try { Promise.resolve(onEvent({ method: message.method, params: message.params })).catch(() => {}); } catch { /* UI failures cannot break transport. */ }
        if (message.method === 'turn/started' && message.params?.threadId === threadId && active?.kind === 'compact' && !active.id && isTurn(message.params.turn)) {
          identify(active, message.params.turn);
        }
        if (message.method === 'turn/completed' && message.params?.threadId === threadId && active) {
          const turn = message.params.turn;
          if (active.id === turn?.id) complete(active, turn);
          else if (!active.id && typeof turn?.id === 'string' && active.early.size < 16) active.early.set(turn.id, turn);
        }
      } else if (pending.has(message.id)) {
        const call = pending.get(message.id);
        pending.delete(message.id);
        clearTimeout(call.timer);
        if (message.error) call.reject(new Error('Codex app-server rejected the request.'));
        else call.resolve(message.result);
      }
    }
    if (buffer.length > MAX_LINE_CHARS) {
      fail(new Error('Codex app-server output exceeded the message limit.'));
      buffer = '';
      child.kill();
    }
  });
  // Drain stderr so diagnostic output cannot block the process. Never echo raw diagnostics.
  child.stderr.resume();
  child.on('error', () => fail(new Error('Unable to start Codex app-server. Check the codex executable.')));
  child.on('exit', () => fail(new Error('Codex app-server exited.')));
  child.stdin.on('error', () => fail(new Error('Codex app-server input stream failed.')));
  child.stdout.on('error', () => fail(new Error('Codex app-server output stream failed.')));
  child.stdout.on('end', () => { if (!closed) fail(new Error('Codex app-server output stream closed.')); });
  child.stderr.on('error', () => fail(new Error('Codex app-server diagnostic stream failed.')));

  function close() {
    if (closing) return closing;
    closed = true;
    fail(new Error('Codex engine is closed.'));
    closing = (async () => {
      if (exited) return;
      child.stdin.end();
      let timeout;
      await Promise.race([ended, new Promise((resolve) => { timeout = setTimeout(() => { child.kill(); resolve(); }, 1000); })]);
      clearTimeout(timeout);
      if (!exited) {
        let forceTimeout;
        await Promise.race([ended, new Promise((resolve) => { forceTimeout = setTimeout(() => { child.kill('SIGKILL'); resolve(); }, 250); })]);
        clearTimeout(forceTimeout);
      }
    })();
    return closing;
  }

  try {
    await request('initialize', {
      clientInfo: { name: 'sudo_cli', title: 'sudo', version: VERSION },
      capabilities: { experimentalApi: true, explicitGatewayOauth: true },
    });
    send({ method: 'initialized', params: {} });
    const config = { 'sandbox_workspace_write.network_access': choices.webAccess };
    // The host process must still reach the selected model API. This disables
    // hosted web capabilities and restricts sandboxed commands, not API traffic.
    if (!choices.webAccess) config.web_search = 'disabled';
    const result = await request('thread/start', { cwd, model, ephemeral: true, approvalPolicy, approvalsReviewer: 'user', sandbox, config });
    if (typeof result?.thread?.id !== 'string' || !result.thread.id) throw new Error('Codex app-server returned an invalid thread response.');
    if (result.thread.ephemeral !== true) throw new Error('Codex app-server must support ephemeral threads. Update Codex and retry.');
    const actual = result.sandbox;
    const validSandbox = choices.permissions === 'allow-everything' ? actual?.type === 'dangerFullAccess'
      : ['workspaceWrite', 'readOnly'].includes(actual?.type);
    if (result.approvalPolicy !== approvalPolicy || !validSandbox) throw new Error('Codex engine did not apply the requested permission policy.');
    if (choices.permissions === 'ask' && (typeof actual.networkAccess !== 'boolean'
      || (actual.type === 'workspaceWrite' && actual.networkAccess !== choices.webAccess)
      || (actual.type === 'readOnly' && actual.networkAccess))) throw new Error('Codex engine did not apply the requested network policy.');
    // Windows without sandbox setup can return a stricter read-only policy.
    // Expose that actual policy instead of silently claiming workspace access.
    runtimePolicy = { ...choices, approvalPolicy: result.approvalPolicy, sandbox: { ...actual } };
    instructionSources = Array.isArray(result.instructionSources) ? result.instructionSources.filter(identifier) : [];
    threadId = result.thread.id;
  } catch (error) { await close(); throw error; }

  function operation(kind, params, effort) {
    if (terminalError || closed) return Promise.reject(terminalError ?? new Error('Codex engine is closed.'));
    if (active) return Promise.reject(new Error('A Codex turn is already active.'));
    let resolve;
    let reject;
    const completion = new Promise((yes, no) => { resolve = yes; reject = no; });
    let identifyReady;
    const identified = new Promise(yes => { identifyReady = yes; });
    const record = { kind, effort, resolve, reject, identified, identify: identifyReady, early: new Map(), acknowledged: false };
    active = record;
    record.started = request(kind === 'compact' ? 'thread/compact/start' : 'turn/start', { threadId, ...params })
      .then((result) => {
        if (record.done) return;
        record.acknowledged = true;
        if (kind === 'compact') {
          if (!object(result)) throw new Error('Codex app-server returned an invalid compaction response.');
          if (record.id && record.early.has(record.id)) finish(record, record.early.get(record.id));
          else if (!record.id) record.startTimer = setTimeout(() => {
            fail(new Error('Codex compaction start notification timed out.'));
            child.kill();
          }, requestTimeoutMs);
          return;
        }
        const turn = result?.turn;
        if (!isTurn(turn)) throw new Error('Codex app-server returned an invalid turn response.');
        identify(record, turn);
        if (!record.done && turn.status !== 'inProgress') finish(record, turn);
        record.early.clear();
      }).catch((error) => finish(record, undefined, effort && error.message === 'Codex app-server rejected the request.'
        ? new Error('Codex app-server rejected the turn request with the requested reasoning effort. Check model support or use Default.') : error));
    return completion;
  }

  function startTurn(input, { model: turnModel, effort, supportedEfforts: overrideEfforts } = {}) {
    try {
      const normalized = normalizeTurnInput(input);
      if (turnModel !== undefined && !identifier(turnModel)) throw new Error('Turn model must be a nonempty identifier without control characters.');
      const validated = validateReasoningEffort(effort, { supportedEfforts: overrideEfforts !== undefined ? overrideEfforts : modelEfforts });
      return operation('turn', { input: normalized, ...(turnModel !== undefined ? { model: turnModel } : {}), ...(validated !== undefined ? { effort: validated } : {}) }, validated);
    } catch (error) { return Promise.reject(error); }
  }

  const compact = () => operation('compact', {});

  async function catalog(method, params) {
    const result = await request(method, params);
    if (!object(result) || !Array.isArray(result.data)) throw new Error('Codex app-server returned an invalid catalog response.');
    return result;
  }
  function listModels({ cursor, limit, includeHidden } = {}) {
    if (includeHidden !== undefined && typeof includeHidden !== 'boolean') throw new Error('Include hidden models must be a boolean.');
    return catalog('model/list', { ...pageOptions({ cursor, limit }), ...(includeHidden !== undefined ? { includeHidden } : {}) });
  }
  function listSkills({ cwd: skillCwd = cwd, forceReload = false } = {}) {
    if (!identifier(skillCwd) || typeof forceReload !== 'boolean') throw new Error('Skill lookup requires a workspace path and a boolean reload option.');
    return catalog('skills/list', { cwds: [skillCwd], forceReload });
  }
  function listMcpServers({ cursor, limit, serverName, detail = 'toolsAndAuthOnly' } = {}) {
    if (serverName !== undefined && !identifier(serverName)) throw new Error('MCP server name must be a nonempty identifier.');
    if (!['full', 'toolsAndAuthOnly'].includes(detail)) throw new Error('MCP detail must be full or toolsAndAuthOnly.');
    return catalog('mcpServerStatus/list', { threadId, detail, ...pageOptions({ cursor, limit }), ...(serverName !== undefined ? { serverName } : {}) });
  }
  async function listMcpTools() {
    const tools = [];
    const cursors = new Set();
    let cursor;
    do {
      const result = await listMcpServers({ cursor });
      for (const server of result.data) if (identifier(server?.name) && object(server.tools)) {
        for (const [name, tool] of Object.entries(server.tools)) tools.push({ serverName: server.name, name, runtimeStatus: server.runtimeStatus, tool });
      }
      cursor = result.nextCursor ?? undefined;
      if (cursor !== undefined && (!identifier(cursor) || cursors.has(cursor) || cursors.size >= 128)) throw new Error('Codex MCP catalog returned invalid pagination.');
      if (cursor !== undefined) cursors.add(cursor);
    } while (cursor !== undefined);
    return tools;
  }
  async function capabilities() {
    const result = await request('modelProvider/capabilities/read', {});
    if (!object(result) || ['namespaceTools', 'imageGeneration', 'webSearch'].some(key => typeof result[key] !== 'boolean')) throw new Error('Codex app-server returned invalid provider capabilities.');
    return result;
  }

  async function interrupt() {
    const record = active;
    if (!record) return;
    await record.started;
    await record.identified;
    if (active === record && record.id) await request('turn/interrupt', { threadId, turnId: record.id });
  }
  async function steer(input) {
    const normalized = normalizeTurnInput(input);
    const record = active;
    if (!record) throw new Error('Steering requires an active turn.');
    if (record.kind === 'compact') throw new Error('Manual compaction cannot accept same-turn steering.');
    await record.started;
    await record.identified;
    if (active !== record || !record.id) throw new Error('Steering requires an active turn.');
    const result = await request('turn/steer', { threadId, expectedTurnId: record.id, input: normalized });
    if (result?.turnId !== record.id) throw new Error('Codex app-server returned an invalid steering response.');
    return result;
  }
  return { threadId, runtimePolicy, instructionSources, startTurn, compact, steer, listModels, listSkills, listMcpServers, listMcpTools, capabilities, interrupt, close };
}
