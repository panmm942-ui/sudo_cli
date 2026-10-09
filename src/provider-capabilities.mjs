import { validateConnection, CAPABILITY_NAMES } from './runtime.mjs';

export { CAPABILITY_NAMES } from './runtime.mjs';
const booleanEvidence = value => typeof value === 'boolean' ? value : null;
const toolIdentifier = value => typeof value === 'string' && value.length > 0 && value.length <= 1024 && !/[\p{Cc}\p{Cf}]/u.test(value);
const executableType = value => typeof value === 'string' && (/_call$/.test(value) || ['mcp_list_tools', 'mcp_approval_request'].includes(value));

/** Request-scoped tool permissions, shared by both provider transports. */
export function createToolPolicy({ toolsAllowed = true, toolAllowlist, parallelToolCalls } = {}) {
  if (typeof toolsAllowed !== 'boolean') throw new Error('toolsAllowed must be a boolean.');
  if (parallelToolCalls !== undefined && typeof parallelToolCalls !== 'boolean') throw new Error('parallelToolCalls must be a boolean.');
  if (toolAllowlist !== undefined && (!Array.isArray(toolAllowlist) || toolAllowlist.length > 1024 || toolAllowlist.some(name => !toolIdentifier(name)) || new Set(toolAllowlist).size !== toolAllowlist.length)) throw new Error('Tool permissions must contain unique wire names.');
  const unrestricted = toolsAllowed && toolAllowlist === undefined;
  const selected = new Set(toolAllowlist ?? []), catalog = new Map(), ambiguous = new Set(), items = new Map();
  const allows = (name, types) => toolsAllowed && (unrestricted || (selected.has(name) && catalog.has(name) && !ambiguous.has(name) && (!types || types.includes(catalog.get(name)))));
  const violation = () => { const error = new Error('The model returned a tool call outside the configured tool permissions.'); error.code = toolsAllowed ? 'TOOL_NOT_ALLOWED' : 'TOOLS_DISABLED'; throw error; };
  const qualified = (name, namespace) => toolIdentifier(name) && (namespace == null || toolIdentifier(namespace)) ? namespace == null ? name : `${namespace}.${name}` : undefined;
  const identity = (tool, format, namespace) => format === 'chat-completions' ? tool?.function?.name : qualified(tool?.name ?? tool?.type, namespace ?? tool?.namespace);
  const gather = (definitions, format, namespace) => {
    if (!Array.isArray(definitions)) return;
    for (const tool of definitions) {
      if (tool?.type === 'namespace' && Array.isArray(tool.tools)) {
        const prefix = qualified(tool.name, namespace);
        if (prefix) gather(tool.tools, format, prefix);
      } else {
        const name = identity(tool, format, namespace), type = tool?.type ?? 'unknown';
        if (toolIdentifier(name)) {
          if (catalog.has(name) && (['function', 'custom'].includes(type) || catalog.get(name) !== type)) ambiguous.add(name);
          catalog.set(name, type);
        }
      }
    }
  };
  const filter = (definitions, format, namespace) => {
    if (!Array.isArray(definitions)) return [];
    return definitions.flatMap(tool => {
      if (tool?.type === 'namespace' && Array.isArray(tool.tools)) {
        const prefix = qualified(tool.name, namespace), children = prefix ? filter(tool.tools, format, prefix) : [];
        return children.length ? [{ ...tool, tools: children }] : [];
      }
      return allows(identity(tool, format, namespace)) ? [tool] : [];
    });
  };
  const assertItem = item => {
    if (unrestricted || !executableType(item?.type)) return;
    if (!toolsAllowed) violation();
    if (['function_call', 'custom_tool_call'].includes(item.type)) { if (!allows(qualified(item.name, item.namespace), [item.type === 'function_call' ? 'function' : 'custom'])) violation(); return; }
    const aliases = item.type.startsWith('mcp_') ? ['mcp'] : item.type === 'web_search_call' ? ['web_search', 'web_search_preview', 'web_search_preview_2025_03_11'] : item.type === 'computer_call' ? ['computer', 'computer_use_preview'] : [item.type.replace(/_call$/, '')];
    if (!aliases.some(name => allows(name, [name]))) violation();
  };
  return {
    unrestricted, toolsAllowed, allows,
    getToolCatalog: () => [...catalog.keys()].sort(),
    filterRequest(request, { format = 'responses' } = {}) {
      gather(request.tools, format);
      if (unrestricted && parallelToolCalls !== false) return request;
      const result = { ...request };
      // Some endpoints reject the parameter itself, including an explicit false.
      if (parallelToolCalls === false) delete result.parallel_tool_calls;
      if (unrestricted) return result;
      const tools = filter(request.tools, format);
      if (tools.length) result.tools = tools; else delete result.tools;
      if (!tools.length) { delete result.tool_choice; delete result.parallel_tool_calls; }
      else if (result.tool_choice && typeof result.tool_choice === 'object') {
        const chosen = format === 'chat-completions' ? result.tool_choice.function?.name : identity(result.tool_choice, format);
        if (!allows(chosen)) delete result.tool_choice;
      }
      return result;
    },
    assertItem,
    assertResponse(response) { if (!unrestricted && Array.isArray(response?.output)) response.output.forEach(assertItem); },
    assertEvent(event, eventName) {
      if (unrestricted) return;
      if (event?.item) { assertItem(event.item); if (event.item.id) items.set(event.item.id, event.item); }
      if (Array.isArray(event?.response?.output)) event.response.output.forEach(assertItem);
      if (Array.isArray(event?.output)) event.output.forEach(assertItem);
      const type = event?.type ?? eventName;
      const prefix = typeof type === 'string' ? /^response\.([^.]*(?:call|approval_request|list_tools)[^.]*)/.exec(type)?.[1] : undefined;
      if (!prefix) return;
      const known = items.get(event?.item_id ?? event?.item?.id);
      if (known) { assertItem(known); return; }
      const itemType = prefix.startsWith('function_call') ? 'function_call' : prefix.startsWith('custom_tool_call') ? 'custom_tool_call' : prefix.startsWith('mcp_') ? 'mcp_call' : prefix.slice(0, prefix.indexOf('call') + 4);
      assertItem({ type: itemType, name: event?.name, namespace: event?.namespace });
    },
  };
}

/** Support is evidence about this configured endpoint/model, never a model-name guess. */
export function capabilityReport(connection, { declared = connection?.capabilities ?? {}, observed = {} } = {}) {
  const config = validateConnection(connection);
  const capabilities = Object.fromEntries(CAPABILITY_NAMES.map(name => {
    const declaration = booleanEvidence(declared?.[name]);
    const observation = booleanEvidence(observed?.[name]);
    return [name, { state: observation !== null ? 'observed' : declaration !== null ? 'declared' : 'unknown', supported: observation ?? declaration, declared: declaration, observed: observation }];
  }));
  return { transport: { state: 'declared', value: config.transport }, capabilities,
    contextWindow: { state: config.contextWindow ? 'declared' : 'unknown', value: config.contextWindow ?? null },
    supportedEfforts: { state: config.supportedEfforts ? 'declared' : 'unknown', value: config.supportedEfforts ?? null } };
}

/** Explicit, read-only catalog request. It does not exercise generation or infer features. */
export async function discoverModels(connection, { timeoutMs = 5000, signal } = {}) {
  const config = validateConnection(connection);
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 2147483647) throw new Error('Probe timeout must be a positive timer duration.');
  if (config.apiKey && /[\r\n]/.test(config.apiKey)) throw new Error('The connection key contains invalid line breaks.');
  const controller = new AbortController(); let timedOut = false;
  const abort = () => controller.abort(); signal?.addEventListener('abort', abort, { once: true });
  if (signal?.aborted) controller.abort();
  const timer = setTimeout(() => { timedOut = true; controller.abort(); }, timeoutMs); timer.unref();
  const started = performance.now();
  const result = (ok, status, models = [], httpStatus = null) => ({ ok, status, models, httpStatus, latencyMs: performance.now() - started, generationTested: false });
  try {
    const response = await fetch(config.baseUrl.replace(/\/$/, '') + '/models', { method: 'GET', headers: config.apiKey ? { authorization: `Bearer ${config.apiKey}` } : {}, signal: controller.signal, redirect: 'error' });
    if (!response.ok) {
      await response.body?.cancel();
      return result(false, [401, 403].includes(response.status) ? 'authentication-required' : [404, 405, 501].includes(response.status) ? 'unsupported-models' : 'http-error', [], response.status);
    }
    const chunks = []; let bytes = 0;
    for await (const chunk of response.body ?? []) {
      bytes += chunk.length;
      if (bytes > 2 * 1024 * 1024) { controller.abort(); return result(false, 'invalid-catalog'); }
      chunks.push(Buffer.from(chunk));
    }
    let catalog; try { catalog = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { return result(false, 'invalid-catalog'); }
    if (!Array.isArray(catalog?.data) || catalog.data.length > 5000) return result(false, 'invalid-catalog');
    const models = [...new Set(catalog.data.map(item => item?.id).filter(id => typeof id === 'string' && id.trim() && id.length <= 512 && !/[\p{Cc}\p{Cf}]/u.test(id) && (!config.apiKey || !id.includes(config.apiKey))))].sort();
    return result(true, 'reachable', models, response.status);
  } catch { return result(false, timedOut ? 'timeout' : signal?.aborted ? 'cancelled' : 'unreachable'); }
  finally { clearTimeout(timer); signal?.removeEventListener('abort', abort); }
}

export async function probeConnection(connection, options = {}) {
  const discovery = await discoverModels(connection, options);
  return { ...discovery, selectedModelListed: discovery.ok ? discovery.models.includes(connection.model) : null,
    capabilities: capabilityReport(connection, { observed: discovery.ok ? { modelDiscovery: true } : {} }) };
}
