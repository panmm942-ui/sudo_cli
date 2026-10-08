import test from 'node:test';
import assert from 'node:assert/strict';
import { createInterface } from 'node:readline/promises';
import { PassThrough } from 'node:stream';

test('simultaneous approval questions are shown and answered in order', async () => {
  const { createPromptQueue } = await import('../src/prompts.mjs');
  const input = new PassThrough(), output = new PassThrough();
  const rl = createInterface({ input, output, terminal: false });
  const seen = [];
  const queue = createPromptQueue({ question: (prompt, options) => { seen.push(prompt); return rl.question(prompt, options); } });
  const first = queue.ask('first');
  const second = queue.ask('second');
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(seen, ['first']);
  input.write('yes\n');
  assert.equal(await first, 'yes');
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(seen, ['first', 'second']);
  input.write('no\n');
  assert.equal(await second, 'no');
  queue.close(); rl.close(); input.end(); output.end();
});

test('cancelling aborts active and queued questions, then permits a fresh prompt', async () => {
  const { createPromptQueue } = await import('../src/prompts.mjs');
  const input = new PassThrough(), output = new PassThrough();
  const rl = createInterface({ input, output, terminal: false });
  const queue = createPromptQueue({ question: (prompt, options) => rl.question(prompt, options) });
  const a = assert.rejects(queue.ask('approval'), /abort/i);
  const b = assert.rejects(queue.ask('queued'), /abort/i);
  await new Promise(resolve => setImmediate(resolve));
  queue.cancel();
  await Promise.all([a, b]);
  const fresh = queue.ask('task');
  await new Promise(resolve => setImmediate(resolve));
  input.write('next task\n');
  assert.equal(await fresh, 'next task');
  queue.close(); rl.close(); input.end(); output.end();
});

test('closing rejects the idle question so shutdown can reach cleanup', async () => {
  const { createPromptQueue } = await import('../src/prompts.mjs');
  const input = new PassThrough(), output = new PassThrough();
  const rl = createInterface({ input, output, terminal: false });
  const queue = createPromptQueue({ question: (prompt, options) => rl.question(prompt, options) });
  const idle = assert.rejects(queue.ask('task'), /abort/i);
  await new Promise(resolve => setImmediate(resolve));
  queue.close();
  await idle;
  await assert.rejects(queue.ask('after shutdown'), /closed/i);
  rl.close(); input.end(); output.end();
});
