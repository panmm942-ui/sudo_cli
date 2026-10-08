import test from 'node:test';
import assert from 'node:assert/strict';
import {fileURLToPath} from 'node:url';
import {runFixtureProcess} from './fixtures/native-process.mjs';

test('acceptance PTY input drains duplex output and bounds stalled, exited and closed peers', {skip: process.platform === 'win32', timeout: 15_000}, async () => {
  const stages = [];
  let result;
  try {
    result = await runFixtureProcess('python3', [fileURLToPath(new URL('./fixtures/linux-pty-send.py', import.meta.url))], {
      timeoutMs: 12_000, maxBytes: 4096,
      onStderr: chunk => { for (const stage of chunk.match(/PTY_PHASE_(?:duplex|nonconsuming|exit|eof)\b/g) || []) if (stages.length < 4) stages.push(stage); },
    });
  } catch (error) { assert.fail(`${error.message}; PTY fixture stages: ${stages.join(', ')}`); }
  const proof = JSON.parse(result.stdout);
  assert.equal(proof.productLaunched, false);
  assert.equal(proof.modelCalls, 0);
  assert.deepEqual(proof.results.map(value => value.mode), ['duplex', 'nonconsuming', 'exit', 'eof']);
  assert.equal(proof.results[0].inputBytes, 17871);
  assert.equal(proof.results[0].inputExact, true);
  assert.equal(proof.results[0].outputExact, true);
  assert.ok(proof.results[0].outputBytes > 256 * 1024);
  assert.equal(proof.results[1].boundedTimeout, true);
  assert.equal(proof.results[2].childExitDetected, true);
  assert.equal(proof.results[3].ptyEofDetected, true);
  assert.ok(proof.results.every(value => value.flagsRestored && value.childReaped && value.elapsedMs < 4000));
});
