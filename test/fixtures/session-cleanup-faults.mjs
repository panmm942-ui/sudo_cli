import {createEngine as nativeEngine} from '../../src/engine.mjs';
import {createSessionHome as nativeHome} from '../../src/runtime.mjs';
import {startBridge as bridge} from '../../src/bridge.mjs';
import {startResponsesMonitor as monitor} from '../../src/responses-monitor.mjs';
import {createCommandWatchdog as nativeWatchdog} from '../../src/command-watchdog.mjs';
import {createAssistantFeatures as nativeFeatures,createBackgroundResultReporter} from '../../src/assistant-features.mjs';
import {createAlwaysOn} from '../../src/always-on.mjs';
import {createTaskInbox} from '../../src/task-inbox.mjs';
import {createProjectChanges as nativeProjectChanges} from '../../src/project-changes.mjs';
import {join} from 'node:path';
import {mkdir} from 'node:fs/promises';
import {fileURLToPath} from 'node:url';
export * from '../../src/engine.mjs';
export * from '../../src/runtime.mjs';
export {backgroundNotificationEvent} from '../../src/assistant-features.mjs';

let events=[],failure=true,projectCleanupFailure=false,scenario='normal',throwTurn=false,gates={},backgroundCode,backgroundRun,backgroundOrder,activeBackground;const ownedEngines=new Set();
export function resetCleanupFault({fail=true,turn='normal',taskError=false,projectCleanupError=false,holdEngine=false,holdBridge=false,holdBackgroundCleanup=false,backgroundCleanupCode,runBackground,backgroundDelivery='attention-first'}={}){events=[];failure=fail;projectCleanupFailure=projectCleanupError;scenario=turn;throwTurn=taskError;backgroundCode=backgroundCleanupCode;backgroundRun=runBackground;backgroundOrder=backgroundDelivery;activeBackground=undefined;gates={};for(const name of [holdEngine?'engine':null,holdBridge?'bridge':null,holdBackgroundCleanup?'background-cleanup':null].filter(Boolean)){let release;const wait=new Promise(resolve=>{release=resolve;});gates[name]={wait,release};}}
export function createProjectChanges(options){const value=nativeProjectChanges(options);return {...value,async close(){events.push('project-changes-close');await value.close();if(projectCleanupFailure)throw new Error('project-cleanup-private-canary');}};}
export function cleanupEvents(){return [...events];}
export function releaseCleanupGate(name){gates[name]?.release();}
export async function stopCleanupBackground(){if(!activeBackground)throw new Error('Background fixture has not started.');await activeBackground.stop();}
export async function reapCleanupEngines(){for(const engine of ownedEngines){await engine.close();ownedEngines.delete(engine);}}
export async function createEngine(options){
  const background=options.developerInstructions==='fixture-background-native-cleanup';
  const engine=await nativeEngine({...options,codexPath:[process.execPath,fileURLToPath(new URL('./engine-server.mjs',import.meta.url))],env:{...options.env,ENGINE_SCENARIO:background?'hang-turn':scenario}});
  ownedEngines.add(engine);
  let closing;
  const value={...engine,startTurn(...args){events.push(background?'background-turn':'turn');if(!background&&throwTurn)throw new Error('Fixture primary task failed. caller-secret-canary');return engine.startTurn(...args);},close(){return closing??=(async()=>{await engine.close();ownedEngines.delete(engine);events.push(background?'background-engine':'engine');if(background)await gates['background-cleanup']?.wait;if(background?backgroundCode==='ENGINE_CLEANUP_UNVERIFIED':failure)throw new Error('private-cleanup-canary');})();}};
  events.push(background?'background-engine-acquired':'engine-acquired');if(!background)await gates.engine?.wait;return value;
}
export async function createSessionHome(options){
  const home=await nativeHome(options);
  const background=String(options?.baseDir||'').includes('background-homes');
  return {...home,async cleanup(){events.push(background?'background-home':'home');await home.cleanup();events.push(background?'background-home-done':'home-done');if(background&&backgroundCode==='SESSION_CLEANUP_FAILED')throw new Error('private-cleanup-canary');}};
}
async function observedBridge(factory,options){const value=await factory(options),background=options.model==='fixture-background';return {...value,async close(){events.push(background?'background-bridge':'bridge');if(!background)await gates.bridge?.wait;await value.close();}};}
export function startBridge(options){return observedBridge(bridge,options);}
export function startResponsesMonitor(options){return observedBridge(monitor,options);}
export function createCommandWatchdog(options){const value=nativeWatchdog(options);return {...value,start(){events.push('watchdog-start');return value.start();},stop(){events.push('watchdog-stop');return value.stop();}};}
export function createAssistantFeatures(options){
  const api=nativeFeatures(options);if(!backgroundCode)return api;
  let coordinator;
  const ready=(async()=>{
    const inbox=await createTaskInbox({cwd:options.cwd,stateDir:join(options.stateDir,'background-fixture')});
    await mkdir(join(options.stateDir,'background-homes'),{recursive:true});
    let cleanupError;
    const reporter=createBackgroundResultReporter({work:{result:async(_job,patch)=>patch},onResult:options.onBackgroundResult,onAttention:options.onBackgroundError});
    coordinator=createAlwaysOn({inbox,pollMs:10,idleSleepMs:40,beginTask:id=>reporter.begin(id),onTaskResult:async(job,patch,detail)=>{
      if(backgroundOrder==='result-first'&&cleanupError){const result=await reporter.result(job,{...patch,code:cleanupError.code,cause:cleanupError.cause},detail);await reporter.error(cleanupError,job.id);events.push('background-notice');return result;}
      return reporter.result(job,patch,detail);
    },onState:options.onBackgroundState,onError:async error=>{cleanupError=error;if(backgroundOrder!=='result-first'){await reporter.error(error,coordinator.snapshot().activeJobId);events.push('background-notice');}},assess:async()=>({action:'cloud'}),runCloud:async(job,{signal})=>{
      const result=await backgroundRun({connection:{model:'fixture-background',baseUrl:'http://127.0.0.1:1/v1',transport:'chat-completions'},cwd:options.cwd,prompt:job.prompt,developerInstructions:'fixture-background-native-cleanup',signal,runtime:{baseDir:join(options.stateDir,'background-homes')}});return result.text;
    }});
    activeBackground=coordinator;await coordinator.start();await coordinator.submit('Explicit background cleanup fixture.');
  })();
  return {...api,async stop(){await ready;await coordinator.stop();await api.stop();}};
}
// These API faults need no elevation, real provider, or physical audio.
export async function requireElevated(){}
export function createNotifications(){return {
  load:async()=>({enabled:true}),get:()=>({enabled:true}),
  notify:async event=>{events.push('notify:'+event);await new Promise(resolve=>setTimeout(resolve,25));events.push('delivered:'+event);},
  close:async()=>{events.push('notifications-close');},
};}
