import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { stripVTControlCharacters } from 'node:util';

const example = { cwd: '/projects/demo', working: false, status: 'Offline', connectionState: 'pending', configuredModel: 'test-model', connectedAI: null, context: { used: null, limit: 200000, percent: null } };

test('command picker receives a bounded input area below the header after terminal resize',async()=>{
  const {createDashboard}=await import('../src/dashboard.mjs');
  const out=Object.assign(new EventEmitter(),{isTTY:true,columns:150,rows:44,text:'',write(value){this.text+=value;}});
  const dashboard=createDashboard({output:out,snapshot:()=>example,env:{TERM:'xterm'},tickMs:0});
  dashboard.start();const area=dashboard.inputArea();assert.ok(area.top>1);assert.equal(area.top+area.rows-1,44);assert.equal(area.columns,149);
  out.rows=8;out.columns=35;out.emit('resize');const small=dashboard.inputArea();assert.equal(small.top,2);assert.equal(small.rows,7);assert.equal(small.columns,34);
  dashboard.redraw();dashboard.stop();assert.ok(out.text.endsWith('\x1b[?1049l'));
});

test('connection thresholds, permissions, web switch and worked totals are visible', async () => {
  const { renderDashboard } = await import('../src/dashboard.mjs');
  for (const [percent, code, label] of [[100, '32', 'Good'], [71, '32', 'Good'], [70, '38;5;208', 'Fair'], [51, '38;5;208', 'Fair'], [50, '31', 'Bad'], [0, '31', 'Bad']]) {
    const text = renderDashboard({ state: { ...example,healthPercent:true, permissions: 'allow-everything', webAccess: true, health: { percent, latencyMs: 900 }, worked: { sessionMs: 3723000, totalMs: 18623000 } }, columns: 132, rows: 32, color: true }).lines.join('\n');
    assert.ok(text.includes(`\x1b[${code}m${percent}% ${label}`));
    assert.match(stripVTControlCharacters(text), /Permissions: Allow Everything/);
    assert.match(stripVTControlCharacters(text), /Web Access: On/);
    assert.match(stripVTControlCharacters(text), /Worked: 01:02:03 .*In Total: 05:10:23/);
  }
});

test('temporary screen preserves scrollback and restores cursor on stop', async () => {
  const { createDashboard } = await import('../src/dashboard.mjs');
  const out = Object.assign(new EventEmitter(), { isTTY: true, columns: 110, rows: 30, text: '', write(s) { this.text += s; } });
  const dashboard = createDashboard({ output: out, snapshot: () => example, env: { TERM: 'xterm' }, tickMs: 0 });
  dashboard.start(); dashboard.stop(); dashboard.stop();
  assert.ok(out.text.startsWith('\x1b[?1049h\x1b[?25l\x1b[2J\x1b[H'));
  assert.ok(out.text.endsWith('\x1b[0m\x1b[?25h\x1b[?1049l'));
  assert.equal(out.text.split('\x1b[?1049l').length - 1, 1);
});

test('dashboard shows the requested fields next to a large ASCII logo', async () => {
  const { renderDashboard } = await import('../src/dashboard.mjs');
  const view = renderDashboard({ state: example, columns: 110, rows: 30, color: false, now: new Date('2026-10-07T08:09:10Z'), timeZone: 'Europe/Athens', platform: 'win32', arch: 'x64' });
  const text = view.lines.join('\n');
  assert.match(text, /Time: 2026-10-07 11:09:10/);
  assert.match(text, /Software System: Windows/);
  assert.match(text, /Status: Not Working/);
  assert.doesNotMatch(text, /Working:|Status: Offline|Status: Online/);
  assert.match(text, /WiFi Connection: Unknown/);
  assert.match(text, /Connected AI: test-model \(unconfirmed\)/);
  assert.match(text, /Context: Unknown/);
  assert.ok(view.lines[0].includes('____') && view.lines[0].includes('Time:'), 'Logo and details must share a row');
  assert.doesNotMatch(text, /\x1b/);
});

test('system identification works on Windows, Linux and macOS', async () => {
  const { describeSystem } = await import('../src/dashboard.mjs');
  assert.equal(describeSystem({ platform: 'win32', arch: 'x64' }), 'Windows (x64)');
  assert.equal(describeSystem({ platform: 'linux', arch: 'arm64' }), 'Linux (arm64)');
  assert.equal(describeSystem({ platform: 'darwin', arch: 'arm64' }), 'macOS (arm64)');
});

test('working Status and WiFi values have restrained green/red colors', async () => {
  const { renderDashboard } = await import('../src/dashboard.mjs');
  const active = renderDashboard({ state: { ...example, working: true, status: 'Online', connectionState: 'online', connectedAI: 'test-model' }, columns: 110, rows: 30, color: true }).lines.join('\n');
  assert.match(active, /\x1b\[32mWorking\x1b\[0m/);
  const idle = renderDashboard({ state: example, columns: 110, rows: 30, color: true }).lines.join('\n');
  assert.match(idle, /\x1b\[31mNot Working\x1b\[0m/);
});

test('WiFi Yes shows actual sampled upload/download rates, while No omits them', async () => {
  const {renderDashboard}=await import('../src/dashboard.mjs');
  const yes=renderDashboard({state:{...example,network:{wifi:'Yes',downloadBps:2048,uploadBps:1024}},columns:132,rows:32}).lines.join('\n');
  assert.match(yes,/WiFi Connection: Yes/);assert.match(yes,/Download: 2\.0 KiB\/s \| Upload: 1\.0 KiB\/s/);
  const no=renderDashboard({state:{...example,network:{wifi:'No',downloadBps:2048,uploadBps:1024}},columns:132,rows:32}).lines.join('\n');
  assert.doesNotMatch(no,/Download:|Upload:/);
});

test('live dashboard freezes antenna colors idle while continuing its wall clock', async () => {
  const {createDashboard}=await import('../src/dashboard.mjs');
  const {ANTENNA_ROWS}=await import('../src/antenna.mjs');
  const out=Object.assign(new EventEmitter(),{isTTY:true,columns:132,rows:32,text:'',write(value){this.text+=value;}});
  let working=false,elapsed=0,date=new Date('2026-10-07T08:09:10Z');
  const dashboard=createDashboard({output:out,snapshot:()=>({...example,working}),now:()=>date,monotonic:()=>elapsed,env:{TERM:'xterm'},color:true,tickMs:0});
  const frames=[];function frame(){out.text='';dashboard.refresh();frames.push(out.text);}
  dashboard.start();working=true;frame();elapsed=200;frame();working=false;frame();
  date=new Date('2026-10-07T08:09:11Z');elapsed=3000;frame();
  const antenna=text=>text.split('\r\n').filter(line=>ANTENNA_ROWS.some(row=>stripVTControlCharacters(line).includes(row))).map(line=>line.slice(0,line.indexOf('\x1b[90m'))).join('\n');
  assert.notEqual(antenna(frames[0]),antenna(frames[1]));
  assert.equal(antenna(frames[2]),antenna(frames[3]));
  assert.match(stripVTControlCharacters(frames[3]),/11/);
  dashboard.stop();
});

test('reported context shows percent and amounts without inventing unknown values', async () => {
  const { renderDashboard } = await import('../src/dashboard.mjs');
  const text = renderDashboard({ state: { ...example, context: { used: 50000, limit: 200000, percent: 25 } }, columns: 120, rows: 30, color: false }).lines.join('\n');
  assert.match(text, /Context: ~25%/);
  assert.match(text, /50,000\/200,000/);
  assert.match(text, /reported/);
  const unknown = renderDashboard({ state: { ...example, context: { used: 1000, limit: null, percent: null } }, columns: 120, rows: 30, color: false }).lines.join('\n');
  assert.match(unknown, /Context: \?%/);
  assert.match(unknown, /1,000\/unknown/);
});

test('narrow terminal layout retains every field and bounds line widths', async () => {
  const { renderDashboard } = await import('../src/dashboard.mjs');
  const view = renderDashboard({ state: { ...example, connectedAI: '模型'.repeat(80) }, columns: 48, rows: 24, color: true });
  const plain = view.lines.map(stripVTControlCharacters);
  for (const field of ['Time:', 'Software System:', 'Status:', 'WiFi Connection:', 'Connected AI:', 'Context:']) assert.ok(plain.some(line => line.includes(field)));
  assert.ok(view.height < 21);
  for (const line of plain) assert.ok(line.length <= 48, line);
});

test('tiny terminals use a non-sticky fallback rather than an invalid scroll region', async () => {
  const { createDashboard } = await import('../src/dashboard.mjs');
  const out = Object.assign(new EventEmitter(), { isTTY: true, columns: 35, rows: 8, text: '', write(s) { this.text += s; } });
  const dashboard = createDashboard({ output: out, snapshot: () => example, env: { TERM: 'xterm' }, tickMs: 0 });
  dashboard.start(); dashboard.refresh(); dashboard.stop();
  assert.doesNotMatch(out.text, /\x1b\[\d+;\d+r/);
  assert.match(out.text, /Enlarge terminal/);
});

test('live clock redraw preserves cursor, never repeats model input, and restores terminal on stop', async () => {
  const { createDashboard } = await import('../src/dashboard.mjs');
  const out = Object.assign(new EventEmitter(), { isTTY: true, columns: 110, rows: 30, text: '', write(s) { this.text += s; } });
  let now = new Date('2026-10-07T08:09:10Z');
  const dashboard = createDashboard({ output: out, snapshot: () => example, now: () => now, timeZone: 'Europe/Athens', color: false, env: { TERM: 'xterm' }, tickMs: 0 });
  dashboard.start();
  now = new Date('2026-10-07T08:09:11Z'); dashboard.refresh();
  assert.match(out.text, /11:09:11/);
  assert.match(out.text, /\x1b7/);
  assert.match(out.text, /\x1b8/);
  assert.match(out.text, /\x1b\[\d+;30r/);
  assert.equal(out.listenerCount('resize'), 1);
  dashboard.stop(); dashboard.stop();
  assert.equal(out.listenerCount('resize'), 0);
  assert.ok(out.text.includes('\x1b[r'));
});

test('plain terminal mode disables all escape sequences', async () => {
  const { createDashboard } = await import('../src/dashboard.mjs');
  const out = Object.assign(new EventEmitter(), { isTTY: false, columns: 80, rows: 24, text: '', write(s) { this.text += s; } });
  const dashboard = createDashboard({ output: out, snapshot: () => example, env: {}, tickMs: 0 });
  dashboard.start(); dashboard.refresh(); out.emit('resize'); dashboard.stop();
  assert.doesNotMatch(out.text, /\x1b/);
});

test('the idle clock resumes after enlarging an initially tiny terminal', async () => {
  const { createDashboard } = await import('../src/dashboard.mjs');
  const out = Object.assign(new EventEmitter(), { isTTY: true, columns: 40, rows: 8, text: '', write(s) { this.text += s; } });
  let now = new Date('2026-10-07T08:09:10Z');
  const dashboard = createDashboard({ output: out, snapshot: () => example, now: () => now, timeZone: 'Europe/Athens', color: false, env: { TERM: 'xterm' }, tickMs: 10 });
  dashboard.start();
  out.columns = 110; out.rows = 30; out.emit('resize');
  now = new Date('2026-10-07T08:09:11Z');
  await new Promise(resolve => setTimeout(resolve, 40));
  dashboard.stop();
  assert.match(out.text, /11:09:11/);
});
