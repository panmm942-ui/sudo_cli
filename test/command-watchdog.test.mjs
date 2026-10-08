import test from 'node:test';
import assert from 'node:assert/strict';

const command={itemId:'native-item',processId:'native-process'};

test('native timeout uses observed lifetime and confirms termination before reporting it',async()=>{
  const {createCommandWatchdog}=await import('../src/command-watchdog.mjs');
  let time=1000000;const actions=[];
  const watchdog=createCommandWatchdog({now:()=>time,timeoutMs:1000,getCommands:async()=>[command],
    terminate:async processId=>{actions.push('terminate:'+processId);return true;},
    onTimeout:async info=>{actions.push('timeout:'+info.itemId);assert.equal(info.elapsedMs,1000);}});
  await watchdog.poll();time+=999;await watchdog.poll();assert.deepEqual(actions,[]);
  time+=1;await watchdog.poll();assert.deepEqual(actions,['terminate:native-process','timeout:native-item']);
  time+=10000;await watchdog.poll();assert.equal(actions.length,2,'Acknowledged command must not be terminated repeatedly');await watchdog.stop();
});

test('vanished commands and new native process identifiers receive independent lifetimes',async()=>{
  const {createCommandWatchdog}=await import('../src/command-watchdog.mjs');
  let time=0,commands=[command];const terminated=[];
  const watchdog=createCommandWatchdog({now:()=>time,timeoutMs:1000,getCommands:async()=>commands,terminate:async id=>{terminated.push(id);return true;}});
  await watchdog.poll();time=900;commands=[];await watchdog.poll();time=2000;commands=[command];await watchdog.poll();
  time=2500;commands=[{...command,processId:'new-native-process'}];await watchdog.poll();time=3499;await watchdog.poll();assert.deepEqual(terminated,[]);
  time=3500;await watchdog.poll();assert.deepEqual(terminated,['new-native-process']);await watchdog.stop();
});

test('unlisted approvals and malformed identifiers never become termination requests',async()=>{
  const {createCommandWatchdog}=await import('../src/command-watchdog.mjs');
  let time=0;const terminated=[];
  const watchdog=createCommandWatchdog({now:()=>time,timeoutMs:1000,getCommands:async()=>[{},null,{itemId:'approval-awaiting-user'},
    {itemId:'bad-control-id',processId:'\n'}, {itemId:'no-native-process',processId:undefined}],terminate:async id=>{terminated.push(id);return true;}});
  await watchdog.poll();time=10000;await watchdog.poll();assert.deepEqual(terminated,[]);await watchdog.stop();
});

test('overlapping polls share one lookup and stopping cancels actions from a pending lookup',async()=>{
  const {createCommandWatchdog}=await import('../src/command-watchdog.mjs');
  let resolveLookup,lookups=0,terminated=0;
  const watchdog=createCommandWatchdog({timeoutMs:1000,getCommands:()=>{lookups++;return new Promise(resolve=>{resolveLookup=resolve;});},terminate:async()=>{terminated++;return true;}});
  const first=watchdog.poll(),second=watchdog.poll();await Promise.resolve();assert.equal(lookups,1);
  let stopped=false;const stopping=watchdog.stop().then(()=>{stopped=true;});await Promise.resolve();assert.equal(stopped,false);
  resolveLookup([command]);await Promise.all([first,second,stopping]);assert.equal(terminated,0);
  await watchdog.poll();assert.equal(lookups,1,'Stopped watchdog must remain stopped until restarted');
});

test('stopping waits for an already issued native termination acknowledgement',async()=>{
  const {createCommandWatchdog}=await import('../src/command-watchdog.mjs');
  let time=0,resolveTermination,reported=0;
  const watchdog=createCommandWatchdog({now:()=>time,timeoutMs:1000,getCommands:async()=>[command],
    terminate:()=>new Promise(resolve=>{resolveTermination=resolve;}),onTimeout:()=>{reported++;}});
  await watchdog.poll();time=1000;const pending=watchdog.poll();await Promise.resolve();await Promise.resolve();
  let stopped=false;const stopping=watchdog.stop().then(()=>{stopped=true;});await Promise.resolve();assert.equal(stopped,false);
  resolveTermination(true);await Promise.all([pending,stopping]);assert.equal(stopped,true);assert.equal(reported,1);
});

test('failed and unconfirmed native termination retry finitely without false timeout confirmation',async()=>{
  const {createCommandWatchdog}=await import('../src/command-watchdog.mjs');
  let time=0,attempts=0;const errors=[],reported=[];
  const watchdog=createCommandWatchdog({now:()=>time,timeoutMs:1000,pollMs:1000,getCommands:async()=>[command],
    terminate:async()=>{attempts++;if(attempts===1)throw new Error('upstream diagnostic');return false;},
    onTimeout:info=>reported.push(info),onError:error=>errors.push(error.message)});
  await watchdog.poll();for(time=1000;time<=10000;time+=1000)await watchdog.poll();
  assert.equal(attempts,3);assert.equal(errors.length,3);assert.deepEqual(reported,[]);
  assert.ok(errors.every(message=>/not confirmed|could not|unable/i.test(message)));await watchdog.stop();
});

test('reconfiguration disables actions and applies timeout changes to a currently observed command',async()=>{
  const {createCommandWatchdog}=await import('../src/command-watchdog.mjs');
  let time=0;const terminated=[];
  const watchdog=createCommandWatchdog({now:()=>time,timeoutMs:5000,getCommands:async()=>[command],terminate:async id=>{terminated.push(id);return true;}});
  await watchdog.poll();time=2000;watchdog.update({timeoutMs:1000});await watchdog.poll();assert.deepEqual(terminated,['native-process']);
  watchdog.update({enabled:false});time=10000;await watchdog.poll();watchdog.update({enabled:true});await watchdog.poll();
  time=10999;await watchdog.poll();assert.equal(terminated.length,1);time=11000;await watchdog.poll();assert.equal(terminated.length,2);
  for(const timeoutMs of [0,999,3600001,NaN,Infinity,'1000'])assert.throws(()=>watchdog.update({timeoutMs}),/timeout/i);
  await watchdog.stop();
});

test('start installs one unref timer and restart forgets commands from the preceding native session',async()=>{
  const {createCommandWatchdog}=await import('../src/command-watchdog.mjs');
  let time=0,tick,installed=0,cleared=0,unrefed=0;const terminated=[];
  const watchdog=createCommandWatchdog({now:()=>time,timeoutMs:1000,getCommands:async()=>[command],terminate:async id=>{terminated.push(id);return true;},
    setIntervalFn:callback=>{tick=callback;installed++;return {unref(){unrefed++;}};},clearIntervalFn:()=>{cleared++;}});
  watchdog.start();watchdog.start();assert.equal(installed,1);assert.equal(unrefed,1);await tick();await watchdog.poll();
  await watchdog.stop();assert.equal(cleared,1);time=10000;watchdog.start();await watchdog.poll();assert.deepEqual(terminated,[]);
  time=11000;await watchdog.poll();assert.deepEqual(terminated,['native-process']);await watchdog.stop();assert.equal(cleared,2);
});

test('lookup and notification failures reach onError without disabling later native polling',async()=>{
  const {createCommandWatchdog}=await import('../src/command-watchdog.mjs');
  let time=0,lookups=0,terminations=0,notifications=0;const errors=[];
  const watchdog=createCommandWatchdog({now:()=>time,timeoutMs:1000,getCommands:async()=>{lookups++;if(lookups===1)throw new Error('lookup failed');return [command];},
    terminate:async()=>{terminations++;return true;},onTimeout:()=>{notifications++;throw new Error('notification failed');},onError:error=>errors.push(error.message)});
  await watchdog.poll();await watchdog.poll();time=1000;await watchdog.poll();time=3000;await watchdog.poll();
  assert.equal(errors.length,2);assert.equal(terminations,1);assert.equal(notifications,1);assert.equal(lookups,4);await watchdog.stop();
});
