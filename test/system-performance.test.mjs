import test from 'node:test';
import assert from 'node:assert/strict';
import { setTimeout as delay } from 'node:timers/promises';
import { createHash } from 'node:crypto';
import { win32 } from 'node:path';
import { windowsGpuInventory } from '../src/system-performance-windows.mjs';

const api = await import('../src/system-performance.mjs').catch(error => {
  if (error.code === 'ERR_MODULE_NOT_FOUND') return {};
  throw error;
});
const feature = name => { assert.equal(typeof api[name], 'function', `${name} must be implemented`); return api[name]; };
const cpu = (user, idle, extra = {}) => ({ times: { user, nice: 0, sys: 0, idle, irq: 0, ...extra } });
const noGpu = async () => ({ source: 'unavailable', adapters: [] });
const windows = (engines, memory = []) => JSON.stringify({ engines, memory });
const engine = (pid, number, value, time, luid = 'luid_0x0_0x1_phys_0') => ({ Name: `pid_${pid}_${luid}_eng_${number}_engtype_3D`, UtilizationPercentage: String(value), Timestamp_Sys100NS: String(time) });
const deviceId = pnp => 'device_' + createHash('sha256').update(pnp.toLowerCase()).digest('hex');
const nvidiaPnp = 'PCI\\VEN_10DE&DEV_2D98&SUBSYS_800D17AA&REV_A1\\NVIDIA_INSTANCE';
const unavailableNvidia = () => ({ id: deviceId(nvidiaPnp), pnpDeviceId: nvidiaPnp, name: 'NVIDIA GeForce RTX 5050 Laptop GPU',
  identified: true, dedicatedBytes: 8 * 1024 ** 3, sharedBytes: null, driverErrorCode: 43,
  deviceStatus: 'driver-error', capacitySource: 'windows-driver-registry-qword' });

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

test('installed NVIDIA capacity remains visible without a live counter or fabricated idle utilization', () => {
  const parse = feature('parseWindowsGpu');
  const inventory = [unavailableNvidia(), { id: 'luid_0x0_0x1_phys_0', name: 'AMD 780M', dedicatedBytes: 512 * 1024 ** 2, sharedBytes: 16 * 1024 ** 3 }];
  const result = parse(windows([], [{ Name: 'luid_0x0_0x1_phys_0', DedicatedUsage: '100', SharedUsage: '200' }]), undefined, inventory);
  const nvidia = result.adapters.find(row => row.name.includes('NVIDIA'));
  assert.ok(nvidia, 'installed inventory-only card must remain present');
  assert.equal(nvidia.vramTotalBytes, 8 * 1024 ** 3);
  assert.equal(nvidia.vramUsedBytes, null);
  assert.equal(nvidia.percent, null);
  assert.equal(nvidia.driverErrorCode, 43);
  assert.equal(nvidia.deviceStatus, 'driver-error');
  assert.equal(nvidia.status, 'unavailable');
  assert.equal(nvidia.capacitySource, 'windows-driver-registry-qword');
  assert.match(nvidia.message, /43/);
  assert.equal(result.adapters.find(row => row.name === 'AMD 780M').sharedUsedBytes, 200);
});

test('a GPU device error overrides otherwise readable zero live counters', () => {
  const parse = feature('parseWindowsGpu');
  const inventory = [{ ...unavailableNvidia(), id: 'luid_0x0_0x1_phys_0' }];
  const first = parse(windows([engine(1, 0, 0, 1000)], [{ Name: 'luid_0x0_0x1_phys_0', DedicatedUsage: '0', SharedUsage: '0' }]), undefined, inventory);
  const second = parse(windows([engine(1, 0, 0, 2000)], [{ Name: 'luid_0x0_0x1_phys_0', DedicatedUsage: '0', SharedUsage: '0' }]), first.baseline, inventory);
  assert.equal(second.adapters[0].percent, null);
  assert.equal(second.adapters[0].vramUsedBytes, null);
  assert.equal(second.adapters[0].vramTotalBytes, 8 * 1024 ** 3);
});

test('live counter failure retains verified GPU inventory and its capacity provenance in snapshots', async () => {
  const sampler = feature('createGpuSampler')({ platform: 'win32', run: async (_command, args) => {
    if (args.join(' ').includes('dxgi.dll')) return JSON.stringify({ adapters: [unavailableNvidia()], complete: true });
    throw new Error('CIM unavailable; diagnostic secret');
  } });
  const monitor = feature('createSystemPerformance')({ intervalMs: 0, gpuIntervalMs: 0, gpuSampler: sampler });
  await monitor.sample();
  const snapshot = monitor.snapshot();
  assert.equal(snapshot.gpu.adapters.length, 1);
  assert.equal(snapshot.gpu.adapters[0].driverErrorCode, 43);
  assert.equal(snapshot.gpu.adapters[0].capacitySource, 'windows-driver-registry-qword');
  assert.equal(snapshot.gpu.adapters[0].vramTotalBytes, 8 * 1024 ** 3);
  assert.equal(snapshot.gpu.percent, null);
  assert.ok(!JSON.stringify(snapshot).includes('diagnostic secret'));
  monitor.stop();
});

test('DXGI and installed-device records for the same exact PNP instance do not create two cards', () => {
  const parse = feature('parseWindowsGpu');
  const healthy = { ...unavailableNvidia(), driverErrorCode: 0, deviceStatus: 'ready' };
  const inventory = [healthy, { ...healthy, id: 'luid_0x0_0x1_phys_0', capacitySource: 'dxgi' }];
  const result = parse(windows([], []), undefined, inventory);
  assert.equal(result.adapters.length, 1);
  assert.equal(result.adapters[0].id, 'luid_0x00000000_0x00000001_phys_0');
  assert.equal(result.adapters[0].capacitySource, 'dxgi');
  const otherPnp = nvidiaPnp.replace('NVIDIA_INSTANCE', 'OTHER_INSTANCE');
  const separate = parse(windows([], []), undefined, [healthy, { ...healthy, id: deviceId(otherPnp), pnpDeviceId: otherPnp }]);
  assert.equal(separate.adapters.length, 2, 'identical GPU model names are not an identity match');
});

test('failed inventory queries retry after a bounded cooldown and later failures keep known capacity', async () => {
  let now = 0, inventories = 0;
  const sampler = feature('createGpuSampler')({ platform: 'win32', clock: () => now, inventoryRetryMs: 100,
    run: async (_command, args) => {
      if (!args.join(' ').includes('dxgi.dll')) return windows([], []);
      inventories++;
      if (inventories !== 2) throw new Error('Inventory temporarily unavailable');
      return JSON.stringify({ adapters: [unavailableNvidia()], complete: true });
    } });
  assert.equal((await sampler()).adapters.length, 0);
  now = 50; await sampler(); assert.equal(inventories, 1);
  now = 100; const recovered = await sampler(); assert.equal(recovered.adapters.length, 1); assert.equal(recovered.adapters[0].vramTotalBytes, 8 * 1024 ** 3);
  now = 200; const later = await sampler();
  assert.equal(inventories, 3, 'driver-error inventory is periodically refreshed too');
  assert.equal(later.adapters[0].vramTotalBytes, 8 * 1024 ** 3);
  assert.equal(later.adapters[0].percent, null);
});

test('fresh installed-device errors supersede a cached healthy LUID for the same PNP instance', async () => {
  let now = 0, inventories = 0;
  const healthy = { ...unavailableNvidia(), id: 'luid_0x0_0x1_phys_0', driverErrorCode: 0, deviceStatus: 'ready', capacitySource: 'dxgi' };
  const sampler = feature('createGpuSampler')({ platform: 'win32', clock: () => now, inventoryRetryMs: 100,
    run: async (_command, args) => {
      if (!args.join(' ').includes('dxgi.dll')) return windows([], [{ Name: 'luid_0x0_0x1_phys_0', DedicatedUsage: '100', SharedUsage: '200' }]);
      inventories++;
      return JSON.stringify({ adapters: inventories === 1 ? [healthy] : [{ ...unavailableNvidia(), dedicatedBytes: null }], complete: false });
    } });
  const first = await sampler();
  assert.equal(first.adapters[0].deviceStatus, 'ready');
  now = 100;
  const changed = await sampler();
  const identified = changed.adapters.filter(row => row.identified);
  assert.equal(identified.length, 1);
  assert.equal(identified[0].id, deviceId(nvidiaPnp));
  assert.equal(identified[0].driverErrorCode, 43);
  assert.equal(identified[0].deviceStatus, 'driver-error');
  assert.equal(identified[0].percent, null);
  assert.equal(identified[0].vramUsedBytes, null);
  assert.equal(identified[0].vramTotalBytes, 8 * 1024 ** 3, 'previously verified capacity survives an exact-PNP transient read failure');
  assert.equal(identified[0].capacitySource, 'dxgi');
});

test('a repaired installed GPU acquires its live LUID without a duplicate stale error row', async () => {
  let now = 0, inventories = 0;
  const healthy = { ...unavailableNvidia(), id: 'luid_0x0_0x1_phys_0', driverErrorCode: 0, deviceStatus: 'ready', capacitySource: 'dxgi' };
  const sampler = feature('createGpuSampler')({ platform: 'win32', clock: () => now, inventoryRetryMs: 100,
    run: async (_command, args) => {
      if (!args.join(' ').includes('dxgi.dll')) return windows([], []);
      inventories++;
      return JSON.stringify({ adapters: inventories === 1 ? [unavailableNvidia()] : [healthy], complete: true });
    } });
  assert.equal((await sampler()).adapters[0].driverErrorCode, 43);
  now = 100; const repaired = await sampler();
  assert.equal(repaired.adapters.length, 1);
  assert.equal(repaired.adapters[0].id, 'luid_0x00000000_0x00000001_phys_0');
  assert.equal(repaired.adapters[0].driverErrorCode, 0);
  assert.equal(repaired.adapters[0].capacitySource, 'dxgi');
  now = 1000; await sampler(); assert.equal(inventories, 2, 'complete healthy inventory is cached');
});

test('installed-device fallback rejects a capacity record with another PNP instance hash', () => {
  const result = feature('parseWindowsGpu')(windows([], []), undefined, [{ ...unavailableNvidia(), id: deviceId(nvidiaPnp + '_OTHER') }]);
  assert.equal(result.adapters.length, 0);
});

test('Windows installed capacity follows the exact display-class instance and accepts only QWORD bytes', { skip: process.platform !== 'win32' }, async () => {
  const run = feature('runPerformanceProbe');
  const powershell = win32.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
  const displayDriver = '{4d36e968-e325-11ce-bfc1-08002be10318}\\0042';
  async function readFixture(kind, driver = displayDriver) {
    // Mock only read APIs in an isolated child; the production inventory script resolves identity and byte type.
    const mocks = `
function Get-CimInstance {
  [CmdletBinding()] param([string]$ClassName)
  if ($ClassName -ne 'Win32_VideoController') { throw 'Unexpected class' }
  [pscustomobject]@{Name='Fixture installed GPU';PNPDeviceID='${nvidiaPnp}';ConfigManagerErrorCode=43;Status='Error'}
}
function Get-ItemProperty {
  [CmdletBinding()] param([string]$LiteralPath)
  if ($LiteralPath -cne 'Registry::HKEY_LOCAL_MACHINE\\SYSTEM\\CurrentControlSet\\Enum\\${nvidiaPnp}') { throw 'Wrong PNP instance' }
  [pscustomobject]@{Driver='${driver}'}
}
function Get-Item {
  [CmdletBinding()] param([string]$LiteralPath)
  if ($LiteralPath -cne 'Registry::HKEY_LOCAL_MACHINE\\SYSTEM\\CurrentControlSet\\Control\\Class\\${displayDriver}') { throw 'Wrong driver key' }
  $fixtureKey = [pscustomobject]@{Kind='${kind}';Size=[long]8589934592}
  $fixtureKey | Add-Member -MemberType ScriptMethod -Name GetValueKind -Value {
    param($name) if ($name -ne 'HardwareInformation.qwMemorySize') { throw 'Wrong capacity property' }
    [Microsoft.Win32.RegistryValueKind][Enum]::Parse([Microsoft.Win32.RegistryValueKind], $this.Kind)
  }
  $fixtureKey | Add-Member -MemberType ScriptMethod -Name GetValue -Value { param($name,$default) $this.Size }
  $fixtureKey | Add-Member -MemberType ScriptMethod -Name Close -Value { }
  $fixtureKey
}
`;
    const script = mocks + windowsGpuInventory.replace("Add-Type -TypeDefinition @'", "throw 'DXGI fixture unavailable'\nAdd-Type -TypeDefinition @'");
    // Cold CI PowerShell startup is outside this identity/type correctness
    // assertion. Production sampling bounds and timeout failures stay separate.
    return JSON.parse(await run(powershell, ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', script], { timeoutMs: 10000, maxBytes: 32768 }));
  }
  const valid = await readFixture('QWord');
  assert.equal(valid.complete, false, 'installed devices survive an independent DXGI failure');
  assert.equal(valid.adapters.length, 1);
  assert.equal(valid.adapters[0].id, deviceId(nvidiaPnp));
  assert.equal(valid.adapters[0].pnpDeviceId, nvidiaPnp);
  assert.equal(valid.adapters[0].dedicatedBytes, String(8 * 1024 ** 3));
  assert.equal(valid.adapters[0].driverErrorCode, 43);
  assert.equal(valid.adapters[0].capacitySource, 'windows-driver-registry-qword');
  for (const unsupported of [await readFixture('DWord'), await readFixture('QWord', '{00000000-0000-0000-0000-000000000000}\\0042')]) {
    assert.equal(unsupported.adapters.length, 1, 'unverified capacity does not erase installed inventory');
    assert.equal(unsupported.adapters[0].dedicatedBytes, null);
    assert.equal(unsupported.adapters[0].capacitySource, 'unavailable');
  }
});

test('known shared-only adapters retain shared capacity independently of unknown usage', () => {
  const result = feature('parseWindowsGpu')(windows([], []), undefined, [{ id: 'luid_0x0_0x1_phys_0', name: 'Integrated GPU', dedicatedBytes: 0, sharedBytes: 16 * 1024 ** 3 }]);
  assert.equal(result.adapters.length, 1);
  assert.equal(result.adapters[0].memoryKind, 'shared');
  assert.equal(result.adapters[0].vramTotalBytes, 16 * 1024 ** 3);
  assert.equal(result.adapters[0].sharedUsedBytes, null);
  assert.equal(result.adapters[0].vramUsedBytes, null);
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
