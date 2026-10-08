import {spawn} from 'node:child_process';
import {win32} from 'node:path';
import {isolatedEnvironment} from './permission-scope.mjs';
import {ownProcess} from './owned-process.mjs';

// Fixed stock command, invoked only by an explicit paste key. Clipboard text
// never enters arguments, environment, logs or files. Hold the process at stdin
// until the existing owner can observe and verify its original lifetime.
const SCRIPT="$ErrorActionPreference='Stop';$env:PSModulePath=$PSHOME+'\\Modules';Import-Module ($PSHOME+'\\Modules\\Microsoft.PowerShell.Management\\Microsoft.PowerShell.Management.psd1');$PSModuleAutoLoadingPreference='None';$value=[string](Get-Clipboard -Raw);[Console]::WriteLine([Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes($value)));$null=[Console]::ReadLine()";
const failure=()=>new Error('Clipboard could not be read. Use the terminal paste menu.');

/** Windows Ctrl+V fallback; native terminal paste remains the portable default. */
export async function readTerminalClipboard({platform=process.platform,env=process.env,signal,maxBytes=1024*1024,timeoutMs=3000,spawnProcess=spawn,ownerFactory=ownProcess}={}){
  if(platform!=='win32')throw new Error('Use the terminal paste menu on this platform.');
  signal?.throwIfAborted();
  const systemRoot=env.SystemRoot||env.SYSTEMROOT||env.windir||'C:\\Windows';
  if(!/^[a-z]:\\Windows$/i.test(systemRoot))throw failure();
  maxBytes=Math.max(1,Math.min(1024*1024,Number.isFinite(maxBytes)?Math.floor(maxBytes):1024*1024));
  timeoutMs=Math.max(1,Math.min(5000,Number.isFinite(timeoutMs)?Math.floor(timeoutMs):3000));
  const executable=win32.join(systemRoot,'System32','WindowsPowerShell','v1.0','powershell.exe');
  let child,owner,timer,abort,data,stderr,exit,error;
  try{
    child=spawnProcess(executable,['-NoProfile','-NonInteractive','-EncodedCommand',Buffer.from(SCRIPT,'utf16le').toString('base64')],{shell:false,windowsHide:true,stdio:['pipe','pipe','pipe'],env:isolatedEnvironment(env),detached:process.platform!=='win32'});
    child.stdin?.on('error',()=>{});owner=ownerFactory(child);
    const result=new Promise((resolve,reject)=>{
      let chunks=[],bytes=0,errorBytes=0,settled=false;
      const finish=(problem,value)=>{if(settled)return;settled=true;problem?reject(problem):resolve(value);};
      error=()=>finish(failure());exit=()=>finish(failure());
      abort=()=>finish(new DOMException('Clipboard paste was canceled.','AbortError'));
      stderr=chunk=>{errorBytes+=chunk.length;if(errorBytes>2048)finish(failure());};
      data=chunk=>{
        bytes+=chunk.length;if(bytes>Math.ceil(maxBytes/3)*4+1024){finish(failure());return;}
        chunks.push(chunk);const buffer=Buffer.concat(chunks),end=buffer.indexOf(10);if(end<0)return;
        try{
          const line=buffer.subarray(0,end).toString('ascii').replace(/\r$/,'');
          if(!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(line))throw failure();
          const decoded=Buffer.from(line,'base64');if(decoded.length>maxBytes||decoded.toString('base64')!==line)throw failure();
          finish(undefined,new TextDecoder('utf-8',{fatal:true}).decode(decoded));
        }catch{finish(failure());}
      };
      child.stdout.on('data',data);child.stderr.on('data',stderr);child.once('error',error);child.once('exit',exit);
      signal?.addEventListener('abort',abort,{once:true});if(signal?.aborted)abort();
      timer=setTimeout(()=>finish(failure()),timeoutMs);timer.unref?.();
    });
    const [,text]=await Promise.all([owner.capture(Date.now()+timeoutMs),result]);return text;
  }catch(problem){if(problem?.name==='AbortError')throw problem;throw failure();}
  finally{
    clearTimeout(timer);signal?.removeEventListener('abort',abort);
    let unverified=false;
    try{await owner?.close();}catch{unverified=true;}
    if(data)child?.stdout?.removeListener('data',data);if(stderr)child?.stderr?.removeListener('data',stderr);if(exit)child?.removeListener('exit',exit);if(error)child?.removeListener('error',error);
    if(unverified)throw Object.assign(new Error('Clipboard process cleanup could not be verified.'),{code:'SESSION_CLEANUP_FAILED'});
  }
}
