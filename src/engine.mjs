import { spawn } from 'node:child_process';
import { VERSION } from './version.mjs';
import { validateRuntimeOptions, validateReasoningEffort, validateSupportedEfforts,grantSessionHomeOwner } from './runtime.mjs';
import {permissionPolicy,approvalWithinScope,prepareSandboxRuntime,sandboxExecutionIdentity,sandboxChildEnvironment,createSandboxScratch} from './permission-scope.mjs';
import { prepareCustomModelCatalog } from './model-catalog.mjs';

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
  requestTimeoutMs = 30_000, permissions = 'ask', webAccess = false, scope,writableRoots=[], supportedEfforts, capabilities: declaredCapabilities, developerInstructions, signal,
} = {}) {
  signal?.throwIfAborted();
  if(developerInstructions !== undefined && (typeof developerInstructions!=='string' || Buffer.byteLength(developerInstructions)>65536 || /[\u0000-\u0008\u000b-\u001f\u007f]/.test(developerInstructions)))throw new Error('Developer instructions must be text within 64 KiB.');
  const choices = validateRuntimeOptions({ permissions, webAccess });
  const modelEfforts = validateSupportedEfforts(supportedEfforts);
  const policy=permissionPolicy({...choices,scope:scope|| (permissions==='allow-everything'?'full':'project'),writableRoots});
  const {approvalPolicy,sandbox}=policy;
  const command = Array.isArray(codexPath) ? codexPath : [codexPath];
  const identity=await sandboxExecutionIdentity({cwd,policy});
  if(identity)await grantSessionHomeOwner(env.CODEX_HOME,identity);
  env=sandboxChildEnvironment(env,identity,providerArgs);
  const sandboxRuntime=policy.unrestricted?{path:command[0],cleanup:async()=>{}}:await prepareSandboxRuntime(command[0],{cwd,env,identity});
  let nativeCatalog,scratch;
  try{if(policy.sandbox==='workspace-write'){scratch=await createSandboxScratch({identity});env={...env,TMPDIR:scratch.path,TMP:scratch.path,TEMP:scratch.path};}nativeCatalog=await prepareCustomModelCatalog({ model, providerArgs, supportedEfforts: modelEfforts, capabilities: declaredCapabilities,owner:identity });}
  catch(error){await Promise.all([sandboxRuntime.cleanup(),scratch?.cleanup()]);throw error;}
  if (nativeCatalog) providerArgs = [...providerArgs, '-c', `model_catalog_json=${JSON.stringify(nativeCatalog.path)}`];
  let runtimePolicy;
  let instructionSources = [];
  let child;
  try{child=spawn(sandboxRuntime.path, [...command.slice(1), '--no-daemon', 'app-server', '--listen', 'stdio://', ...providerArgs], {
    cwd, env, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true, shell: false,...identity,
  });}catch(error){await Promise.all([nativeCatalog?.cleanup(),sandboxRuntime.cleanup(),scratch?.cleanup()]);throw error;}
  const pending = new Map();
  let nextId = 1;
  let buffer = '';
  let threadId;
  let active;
  let interruptCleanup;
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
      const inScope=approvalWithinScope({method,params},{...policy,cwd});
      if(!inScope)try{onEvent({method:'sudo/policyDenied',params:{method}});}catch{}
      let approved = inScope && choices.permissions === 'allow-everything';
      if (!approved && inScope) {
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
    signal?.removeEventListener('abort',aborted);
    closing = (async () => {
      try {
      // Turn interruption does not necessarily close unified-exec sessions.
      // Ask the native engine to terminate its own commands before shutdown.
      if (threadId && !terminalError && !exited) {
        let deadline;
        try { await Promise.race([terminateBackgroundCommands(), new Promise(resolve => { deadline = setTimeout(resolve, 500); })]); }
        catch { /* Closing the private app-server is the final cleanup fallback. */ }
        finally { clearTimeout(deadline); }
      }
      closed = true;
      fail(new Error('Codex engine is closed.'));
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
      } finally { await Promise.all([nativeCatalog?.cleanup(),sandboxRuntime.cleanup(),scratch?.cleanup()]); }
    })();
    return closing;
  }

  const aborted=()=>{fail(new DOMException('The model task was aborted.','AbortError'));void close();};
  signal?.addEventListener('abort',aborted,{once:true});
  if(signal?.aborted)aborted();

  try {
    await request('initialize', {
      clientInfo: { name: 'sudo_cli', title: 'sudo', version: VERSION },
      capabilities: { experimentalApi: true, explicitGatewayOauth: true },
    });
    send({ method: 'initialized', params: {} });
    const config = { 'sandbox_workspace_write.network_access': policy.networkAccess,'sandbox_workspace_write.exclude_tmpdir_env_var':true,'sandbox_workspace_write.exclude_slash_tmp':true };
    if(policy.writableRoots.length||scratch)config['sandbox_workspace_write.writable_roots']=[...policy.writableRoots,...(scratch?[scratch.path]:[])];
    // The host process must still reach the selected model API. This disables
    // hosted web capabilities and restricts sandboxed commands, not API traffic.
    if (!policy.networkAccess) config.web_search = 'disabled';
    const result = await request('thread/start', { cwd, model, ephemeral: true, approvalPolicy, approvalsReviewer: 'user', sandbox, config, ...(developerInstructions ? {developerInstructions} : {}) });
    if (typeof result?.thread?.id !== 'string' || !result.thread.id) throw new Error('Codex app-server returned an invalid thread response.');
    if (result.thread.ephemeral !== true) throw new Error('Codex app-server must support ephemeral threads. Update Codex and retry.');
    const actual = result.sandbox;
    const validSandbox = policy.unrestricted ? actual?.type === 'dangerFullAccess'
      : policy.sandbox==='read-only'?actual?.type==='readOnly':['workspaceWrite', 'readOnly'].includes(actual?.type);
    if (result.approvalPolicy !== approvalPolicy || !validSandbox) throw new Error('Codex engine did not apply the requested permission policy.');
    if (!policy.unrestricted && (typeof actual.networkAccess !== 'boolean'
      || (actual.type === 'workspaceWrite' && actual.networkAccess !== policy.networkAccess)
      || (actual.type === 'readOnly' && actual.networkAccess))) throw new Error('Codex engine did not apply the requested network policy.');
    if(actual.type==='workspaceWrite'&&(actual.excludeTmpdirEnvVar!==true||actual.excludeSlashTmp!==true))throw new Error('Codex engine did not apply the requested temporary folder policy.');
    // Windows without sandbox setup can return a stricter read-only policy.
    // Expose that actual policy instead of silently claiming workspace access.
    runtimePolicy = { ...choices,scope:policy.scope,networkEnforced:!policy.unrestricted,approvalPolicy: result.approvalPolicy, sandbox: { ...actual } };
    instructionSources = Array.isArray(result.instructionSources) ? result.instructionSources.filter(identifier) : [];
    threadId = result.thread.id;
  } catch (error) { await close(); throw error; }

  function operation(kind, params, effort) {
    if (terminalError || closed || closing) return Promise.reject(terminalError ?? new Error('Codex engine is closed.'));
    if (interruptCleanup) return interruptCleanup.then(() => operation(kind, params, effort));
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

  function interrupt() {
    if (interruptCleanup) return interruptCleanup;
    const pending = (async () => {
      const record = active;
      if (record) {
        await record.started;
        await record.identified;
        if (active === record && record.id) await request('turn/interrupt', { threadId, turnId: record.id });
      }
      await terminateBackgroundCommands();
    })();
    interruptCleanup = pending;
    pending.finally(() => { if (interruptCleanup === pending) interruptCleanup = undefined; }).catch(() => {});
    return pending;
  }

  async function listBackgroundCommands() {
    const commands = [], cursors = new Set();
    let cursor;
    for (let page = 0; page < 32; page++) {
      const result = await request('thread/backgroundTerminals/list', { threadId, limit: 100, ...(cursor ? { cursor } : {}) });
      if (!object(result) || !Array.isArray(result.data) || result.data.length > 100 || result.data.some(item => !object(item) || !identifier(item.processId) || !identifier(item.itemId))) throw new Error('Codex returned invalid background command metadata.');
      commands.push(...result.data);
      if (!result.nextCursor) return commands;
      if (!identifier(result.nextCursor) || cursors.has(result.nextCursor)) throw new Error('Codex returned an invalid background command cursor.');
      cursors.add(result.nextCursor); cursor = result.nextCursor;
    }
    throw new Error('Codex background command catalog exceeded its page limit.');
  }

  async function terminateBackgroundCommand(processId) {
    if (!identifier(processId) || !/^\d{1,16}$/.test(processId)) throw new Error('A native background process ID is required.');
    const result = await request('thread/backgroundTerminals/terminate', { threadId, processId });
    if (!object(result) || typeof result.terminated !== 'boolean') throw new Error('Codex returned an invalid background command termination result.');
    return result.terminated;
  }

  async function terminateBackgroundCommands() {
    let terminated = 0;
    for (const command of await listBackgroundCommands()) if (await terminateBackgroundCommand(command.processId)) terminated++;
    return { terminated };
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
  return { threadId, runtimePolicy, instructionSources, startTurn, compact, steer, listModels, listSkills, listMcpServers, listMcpTools, listBackgroundCommands, terminateBackgroundCommand, terminateBackgroundCommands, capabilities, interrupt, close };
}
