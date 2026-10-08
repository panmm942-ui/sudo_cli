// Actual UI startup with one gated project scan. No elevation, hardware GPU,
// network, model connection, clipboard access, or audible playback occurs.
import {createSystemPerformance as nativePerformance} from '../../src/system-performance.mjs';
import {createNetworkStatus as nativeNetwork} from '../../src/network-status.mjs';
export {workedTime} from '../../src/dashboard.mjs';
export * from '../../src/github-releases.mjs';
export async function checkGitHubRelease(){return {status:'current'};}

let entered, stop, started, monitor, snapshot;
export function resetStartupGate(){
  started=new Promise(resolve=>{entered=resolve;});
  const blocked=new Promise((_resolve,reject)=>{stop=reject;});
  return {started,blocked,stop:()=>stop(new Error('Fixture startup scan stopped.'))};
}
let gate;
export function setStartupGate(value){gate=value;}
export function performanceSnapshot(){return snapshot?.().performance||monitor?.snapshot();}
export async function requireElevated(){}
export function createSystemPerformance(options){
  let ticks=0;
  const system={cpus:()=>[{times:{user:++ticks,nice:0,sys:0,idle:ticks,irq:0}}],totalmem:()=>8*1024**3,freemem:()=>4*1024**3};
  monitor=nativePerformance({...options,system,cpuMemoryIntervalMs:1,gpuIntervalMs:0,gpuSampler:async()=>({source:'unavailable',adapters:[]})});return monitor;
}
export function createNetworkStatus(options){return nativeNetwork({...options,intervalMs:0,sampler:async()=>({supported:true,interfaces:[]})});}
export function createProjectChanges(){return {initialize(){entered();return gate.blocked;},snapshot:()=>({files:[]}),close:async()=>{}};}
export function createDashboard(options){snapshot=options.snapshot;return {managed:true,start(){},stop(){},refresh(){},setInput(){},event(){},write(){},isScrolled:()=>false,inputArea:()=>({columns:80,top:1,bottom:1})};}
export function createNotifications(){return {load:async()=>({enabled:false}),get:()=>({enabled:false}),notify:async()=>({status:'disabled'}),close:async()=>{}};}
