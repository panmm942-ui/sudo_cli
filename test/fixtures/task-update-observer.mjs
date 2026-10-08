const terminal=new Set(['completed','blocked','failed']);

/** Test-only receipt of the real inbox update, registered before work starts. */
export function observeTaskUpdates(inbox){
  if(typeof inbox?.update!=='function')throw new Error('Task observer requires an inbox update method.');
  const original=inbox.update,waiters=new Map();let closed=false,count=0;
  function finish(waiter,error,value){
    if(waiter.settled)return;waiter.settled=true;
    waiter.signal?.removeEventListener('abort',waiter.abort);
    const selected=waiters.get(waiter.id);selected?.delete(waiter);if(!selected?.size)waiters.delete(waiter.id);count--;
    if(error)waiter.reject(error);else waiter.resolve(value);
  }
  const wrapped=async function(id,patch,...rest){
    let record;
    try{record=await original.call(this,id,patch,...rest);}
    catch(error){for(const waiter of [...(waiters.get(id)||[])])finish(waiter,error);throw error;}
    for(const waiter of [...(waiters.get(id)||[])]){
      if(record?.id!==id)finish(waiter,new Error('Task update returned identity does not match the observed task.'));
      else if(record.status!==patch?.status)finish(waiter,new Error('Task update returned status does not match its committed transition.'));
      else if(record.status===waiter.status)finish(waiter,undefined,record);
      else if(terminal.has(record.status))finish(waiter,new Error('Task reached an unexpected terminal status.'));
    }
    return record;
  };
  inbox.update=wrapped;
  return {
    waitFor(id,status,{signal}={}){
      if(closed)throw new Error('Task update observer is closed.');
      if(typeof id!=='string'||!id||id.length>256||!terminal.has(status))throw new Error('Task observer requires a bounded task identity and terminal status.');
      if(count>=128)throw new Error('Task observer registration limit exceeded.');
      let waiter;
      const promise=new Promise((resolve,reject)=>{waiter={id,status,signal,resolve,reject};});
      // A transition can reject while start() is still awaited. Preserve that
      // rejection for its owner without a temporary unhandled rejection.
      promise.catch(()=>{});
      const selected=waiters.get(id)||new Set();selected.add(waiter);waiters.set(id,selected);count++;
      waiter.abort=()=>finish(waiter,signal.reason);
      if(signal?.aborted)waiter.abort();else signal?.addEventListener('abort',waiter.abort,{once:true});
      return promise;
    },
    close(){
      if(closed)return;closed=true;
      if(inbox.update===wrapped)inbox.update=original;
      for(const selected of [...waiters.values()])for(const waiter of [...selected])finish(waiter,new Error('Task observer closed before the expected transition.'));
    },
  };
}
