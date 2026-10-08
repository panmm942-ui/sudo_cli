import test from 'node:test';
import assert from 'node:assert/strict';
import {fileURLToPath} from 'node:url';
import {runFixtureProcess} from './fixtures/native-process.mjs';

test('acceptance PTY input drains duplex output and bounds stalled, exited and closed peers', {skip: process.platform === 'win32', timeout: 15_000}, async () => {
  const stages = [];
  const causes = [];
  let pending = '';
  const phases = new Set(['duplex', 'nonconsuming', 'exit', 'eof']);
  const errorTypes = new Set(['AssertionError', 'EOFError', 'TimeoutError', 'FixtureDeadline', 'OSError', 'BlockingIOError', 'InterruptedError', 'PermissionError', 'FileNotFoundError', 'ChildProcessError', 'ProcessLookupError', 'ValueError', 'RuntimeError', 'OtherError']);
  const collect = chunk => {
    pending = (pending + chunk).slice(-4096);
    let newline;
    while ((newline = pending.indexOf('\n')) !== -1) {
      const line = pending.slice(0, newline); pending = pending.slice(newline + 1);
      const phase = /^PTY_PHASE_(duplex|nonconsuming|exit|eof)$/.exec(line);
      if (phase && stages.length < 4) stages.push(phase[0]);
      if (!line.startsWith('PTY_CAUSE ') || causes.length >= 2) continue;
      let value; try { value = JSON.parse(line.slice(10)); } catch { continue; }
      if (!value || typeof value !== 'object' || Array.isArray(value)) continue;
      if (!phases.has(value.phase) || !errorTypes.has(value.errorType)) continue;
      const cause = {phase: value.phase, errorType: value.errorType};
      if (['spawn', 'send', 'receipt', 'marker', 'wire', 'flags', 'exit', 'cleanup'].includes(value.stage)) cause.stage = value.stage;
      if (['none', 'marker', 'length', 'byte', 'flags'].includes(value.diffClass)) cause.diffClass = value.diffClass;
      for (const key of ['errno', 'peerErrno']) if (Number.isInteger(value[key]) && value[key] >= 0 && value[key] <= 255) cause[key] = value[key];
      if (value.childStatus === null || (Number.isInteger(value.childStatus) && value.childStatus >= -128 && value.childStatus <= 255)) cause.childStatus = value.childStatus;
      for (const key of ['actualBytes', 'expectedBytes']) if (Number.isInteger(value[key]) && value[key] >= 0 && value[key] <= 1024 * 1024) cause[key] = value[key];
      for (const key of ['flagsOriginal', 'flagsBeforeSend', 'flagsAfterSend', 'nonblockBit', 'accessMask']) if (Number.isInteger(value[key]) && value[key] >= 0 && value[key] <= 0x7fffffff) cause[key] = value[key];
      if (errorTypes.has(value.peerErrorType)) cause.peerErrorType = value.peerErrorType;
      causes.push(cause);
    }
  };
  let result;
  try {
    result = await runFixtureProcess('python3', [fileURLToPath(new URL('./fixtures/linux-pty-send.py', import.meta.url))], {
      timeoutMs: 12_000, maxBytes: 4096,
      onStderr: collect,
    });
  } catch (error) { collect('\n'); assert.fail(`${error.message}; PTY fixture stages: ${stages.join(', ')}; causes: ${JSON.stringify(causes)}`); }
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
