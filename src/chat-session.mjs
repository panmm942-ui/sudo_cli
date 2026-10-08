import {createChatHistory} from './chat-history.mjs';
import {createRedactor} from './redactor.mjs';

/** Serialize snapshots before changing chat identity. Storage owns validation/redaction. */
export function createChatSession({store,history,getConnection=()=>undefined,getPending=()=>[],getPendingSubmissions=()=>undefined,secrets=()=>[]}) {
  if(typeof secrets!=='function')throw new Error('Chat context requires a secret supplier.');
  let current,tail=Promise.resolve(),paused=false;
  const contextHistory=createChatHistory({secrets});
  const flush=()=>tail;
  const interruptSnapshot=record=>{
    const snapshot=structuredClone(record.history);
    for(const message of snapshot.messages)if(message.role==='assistant' && message.status==='streaming')message.status='interrupted';
    return snapshot;
  };
  const checkpoint=()=>{
    if(!current || paused)return tail;
    const input={id:current.id,history:history.snapshot(),connection:getConnection(),pendingInputs:getPending(),pendingSubmissions:getPendingSubmissions()};
    const next=tail.catch(()=>{}).then(()=>store.save(input));
    tail=next.then(record=>{if(current?.id===record.id)current=record;return record;});
    return tail;
  };
  const transaction=async fn=>{if(paused)throw new Error('Another chat change is already in progress.');paused=true;try{await flush();return await fn();}finally{paused=false;}};
  const load=record=>{history.restore(interruptSnapshot(record));current=record;return record;};
  const contextSnapshot=()=>{
    const visible=history.snapshot(),retained=current?.contextHistory;
    const messages=new Map();
    for(const message of [...(retained?.messages||[]),...visible.messages])messages.set(message.id,message);
    const promptCount=visible.promptCount??retained?.promptCount;
    return contextHistory.restore({version:1,...(promptCount===undefined?{}:{promptCount}),messages:[...messages.values()]});
  };
  const contextPrompt=()=>{contextSnapshot();return contextHistory.toPrompt();};
  return {
    current:()=>current,checkpoint,flush,contextSnapshot,contextPrompt,
    async resumeLast(){return transaction(async()=>{const record=await store.last();return record?load(record):undefined;});},
    async ensure(){if(current)return current;return transaction(async()=>{current=await store.create({history:history.snapshot(),connection:getConnection(),pendingInputs:getPending(),pendingSubmissions:getPendingSubmissions()});return current;});},
    async open(id){await checkpoint();return transaction(async()=>{const record=await store.get(id);if(!record)throw new Error('Saved chat was not found.');await store.setLast(id);return load(record);});},
    async newChat({keep=true}={}){await checkpoint();return transaction(async()=>{const previous=current;const record=await store.create({connection:getConnection()});load(record);if(!keep && previous)await store.remove(previous.id);return record;});},
    async rename(title){if(!current)await this.ensure();await checkpoint();return transaction(async()=>{current=await store.save({id:current.id,title,history:history.snapshot(),connection:getConnection(),pendingInputs:getPending(),pendingSubmissions:getPendingSubmissions()});return current;});},
    async clear({forget=false}={}){
      if(typeof forget!=='boolean')throw new Error('Clearing chat memory requires an explicit boolean choice.');
      if(!current)await this.ensure();
      return transaction(async()=>{
        const previous=history.snapshot(),context=contextSnapshot();
        const promptCount=previous.promptCount??context.messages.filter(message=>message.role==='user').length;
        const before=new Set(previous.messages.map(message=>message.id));
        const pendingSnapshot=()=>{
          const pendingInputs=structuredClone(getPending()),pendingSubmissions=structuredClone(getPendingSubmissions());
          if(Array.isArray(pendingInputs))for(let index=0;index<pendingInputs.length;index++){
            if(typeof pendingInputs[index]!=='string')throw new Error('Queued chat inputs must contain text prompts.');
            const filter=createRedactor({secrets});pendingInputs[index]=filter.write(pendingInputs[index])+filter.flush();
          }
          return {pendingInputs,pendingSubmissions};
        };
        const synchronize=record=>{
          const live=history.snapshot();
          const messages=live.messages.filter(message=>!before.has(message.id));
          const liveCount=live.promptCount??promptCount+messages.filter(message=>message.role==='user').length;
          const pending=pendingSnapshot();
          const next={...record,history:{version:1,promptCount:Math.max(promptCount,liveCount),messages},pendingInputs:pending.pendingInputs??record.pendingInputs};
          const submissions=pending.pendingSubmissions??(pending.pendingInputs===undefined?record.pendingSubmissions:undefined);
          if(submissions!==undefined)next.pendingSubmissions=submissions;else delete next.pendingSubmissions;
          // The clear boundary excludes old messages only. Input may arrive while
          // disk I/O is pending; its history and submission count must survive.
          history.restore(next.history);current=next;return next;
        };
        const differs=(saved,live)=>JSON.stringify([saved.history,saved.pendingInputs,saved.pendingSubmissions])!==JSON.stringify([live.history,live.pendingInputs,live.pendingSubmissions]);
        const record=await store.save({id:current.id,title:current.title,history:{version:1,promptCount,messages:[]},contextHistory:forget?null:context,connection:getConnection(),...pendingSnapshot()});
        let latest;
        try{
          latest=synchronize(record);
          if(differs(record,latest)){
            // One follow-up save is bounded even if prompts keep arriving. The
            // UI's next checkpoint persists any arrivals during this save.
            const reconciled=await store.save({id:latest.id,title:latest.title,history:latest.history,contextHistory:latest.contextHistory??null,connection:getConnection(),pendingInputs:latest.pendingInputs,pendingSubmissions:latest.pendingSubmissions});
            latest=synchronize(reconciled);
          }
          return latest;
        }catch(cause){
          // The first write has committed. Keep cleared messages cleared, and
          // preserve newer input for a subsequent save instead of rolling back.
          latest=synchronize(latest??record);
          throw Object.assign(new Error('Chat was cleared, but new input accepted during clearing could not be saved. Keep this session open and retry /chat save.',{cause}),{code:'CHAT_CLEAR_COMMITTED',record:latest});
        }
      });
    },
    list:()=>store.list(),
    async remove(id){if(current?.id===id)throw new Error('Start or open another chat before deleting the current chat.');await flush();return store.remove(id);},
  };
}
