/** Serialize snapshots before changing chat identity. Storage owns validation/redaction. */
export function createChatSession({store,history,getConnection=()=>undefined,getPending=()=>[]}) {
  let current,tail=Promise.resolve(),paused=false;
  const flush=()=>tail;
  const interruptSnapshot=record=>{
    const snapshot=structuredClone(record.history);
    for(const message of snapshot.messages)if(message.role==='assistant' && message.status==='streaming')message.status='interrupted';
    return snapshot;
  };
  const checkpoint=()=>{
    if(!current || paused)return tail;
    const input={id:current.id,history:history.snapshot(),connection:getConnection(),pendingInputs:getPending()};
    const next=tail.catch(()=>{}).then(()=>store.save(input));
    tail=next.then(record=>{if(current?.id===record.id)current=record;return record;});
    return tail;
  };
  const transaction=async fn=>{if(paused)throw new Error('Another chat change is already in progress.');paused=true;try{await flush();return await fn();}finally{paused=false;}};
  const load=record=>{history.restore(interruptSnapshot(record));current=record;return record;};
  return {
    current:()=>current,checkpoint,flush,
    async resumeLast(){return transaction(async()=>{const record=await store.last();return record?load(record):undefined;});},
    async ensure(){if(current)return current;return transaction(async()=>{current=await store.create({history:history.snapshot(),connection:getConnection(),pendingInputs:getPending()});return current;});},
    async open(id){await checkpoint();return transaction(async()=>{const record=await store.get(id);if(!record)throw new Error('Saved chat was not found.');await store.setLast(id);return load(record);});},
    async newChat({keep=true}={}){await checkpoint();return transaction(async()=>{const previous=current;const record=await store.create({connection:getConnection()});load(record);if(!keep && previous)await store.remove(previous.id);return record;});},
    async rename(title){if(!current)await this.ensure();await checkpoint();return transaction(async()=>{current=await store.save({id:current.id,title,history:history.snapshot(),connection:getConnection(),pendingInputs:getPending()});return current;});},
    list:()=>store.list(),
    async remove(id){if(current?.id===id)throw new Error('Start or open another chat before deleting the current chat.');await flush();return store.remove(id);},
  };
}
