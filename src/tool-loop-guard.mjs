import {createHash} from 'node:crypto';

const MAX_BYTES=16*1024*1024,MAX_RECENT=30;
const callTypes=new Set(['function_call','custom_tool_call']);
const outputTypes=new Set(['function_call_output','custom_tool_call_output']);
const volatileFields=new Set(['chunk_id','wall_time_seconds','original_token_count']);
const hash=value=>createHash('sha256').update(value).digest('hex');
function fail(code,message){throw Object.assign(new Error(message),{code});}
function invalid(){fail('TOOL_LOOP_INVALID','The tool-loop guard received invalid tool history.');}
function historyLimit(){fail('TOOL_LOOP_HISTORY_LIMIT','Tool history exceeded the loop guard limit. Start a new explicit task or reduce its history.');}
function identity(value){if(typeof value!=='string'||!value||value.length>256||/[\u0000-\u001f\u007f]/.test(value))invalid();return value;}
function canonical(value,depth=0){
  if(depth>128)historyLimit();
  if(value===null||typeof value!=='object')return JSON.stringify(value)??'null';
  if(Array.isArray(value))return`[${value.map(item=>canonical(item,depth+1)).join(',')}]`;
  return`{${Object.keys(value).sort().map(key=>`${JSON.stringify(key)}:${canonical(value[key],depth+1)}`).join(',')}}`;
}
function nativeText(value){
  const text=value.replace(/\r\n|\r/g,'\n'),lines=text.split('\n');
  const marker=lines.findIndex(line=>line==='Final output:'||line==='Output:');
  const volatile=line=>/^(?:Chunk ID:|Wall time:|Original token count:) /.test(line);
  const wrapper=line=>line===''||volatile(line)||/^(?:Process exited with code |Process running with session ID |Exit code: |Session ID: )/.test(line);
  // Only remove metadata in a recognizable header; timing-like lines inside the command output are retained.
  if(marker<0||!lines.slice(0,marker).some(volatile)||!lines.slice(0,marker).every(wrapper))return text;
  return[...lines.slice(0,marker).filter(line=>!volatile(line)),...lines.slice(marker)].join('\n');
}
function nativeObject(value){return value!==null&&typeof value==='object'&&!Array.isArray(value)&&typeof value.output==='string'&&('exit_code' in value||'session_id' in value||'chunk_id' in value);}
function normalizedOutput(value,executionTool,depth=0){
  if(depth>128)historyLimit();
  if(typeof value==='string'){
    if(executionTool){let parsed;try{parsed=JSON.parse(value);}catch{/* Ordinary tool output remains text. */}if(nativeObject(parsed))return normalizedOutput(parsed,true,depth+1);}
    return executionTool?nativeText(value):value.replace(/\r\n|\r/g,'\n');
  }
  if(Array.isArray(value))return value.map(item=>normalizedOutput(item,executionTool,depth+1));
  if(value!==null&&typeof value==='object'){
    const structured=executionTool&&nativeObject(value),result=Object.create(null);
    for(const key of Object.keys(value)){
      if(structured&&volatileFields.has(key))continue;
      // A structured wrapper's output field is the actual command output, not another wrapper.
      result[key]=normalizedOutput(value[key],structured&&key==='output'?false:executionTool,depth+1);
    }
    return result;
  }
  return value;
}
function signature(call,output){
  const name=identity(call.name),namespace=call.namespace==null?null:identity(call.namespace);
  const executionTool=call.type==='function_call'&&['exec_command','write_stdin'].includes(name.split('.').at(-1));
  let args,argsKind='json';
  if(call.type==='custom_tool_call'){if(typeof call.input!=='string')invalid();args={literal:call.input};}
  else{
    if(typeof call.arguments!=='string')invalid();
    try{args=JSON.parse(call.arguments);}catch{args=call.arguments;argsKind='literal';}
    if(executionTool&&args!==null&&typeof args==='object'&&!Array.isArray(args)){const kept=Object.create(null);for(const key of Object.keys(args))if(!['yield_time_ms','max_output_tokens'].includes(key))kept[key]=args[key];args=kept;}
  }
  return hash(canonical([call.type,[namespace,name],[argsKind,args],normalizedOutput(output,executionTool)]));
}

export function createToolLoopGuard({enabled=true,repeatLimit=4,maxHistory=10000}={}){
  if(typeof enabled!=='boolean'||!Number.isSafeInteger(repeatLimit)||repeatLimit<2||repeatLimit>10||!Number.isSafeInteger(maxHistory)||maxHistory<1||maxHistory>10000)throw new Error('Tool-loop guard configuration or history limit is invalid.');
  let seeded=false,blocked=false;
  const seen=new Map(),recent=[];
  const repeated=()=>fail('TOOL_LOOP_REPEATED',`Stopped this task because the same tool actions and results repeated ${repeatLimit} times without progress. Change the task or settings, then explicitly continue.`);
  function remember(id,ignored){
    const key=hash(identity(id));
    if(!seen.has(key)){if(seen.size>=maxHistory)historyLimit();seen.set(key,{ignored,completed:false});}
    else if(ignored)seen.get(key).ignored=true;
    return key;
  }
  function observe(value){
    recent.push(value);if(recent.length>MAX_RECENT)recent.shift();
    for(let length=1;length<=3;length++){
      const needed=length*repeatLimit;if(recent.length<needed)continue;
      const start=recent.length-needed;let matches=true;
      for(let index=start+length;index<recent.length;index++)if(recent[index]!==recent[start+(index-start)%length]){matches=false;break;}
      if(matches){blocked=true;repeated();}
    }
  }
  return Object.freeze({
    inspect(input){
      if(!enabled)return;
      if(blocked)repeated();
      if(input===undefined||input===null||typeof input==='string'){if(typeof input==='string'&&Buffer.byteLength(input)>MAX_BYTES)historyLimit();seeded=true;return;}
      if(!Array.isArray(input))invalid();
      if(input.length>maxHistory)historyLimit();
      let serialized;try{serialized=JSON.stringify(input);}catch{invalid();}
      if(Buffer.byteLength(serialized)>MAX_BYTES)historyLimit();
      let lastUser=-1;for(let index=0;index<input.length;index++)if(input[index]?.role==='user'&&(!input[index].type||input[index].type==='message'))lastUser=index;
      const calls=new Map(),outputs=[];
      for(let index=0;index<input.length;index++){
        const item=input[index];if(!item||typeof item!=='object')continue;
        if(callTypes.has(item.type)){const id=remember(item.call_id,!seeded||index<lastUser);calls.set(id,{call:item,index});}
        else if(outputTypes.has(item.type)){const id=hash(identity(item.call_id));outputs.push({id,item,index});}
      }
      if(!seeded){seeded=true;return;}
      for(const {id,item,index} of outputs){
        const matched=calls.get(id),record=seen.get(id);
        if(!matched||!record||record.ignored||record.completed||index<=matched.index||matched.index<lastUser||!Object.hasOwn(item,'output')||item.type!==(matched.call.type==='function_call'?'function_call_output':'custom_tool_call_output'))continue;
        const value=signature(matched.call,item.output);record.completed=true;observe(value);
      }
    },
    reset(){seeded=false;blocked=false;seen.clear();recent.length=0;},
  });
}
