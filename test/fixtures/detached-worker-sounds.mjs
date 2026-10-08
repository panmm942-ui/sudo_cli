// Synthetic runtime only: exercise the actual worker without elevation,
// remote model requests, executable AI tools, or audible host playback.
import {mock} from 'node:test';
import * as privileges from '../../src/privileges.mjs';
import * as notifications from '../../src/notifications.mjs';

// Node discovers .mjs files below test/. Only the explicit fork harness has
// IPC and enables module mocks; ordinary discovery must leave the host idle.
if(process.send){
mock.module(new URL('../../src/privileges.mjs',import.meta.url).href,{namedExports:{...privileges,requireElevated:async()=>{}}});
mock.module(new URL('../../src/notifications.mjs',import.meta.url).href,{namedExports:{...notifications,createNotifications:options=>notifications.createNotifications({...options,play:async({event})=>{
  process.send?.({type:'fixture-sound',event,nonTTY:options.output?.isTTY===false});
  await new Promise(resolve=>setTimeout(resolve,30));
}})}});
mock.module(new URL('../../src/agent-runtime.mjs',import.meta.url).href,{namedExports:{runAgentTask:async options=>{
  let task;try{task=JSON.parse(options.prompt).task;}catch{}
  process.send?.({type:'fixture-request'});
  if(task==='stop'){
    process.send?.({type:'fixture-waiting'});
    await new Promise((resolve,reject)=>{if(options.signal.aborted)reject(options.signal.reason);else options.signal.addEventListener('abort',()=>reject(options.signal.reason),{once:true});});
  }
  if(task==='approval'){options.onApproval();throw new Error('Fixture permission denial.');}
  if(task==='information')return {text:JSON.stringify({action:'wait',reason:'Need more information.'})};
  if(task==='error')return {text:JSON.stringify({action:'cloud',prompt:'fail-cloud'})};
  if(options.prompt==='fail-cloud')throw new Error('Fixture task failure.');
  return {text:JSON.stringify({action:'local',result:'Fixture task completed.'})};
}}});
await import('../../src/agent-worker.mjs');
}
