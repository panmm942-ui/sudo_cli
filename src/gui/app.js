const $=id=>document.getElementById(id);
const token=new URLSearchParams(location.hash.slice(1)).get('token')||'';
history.replaceState(null,'',location.pathname);
let snapshot={},activePrompt=null,draft='',draftLiteral=false,pastedLiteral=false,closed=false,pending=false,polling=false,returning=false,secretRevealed=false;
let chatKey='',eventKey='',changeKey='',performanceKey='',timer;
const text=value=>typeof value==='string'||typeof value==='number'?String(value):'Unknown';
const node=(tag,className,content)=>{const element=document.createElement(tag);if(className)element.className=className;if(content!==undefined)element.textContent=text(content);return element;};
const number=value=>Number.isFinite(value)&&value>=0;
const count=value=>number(value)?new Intl.NumberFormat(undefined,{maximumFractionDigits:1,notation:'compact'}).format(value):'Unknown';
const duration=value=>number(value)?value>=3600000?`${Math.floor(value/3600000)}h ${Math.floor(value/60000)%60}m`:value>=60000?`${Math.floor(value/60000)}m ${Math.floor(value/1000)%60}s`:`${Math.floor(value/1000)}s`:'Unknown';
const rate=value=>number(value)?value>=1048576?(value/1048576).toFixed(1)+' MB/s':value>=1024?(value/1024).toFixed(1)+' KB/s':Math.round(value)+' B/s':'Unknown';
function showBanner(message){$('banner').textContent=message;$('banner').hidden=!message;}
function time(value){const date=new Date(value);return Number.isFinite(date.getTime())?date.toLocaleTimeString([],{hour:'2-digit',minute:'2-digit'}):'';}
function replaceScroll(container,content){const atEnd=container.scrollHeight-container.scrollTop-container.clientHeight<48,position=container.scrollTop;container.replaceChildren(...content);container.scrollTop=atEnd?container.scrollHeight:position;}
async function request(path,body){
  const response=await fetch(path,{method:body?'POST':'GET',headers:{authorization:'Bearer '+token,...(body?{'content-type':'application/json'}:{})},body:body?JSON.stringify(body):undefined,cache:'no-store'});
  if(response.status===401||response.status===410){end('This local GUI session has ended. Continue in your terminal.');throw new Error('Session ended');}
  if(!response.ok)throw new Error(response.status===413?'This view exceeds its display limit. Inspect it in the terminal.':'The action is unavailable. Check the current question and session events.');
  return response.json();
}
function revealSecret(revealed=false){secretRevealed=!!revealed;$('secret-input').type=secretRevealed?'text':'password';$('reveal-secret').textContent=secretRevealed?'Hide':'Show';$('reveal-secret').ariaPressed=String(secretRevealed);}
function end(message){closed=true;clearTimeout(timer);$('secret-input').value='';revealSecret();showBanner(message);$('connection').textContent='GUI closed';$('connection-dot').classList.add('offline');$('footer-status').textContent='CONTINUE IN TERMINAL';$('command-dialog').close();updateControls();}
function updateControls(){
  for(const id of ['input','secret-input','reveal-secret','send','commands','model','stop','refresh-changes','return'])$(id).disabled=closed||pending||returning||(id==='commands'||id==='model')&&!!activePrompt;
  $('stop').disabled=closed||returning||!snapshot.session?.working;
}
function prompt(value){
  const next=value&&typeof value.id==='string'?value:null;
  if(next?.id!==activePrompt?.id){
    if(next&&!activePrompt){draft=$('input').value;draftLiteral=pastedLiteral;}
    $('secret-input').value='';$('input').value=next?'':draft;pastedLiteral=next?false:draftLiteral;
    revealSecret();
  }
  activePrompt=next;$('question').hidden=!next;$('question-text').textContent=next?text(next.prompt):'';$('question-privacy').textContent=next?.hidden?'Hidden answer: cleared from this view after sending.':'';
  $('input').hidden=!!next?.hidden;$('secret-input').hidden=!next?.hidden;$('reveal-secret').hidden=!next?.hidden;$('send-label').textContent=next?'Answer':'Send';
  const sequence=Number.isSafeInteger(snapshot.chat?.promptCount)?snapshot.chat.promptCount+1:null;
  $('composer-label').textContent=next?'Answer the current question':sequence?`${new Date().toLocaleTimeString([],{hour:'2-digit',minute:'2-digit'})} · ${String(sequence).padStart(2,'0')}@you >`:'Message your AI';
  $('input').placeholder=next?'Your answer…':'Ask, build, investigate…';updateControls();
}
function session(value={}){
  $('project').textContent=text(value.project||'Local session');$('chat-title').textContent=text(value.chatTitle||'One session. Two views.');$('conversation-name').textContent=text(value.chatTitle||'Chat');
  $('ai-name').textContent=text(value.connectedAI||'Not connected');$('model-name').textContent=text(value.configuredModel||'Model unavailable');$('connection').textContent=text(value.connectionState||'Unknown connection');$('connection-dot').classList.toggle('offline',!['connected','online','ready'].includes(String(value.connectionState).toLowerCase()));$('version').textContent=value.version?'v'+text(value.version):'';
  $('activity').textContent=value.working?'Working':text(value.activity||'Ready');$('activity').classList.toggle('busy',!!value.working);
  const context=value.context||{},health=value.health||{},worked=value.worked||{},network=value.network||{};
  const contextText=number(context.used)?count(context.used)+(number(context.limit)?' / '+count(context.limit):'')+(number(context.percent)?' · '+Math.round(context.percent)+'%':''):'Unknown';
  const healthParts=[...(value.healthPercent!==false&&number(health.percent)?[Math.round(health.percent)+'%']:[]),...(number(health.latencyMs)?[Math.round(health.latencyMs)+' ms']:[])];
  const healthText=health.pending?'Measuring':healthParts.join(' · ')||'Unknown';
  const fields=[['Permissions',value.permissions],['Scope',value.scope],['Web',typeof value.webAccess==='boolean'?(value.webAccess?'On':'Off'):undefined],['Effort',value.effort],['Context',contextText],['Health',healthText],['Worked',duration(worked.sessionMs)],['Total worked',duration(worked.totalMs)],['Network',network.wifi||'Unknown'],['Download',rate(network.downloadBps)],['Upload',rate(network.uploadBps)]];
  $('session-fields').replaceChildren(...fields.flatMap(([label,value])=>[node('dt','',label),node('dd','',value===undefined?'Unknown':value)]));
  const groups=Array.isArray(value.performance?.groups)?value.performance.groups:[],key=JSON.stringify(groups);
  if(key!==performanceKey){performanceKey=key;const content=groups.map(group=>{const section=node('section','performance-group');section.append(node('h3','',group.title));for(const field of Array.isArray(group.fields)?group.fields:[]){const row=node('div','performance-field'),strong=node('strong','',field.value);if(typeof field.code==='string')strong.dataset.code=field.code;row.append(node('span','',field.label),strong);section.append(row);}return section;});$('performance').replaceChildren(...(content.length?content:[node('p','empty','Measurements unavailable')]));}
}
function chat(value={}){
  const messages=Array.isArray(value.messages)?value.messages:[],key=JSON.stringify(value);if(key===chatKey)return;chatKey=key;
  const content=messages.map(message=>{const role=message.role==='user'?'user':'assistant',item=node('article','message '+role),meta=node('div','message-meta');meta.append(node('span','message-avatar',role==='user'?'Y':'S'),node('strong','',role==='user'?'You':message.model||'Assistant'));if(message.sequence)meta.append(node('span','message-status','#'+text(message.sequence)));meta.append(node('time','',time(message.timestamp)));if(message.status&&message.status!=='completed')meta.append(node('span','message-status',message.status));item.append(meta,node('div','message-content',message.content||''));return item;});
  if(value.truncated||value.dropped)content.unshift(node('p','truncation','Earlier messages are omitted from this bounded view. Full history remains in the session.'));
  if(!content.length){const welcome=node('div','welcome');welcome.append(node('h2','','Your session, in focus.'),node('p','','Send a prompt or open the command menu. Chat and permissions stay with your terminal.'));content.push(welcome);}replaceScroll($('chat'),content);
}
function events(value={}){
  const entries=Array.isArray(value.entries)?value.entries:Array.isArray(value)?value:[],key=JSON.stringify(value);if(key===eventKey)return;eventKey=key;$('event-count').textContent=String(entries.length);
  const content=entries.map(entry=>{const item=node('article','event '+(['error','approval'].includes(entry.kind)?entry.kind:'')),meta=node('div','event-meta');meta.append(node('span','',entry.kind||'Session'),node('time','',time(entry.timestamp)));item.append(meta,node('div','',entry.text||''));return item;});if(value.dropped)content.unshift(node('p','truncation',`${value.dropped} earlier events omitted`));replaceScroll($('events'),content.length?content:[node('p','empty','Session events will appear here')]);
}
function changes(value={}){
  const files=Array.isArray(value.files)?value.files:[],key=JSON.stringify(value);if(key===changeKey)return;changeKey=key;$('change-count').textContent=String(files.length);$('changes-note').textContent=value.partial?'Partial scan: '+text(value.reason||'some files could not be checked'):value.updatedAt?'Updated '+time(value.updatedAt)+' · read-only view':'Awaiting project scan';
  $('changes').replaceChildren(...(files.length?files.map(file=>{const button=node('button','change-file');button.type='button';button.title=text(file.path);button.append(node('span','change-status '+(['added','deleted'].includes(file.status)?file.status:''),file.status==='added'?'A':file.status==='deleted'?'D':file.status==='modified'?'M':file.status||'?'),node('span','change-path',file.path));button.addEventListener('click',()=>diff(file.path));return button;}):[node('p','empty',value.partial?'No changes found in the scanned files':'No changes reported')]));
}
async function diff(path){if(closed||returning)return;try{const response=await request('/api/action',{type:'changes',path});$('diff-title').textContent=path;$('diff-content').textContent=typeof response.result==='string'?response.result:text(response.result?.diff||response.result?.text||'Diff unavailable');$('diff').hidden=false;}catch(error){showBanner(error.message);}}
function render(value){snapshot=value&&typeof value==='object'?value:{};session(snapshot.session);chat(snapshot.chat);events(snapshot.events);changes(snapshot.changes);prompt(snapshot.currentPrompt);for(const [name,color]of [['--chat-bg',snapshot.theme?.bgcolor],['--chat-text',snapshot.theme?.bodyForeground||snapshot.theme?.effectiveTxtcolor],['--user-text',snapshot.theme?.effectiveTxtcolor]])if(/^#[a-f0-9]{6}$/i.test(color))document.documentElement.style.setProperty(name,color);}
async function poll(){if(closed||polling||returning)return;clearTimeout(timer);polling=true;try{render(await request('/api/state'));}catch(error){if(!closed)showBanner(error.message==='Session ended'?error.message:'Unable to reach the local session. Continue in the terminal if it has closed.');}finally{polling=false;if(!closed&&!returning)timer=setTimeout(poll,document.hidden?2500:1000);}}
function commands(query=''){
  const items=(Array.isArray(snapshot.commands)?snapshot.commands:[]).filter(command=>(text(command.name)+' '+text(command.description)).toLowerCase().includes(query.toLowerCase()));
  $('command-list').replaceChildren(...(items.length?items.map(command=>{const button=node('button','command-item');button.type='button';button.append(node('strong','',command.name+(command.usage?' '+text(command.usage):'')),node('span','',command.description));button.addEventListener('click',()=>{$('input').value=text(command.name)+(command.usage?' ':'');pastedLiteral=false;$('command-dialog').close();$('input').focus();});return button;}):[node('p','empty','No matching commands')]));
}
function openCommands(query=''){if(closed||activePrompt)return;$('command-search').value=query;commands(query);$('command-dialog').showModal();$('command-search').focus();}
$('commands').addEventListener('click',()=>openCommands());$('close-commands').addEventListener('click',()=>$('command-dialog').close());$('command-search').addEventListener('input',event=>commands(event.target.value));
$('model').addEventListener('click',()=>openCommands('/model'));
$('composer').addEventListener('submit',async event=>{
  event.preventDefault();if(closed||pending||returning)return;const field=activePrompt?.hidden?$('secret-input'):$('input'),value=field.value,question=activePrompt;
  if(!question&&!value.trim())return;if(new TextEncoder().encode(value).length>65536){showBanner('The message exceeds the 64 KiB input limit.');return;}
  pending=true;updateControls();showBanner('');if(question?.hidden){field.value='';revealSecret();}
  try{await request('/api/action',question?{type:'answer',promptId:question.id,text:value}:{type:'submit',text:value,...(pastedLiteral?{literal:true}:{})});if(!question||activePrompt?.id===question.id)field.value='';if(!question){draft='';pastedLiteral=false;}await poll();}catch(error){if(!closed)showBanner(error.message);}finally{pending=false;updateControls();}
});
for(const id of ['input','secret-input'])$(id).addEventListener('keydown',event=>{if(event.key==='Enter'&&(event.ctrlKey||event.metaKey)){event.preventDefault();$('composer').requestSubmit();}});
$('reveal-secret').addEventListener('click',()=>{if(closed||pending||returning||!activePrompt?.hidden)return;revealSecret(!secretRevealed);$('secret-input').focus();});
$('input').addEventListener('paste',()=>{if(!activePrompt)pastedLiteral=true;});$('input').addEventListener('input',()=>{if(!$('input').value)pastedLiteral=false;});
$('stop').addEventListener('click',async()=>{try{await request('/api/action',{type:'stop'});await poll();}catch(error){showBanner(error.message);}});
$('refresh-changes').addEventListener('click',async()=>{try{await request('/api/action',{type:'changes'});await poll();}catch(error){showBanner(error.message);}});
$('close-diff').addEventListener('click',()=>{$('diff').hidden=true;$('diff-content').textContent='';});
$('return').addEventListener('click',async()=>{if(closed||returning)return;returning=true;clearTimeout(timer);updateControls();try{await request('/api/action',{type:'return'});end('Returned to terminal. You can close this browser tab.');}catch(error){returning=false;if(!closed){showBanner(error.message);updateControls();timer=setTimeout(poll,1000);}}});
document.addEventListener('visibilitychange',()=>{if(!document.hidden&&!closed&&!returning){clearTimeout(timer);void poll();}});
if(/^[a-f0-9]{64}$/.test(token))void poll();else end('Open /gui in your terminal to create a fresh local GUI session.');
