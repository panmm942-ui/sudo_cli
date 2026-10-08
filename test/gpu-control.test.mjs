import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';

async function fixture(t, handler) {
  const server = createServer(handler);
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => { server.closeAllConnections(); server.close(resolve); }));
  return `http://127.0.0.1:${server.address().port}`;
}

test('GPU command acknowledgement never verifies power or stopped billing', async t => {
  const { createGpuController } = await import('../src/gpu-control.mjs');
  const url = await fixture(t, (_, res) => { res.end('{"ok":true}'); });
  const gpu = createGpuController({ wake: { url }, sleep: { url } });
  assert.equal((await gpu.sleep()).state, 'unknown');
  assert.equal(gpu.snapshot().billing, 'unknown');
  assert.equal(gpu.snapshot().verified, false);
});

test('GPU controller polls strict status after command until actual requested state is observed', async t => {
  const { createGpuController } = await import('../src/gpu-control.mjs');
  let reads = 0, now = 0;
  const url = await fixture(t, async (req, res) => {
    if (req.method === 'POST') { res.end('{"accepted":true}'); return; }
    reads++; res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify({ state: reads < 2 ? 'transitioning' : 'stopped', billing: 'storage-only' }));
  });
  const gpu = createGpuController({ sleep: { url }, status: { url }, clock: () => now, wait: async ms => { now += ms; }, pollMs: 10, verifyTimeoutMs: 100 });
  const state = await gpu.sleep();
  assert.equal(state.state, 'stopped'); assert.equal(state.billing, 'storage-only'); assert.equal(state.verified, true);
  assert.equal(reads, 2);
});

test('invalid provider status and redirects fail without exposing credential or claiming resource stopped', async t => {
  const { createGpuController } = await import('../src/gpu-control.mjs');
  const url = await fixture(t, (req, res) => { res.end(req.method === 'POST' ? '{}' : '{"state":"stopped","billing":false}'); });
  const gpu = createGpuController({ sleep: { url, apiKey: 'private-gpu-key' }, status: { url, apiKey: 'private-gpu-key' } });
  await assert.rejects(gpu.sleep(), error => !error.message.includes('private-gpu-key'));
  assert.equal(gpu.snapshot().state, 'unknown'); assert.equal(gpu.snapshot().billing, 'unknown');
});
