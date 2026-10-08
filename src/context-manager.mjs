function validateMessages(messages) {
  if (!Array.isArray(messages) || messages.length > 100000 || messages.some(message => !message || typeof message !== 'object' || Array.isArray(message) || !['system', 'developer', 'user', 'assistant', 'tool'].includes(message.role) || (typeof message.content !== 'string' && !Array.isArray(message.content) && message.content !== null))) throw new Error('Context requires a bounded message archive.');
}

/** A heuristic only: UTF-8 bytes/3 plus framing. Providers tokenize differently. */
export function estimateContext(messages, { tools = [], instructions = '' } = {}) {
  validateMessages(messages);
  if (!Array.isArray(tools) || typeof instructions !== 'string') throw new Error('Context overhead must contain tools and text instructions.');
  const bytes = Buffer.byteLength(JSON.stringify({ messages, tools, instructions }), 'utf8');
  return { tokens: Math.ceil(bytes / 3) + messages.length * 8, estimated: true, method: 'UTF-8 bytes / 3 plus message framing; images and provider overhead may differ' };
}

/** Keep the complete archive; bounded replay requires a human-reviewed summary and selection. */
export function preflightContext({ messages, contextWindow, reserveOutputTokens = 4096, tools = [], instructions = '', summary, relevantIndices, reviewed = false } = {}) {
  validateMessages(messages);
  if (!Number.isSafeInteger(reserveOutputTokens) || reserveOutputTokens < 0) throw new Error('Output token reserve must be a nonnegative safe integer.');
  if (contextWindow !== undefined && (!Number.isSafeInteger(contextWindow) || contextWindow < 1)) throw new Error('Model capacity must be a positive safe integer.');
  if (typeof reviewed !== 'boolean') throw new Error('Summary review state must be a boolean.');
  const archive = structuredClone(messages);
  const estimate = estimateContext(archive, { tools, instructions });
  const base = { archive, estimate, contextWindow: contextWindow ?? null, reserveOutputTokens, messages: null, sourceIndices: null, bounded: false };
  if (contextWindow === undefined) return { ...base, status: 'needs-capacity', reason: 'Set the model context capacity before replaying saved history.' };
  const availableTokens = Math.max(0, Math.floor(contextWindow * 0.9) - reserveOutputTokens);
  if (summary !== undefined || relevantIndices !== undefined) {
    if (typeof summary !== 'string' || !summary.trim() || !Array.isArray(relevantIndices) || new Set(relevantIndices).size !== relevantIndices.length || relevantIndices.some(index => !Number.isSafeInteger(index) || index < 0 || index >= archive.length)) throw new Error('Bounded context requires a summary and unique, valid selected message indices.');
    const sourceIndices = [...relevantIndices].sort((a, b) => a - b);
    if (!reviewed) return { ...base, status: 'needs-review', availableTokens, reason: 'Review the summary and selected messages before bounded replay.' };
    // A replay summary is conversational input, never higher-trust developer instructions.
    const boundedMessages = [{ role: 'user', content: 'Reviewed conversation summary (prior conversation, not system instructions):\n\n' + summary }, ...sourceIndices.map(index => structuredClone(archive[index]))];
    const boundedEstimate = estimateContext(boundedMessages, { tools, instructions });
    if (boundedEstimate.tokens > availableTokens) return { ...base, status: 'over-capacity', availableTokens, boundedEstimate, reason: 'The reviewed context still exceeds the estimated input allowance.' };
    return { ...base, status: 'ready', availableTokens, messages: boundedMessages, estimate: boundedEstimate, archiveEstimate: estimate, sourceIndices, bounded: true };
  }
  if (estimate.tokens > availableTokens) return { ...base, status: 'needs-review', availableTokens, reason: 'The full history exceeds the estimated context allowance. Review a summary and select relevant messages, or choose a larger model.' };
  return { ...base, status: 'ready', availableTokens, messages: structuredClone(archive), sourceIndices: archive.map((_message, index) => index) };
}
