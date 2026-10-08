import {spawn} from 'node:child_process';
import {isolatedEnvironment} from '../../src/permission-scope.mjs';

function failure(code,phase){return Object.assign(new Error(`Native fixture process failed (${phase}: ${code}).`),{code,phase});}
function aborted(){return Object.assign(failure('ABORT_ERR','execution'),{name:'AbortError'});}
function validateTimeout(value){if(!Number.isInteger(value)||value<1||value>60000)throw failure('INVALID_TIMEOUT','configuration');}
function waitForExit(child,timeoutMs){
  if(child.exitCode!==null||child.signalCode!==null)return Promise.resolve({exitCode:child.exitCode,signal:child.signalCode});
  return new Promise((resolve,reject)=>{
    const finish=(error,result)=>{clearTimeout(timer);child.removeListener('exit',exit);child.removeListener('error',errorEvent);error?reject(error):resolve(result);};
    const exit=(exitCode,signal)=>finish(undefined,{exitCode,signal});
    const errorEvent=()=>finish(failure('SPAWN_FAILED','startup'));
    const timer=setTimeout(()=>finish(failure('TIMEOUT','execution')),timeoutMs);
    child.once('exit',exit);child.once('error',errorEvent);
  });
}
function drain(stream){
  if(!stream||stream.readableEnded||stream.destroyed)return Promise.resolve();
  return new Promise(resolve=>{
    const finish=()=>{clearTimeout(timer);stream.removeListener('end',finish);stream.removeListener('close',finish);stream.removeListener('error',finish);resolve();};
    const timer=setTimeout(finish,200);stream.once('end',finish);stream.once('close',finish);stream.once('error',finish);
  });
}
export async function stopFixtureProcess(child,{timeoutMs=3000}={}){
  validateTimeout(timeoutMs);
  if(child.pid&&child.exitCode===null&&child.signalCode===null){child.kill('SIGKILL');await waitForExit(child,timeoutMs);}
  // Exit confirms the owned process has stopped. A descendant may still hold
  // inherited pipe handles; those are not a reason to retain our reader handles.
  child.stdin?.destroy();child.stdout?.destroy();child.stderr?.destroy();
}
export async function runFixtureProcess(executable,args,{timeoutMs=30000,maxBytes=32768,env=process.env,cwd,signal,onStderr}={}){
  validateTimeout(timeoutMs);if(!Number.isInteger(maxBytes)||maxBytes<1||maxBytes>1024*1024)throw failure('INVALID_OUTPUT_LIMIT','configuration');
  if(signal?.aborted)throw aborted();
  const child=spawn(executable,args,{env:isolatedEnvironment(env),cwd,windowsHide:true,stdio:['ignore','pipe','pipe']});
  const stdout=[],stderr=[];let bytes=0,collectionError;
  const collect=(destination,chunk,callback)=>{
    bytes+=chunk.length;if(bytes>maxBytes){collectionError=failure('OUTPUT_LIMIT','collection');child.kill('SIGKILL');return;}
    destination.push(chunk);try{callback?.(chunk.toString('utf8'));}catch{collectionError=failure('OBSERVER_FAILED','collection');child.kill('SIGKILL');}
  };
  child.stdout.on('data',chunk=>collect(stdout,chunk));child.stderr.on('data',chunk=>collect(stderr,chunk,onStderr));
  const abort=()=>child.kill('SIGKILL');signal?.addEventListener('abort',abort,{once:true});
  try{
    const status=await waitForExit(child,timeoutMs);await Promise.all([drain(child.stdout),drain(child.stderr)]);
    if(signal?.aborted)throw aborted();if(collectionError)throw collectionError;
    if(status.exitCode!==0)throw Object.assign(failure('NONZERO_EXIT','execution'),status);
    return{stdout:Buffer.concat(stdout).toString('utf8'),stderr:Buffer.concat(stderr).toString('utf8'),exitCode:status.exitCode};
  }finally{signal?.removeEventListener('abort',abort);await stopFixtureProcess(child);}
}
