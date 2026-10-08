import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,readFile,readdir,rm,stat,writeFile,symlink} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,dirname,basename,isAbsolute} from 'node:path';
import {createHash} from 'node:crypto';

async function api(){
  const module=await import('../src/notifications.mjs').catch(error=>{
    if(error.code!=='ERR_MODULE_NOT_FOUND')throw error;
    return {};
  });
  assert.equal(typeof module.createNotifications,'function','notification factory must be available');
  assert.equal(typeof module.notificationWav,'function','original notification WAV generator must be available');
  return module;
}
async function fixture(run){
  const directory=await mkdtemp(join(tmpdir(),'sudo-notifications-'));
  try{await run(directory);}finally{await rm(directory,{recursive:true,force:true});}
}
const fakeOutput=()=>({isTTY:true,bells:[],write(text){this.bells.push({text,time:Date.now()});return true;}});
const missing=()=>Object.assign(new Error('missing player'),{code:'ENOENT'});

test('notification preferences default on, survive restart, and never sound during setup',async()=>fixture(async directory=>{
  const {createNotifications}=await api();let plays=0;
  const options={directory,interactive:true,play:async()=>{plays++;}};
  const notifications=createNotifications(options);
  assert.equal(notifications.get().enabled,true);
  await notifications.load();await notifications.off();
  assert.equal(notifications.status().enabled,false);
  assert.deepEqual(JSON.parse(await readFile(join(directory,'notifications.json'),'utf8')),{version:1,enabled:false});
  const restored=createNotifications(options);await restored.load();assert.equal(restored.get().enabled,false);
  assert.equal((await restored.notify('done')).status,'disabled');
  await restored.on();assert.equal(restored.get().enabled,true);assert.equal(plays,0);
  if(process.platform!=='win32')assert.equal((await stat(join(directory,'notifications.json'))).mode&0o777,0o600);
  await notifications.close();await restored.close();
}));

test('each lifecycle event has an original, bounded, distinct PCM melody',async()=>{
  const {notificationWav,NOTIFICATION_EVENTS}=await api();
  assert.deepEqual(NOTIFICATION_EVENTS,['approval','error','done','interrupted','connected','disconnected']);
  const fingerprints=new Set();
  for(const event of NOTIFICATION_EVENTS){
    const wav=notificationWav(event);
    assert.ok(Buffer.isBuffer(wav));assert.equal(wav.toString('ascii',0,4),'RIFF');assert.equal(wav.toString('ascii',8,12),'WAVE');
    assert.equal(wav.readUInt16LE(20),1);assert.equal(wav.readUInt16LE(22),1);assert.equal(wav.readUInt16LE(34),16);
    assert.equal(wav.readUInt32LE(4),wav.length-8);assert.equal(wav.readUInt32LE(40),wav.length-44);
    const rate=wav.readUInt32LE(24),samples=(wav.length-44)/2;
    assert.ok(rate>=16000&&rate<=48000);assert.ok(samples/rate>=0.15&&samples/rate<=2);
    let peak=0,energy=0;for(let offset=44;offset<wav.length;offset+=2){const sample=wav.readInt16LE(offset);peak=Math.max(peak,Math.abs(sample));energy+=sample*sample;}
    assert.ok(peak>1000&&peak<=12000);assert.ok(energy>0);assert.ok(Math.abs(wav.readInt16LE(44))<100);assert.ok(Math.abs(wav.readInt16LE(wav.length-2))<100);
    fingerprints.add(createHash('sha256').update(wav).digest('hex'));
  }
  assert.equal(fingerprints.size,NOTIFICATION_EVENTS.length);
  assert.deepEqual(notificationWav('ai-done'),notificationWav('done'));
  assert.throws(()=>notificationWav('progress'),/event/i);
});

test('noninteractive sessions and disabled preferences never create audio assets or jobs',async()=>fixture(async directory=>{
  const {createNotifications}=await api();let calls=0;const output=fakeOutput();
  const quiet=createNotifications({directory,interactive:false,output,play:async()=>{calls++;}});
  assert.equal((await quiet.notify('approval')).status,'quiet');await quiet.close();assert.equal(calls,0);assert.equal(output.bells.length,0);
  assert.deepEqual(await readdir(directory),[]);
  const off=createNotifications({directory,interactive:true,play:async()=>{calls++;}});await off.set('off');
  assert.equal((await off.notify('error')).status,'disabled');await off.close();assert.equal(calls,0);
  assert.deepEqual(await readdir(directory),['notifications.json']);
}));

test('events validate identifiers and bounds before invoking any player',async()=>fixture(async directory=>{
  const {createNotifications}=await api();let calls=0;
  const notifications=createNotifications({directory,interactive:true,play:async()=>{calls++;}});
  for(const event of ['progress','',null,'done\x1b[31m'])await assert.rejects(()=>notifications.notify(event),/event/i);
  for(const id of ['',3,'x'.repeat(129),'line\n'])await assert.rejects(()=>notifications.notify('done',{id}),/id|identifier/i);
  for(const options of [null,[],3])await assert.rejects(()=>notifications.notify('done',options),/options/i);
  for(const value of ['yes',null,1,'ON'])await assert.rejects(()=>notifications.set(value),/on|off|boolean/i);
  for(const options of [{timeoutMs:0},{timeoutMs:10001},{cooldownMs:-1},{cooldownMs:10001},{maxQueue:0},{maxQueue:9},{maxIds:0},{maxIds:1025},{directory:''},{interactive:'yes'},{play:3},{execute:3}])assert.throws(()=>createNotifications(options),/notification|directory|interactive|play|execute|timeout|cooldown|queue|ids/i);
  assert.equal(calls,0);await notifications.close();
}));

test('deduplication is scoped to events, cooldown is bounded, and remembered IDs are capped',async()=>fixture(async directory=>{
  const {createNotifications}=await api();let now=0;const calls=[];
  const notifications=createNotifications({directory,interactive:true,cooldownMs:100,maxIds:2,now:()=>now,play:async item=>{calls.push(item.event);}});
  assert.equal((await notifications.notify('done',{id:'turn-1'})).status,'played');
  assert.equal((await notifications.notify('ai-done',{id:'turn-1'})).status,'duplicate');
  assert.equal((await notifications.notify('done',{id:'turn-2'})).status,'cooldown');
  assert.equal((await notifications.notify('approval',{id:'turn-1'})).status,'played');
  now=101;assert.equal((await notifications.notify('done',{id:'turn-2'})).status,'played');
  now=202;assert.equal((await notifications.notify('done',{id:'turn-1'})).status,'played');
  assert.deepEqual(calls,['done','approval','done','done']);assert.ok(notifications.get().rememberedIds<=2);await notifications.close();
}));

test('notification bursts use a bounded serial queue without overlapping players',async()=>fixture(async directory=>{
  const {createNotifications}=await api();const releases=[];let active=0,peak=0;
  const notifications=createNotifications({directory,interactive:true,cooldownMs:0,maxQueue:2,play:()=>new Promise(resolve=>{active++;peak=Math.max(peak,active);releases.push(()=>{active--;resolve();});})});
  const first=notifications.notify('approval'),second=notifications.notify('error'),third=notifications.notify('done');
  assert.equal((await third).status,'busy');
  while(!releases.length)await new Promise(resolve=>setTimeout(resolve,2));releases.shift()();assert.equal((await first).status,'played');
  while(!releases.length)await new Promise(resolve=>setTimeout(resolve,2));releases.shift()();assert.equal((await second).status,'played');assert.equal(peak,1);await notifications.close();
}));

test('private WAV assets exist only during the session and are removed by stop and close',async()=>fixture(async directory=>{
  const {createNotifications}=await api();const paths=[];
  const notifications=createNotifications({directory,interactive:true,cooldownMs:0,play:async({path,signal})=>{
    paths.push(path);assert.equal(signal.aborted,false);assert.equal(isAbsolute(path),true);assert.equal(dirname(dirname(path)),directory);
    assert.match(basename(dirname(path)),/^notification-sounds-/);assert.match(basename(path),/^[a-z]+\.wav$/);
    assert.equal((await readFile(path)).toString('ascii',0,4),'RIFF');
    if(process.platform!=='win32')assert.equal((await stat(path)).mode&0o777,0o600);
  }});
  await notifications.notify('done');await notifications.stop();await assert.rejects(()=>stat(paths[0]),{code:'ENOENT'});
  await notifications.notify('interrupted');assert.notEqual(dirname(paths[0]),dirname(paths[1]));await notifications.close();
  await assert.rejects(()=>stat(paths[1]),{code:'ENOENT'});assert.equal((await notifications.notify('done')).status,'cancelled');
  assert.ok((await readdir(directory)).every(name=>!name.startsWith('notification-sounds-')));
}));

test('off and close cancel active and queued work even when an injected player never settles',async()=>fixture(async directory=>{
  const {createNotifications}=await api();const signals=[];
  const notifications=createNotifications({directory,interactive:true,cooldownMs:0,play:({signal})=>{signals.push(signal);return new Promise(()=>{});}});
  const active=notifications.notify('approval'),queued=notifications.notify('error');
  while(!signals.length)await new Promise(resolve=>setTimeout(resolve,2));await notifications.off();
  assert.equal(signals[0].aborted,true);assert.equal((await active).status,'cancelled');assert.equal((await queued).status,'cancelled');
  assert.equal(notifications.get().pending,0);assert.ok((await readdir(directory)).every(name=>!name.startsWith('notification-sounds-')));
  await notifications.on();const next=notifications.notify('done');while(signals.length<2)await new Promise(resolve=>setTimeout(resolve,2));await notifications.close();
  assert.equal(signals[1].aborted,true);assert.equal((await next).status,'cancelled');await notifications.close();
}));

test('hung playback is timed out and aborted without silently claiming a sound played',async()=>fixture(async directory=>{
  const {createNotifications}=await api();let signal;
  const notifications=createNotifications({directory,interactive:true,timeoutMs:35,play:item=>{signal=item.signal;return new Promise(()=>{});}});
  const started=Date.now(),result=await notifications.notify('error');assert.equal(result.status,'unavailable');assert.match(result.reason,/timed out/i);
  assert.equal(signal.aborted,true);assert.ok(Date.now()-started<1000);assert.equal(notifications.get().pending,0);assert.equal(notifications.get().backend,'unavailable');await notifications.close();
}));

test('Windows playback uses a fixed SoundPlayer script, safe argument boundaries, and a hidden non-shell process',async()=>fixture(async directory=>{
  const {createNotifications}=await api();let call;
  const notifications=createNotifications({directory,interactive:true,platform:'win32',env:{SystemRoot:'C:\\Windows',PATH:'runtime-path',OPENAI_API_KEY:'fixture-provider-key',AWS_SECRET_ACCESS_KEY:'fixture-cloud-key',OTHER:'excluded'},execute:async(file,args,options)=>{call={file,args,options};}});
  assert.equal((await notifications.notify('approval')).status,'played');
  assert.equal(call.file,'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe');assert.equal(call.options.shell,false);assert.equal(call.options.windowsHide,true);
  assert.ok(call.args.includes('-NoProfile'));assert.ok(call.args.includes('-NonInteractive'));const index=call.args.indexOf('-EncodedCommand');assert.ok(index>=0);
  const script=Buffer.from(call.args[index+1],'base64').toString('utf16le');assert.match(script,/System\.Media\.SoundPlayer/);assert.match(script,/PlaySync/);assert.doesNotMatch(script,/Start-Process|RunAs|Invoke-Expression|Speak|Speech/i);
  assert.ok(!script.includes(directory));assert.ok(!call.args.some(arg=>arg.includes(directory)));assert.ok(call.options.env.SUDO_CLI_NOTIFICATION_WAV.startsWith(directory));assert.equal(call.options.env.PATH,'runtime-path');assert.equal(call.options.env.SystemRoot,'C:\\Windows');
  for(const key of ['OPENAI_API_KEY','AWS_SECRET_ACCESS_KEY','OTHER'])assert.equal(call.options.env[key],undefined);
  assert.ok(call.options.timeout<=10000);assert.ok(call.options.maxBuffer<=4096);await notifications.close();
}));

test('macOS and Linux players receive only a private file argument and fall through missing binaries',async()=>fixture(async directory=>{
  const {createNotifications}=await api();
  for(const platform of ['darwin','linux']){
    const calls=[];const notifications=createNotifications({directory,interactive:true,platform,env:{PATH:'runtime-path',HOME:'/fixture/home',XDG_RUNTIME_DIR:'/fixture/runtime',OPENAI_API_KEY:'fixture-provider-key',ANTHROPIC_API_KEY:'fixture-provider-key'},execute:async(file,args,options)=>{calls.push({file,args,options});if(file==='paplay')throw missing();}});
    assert.equal((await notifications.notify('done')).status,'played');assert.deepEqual(calls.map(call=>call.file),platform==='darwin'?['afplay']:['paplay','aplay']);
    for(const call of calls){assert.equal(call.options.shell,false);assert.equal(call.options.windowsHide,true);assert.ok(call.args.at(-1).startsWith(directory));assert.equal(call.options.signal.aborted,false);assert.ok(!call.args.includes('-c'));assert.equal(call.options.env.PATH,'runtime-path');assert.equal(call.options.env.HOME,'/fixture/home');assert.equal(call.options.env.XDG_RUNTIME_DIR,'/fixture/runtime');assert.equal(call.options.env.OPENAI_API_KEY,undefined);assert.equal(call.options.env.ANTHROPIC_API_KEY,undefined);}
    if(platform==='linux')assert.deepEqual(calls[1].args.slice(0,-1),['-q']);await notifications.close();
  }
}));

test('missing audio players report terminal-bell fallback with distinguishable rhythms',async()=>fixture(async directory=>{
  const {createNotifications}=await api();const counts=[];
  for(const event of ['connected','done','approval','interrupted']){
    const output=fakeOutput(),notifications=createNotifications({directory,interactive:true,platform:'linux',output,execute:async()=>{throw missing();}});
    const result=await notifications.notify(event);assert.equal(result.status,'terminal-bell');assert.equal(notifications.get().backend,'terminal-bell');
    assert.ok(output.bells.every(item=>item.text==='\x07'));counts.push(output.bells.length);await notifications.close();
  }
  assert.deepEqual(counts,[1,2,3,4]);
}));

test('no usable player or writable TTY is truthfully unavailable, and fallback timers cancel on close',async()=>fixture(async directory=>{
  const {createNotifications}=await api();const quiet=createNotifications({directory,interactive:true,platform:'unknown',output:{isTTY:false,write(){assert.fail('must stay silent');}}});
  assert.equal((await quiet.notify('error')).status,'unavailable');assert.equal(quiet.get().backend,'unavailable');await quiet.close();
  const output=fakeOutput(),notifications=createNotifications({directory,interactive:true,platform:'unknown',output});
  const sound=notifications.notify('interrupted');while(!output.bells.length)await new Promise(resolve=>setTimeout(resolve,2));await notifications.close();assert.equal((await sound).status,'cancelled');
  await new Promise(resolve=>setTimeout(resolve,210));assert.equal(output.bells.length,1);
}));

test('corrupt saved preferences fail closed and private state refuses symbolic links',async()=>fixture(async directory=>{
  const {createNotifications}=await api();let plays=0;
  await writeFile(join(directory,'notifications.json'),JSON.stringify({version:99,enabled:true}));
  const invalid=createNotifications({directory,interactive:true,play:async()=>{plays++;}});await assert.rejects(()=>invalid.load(),/notification.*state|preference/i);assert.equal(invalid.get().enabled,false);await invalid.close();assert.equal(plays,0);
  if(process.platform!=='win32'){
    const linked=join(directory,'linked');await symlink(directory,linked,'dir');
    const unsafe=createNotifications({directory:linked,interactive:true,play:async()=>{plays++;}});await assert.rejects(()=>unsafe.load(),/notification.*preference/i);await unsafe.close();assert.equal(plays,0);
  }
}));

test('backend and saved-state failures expose fixed safe messages instead of raw command or state content',async()=>fixture(async directory=>{
  const {createNotifications}=await api();
  const marker='PRIVATE_FIXTURE_MARKER';
  for(const options of [{platform:'linux',execute:async()=>{throw new Error(marker+' private-path encoded-script');}},{play:async()=>{throw new Error(marker+' recording-output');}}]){
    const notifications=createNotifications({directory,interactive:true,...options});const outcome=await notifications.notify('error');
    assert.equal(outcome.status,'unavailable');assert.doesNotMatch(JSON.stringify(outcome),new RegExp(marker));assert.doesNotMatch(JSON.stringify(notifications.get()),new RegExp(marker));assert.match(outcome.reason,/audio|player/i);await notifications.close();
  }
  await writeFile(join(directory,'notifications.json'),marker);
  const invalid=createNotifications({directory,interactive:true,play:async()=>assert.fail('must fail closed')});
  await assert.rejects(()=>invalid.load(),error=>!error.message.includes(marker)&&/preference/i.test(error.message));
  const outcome=await invalid.notify('error');assert.equal(outcome.status,'unavailable');assert.doesNotMatch(JSON.stringify(invalid.get()),new RegExp(marker));await invalid.close();
}));
