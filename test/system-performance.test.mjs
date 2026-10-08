import test from 'node:test';
import assert from 'node:assert/strict';
import { setTimeout as delay } from 'node:timers/promises';

const api = await import('../src/system-performance.mjs').catch(error => {
  if (error.code === 'ERR_MODULE_NOT_FOUND') return {};
  throw error;
});
const feature = name => { assert.equal(typeof api[name], 'function', `${name} must be implemented`); return api[name]; };
const cpu = (user, idle, extra = {}) => ({ times: { user, nice: 0, sys: 0, idle, irq: 0, ...extra } });
const noGpu = async () => ({ source: 'unavailable', adapters: [] });
const windows = (engines, memory = []) => JSON.stringify({ engines, memory });
const engine = (pid, number, value, time, luid = 'luid_0x0_0x1_phys_0') => ({ Name: `pid_${pid}_${luid}_eng_${number}_engtype_3D`, UtilizationPercentage: String(value), Timestamp_Sys100NS: String(time) });

test('CPU shows measured busy time after two samples while RAM uses current OS bytes', async () => {
  let rows = [cpu(10, 90), cpu(20, 80)], free = 600, now = 1000;
  const monitor = feature('createSystemPerformance')({ intervalMs: 0, gpuIntervalMs: 0, clock: () => now,
    system: { cpus: () => rows, totalmem: () => 1000, freemem: () => free }, gpuSampler: noGpu });
  await monitor.sample();
  assert.equal(monitor.snapshot().scope, 'local-computer');
  assert.equal(monitor.snapshot().cpu.percent, null);
  assert.equal(monitor.snapshot().cpu.status, 'warming-up');
  rows = [cpu(40, 160), cpu(40, 160)]; free = 300; now = 2500;
  await monitor.sample();
  assert.equal(monitor.snapshot().cpu.percent, 25);
  assert.equal(monitor.snapshot().ram.percent, 70);
  assert.equal(monitor.snapshot().ram.usedBytes, 700);
  assert.equal(monitor.snapshot().cpu.sampledAtMs, 2500);
  monitor.stop();
});

test('CPU resets and empty counters cannot become fake zero usage', async () => {
  let rows = [cpu(100, 100)];
  const monitor = feature('createSystemPerformance')({ intervalMs: 0, gpuIntervalMs: 0,
    system: { cpus: () => rows, totalmem: () => 100, freemem: () => 101 }, gpuSampler: noGpu });
  await monitor.sample(); rows = [cpu(1, 1)]; await monitor.sample();
  assert.equal(monitor.snapshot().cpu.percent, null);
  assert.equal(monitor.snapshot().ram.usedBytes, null);
  rows = []; await monitor.sample();
  assert.equal(monitor.snapshot().cpu.status, 'unavailable');
  monitor.stop();
});

test('NVIDIA CSV preserves N/A and converts MiB without counting memory bandwidth as VRAM', () => {
  const parse = feature('parseNvidiaGpu');
  const rows = parse('0, "NVIDIA, device", 37, 1024, 8192\n1, NVIDIA other, [N/A], N/A, 4096\n');
  assert.equal(rows.adapters[0].name, 'NVIDIA, device');
  assert.equal(rows.adapters[0].percent, 37);
  assert.equal(rows.adapters[0].vramUsedBytes, 1024 * 1024 * 1024);
  assert.equal(rows.adapters[0].vramTotalBytes, 8192 * 1024 * 1024);
  assert.equal(rows.adapters[1].percent, null);
  assert.equal(rows.adapters[1].vramUsedBytes, null);
  assert.deepEqual(parse('0, Device, -1, 20, 10').adapters, []);
  assert.deepEqual(parse('0, Device, 200, 0, 10').adapters, []);
});

test('Windows raw GPU deltas sum process time per engine and select the busiest engine', () => {
  const parse = feature('parseWindowsGpu');
  const baseTime = 134000000000000000n;
  const memory = [{ Name: 'luid_0x0_0x1_phys_0', DedicatedUsage: '123456', SharedUsage: '654321' }];
  const first = parse(windows([engine(1, 0, 500, baseTime), engine(2, 0, 900, baseTime), engine(1, 1, 100, baseTime)], memory));
  assert.equal(first.adapters[0].percent, null);
  const next = parse(windows([engine(1, 0, 800, baseTime + 1000n), engine(2, 0, 1000, baseTime + 1000n), engine(1, 1, 300, baseTime + 1000n)], memory), first.baseline);
  assert.equal(next.adapters[0].percent, 40);
  assert.equal(next.adapters[0].vramUsedBytes, 123456);
  assert.equal(next.adapters[0].sharedUsedBytes, 654321);
  assert.equal(next.adapters[0].vramTotalBytes, null);
  assert.equal(next.adapters[0].memoryKind, 'dedicated');
  const reset = parse(windows([engine(1, 0, 2, baseTime + 2000n)], memory), next.baseline);
  assert.equal(reset.adapters[0].percent, null);
  assert.deepEqual(parse('{"engines":[{}],"memory":[]}').adapters, []);
});

test('macOS accepts explicit driver utilization and labels Apple memory as shared', () => {
  const parse = feature('parseMacGpu');
  const rows = parse('+-o AGXAccelerator <class AGXAccelerator>\n  "PerformanceStatistics" = {"Device Utilization %"=28,"vramUsedBytes"=1048576}\n');
  assert.equal(rows.adapters[0].percent, 28);
  assert.equal(rows.adapters[0].memoryKind, 'shared');
  assert.equal(rows.adapters[0].vramTotalBytes, null);
  assert.equal(parse('+-o GPU\n "PerformanceStatistics" = {"GPU Power"=3}').adapters.length, 0);
});

test('GPU aggregate keeps real zero usage and partial VRAM capacity truthful', async () => {
  const monitor = feature('createSystemPerformance')({ intervalMs: 0, gpuIntervalMs: 0,
    gpuSampler: async () => ({ source: 'test-counters', adapters: [
      { id: 'a', name: 'a', percent: 0, vramUsedBytes: 2, vramTotalBytes: 10, memoryKind: 'dedicated' },
      { id: 'b', name: 'b', percent: 40, vramUsedBytes: 3, vramTotalBytes: null, memoryKind: 'dedicated' },
    ] }) });
  await monitor.sample();
  const snapshot = monitor.snapshot();
  assert.equal(snapshot.gpu.percent, 40);
  assert.equal(snapshot.vram.usedBytes, 5);
  assert.equal(snapshot.vram.totalBytes, null);
  assert.equal(snapshot.vram.percent, null);
  snapshot.gpu.adapters[0].percent = 99;
  assert.equal(monitor.snapshot().gpu.adapters[0].percent, 0);
  monitor.stop();
});

test('start returns immediately and CPU/RAM continue during a single pending GPU probe', async () => {
  let calls = 0, resolve, ticks = 0;
  const monitor = feature('createSystemPerformance')({ intervalMs: 10, gpuIntervalMs: 10,
    system: { cpus: () => { ticks++; return [cpu(ticks, ticks)]; }, totalmem: () => 100, freemem: () => 50 },
    gpuSampler: () => { calls++; return new Promise(done => { resolve = done; }); } });
  const result = monitor.start();
  assert.equal(result.status, 'running');
  await delay(45);
  assert.ok(ticks >= 3);
  assert.equal(calls, 1);
  const first = monitor.sample(), second = monitor.sample();
  assert.equal(first, second);
  monitor.stop(); resolve({ source: 'test', adapters: [{ id: 'a', name: 'a', percent: 99 }] });
  await first;
  assert.equal(monitor.snapshot().gpu.percent, null);
  const stoppedTicks = ticks; await delay(30); assert.equal(ticks, stoppedTicks);
});

test('stop aborts the outstanding probe and failed reads discard stale GPU statistics', async () => {
  let fail = false, observedSignal;
  const monitor = feature('createSystemPerformance')({ intervalMs: 0, gpuIntervalMs: 0,
    gpuSampler: async ({ signal }) => { observedSignal = signal; if (fail) throw new Error('secret must never be surfaced'); return { source: 'test', adapters: [{ id: 'a', percent: 80, vramUsedBytes: 2, vramTotalBytes: 4, memoryKind: 'dedicated' }] }; } });
  await monitor.sample(); assert.equal(monitor.snapshot().gpu.percent, 80);
  fail = true; await monitor.sample();
  assert.equal(monitor.snapshot().gpu.status, 'unavailable');
  assert.equal(monitor.snapshot().vram.usedBytes, null);
  assert.ok(!JSON.stringify(monitor.snapshot()).includes('secret'));
  let aborted = false;
  const pending = feature('createSystemPerformance')({ intervalMs: 0, gpuIntervalMs: 0, gpuSampler: ({ signal }) => new Promise(resolve => {
    signal.addEventListener('abort', () => { aborted = true; resolve({ source: 'test', adapters: [] }); }, { once: true });
  }) });
  const promise = pending.sample(); pending.stop(); await promise; assert.equal(aborted, true);
  monitor.stop(); assert.ok(observedSignal);
});

test('Windows sampler uses raw CIM classes rather than localized counter paths', async () => {
  let args;
  const sampler = feature('createGpuSampler')({ platform: 'win32', run: async (_command, values) => { args = values; return windows([], [{ Name: 'luid_0x0_0x1_phys_0', DedicatedUsage: '0', SharedUsage: '0' }]); } });
  const result = await sampler({ signal: new AbortController().signal });
  assert.ok(args.includes('-NoProfile'));
  assert.ok(args.join(' ').includes('Win32_PerfRawData_GPUPerformanceCounters_GPUEngine'));
  assert.ok(!args.join(' ').includes('Get-Counter'));
  assert.equal(result.source, 'windows-gpu-counters');
});

test('DXGI 64-bit capacities join Windows counters by LUID and inventory runs only once', async () => {
  const parse = feature('parseWindowsGpu');
  const counters = windows([], [{ Name: 'luid_0x00000000_0x00000001_phys_0', DedicatedUsage: '1000', SharedUsage: '2000' }]);
  const inventory = [{ id: 'luid_0x00000000_0x00000001_phys_0', name: 'Big GPU', dedicatedBytes: 24 * 1024 ** 3, sharedBytes: 16 * 1024 ** 3 }];
  const result = parse(counters, undefined, inventory);
  assert.equal(result.adapters[0].vramTotalBytes, 24 * 1024 ** 3);
  assert.equal(result.adapters[0].name, 'Big GPU');
  assert.equal(result.adapters[0].identified, true);
  assert.equal(parse(counters).adapters[0].identified, false);
  let inventories = 0, reads = 0;
  const sampler = feature('createGpuSampler')({ platform: 'win32', run: async (_command, args) => {
    if (args.join(' ').includes('dxgi.dll')) { inventories++; return JSON.stringify(inventory); }
    reads++; return counters;
  } });
  assert.equal((await sampler()).adapters[0].vramTotalBytes, 24 * 1024 ** 3);
  await sampler(); assert.equal(inventories, 1); assert.equal(reads, 2);
});

test('stopping resets GPU delta baselines so restarting cannot average the idle gap', async () => {
  let time = 1000, busy = 100;
  const gpuSampler = feature('createGpuSampler')({ platform: 'win32', run: async (_command, args) => {
    if (args.join(' ').includes('dxgi.dll')) return '[]';
    return windows([engine(1, 0, busy, time)], [{ Name: 'luid_0x0_0x1_phys_0', DedicatedUsage: '0', SharedUsage: '0' }]);
  } });
  const monitor = feature('createSystemPerformance')({ intervalMs: 0, gpuIntervalMs: 0, gpuSampler });
  await monitor.sample(); time = 2000; busy = 500; await monitor.sample();
  assert.equal(monitor.snapshot().gpu.percent, 40);
  monitor.stop(); time = 10000000; busy = 9999999; await monitor.sample();
  assert.equal(monitor.snapshot().gpu.percent, null);
  assert.equal(monitor.snapshot().gpu.status, 'warming-up');
  monitor.stop();
});

test('bounded probe strips credentials and refuses timeout, excess output and cancellation', async () => {
  const run = feature('runPerformanceProbe');
  const source = { PATH: process.env.PATH, SystemRoot: process.env.SystemRoot, TEMP: process.env.TEMP, OPENAI_API_KEY: 'never-in-child', AWS_SECRET_ACCESS_KEY: 'never-in-child', NODE_OPTIONS: '--bad-option' };
  const result = await run(process.execPath, ['-e', 'process.stdout.write(JSON.stringify({secret:process.env.OPENAI_API_KEY,aws:process.env.AWS_SECRET_ACCESS_KEY,path:!!process.env.PATH}))'], { env: source });
  assert.deepEqual(JSON.parse(result), { path: true });
  await assert.rejects(run(process.execPath, ['-e', 'setTimeout(()=>{},10000)'], { timeoutMs: 60 }), /Performance probe unavailable/);
  await assert.rejects(run(process.execPath, ['-e', 'process.stdout.write("x".repeat(100000))'], { maxBytes: 1024 }), /Performance probe unavailable/);
  const controller = new AbortController();
  const pending = run(process.execPath, ['-e', 'setTimeout(()=>{},10000)'], { signal: controller.signal });
  controller.abort(); await assert.rejects(pending, /Performance probe unavailable/);
});
