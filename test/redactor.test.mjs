import test from 'node:test';
import assert from 'node:assert/strict';
import { createRedactor } from '../src/redactor.mjs';

function render(chunks, keys) {
  const redactor = createRedactor({ secrets: () => keys });
  return chunks.map((chunk) => redactor.write(chunk)).join('') + redactor.flush();
}

test('redacts an actual API key at every possible delta split', () => {
  const key = 'sk-test-session-r4NvG_1AZqX-42';
  const text = `Before ${key} after`;
  for (let split = 0; split <= text.length; split++) {
    assert.equal(render([text.slice(0, split), text.slice(split)], [key]), 'Before [redacted] after', `split ${split}`);
  }
  assert.equal(render([...text], [key]), 'Before [redacted] after');
});

test('redacts several keys and prefers the longest overlapping key', () => {
  const keys = ['bridge-7vM4-secret', 'bridge', 'api-αβ-🌍-key'];
  const text = 'bridge-7vM4-secret | api-αβ-🌍-key | bridge';
  for (let split = 0; split <= text.length; split++) {
    assert.equal(render([text.slice(0, split), text.slice(split)], keys), '[redacted] | [redacted] | [redacted]');
  }
});

test('retains near matches and Unicode text while emitting a bounded prefix', () => {
  const keys = ['κλειδί-🌍'];
  const redactor = createRedactor({ secrets: () => keys });
  const prefix = 'x'.repeat(5000);
  const emitted = redactor.write(prefix);
  assert.ok(emitted.length >= prefix.length - keys[0].length + 1);
  const tail = redactor.write(' κλειδί-🌎 κλειδZ-🌍 Ελλάδα 🌍');
  assert.equal(emitted + tail + redactor.flush(), prefix + ' κλειδί-🌎 κλειδZ-🌍 Ελλάδα 🌍');
});

test('does not split a Unicode surrogate pair across emitted strings', () => {
  const redactor = createRedactor({ secrets: () => [] });
  const first = redactor.write('Hello \ud83c');
  assert.equal(first, 'Hello ');
  assert.equal(redactor.write('\udf0d!') + redactor.flush(), '🌍!');
});

test('removes CSI, OSC, DCS and C1 terminal sequences at every split', () => {
  const malicious = 'a\x1b[31mred\x1b[0mb\x1b]52;c;c2VjcmV0\x07c\x1b]8;;https://example.test\x1b\\link\x1b]8;;\x1b\\d\x1bPsecret payload\x1b\\e\u009b2Jf\u009dhidden\u009cg';
  for (let split = 0; split <= malicious.length; split++) {
    const result = render([malicious.slice(0, split), malicious.slice(split)], []);
    assert.equal(result, 'aredbclinkdefg', `split ${split}`);
    assert.doesNotMatch(result, /[\x00-\x08\x0b-\x1f\x7f-\x9f]/);
  }
  assert.equal(render([...malicious], []), 'aredbclinkdefg');
});

test('removes terminal controls before matching secrets reconstructed by sanitization', () => {
  const text = 'token: sk-test-\x1b[32msecret\x1b[0m\x00\x0d-value\x07\x08\x0b\x1f\x7f\u0085\n\tend';
  assert.equal(render([...text], ['sk-test-secret-value']), 'token: [redacted]\n\tend');
});

test('flush drops unfinished VT sequences and reset discards old pending text', () => {
  const redactor = createRedactor({ secrets: () => ['long-secret-token'] });
  assert.equal(redactor.write('old pending'), '');
  redactor.reset();
  assert.equal(redactor.write('new\x1b]52;discarded'), '');
  assert.equal(redactor.flush(), 'new');
  assert.equal(redactor.flush(), '');
  assert.equal(redactor.write('plain') + redactor.flush(), 'plain');
});

test('uses current runtime secrets and ignores empty or duplicate keys', () => {
  let keys = [];
  const redactor = createRedactor({ secrets: () => keys });
  assert.equal(redactor.write('start '), 'start ');
  keys = ['', 'runtime-token', 'runtime-token'];
  assert.equal(redactor.write('runtime-') + redactor.write('token') + redactor.flush(), '[redacted]');
  keys = ['new-token'];
  assert.equal(redactor.write('new-token') + redactor.flush(), '[redacted]');
});

test('replacement markers cannot contain or reconstruct another configured secret', () => {
  for (const key of ['red', 'redacted', '[redacted]']) {
    const text = `Before ${key} after`;
    for (let split = 0; split <= text.length; split++) {
      const output = render([text.slice(0, split), text.slice(split)], [key]);
      assert.equal(output, 'Before █ after');
      assert.equal(output.includes(key), false);
    }
  }
  const keys = ['abc', 'x[redacted]y', 'x█y'];
  for (let split = 0; split <= 5; split++) {
    const output = render(['xabcy'.slice(0, split), 'xabcy'.slice(split)], keys);
    for (const key of keys) assert.equal(output.includes(key), false);
    assert.equal(output, 'x▉y');
  }
});

test('Unicode repair cannot reconstruct a configured secret after matching', () => {
  for (const text of ['x\ud800y', 'x\udc00y']) {
    for (let split = 0; split <= text.length; split++) {
      assert.equal(render([text.slice(0, split), text.slice(split)], ['x�y']), '[redacted]');
    }
  }
  assert.equal(render(['\ud800'], ['�']), '[redacted]');
  assert.equal(render(['\udc00'], ['�']), '[redacted]');
  assert.equal(render(['x\ud83c', '\udf0dy'], ['x�y']), 'x🌍y');
});
