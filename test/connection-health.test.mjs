import test from 'node:test';
import assert from 'node:assert/strict';
import { createConnectionHealth } from '../src/connection-health.mjs';

test('health stays unmeasured before an actual request and during its initial wait', () => {
  let now = 0;
  const health = createConnectionHealth({ clock: () => now });
  assert.equal(health.snapshot().percent, null);
  assert.equal(health.snapshot().source, 'unmeasured');
  health.requestStarted('one');
  now = 1000;
  assert.equal(health.snapshot().percent, null);
  assert.equal(health.snapshot().pending, 1);
  assert.equal(health.snapshot().latencyMs, 1000);
});

test('measured fast responses produce healthy latency while failures reduce the measured score', () => {
  let now = 0;
  const health = createConnectionHealth({ clock: () => now });
  health.requestStarted('fast');
  now = 200;
  health.requestSucceeded('fast');
  assert.equal(health.snapshot().percent, 100);
  assert.equal(health.snapshot().latencyMs, 200);
  assert.equal(health.snapshot().source, 'response-latency-and-errors');
  health.requestStarted('failed');
  health.requestFailed('failed');
  assert.equal(health.snapshot().percent, 50);
  assert.equal(health.snapshot().label, 'Poor');
});

test('a pending request deteriorates live without an outcome callback', () => {
  let now = 0;
  const health = createConnectionHealth({ clock: () => now });
  health.requestStarted('first');
  now = 20_000;
  assert.equal(health.snapshot().percent, 55);
  assert.equal(health.snapshot().label, 'Fair');
  assert.equal(health.snapshot().source, 'pending-latency-estimate');
  now = 35_000;
  assert.equal(health.snapshot().percent, 18);
  assert.equal(health.snapshot().label, 'Poor');
  health.requestSucceeded('first', { latencyMs: 200 });
  assert.equal(health.snapshot().percent, 100);
});

test('intentional cancellation neither penalizes measured health nor leaves a pending request', () => {
  let now = 0;
  const health = createConnectionHealth({ clock: () => now });
  health.requestStarted('fast');
  health.requestSucceeded('fast', { latencyMs: 100 });
  health.requestStarted('cancelled');
  now = 35_000;
  assert.equal(health.snapshot().percent, 18);
  health.requestCancelled('cancelled');
  assert.equal(health.snapshot().percent, 100);
  assert.equal(health.snapshot().pending, 0);
});

test('concurrent requests retain the slowest live wait and ignore duplicate outcomes', () => {
  let now = 0;
  const health = createConnectionHealth({ clock: () => now });
  health.requestStarted('a');
  now = 5000;
  health.requestStarted('b');
  assert.equal(health.requestStarted('a'), false);
  now = 20_000;
  assert.equal(health.snapshot().pending, 2);
  health.requestSucceeded('b', { latencyMs: 100 });
  assert.equal(health.snapshot().percent, 55);
  assert.equal(health.requestFailed('b'), false);
  assert.equal(health.requestSucceeded('a'), true);
  assert.equal(health.snapshot().pending, 0);
});

test('recent successful traffic recovers after older failures leave the bounded history', () => {
  const health = createConnectionHealth({ clock: () => 0, historySize: 3 });
  health.requestStarted('bad');
  health.requestFailed('bad');
  assert.equal(health.snapshot().percent, 0);
  for (const id of ['one', 'two', 'three']) {
    health.requestStarted(id);
    health.requestSucceeded(id, { latencyMs: 300 });
  }
  assert.equal(health.snapshot().percent, 100);
  assert.equal(health.snapshot().samples, 3);
});

test('first semantic response stops pending decay during a long healthy stream', () => {
  let now = 0;
  const health = createConnectionHealth({ clock: () => now });
  health.requestStarted('stream');
  now = 300;
  assert.equal(health.requestResponding('stream'), true);
  now = 60_000;
  assert.equal(health.snapshot().pending, 0);
  assert.equal(health.snapshot().active, 1);
  assert.equal(health.snapshot().latencyMs, 300);
  assert.equal(health.snapshot().percent, 100);
  health.requestSucceeded('stream');
  assert.equal(health.snapshot().percent, 100);
  assert.equal(health.snapshot().latencyMs, 300);
  assert.equal(health.snapshot().samples, 1);
});

test('a partial stream failure counts once even after a healthy first response', () => {
  let now = 0;
  const health = createConnectionHealth({ clock: () => now });
  health.requestStarted('stream');
  health.requestResponding('stream', { latencyMs: 500 });
  assert.equal(health.requestResponding('stream', { latencyMs: 20_000 }), false);
  now = 10_000;
  health.requestFailed('stream');
  assert.equal(health.snapshot().percent, 0);
  assert.equal(health.snapshot().samples, 1);
  assert.equal(health.snapshot().active, 0);
  assert.equal(health.requestFailed('stream'), false);
});

test('measured metrics distinguish first output, full latency, errors and provider token speed', () => {
  let now = 0; const health = createConnectionHealth({ clock: () => now });
  health.requestStarted('one'); now = 100; health.requestResponding('one', { firstTokenLatencyMs: 100 });
  now = 1100; health.requestSucceeded('one', { firstTokenLatencyMs: 100, totalLatencyMs: 1100, outputTokens: 20 });
  health.requestStarted('bad'); now = 1200; health.requestFailed('bad');
  const result = health.snapshot();
  assert.equal(result.firstTokenLatencyMs, 100);
  assert.equal(result.totalLatencyMs, 1100);
  assert.equal(result.generationTokensPerSecond, 20);
  assert.equal(result.errorRate, 0.5);
  assert.equal(result.failures, 1);
});
