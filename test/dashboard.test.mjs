import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { stripVTControlCharacters } from 'node:util';

const example = { cwd: '/projects/demo', working: false, status: 'Offline', connectionState: 'pending', configuredModel: 'test-model', connectedAI: null, context: { used: null, limit: 200000, percent: null } };

test('two named GPUs keep separate dedicated capacities, shared RAM and driver failure visible without stealing input space',async()=>{
  const {renderDashboard}=await import('../src/dashboard.mjs');
  const performance={cpu:{percent:12.5},ram:{usedBytes:8*1024**3,totalBytes:32*1024**3,percent:25},gpu:{adapters:[
    {id:'unmatched',name:'Windows GPU unmatched counters',identified:false,percent:0,vramUsedBytes:0,vramTotalBytes:null,sharedUsedBytes:8192,sharedTotalBytes:null,memoryKind:'dedicated'},
    {id:'amd',name:'AMD Radeon 780M',identified:true,percent:17.8,vramUsedBytes:400*1024**2,vramTotalBytes:512*1024**2,sharedUsedBytes:300*1024**2,sharedTotalBytes:16*1024**3,memoryKind:'dedicated'},
    {id:'rtx',name:'NVIDIA GeForce RTX 5050 Laptop GPU',identified:true,status:'unavailable',percent:null,vramUsedBytes:null,vramTotalBytes:7.96*1024**3,memoryKind:'dedicated',driverErrorCode:43,deviceStatus:'driver-error'},
  ]}};
  for(const columns of [150,110,70,48]){
    const view=renderDashboard({state:{...example,performance,scope:'project',chatTitle:'New chat',network:{wifi:'Yes',downloadBps:1024,uploadBps:2048}},columns,rows:44,color:true});
    assert.equal(view.sticky,true,`Two-card layout should remain useful at ${columns} columns`);
    const lines=view.lines.map(stripVTControlCharacters),panel=view.performance.map(stripVTControlCharacters);
    const text=panel.join(' ').replace(/\s+/g,' ');
    assert.match(text,/GPU 0: AMD Radeon 780M/);assert.match(text,/GPU 1: NVIDIA GeForce RTX 5050 Laptop GPU/);
    assert.doesNotMatch(text,/Unidentified counters|Windows GPU unmatched counters/,'Unmatched counters belong in the full listing, leaving header space for physical GPUs');
    for(const value of ['Dedicated VRAM:','400/512 MiB (78.1%)','Shared RAM:','0.3/16.0 GiB (1.8%)','Unavailable / 8.0 GiB','Driver error 43'])assert.ok(text.includes(value),`${columns} columns lost ${value}: ${text}`);
    assert.ok(lines.every(line=>[...line].length<columns),`${columns} columns overflowed`);
    assert.ok(44-view.height>=8,`${columns} columns left insufficient panel/composer space`);
  }
  const tiny=renderDashboard({state:{...example,performance},columns:35,rows:8,color:true});
  assert.equal(tiny.sticky,false);assert.equal(tiny.height,1);assert.match(stripVTControlCharacters(tiny.lines[0]),/Enlarge terminal/);
});

test('local performance has its own header column and retains accurate compact inventory',async()=>{
  const {renderDashboard}=await import('../src/dashboard.mjs');
  const {ANTENNA_ROWS}=await import('../src/antenna.mjs');
  const performance={cpu:{status:'available',percent:12.5},ram:{status:'available',usedBytes:8*1024**3,totalBytes:32*1024**3,percent:25},gpu:{status:'unavailable',adapters:[]},vram:{status:'unavailable'}};
  for(const columns of [150,110,70,48]){
    const view=renderDashboard({state:{...example,performance,scope:'project',chatTitle:'New chat',network:{wifi:'Yes',downloadBps:1024,uploadBps:2048}},columns,rows:44,color:true});
    assert.equal(view.sticky,true,`Useful layout at ${columns} columns`);
    const lines=view.lines.map(stripVTControlCharacters),text=view.performance.map(stripVTControlCharacters).join('\n');
    for(const field of ['Performance','CPU: 12.5%','RAM: 8.0/32.0 GiB (25.0%)','GPU: Unavailable','VRAM: Unavailable'])assert.ok(text.includes(field),`${columns} columns missing ${field}`);
    assert.ok(lines.every(line=>[...line].length<columns),`${columns}: ${text}`);
    if(columns===150){
      const first=lines.findIndex(line=>line.includes('Performance (This PC)'));
      assert.equal(first,0,'Performance begins in the separate right column');
      assert.match(lines.at(-2),/Credits:/,'Credits remain below the antenna and status');
      assert.equal(lines[first+1].slice(lines[first].indexOf('Performance')).trim(),'','Heading has breathing room');
      assert.ok(lines.some(line=>line.includes(ANTENNA_ROWS[0])),'Exact antenna remains visible');
    }else assert.match(text,/Performance \(This PC\)/);
    assert.doesNotMatch(text,/GPU: 0\.0%|VRAM: 0[\/.]/,'Unknown counters cannot look idle');
    assert.ok(44-view.height>=4,'Input remains usable');
  }
});

test('performance resize keeps the input outside the header and falls back safely on tiny terminals',async()=>{
  const {createDashboard}=await import('../src/dashboard.mjs');
  const state={...example,performance:{cpu:{status:'warming-up'},ram:{status:'unavailable'},gpu:{status:'unavailable'},vram:{status:'unavailable'}}};
  const out=Object.assign(new EventEmitter(),{isTTY:true,columns:150,rows:44,text:'',write(value){this.text+=value;}});
  const dashboard=createDashboard({output:out,snapshot:()=>state,env:{TERM:'xterm'},tickMs:0});
  dashboard.start();assert.equal(dashboard.inputArea().rows,3);assert.ok(dashboard.menuArea().rows>=4);
  out.columns=35;out.rows=8;out.text='';out.emit('resize');
  assert.ok(dashboard.inputArea().top>dashboard.layout().chat.bottom);assert.match(out.text,/Enlarge terminal/);
  assert.doesNotMatch(out.text,/\x1b\[\d+;\d+r/);
  out.columns=150;out.rows=44;out.text='';out.emit('resize');
  assert.match(out.text,/Performance \(This PC\)/);assert.ok(dashboard.menuArea().rows>=4);
  dashboard.stop();assert.ok(out.text.endsWith('\x1b[?1049l'));
});

test('command picker receives a bounded input area below the header after terminal resize',async()=>{
  const {createDashboard}=await import('../src/dashboard.mjs');
  const out=Object.assign(new EventEmitter(),{isTTY:true,columns:150,rows:44,text:'',write(value){this.text+=value;}});
  const dashboard=createDashboard({output:out,snapshot:()=>example,env:{TERM:'xterm'},tickMs:0});
  dashboard.start();const area=dashboard.inputArea();assert.ok(area.top>1);assert.equal(area.top+area.rows-1,43);assert.ok(area.columns<149);assert.equal(dashboard.menuArea().left,1);
  out.rows=8;out.columns=35;out.emit('resize');const small=dashboard.inputArea();assert.equal(small.top,5);assert.equal(small.rows,3);assert.equal(small.columns,34);
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
  assert.ok(view.lines.some(line=>line.includes('SUDO CLI')&&line.includes('Time:')), 'Brand and details must share a row');assert.match(view.lines.at(-2),/Credits:/);
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
  const yes=renderDashboard({state:{...example,network:{wifi:'Yes',downloadBps:2048,uploadBps:1024}},columns:150,rows:44}).lines.join('\n');
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
  const antenna=text=>text.split(/\x1b\[\d+;1H/).filter(line=>ANTENNA_ROWS.some(row=>stripVTControlCharacters(line).includes(row))).map(line=>line.slice(0,line.indexOf('\x1b[90m'))).join('\n');
  assert.notEqual(antenna(frames[0]),antenna(frames[1]));
  assert.equal(antenna(frames[2]),antenna(frames[3]));
  assert.match(stripVTControlCharacters(frames[3]),/11/);
  dashboard.stop();
});

test('reported context shows percent and amounts without inventing unknown values', async () => {
  const { renderDashboard } = await import('../src/dashboard.mjs');
  const view = renderDashboard({ state: { ...example, context: { used: 50000, limit: 200000, percent: 25 } }, columns: 150, rows: 44, color: false });const text=view.lines.join('\n')+'\n'+view.footer;
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
  assert.doesNotMatch(out.text, /\x1b\[\d+;30r/,'Two columns must not share a full-width scroll region');
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

test('custom lower backgrounds paint empty chat rows while dashboard keeps its original background',async()=>{
  const {createDashboard}=await import('../src/dashboard.mjs');
  const {createTerminalTheme}=await import('../src/terminal-theme.mjs');
  const theme=createTerminalTheme({color:true,env:{TERM:'xterm'}});await theme.set('bgcolor','white');
  const out=Object.assign(new EventEmitter(),{isTTY:true,columns:132,rows:40,text:'',write(value){this.text+=value;}});
  const dashboard=createDashboard({output:out,snapshot:()=>example,env:{TERM:'xterm'},color:true,tickMs:0,theme:()=>theme});
  dashboard.start();const top=dashboard.layout().chat.top;
  assert.match(out.text,/\x1b\[48;2;11;15;20m.*Software System/s);
  for(let line=top;line<=dashboard.inputArea().bottom;line++)assert.ok(out.text.includes(`\x1b[${line};1H${theme.bodyStyle}`),'new lower background must paint every empty chat/composer row');
  dashboard.stop();
});

test('color redraw recolors previous user text and preserves readable system output',async()=>{
  const {createDashboard}=await import('../src/dashboard.mjs');
  const {createTerminalTheme}=await import('../src/terminal-theme.mjs');
  const theme=createTerminalTheme({color:true,env:{TERM:'xterm'}});await theme.set('txtcolor','cyan');
  const out=Object.assign(new EventEmitter(),{isTTY:true,columns:132,rows:40,text:'',write(value){this.text+=value;}});
  const dashboard=createDashboard({output:out,snapshot:()=>example,env:{TERM:'xterm'},color:true,tickMs:0,theme:()=>theme});
  dashboard.start();dashboard.write('user asks\n',{user:true});dashboard.write('\x1b[90mworking\x1b[0m\n');
  await theme.set('bgcolor','white');await theme.set('txtcolor','#800000');out.text='';dashboard.redraw();
  const lower=out.text.slice(out.text.indexOf(`\x1b[${dashboard.layout().chat.top};1H`));
  assert.match(lower,/\x1b\[38;2;128;0;0muser asks/);
  assert.match(lower,/\x1b\[38;2;0;0;0mworking/);
  assert.doesNotMatch(lower,/48;2;11;15;20/);
  dashboard.stop();
});

test('header animation restores lower theme after the saved cursor without repeating chat',async()=>{
  const {createDashboard}=await import('../src/dashboard.mjs');
  const {createTerminalTheme}=await import('../src/terminal-theme.mjs');
  const theme=createTerminalTheme({color:true,env:{TERM:'xterm'}});await theme.set('bgcolor','navy');
  const out=Object.assign(new EventEmitter(),{isTTY:true,columns:132,rows:40,text:'',write(value){this.text+=value;}});
  let date=new Date('2026-10-07T08:09:10Z');
  const dashboard=createDashboard({output:out,snapshot:()=>example,now:()=>date,env:{TERM:'xterm'},color:true,tickMs:0,theme:()=>theme});
  dashboard.start();dashboard.write('private question\n',{user:true});out.text='';date=new Date('2026-10-07T08:09:11Z');dashboard.refresh();
  assert.ok(out.text.endsWith('\x1b8'+theme.bodyStyle));assert.doesNotMatch(out.text,/\x1b\[\?25[hl]/);
  assert.doesNotMatch(out.text,/private question/);dashboard.stop();
});

test('NO_COLOR disables header and body color even when a theme remains saved',async()=>{
  const {createDashboard}=await import('../src/dashboard.mjs');
  const {createTerminalTheme}=await import('../src/terminal-theme.mjs');
  const theme=createTerminalTheme({color:true,env:{TERM:'xterm'}});await theme.set('bgcolor','red');
  const out=Object.assign(new EventEmitter(),{isTTY:true,columns:132,rows:40,text:'',write(value){this.text+=value;}});
  const dashboard=createDashboard({output:out,snapshot:()=>example,env:{TERM:'xterm',NO_COLOR:'1'},color:true,tickMs:0,theme:()=>theme});
  dashboard.start();dashboard.write('message');dashboard.stop();
  assert.doesNotMatch(out.text,/\x1b\[(?:3[0-9]|4[0-9]|9[0-9]|10[0-7])(?:;[0-9]+)*m/);
});

test('recording readline user echo recolors it on resize without echoing it twice',async()=>{
  const {createDashboard}=await import('../src/dashboard.mjs');
  const {createTerminalTheme}=await import('../src/terminal-theme.mjs');
  const theme=createTerminalTheme({color:true,env:{TERM:'xterm'}});await theme.set('bgcolor','black');await theme.set('txtcolor','cyan');
  const out=Object.assign(new EventEmitter(),{isTTY:true,columns:132,rows:40,text:'',write(value){this.text+=value;}});
  const dashboard=createDashboard({output:out,snapshot:()=>example,env:{TERM:'xterm'},color:true,tickMs:0,theme:()=>theme});
  dashboard.start();out.text='';dashboard.remember('  you › previously typed\n',{user:true});assert.equal(out.text,'');
  await theme.set('txtcolor','yellow');dashboard.redraw();
  assert.match(out.text,/\x1b\[38;2;255;255;0m  you › previously typed/);dashboard.stop();
});

test('tiny fallback keeps header cells nearblack when resizing a white chat background',async()=>{
  const {createDashboard,renderDashboard}=await import('../src/dashboard.mjs');
  const {createTerminalTheme}=await import('../src/terminal-theme.mjs');
  const theme=createTerminalTheme({color:true,env:{TERM:'xterm'}});await theme.set('bgcolor','white');
  const fallback=renderDashboard({state:example,columns:35,rows:8,color:true});
  assert.ok(fallback.lines[0].startsWith('\x1b[48;2;11;15;20m'),'Fallback header must set its own background before any visible character');
  const out=Object.assign(new EventEmitter(),{isTTY:true,columns:132,rows:40,text:'',write(value){this.text+=value;}});
  const dashboard=createDashboard({output:out,snapshot:()=>example,env:{TERM:'xterm'},color:true,tickMs:0,theme:()=>theme});
  dashboard.start();out.text='';out.columns=35;out.rows=8;out.emit('resize');
  assert.match(out.text,/\x1b\[48;2;11;15;20m\x1b\[2J/,'Shrinking must clear upper blank cells under the fixed header color');
  assert.match(out.text,/Enlarge terminal\x1b\[0m\x1b\[48;2;11;15;20m/,'Fallback padding must retain header background');
  assert.ok(out.text.includes('\x1b[2;1H'+theme.bodyStyle));assert.doesNotMatch(out.text,/\x1b\[J/);
  dashboard.stop();
});

test('chat page navigation redraws only lower rows and keeps arriving output out of the paused view',async()=>{
  const {createDashboard}=await import('../src/dashboard.mjs');
  const out=Object.assign(new EventEmitter(),{isTTY:true,columns:132,rows:40,text:'',write(value){this.text+=value;}});
  let dashboard;const promptRestores=[];
  dashboard=createDashboard({output:out,snapshot:()=>example,env:{TERM:'xterm'},color:false,tickMs:0,onResize:()=>promptRestores.push(dashboard.isScrolled())});
  dashboard.start();promptRestores.length=0;dashboard.write('FIRST USER\n',{user:true});dashboard.write('assistant line\n'.repeat(40));out.text='';
  assert.equal(typeof dashboard.scrollToTop,'function','dashboard must expose retained chat navigation');
  assert.equal(dashboard.scrollToTop(),true);
  assert.equal(dashboard.isScrolled(),true);
  assert.match(out.text,/FIRST USER/);
  assert.doesNotMatch(out.text,/Software System|Credits:|\x1b\[2J/,'Scrolling cannot clear or redraw the antenna/header');
  assert.ok(out.text.includes(`\x1b[${dashboard.layout().chat.top};1H`));
  out.text='';dashboard.write('INCOMING PRIVATE ANSWER\n');
  assert.doesNotMatch(out.text,/INCOMING PRIVATE ANSWER|FIRST USER/);
  assert.match(stripVTControlCharacters(out.text),/new output/i);
  assert.ok(dashboard.scrollState().unseen>0);
  out.text='';dashboard.scrollToBottom();
  assert.equal(dashboard.isScrolled(),false);assert.match(out.text,/INCOMING PRIVATE ANSWER/);
  assert.deepEqual(promptRestores,[],'Panel scrolling leaves the fixed composer in place');dashboard.stop();
});

test('saved chat hydration and chat clearing reset old scroll content without duplicating readline echo',async()=>{
  const {createDashboard}=await import('../src/dashboard.mjs');
  const out=Object.assign(new EventEmitter(),{isTTY:true,columns:132,rows:40,text:'',write(value){this.text+=value;}});
  const dashboard=createDashboard({output:out,snapshot:()=>example,env:{TERM:'xterm'},color:false,tickMs:0});
  dashboard.start();
  assert.equal(typeof dashboard.replaceBody,'function','saved messages must hydrate the retained chat');
  dashboard.replaceBody([{text:'SAVED USER\n',user:true},{text:'answer\n'.repeat(50),user:false}]);
  dashboard.scrollToTop();assert.match(out.text,/SAVED USER/);
  dashboard.clearBody();assert.equal(dashboard.isScrolled(),false);assert.equal(dashboard.scrollState().unseen,0);
  out.text='';dashboard.remember('NEW USER\n',{user:true});assert.equal(out.text,'');
  dashboard.redraw();assert.doesNotMatch(out.text,/SAVED USER/);
  assert.equal(out.text.split('NEW USER').length-1,1);dashboard.stop();
});

test('paused chat survives terminal shrink and recolors only its lower region',async()=>{
  const {createDashboard}=await import('../src/dashboard.mjs');
  const {createTerminalTheme}=await import('../src/terminal-theme.mjs');
  const theme=createTerminalTheme({color:true,env:{TERM:'xterm'}});await theme.set('bgcolor','white');await theme.set('txtcolor','maroon');
  const out=Object.assign(new EventEmitter(),{isTTY:true,columns:132,rows:40,text:'',write(value){this.text+=value;}});
  const dashboard=createDashboard({output:out,snapshot:()=>example,env:{TERM:'xterm'},color:true,tickMs:0,theme:()=>theme});
  dashboard.start();assert.equal(typeof dashboard.scrollToTop,'function');
  dashboard.write('ANCHOR USER\n',{user:true});dashboard.write('other\n'.repeat(50));dashboard.scrollToTop();
  out.text='';out.columns=35;out.rows=8;out.emit('resize');
  assert.equal(dashboard.isScrolled(),true);assert.match(out.text,/Enlarge terminal/);assert.match(out.text,/ANCHOR USER/);
  assert.match(out.text,/\x1b\[38;2;128;0;0mANCHOR USER/);
  assert.doesNotMatch(out.text,/\x1b\[\d+;\d+r/);dashboard.stop();
});

test('plain terminals keep line output and decline managed scroll navigation',async()=>{
  const {createDashboard}=await import('../src/dashboard.mjs');
  for(const isTTY of [true,false]){
    const out=Object.assign(new EventEmitter(),{isTTY,columns:80,rows:24,text:'',write(value){this.text+=value;}});
    const dashboard=createDashboard({output:out,snapshot:()=>example,env:{TERM:'dumb'},tickMs:0});
    dashboard.start();dashboard.write('plain body\n');assert.equal(typeof dashboard.pageUp,'function');
    assert.equal(dashboard.pageUp(),false);assert.match(out.text,/plain body/);assert.doesNotMatch(out.text,/\x1b/);dashboard.stop();
  }
});

test('a narrow paused terminal keeps its new output indicator readable for a long chat',async()=>{
  const {createDashboard}=await import('../src/dashboard.mjs');
  const out=Object.assign(new EventEmitter(),{isTTY:true,columns:35,rows:8,text:'',write(value){this.text+=value;}});
  const dashboard=createDashboard({output:out,snapshot:()=>example,env:{TERM:'xterm'},color:false,tickMs:0});
  dashboard.start();dashboard.write('old\n'.repeat(1200));dashboard.scrollToTop();out.text='';dashboard.write('new answer\n');
  assert.match(stripVTControlCharacters(out.text),/New output/);dashboard.stop();
});
