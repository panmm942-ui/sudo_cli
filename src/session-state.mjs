const tokenCount = (value) => Number.isSafeInteger(value) && value >= 0 ? value : null;
const contextLimit = (value) => Number.isSafeInteger(value) && value > 0 ? value : null;
const connectionFailures = new Set([
  'httpConnectionFailed', 'responseStreamConnectionFailed', 'responseStreamDisconnected',
  'responseTooManyFailedAttempts', 'unauthorized',
]);
const generatedTools = new Set(['commandExecution', 'fileChange', 'mcpToolCall', 'webSearch', 'imageGeneration']);

function isConnectionFailure(error) {
  const info = error?.codexErrorInfo;
  return typeof info === 'string' ? connectionFailures.has(info)
    : info && typeof info === 'object' && Object.keys(info).some((name) => connectionFailures.has(name));
}

/** In-memory dashboard facts; endpoint configuration alone is not a model connection. */
export function createSessionState({ cwd = process.cwd(), contextLimit: initialLimit } = {}) {
  let model = null, endpoint = null, threadId = null, working = false;
  let connectionState = 'unconfigured';
  let configuredLimit = contextLimit(initialLimit);
  let context = { used: null, limit: configuredLimit, percent: null, source: 'unknown' };

  const resetContext = () => { context = { used: null, limit: configuredLimit, percent: null, source: 'unknown' }; };
  const markOnline = () => { if (model) connectionState = 'online'; };
  const markOffline = () => { connectionState = model ? 'offline' : 'unconfigured'; };
  const snapshot = () => ({
    cwd, working, status: connectionState === 'online' ? 'Online' : 'Offline', connectionState,
    configuredModel: model, connectedAI: connectionState === 'online' ? model : null,
    endpoint, threadId, context: { ...context },
  });

  function updateConnection(connection) {
    model = connection?.model || null;
    endpoint = connection?.baseUrl || null;
    configuredLimit = contextLimit(connection?.contextWindow);
    connectionState = model ? 'pending' : 'unconfigured';
    working = false;
    resetContext();
  }

  function bindThread(nextThreadId) {
    if (threadId && threadId !== nextThreadId) {
      working = false;
      resetContext();
    }
    threadId = nextThreadId || null;
  }

  function resetConversation() {
    working = false;
    resetContext();
  }

  function applyEvent({ method, params = {} } = {}) {
    if (threadId && params.threadId && params.threadId !== threadId) return;
    if (method === 'turn/started') working = true;
    else if (method === 'turn/completed') {
      working = false;
      if (params.turn?.status === 'completed') markOnline();
      else if (params.turn?.status === 'failed' && isConnectionFailure(params.turn.error)) markOffline();
    } else if (method === 'error') {
      if (params.willRetry !== true && isConnectionFailure(params.error)) markOffline();
    } else if (method === 'thread/tokenUsage/updated') {
      // `total` is cumulative billing usage. `last` is the latest reported context,
      // excluding local items appended after that response (core/history.rs).
      const used = tokenCount(params.tokenUsage?.last?.totalTokens);
      if (used === null) return;
      const limit = contextLimit(params.tokenUsage?.modelContextWindow) ?? configuredLimit;
      context = { used, limit, percent: limit === null ? null : Math.round(used / limit * 1000) / 10, source: 'reported' };
    } else if (method === 'item/agentMessage/delta' || method === 'item/reasoning/textDelta' || method === 'item/reasoning/summaryTextDelta') {
      if (typeof params.delta === 'string' && params.delta.length > 0) markOnline();
    } else if (method === 'item/started' && generatedTools.has(params.item?.type)) markOnline();
    else if (method === 'item/completed' && params.item?.type === 'agentMessage') markOnline();
  }

  return {
    snapshot, updateConnection, bindThread, resetConversation, applyEvent, markOnline, markOffline,
    setWorking(value) { working = value === true; },
  };
}
