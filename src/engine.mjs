import { spawn } from 'node:child_process';
import { VERSION } from './version.mjs';
import { validateRuntimeOptions } from './runtime.mjs';

const MAX_LINE_CHARS = 8 * 1024 * 1024;
const isTurn = (turn) => typeof turn?.id === 'string' && turn.id.length > 0 && Array.isArray(turn.items)
  && ['inProgress', 'completed', 'interrupted', 'failed'].includes(turn.status);

/** Start a private app-server. The caller owns the supplied runtime environment. */
export async function createEngine({
  codexPath = 'codex', cwd = process.cwd(), model, providerArgs = [],
  env = process.env, onEvent = () => {}, onApproval = async () => false,
  requestTimeoutMs = 30_000, permissions = 'ask', webAccess = false,
} = {}) {
  const choices = validateRuntimeOptions({ permissions, webAccess });
  const approvalPolicy = choices.permissions === 'ask' ? 'on-request' : 'never';
  const sandbox = choices.permissions === 'ask' ? 'workspace-write' : 'danger-full-access';
  let runtimePolicy;
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
    if (active === record) active = undefined;
    if (error) record.reject(error);
    else if (!isTurn(turn)) record.reject(new Error('Codex app-server returned an invalid turn response.'));
    else if (turn.status === 'failed') record.reject(new Error('Codex turn failed.'));
    else record.resolve(turn);
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
        if (message.method === 'turn/completed' && message.params?.threadId === threadId && active) {
          const turn = message.params.turn;
          if (active.id === turn?.id) finish(active, turn);
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
    threadId = result.thread.id;
  } catch (error) { await close(); throw error; }

  function startTurn(text, { model: turnModel } = {}) {
    if (terminalError || closed) return Promise.reject(terminalError ?? new Error('Codex engine is closed.'));
    if (active) return Promise.reject(new Error('A Codex turn is already active.'));
    if (typeof text !== 'string' || !text.trim()) return Promise.reject(new Error('A turn requires non-empty text.'));
    let resolve;
    let reject;
    const completion = new Promise((yes, no) => { resolve = yes; reject = no; });
    const record = { resolve, reject, early: new Map() };
    active = record;
    record.started = request('turn/start', { threadId, input: [{ type: 'text', text, text_elements: [] }], ...(turnModel ? { model: turnModel } : {}) })
      .then((result) => {
        const turn = result?.turn;
        if (!isTurn(turn)) throw new Error('Codex app-server returned an invalid turn response.');
        record.id = turn.id;
        if (record.early.has(turn.id)) finish(record, record.early.get(turn.id));
        else if (turn.status !== 'inProgress') finish(record, turn);
        record.early.clear();
      }).catch((error) => finish(record, undefined, error));
    return completion;
  }

  async function interrupt() {
    const record = active;
    if (!record) return;
    await record.started;
    if (active === record) await request('turn/interrupt', { threadId, turnId: record.id });
  }
  return { threadId, runtimePolicy, startTurn, interrupt, close };
}
