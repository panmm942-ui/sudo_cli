const safeId=/^[a-z][a-z0-9-]{0,39}$/;
const protectedFromAll=new Set(['memory','preferences','ai','connection','chats','profiles','agents','files','weights','credentials','keys','datasets','history']);

export function createResetCommands({actions,note=()=>{},ask=async()=>''}={}){
  if(!actions||typeof actions!=='object'||Array.isArray(actions)||![Object.prototype,null].includes(Object.getPrototypeOf(actions))||Object.keys(actions).length>64||typeof note!=='function'||typeof ask!=='function')throw new Error('Reset actions or handlers are invalid.');
  const targets=Object.entries(actions).map(([id,action])=>{
    if(!safeId.test(id)||['all','list'].includes(id)||!action||typeof action!=='object'||typeof action.reset!=='function'||typeof action.description!=='string'||!action.description.trim()||action.description.length>500||/[\u0000-\u001f\u007f]/.test(action.description)||action.includeInAll!==undefined&&typeof action.includeInAll!=='boolean'||action.available!==undefined&&typeof action.available!=='function')throw new Error('Reset target action, description or name is invalid.');
    return Object.freeze({id,description:action.description.trim(),reset:action.reset,available:action.available,includeInAll:action.includeInAll!==false&&!protectedFromAll.has(id)});
  });
  const byId=new Map(targets.map(target=>[target.id,target]));
  function available(target){
    if(!target.available)return true;
    try{const result=target.available();if(typeof result!=='boolean')throw new Error('Invalid availability result.');return result;}
    catch(cause){throw new Error(`Reset target ${target.id} availability check failed.`,{cause});}
  }
  function list(){
    const present=targets.filter(available);
    note(present.length?`Reset targets:\n${present.map((target,index)=>`${index+1}. ${target.id}: ${target.description}`).join('\n')}\nall: Reset eligible settings after y/n confirmation.`:'No reset targets are available.');
    return present;
  }
  async function one(id){
    const target=byId.get(id);if(!target)throw new Error(`Unknown reset target: ${id}. Use /reset list.`);
    if(!available(target))throw new Error(`Reset target ${id} is unavailable.`);
    try{await target.reset();}catch(cause){note(`Reset failed: ${id}. The callback did not complete.`);throw new Error(`Reset failed: ${id}.`,{cause});}
    note(`Reset completed: ${id}. ${target.description}`);
  }
  async function all(){
    const selected=targets.filter(target=>target.includeInAll&&available(target));
    if(!selected.length){note('No settings are eligible for reset all.');return;}
    note(`Reset all will apply these setting changes:\n${selected.map(target=>`${target.id}: ${target.description}`).join('\n')}`);
    const answer=await ask('Reset these settings? [y/n]: ');
    if(typeof answer!=='string'||!['y','yes'].includes(answer.trim().toLowerCase())){note('Reset canceled; settings are unchanged.');return;}
    const completed=[],failed=[],errors=[];
    for(const target of selected){
      try{if(!available(target))throw new Error('Target became unavailable.');await target.reset();completed.push(target.id);}
      catch(cause){failed.push(target.id);errors.push(new Error(`Reset failed: ${target.id}.`,{cause}));}
    }
    if(completed.length)note(`Reset completed: ${completed.join(', ')}.`);
    if(failed.length){note(`Reset failed: ${failed.join(', ')}.`);throw new AggregateError(errors,`Reset all finished with failures: ${failed.join(', ')}. Completed: ${completed.length?completed.join(', '):'none'}.`);}
  }
  return Object.freeze({
    async handle(command){
      if(typeof command?.name!=='string'||command.name.toLowerCase()!=='/reset')return false;
      const args=command.args??[];
      if(!Array.isArray(args)||args.length>1||args.some(value=>typeof value!=='string'||!value||value.length>40||/[\u0000-\u0020\u007f]/.test(value)))throw new Error('Usage: /reset [TARGET|list|all].');
      let id=args[0]?.toLowerCase();
      if(!id){
        const present=list();if(!present.length)return true;
        const answer=await ask('Reset target (number/name; Enter cancels): ');
        if(typeof answer!=='string'||!answer.trim()){note('Reset canceled.');return true;}
        const selected=answer.trim().toLowerCase();
        if(/^[1-9]\d*$/.test(selected)){const index=Number(selected)-1;if(!Number.isSafeInteger(index)||!present[index])throw new Error('Invalid reset target selection.');id=present[index].id;}
        else if(safeId.test(selected))id=selected;
        else throw new Error('Invalid reset target selection.');
      }
      if(id==='list')list();else if(id==='all')await all();else await one(id);
      return true;
    },
  });
}
