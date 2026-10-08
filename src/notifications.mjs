import {execFile} from 'node:child_process';
import {mkdtemp,open,lstat,rm,realpath} from 'node:fs/promises';
import {constants} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,resolve,dirname,basename,win32} from 'node:path';
import {createPrivateRecord,privateDirectory} from './private-state.mjs';
import {isolatedEnvironment} from './permission-scope.mjs';

export const NOTIFICATION_EVENTS=Object.freeze(['approval','error','done','interrupted','connected','disconnected']);
const aliases=Object.freeze({'ai-done':'done','ai-interrupted':'interrupted',stop:'interrupted'});
// [frequency in Hz, duration in ms, silence after the note in ms]. These are
// original short motifs; no speech, downloaded recordings, or external assets.
const motifs=Object.freeze({
  approval:[[660,150,65],[880,150,65],[660,230,0]],
  error:[[220,240,100],[185,240,100],[147,330,0]],
  done:[[523,150,35],[659,150,35],[784,280,0]],
  interrupted:[[784,110,55],[523,110,55],[330,250,0]],
  connected:[[440,120,30],[660,200,0]],
  disconnected:[[660,180,85],[440,240,0]],
});
const bellRhythms=Object.freeze({approval:[0,90,90],error:[0,200,200],done:[0,70],interrupted:[0,160,60,160],connected:[0],disconnected:[0,140]});
const sampleRate=22050;
const powershellScript="$ErrorActionPreference='Stop';$path=[Environment]::GetEnvironmentVariable('SUDO_CLI_NOTIFICATION_WAV');$player=New-Object System.Media.SoundPlayer;$player.SoundLocation=$path;try{$player.Load();$player.PlaySync()}finally{$player.Dispose()}";

function eventName(event){
  if(typeof event!=='string')throw new Error('Invalid notification event.');
  const normalized=Object.hasOwn(aliases,event)?aliases[event]:event;
  if(!NOTIFICATION_EVENTS.includes(normalized))throw new Error('Unknown notification event.');
  return normalized;
}
function boundedInteger(value,fallback,min,max,label){
  const number=value===undefined?fallback:value;
  if(!Number.isInteger(number)||number<min||number>max)throw new Error(`Notification ${label} must be between ${min} and ${max}.`);
  return number;
}
function enabledValue(value){
  if(value===true||value==='on')return true;
  if(value===false||value==='off')return false;
  throw new Error('Notifications require on, off, or a boolean.');
}
function executeFile(file,args,options){
  return new Promise((resolvePromise,reject)=>{
    execFile(file,args,options,(error,stdout,stderr)=>error?reject(error):resolvePromise({stdout,stderr}));
  });
}

export function notificationWav(event){
  const notes=motifs[eventName(event)];
  const frames=notes.reduce((sum,[,duration,gap])=>sum+Math.round(sampleRate*duration/1000)+Math.round(sampleRate*gap/1000),0);
  const wave=Buffer.alloc(44+frames*2);
  wave.write('RIFF',0);wave.writeUInt32LE(wave.length-8,4);wave.write('WAVEfmt ',8);wave.writeUInt32LE(16,16);
  wave.writeUInt16LE(1,20);wave.writeUInt16LE(1,22);wave.writeUInt32LE(sampleRate,24);wave.writeUInt32LE(sampleRate*2,28);
  wave.writeUInt16LE(2,32);wave.writeUInt16LE(16,34);wave.write('data',36);wave.writeUInt32LE(frames*2,40);
  let frame=0;
  for(const [frequency,duration,gap] of notes){
    const length=Math.round(sampleRate*duration/1000),fade=Math.min(Math.round(sampleRate*0.015),Math.floor(length/4));
    for(let index=0;index<length;index++){
      const envelope=Math.min(1,index/fade,(length-1-index)/fade);
      // A quiet harmonic gives the motifs a clear timbre while keeping their
      // peak well below full-scale PCM. The envelope prevents abrupt clicks.
      const phase=2*Math.PI*frequency*index/sampleRate;
      const sample=Math.round(envelope*8500*(Math.sin(phase)+0.18*Math.sin(phase*2))/1.18);
      wave.writeInt16LE(sample,44+frame++*2);
    }
    frame+=Math.round(sampleRate*gap/1000);
  }
  return wave;
}

export function createNotifications(options={}){
  if(!options||typeof options!=='object'||Array.isArray(options))throw new Error('Invalid notification options.');
  const {directory,platform=process.platform,output=process.stdout,play,execute=executeFile,env=process.env,now=Date.now}=options;
  if(directory!==undefined&&(typeof directory!=='string'||!directory.trim()))throw new Error('Invalid notification directory.');
  const interactive=options.interactive===undefined?Boolean(output?.isTTY):options.interactive;
  if(typeof interactive!=='boolean')throw new Error('Notification interactive must be a boolean.');
  if(play!==undefined&&typeof play!=='function')throw new Error('Notification play must be a function.');
  if(typeof execute!=='function')throw new Error('Notification execute must be a function.');
  if(typeof now!=='function')throw new Error('Notification clock must be a function.');
  const timeoutMs=boundedInteger(options.timeoutMs,4000,25,10000,'timeout');
  const cooldownMs=boundedInteger(options.cooldownMs,800,0,10000,'cooldown');
  const maxQueue=boundedInteger(options.maxQueue,4,1,8,'queue');
  const maxIds=boundedInteger(options.maxIds,128,1,1024,'ids');
  let enabled=true,closed=false,stopping=0,epoch=0,backend='unprobed',last=null,preferenceError=null;
  let recordPromise,loadPromise,settingsTail=Promise.resolve(),assetsPromise,assetRoot,assetBase,runner,active;
  const paths=new Map(),preparing=new Set(),queue=[],ids=new Map(),lastEvents=new Map();
  const get=()=>({enabled,interactive,closed,backend,pending:queue.length+(active?1:0),rememberedIds:ids.size,last:last?{...last}:null,preferenceError});
  const record=()=>directory?(recordPromise||=createPrivateRecord({directory,filename:'notifications.json',maxBytes:1024})):undefined;
  const result=(status,event,reason)=>({status,event,...(reason?{reason}:{} )});
  async function load(){
    if(!loadPromise)loadPromise=(async()=>{
      const value=await (await record())?.read();
      if(value!==undefined){
        if(!value||value.version!==1||typeof value.enabled!=='boolean'||Object.keys(value).some(key=>key!=='version'&&key!=='enabled'))throw new Error('Invalid notification preference state.');
        enabled=value.enabled;
      }
    })().catch(()=>{enabled=false;preferenceError='Notification preferences are unavailable or invalid.';throw new Error(preferenceError);});
    await loadPromise;return get();
  }
  async function preparePath(event,signal){
    if(!assetsPromise)assetsPromise=(async()=>{
      assetBase=await privateDirectory(directory||await realpath(tmpdir()));
      assetRoot=await mkdtemp(join(assetBase,'notification-sounds-'));
      return assetRoot;
    })();
    const root=await assetsPromise;
    if(signal.aborted)throw signal.reason;
    if(!paths.has(event)){
      const path=join(root,event+'.wav');let file;
      try{file=await open(path,constants.O_WRONLY|constants.O_CREAT|constants.O_EXCL|(constants.O_NOFOLLOW||0),0o600);await file.writeFile(notificationWav(event));}
      finally{await file?.close();}
      paths.set(event,path);
    }
    return paths.get(event);
  }
  async function soundPath(event,signal){
    const work=preparePath(event,signal);preparing.add(work);
    try{return await work;}finally{preparing.delete(work);}
  }
  async function removeAssets(){
    // Aborting playback must not race an in-flight open/write/close. These are
    // our own small file operations, separate from any uncooperative player.
    await Promise.allSettled([...preparing]);
    if(assetsPromise){
      try{await assetsPromise;}catch{}
      if(assetRoot){
        const target=resolve(assetRoot),base=resolve(assetBase);
        if(dirname(target)!==base||!basename(target).startsWith('notification-sounds-'))throw new Error('Unsafe notification asset cleanup path.');
        const info=await lstat(target).catch(error=>{if(error.code==='ENOENT')return null;throw error;});
        if(info&&!info.isSymbolicLink()&&info.isDirectory())await rm(target,{recursive:true,force:true,maxRetries:2,retryDelay:50});
        else if(info)throw new Error('Notification asset directory was replaced.');
      }
      assetsPromise=undefined;assetRoot=undefined;assetBase=undefined;paths.clear();
    }
  }
  function sleep(delay,signal){
    return new Promise((resolvePromise,reject)=>{
      if(signal.aborted){reject(signal.reason);return;}
      const timer=setTimeout(finish,delay);
      function finish(){signal.removeEventListener('abort',abort);resolvePromise();}
      function abort(){clearTimeout(timer);signal.removeEventListener('abort',abort);reject(signal.reason);}
      signal.addEventListener('abort',abort,{once:true});
    });
  }
  async function bells(event,signal){
    if(!output?.isTTY||typeof output.write!=='function')return result('unavailable',event,'No audio player or writable terminal bell is available.');
    for(const delay of bellRhythms[event]){
      if(delay)await sleep(delay,signal);
      if(signal.aborted)throw signal.reason;
      output.write('\x07');
    }
    // This reports BEL delivery, not a promise that the terminal emitted sound.
    return result('terminal-bell',event,'Audio player unavailable; terminal BEL rhythm sent. Terminal settings may mute it.');
  }
  async function playback(event,signal){
    if(signal.aborted)throw signal.reason;
    if(!play&&!['win32','darwin','linux'].includes(platform))return bells(event,signal);
    const path=await soundPath(event,signal);
    if(signal.aborted)throw signal.reason;
    if(play){await play({event,path,signal});return result('played',event);}
    const common={shell:false,windowsHide:true,encoding:'utf8',timeout:timeoutMs,maxBuffer:2048,signal,env:isolatedEnvironment(env)};
    let commands;
    if(platform==='win32'){
      const configuredRoot=env?.SystemRoot||env?.SYSTEMROOT||'C:\\Windows';
      const systemRoot=/^[a-z]:[\\/]Windows[\\/]*$/i.test(configuredRoot)?configuredRoot:'C:\\Windows';
      commands=[[win32.join(systemRoot,'System32','WindowsPowerShell','v1.0','powershell.exe'),['-NoProfile','-NonInteractive','-EncodedCommand',Buffer.from(powershellScript,'utf16le').toString('base64')],{...common,env:isolatedEnvironment(env,{SUDO_CLI_NOTIFICATION_WAV:path})}]];
    }else if(platform==='darwin')commands=[['afplay',[path],common]];
    else commands=[['paplay',[path],common],['aplay',['-q',path],common]];
    for(const [file,args,settings] of commands){
      try{await execute(file,args,settings);return result('played',event);}
      catch(error){if(signal.aborted)throw signal.reason;if(error?.code!=='ENOENT'&&error?.code!=='EACCES')return result('unavailable',event,'Audio player failed or no output device is available.');}
    }
    return bells(event,signal);
  }
  function deliver(item,controller){
    return new Promise(resolvePromise=>{
      let settled=false,timer;
      function finish(value){if(settled)return;settled=true;clearTimeout(timer);controller.signal.removeEventListener('abort',abort);resolvePromise(value);}
      function abort(){finish(result(controller.signal.reason?.code==='NOTIFICATION_TIMEOUT'?'unavailable':'cancelled',item.event,controller.signal.reason?.code==='NOTIFICATION_TIMEOUT'?'Audio playback timed out.':undefined));}
      controller.signal.addEventListener('abort',abort,{once:true});
      timer=setTimeout(()=>controller.abort(Object.assign(new Error('Audio playback timed out.'),{code:'NOTIFICATION_TIMEOUT'})),timeoutMs);
      Promise.resolve().then(()=>playback(item.event,controller.signal)).then(finish,()=>finish(result(controller.signal.aborted?'cancelled':'unavailable',item.event,'Notification audio is unavailable.')));
    });
  }
  function drain(){
    if(runner)return;
    runner=(async()=>{
      while(queue.length&&!closed&&enabled&&!stopping){
        const item=queue.shift(),controller=new AbortController();active={controller,item};
        const outcome=await deliver(item,controller);last=outcome;
        if(outcome.status==='played')backend=play?'injected-player':platform==='win32'?'windows-soundplayer':platform==='darwin'?'afplay':'linux-audio-player';
        else if(outcome.status==='terminal-bell'||outcome.status==='unavailable')backend=outcome.status;
        active=undefined;item.resolve(outcome);
      }
    })().finally(()=>{runner=undefined;});
  }
  async function notify(event,details={}){
    const normalized=eventName(event);
    if(!details||typeof details!=='object'||Array.isArray(details))throw new Error('Invalid notification options.');
    const {id}=details;
    if(id!==undefined&&(typeof id!=='string'||!id.length||id.length>128||/[\x00-\x1f\x7f]/.test(id)))throw new Error('Invalid notification identifier.');
    if(closed||stopping)return result('cancelled',normalized);
    if(!interactive)return result('quiet',normalized);
    const startedEpoch=epoch;
    try{await load();}catch{backend='unavailable';last=result('unavailable',normalized,preferenceError);return {...last};}
    if(closed||stopping||startedEpoch!==epoch)return result('cancelled',normalized);
    if(!enabled)return result('disabled',normalized);
    const key=id===undefined?undefined:normalized+'\0'+id;
    if(key&&ids.has(key))return result('duplicate',normalized);
    const time=now();
    if(lastEvents.has(normalized)&&time-lastEvents.get(normalized)<cooldownMs)return result('cooldown',normalized);
    if(queue.length+(active?1:0)>=maxQueue)return result('busy',normalized);
    if(key){ids.set(key,true);while(ids.size>maxIds)ids.delete(ids.keys().next().value);}
    lastEvents.set(normalized,time);
    return new Promise(resolvePromise=>{queue.push({event:normalized,resolve:resolvePromise});drain();});
  }
  async function stop(){
    epoch++;stopping++;
    active?.controller.abort(new Error('Notification cancelled.'));
    for(const item of queue.splice(0))item.resolve(result('cancelled',item.event));
    try{await runner;await removeAssets();}finally{stopping--;}
    return get();
  }
  async function set(value){
    const desired=enabledValue(value);
    const operation=settingsTail.then(async()=>{
      if(closed)throw new Error('Notifications are closed.');
      await load();
      if(!desired){enabled=false;await stop();}
      await (await record())?.write({version:1,enabled:desired});
      if(closed)throw new Error('Notifications are closed.');
      enabled=desired;return get();
    });
    settingsTail=operation.catch(()=>{});return operation;
  }
  async function close(){closed=true;await stop();return get();}
  return {load,get,status:get,set,on:()=>set(true),off:()=>set(false),notify,stop,close};
}
