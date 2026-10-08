import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from './fixtures/temp-root.mjs';
import { createNetworkStatus, createNetworkSampler } from '../src/network-status.mjs';

const iface = (rx, tx, extra = {}) => ({ name: 'wlan0', wifi: true, connected: true, rxBytes: String(rx), txBytes: String(tx), ...extra });

test('network stop waits for a later interval sample and rejects its late update',async t=>{
  t.mock.timers.enable({apis:['setInterval']});let calls=0,release,settled=false;
  const monitor=createNetworkStatus({intervalMs:10,sampler:()=>++calls===1?Promise.resolve({supported:true,interfaces:[iface(1,2)]}):new Promise(resolve=>{release=resolve;})});
  await monitor.start();t.mock.timers.tick(10);assert.equal(calls,2);
  const stopping=Promise.resolve(monitor.stop()).then(()=>{settled=true;});
  try{
    await new Promise(setImmediate);assert.equal(settled,false,'Stop must drain the currently running interval read.');
    release({supported:true,interfaces:[iface(300,400,{wifi:false})]});await stopping;
    assert.equal(monitor.snapshot().wifi,'Yes');t.mock.timers.tick(50);assert.equal(calls,2);
  }finally{release({supported:false,interfaces:[]});await stopping;}
});

test('actual interface counter deltas produce download/upload rates after two samples', async () => {
  let now = 0, value = { supported: true, interfaces: [iface(1000, 2000)] };
  const monitor = createNetworkStatus({ clock: () => now, intervalMs: 0, sampler: async () => value });
  assert.equal(monitor.snapshot().wifi, 'Unknown');
  await monitor.sample();
  assert.equal(monitor.snapshot().wifi, 'Yes');
  assert.equal(monitor.snapshot().downloadBps, null);
  now = 2000; value = { supported: true, interfaces: [iface(5000, 3000)] };
  await monitor.sample();
  assert.equal(monitor.snapshot().downloadBps, 2000);
  assert.equal(monitor.snapshot().uploadBps, 500);
  monitor.stop();
});

test('Ethernet is never called Wi-Fi and unavailable reads remain Unknown', async () => {
  let value = { supported: true, interfaces: [iface(100, 200, { name: 'eth0', wifi: false })] };
  const monitor = createNetworkStatus({ intervalMs: 0, sampler: async () => { if (value instanceof Error) throw value; return value; } });
  await monitor.start();
  assert.equal(monitor.snapshot().wifi, 'No');
  value = new Error('Permission denied');
  await monitor.sample();
  assert.equal(monitor.snapshot().wifi, 'Unknown');
  assert.equal(monitor.snapshot().downloadBps, null);
  assert.equal(monitor.snapshot().source, 'unavailable');
  monitor.stop();
});

test('counter resets and new interfaces restart baselines instead of generating artificial traffic', async () => {
  let now = 0, value = { supported: true, interfaces: [iface(999999, 999999)] };
  const monitor = createNetworkStatus({ clock: () => now, intervalMs: 0, sampler: async () => value });
  await monitor.sample();
  now = 1000; value = { supported: true, interfaces: [iface(10, 20)] }; await monitor.sample();
  assert.equal(monitor.snapshot().downloadBps, null);
  now = 2000; value = { supported: true, interfaces: [iface(30, 50)] }; await monitor.sample();
  assert.equal(monitor.snapshot().downloadBps, 20);
  assert.equal(monitor.snapshot().uploadBps, 30);
  now = 3000; value = { supported: true, interfaces: [iface(100000, 100000, { name: 'wlan1' })] }; await monitor.sample();
  assert.equal(monitor.snapshot().downloadBps, null);
});

test('64-bit counter subtraction retains small deltas beyond Number safe integer range', async () => {
  let now = 0, value = { supported: true, interfaces: [iface('1000000000000000000', '2000000000000000000')] };
  const monitor = createNetworkStatus({ clock: () => now, intervalMs: 0, sampler: async () => value });
  await monitor.sample(); now = 1000;
  value = { supported: true, interfaces: [iface('1000000000000000123', '2000000000000000456')] };
  await monitor.sample();
  assert.equal(monitor.snapshot().downloadBps, 123);
  assert.equal(monitor.snapshot().uploadBps, 456);
});

test('Windows sampling identifies actual WLAN media and excludes virtual adapter double counting', async () => {
  const rows = [
    { Name: 'Ethernet', InterfaceGuid: 'wired', HardwareInterface: true, InterfaceType: 6, NdisPhysicalMedium: 14, Status: 'Up', ReceivedBytes: '100', SentBytes: '200' },
    { Name: 'Wi-Fi', InterfaceGuid: 'wireless', HardwareInterface: true, InterfaceType: 71, NdisPhysicalMedium: 9, Status: 'Up', ReceivedBytes: '300', SentBytes: '400' },
    { Name: 'vEthernet', HardwareInterface: false, InterfaceType: 6, NdisPhysicalMedium: 0, Status: 'Up', ReceivedBytes: '9999', SentBytes: '9999' },
  ];
  let calls = 0;
  const sample = createNetworkSampler({ platform: 'win32', run: async (_command, args) => { calls++; assert.ok(args.includes('-NoProfile')); return JSON.stringify(rows); } });
  const result = await sample();
  assert.equal(calls, 1);
  assert.equal(result.interfaces.length, 2);
  assert.equal(result.interfaces[0].wifi, false);
  assert.equal(result.interfaces[1].wifi, true);
  assert.equal(result.interfaces[1].rxBytes, '300');
});

test('Linux sysfs sampling uses wireless markers and real byte counters', async t => {
  const sysfsDir = await mkdtemp(join(tmpdir(), 'codexcli-network-test-'));
  t.after(() => rm(sysfsDir, { recursive: true, force: true }));
  for (const [name, wifi] of [['wlan0', true], ['eth0', false]]) {
    await mkdir(join(sysfsDir, name, 'device'), { recursive: true });
    await mkdir(join(sysfsDir, name, 'statistics'));
    if (wifi) await mkdir(join(sysfsDir, name, 'wireless'));
    await writeFile(join(sysfsDir, name, 'operstate'), 'up\n');
    await writeFile(join(sysfsDir, name, 'statistics', 'rx_bytes'), '1234\n');
    await writeFile(join(sysfsDir, name, 'statistics', 'tx_bytes'), '5678\n');
  }
  const result = await createNetworkSampler({ platform: 'linux', sysfsDir })();
  assert.equal(result.interfaces.find(value => value.name === 'wlan0').wifi, true);
  assert.equal(result.interfaces.find(value => value.name === 'eth0').wifi, false);
  assert.equal(result.interfaces[0].rxBytes, '1234');
});

test('macOS maps hardware ports to actual Wi-Fi devices and counts one link-layer statistics row', async () => {
  const ports = 'Hardware Port: Ethernet\nDevice: en0\nEthernet Address: aa:bb\n\nHardware Port: Wi-Fi\nDevice: en1\nEthernet Address: cc:dd\n';
  const stats = 'Name Mtu Network Address Ipkts Ierrs Ibytes Opkts Oerrs Obytes Coll\nen0 1500 <Link#1> aa:bb 1 0 111 2 0 222 0\nen1 1500 <Link#2> cc:dd 3 0 333 4 0 444 0\nen1 1500 192.168.1 192.168.1.2 3 - 333 4 - 444 -\n';
  const sample = createNetworkSampler({ platform: 'darwin', run: async (command, args) => command.endsWith('networksetup') ? ports : command.endsWith('netstat') ? stats : `${args[0]}: flags=UP,RUNNING\n\tstatus: active\n` });
  const result = await sample();
  assert.equal(result.interfaces.length, 2);
  assert.equal(result.interfaces[0].wifi, false);
  assert.equal(result.interfaces[1].name, 'en1');
  assert.equal(result.interfaces[1].wifi, true);
  assert.equal(result.interfaces[1].rxBytes, '333');
  assert.equal(result.interfaces[1].txBytes, '444');
});

test('invalid counters cannot create infinite rates and ambiguous adapter formats stay Unknown', async () => {
  let now = 0, value = { supported: true, interfaces: [iface(10, 20)] };
  const monitor = createNetworkStatus({ clock: () => now, intervalMs: 0, sampler: async () => value });
  await monitor.sample(); now = 1000;
  value = { supported: true, interfaces: [iface('9'.repeat(400), '9'.repeat(400))] };
  await monitor.sample();
  assert.equal(monitor.snapshot().downloadBps, null);
  const windows = createNetworkSampler({ platform: 'win32', run: async () => '[{}]' });
  assert.equal((await windows()).supported, false);
});

test('concurrent refreshes share one sampler and stopping rejects its late result', async () => {
  let resolve, calls = 0;
  const monitor = createNetworkStatus({ intervalMs: 0, sampler: () => { calls++; return new Promise(done => { resolve = done; }); } });
  const first = monitor.sample(), second = monitor.sample();
  assert.equal(first, second);
  assert.equal(calls, 1);
  monitor.stop();
  resolve({ supported: true, interfaces: [iface(10, 20)] });
  await first;
  assert.equal(monitor.snapshot().wifi, 'Unknown');
});
