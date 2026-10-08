import test from 'node:test';
import assert from 'node:assert/strict';
import { createSessionState } from '../src/session-state.mjs';

const connection = { model: 'chosen-model', baseUrl: 'https://provider.example/v1', contextWindow: 100_000 };
function configured() {
  const state = createSessionState({ cwd: '/project' });
  state.updateConnection(connection);
  state.bindThread('thread-1');
  return state;
}
function usage({ last = 25_000, total = 400_000, limit = 100_000, threadId = 'thread-1' } = {}) {
  return {
    method: 'thread/tokenUsage/updated',
    params: { threadId, turnId: 'turn-1', tokenUsage: {
      total: { totalTokens: total, inputTokens: total - 1000, cachedInputTokens: 0, cacheWriteInputTokens: 0, outputTokens: 1000, reasoningOutputTokens: 0 },
      last: { totalTokens: last, inputTokens: last - 1000, cachedInputTokens: 0, cacheWriteInputTokens: 0, outputTokens: 1000, reasoningOutputTokens: 0 },
      modelContextWindow: limit,
    } },
  };
}

test('configuration stays offline until a model response is confirmed', () => {
  const state = configured();
  assert.equal(state.snapshot().connectionState, 'pending');
  assert.equal(state.snapshot().status, 'Offline');
  assert.equal(state.snapshot().connectedAI, null);
  assert.equal(state.snapshot().configuredModel, 'chosen-model');
  state.applyEvent({ method: 'turn/started', params: { threadId: 'thread-1', turn: { id: 'turn-1', status: 'inProgress', items: [], error: null } } });
  assert.equal(state.snapshot().working, true);
  assert.equal(state.snapshot().status, 'Offline');
  state.applyEvent({ method: 'item/agentMessage/delta', params: { threadId: 'thread-1', turnId: 'turn-1', itemId: 'message-1', delta: 'Hello' } });
  assert.equal(state.snapshot().status, 'Online');
  assert.equal(state.snapshot().connectedAI, 'chosen-model');
});

test('latest reported context uses last total tokens rather than cumulative billing tokens', () => {
  const state = configured();
  assert.deepEqual(state.snapshot().context, { used: null, limit: 100_000, percent: null, source: 'unknown' });
  state.applyEvent(usage());
  assert.deepEqual(state.snapshot().context, { used: 25_000, limit: 100_000, percent: 25, source: 'reported' });
  state.applyEvent(usage({ last: 10_000, total: 500_000, limit: 50_000 }));
  assert.deepEqual(state.snapshot().context, { used: 10_000, limit: 50_000, percent: 20, source: 'reported' });
});

test('reported usage without a known context limit has no invented percentage', () => {
  const state = createSessionState();
  state.updateConnection({ model: 'custom-model', baseUrl: connection.baseUrl });
  state.bindThread('thread-1');
  state.applyEvent(usage({ last: 2500, limit: null }));
  assert.deepEqual(state.snapshot().context, { used: 2500, limit: null, percent: null, source: 'reported' });
});

test('tool work and approval waits stay working until the whole turn ends', () => {
  const state = configured();
  state.setWorking(true);
  state.applyEvent({ method: 'item/started', params: { threadId: 'thread-1', turnId: 'turn-1', item: { type: 'commandExecution', id: 'command-1', command: 'echo hello' } } });
  assert.equal(state.snapshot().status, 'Online');
  state.applyEvent({ method: 'item/completed', params: { threadId: 'thread-1', turnId: 'turn-1', item: { type: 'commandExecution', id: 'command-1', status: 'completed' } } });
  assert.equal(state.snapshot().working, true);
  state.applyEvent({ method: 'turn/completed', params: { threadId: 'thread-1', turn: { id: 'turn-1', status: 'interrupted', items: [], error: null } } });
  assert.equal(state.snapshot().working, false);
  assert.equal(state.snapshot().status, 'Online');
});

test('transient retries and local validation or permission failures preserve an established connection', () => {
  const state = configured();
  state.markOnline();
  state.setWorking(true);
  state.applyEvent({ method: 'error', params: { threadId: 'thread-1', turnId: 'turn-1', willRetry: true, error: { message: 'retrying', codexErrorInfo: { responseStreamConnectionFailed: { httpStatusCode: null } }, additionalDetails: null } } });
  assert.equal(state.snapshot().status, 'Online');
  assert.equal(state.snapshot().working, true);
  for (const codexErrorInfo of ['badRequest', 'tooManyDenials', 'sandboxError', 'contextWindowExceeded']) {
    state.applyEvent({ method: 'error', params: { threadId: 'thread-1', turnId: 'turn-1', willRetry: false, error: { message: 'failed', codexErrorInfo, additionalDetails: null } } });
    assert.equal(state.snapshot().status, 'Online');
  }
});

test('terminal transport failures mark the model disconnected while retaining the selected model', () => {
  const state = configured();
  state.markOnline();
  state.setWorking(true);
  state.applyEvent({ method: 'turn/completed', params: { threadId: 'thread-1', turn: { id: 'turn-1', status: 'failed', items: [], error: { message: 'network failed', codexErrorInfo: { httpConnectionFailed: { httpStatusCode: null } }, additionalDetails: null } } } });
  assert.equal(state.snapshot().working, false);
  assert.equal(state.snapshot().status, 'Offline');
  assert.equal(state.snapshot().connectionState, 'offline');
  assert.equal(state.snapshot().connectedAI, null);
  assert.equal(state.snapshot().configuredModel, 'chosen-model');
});

test('a model change invalidates earlier model context and confirmation', () => {
  const state = configured();
  state.markOnline();
  state.applyEvent(usage());
  state.updateConnection({ model: 'another-model', baseUrl: connection.baseUrl });
  assert.equal(state.snapshot().configuredModel, 'another-model');
  assert.equal(state.snapshot().connectedAI, null);
  assert.equal(state.snapshot().connectionState, 'pending');
  assert.deepEqual(state.snapshot().context, { used: null, limit: null, percent: null, source: 'unknown' });
});

test('a fresh conversation clears usage and ignores notifications from a previous thread', () => {
  const state = configured();
  state.markOnline();
  state.applyEvent(usage());
  state.resetConversation();
  state.bindThread('thread-2');
  state.setWorking(true);
  state.applyEvent(usage());
  state.applyEvent({ method: 'turn/completed', params: { threadId: 'thread-1', turn: { id: 'old-turn', status: 'completed', items: [], error: null } } });
  assert.deepEqual(state.snapshot().context, { used: null, limit: 100_000, percent: null, source: 'unknown' });
  assert.equal(state.snapshot().working, true);
});

test('invalid token reports cannot replace known usage or fabricate a context limit', () => {
  const state = configured();
  state.applyEvent(usage());
  for (const last of [-1, '999', null, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1]) state.applyEvent(usage({ last }));
  assert.deepEqual(state.snapshot().context, { used: 25_000, limit: 100_000, percent: 25, source: 'reported' });
  state.applyEvent(usage({ last: 0, limit: 0 }));
  assert.deepEqual(state.snapshot().context, { used: 0, limit: 100_000, percent: 0, source: 'reported' });
});

test('reconfiguration cannot keep the previous endpoint online or carry its context', () => {
  const state = configured();
  state.markOnline();
  state.applyEvent(usage());
  state.updateConnection({ model: 'chosen-model', baseUrl: 'https://another.example/v1', contextWindow: 50_000 });
  assert.equal(state.snapshot().endpoint, 'https://another.example/v1');
  assert.equal(state.snapshot().connectedAI, null);
  assert.equal(state.snapshot().status, 'Offline');
  assert.deepEqual(state.snapshot().context, { used: null, limit: 50_000, percent: null, source: 'unknown' });
  state.markOnline();
  state.markOffline();
  assert.equal(state.snapshot().connectedAI, null);
});
