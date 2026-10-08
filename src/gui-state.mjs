import {stripVTControlCharacters} from 'node:util';
import {createRedactor} from './redactor.mjs';

/** Explicit view model: raw connections, settings, device IDs and paths never cross HTTP. */
export function buildGuiSnapshot({session={},history={messages:[]},events={entries:[]},prompt,changes={files:[]},commands=[],theme={},secrets=()=>[]}={}) {
  const clean=(value,max=4096)=>{const filter=createRedactor({secrets});const text=stripVTControlCharacters(filter.write(String(value??''))+filter.flush()).replace(/[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/g,'');return Buffer.from(text).subarray(0,max).toString('utf8');};
  const numbers=(value={},names=[])=>Object.fromEntries(names.filter(name=>Number.isFinite(value?.[name])).map(name=>[name,value[name]]));
  const state={};
  for(const name of ['version','project','connectedAI','configuredModel','connectionState','permissions','scope','effort','chatTitle','activity'])if(session[name]!=null)state[name]=clean(session[name]);
  for(const name of ['working','webAccess','healthPercent'])state[name]=!!session[name];
  state.context=numbers(session.context,['used','limit','percent']);
  state.worked=numbers(session.worked,['sessionMs','totalMs']);
  state.health={...numbers(session.health,['percent','latencyMs','firstTokenLatencyMs','errorRate','generationTokensPerSecond']),pending:!!session.health?.pending};
  state.network={wifi:clean(session.network?.wifi||'Unknown',32),...numbers(session.network,['downloadBps','uploadBps'])};
  state.performance={groups:(session.performance?.groups||[]).slice(0,20).map(group=>({title:clean(group.title,256),fields:(group.fields||[]).slice(0,20).map(field=>({label:clean(field.label,128),value:clean(field.value,512)}))}))};
  let budget=600000,truncated=false;
  const all=history.messages||[],messages=[];
  for(const original of all.slice(-300).reverse()){
    if(!['user','assistant'].includes(original.role))continue;
    const content=clean(original.content,Math.min(100000,Math.max(0,budget))),bytes=Buffer.byteLength(content);
    if(bytes<Buffer.byteLength(String(original.content??'')))truncated=true;
    if(budget<=0){truncated=true;break;}budget-=bytes+512;
    const item={id:clean(original.id,128),role:original.role,model:original.model?clean(original.model,512):null,content};
    if(['streaming','completed','interrupted'].includes(original.status))item.status=original.status;
    if(Number.isSafeInteger(original.sequence)&&original.sequence>0)item.sequence=original.sequence;
    if(typeof original.timestamp==='string'&&Number.isFinite(Date.parse(original.timestamp)))item.timestamp=new Date(original.timestamp).toISOString();
    messages.unshift(item);
  }
  truncated||=messages.length<all.length;
  let eventBudget=240000;const eventEntries=[];
  for(const entry of (events.entries||[]).slice(-200).reverse()){
    if(eventBudget<=0)break;const text=clean(entry.text,Math.min(3000,eventBudget));eventBudget-=Buffer.byteLength(text)+256;
    eventEntries.unshift({id:clean(entry.id,128),timestamp:clean(entry.timestamp,32),kind:clean(entry.kind,32),text});
  }
  const view={session:state,chat:{version:1,promptCount:Number.isSafeInteger(history.promptCount)?history.promptCount:all.filter(message=>message.role==='user').length,messages,truncated},events:{entries:eventEntries,dropped:(events.dropped||0)+(events.entries?.length||0)-eventEntries.length},
    currentPrompt:prompt&&!prompt.input?{id:clean(prompt.id,128),prompt:clean(prompt.prompt),hidden:!!prompt.hidden,input:false}:null,
    changes:{files:[],partial:!!changes.partial,reason:clean(changes.reason||''),updatedAt:typeof changes.updatedAt==='string'?clean(changes.updatedAt,32):null},
    commands:commands.slice(0,512).filter(command=>/^\/[a-z0-9-]+(?:\.[a-z0-9-]+)*$/i.test(command.name)).map(command=>({name:command.name,usage:clean(command.usage,1024),description:clean(command.description,1024)})),theme:{}};
  for(const name of ['bgcolor','txtcolor','effectiveTxtcolor','bodyForeground'])if(/^#[0-9a-f]{6}$/i.test(theme[name]))view.theme[name]=theme[name];
  let fileBudget=400000;
  for(const file of (changes.files||[]).slice(0,2000)){
    const item={path:clean(file.path,4096),status:['added','modified','deleted'].includes(file.status)?file.status:'modified'};
    const bytes=Buffer.byteLength(JSON.stringify(item))+1;if(bytes>fileBudget)break;fileBudget-=bytes;view.changes.files.push(item);
  }
  if(view.changes.files.length<(changes.files?.length||0)){view.changes.partial=true;view.changes.reason=[view.changes.reason,'Display limit: more changed files were detected than this view can display.'].filter(Boolean).join(' ');}
  // JSON escaping can greatly expand otherwise bounded text. Keep the complete
  // HTTP view below the server ceiling and make every omitted collection clear.
  while(Buffer.byteLength(JSON.stringify(view))>1700000){
    if(view.chat.messages.length>1){view.chat.messages.shift();view.chat.truncated=true;}
    else if(view.events.entries.length){view.events.entries.shift();view.events.dropped++;}
    else if(view.changes.files.length){view.changes.files.pop();view.changes.partial=true;view.changes.reason='Display limit: more changed files were detected than this view can display.';}
    else if(view.commands.length){view.commands.pop();view.commandsTruncated=true;}
    else if(view.session.performance.groups.length){view.session.performance.groups.pop();view.session.performance.truncated=true;}
    else break;
  }
  return view;
}
