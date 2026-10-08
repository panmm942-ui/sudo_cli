const kinds=new Set(['model','agent','background','compact']);
/** Only actual AI task lifetimes feed the antenna and worked-time meter. */
export function createAiActivity({onChange=()=>{}}={}){
  const tasks=new Map();let working=false;
  const snapshot=()=>Object.freeze({working,active:[...tasks.values()].filter(task=>!task.paused).length,paused:[...tasks.values()].filter(task=>task.paused).length});
  const update=()=>{const next=[...tasks.values()].some(task=>!task.paused);if(next!==working){working=next;onChange(snapshot());}};
  return Object.freeze({
    begin(kind,id){if(!kinds.has(kind)||typeof id!=='string'||!id||id.length>128||/[\u0000-\u001f\u007f]/.test(id))throw new Error('An explicit AI task kind and bounded ID are required.');if(!tasks.has(id)){if(tasks.size>=128)throw new Error('Too many concurrent AI tasks.');tasks.set(id,{kind,paused:false});update();}return snapshot();},
    pause(id){const task=tasks.get(id);if(task){task.paused=true;update();}return snapshot();},
    resume(id){const task=tasks.get(id);if(task){task.paused=false;update();}return snapshot();},
    end(id){tasks.delete(id);update();return snapshot();},
    clear(){tasks.clear();update();},snapshot,
  });
}
