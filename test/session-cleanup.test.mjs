import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile,writeFile,mkdtemp,mkdir,rm,readdir} from 'node:fs/promises';
import {join} from 'node:path';
import {pathToFileURL} from 'node:url';
import {tmpdir} from './fixtures/temp-root.mjs';
import {cleanupEvents,resetCleanupFault,releaseCleanupGate,reapCleanupEngines,stopCleanupBackground} from './fixtures/session-cleanup-faults.mjs';
import {closeNativeSession,isSessionCleanupError} from '../src/session-cleanup.mjs';

const fixture=new URL('./fixtures/session-cleanup-faults.mjs',import.meta.url).href;
async function callerCopy(t,name){
  const directory=await mkdtemp(join(tmpdir(),'sudo-cleanup-caller-'));t.after(()=>rm(directory,{recursive:true,force:true,maxRetries:5,retryDelay:100}));
  const original=new URL('../src/'+name,import.meta.url);
  const source=(await readFile(original,'utf8')).replace(/from\s+(['"])(\.[^'"]+)\1/g,(_match,_quote,path)=>{
    const replacement=['./engine.mjs','./runtime.mjs','./bridge.mjs','./responses-monitor.mjs','./privileges.mjs','./notifications.mjs','./command-watchdog.mjs','./assistant-features.mjs','./project-changes.mjs'].includes(path)?fixture:new URL(path,original).href;
    return 'from '+JSON.stringify(replacement);
  });
  const target=join(directory,name);await writeFile(target,source);
  return {module:await import(pathToFileURL(target)),directory};
}

test('actual agent caller withholds success on cleanup failure and still closes bridge and home',{timeout:30000},async t=>{
  resetCleanupFault();
  const {module,directory}=await callerCopy(t,'agent-runtime.mjs');const homes=join(directory,'homes');await mkdir(homes);
  await assert.rejects(module.runAgentTask({connection:{model:'fixture-model',baseUrl:'http://127.0.0.1:1/v1',transport:'chat-completions'},cwd:directory,prompt:'Fixture task.',runtime:{baseDir:homes}}),error=>{
    assert.equal(error.code,'ENGINE_CLEANUP_UNVERIFIED');assert.doesNotMatch(error.message,/private-cleanup-canary/);return true;
  });
  assert.deepEqual(cleanupEvents().filter(value=>['engine','bridge','home'].includes(value)),['engine','bridge','home']);assert.deepEqual(await readdir(homes),[]);
});

test('actual agent cleanup failure preserves a failed task as its redacted cause',{timeout:30000},async t=>{
  resetCleanupFault({turn:'failed-turn'});
  const {module,directory}=await callerCopy(t,'agent-runtime.mjs');const homes=join(directory,'homes');await mkdir(homes);
  await assert.rejects(module.runAgentTask({connection:{model:'fixture-model',baseUrl:'http://127.0.0.1:1/v1',transport:'chat-completions'},cwd:directory,prompt:'Fixture failure.',runtime:{baseDir:homes}}),error=>{
    assert.equal(error.code,'ENGINE_CLEANUP_UNVERIFIED');assert.match(error.cause.message,/failed/);assert.doesNotMatch(error.message,/private-cleanup-canary/);return true;
  });
  assert.deepEqual(cleanupEvents().filter(value=>['engine','bridge','home'].includes(value)),['engine','bridge','home']);assert.deepEqual(await readdir(homes),[]);
});

async function withUIState(directory,run,{apiKey}={}){
  const previous={};for(const name of ['SUDO_CLI_STATE_DIR','SUDO_CLI_CODEX','HOME','XDG_CONFIG_HOME','XDG_DATA_HOME','XDG_STATE_HOME','XDG_CACHE_HOME','SUDO_CLI_API_KEY'])previous[name]=process.env[name];
  const stdout=process.stdout.write,stderr=process.stderr.write,exitCode=process.exitCode;let text='';
  try{for(const name of Object.keys(previous)){if(name==='SUDO_CLI_API_KEY'){if(apiKey)process.env[name]=apiKey;else delete process.env[name];}else process.env[name]=name==='SUDO_CLI_CODEX'?process.execPath:join(directory,name.toLowerCase());}process.stdout.write=process.stderr.write=function(chunk){text+=String(chunk);return true;};await run();}
  finally{process.exitCode=exitCode;process.stdout.write=stdout;process.stderr.write=stderr;for(const [name,value] of Object.entries(previous)){if(value===undefined)delete process.env[name];else process.env[name]=value;}}
  return text;
}
async function untilEvent(name){const deadline=Date.now()+5000;while(Date.now()<deadline){if(cleanupEvents().includes(name))return;await new Promise(resolve=>setTimeout(resolve,5));}assert.fail('Owned resource did not reach its gated phase.');}

test('project view cleanup failure still closes the native engine, bridge, home and audio',{timeout:30000},async t=>{
  t.after(reapCleanupEngines);resetCleanupFault({fail:false,projectCleanupError:true});
  const {module,directory}=await callerCopy(t,'ui.mjs');
  const text=await withUIState(directory,async()=>{
    await assert.rejects(module.runUI({cwd:directory,model:'fixture-model',baseUrl:'http://127.0.0.1:1/v1',transport:'chat-completions',once:'Finish the harmless fixture.'}),{code:'SESSION_CLEANUP_FAILED'});
  });
  const events=cleanupEvents();assert.ok(events.includes('project-changes-close'));
  for(const name of ['engine','bridge','home','notifications-close'])assert.ok(events.includes(name),name+' must still close');
  assert.doesNotMatch(text,/project-cleanup-private-canary/);
});

test('actual UI shutdown drains an engine acquired during pending startup without starting work',{timeout:30000},async t=>{
  t.after(reapCleanupEngines);
  resetCleanupFault({fail:false,holdEngine:true,holdBridge:true});
  const {module,directory}=await callerCopy(t,'ui.mjs');
  await withUIState(directory,async()=>{
    const running=module.runUI({cwd:directory,model:'fixture-model',baseUrl:'http://127.0.0.1:1/v1',transport:'chat-completions',once:'No work during shutdown.'});
    try{await untilEvent('engine-acquired');process.emit('SIGTERM');await new Promise(setImmediate);releaseCleanupGate('engine');await new Promise(setImmediate);releaseCleanupGate('bridge');await running;}
    finally{releaseCleanupGate('engine');releaseCleanupGate('bridge');await running.catch(()=>{});}
  });
  const events=cleanupEvents();assert.equal(events.filter(value=>value==='engine').length,1);assert.ok(events.indexOf('bridge')>events.indexOf('engine'));assert.ok(events.indexOf('home')>events.indexOf('bridge'));
  assert.ok(!events.includes('watchdog-start'));assert.ok(!events.includes('turn'));assert.equal(events.filter(value=>value==='notifications-close').length,1);
});

test('actual UI pending-startup cleanup failure still drains resources and delivers attention once',{timeout:30000},async t=>{
  t.after(reapCleanupEngines);resetCleanupFault({holdEngine:true,holdBridge:true});
  const {module,directory}=await callerCopy(t,'ui.mjs');
  await withUIState(directory,async()=>{
    const running=module.runUI({cwd:directory,model:'fixture-model',baseUrl:'http://127.0.0.1:1/v1',transport:'chat-completions',once:'No work during failed shutdown.'});
    const rejected=assert.rejects(running,error=>{assert.equal(error.code,'ENGINE_CLEANUP_UNVERIFIED');assert.doesNotMatch(error.message,/private-cleanup-canary/);return true;});
    try{await untilEvent('engine-acquired');process.emit('SIGHUP');await new Promise(setImmediate);releaseCleanupGate('engine');await new Promise(setImmediate);releaseCleanupGate('bridge');await rejected;}
    finally{releaseCleanupGate('engine');releaseCleanupGate('bridge');await rejected;}
  });
  const events=cleanupEvents();assert.equal(events.filter(value=>value==='engine').length,1);assert.ok(events.indexOf('bridge')>events.indexOf('engine'));assert.ok(events.indexOf('home')>events.indexOf('bridge'));
  assert.ok(!events.includes('watchdog-start'));assert.ok(!events.includes('turn'));assert.equal(events.filter(value=>value==='notify:error').length,1);assert.ok(events.indexOf('notifications-close')>events.indexOf('delivered:error'));
});

test('actual UI failed task remains the redacted cause of unverified cleanup',{timeout:30000},async t=>{
  resetCleanupFault({taskError:true});const {module,directory}=await callerCopy(t,'ui.mjs');
  const text=await withUIState(directory,async()=>{
    await assert.rejects(module.runUI({cwd:directory,model:'fixture-model',baseUrl:'http://127.0.0.1:1/v1',transport:'chat-completions',once:'Fail this fixture.'}),error=>{
      assert.equal(error.code,'ENGINE_CLEANUP_UNVERIFIED');assert.match(error.cause?.message||'',/Fixture primary task failed/);assert.doesNotMatch(error.cause?.message||'',/caller-secret-canary/);assert.doesNotMatch(error.message,/private-cleanup-canary/);return true;
    });
  },{apiKey:'caller-secret-canary'});
  assert.doesNotMatch(text,/caller-secret-canary|private-cleanup-canary/);assert.equal(cleanupEvents().filter(value=>value==='notify:error').length,2,'one failed-task outcome and one distinct cleanup attention');
});

test('actual UI signal shutdown fails when background native cleanup fails despite clean foreground cleanup',{timeout:60000},async t=>{
  for(const code of ['ENGINE_CLEANUP_UNVERIFIED','SESSION_CLEANUP_FAILED'])for(const timing of ['attention-during-close','result-after-close'])await t.test(code+' '+timing,async t=>{
    t.after(reapCleanupEngines);const background=await callerCopy(t,'agent-runtime.mjs');
    const during=timing==='attention-during-close';
    resetCleanupFault({fail:false,holdEngine:true,holdBridge:during,holdBackgroundCleanup:!during,backgroundDelivery:during?'attention-first':'result-first',backgroundCleanupCode:code,runBackground:background.module.runAgentTask});
    const {module,directory}=await callerCopy(t,'ui.mjs');let failureExit;
    const text=await withUIState(directory,async()=>{
      const running=module.runUI({cwd:directory,model:'fixture-model',baseUrl:'http://127.0.0.1:1/v1',transport:'chat-completions',once:'No foreground work during shutdown.'});
      const rejected=assert.rejects(running,error=>{assert.equal(error.code,code);assert.match(error.cause?.message||'',/cancelled/);assert.doesNotMatch(error.message+' '+error.cause?.message,/private-cleanup-canary/);return true;});void rejected.catch(()=>{});
      try{await untilEvent('engine-acquired');await untilEvent('background-turn');process.emit('SIGTERM');releaseCleanupGate('engine');await untilEvent(during?'background-notice':'home-done');releaseCleanupGate(during?'bridge':'background-cleanup');await rejected;failureExit=process.exitCode;}
      finally{releaseCleanupGate('engine');releaseCleanupGate('bridge');releaseCleanupGate('background-cleanup');await running.catch(()=>{});}
    });
    const events=cleanupEvents();assert.equal(failureExit,1);assert.equal(events.filter(value=>value==='engine').length,1);assert.ok(events.includes('background-engine'));assert.ok(events.includes('background-home'));assert.ok(events.includes('home'));assert.ok(!events.includes('turn'));assert.ok(!events.includes('watchdog-start'));
    assert.equal(events.filter(value=>value==='notify:error').length,1);assert.equal(events.filter(value=>value==='notify:interrupted'||value==='notify:approval'||value==='notify:done').length,0);assert.ok(events.indexOf('notifications-close')>events.indexOf('delivered:error'));assert.doesNotMatch(text,/private-cleanup-canary/);
  });
});

test('actual UI pending startup refuses a background cleanup failure before enabling a new AI',{timeout:30000},async t=>{
  for(const code of ['ENGINE_CLEANUP_UNVERIFIED','SESSION_CLEANUP_FAILED'])await t.test(code,async t=>{
    t.after(reapCleanupEngines);const background=await callerCopy(t,'agent-runtime.mjs');
    resetCleanupFault({fail:false,holdEngine:true,backgroundCleanupCode:code,runBackground:background.module.runAgentTask});
    const {module,directory}=await callerCopy(t,'ui.mjs');let failedExit;
    await withUIState(directory,async()=>{
      const running=module.runUI({cwd:directory,model:'fixture-model',baseUrl:'http://127.0.0.1:1/v1',transport:'chat-completions',once:'Never start work after failed background cleanup.'});
      const rejected=assert.rejects(running,{code});void rejected.catch(()=>{});
      try{await untilEvent('engine-acquired');await untilEvent('background-turn');await stopCleanupBackground();releaseCleanupGate('engine');await rejected;failedExit=process.exitCode;}
      finally{releaseCleanupGate('engine');await running.catch(()=>{});}
    });
    const events=cleanupEvents();assert.equal(failedExit,1);assert.ok(!events.includes('watchdog-start'));assert.ok(!events.includes('turn'));assert.equal(events.filter(value=>value==='engine').length,1);assert.ok(events.includes('home'));assert.ok(events.includes('background-home'));assert.equal(events.filter(value=>value==='notify:error').length,1);assert.ok(events.indexOf('notifications-close')>events.indexOf('delivered:error'));
  });
});

test('the actual UI operation keeps cancelled cleanup failures distinct from a verified interruption',async()=>{
  const source=await readFile(new URL('../src/ui.mjs',import.meta.url),'utf8');
  const start=source.indexOf('const runOperation=async('),end=source.indexOf('\n  const budgetOptions=',start);assert.ok(start>=0&&end>start);
  const operation=source.slice(start,end),notification=/const notifyError=error=>\{[^\n]+/.exec(source)?.[0];assert.ok(notification);
  const create=new Function('isSessionCleanupError','tones',`let operationState,busy,activity;const engine={},settings={},operationTasks=[],notifiedErrors=new WeakSet(),dashboard={refresh(){}},ledger={endTask:async()=>{}},aiActivity={end(){}},randomUUID=()=> 'fixture-id',notify=event=>tones.push(event);${notification}\n${operation}\nreturn {run:runOperation,work(){operationState.aiPerformed=true;},abort(){settings.serviceController.abort();},reported:error=>notifiedErrors.has(error),notifyError};`);
  for(const code of ['ENGINE_CLEANUP_UNVERIFIED','SESSION_CLEANUP_FAILED',undefined]){
    const tones=[],api=create(isSessionCleanupError,tones);
    const error=code?Object.assign(new Error('Cleanup needs attention.'),{code}):new DOMException('Verified operation cancelled.','AbortError');
    await assert.rejects(api.run('Fixture operation',async()=>{api.work();api.abort();throw error;}),value=>value===error);
    assert.deepEqual(tones,[code?'error':'interrupted']);assert.equal(api.reported(error),!!code);
    if(code){api.notifyError(error);assert.deepEqual(tones,['error']);}
  }
});

test('the actual foreground background-task wrapper preserves cleanup failures after denied approval',async()=>{
  const source=await readFile(new URL('../src/assistant-features.mjs',import.meta.url),'utf8');
  const match=/const run=(async options=>\{[^\n]+\});/.exec(source);assert.ok(match,'Actual startAgent wrapper must be present.');
  for(const code of ['ENGINE_CLEANUP_UNVERIFIED','SESSION_CLEANUP_FAILED']){
    const error=Object.assign(new Error('Cleanup needs attention.'),{code});
    const run=new Function('runAgentTask','onApproval','return '+match[1])(async options=>{await options.onApproval({});throw error;},async()=>false);
    await assert.rejects(run({}),value=>value===error);
  }
  for(const result of ['failure','success']){
    const run=new Function('runAgentTask','onApproval','return '+match[1])(async options=>{await options.onApproval({});if(result==='failure')throw new Error('Ordinary task failure.');return 'Ordinary task result.';},async()=>false);
    await assert.rejects(run({}),{code:'APPROVAL_REQUIRED'});
  }
});

test('resource cleanup attempts every resource after earlier failures and preserves the primary error',async()=>{
  const events=[],primary=new DOMException('Agent task was cancelled.','AbortError');
  const fail=name=>async()=>{events.push(name);throw new Error('private-resource-canary');};
  await assert.rejects(closeNativeSession({watchdog:{stop:fail('watchdog')},engine:{close:fail('engine')},bridge:{close:fail('bridge')},home:{cleanup:fail('home')}},{cause:primary}),error=>{
    assert.equal(error.code,'ENGINE_CLEANUP_UNVERIFIED');assert.equal(error.cause,primary);assert.doesNotMatch(error.message,/private-resource-canary/);return true;
  });
  assert.deepEqual(events,['watchdog','engine','bridge','home']);
  await assert.rejects(closeNativeSession({engine:{close:async()=>{}},home:{cleanup:fail('home')}}),{code:'SESSION_CLEANUP_FAILED'});
  await assert.doesNotReject(closeNativeSession({engine:{close:async()=>{}}},{cause:primary}));
});

test('the actual worker approval conversion preserves cleanup failures while retaining real approvals',async()=>{
  const source=await readFile(new URL('../src/agent-worker.mjs',import.meta.url),'utf8');
  const branch=/catch \(error\) \{ (if \(approvalNeeded[^\n]+) \}/.exec(source);assert.ok(branch);
  const classify=new Function('error','approvalNeeded','blocked',branch[1]);
  const blocked=()=>Object.assign(new Error('Approval required.'),{code:'APPROVAL_REQUIRED'});
  for(const code of ['ENGINE_CLEANUP_UNVERIFIED','SESSION_CLEANUP_FAILED']){
    const error=Object.assign(new Error('Cleanup needs attention.'),{code});assert.throws(()=>classify(error,true,blocked),value=>value===error);
  }
  assert.throws(()=>classify(new Error('Ordinary failure.'),true,blocked),{code:'APPROVAL_REQUIRED'});
  const original=new Error('Original failure.');assert.throws(()=>classify(original,false,blocked),value=>value===original);
});

test('actual UI caller reports cleanup once, finishes resources and delivers attention before closing audio',{timeout:30000},async t=>{
  resetCleanupFault();
  const {module,directory}=await callerCopy(t,'ui.mjs');
  const previous={};for(const name of ['SUDO_CLI_STATE_DIR','SUDO_CLI_CODEX','HOME','XDG_CONFIG_HOME','XDG_DATA_HOME','XDG_STATE_HOME','XDG_CACHE_HOME'])previous[name]=process.env[name];
  const stdout=process.stdout.write,stderr=process.stderr.write,exitCode=process.exitCode;let text='',failedExitCode;
  try{
    for(const name of Object.keys(previous))process.env[name]=name==='SUDO_CLI_CODEX'?process.execPath:join(directory,name.toLowerCase());
    process.stdout.write=process.stderr.write=function(chunk){text+=String(chunk);return true;};
    await assert.rejects(module.runUI({cwd:directory,model:'fixture-model',baseUrl:'http://127.0.0.1:1/v1',transport:'chat-completions',once:'Fixture task.'}),{code:'ENGINE_CLEANUP_UNVERIFIED'});
  }finally{
    failedExitCode=process.exitCode;process.exitCode=exitCode;
    process.stdout.write=stdout;process.stderr.write=stderr;
    for(const [name,value] of Object.entries(previous)){if(value===undefined)delete process.env[name];else process.env[name]=value;}
  }
  const events=cleanupEvents();assert.equal(events.filter(value=>value==='notify:error').length,1);
  assert.equal(failedExitCode,1);
  assert.ok(events.indexOf('bridge')>events.indexOf('engine'));assert.ok(events.indexOf('home')>events.indexOf('bridge'));
  assert.ok(events.indexOf('notifications-close')>events.indexOf('delivered:error'));assert.doesNotMatch(text,/private-cleanup-canary/);
});
