import test from 'node:test';
import assert from 'node:assert/strict';

async function api() {
  const module = await import('../src/context-manager.mjs').catch(() => ({}));
  assert.equal(typeof module.preflightContext, 'function', 'context preflight API must exist');
  return module;
}
const messages = [{ role: 'user', content: 'x'.repeat(4000) }, { role: 'assistant', content: 'Old result' }, { role: 'user', content: 'Continue' }];

test('unknown model capacity requires explicit configuration and leaves complete archive intact', async () => {
  const { preflightContext } = await api();
  const result = preflightContext({ messages });
  assert.equal(result.status, 'needs-capacity');
  assert.deepEqual(result.archive, messages);
  assert.equal(result.estimate.estimated, true);
  assert.equal(result.messages, null);
});

test('over-capacity history never silently loses older messages', async () => {
  const { preflightContext } = await api();
  const result = preflightContext({ messages, contextWindow: 1000, reserveOutputTokens: 100 });
  assert.equal(result.status, 'needs-review');
  assert.deepEqual(result.archive, messages);
  assert.equal(result.messages, null);
});

test('only explicitly reviewed summary and selected messages create bounded context', async () => {
  const { preflightContext } = await api();
  const input = { messages, contextWindow: 1000, reserveOutputTokens: 100, summary: 'User wants to continue the earlier work.', relevantIndices: [1, 2] };
  assert.equal(preflightContext(input).status, 'needs-review');
  const reviewed = preflightContext({ ...input, reviewed: true });
  assert.equal(reviewed.status, 'ready');
  assert.deepEqual(reviewed.sourceIndices, [1, 2]);
  assert.deepEqual(reviewed.archive, messages);
  assert.equal(reviewed.messages[0].role, 'user');
  assert.match(reviewed.messages[0].content, /reviewed conversation summary/i);
  assert.deepEqual(reviewed.messages.slice(1), messages.slice(1));
  assert.equal(preflightContext({ ...input, reviewed: true, summary: 'x'.repeat(5000) }).status, 'over-capacity');
});

test('context overhead and output reserve are included and illegal selections fail', async () => {
  const { preflightContext, estimateContext } = await api();
  const plain = estimateContext([{ role: 'user', content: 'Hello' }]);
  const tools = estimateContext([{ role: 'user', content: 'Hello' }], { tools: [{ description: 'x'.repeat(1000) }] });
  assert.ok(tools.tokens > plain.tokens);
  assert.equal(plain.estimated, true);
  assert.throws(() => preflightContext({ messages, contextWindow: 1000, relevantIndices: [8], summary: 'Summary', reviewed: true }));
  const result = preflightContext({ messages: [{ role: 'user', content: 'Hello' }], contextWindow: 100, reserveOutputTokens: 99 });
  assert.equal(result.status, 'needs-review');
});
test('a human-reviewed summary-only replay retains the original archive',async()=>{const {preflightContext}=await api();const result=preflightContext({messages,contextWindow:1000,reserveOutputTokens:100,summary:'Approved summary of earlier work.',relevantIndices:[],reviewed:true});assert.equal(result.status,'ready');assert.equal(result.messages.length,1);assert.deepEqual(result.archive,messages);});
