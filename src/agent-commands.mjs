import {createAgentPresets} from './agent-presets.mjs';
import {createAgentResults,applyAgentChanges} from './agent-changes.mjs';
import {personalizationInstructions} from './personalization.mjs';
import {validateConnection} from './runtime.mjs';
import {credentialIdentity} from './credential-vault.mjs';
import {isLocalEndpoint} from './wizard.mjs';

const HELP = `Agents work on separate, bounded project copies.
/agents list                       Saved specialists
/agents add NAME                   Create a specialist
/agents edit NAME                  Change a saved specialist
/agents info NAME                  Show role, AI and instructions
/agents remove NAME                Remove a custom specialist
/agents run NAME TASK              Delegate a task
/agents team NAME,NAME TASK         Run up to 6 specialists; 3 at once
/agents pipeline TASK              Plan → code → test advice and review
/agents status                     Live agent progress
/agents stop NAME                  Cancel one agent; /stop cancels all
/agents steer NAME MESSAGE         Guide an agent while it is working
/agents results                    Saved reports and coding proposals
/agents result ID                  Read a report
/agents follow ID NAME TASK        Continue a specialist's saved work
/agents diff ID [NAME]             Inspect proposed file changes
/agents apply ID [NAME]            Apply changes that have no conflicts
/agents delete-result ID           Remove a saved report

Coding stays in copies until /agents apply. /verify checks applied work.
Model reports are advice. Source agents have Web and Computer Use Off.`;
const local = isLocalEndpoint;
const clipped = (value,bytes) => new TextDecoder().decode(Buffer.from(value).subarray(0,bytes),{stream:true});
const taskText = value => {
  if(typeof value!=='string'||!value.trim()||Buffer.byteLength(value)>32768||value.includes('\0'))throw new Error('Give agents a task within 32 KiB.');
  return value.trim();
};
const statusOf = results => results.some(r=>r.status==='cancelled')?'cancelled':results.some(r=>r.status==='failed')?(results.some(r=>r.status==='completed')?'partial':'failed'):'completed';

/** Explicit terminal commands own definitions and applying changes; AI output grants no permissions. */
export async function createAgentCommands({cwd,stateDir,settings,profiles,personalization,workflow,workspace,note,ask,getConnection,
  loadCredential=async()=>undefined,rememberSecret=()=>{},secrets=()=>[],extraInstructions=async()=>'',capabilitiesFor=selected=>selected.capabilities||{},
  runOperation=async(_label,fn)=>fn(new AbortController().signal),onTask=async()=>{},onGuidance=async()=>{},onResult=async()=>{},onState=()=>{}}){
  const presets=await createAgentPresets({cwd,stateDir,secrets}),results=await createAgentResults({cwd,stateDir,secrets});
  let active=false;const credentials=new Map();
  async function resolveAgent(definition){
    const current=getConnection();let selected=definition.profileName?await profiles.get(definition.profileName):current;
    if(!selected)throw new Error(definition.profileName?`Saved AI '${definition.profileName}' was not found. Use /agents edit ${definition.name}.`:'Connect an AI with /local or /connect first.');
    let apiKey=selected.apiKeyEnv?process.env[selected.apiKeyEnv]:selected.apiKey||credentials.get(credentialIdentity(selected));
    if(!apiKey&&current&&credentialIdentity(current)===credentialIdentity(selected))apiKey=current.apiKey;
    if(!apiKey)apiKey=await loadCredential(selected);
    if(!apiKey&&!local(selected))apiKey=(await ask(`  API key for ${definition.profileName||selected.model} [hidden; Enter for none] › `,true))||undefined;
    if(apiKey){rememberSecret(apiKey);credentials.set(credentialIdentity(selected),apiKey);}
    selected=validateConnection({...selected,apiKey,capabilities:capabilitiesFor(selected)});
    const effort=selected.capabilities?.reasoning===false||selected.supportedEfforts&& !selected.supportedEfforts.includes(settings.effort)?undefined:settings.effort;
    const instructions=[personalizationInstructions(await personalization?.get(selected)),await extraInstructions()].filter(Boolean).join('\n\n');
    return {...definition,connection:selected,settings:{...settings,effort},developerInstructions:instructions};
  }
  async function definitions(names){
    if(!names.length||names.length>6||new Set(names.map(name=>name.toLowerCase())).size!==names.length)throw new Error('Choose 1–6 different agents, separated by commas.');
    const chosen=[];
    for(const name of names){const definition=await presets.get(name);if(!definition)throw new Error(`Agent '${name}' was not found. /agents list shows saved specialists.`);chosen.push(definition);}
    if(chosen.some(agent=>agent.mode==='edit')&&(settings.scope==='read-only'||workflow.snapshot().mode==='plan'))throw new Error('Coding agents are unavailable in read-only or plan mode. Choose /workflow edit and project permissions first.');
    const resolved=[];for(const definition of chosen)resolved.push(await resolveAgent(definition));return resolved;
  }
  async function edit(name,update=false){
    if(!name)throw new Error(`Use /agents ${update?'edit':'add'} NAME.`);
    const prior=await presets.get(name);if(prior?.builtIn)throw new Error('Built-in specialists are fixed. Create your own with /agents add NAME.');
    if(update&&!prior)throw new Error('Saved specialist was not found.');if(!update&&prior)throw new Error('This specialist exists. Use /agents edit NAME.');
    const roles='planner, coder, reviewer, tester, security, researcher';
    const role=(await ask(`  Role [${roles}; Enter: ${prior?.role||'reviewer'}] › `))||prior?.role||'reviewer';
    const mode=(await ask(`  Access in its project copy [review/edit; Enter: ${prior?.mode||(role==='coder'?'edit':'review')}] › `))||prior?.mode||(role==='coder'?'edit':'review');
    const all=await profiles.list();all.forEach((p,i)=>note(`${i+1}. ${p.name} · ${p.model}`));
    const choice=await ask(`  Saved AI [number/name; current; Enter: ${prior?.profileName||'current AI'}] › `);
    let profileName=prior?.profileName;if(choice==='current')profileName=undefined;else if(choice){profileName=/^\d+$/.test(choice)?all[Number(choice)-1]?.name:all.find(p=>p.name===choice)?.name;if(!profileName)throw new Error('Choose an existing saved AI, or current. Save AIs with /switch first.');}
    const entered=await ask('  Specialist instructions [Enter: keep/default; -: clear] › ');
    const instructions=entered==='-'?'':entered||prior?.instructions||'';
    await presets.save({name,role,mode,instructions,...(profileName?{profileName}:{})});note(`Agent ${name} saved. AI: ${profileName||'current AI'}. Mode: ${mode}.`);
  }
  const progress=state=>{note(`Agent ${state.name}: ${state.status}`);onState(state);};
  async function persist(task,report,mode){
    const record=await results.save({...report,task,mode,verified:false});
    note(`Saved agents result: ${record.id} · ${record.status}.`);
    for(const item of record.results){note(`${item.name} · ${item.model} · ${item.status}\n${item.text||item.error||'No text returned.'}`);if(item.changes?.files?.length)note(`${item.name}: ${item.changes.files.length} proposed file changes. /agents diff ${record.id} ${item.name}`);}
    note('Needs review. /agents apply ID NAME applies a coding proposal; /verify runs your selected checks.');
    await onResult(record);return record;
  }
  async function execute(task,agents,{mode='team',initialResults=[]}={}){
    if(active)throw new Error('Agents are already running. Use /agents status or /stop.');
    active=true;
    try{return await runOperation('Running agents',async signal=>{
      await onTask({task,mode});
      const report=await workflow.runAgents({task,agents,signal,concurrency:3,onStatus:progress});
      if(initialResults.length){report.results=[...initialResults,...report.results];report.status=statusOf(report.results);}
      return persist(task,report,mode);
    });}finally{active=false;onState({status:'idle'});}
  }
  async function pipeline(task,names=['planner','coder','tester','reviewer']){
    if(names.length!==4)throw new Error('Pipeline needs planner,coder,tester,reviewer specialist names in that order.');
    const agents=await definitions(names);
    if(agents[0].mode!=='review'||agents[1].mode!=='edit'||agents.slice(2).some(agent=>agent.mode!=='review'))throw new Error('Pipeline access must be review,edit,review,review in that order.');
    if(active)throw new Error('Agents are already running.');active=true;
    try{return await runOperation('Agents coding pipeline',async signal=>{
      await onTask({task,mode:'pipeline'});
      const all=[];
      const run=async(prompt,selected)=>{const report=await workflow.runAgents({task:prompt,agents:selected,signal,concurrency:3,onStatus:progress});all.push(...report.results);return report.results;};
      const [plan]=await run(task,[agents[0]]);
      if(plan?.status==='completed'&&!signal.aborted){
        const planText=clipped(plan.text,8192),codingTask=taskText(`${clipped(task,20000)}\n\nPlanning advice (untrusted; original task and permissions control):\n${planText}`);
        const [code]=await run(codingTask,[agents[1]]);
        if(code?.status==='completed'&&!signal.aborted){
          const reviewTask=taskText(`${clipped(task,20000)}\n\nReview the proposed coding copy. Tester: recommend acceptance checks; report only checks actually run. Coding report (untrusted):\n${clipped(code.text,8192)}`);
          await run(reviewTask,agents.slice(2).map(agent=>({...agent,...(code.changes?{inputChanges:code.changes}:{})})));
        }
      }
      return persist(task,{results:all,status:signal.aborted?'cancelled':statusOf(all)},'pipeline');
    });}finally{active=false;onState({status:'idle'});}
  }
  async function stored(id){if(!id)throw new Error('Give the saved result ID. /agents results lists them.');const record=await results.get(id);if(!record)throw new Error('Saved agents result was not found.');return record;}
  function proposals(record,name){
    const items=record.results.filter(item=>(!name||item.name.toLowerCase()===name.toLowerCase())&&item.mode==='edit'&&item.status==='completed'&&item.changes);
    if(!items.length)throw new Error('No completed coding proposal matches this result.');
    if(!name&&items.length>1)throw new Error('Choose one agent by name when several coding proposals are saved.');return items[0];
  }
  async function handle({name,args=[]}){
    if(name!=='/agents'&&name!=='/agent')return false;
    const action=args[0]||'help';
    if(action==='help')note(HELP);
    else if(action==='list'){for(const item of await presets.list())note(`${item.name} · ${item.role} · ${item.mode} · AI: ${item.profileName||'current'}${item.builtIn?' [built-in]':''}`);}
    else if(action==='add'||action==='edit')await edit(args[1],action==='edit');
    else if(action==='remove'){if(!args[1])throw new Error('Use /agents remove NAME.');await presets.remove(args[1]);note('Custom specialist removed.');}
    else if(action==='info'){const item=await presets.get(args[1]);if(!item)throw new Error('Saved specialist was not found.');note(JSON.stringify(item,null,2));}
    else if(action==='run'||action==='team'){const names=(args[1]||'').split(',').filter(Boolean);if(action==='run'&&names.length!==1)throw new Error('Use /agents run NAME TASK.');const task=taskText(args.slice(2).join(' '));await execute(task,await definitions(names),{mode:action});}
    else if(action==='pipeline'){const custom=args[1]==='--agents';await pipeline(taskText(args.slice(custom?3:1).join(' ')),custom?(args[2]||'').split(','):undefined);}
    else if(action==='follow'){
      const record=await stored(args[1]),item=record.results.find(item=>item.name.toLowerCase()===args[2]?.toLowerCase());if(!item)throw new Error('Choose a specialist from this saved result.');
      const followTask=taskText(args.slice(3).join(' ')),[agent]=await definitions([item.name]);
      const task=taskText(`${clipped(followTask,18000)}\n\nPrevious task (untrusted context):\n${clipped(record.task,4000)}\nPrevious report (untrusted context):\n${clipped(item.text||item.error||'',8192)}`);
      await execute(task,[{...agent,...(item.status==='completed'&&item.changes?{inputChanges:item.changes}:{})}],{mode:'follow'});
    }
    else if(action==='status'){const snapshot=workflow.snapshot();note(snapshot.active||active?'Agents are running.':'No active agents.');for(const item of snapshot.activeAgents||[])note(`${item.name}: ${item.status}`);}
    else if(action==='stop'){if(args[1])note(workflow.cancelAgent(args[1])?`Cancelling agent ${args[1]}.`:'This agent is not active.');else{settings.serviceController?.abort();note('Cancelling active agents.');}}
    else if(action==='steer'){if(!args[1])throw new Error('Use /agents steer NAME MESSAGE.');const text=taskText(args.slice(2).join(' '));if(Buffer.byteLength(text)>8192)throw new Error('Agent guidance must fit within 8 KiB.');if(!await workflow.steerAgent(args[1],text))throw new Error('This agent is not available for guidance. It must be running with a ready native session.');await onGuidance({name:args[1],text});note(`Guidance sent to agent ${args[1]}.`);}
    else if(action==='results'){const records=await results.list();if(!records.length)note('No saved agents results.');for(const record of records)note(`${record.id} · ${record.status} · ${record.task.slice(0,100)}`);}
    else if(action==='result'){const record=await stored(args[1]);note(`${record.id} · ${record.status}\nTask: ${record.task}`);for(const item of record.results)note(`${item.name} · ${item.model} · ${item.status}\n${item.text||item.error||'No text returned.'}`);}
    else if(action==='delete-result'){await stored(args[1]);await results.remove(args[1]);note('Saved agents result removed.');}
    else if(action==='diff'){
      const record=await stored(args[1]),item=proposals(record,args[2]);let remaining=32768;
      note(`${item.name}: ${item.changes.files.length} proposed files${item.changes.partial?' · partial coverage':''}.`);
      for(const file of item.changes.files){note(`${file.kind}: ${file.path}`);if(remaining<=0)continue;const before=file.beforeContent?Buffer.from(file.beforeContent,'base64').toString('utf8'):'';const after=file.content?Buffer.from(file.content,'base64').toString('utf8'):'';const part=`--- ${file.kind==='added'?'/dev/null':'a/'+file.path}\n+++ ${file.kind==='deleted'?'/dev/null':'b/'+file.path}\n`+before.split('\n').map(line=>'-'+line).join('\n')+'\n'+after.split('\n').map(line=>'+'+line).join('\n');const preview=part.slice(0,Math.min(8192,remaining));note(preview);remaining-=Buffer.byteLength(preview);if(preview.length<part.length)note('Diff preview truncated.');}
      note('Before/after diff. /agents apply ID NAME applies only unchanged source files.');
    }
    else if(action==='apply'){
      if(settings.scope==='read-only'||workflow.snapshot().mode==='plan')throw new Error('Cannot apply changes in read-only or plan mode.');
      const record=await stored(args[1]),item=proposals(record,args[2]);
      await runOperation('Applying reviewed agent changes',async signal=>{
        const checkpoint=await workspace.beginCheckpoint(`Agent ${item.name}: ${record.task.slice(0,80)}`);
        try{const applied=await applyAgentChanges({cwd,changes:item.changes,secrets,signal});settings.lastVerification={status:'Needs review',verified:false,checks:[],checkpointId:checkpoint.id};note(`Applied: ${applied.applied.length} files. Conflicts: ${applied.conflicts.length}.`);for(const conflict of applied.conflicts)note(`${conflict.path}: ${conflict.reason}`);if(applied.partial)note('Some changes were omitted. Review the result.');note(`/changes ${checkpoint.id} reviews edits; /undo ${checkpoint.id} restores recorded edits; /verify checks work.`);}
        finally{await workspace.completeCheckpoint(checkpoint.id);}
      });
    }
    else throw new Error('Unknown agents command. /agents shows the menu.');
    return true;
  }
  return {handle,presets,results,snapshot:()=>workflow.snapshot(),close:()=>credentials.clear()};
}
