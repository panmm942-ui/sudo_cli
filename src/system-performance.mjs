import * as os from 'node:os';
import { execFile } from 'node:child_process';
import { win32 } from 'node:path';
import { isolatedEnvironment } from './permission-scope.mjs';
import { windowsGpuCounters, windowsGpuInventory } from './system-performance-windows.mjs';

const numeric = value => typeof value === 'number' && Number.isFinite(value) ? value
  : typeof value === 'string' && /^\d+(?:\.\d+)?$/.test(value.trim()) ? Number(value) : null;
const bytes = value => { const number = numeric(value); return Number.isSafeInteger(number) && number >= 0 ? number : null; };
const percent = value => { const number = numeric(value); return number !== null && number >= 0 && number <= 100 ? number : null; };
const counter = value => {
  if (typeof value === 'number' && Number.isSafeInteger(value) && value >= 0) return BigInt(value);
  if (typeof value === 'string' && /^\d{1,20}$/.test(value)) { const parsed = BigInt(value); return parsed <= 0xffffffffffffffffn ? parsed : null; }
  return null;
};
const cleanName = (value, fallback) => typeof value === 'string' ? value.replace(/[\p{Cc}\p{Cf}]/gu, '').slice(0, 128) || fallback : fallback;
const output = result => typeof result === 'string' ? result : result?.stdout || '';
const unavailableGpu = () => ({ source: 'unavailable', adapters: [] });

/** Fixed executable/argument probes: no shell, profiles, inherited keys, or unbounded output. */
export function runPerformanceProbe(command, args, { signal, timeoutMs = 2500, maxBytes = 512 * 1024, env = process.env } = {}) {
  if (typeof command !== 'string' || !Array.isArray(args) || args.some(value => typeof value !== 'string')
      || !Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 10000
      || !Number.isSafeInteger(maxBytes) || maxBytes < 1 || maxBytes > 1024 * 1024) return Promise.reject(new Error('Performance probe unavailable.'));
  return new Promise((resolve, reject) => {
    try {
      execFile(command, args, { shell: false, windowsHide: true, encoding: 'utf8', signal,
        timeout: timeoutMs, killSignal: 'SIGKILL', maxBuffer: maxBytes, cwd: os.tmpdir(),
        env: isolatedEnvironment(env, { LC_ALL: 'C', LANG: 'C' }) }, (error, stdout) => {
        if (error) reject(new Error('Performance probe unavailable.'));
        else resolve(stdout);
      });
    } catch { reject(new Error('Performance probe unavailable.')); }
  });
}

function csvFields(line) {
  const values = [], expression = /(?:^|,)\s*(?:"((?:[^"]|"")*)"|([^,]*))/g;
  for (const match of line.matchAll(expression)) values.push((match[1] === undefined ? match[2] : match[1].replace(/""/g, '"')).trim());
  return values;
}

/** nvidia-smi reports framebuffer memory in MiB and explicitly marks unsupported fields N/A. */
export function parseNvidiaGpu(text) {
  const adapters = [];
  if (typeof text !== 'string' || text.length > 512 * 1024) return unavailableGpu();
  for (const line of text.trim().split(/\r?\n/)) {
    const values = csvFields(line);
    if (values.length !== 5 || !/^\d{1,3}$/.test(values[0]) || !values[1]) continue;
    const usage = percent(values[2]), used = bytes(values[3]), total = bytes(values[4]);
    const absent = value => /^(?:\[?N\/A\]?|Not Supported)$/i.test(value);
    if (usage === null && !absent(values[2]) || used === null && !absent(values[3]) || total === null && !absent(values[4]) || used !== null && total !== null && used > total) continue;
    const usedBytes = used === null ? null : bytes(used * 1024 ** 2), totalBytes = total === null ? null : bytes(total * 1024 ** 2);
    adapters.push({ id: `nvidia-${values[0]}`, name: cleanName(values[1], 'NVIDIA GPU'), identified: true, percent: usage,
      vramUsedBytes: usedBytes, vramTotalBytes: totalBytes, sharedUsedBytes: null, memoryKind: 'dedicated' });
  }
  return { source: adapters.length ? 'nvidia-smi' : 'unavailable', adapters };
}

function luid(value) {
  const match = /^luid_0x([\da-f]{1,8})_0x([\da-f]{1,8})_phys_(\d+)$/i.exec(value || '');
  return match ? `luid_0x${match[1].toLowerCase().padStart(8, '0')}_0x${match[2].toLowerCase().padStart(8, '0')}_phys_${match[3]}` : null;
}

/** Windows GPU usage uses PERF_100NSEC_TIMER deltas, summed by engine across processes. */
export function parseWindowsGpu(text, previous = new Map(), inventory = []) {
  const baseline = new Map(), adapters = new Map(), capacities = new Map();
  let value;
  try { value = typeof text === 'string' && text.length <= 512 * 1024 ? JSON.parse(text.replace(/^\uFEFF/, '')) : null; } catch { value = null; }
  if (!Array.isArray(value?.engines) || !Array.isArray(value?.memory) || value.engines.length > 4096 || value.memory.length > 64) return { ...unavailableGpu(), baseline };
  for (const row of inventory) {
    const id = luid(row?.id); if (id) capacities.set(id, row);
  }
  const adapter = id => {
    if (!adapters.has(id)) {
      const info = capacities.get(id), dedicated = bytes(info?.dedicatedBytes), shared = bytes(info?.sharedBytes);
      adapters.set(id, { id, name: cleanName(info?.name, 'Windows GPU'), identified: typeof info?.name === 'string' && Boolean(info.name.trim()), percent: null, vramUsedBytes: null,
        vramTotalBytes: dedicated && dedicated > 0 ? dedicated : null, sharedUsedBytes: null,
        sharedTotalBytes: shared, memoryKind: dedicated === 0 && shared > 0 ? 'shared' : 'dedicated', engines: new Map() });
    }
    return adapters.get(id);
  };
  for (const row of value.memory) {
    const id = luid(row?.Name), dedicated = bytes(row?.DedicatedUsage), shared = bytes(row?.SharedUsage);
    if (!id || dedicated === null && shared === null) continue;
    const target = adapter(id);
    target.vramUsedBytes = target.memoryKind === 'shared' ? shared : dedicated;
    if (target.memoryKind === 'shared') target.vramTotalBytes = target.sharedTotalBytes;
    target.sharedUsedBytes = shared;
    // A capacity mismatch is unknown, never a percentage larger than 100.
    if (target.vramUsedBytes !== null && target.vramTotalBytes !== null && target.vramUsedBytes > target.vramTotalBytes) target.vramTotalBytes = null;
  }
  for (const row of value.engines) {
    const match = /^pid_\d+_(luid_0x[\da-f]+_0x[\da-f]+_phys_\d+)_eng_(\d+)_engtype_.+$/i.exec(row?.Name || '');
    const id = match && luid(match[1]), busy = counter(row?.UtilizationPercentage), time = counter(row?.Timestamp_Sys100NS);
    if (!id || busy === null || time === null) continue;
    baseline.set(row.Name, { busy, time });
    const target = adapter(id), old = previous.get(row.Name);
    if (!old || busy < old.busy || time <= old.time) continue;
    const usage = Number(busy - old.busy) / Number(time - old.time) * 100;
    if (!Number.isFinite(usage) || usage < 0) continue;
    target.engines.set(match[2], (target.engines.get(match[2]) || 0) + usage);
  }
  for (const row of adapters.values()) {
    if (row.engines.size) row.percent = Math.min(100, Math.max(...row.engines.values()));
    delete row.engines;
  }
  return { source: adapters.size ? 'windows-gpu-counters' : 'unavailable', adapters: [...adapters.values()], baseline,
    warmingUp: baseline.size > 0 && ![...adapters.values()].some(row => row.percent !== null) };
}

/** IOAccelerator statistics are driver-dependent; only explicit utilization/byte fields qualify. */
export function parseMacGpu(text) {
  const adapters = [];
  if (typeof text !== 'string' || text.length > 512 * 1024) return unavailableGpu();
  for (const block of text.split(/(?=\+-o )/)) {
    const header = /\+-o ([^\r\n<]+)/.exec(block);
    const stats = /"PerformanceStatistics"\s*=\s*\{([^\r\n]*)\}/.exec(block);
    if (!header || !stats) continue;
    const field = name => numeric(new RegExp(`"${name}"\\s*=\\s*(\\d+(?:\\.\\d+)?)`).exec(stats[1])?.[1]);
    const usage = percent(field('Device Utilization %')), used = bytes(field('vramUsedBytes')), total = bytes(field('vramTotalBytes'));
    if (usage === null && used === null) continue;
    const name = cleanName(header[1].trim(), 'macOS GPU'), shared = /AGX|Apple.*(?:GPU|M\d)/i.test(name);
    adapters.push({ id: `macos-${adapters.length}`, name, identified: false, percent: usage, vramUsedBytes: used,
      vramTotalBytes: shared || used !== null && total !== null && used > total ? null : total,
      sharedUsedBytes: shared ? used : null, memoryKind: shared ? 'shared' : 'dedicated' });
  }
  return { source: adapters.length ? 'macos-ioreg' : 'unavailable', adapters };
}

/** OS-local measurements only. Missing drivers/tools/permission never become synthetic zeros. */
export function createGpuSampler({ platform = process.platform, run = runPerformanceProbe, env = process.env } = {}) {
  let baseline = new Map(), inventoryPromise;
  const powershell = win32.join(env.SystemRoot || env.SYSTEMROOT || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
  const psArgs = script => ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', script];
  const sample = async ({ signal } = {}) => {
    try {
      if (signal?.aborted) return unavailableGpu();
      if (platform === 'win32') {
        if (!inventoryPromise) inventoryPromise = run(powershell, psArgs(windowsGpuInventory), { signal, env, timeoutMs: 4000, maxBytes: 32768 })
          .then(result => { try { const rows = JSON.parse(output(result)); return Array.isArray(rows) && rows.length <= 64 ? rows : []; } catch { return []; } }, () => []);
        const [text, inventory] = await Promise.all([run(powershell, psArgs(windowsGpuCounters), { signal, env }), inventoryPromise]);
        if (signal?.aborted) return unavailableGpu();
        const result = parseWindowsGpu(output(text), baseline, inventory); baseline = result.baseline;
        const { baseline: _baseline, ...snapshot } = result; return snapshot;
      }
      if (platform === 'linux') return parseNvidiaGpu(output(await run('nvidia-smi', ['--query-gpu=index,name,utilization.gpu,memory.used,memory.total', '--format=csv,noheader,nounits'], { signal, env })));
      if (platform === 'darwin') return parseMacGpu(output(await run('/usr/sbin/ioreg', ['-r', '-c', 'IOAccelerator', '-l', '-w', '0'], { signal, env })));
    } catch { baseline = new Map(); }
    return unavailableGpu();
  };
  sample.reset = () => { baseline = new Map(); };
  return sample;
}

const emptyCpu = (status = 'unavailable') => ({ status, percent: null, sampledAtMs: null, source: 'os-cpu-times' });
const emptyRam = () => ({ status: 'unavailable', usedBytes: null, totalBytes: null, percent: null, sampledAtMs: null, source: 'os-memory' });
const emptyGpu = () => ({ status: 'unavailable', percent: null, adapters: [], sampledAtMs: null, source: 'unavailable' });
const emptyVram = () => ({ status: 'unavailable', usedBytes: null, totalBytes: null, percent: null, memoryKind: 'unknown', sampledAtMs: null, source: 'unavailable' });

/** Starts without awaiting external probes; CPU/RAM and GPU have independent timers. */
export function createSystemPerformance({ platform = process.platform, system = os, gpuSampler = createGpuSampler({ platform }),
  clock = Date.now, intervalMs = 1500, cpuMemoryIntervalMs = intervalMs, gpuIntervalMs = 3000 } = {}) {
  if (typeof gpuSampler !== 'function' || typeof clock !== 'function' || !system
      || ![cpuMemoryIntervalMs, gpuIntervalMs].every(value => Number.isSafeInteger(value) && value >= 0)) throw new Error('Performance monitor needs valid samplers and intervals.');
  let current = { scope: 'local-computer', status: 'idle', sampledAtMs: null,
    cpu: emptyCpu(), ram: emptyRam(), gpu: emptyGpu(), vram: emptyVram() };
  let previous, cpuTimer, gpuTimer, inFlight, controller, generation = 0;
  const snapshot = () => ({ ...current, cpu: { ...current.cpu }, ram: { ...current.ram },
    gpu: { ...current.gpu, adapters: current.gpu.adapters.map(value => ({ ...value })) }, vram: { ...current.vram } });
  function sampleCpuMemory() {
    const sampledAtMs = clock();
    if (!Number.isFinite(sampledAtMs)) return;
    try {
      const rows = system.cpus();
      if (!Array.isArray(rows) || !rows.length) throw new Error('No counters');
      const times = rows.map(row => {
        const values = ['user', 'nice', 'sys', 'idle', 'irq'].map(field => bytes(row?.times?.[field]));
        if (values.some(value => value === null)) throw new Error('Invalid counter');
        return { total: values.reduce((a, b) => a + b, 0), idle: values[3] };
      });
      let busy = 0, total = 0, valid = previous?.length === times.length;
      if (valid) for (let i = 0; i < times.length; i++) {
        const elapsed = times[i].total - previous[i].total, idle = times[i].idle - previous[i].idle;
        if (elapsed < 0 || idle < 0 || idle > elapsed) { valid = false; break; }
        total += elapsed; busy += elapsed - idle;
      }
      const usage = valid && total > 0 ? Math.max(0, Math.min(100, busy / total * 100)) : null;
      current.cpu = { status: usage === null ? 'warming-up' : 'available', percent: usage, sampledAtMs, source: 'os-cpu-times' };
      previous = times;
    } catch { previous = undefined; current.cpu = { ...emptyCpu(), sampledAtMs }; }
    try {
      const total = bytes(system.totalmem()), free = bytes(system.freemem());
      if (total === null || total <= 0 || free === null || free > total) throw new Error('Invalid memory');
      current.ram = { status: 'available', usedBytes: total - free, totalBytes: total, percent: (total - free) / total * 100, sampledAtMs, source: 'os-memory' };
    } catch { current.ram = { ...emptyRam(), sampledAtMs }; }
    current.sampledAtMs = sampledAtMs;
  }
  function sampleGpu() {
    if (inFlight) return inFlight;
    const owner = generation, abort = new AbortController(); controller = abort;
    // Invoke immediately so stop() can cancel work before the next microtask.
    let result;
    try { result = gpuSampler({ signal: abort.signal }); } catch { result = Promise.reject(new Error('Unavailable')); }
    const pending = Promise.resolve(result).then(value => {
      if (owner !== generation || abort.signal.aborted) return;
      const sampledAtMs = clock();
      if (!Number.isFinite(sampledAtMs) || !Array.isArray(value?.adapters) || value.adapters.length > 64) throw new Error('Invalid GPU data');
      const adapters = value.adapters.map((row, index) => ({ id: cleanName(row?.id, `gpu-${index}`), name: cleanName(row?.name, 'GPU'),
        identified: row?.identified === true,
        percent: percent(row?.percent), vramUsedBytes: bytes(row?.vramUsedBytes), vramTotalBytes: bytes(row?.vramTotalBytes),
        sharedUsedBytes: bytes(row?.sharedUsedBytes), sharedTotalBytes: bytes(row?.sharedTotalBytes),
        memoryKind: ['dedicated', 'shared'].includes(row?.memoryKind) ? row.memoryKind : 'unknown' }));
      const usages = adapters.map(row => row.percent).filter(value => value !== null);
      const source = cleanName(value.source, 'unavailable');
      current.gpu = { status: usages.length ? 'available' : value.warmingUp ? 'warming-up' : 'unavailable',
        percent: usages.length ? Math.max(...usages) : null, adapters, sampledAtMs, source };
      const kinds = new Set(adapters.map(row => row.memoryKind));
      const memoryKind = kinds.size === 1 ? adapters[0].memoryKind : 'unknown';
      const usedKnown = adapters.length > 0 && adapters.every(row => row.vramUsedBytes !== null);
      const totalKnown = adapters.length > 0 && adapters.every(row => row.vramTotalBytes !== null && row.vramTotalBytes > 0);
      const usedBytes = usedKnown ? adapters.reduce((sum, row) => sum + row.vramUsedBytes, 0) : null;
      const totalBytes = totalKnown ? adapters.reduce((sum, row) => sum + row.vramTotalBytes, 0) : null;
      const usage = usedBytes !== null && totalBytes !== null && usedBytes <= totalBytes ? usedBytes / totalBytes * 100 : null;
      current.vram = { status: usedBytes === null ? 'unavailable' : usage === null ? 'partial' : 'available',
        usedBytes, totalBytes: usedBytes !== null && totalBytes !== null && usedBytes > totalBytes ? null : totalBytes,
        percent: usage, memoryKind, sampledAtMs, source };
    }).catch(() => {
      if (owner === generation && !abort.signal.aborted) { current.gpu = { ...emptyGpu(), sampledAtMs: clock() }; current.vram = { ...emptyVram(), sampledAtMs: clock() }; }
    }).then(snapshot).finally(() => {
      if (inFlight === pending) { inFlight = undefined; controller = undefined; }
    });
    inFlight = pending;
    return pending;
  }
  return {
    snapshot,
    sample() { sampleCpuMemory(); return sampleGpu(); },
    start() {
      if (current.status === 'running') return snapshot();
      previous = undefined; current.status = 'running'; sampleCpuMemory(); void sampleGpu();
      if (cpuMemoryIntervalMs > 0) { cpuTimer = setInterval(sampleCpuMemory, cpuMemoryIntervalMs); cpuTimer.unref?.(); }
      if (gpuIntervalMs > 0) { gpuTimer = setInterval(() => { void sampleGpu(); }, gpuIntervalMs); gpuTimer.unref?.(); }
      return snapshot();
    },
    stop() {
      generation++; current.status = 'stopped'; previous = undefined;
      clearInterval(cpuTimer); clearInterval(gpuTimer); cpuTimer = gpuTimer = undefined;
      controller?.abort();
      try { gpuSampler.reset?.(); } catch { /* A provider reset cannot prevent timer/probe cleanup. */ }
    },
  };
}
