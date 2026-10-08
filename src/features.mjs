import { promisify } from 'node:util';
import { execFile } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve, basename } from 'node:path';
import { commandMenu, parseMcpEntry } from './commands.mjs';
import { collectAttachments } from './attachments.mjs';
import { validateConnection, validateReasoningEffort, REASONING_EFFORTS } from './runtime.mjs';
import { workedTime, trafficRate } from './dashboard.mjs';
import { computerToolFilters, isComputerTool } from './computer-policy.mjs';
import {isLocalEndpoint} from './wizard.mjs';
const execute = promisify(execFile);

/** The interactive command layer; model keys and optional services stay in RAM. */
export function createFeatureCommands({cwd,settings,profiles,history,note,ask,getConnection,getEngine,reconnect,configure,loadCredential=async()=>undefined,runTurn,runCompact,getSnapshot,rememberSecret,stop}) {
  settings.attachments ??= []; settings.skills ??= []; settings.mcp ??= new Map();
  settings.computerServers ??= new Set(); settings.disabledComputerTools ??= new Map();
  const keys = new Map();
  const serviceModule = () => import('./external-services.mjs');
  const cacheKey = connection => `${connection.baseUrl}\0${connection.model}\0${connection.transport}`;
  const localEndpoint=isLocalEndpoint;
  function remember(connection) { if (connection.apiKey) { keys.set(cacheKey(connection),connection.apiKey); rememberSecret(connection.apiKey); } }
  async function activate(selected, carry = true) {
    if(!selected)return;
    const validated = validateConnection(selected);
    const supported = validated.supportedEfforts;
    if (settings.effort && supported && !supported.includes(settings.effort)) { settings.effort = undefined; note('Effort reset to provider default for this model.'); }
    await reconnect(validated,{carryHistory:carry}); remember(validated);
  }
  async function serviceSetup(label) {
    const {validateService}=await serviceModule();
    const baseUrl=await ask(`  ${label} API base URL › `);
    const model=await ask(`  ${label} model ID › `);
    const apiKey=(await ask(`  ${label} API key [hidden; Enter for none] › `,true)) || undefined;
    const service=validateService({baseUrl,model,apiKey});if(apiKey)rememberSecret(apiKey);return service;
  }
  async function addModel(local = false) {
    const selected=await configure(true,...(local?[{forceLocal:true}]:[]));
    if(local&&!localEndpoint(selected))throw new Error('Local AI must run on this computer.');
    const name=(await ask(`  Save AI as [Enter: ${selected.model.slice(0,100)}] › `))||selected.model.slice(0,100);
    const supportedText=await ask('  Supported effort levels [comma-separated if known; Enter for unknown] › ');
    if(supportedText)selected.supportedEfforts=supportedText.split(',').map(value=>value.trim()).filter(Boolean);
    await profiles.save({...selected,name});remember(selected);await activate(selected);
    note(`Saved AI: ${name}. API keys are not stored.`);
  }
  async function chooseProfile(name,{localOnly=false}={}) {
    const all=await profiles.list();
    if(!name) {
      all.forEach((profile,index)=>note(`${index+1}. ${profile.name} · ${profile.model} · ${new URL(profile.baseUrl).host}`));
      note('add — new cloud/custom AI · local — AI running on this computer');
      name=await ask('  Choose saved AI [number/name/add/local; Enter cancels] › ');
      if(!name)return;
      if(/^\d+$/.test(name))name=all[Number(name)-1]?.name || name;
    }
    if(name==='add'||name==='local')return addModel(name==='local');
    const profile=await profiles.get(name);if(!profile)throw new Error('Saved AI not found. Use /switch add or /switch local.');
    if(localOnly&&!localEndpoint(profile))throw new Error('This saved AI is remote. /local selects an AI on this computer.');
    let apiKey=profile.apiKeyEnv ? process.env[profile.apiKeyEnv] : keys.get(cacheKey(profile));
    if(!apiKey)apiKey=await loadCredential(profile);
    if(!apiKey&&!localEndpoint(profile))apiKey=(await ask('  Cloud API key [hidden; Enter for none] › ',true)) || undefined;
    await activate({...profile,apiKey});note(`Connected configuration: ${profile.name}. API health is confirmed by its next response.`);
  }
  async function endpointModels() {
    const connection=getConnection();
    const response=await fetch(connection.baseUrl.replace(/\/$/,'')+'/models',{headers:connection.apiKey?{authorization:`Bearer ${connection.apiKey}`}:{},redirect:'error',signal:AbortSignal.timeout(15000)}).catch(()=>{throw new Error('Could not read this endpoint model list; enter an exact model ID with /model ID.');});
    if(!response.ok){await response.body?.cancel();throw new Error(`This endpoint model list returned HTTP${response.status}; enter /model ID directly.`);}
    let size=0;const chunks=[];for await(const chunk of response.body){size+=chunk.length;if(size>1024*1024){await response.body?.cancel().catch(()=>{});throw new Error('Model catalog exceeds its limit.');}chunks.push(chunk);}
    let data;try{data=JSON.parse(Buffer.concat(chunks).toString('utf8'));}catch{throw new Error('The endpoint returned an invalid model catalog.');}
    if(!Array.isArray(data.data))throw new Error('The endpoint returned an unsupported model catalog.');
    data.data.slice(0,200).forEach(item=>{if(typeof item.id==='string')note(item.id);});
    if(!data.data.length)note('The endpoint reports no models.');
  }
  function prepareTurn(text, {consume = true,agentReplayIncluded=false} = {}) {
    const queued=settings.attachments;
    const input=[];
    if(settings.pendingContext)input.push({type:'text',text:settings.pendingContext,text_elements:[]});
    if(settings.pendingAgentContext&&!agentReplayIncluded)input.push({type:'text',text:settings.pendingAgentContext,text_elements:[]});
    input.push({type:'text',text,text_elements:[]});
    for(const batch of queued)input.push(...batch.inputItems);
    input.push(...settings.skills);
    if(consume){settings.pendingContext='';settings.pendingAgentContext='';settings.attachments=[];settings.skills=[];}
    return input;
  }
  async function skills(args) {
    if(args[0]==='clear'){settings.skills=[];note('Queued skills cleared.');return;}
    const result=await getEngine().listSkills({cwd,forceReload:true});
    const available=result.data.flatMap(entry=>entry.skills || []);
    for(const entry of result.data)for(const error of entry.errors||[])note(`Skill load error: ${error.message||'invalid skill'}`);
    if(args[0]==='load'){
      const name=args.slice(1).join(' ');const selected=available.find(skill=>skill.name===name&&skill.enabled!==false);
      if(!selected)throw new Error('Enabled skill not found; use /skills list.');
      settings.skills.push({type:'skill',name:selected.name,path:selected.path});note(`Skill ${selected.name} attached to your next prompt.`);
    }else{
      if(!available.length)note('No skills found. Put SKILL.md under .agents/skills/NAME/ in this project, then /skills list.');
      for(const skill of available)note(`${skill.name}${skill.enabled===false?' [disabled]':''} · ${skill.description||''} · ${skill.path}`);
      for(const path of getEngine().instructionSources || [])note(`Loaded instructions: ${path}`);
    }
  }
  async function mcp(args) {
    if(!args.length||args[0]==='list'){
      if(!settings.mcp.size)note('No HTTP MCP servers configured. Use /mcp add NAME URL.');
      for(const[name,url]of settings.mcp)note(`${name} · ${url} · ${!settings.webAccess?'disabled by Web Off':settings.computerUse===false && (settings.computerServers.has(name)||!settings.disabledComputerTools.has(name))?'disabled by Computer Off':'enabled'}`);
      if(settings.webAccess){const result=await getEngine().listMcpServers();for(const server of result.data)note(`${server.name} · ${JSON.stringify(server.runtimeStatus||server.authStatus||'status available')}`);}
    }else if(args[0]==='tools'){
      if(!settings.webAccess)throw new Error('Use /web on to enable HTTP MCP tools.');
      const tools=await getEngine().listMcpTools();for(const tool of tools)note(`${tool.serverName}/${tool.name} · ${tool.tool?.description||''}`);if(!tools.length)note('No connected MCP tools are available.');
    }else if(args[0]==='add'){
      const{name,url}=parseMcpEntry(`${args[1]}=${args[2]}`);settings.mcp.set(name,url);settings.disabledComputerTools.delete(name);await activate(getConnection());note(`MCP server ${name} configured${!settings.webAccess?' (enable with /web on)':settings.computerUse===false?' (new server disabled until /computer-use on)':''}.`);
    }else if(args[0]==='remove'){
      if(!settings.mcp.delete(args[1]))throw new Error('MCP server name not found.');settings.computerServers.delete(args[1]);settings.disabledComputerTools.delete(args[1]);await activate(getConnection());note('MCP server removed.');
    }else throw new Error('Use /mcp list,tools,add NAME URL,or remove NAME.');
  }
  async function computer(args) {
    if(args[0]==='setup'){
      const{name}=parseMcpEntry(`${args[1]}=${args[2]}`);settings.computerServers.add(name);
      return mcp(['add',...args.slice(1)]);
    }
    if(args[0]==='on'||args[0]==='off'){
      if(args[0]==='off' && settings.computerUse!==false){
        settings.disabledComputerTools=new Map();
        if(settings.webAccess)try{settings.disabledComputerTools=computerToolFilters(await getEngine().listMcpTools(),settings.mcp.keys());}catch{note('MCP discovery unavailable; all unclassified servers will be disabled.');}
      }
      settings.computerUse=args[0]==='on';await activate(getConnection());
      note(`Computer MCP tools ${settings.computerUse?'permitted':'disabled'} for this session. This controls MCP tools; /permissions controls terminal commands.`);return;
    }
    if(!settings.webAccess){note('Computer tools require your HTTP MCP server and /web on.');return;}
    const tools=(await getEngine().listMcpTools()).filter(isComputerTool);
    for(const tool of tools)note(`${tool.serverName}/${tool.name}`);
    if(!tools.length)note('No computer-use tools detected. /computer-use setup NAME URL connects your running browser/desktop MCP service.');
    note(`Computer tool policy: ${settings.computerUse===false?'disabled':'permitted'}. Model vision/tool support and the MCP service determine capability.`);
  }
  async function voice(args) {
    if(args[0]==='setup'){settings.voiceService=await serviceSetup('Transcription');note('Transcription service configured for this session.');return;}
    if(args[0]==='off'){settings.voiceService=undefined;settings.microphone=false;note('Voice and microphone disabled.');return;}
    if(!args.length||args[0]==='status'){note(`Transcription: ${settings.voiceService?'configured':'use /voice setup'} · Microphone: ${settings.microphone?'armed':'Off'} · Recording requires FFmpeg and an input device.`);return;}
    if(!settings.voiceService)throw new Error('Configure a compatible transcription service with /voice setup.');
    const service=await serviceModule();let path,directory;
    const controller=new AbortController();settings.serviceController=controller;
    try{
      if(args[0]==='record'){
        if(!settings.microphone)throw new Error('Enable explicit recording with /microphone on first.');
        directory=await mkdtemp(join(tmpdir(),'sudocli-voice-'));path=join(directory,'prompt.wav');
        note(`Recording microphone for ${args[1]||10} seconds… Ctrl+C cancels.`);
        await service.captureMicrophone({path,seconds:Number(args[1]||10),device:settings.microphoneDevice,signal:controller.signal});
      }else if(args[0]==='file'){if(!args[1])throw new Error('Use /voice file PATH.');path=resolve(cwd,args[1]);}
      else throw new Error('Use /voice setup,status,record SECONDS,file PATH,or off.');
      const text=await service.transcribeAudio({connection:settings.voiceService,path,signal:controller.signal});note(`Transcript: ${text}`);
      settings.serviceController=undefined;
      if(/^y(es)?$/i.test(await ask('  Send this transcript as your prompt? [y/N] › ')))await runTurn(text);
    }finally{if(settings.serviceController===controller)settings.serviceController=undefined;if(directory)await rm(directory,{recursive:true,force:true}).catch(()=>{});}
  }
  async function training(args) {
    const service=await serviceModule();
    if(args[0]==='export'){
      const result=await service.createTrainingDataset({messages:history.snapshot().messages,cwd,directory:args[1]?resolve(cwd,args[1]):undefined});note(`Training dataset: ${result.path} · ${result.examples} examples. Review it before training.`);return;
    }
    if(args[0]==='setup'){settings.trainingService=await serviceSetup('Fine-tuning');note('Compatible fine-tuning service configured for this session.');return;}
    if(!args.length){note('/training export builds a reviewed JSONL dataset. /training setup connects a service supporting Files and Fine-tuning APIs. Training depends on provider/model support; local GPU training can be supplied by a training MCP server.');return;}
    const connection=settings.trainingService;if(!connection)throw new Error('Use /training setup with a compatible service first.');
    if(args[0]==='start'){
      if(!args[1])throw new Error('Use /training start DATASET.jsonl.');
      note(`Training model ${connection.model} at ${new URL(connection.baseUrl).host} can incur provider charges.`);
      if(!/^y(es)?$/i.test(await ask('  Upload the dataset and start this training job? [y/N] › ')))return note('Training was not started.');
      const controller=new AbortController();settings.serviceController=controller;
      try{const file=await service.uploadTrainingFile({connection,path:resolve(cwd,args[1]),signal:controller.signal});const job=await service.startTrainingJob({connection,trainingFileId:file.id,model:connection.model,signal:controller.signal});note(`Training job: ${job.id} · ${job.status||'submitted'}`);}
      finally{if(settings.serviceController===controller)settings.serviceController=undefined;}
    }else if(args[0]==='status'){const job=await service.getTrainingJob({connection,id:args[1]});note(`Training job: ${job.id} · ${job.status} · model ${job.fine_tuned_model||'pending'}`);}
    else if(args[0]==='cancel'){if(/^y(es)?$/i.test(await ask('  Cancel this provider training job? [y/N] › '))){const job=await service.cancelTrainingJob({connection,id:args[1]});note(`Training job: ${job.id} · ${job.status}`);}}
    else throw new Error('Use /training export,setup,start FILE,status ID,or cancel ID.');
  }
  async function handle({name,args=[],rawArgs=args.join(' ')}) {
    if(['/model','/effort','/upload','/skills','/compact'].includes(name)&&!getConnection())throw new Error('Connect an AI with /switch or /connect first.');
    if(name==='/effort'&&args[0]&&!['default','supported'].includes(args[0])&&settings.capabilities?.reasoning===false)throw new Error('Reasoning overrides are disabled for this AI. Use /effort default.');
    if(name==='/training'&&args[0]==='start'&&settings.capabilities?.training===false&&settings.trainingService?.model===getConnection()?.model&&settings.trainingService?.baseUrl===getConnection()?.baseUrl)throw new Error('Training is disabled for this AI. Select a supported training service first.');
    if(name==='/help'){note(commandMenu(rawArgs));return true;}
    if(name==='/status'){
      const current=getSnapshot();const connection=getConnection();note(connection?`${connection.model} · ${new URL(connection.baseUrl).host} · ${connection.transport}`:'No AI selected. /switch or /connect configures one.');
      note(`Status: ${current.working?'Working':'Not Working'} · WiFi Connection: ${current.network?.wifi||'Unknown'}`);
      if(current.network?.wifi==='Yes')note(`Live Traffic: Download ${trafficRate(current.network.downloadBps)} · Upload ${trafficRate(current.network.uploadBps)} (interface traffic, not a speed test)`);
      note(`AI response: ${current.health?.firstTokenLatencyMs==null?'not measured':(current.health.firstTokenLatencyMs/1000).toFixed(2)+'s'} · Errors: ${current.health?.errorRate==null?'not measured':Math.round(current.health.errorRate*100)+'%'} · Speed: ${current.health?.generationTokensPerSecond==null?'not reported':current.health.generationTokensPerSecond.toFixed(1)+' tokens/s'}`);
      note(`Context: ${current.context?.used??'unknown'}/${current.context?.limit??'unknown'} tokens (last reported)`);
      note(`Permissions: ${settings.permissions==='ask'?'Ask':'Allow Everything'} · Web Access: ${settings.webAccess?'On':'Off'} · Effort: ${settings.effort||'Provider default'}`);
      note(`Worked: ${workedTime(current.worked?.sessionMs)} | In Total: ${workedTime(current.worked?.totalMs)}`);return true;
    }
    if(name==='/switch'){
      if(args[0]==='save'){const profileName=args.slice(1).join(' ')||await ask('  Save current AI as › ');await profiles.save({...getConnection(),name:profileName});remember(getConnection());note(`Saved AI: ${profileName}; API key not stored.`);}
      else if(args[0]==='remove'){note(await profiles.remove(args.slice(1).join(' '))?'Saved AI removed.':'Saved AI not found.');}
      else await chooseProfile(args.join(' '));return true;
    }
    if(name==='/model'){
      if(args[0]==='list')await endpointModels();else if(args.length)await activate({...getConnection(),model:args.join(' '),supportedEfforts:undefined,capabilities:undefined,contextWindow:undefined});else note(`Model: ${getConnection().model}; /model list queries this endpoint.`);return true;
    }
    if(name==='/local'){if(args.length&&args[0]!=='add')await chooseProfile(args.join(' '),{localOnly:true});else await addModel(true);return true;}
    if(name==='/connect'){await activate(await configure(true,...(args[0]==='local'?[{forceLocal:true}]:[])));return true;}
    if(name==='/effort'){
      if(args[0]==='supported'){const levels=args.slice(1).join(',').split(',').map(value=>value.trim()).filter(Boolean);const selected=validateConnection({...getConnection(),supportedEfforts:levels});await activate(selected);note(`Declared supported effort: ${levels.join(', ')||'none'}. /switch save NAME persists this metadata.`);}
      else if(args.length){const chosen=args[0];settings.effort=validateReasoningEffort(chosen==='default'?undefined:chosen,{supportedEfforts:getConnection().supportedEfforts});if(chosen==='default')await activate(getConnection());note(`Effort: ${settings.effort||'Provider default'}.`);}
      else{note(`Effort: ${settings.effort||'Provider default'}`);note(getConnection().supportedEfforts?`Model-declared levels: ${getConnection().supportedEfforts.join(', ')}`:`Support is unknown for this endpoint. Standard request values: ${REASONING_EFFORTS.join(', ')}. The provider may reject unsupported levels; Default sends no override.`);}return true;
    }
    if(name==='/web'||name==='/permissions'){
      if(!args.length){note(name==='/web'?`Web Access: ${settings.webAccess?'On':'Off'}`:`Permissions: ${settings.permissions}`);return true;}
      if(name==='/web'){if(!['on','off'].includes(args[0]))throw new Error('Use /web on or off.');settings.webAccess=args[0]==='on';}
      else{const mode=args.join('-').toLowerCase();if(!['ask','allow-everything'].includes(mode))throw new Error('Use /permissions ask or allow-everything; /permissions scope read-only|project|full sets the boundary.');settings.permissions=mode;}
      await activate(getConnection());return true;
    }
    if(name==='/upload'){
      const result=await collectAttachments(args,{cwd});const total=settings.attachments.reduce((sum,batch)=>sum+batch.totalBytes,0);
      if(total+result.totalBytes>2*1024*1024)throw new Error('Queued attachments exceed2MiB. Use /attachments clear or send the current queue first.');
      if(settings.attachments.reduce((sum,batch)=>sum+batch.files.length,0)+result.files.length>100)throw new Error('Queued attachments exceed 100 files. Send the current queue or use /attachments clear.');
      if(result.files.length)settings.attachments.push(result);note(result.summary);for(const warning of result.warnings)note(`${warning.path}: ${warning.reason}`);return true;
    }
    if(name==='/attachments'){if(args[0]==='clear'){settings.attachments=[];note('Queued attachments cleared.');}else{for(const batch of settings.attachments)for(const file of batch.files)note(`${file.path} · ${file.bytes} bytes`);if(!settings.attachments.length)note('No queued attachments. /upload FILE_OR_FOLDER queues context for your next prompt.');}return true;}
    if(name==='/handoff'){const exported=await history.exportHandoff({cwd,directory:args[0]?resolve(cwd,args[0]):undefined});note(`Whole-chat handoff: ${exported.markdownPath}`);note(`JSON: ${exported.jsonPath} · ${exported.messageCount} messages`);return true;}
    if(name==='/history'){if(args[0]==='clear'){history.clear();settings.pendingContext='';settings.pendingAgentContext='';note('In-memory export history cleared; already exported files remain.');}else for(const message of history.snapshot().messages)note(`${message.role}${message.model?' ('+message.model+')':''}: ${message.content}`);return true;}
    if(name==='/compact'){await runCompact();return true;}
    if(name==='/clear'){await activate(getConnection(),false);settings.pendingContext='';settings.pendingAgentContext='';note('Fresh model context. Full-session history remains available to /handoff.');return true;}
    if(name==='/mcp'){await mcp(args);return true;}
    if(name==='/computer-use'){await computer(args);return true;}
    if(name==='/skills'){await skills(args);return true;}
    if(name==='/ide'){const{openIDE}=await serviceModule();await openIDE({cwd,editor:args[0]||'code'});note('Project opened in the installed editor. sudocli continues in this terminal.');return true;}
    if(name==='/microphone'){
      if(args[0]==='devices'){const {listMicrophoneDevices}=await import('./voice-devices.mjs');note(await listMicrophoneDevices());return true;}
      if(args[0]==='on'||args[0]==='off'){settings.microphone=args[0]==='on';note(`Microphone ${settings.microphone?'armed; recording starts only with /voice record':'Off'}.`);}
      else if(args[0]==='device'){settings.microphoneDevice=args.slice(1).join(' ');if(!settings.microphoneDevice)throw new Error('Use /microphone device DEVICE_NAME.');note(`Microphone device: ${settings.microphoneDevice}`);}
      else note(`Microphone: ${settings.microphone?'armed':'Off'} · Device: ${settings.microphoneDevice||'system default (Windows requires an exact device name)'}`);return true;
    }
    if(name==='/voice'){await voice(args);return true;}
    if(name==='/training'){await training(args);return true;}
    if(name==='/review'){await runTurn(`Review the current workspace changes. Identify concrete bugs, security issues and regressions with file references. ${rawArgs}`);return true;}
    if(name==='/diff'){try{const result=await execute('git',['diff','--no-ext-diff','--no-color'],{cwd,windowsHide:true,maxBuffer:1024*1024});note(result.stdout||'No tracked working-tree diff.');}catch{throw new Error('Git diff is unavailable; ensure Git is installed and this project is a repository.');}return true;}
    if(name==='/doctor'){note(`Engine: ${getEngine()?'connected native app-server · '+getEngine().runtimePolicy?.sandbox?.type:'offline; use sudocli doctor for executable diagnostics'}`);note(`WiFi monitor: ${getSnapshot().network?.source||'unavailable'} · Voice: ${settings.voiceService?'configured':'needs /voice setup'} · Training: ${settings.trainingService?'configured':'needs /training setup'}`);return true;}
    if(name==='/stop'){stop();return true;}
    if(name==='/steer'){note('Use /steer MESSAGE while the AI is working. At this prompt, enter a new task normally.');return true;}
    return false;
  }
  return {handle,prepareTurn,chooseProfile,remember,async hasSavedProfiles(){return (await profiles.list()).length>0;}};
}
