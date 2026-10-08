import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readdir, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { createWorkMeter, defaultWorkStateDir } from '../src/work-meter.mjs';

const meters = new WeakMap();
async function directory(t) {
  const path = await mkdtemp(join(tmpdir(), 'codexcli-work-test-'));
  meters.set(t, []);
  t.after(async () => {
    try { await Promise.all(meters.get(t).map((meter) => meter.close())); }
    finally { await rm(path, { recursive: true, force: true }); }
  });
  return path;
}
async function meterFor(t, options) {
  const meter = await createWorkMeter(options);
  meters.get(t).push(meter);
  return meter;
}

test('active duration advances during AI work and pauses while idle', async (t) => {
  const stateDir = await directory(t);
  let now = 0;
  const meter = await meterFor(t, { stateDir, clock: () => now, checkpointMs: 0 });
  assert.equal(meter.snapshot().sessionMs, 0);
  meter.start();
  now = 2000;
  assert.equal(meter.snapshot().sessionMs, 2000);
  meter.pause();
  now = 100_000;
  assert.equal(meter.snapshot().sessionMs, 2000);
  meter.start();
  now = 101_500;
  meter.pause();
  await meter.flush();
  assert.equal(meter.snapshot().sessionMs, 3500);
  assert.equal(meter.snapshot().totalMs, 3500);
  assert.equal(meter.snapshot().active, false);
});

test('new launches reset session time while retaining lifetime numeric duration only', async (t) => {
  const stateDir = await directory(t);
  let now = 0;
  const first = await meterFor(t, { stateDir, clock: () => now, checkpointMs: 0 });
  first.start();
  now = 2500;
  await first.close();
  const second = await meterFor(t, { stateDir, clock: () => now, checkpointMs: 0 });
  assert.equal(second.snapshot().sessionMs, 0);
  assert.equal(second.snapshot().totalMs, 2500);
  const records = await readdir(stateDir);
  assert.equal(records.length, 2);
  const firstRecord = JSON.parse(await readFile(join(stateDir, records[0]), 'utf8'));
  assert.deepEqual(Object.keys(firstRecord).sort(), ['activeMs', 'version']);
  assert.ok(Object.values(firstRecord).every((value) => typeof value === 'number'));
});

test('simultaneous instances preserve both sessions instead of overwriting lifetime totals', async (t) => {
  const stateDir = await directory(t);
  let oneNow = 0, twoNow = 0;
  const [one, two] = await Promise.all([
    meterFor(t, { stateDir, clock: () => oneNow, checkpointMs: 0 }),
    meterFor(t, { stateDir, clock: () => twoNow, checkpointMs: 0 }),
  ]);
  one.start(); two.start();
  oneNow = 1500; twoNow = 2500;
  one.pause(); two.pause();
  await Promise.all([one.flush(), two.flush()]);
  await Promise.all([one.flush(), two.flush()]);
  assert.equal(one.snapshot().totalMs, 4000);
  assert.equal(two.snapshot().totalMs, 4000);
  const third = await meterFor(t, { stateDir, checkpointMs: 0 });
  assert.equal(third.snapshot().totalMs, 4000);
});

test('repeated and overlapping checkpoints do not count the same active time twice', async (t) => {
  const stateDir = await directory(t);
  let now = 0;
  const meter = await meterFor(t, { stateDir, clock: () => now, checkpointMs: 0 });
  meter.start();
  now = 1234;
  await Promise.all(Array.from({ length: 20 }, () => meter.flush()));
  assert.equal(meter.snapshot().totalMs, 1234);
  assert.equal((await readdir(stateDir)).length, 1);
});

test('an abrupt exit retains its last checkpoint without recording idle time after the crash', async (t) => {
  const stateDir = await directory(t);
  const moduleUrl = new URL('../src/work-meter.mjs', import.meta.url).href;
  const code = `import { createWorkMeter } from ${JSON.stringify(moduleUrl)}; let now = 0; const meter = await createWorkMeter({ stateDir: process.argv[1], clock: () => now, checkpointMs: 0 }); meter.start(); now = 4500; await meter.flush(); process.exit(0);`;
  const child = spawnSync(process.execPath, ['--input-type=module', '-e', code, stateDir], { encoding: 'utf8', timeout: 10_000, windowsHide: true });
  assert.equal(child.status, 0, child.stderr);
  const fresh = await meterFor(t, { stateDir, checkpointMs: 0 });
  assert.equal(fresh.snapshot().sessionMs, 0);
  assert.equal(fresh.snapshot().totalMs, 4500);
});

test('automatic checkpoints save active duration before normal shutdown', async (t) => {
  const stateDir = await directory(t);
  let now = 0;
  const meter = await meterFor(t, { stateDir, clock: () => now, checkpointMs: 10 });
  meter.start(); now = 1200;
  const deadline = Date.now() + 2000;
  let saved = false;
  while (!saved && Date.now() < deadline) {
    const files = (await readdir(stateDir)).filter((name) => name.endsWith('.json'));
    const record = JSON.parse(await readFile(join(stateDir, files[0]), 'utf8'));
    saved = record.activeMs === 1200;
    if (!saved) await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.equal(saved, true);
});

test('corrupt and partial checkpoint records cannot corrupt or inflate the lifetime total', async (t) => {
  const stateDir = await directory(t);
  await writeFile(join(stateDir, 'session-valid.json'), JSON.stringify({ version: 1, activeMs: 3500 }));
  await writeFile(join(stateDir, 'session-broken.json'), '{');
  await writeFile(join(stateDir, 'session-invalid.json'), JSON.stringify({ version: 1, activeMs: -1 }));
  await writeFile(join(stateDir, 'session-partial.json.tmp'), JSON.stringify({ version: 1, activeMs: 999_999 }));
  const meter = await meterFor(t, { stateDir, checkpointMs: 0 });
  assert.equal(meter.snapshot().totalMs, 3500);
});

test('default state directories follow each platform convention without writing to the real home', () => {
  assert.equal(defaultWorkStateDir({ platform: 'win32', env: { LOCALAPPDATA: 'C:\\Users\\Test\\AppData\\Local' }, home: 'C:\\Users\\Test' }), 'C:\\Users\\Test\\AppData\\Local\\codexcli');
  assert.equal(defaultWorkStateDir({ platform: 'darwin', env: {}, home: '/Users/test' }), '/Users/test/Library/Application Support/codexcli');
  assert.equal(defaultWorkStateDir({ platform: 'linux', env: { XDG_STATE_HOME: '/state' }, home: '/home/test' }), '/state/codexcli');
  assert.equal(defaultWorkStateDir({ platform: 'linux', env: {}, home: '/home/test' }), '/home/test/.local/state/codexcli');
});

test('duplicate session identifiers cannot overwrite an earlier checkpoint', async (t) => {
  const stateDir = await directory(t);
  let now = 0;
  const original = await meterFor(t, { stateDir, clock: () => now, checkpointMs: 0, sessionId: 'same' });
  original.start(); now = 3000; original.pause(); await original.flush();
  await assert.rejects(createWorkMeter({ stateDir, checkpointMs: 0, sessionId: 'same' }), /already exists/);
  assert.deepEqual(JSON.parse(await readFile(join(stateDir, 'session-same.json'), 'utf8')), { version: 1, activeMs: 3000 });
});

test('a failed checkpoint reports storage failure and permits a later successful retry', async (t) => {
  const base = await directory(t);
  const stateDir = join(base, 'storage');
  let now = 0;
  const meter = await meterFor(t, { stateDir, clock: () => now, checkpointMs: 0 });
  meter.start(); now = 3000; meter.pause();
  await rm(stateDir, { recursive: true, force: true });
  await writeFile(stateDir, 'directory temporarily unavailable');
  await assert.rejects(meter.flush(), /Unable to save/);
  assert.equal(meter.snapshot().storageStatus, 'error');
  assert.equal(meter.snapshot().sessionMs, 3000);
  assert.equal(meter.snapshot().persistedMs, 0);
  await rm(stateDir);
  const { mkdir } = await import('node:fs/promises');
  await mkdir(stateDir);
  await meter.flush();
  assert.equal(meter.snapshot().persistedMs, 3000);
  assert.equal(meter.snapshot().storageStatus, 'ok');
});
