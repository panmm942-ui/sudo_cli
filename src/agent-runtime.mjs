import { stat } from 'node:fs/promises';
import { resolve } from 'node:path';
import { createEngine, normalizeTurnInput } from './engine.mjs';
import { startBridge } from './bridge.mjs';
import { startResponsesMonitor } from './responses-monitor.mjs';
import { validateConnection, validateRuntimeOptions, validateReasoningEffort, providerArgs, createSessionHome } from './runtime.mjs';
import { localCodex } from './local-engine.mjs';
import { enabledMcpEntries } from './computer-policy.mjs';
import { parseMcpEntry } from './commands.mjs';
import { createRedactor } from './redactor.mjs';

const abortError = () => new DOMException('Agent task was cancelled.', 'AbortError');
const checkAbort = signal => { if (signal?.aborted) throw abortError(); };
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const mapEntries = value => value instanceof Map ? [...value] : Array.isArray(value) ? value : object(value) ? Object.entries(value) : [];

function runtimeSettings(settings, connection) {
  if (!object(settings)) throw new Error('Agent settings must be an object.');
  const choices = validateRuntimeOptions(settings);
  const effort = validateReasoningEffort(settings.effort, { supportedEfforts: connection.supportedEfforts });
  if (settings.computerUse !== undefined && typeof settings.computerUse !== 'boolean') throw new Error('Computer Use must be a boolean.');
  if (settings.mcp !== undefined && !(settings.mcp instanceof Map) && !Array.isArray(settings.mcp) && !object(settings.mcp)) throw new Error('MCP settings must be a map of named HTTP endpoints.');
  const mcp = new Map();
  for (const entry of mapEntries(settings.mcp)) {
    if (!Array.isArray(entry) || entry.length !== 2 || typeof entry[0] !== 'string' || typeof entry[1] !== 'string') throw new Error('MCP settings must be named HTTP endpoints.');
    const { name, url } = parseMcpEntry(`${entry[0]}=${entry[1]}`);
    if (mcp.has(name)) throw new Error('Duplicate MCP server name.');
    mcp.set(name, url);
  }
  const disabledComputerTools = new Map();
  for (const [name, tools] of mapEntries(settings.disabledComputerTools)) {
    if (!mcp.has(name) || !Array.isArray(tools) || tools.length > 1024 || tools.some(tool => typeof tool !== 'string' || !tool || tool.length > 512 || /[\u0000-\u001f\u007f]/.test(tool))) throw new Error('Computer-tool filters must contain bounded native tool names for configured servers.');
    disabledComputerTools.set(name, [...new Set(tools)]);
  }
  const computerServers = settings.computerServers instanceof Set ? new Set(settings.computerServers) : new Set(settings.computerServers ?? []);
  if ([...computerServers].some(name => typeof name !== 'string')) throw new Error('Computer server names must be strings.');
  return { ...choices, effort, mcp, computerUse: settings.computerUse ?? true, computerServers, disabledComputerTools };
}

/** One isolated native Codex task; no persistent auth/config or raw-chat tool emulation. */
export async function runAgentTask({ connection: inputConnection, cwd = process.cwd(), settings = {}, prompt, developerInstructions, signal, onEvent = () => {}, onApproval, runtime = {} } = {}) {
  checkAbort(signal);
  const connection = validateConnection(inputConnection);
  const choices = runtimeSettings(settings, connection);
  const input = normalizeTurnInput(prompt);
  if (Buffer.byteLength(JSON.stringify(input)) > 8 * 1024 * 1024) throw new Error('Agent task input exceeds its 8 MiB limit.');
  if (developerInstructions !== undefined && (typeof developerInstructions !== 'string' || Buffer.byteLength(developerInstructions) > 65536)) throw new Error('Agent developer instructions must be text within 64 KiB.');
  if (typeof cwd !== 'string' || !cwd || /[\u0000-\u001f\u007f]/.test(cwd)) throw new Error('Agent project directory is invalid.');
  cwd = resolve(cwd);
  if (!(await stat(cwd).catch(() => null))?.isDirectory()) throw new Error('Agent project directory does not exist.');
  if (!object(runtime) || typeof onEvent !== 'function' || (onApproval !== undefined && typeof onApproval !== 'function')) throw new Error('Agent runtime callbacks are invalid.');
  if (runtime.requestTimeoutMs !== undefined && (!Number.isSafeInteger(runtime.requestTimeoutMs) || runtime.requestTimeoutMs < 1 || runtime.requestTimeoutMs > 2147483647)) throw new Error('Agent native request timeout must be a positive bounded integer.');
  const modelTimeoutMs = runtime.modelTimeoutMs ?? 120000;
  if (!Number.isSafeInteger(modelTimeoutMs) || modelTimeoutMs < 1 || modelTimeoutMs > 2147483647) throw new Error('Agent model timeout must be a positive bounded integer.');
  const secrets = [connection.apiKey].filter(Boolean);
  const safe = text => { const redactor = createRedactor({ secrets: () => secrets }); return redactor.write(text) + redactor.flush(); };
  let engine, bridge, home, collectionError;
  const messages = new Map();
  let outputBytes = 0;
  function collect(id, text, append = false) {
    if (typeof id !== 'string' || typeof text !== 'string') return;
    const prior = messages.get(id) ?? '';
    const next = append ? prior + text : text;
    outputBytes += Buffer.byteLength(next) - Buffer.byteLength(prior);
    if (messages.size >= 1024 && !messages.has(id) || outputBytes > 16 * 1024 * 1024) {
      collectionError = new Error('Agent task output exceeds its collection limit.');
      void engine?.close().catch(() => {});
      return;
    }
    messages.set(id, next);
  }
  const event = notification => {
    const { method, params = {} } = notification;
    if (!engine || !params.threadId || params.threadId === engine.threadId) {
      if (method === 'item/agentMessage/delta') collect(params.itemId, params.delta, true);
      else if (method === 'item/completed' && params.item?.type === 'agentMessage') collect(params.item.id, params.item.text);
      else if (method === 'turn/completed') for (const item of params.turn?.items ?? []) if (item.type === 'agentMessage') collect(item.id, item.text);
    }
    // Foreground callers receive native events and remain responsible for display redaction.
    try { Promise.resolve(onEvent(notification)).catch(() => {}); } catch { /* Display failures must not break native transport. */ }
  };
  let rejectAborted;
  const aborted = new Promise((_, reject) => { rejectAborted = reject; });
  aborted.catch(() => {});
  const abort = () => {
    rejectAborted(abortError());
    void engine?.interrupt().catch(() => {});
  };
  signal?.addEventListener('abort', abort, { once: true });
  try {
    checkAbort(signal);
    home = await createSessionHome(runtime.baseDir ? { baseDir: runtime.baseDir } : undefined);
    checkAbort(signal);
    const env = { ...(runtime.env ?? process.env), CODEX_HOME: home.path, SUDO_CLI_SESSION_KEY: connection.apiKey || '' };
    bridge = await (connection.transport === 'chat-completions' ? startBridge : startResponsesMonitor)({ baseUrl: connection.baseUrl, model: connection.model, apiKey: connection.apiKey, timeoutMs: modelTimeoutMs });
    secrets.push(bridge.token); env.SUDO_CLI_SESSION_KEY = bridge.token;
    checkAbort(signal);
    const args = providerArgs(connection, { baseUrl: bridge.baseUrl, keyEnv: 'SUDO_CLI_SESSION_KEY', permissions: choices.permissions, webAccess: choices.webAccess });
    for (const [name, url] of enabledMcpEntries(choices)) {
      args.push('-c', `mcp_servers.${name}.url=${JSON.stringify(url)}`);
      const disabled = choices.disabledComputerTools.get(name);
      if (choices.computerUse === false && disabled?.length) args.push('-c', `mcp_servers.${name}.disabled_tools=${JSON.stringify(disabled)}`);
    }
    engine = await createEngine({ codexPath: runtime.codexPath ?? localCodex({ env }), cwd, model: connection.model, providerArgs: args, env, signal, developerInstructions,
      ...(runtime.requestTimeoutMs !== undefined ? { requestTimeoutMs: runtime.requestTimeoutMs } : {}),
      permissions: choices.permissions, webAccess: choices.webAccess, supportedEfforts: connection.supportedEfforts, onEvent: event,
      onApproval: async request => { if (signal?.aborted || !onApproval) return false; try { return await Promise.race([Promise.resolve(onApproval(request)), aborted]) === true; } catch { return false; } },
    });
    checkAbort(signal);
    const turn = await Promise.race([engine.startTurn(input, { model: connection.model, effort: choices.effort, supportedEfforts: connection.supportedEfforts }), aborted]);
    checkAbort(signal);
    if (turn.status !== 'completed') throw new Error('Agent task did not complete.');
    for (const item of turn.items) if (item.type === 'agentMessage') collect(item.id, item.text);
    if (collectionError) throw collectionError;
    return { text: safe([...messages.values()].filter(Boolean).join('\n\n')), threadId: engine.threadId };
  } catch (error) {
    if (signal?.aborted) throw abortError();
    throw new Error(safe(error?.message || 'Agent task failed.'));
  } finally {
    signal?.removeEventListener('abort', abort);
    await engine?.close().catch(() => {});
    await bridge?.close().catch(() => {});
    await home?.cleanup().catch(() => {});
  }
}

/** User-supplied GPU service hook; waking hardware is performed by that service. */
export async function gpuHook({ url: input, apiKey, action = 'wake', signal, timeoutMs = 15000 } = {}) {
  checkAbort(signal);
  let url;
  try { url = new URL(input); } catch { throw new Error('GPU hook URL is invalid.'); }
  const loopback = url.hostname === 'localhost' || url.hostname === '[::1]' || /^127\.\d+\.\d+\.\d+$/.test(url.hostname);
  if (typeof input !== 'string' || /[\u0000-\u001f\u007f]/.test(input) || url.username || url.password || url.search || url.hash || input.includes('?') || input.includes('#')
    || !(url.protocol === 'https:' || url.protocol === 'http:' && loopback)) throw new Error('GPU hook requires HTTPS or a loopback HTTP URL without embedded credentials, queries or fragments.');
  if (!['wake', 'sleep'].includes(action) || !Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 120000) throw new Error('GPU hook action or timeout is invalid.');
  if (apiKey !== undefined && (typeof apiKey !== 'string' || !apiKey || apiKey.length > 16384 || /[\u0000-\u001f\u007f]/.test(apiKey))) throw new Error('GPU hook API key is invalid.');
  try {
    const combined = signal ? AbortSignal.any([signal, AbortSignal.timeout(timeoutMs)]) : AbortSignal.timeout(timeoutMs);
    const response = await fetch(url, { method: 'POST', redirect: 'error', signal: combined, headers: { 'content-type': 'application/json', ...(apiKey ? { authorization: `Bearer ${apiKey}` } : {}) }, body: JSON.stringify({ action }) });
    if (!response.ok) { await response.body?.cancel(); throw new Error('HTTP'); }
    let bytes = 0;
    for await (const chunk of response.body ?? []) { bytes += chunk.length; if (bytes > 65536) { await response.body?.cancel().catch(() => {}); throw new Error('limit'); } }
    return { ok: true, status: response.status };
  } catch {
    if (signal?.aborted) throw abortError();
    throw new Error('GPU hook failed, timed out or exceeded its response limit. Check the configured service.');
  }
}
