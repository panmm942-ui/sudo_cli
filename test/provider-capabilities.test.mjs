import test from 'node:test';
import assert from 'node:assert/strict';
import { createToolPolicy } from '../src/provider-capabilities.mjs';

test('parallel tool compatibility omits the unsupported parameter without mutating an unrestricted request', () => {
  for (const format of ['responses', 'chat-completions']) {
    const tools = format === 'responses'
      ? [{ type: 'function', name: 'read', parameters: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] } }, { type: 'web_search' }]
      : [{ type: 'function', function: { name: 'read', parameters: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] } } }];
    for (const value of [true, false]) {
      const request = { model: 'fixture', tools, tool_choice: 'required', parallel_tool_calls: value, input: [{ type: 'function_call', name: 'read', call_id: 'previous', arguments: '{"path":"file.txt"}' }] };
      const policy = createToolPolicy({ parallelToolCalls: false });
      const filtered = policy.filterRequest(request, { format });
      assert.deepEqual(filtered, { model: 'fixture', tools, tool_choice: 'required', input: request.input });
      assert.equal(request.parallel_tool_calls, value);
      assert.equal(policy.unrestricted, true);
      assert.doesNotThrow(() => policy.assertResponse({ output: [{ type: 'function_call', name: 'provider-extension' }] }));
      assert.doesNotThrow(() => policy.assertEvent({ type: 'response.function_call_arguments.delta', delta: '{}' }));
    }
  }
});

test('parallel tool compatibility preserves explicit values and never invents a request parameter', () => {
  for (const parallelToolCalls of [undefined, true]) {
    for (const value of [undefined, true, false]) {
      const request = { tools: [{ type: 'function', name: 'read' }], ...(value === undefined ? {} : { parallel_tool_calls: value }) };
      assert.deepEqual(createToolPolicy({ parallelToolCalls }).filterRequest(request), request);
    }
  }
  const request = { model: 'fixture' };
  assert.deepEqual(createToolPolicy({ parallelToolCalls: false }).filterRequest(request), request);
});

test('parallel tool compatibility preserves disabled tools enforcement', () => {
  const policy = createToolPolicy({ toolsAllowed: false, parallelToolCalls: false });
  assert.deepEqual(policy.filterRequest({ model: 'fixture', tools: [{ type: 'function', name: 'read' }], tool_choice: 'required', parallel_tool_calls: true }), { model: 'fixture' });
  assert.throws(() => policy.assertResponse({ output: [{ type: 'function_call', name: 'read' }] }), { code: 'TOOLS_DISABLED' });
  assert.throws(() => policy.assertEvent({ item: { type: 'function_call', name: 'read' } }), { code: 'TOOLS_DISABLED' });
});

test('parallel tool compatibility preserves allowlist filtering and response enforcement', () => {
  for (const format of ['responses', 'chat-completions']) {
    const policy = createToolPolicy({ toolAllowlist: ['allowed'], parallelToolCalls: false });
    const allowed = format === 'responses' ? { type: 'function', name: 'allowed' } : { type: 'function', function: { name: 'allowed' } };
    const excluded = format === 'responses' ? { type: 'function', name: 'excluded' } : { type: 'function', function: { name: 'excluded' } };
    assert.deepEqual(policy.filterRequest({ tools: [allowed, excluded], tool_choice: 'required', parallel_tool_calls: true }, { format }), { tools: [allowed], tool_choice: 'required' });
    assert.doesNotThrow(() => policy.assertResponse({ output: [{ type: 'function_call', name: 'allowed' }] }));
    assert.throws(() => policy.assertResponse({ output: [{ type: 'function_call', name: 'excluded' }] }), { code: 'TOOL_NOT_ALLOWED' });
    assert.throws(() => policy.assertEvent({ item: { type: 'function_call', name: 'excluded' } }), { code: 'TOOL_NOT_ALLOWED' });
  }
});

test('parallel tool compatibility rejects nonboolean configuration values', () => {
  for (const parallelToolCalls of [null, 'false', 0, {}, []]) {
    assert.throws(() => createToolPolicy({ parallelToolCalls }), /parallelToolCalls must be a boolean/);
  }
});
