import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { readFile, readdir, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { performance } from 'node:perf_hooks';

const execute = promisify(execFile);
const counter = value => {
  if (typeof value === 'number' && Number.isSafeInteger(value) && value >= 0) return BigInt(value);
  if (typeof value === 'string' && /^\d{1,20}$/.test(value.trim())) { const parsed = BigInt(value.trim()); return parsed <= 0xffffffffffffffffn ? parsed : null; }
  return null;
};
async function runCommand(command, args) {
  const result = await execute(command, args, { encoding: 'utf8', windowsHide: true, timeout: 5000, maxBuffer: 512 * 1024, shell: false });
  return result.stdout;
}
const stdout = result => typeof result === 'string' ? result : result?.stdout || '';
const windowsScript = `
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)
$statistics = @{}
Get-NetAdapterStatistics -ErrorAction Stop | ForEach-Object { $statistics[$_.Name] = $_ }
$rows = @(Get-NetAdapter -ErrorAction Stop | ForEach-Object {
  $stats = $statistics[$_.Name]
  [pscustomobject]@{Name=$_.Name;InterfaceGuid=[string]$_.InterfaceGuid;HardwareInterface=$_.HardwareInterface;InterfaceType=$_.InterfaceType;NdisPhysicalMedium=$_.NdisPhysicalMedium;Status=[string]$_.Status;ReceivedBytes=[string]$stats.ReceivedBytes;SentBytes=[string]$stats.SentBytes}
})
ConvertTo-Json -InputObject $rows -Compress -Depth 3
`;

/** Local counters only: this never downloads test data or contacts an Internet service. */
export function createNetworkSampler({ platform = process.platform, run = runCommand, sysfsDir = '/sys/class/net' } = {}) {
  return async () => {
    try {
      if (platform === 'win32') {
        const rows = JSON.parse(stdout(await run('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', windowsScript])));
        if (!Array.isArray(rows) || !rows.every(row => row && typeof row.Name === 'string' && typeof row.HardwareInterface === 'boolean' && typeof row.Status === 'string')) return { supported: false, interfaces: [] };
        return { supported: true, interfaces: rows.filter(row => row.HardwareInterface === true).map(row => ({
          id: row.InterfaceGuid || row.Name, name: row.Name,
          wifi: [1, 9].includes(Number(row.NdisPhysicalMedium)) || Number(row.InterfaceType) === 71 ? true : Number(row.NdisPhysicalMedium) === 14 ? false : null,
          connected: row.Status === 'Up' ? true : ['Disconnected', 'Disabled', 'Not Present', 'LowerLayerDown', 'Dormant', 'Down'].includes(row.Status) ? false : null,
          rxBytes: row.ReceivedBytes, txBytes: row.SentBytes,
        })) };
      }
      if (platform === 'linux') {
        const present = async path => { try { await stat(path); return true; } catch (error) { if (error.code === 'ENOENT' || error.code === 'ENOTDIR') return false; throw error; } };
        const interfaces = [];
        for (const name of await readdir(sysfsDir)) {
          if (name === 'lo') continue;
          const path = join(sysfsDir, name);
          const wifi = await present(join(path, 'wireless')) || await present(join(path, 'phy80211'));
          if (!wifi && !await present(join(path, 'device'))) continue;
          const [state, rxBytes, txBytes] = await Promise.all(['operstate', 'statistics/rx_bytes', 'statistics/tx_bytes'].map(file => readFile(join(path, file), 'utf8')));
          const status = state.trim();
          let connected = status === 'up' ? true : ['down', 'lowerlayerdown', 'notpresent', 'dormant'].includes(status) ? false : null;
          if (connected === null) {
            try { const carrier = (await readFile(join(path, 'carrier'), 'utf8')).trim(); connected = carrier === '1' ? true : carrier === '0' ? false : null; }
            catch (error) { if (error.code !== 'ENOENT') throw error; }
          }
          interfaces.push({ id: name, name, wifi, connected, rxBytes: rxBytes.trim(), txBytes: txBytes.trim() });
        }
        return { supported: true, interfaces };
      }
      if (platform === 'darwin') {
        const ports = stdout(await run('/usr/sbin/networksetup', ['-listallhardwareports']));
        const hardware = [...ports.matchAll(/Hardware Port:\s*([^\r\n]+)\r?\nDevice:\s*([^\s\r\n]+)/g)].map(match => ({ name: match[2], port: match[1] })).filter(value => !/^(bridge|lo|utun|awdl|llw)/.test(value.name));
        if (!hardware.length && !/Hardware Port:/.test(ports)) return { supported: false, interfaces: [] };
        const stats = stdout(await run('/usr/sbin/netstat', ['-ibn'])).trim().split(/\r?\n/);
        const headers = stats.shift()?.trim().split(/\s+/) || [];
        const inputIndex = headers.indexOf('Ibytes'), outputIndex = headers.indexOf('Obytes'), networkIndex = headers.indexOf('Network');
        if (inputIndex < 0 || outputIndex < 0 || networkIndex < 0) return { supported: false, interfaces: [] };
        const counters = new Map();
        for (const row of stats) {
          const values = row.trim().split(/\s+/);
          if (!values[networkIndex]?.startsWith('<Link#')) continue;
          counters.set(values[0].replace(/\*$/, ''), { rxBytes: values[inputIndex], txBytes: values[outputIndex] });
        }
        const interfaces = await Promise.all(hardware.map(async ({ name, port }) => {
          if (!/^[A-Za-z0-9_.:-]+$/.test(name)) throw new Error('Invalid interface');
          const configuration = stdout(await run('/sbin/ifconfig', [name]));
          const match = /status:\s*(active|inactive)\b/.exec(configuration);
          return { id: name, name, wifi: /Wi-?Fi|AirPort/i.test(port) ? true : /Ethernet|Thunderbolt|Bluetooth|USB.*LAN/i.test(port) ? false : null,
            connected: match ? match[1] === 'active' : null, ...counters.get(name) };
        }));
        return { supported: true, interfaces };
      }
    } catch { /* Missing tools, permission failures, and unsupported formats remain unknown. */ }
    return { supported: false, interfaces: [] };
  };
}

/** Rates reflect current OS-visible physical-interface traffic, not rated link speed. */
export function createNetworkStatus({ platform = process.platform, sampler = createNetworkSampler({ platform }), clock = () => performance.now(), intervalMs = 1000 } = {}) {
  if (typeof sampler !== 'function' || typeof clock !== 'function' || !Number.isSafeInteger(intervalMs) || intervalMs < 0) throw new Error('Network monitor needs a sampler, clock, and nonnegative interval.');
  let current = { wifi: 'Unknown', downloadBps: null, uploadBps: null, interfaces: [], source: 'unavailable', sampledAtMs: null };
  let previous = new Map(), previousTime = null, timer, inFlight, running = false, generation = 0;
  const snapshot = () => ({ ...current, interfaces: current.interfaces.map(value => ({ ...value })) });
  function sample() {
    if (inFlight) return inFlight;
    const owner = generation;
    inFlight = (async () => {
      try {
        const result = await sampler();
        const time = clock();
        if (owner !== generation) return snapshot();
        if (!result?.supported || !Array.isArray(result.interfaces) || !Number.isFinite(time)) throw new Error('Unavailable counters');
        const interfaces = result.interfaces.map(value => ({
          id: String(value.id || value.name || ''), name: String(value.name || value.id || 'Unknown'),
          wifi: value.wifi === true ? true : value.wifi === false ? false : null,
          connected: value.connected === true ? true : value.connected === false ? false : null,
          rx: counter(value.rxBytes), tx: counter(value.txBytes),
        }));
        const wifi = interfaces.some(value => value.wifi === true && value.connected === true) ? 'Yes'
          : interfaces.some(value => value.connected !== false && (value.wifi === null || value.wifi === true && value.connected === null)) ? 'Unknown' : 'No';
        const elapsed = previousTime === null ? 0 : time - previousTime;
        let download = 0n, upload = 0n, valid = elapsed > 0;
        const next = new Map();
        for (const value of interfaces) {
          next.set(value.id, value);
          if (value.connected === null) { valid = false; continue; }
          if (!value.connected) continue;
          const old = previous.get(value.id);
          if (!old?.connected || value.rx === null || value.tx === null || old.rx === null || old.tx === null || value.rx < old.rx || value.tx < old.tx) { valid = false; continue; }
          download += value.rx - old.rx; upload += value.tx - old.tx;
        }
        current = { wifi, downloadBps: valid ? Number(download) * 1000 / elapsed : null, uploadBps: valid ? Number(upload) * 1000 / elapsed : null,
          interfaces: interfaces.map(value => ({ name: value.name, wifi: value.wifi === null ? 'Unknown' : value.wifi ? 'Yes' : 'No', connected: value.connected })),
          source: 'interface-counters', sampledAtMs: time };
        previous = next; previousTime = time;
      } catch {
        if (owner === generation) { previous.clear(); previousTime = null; current = { wifi: 'Unknown', downloadBps: null, uploadBps: null, interfaces: [], source: 'unavailable', sampledAtMs: null }; }
      }
      return snapshot();
    })().finally(() => { inFlight = undefined; });
    return inFlight;
  }
  return {
    sample, snapshot,
    async start() {
      if (running) return snapshot();
      running = true;
      await sample();
      if (running && intervalMs > 0) { timer = setInterval(() => { void sample(); }, intervalMs); timer.unref?.(); }
      return snapshot();
    },
    stop() { running = false; generation++; clearInterval(timer); timer = undefined; },
  };
}
