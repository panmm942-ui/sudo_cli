import * as os from 'node:os';
import { execFile } from 'node:child_process';
import { win32 } from 'node:path';
import { createHash } from 'node:crypto';
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
const driverCode = value => { const code = bytes(value); return code !== null && code <= 65535 ? code : null; };
const capacitySources = new Set(['dxgi', 'windows-driver-registry-qword', 'nvidia-smi', 'ioreg']);
const capacitySource = value => capacitySources.has(value) ? value : 'unavailable';
const deviceState = (value, code) => code !== null && code > 0 ? 'driver-error'
  : ['ready', 'driver-error', 'unavailable', 'unknown'].includes(value) ? value : 'unknown';
const gpuMessage = row => row.driverErrorCode > 0 ? `Windows reports GPU driver error ${row.driverErrorCode}.`
  : row.status === 'warming-up' ? 'Waiting for another GPU sample.'
  : row.status === 'unavailable' ? 'Live GPU readings are unavailable.' : null;

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
    const row = { id: `nvidia-${values[0]}`, name: cleanName(values[1], 'NVIDIA GPU'), identified: true, percent: usage,
      vramUsedBytes: usedBytes, vramTotalBytes: totalBytes, sharedUsedBytes: null, sharedTotalBytes: null, memoryKind: 'dedicated',
      driverErrorCode: null, deviceStatus: 'ready', status: usage === null ? 'unavailable' : 'available',
      capacitySource: totalBytes === null ? 'unavailable' : 'nvidia-smi' };
    row.message = gpuMessage(row); adapters.push(row);
  }
  return { source: adapters.length ? 'nvidia-smi' : 'unavailable', adapters };
}

function luid(value) {
  const match = /^luid_0x([\da-f]{1,8})_0x([\da-f]{1,8})_phys_(\d+)$/i.exec(value || '');
  return match ? `luid_0x${match[1].toLowerCase().padStart(8, '0')}_0x${match[2].toLowerCase().padStart(8, '0')}_phys_${match[3]}` : null;
}

const pnpIdentity = value => typeof value === 'string' && value.length > 0 && value.length <= 512 && /^[A-Za-z0-9_&\\#{}-]+$/.test(value) ? value.toLowerCase() : null;
function inventoryId(row) {
  const id = luid(row?.id); if (id) return id;
  const pnp = pnpIdentity(row?.pnpDeviceId);
  return pnp && row?.id === 'device_' + createHash('sha256').update(pnp).digest('hex') ? row.id : null;
}
function normalizeInventory(rows) {
  if (!Array.isArray(rows) || rows.length > 128) return [];
  const result = [], seen = new Set();
  // A LUID record can attach live counters to the exact installed PNP instance.
  const ordered = rows.map((row, index) => ({ row, index })).sort((a, b) => Number(Boolean(luid(b.row?.id))) - Number(Boolean(luid(a.row?.id))) || a.index - b.index);
  for (const { row } of ordered) {
    const id = inventoryId(row); if (!id) continue;
    const pnp = pnpIdentity(row.pnpDeviceId), identity = pnp || id;
    if (seen.has(identity) || seen.has(id)) continue;
    seen.add(identity); seen.add(id);
    result.push({ ...row, id, pnpDeviceId: pnp, dedicatedBytes: bytes(row.dedicatedBytes), sharedBytes: bytes(row.sharedBytes),
      driverErrorCode: driverCode(row.driverErrorCode), capacitySource: capacitySource(row.capacitySource || (luid(id) ? 'dxgi' : undefined)) });
    if (result.length === 64) break;
  }
  return result;
}

function mergeInventory(oldRows, newRows) {
  const sameDevice = (left, right) => left.id === right.id || left.pnpDeviceId && left.pnpDeviceId === right.pnpDeviceId;
  const updated = newRows.map(row => {
    const old = oldRows.find(value => sameDevice(row, value));
    if (!old || row.dedicatedBytes !== null || row.sharedBytes !== null) return row;
    return { ...row, dedicatedBytes: old.dedicatedBytes, sharedBytes: old.sharedBytes, capacitySource: old.capacitySource };
  });
  // Fresh device state owns an exact identity even when a failed driver no longer has a LUID.
  const retained = oldRows.filter(old => !updated.some(row => sameDevice(row, old)));
  return normalizeInventory([...updated, ...retained]);
}

/** Windows GPU usage uses PERF_100NSEC_TIMER deltas, summed by engine across processes. */
export function parseWindowsGpu(text, previous = new Map(), inventory = []) {
  const baseline = new Map(), adapters = new Map(), capacities = new Map();
  const installed = normalizeInventory(inventory);
  for (const row of installed) capacities.set(row.id, row);
  let value;
  try { value = typeof text === 'string' && text.length <= 512 * 1024 ? JSON.parse(text.replace(/^\uFEFF/, '')) : null; } catch { value = null; }
  const countersAvailable = Array.isArray(value?.engines) && Array.isArray(value?.memory) && value.engines.length <= 4096 && value.memory.length <= 64;
  if (!countersAvailable) value = { engines: [], memory: [] };
  const adapter = id => {
    if (!adapters.has(id)) {
      const info = capacities.get(id), dedicated = bytes(info?.dedicatedBytes), shared = bytes(info?.sharedBytes);
      const code = driverCode(info?.driverErrorCode), memoryKind = dedicated === 0 && shared > 0 ? 'shared' : dedicated > 0 || !info ? 'dedicated' : 'unknown';
      adapters.set(id, { id, pnpDeviceId: info?.pnpDeviceId || null, name: cleanName(info?.name, 'Windows GPU'),
        identified: info?.identified !== false && typeof info?.name === 'string' && Boolean(info.name.trim()), percent: null, vramUsedBytes: null,
        vramTotalBytes: memoryKind === 'shared' ? shared : dedicated !== null && dedicated > 0 ? dedicated : null, sharedUsedBytes: null,
        sharedTotalBytes: shared, memoryKind, driverErrorCode: code, deviceStatus: deviceState(info?.deviceStatus || (info && luid(id) ? 'ready' : undefined), code),
        capacitySource: info?.capacitySource || 'unavailable', status: 'unavailable', engines: new Map(), needsBaseline: false });
    }
    return adapters.get(id);
  };
  // Installed cards are inventory, not an accidental by-product of busy counters.
  for (const row of installed) adapter(row.id);
  for (const row of value.memory) {
    const id = luid(row?.Name), dedicated = bytes(row?.DedicatedUsage), shared = bytes(row?.SharedUsage);
    if (!id || dedicated === null && shared === null) continue;
    const target = adapter(id);
    if (['driver-error', 'unavailable'].includes(target.deviceStatus)) continue;
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
    if (['driver-error', 'unavailable'].includes(target.deviceStatus)) continue;
    if (!old || busy < old.busy || time <= old.time) { target.needsBaseline = true; continue; }
    const usage = Number(busy - old.busy) / Number(time - old.time) * 100;
    if (!Number.isFinite(usage) || usage < 0) continue;
    target.engines.set(match[2], (target.engines.get(match[2]) || 0) + usage);
  }
  for (const row of adapters.values()) {
    if (row.engines.size) row.percent = Math.min(100, Math.max(...row.engines.values()));
    row.status = row.percent !== null ? 'available' : row.needsBaseline ? 'warming-up' : 'unavailable';
    row.message = gpuMessage(row); delete row.engines; delete row.needsBaseline;
  }
  return { source: adapters.size ? countersAvailable ? 'windows-gpu-counters' : 'windows-gpu-inventory' : 'unavailable', adapters: [...adapters.values()], baseline,
    warmingUp: [...adapters.values()].some(row => row.status === 'warming-up') && ![...adapters.values()].some(row => row.percent !== null) };
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
    const row = { id: `macos-${adapters.length}`, name, identified: false, percent: usage, vramUsedBytes: used,
      vramTotalBytes: shared || used !== null && total !== null && used > total ? null : total,
      sharedUsedBytes: shared ? used : null, sharedTotalBytes: null, memoryKind: shared ? 'shared' : 'dedicated',
      driverErrorCode: null, deviceStatus: 'unknown', status: usage === null ? 'unavailable' : 'available', capacitySource: total === null || shared ? 'unavailable' : 'ioreg' };
    row.message = gpuMessage(row); adapters.push(row);
  }
  return { source: adapters.length ? 'macos-ioreg' : 'unavailable', adapters };
}

/** OS-local measurements only. Missing drivers/tools/permission never become synthetic zeros. */
export function createGpuSampler({ platform = process.platform, run = runPerformanceProbe, env = process.env, clock = Date.now, inventoryRetryMs = 60000 } = {}) {
  if (typeof clock !== 'function' || !Number.isSafeInteger(inventoryRetryMs) || inventoryRetryMs < 1 || inventoryRetryMs > 3600000) throw new Error('Invalid GPU inventory interval.');
  let baseline = new Map(), inventoryPromise, inventoryRows = [], nextInventoryAt = 0;
  const powershell = win32.join(env.SystemRoot || env.SYSTEMROOT || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
  const psArgs = script => ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', script];
  function getInventory(signal) {
    if (inventoryPromise) return inventoryPromise;
    const now = clock();
    if (now < nextInventoryAt) return Promise.resolve(inventoryRows);
    const pending = Promise.resolve().then(() => run(powershell, psArgs(windowsGpuInventory), { signal, env, timeoutMs: 4000, maxBytes: 32768 }))
      .then(result => {
        const text = output(result); if (text.length > 32768) throw new Error('Inventory limit');
        const payload = JSON.parse(text.replace(/^\uFEFF/, ''));
        const rawRows = Array.isArray(payload) ? payload : payload?.adapters;
        if (!Array.isArray(rawRows) || rawRows.length > 64) throw new Error('Invalid inventory');
        const rows = normalizeInventory(rawRows);
        if (signal?.aborted) return inventoryRows;
        const complete = (Array.isArray(payload) || payload.complete === true) && rows.length > 0
          && !rows.some(row => row.driverErrorCode > 0 || !luid(row.id));
        inventoryRows = complete ? rows : mergeInventory(inventoryRows, rows);
        nextInventoryAt = complete ? Infinity : clock() + inventoryRetryMs;
        return inventoryRows;
      }).catch(() => { nextInventoryAt = signal?.aborted ? 0 : clock() + inventoryRetryMs; return inventoryRows; })
      .finally(() => { if (inventoryPromise === pending) inventoryPromise = undefined; });
    inventoryPromise = pending; return pending;
  }
  const sample = async ({ signal } = {}) => {
    try {
      if (signal?.aborted) return unavailableGpu();
      if (platform === 'win32') {
        const inventoryRead = getInventory(signal);
        const [text, inventory] = await Promise.all([Promise.resolve().then(() => run(powershell, psArgs(windowsGpuCounters), { signal, env })).catch(() => null), inventoryRead]);
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
      const adapters = value.adapters.map((row, index) => {
        const code = driverCode(row?.driverErrorCode), state = deviceState(row?.deviceStatus, code), blocked = ['driver-error', 'unavailable'].includes(state);
        const usage = blocked ? null : percent(row?.percent), status = usage !== null ? 'available' : row?.status === 'warming-up' ? 'warming-up' : 'unavailable';
        const result = { id: cleanName(row?.id, `gpu-${index}`), name: cleanName(row?.name, 'GPU'),
        identified: row?.identified === true,
        pnpDeviceId: pnpIdentity(row?.pnpDeviceId), driverErrorCode: code, deviceStatus: state, status, capacitySource: capacitySource(row?.capacitySource),
        percent: usage, vramUsedBytes: blocked ? null : bytes(row?.vramUsedBytes), vramTotalBytes: bytes(row?.vramTotalBytes),
        sharedUsedBytes: blocked ? null : bytes(row?.sharedUsedBytes), sharedTotalBytes: bytes(row?.sharedTotalBytes),
        memoryKind: ['dedicated', 'shared'].includes(row?.memoryKind) ? row.memoryKind : 'unknown' };
        result.message = gpuMessage(result); return result;
      });
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
      current.vram = { status: usedBytes === null && totalBytes === null ? 'unavailable' : usage === null ? 'partial' : 'available',
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
