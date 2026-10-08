const MAX_TERMINATION_ATTEMPTS=3;
function validateTimeout(value){
  if(!Number.isInteger(value)||value<1000||value>3600000)throw new Error('Command timeout must be an integer from 1000 to 3600000 milliseconds.');
  return value;
}
function validIdentifier(value){
  return typeof value==='string'?value.length>0&&value.length<=256&&!/[\u0000-\u0020\u007f-\u009f]/u.test(value):Number.isSafeInteger(value)&&value>=0;
}

/** Track only command identifiers reported by this native engine, never operating-system PIDs. */
export function createCommandWatchdog({getCommands,terminate,onTimeout=()=>{},onError=()=>{},timeoutMs=120000,pollMs=1000,enabled=true,now=()=>performance.now(),setIntervalFn=setInterval,clearIntervalFn=clearInterval}={}){
  if(typeof getCommands!=='function'||typeof terminate!=='function')throw new Error('Command watchdog requires native command lookup and termination functions.');
  if(typeof onTimeout!=='function'||typeof onError!=='function')throw new Error('Command watchdog callbacks must be functions.');
  if(!Number.isInteger(pollMs)||pollMs<1||pollMs>60000)throw new Error('Command watchdog polling interval must be an integer from 1 to 60000 milliseconds.');
  if(typeof enabled!=='boolean')throw new Error('Command watchdog enabled setting must be boolean.');
  timeoutMs=validateTimeout(timeoutMs);
  let active=true,generation=0,timer,inflight;
  const records=new Map();
  const report=async(error,info)=>{try{await onError(error,info);}catch{/* Diagnostics cannot make polling reject or terminate another command. */}};
  async function sweep(currentGeneration){
    let commands;
    try{commands=await getCommands();if(!Array.isArray(commands))throw new Error('Native command lookup returned an invalid command list.');}
    catch(cause){await report(new Error('Native command timeout lookup could not be completed.',{cause}));return;}
    if(!active||!enabled||generation!==currentGeneration)return;
    const time=now();if(!Number.isFinite(time)){await report(new Error('Native command timeout clock returned an invalid timestamp.'));return;}
    const seen=new Set();
    for(const command of commands){
      if(!command||!validIdentifier(command.itemId)||!validIdentifier(command.processId))continue;
      const key=JSON.stringify([command.itemId,command.processId]);seen.add(key);
      if(!records.has(key))records.set(key,{itemId:command.itemId,processId:command.processId,firstSeen:time,attempts:0,retryAt:0,settled:false});
    }
    for(const key of records.keys())if(!seen.has(key))records.delete(key);
    for(const record of records.values()){
      if(!active||!enabled||generation!==currentGeneration)return;
      const elapsedMs=Math.max(0,time-record.firstSeen);
      if(record.settled||record.attempts>=MAX_TERMINATION_ATTEMPTS||elapsedMs<timeoutMs||time<record.retryAt)continue;
      record.attempts++;record.retryAt=time+Math.max(1000,pollMs);
      const info={itemId:record.itemId,processId:record.processId,elapsedMs,timeoutMs,attempt:record.attempts};
      let confirmed=false,cause;
      try{confirmed=(await terminate(record.processId))===true;}catch(error){cause=error;}
      if(!confirmed){await report(new Error('Native command timeout stop was not confirmed.',cause?{cause}:undefined),info);continue;}
      // The acknowledgement belongs to the issued request even if stop() was requested while awaiting it.
      record.settled=true;
      try{await onTimeout(info);}catch(error){await report(new Error('Native command stopped after its timeout, but timeout notification could not be completed.',{cause:error}),info);}
    }
  }
  function poll(){
    if(inflight)return inflight;
    if(!active||!enabled)return Promise.resolve();
    const operation=sweep(generation).catch(cause=>report(new Error('Native command timeout polling could not be completed.',{cause}))).finally(()=>{if(inflight===operation)inflight=undefined;});
    inflight=operation;return operation;
  }
  return {
    poll,
    start(){
      if(timer!==undefined)return;
      generation++;active=true;records.clear();
      timer=setIntervalFn(poll,pollMs);timer?.unref?.();
    },
    async stop(){
      active=false;generation++;records.clear();
      if(timer!==undefined){clearIntervalFn(timer);timer=undefined;}
      await inflight;
    },
    update(options={}){
      const nextTimeout=options.timeoutMs===undefined?timeoutMs:validateTimeout(options.timeoutMs);
      if(options.enabled!==undefined&&typeof options.enabled!=='boolean')throw new Error('Command watchdog enabled setting must be boolean.');
      timeoutMs=nextTimeout;
      if(options.enabled!==undefined&&options.enabled!==enabled){enabled=options.enabled;generation++;records.clear();}
    },
  };
}
