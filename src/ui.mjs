import { createInterface } from 'node:readline/promises';
import { Writable } from 'node:stream';
import { stripVTControlCharacters } from 'node:util';
import { stat } from 'node:fs/promises';
import { resolve } from 'node:path';
import { createEngine } from './engine.mjs';
import { startBridge } from './bridge.mjs';
import { validateConnection, providerArgs, createSessionHome } from './runtime.mjs';
import { localCodex } from './local-engine.mjs';
import { createPromptQueue } from './prompts.mjs';
import { configureConnection } from './wizard.mjs';
import { createRedactor } from './redactor.mjs';
import { createDashboard } from './dashboard.mjs';
import { createSessionState } from './session-state.mjs';
import { createConnectionHealth } from './connection-health.mjs';
import { createWorkMeter } from './work-meter.mjs';
import { startResponsesMonitor } from './responses-monitor.mjs';
import { workedTime } from './dashboard.mjs';
import { createModelProfiles } from './model-profiles.mjs';
import { createChatHistory } from './chat-history.mjs';
import { createNetworkStatus } from './network-status.mjs';
import { createFeatureCommands } from './features.mjs';
import { completeCommand, parseCommand, parseMcpEntry } from './commands.mjs';
import { BACKGROUND_STYLE } from './antenna.mjs';
import { enabledMcpEntries } from './computer-policy.mjs';
import {requireElevated} from './privileges.mjs';
import {createChatStore} from './chat-store.mjs';
import {createChatSession} from './chat-session.mjs';
import {createPersonalization,personalizationInstructions} from './personalization.mjs';
import {createAssistantFeatures} from './assistant-features.mjs';
import {randomUUID} from 'node:crypto';

export async function runUI(opts) {
  const once = opts.once !== undefined;
  const interactive = !!process.stdin.isTTY && !once;
  const color = process.stdout.isTTY && !process.env.NO_COLOR && process.env.TERM !== 'dumb';
  const paint = (code, text) => color ? `\x1b[${code}m${text}\x1b[0m${BACKGROUND_STYLE}` : text;
  const cyan = (s) => paint('96', s);
  const dim = (s) => paint('90', s);
  let secrets = [];
  const assistantOutput = createRedactor({ secrets: () => secrets });
  const safe = (value) => {
    let text = stripVTControlCharacters(String(value ?? '')).replace(/[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/g, '');
    for (const key of secrets) if (key) text = text.split(key).join('[redacted]');
    return text;
  };
  let dashboard;
  const write = text => dashboard ? dashboard.write(text) : process.stdout.write(text);
  const note = (text) => {
    const message = `${dim('  ·')} ${safe(text)}\n`;
    if (once) process.stderr.write(message); else write(message);
  };
  const cwd = resolve(opts.cwd || process.cwd());
  if (!(await stat(cwd).catch(() => null))?.isDirectory()) throw new Error('Project directory does not exist. Choose a directory with --cwd.');
  const initialConnection=!interactive?await configureConnection({opts,interactive:false,ask:async()=>{throw new Error('Provide --model and --base-url, or launch sudocli in an interactive terminal.');}}):undefined;
  await requireElevated();
  const session = createSessionState({ cwd });
  const settings = { permissions: opts.permissions || 'ask', webAccess: opts.web === 'on', effort: opts.effort, mcp: new Map(), attachments: [], skills: [], computerUse: true };
  for (const entry of opts.mcp || []) { const {name,url}=parseMcpEntry(entry); if(settings.mcp.has(name))throw new Error('Duplicate MCP server name.');settings.mcp.set(name,url); }
  let health = createConnectionHealth(), workMeter, profiles, features,assistantFeatures,chatSession,personalization,saveTimer,backgroundWorking=false;
  const history = createChatHistory({secrets:()=>secrets});
  const network = createNetworkStatus();
  const snapshot = () => ({ ...session.snapshot(),working:session.snapshot().working||backgroundWorking, permissions: settings.permissions, webAccess: settings.webAccess, effort: settings.effort, health: health.snapshot(), worked: workMeter?.snapshot(), network: network.snapshot(),...assistantFeatures?.snapshot(),chatTitle:chatSession?.current()?.title });
  let activity = 'Configure connection', currentPrompt = null;

  let muted = false;
  const output = new Writable({ write(chunk, encoding, done) { if (!muted) process.stdout.write(chunk, encoding); done(); } });
  output.isTTY = process.stdout.isTTY;
  Object.defineProperty(output, 'columns', { get: () => process.stdout.columns });
  const rl = interactive ? createInterface({ input: process.stdin, output, terminal: true, completer: completeCommand }) : null;
  const prompts = createPromptQueue({ question: async (prompt, { signal, hidden, input }) => {
    if (!rl) throw new Error('Provide --model and --base-url, or launch sudocli in an interactive terminal.');
    if(input&&queuedInputs.length)throw new DOMException('A queued task is ready.','AbortError');
    currentPrompt = { prompt, hidden, input };
    if (hidden) { process.stdout.write(prompt); muted = true; }
    try { return (await rl.question(hidden ? '' : prompt, { signal })).trim(); }
    finally { if (hidden) { muted = false; process.stdout.write('\n'); } currentPrompt = null; }
  } });
  const ask = (prompt, hidden = false, metadata) => prompts.ask(cyan(prompt), hidden, metadata);

  let engine, bridge, home, connection, busy = false, quitting = false, hasText = false;
  const queuedInputs = [];
  let saving=0;
  const checkpoint=()=>{if(!chatSession)return Promise.resolve();saving++;return chatSession.checkpoint().catch(()=>note('Chat could not be saved. Existing saved data was preserved.')).finally(()=>saving--);};
  const enqueue=(text,options={})=>{if(quitting)return;queuedInputs.push({text,recorded:false,...options});void checkpoint();if(currentPrompt?.input)prompts.cancel();};
  const displayed = new Set();
  if (interactive) dashboard = createDashboard({ snapshot, activity: () => activity, color,
    onResize: () => {
      if (!rl) return;
      if (!currentPrompt) { if(busy && rl.line)rl.prompt(true);return; }
      if (currentPrompt.hidden) process.stdout.write(currentPrompt.prompt);
      else rl.prompt(true);
    },
  });
  const metrics = ({ phase, id, latencyMs }) => {
    if (phase === 'started') health.requestStarted(id);
    else if (phase === 'responding') { health.requestResponding(id, { latencyMs }); session.markOnline(); activity = 'Receiving AI response'; }
    else if (phase === 'succeeded') { health.requestSucceeded(id, { latencyMs }); session.markOnline(); }
    else if (phase === 'failed') health.requestFailed(id);
    else if (phase === 'cancelled') health.requestCancelled(id);
    dashboard?.refresh();
  };

  const configure = async (refresh = false) => {
    const selected = await configureConnection({ opts, interactive, ask, refresh, report: note });
    if(selected.apiKey && !secrets.includes(selected.apiKey))secrets.push(selected.apiKey);
    return selected;
  };

  const event = ({ method, params = {} }) => {
    session.applyEvent({ method, params });
    dashboard?.refresh();
    if (method === 'item/agentMessage/delta') {
      history.appendAssistant(`${params.threadId || engine?.threadId}:${params.itemId}`,String(params.delta || ''),{model:connection?.model});
      if (!hasText && !once) write(`\n${cyan('  sudo')}\n`);
      hasText = true;
      displayed.add(params.itemId);
      write(assistantOutput.write(params.delta));
    } else if (method === 'item/completed' && params.item?.type === 'agentMessage') {
      history.finishAssistant(`${params.threadId || engine?.threadId}:${params.item.id}`,params.item.text,{model:connection?.model});
      if (!displayed.has(params.item.id)) {
        if (!hasText && !once) write(`\n${cyan('  sudo')}\n`);
        hasText = true;
        displayed.add(params.item.id);
        write(assistantOutput.write(params.item.text));
      }
      write(assistantOutput.flush() + '\n');
    } else if (method === 'item/started') {
      const item = params.item || {};
      activity = ({ commandExecution: 'Running command', fileChange: 'Editing files', mcpToolCall: 'Using a tool', contextCompaction: 'Compacting context' })[item.type] || activity;
      dashboard?.refresh();
      if (item.type === 'commandExecution') note(`Running: ${item.command || 'terminal command'}`);
      else if (item.type === 'fileChange') note(`Editing: ${item.changes?.map(change => change.path).join(', ') || 'workspace files'}`);
      else if (item.type === 'mcpToolCall') note(`Tool: ${item.server || ''}/${item.tool || ''}`);
      else if (item.type === 'contextCompaction') note('Condensing conversation context');
    } else if (method === 'error') note(params.error?.message || 'The model reported an error.');
  };

  const cleanup = async () => {
    await engine?.close().catch(() => {}); engine = undefined;
    await bridge?.close().catch(() => {}); bridge = undefined;
    await home?.cleanup().catch(() => {}); home = undefined;
  };

  const connect = async (selected, {carryHistory = false} = {}) => {
    const transfer = carryHistory && history.snapshot().messages.length ? history.toPrompt() : '';
    await cleanup();
    health = createConnectionHealth();
    session.updateConnection(selected);
    activity = 'Starting engine'; dashboard?.refresh();
    displayed.clear();
    home = await createSessionHome();
    const env = { ...process.env, CODEX_HOME: home.path, SUDO_CLI_SESSION_KEY: selected.apiKey || '' };
    let baseUrl = selected.baseUrl;
    if (selected.transport === 'chat-completions') {
      bridge = await startBridge({ baseUrl, model: selected.model, apiKey: selected.apiKey, onMetrics: metrics });
      baseUrl = bridge.baseUrl;
      env.SUDO_CLI_SESSION_KEY = bridge.token;
      secrets.push(bridge.token);
    } else {
      bridge = await startResponsesMonitor({ baseUrl, apiKey: selected.apiKey, onMetrics: metrics });
      baseUrl = bridge.baseUrl; env.SUDO_CLI_SESSION_KEY = bridge.token; secrets.push(bridge.token);
    }
    const args = providerArgs(selected, { baseUrl, keyEnv: 'SUDO_CLI_SESSION_KEY', permissions:settings.permissions, webAccess:settings.webAccess });
    for (const [name,url] of enabledMcpEntries(settings)) {
      if (settings.webAccess) {
        args.push('-c', `mcp_servers.${name}.url=${JSON.stringify(url)}`);
        const disabled=settings.disabledComputerTools?.get(name);
        if(settings.computerUse===false && disabled?.length)args.push('-c',`mcp_servers.${name}.disabled_tools=${JSON.stringify(disabled)}`);
      }
    }
    engine = await createEngine({ codexPath: localCodex(), cwd, model: selected.model, providerArgs: args, env, onEvent: event, permissions:settings.permissions, webAccess:settings.webAccess, supportedEfforts:selected.supportedEfforts,developerInstructions:personalizationInstructions(await personalization?.get(selected)),
      onApproval: async ({ method, params }) => {
        if (!interactive) return false;
        if(!backgroundWorking)workMeter?.pause();
        session.setWorking(false);
        activity = 'Waiting for permission'; dashboard?.refresh();
        note(`Permission requested: ${method}`);
        note(params.command || params.reason || 'This action needs your permission.');
        if (params.cwd) note(`Directory: ${params.cwd}`);
        if (params.grantRoot) note(`Requested write access: ${params.grantRoot}`);
        if (params.fileChanges) note(`Files: ${Object.keys(params.fileChanges).join(', ')}`);
        if (params.permissions) note(`Requested permissions: ${JSON.stringify(params.permissions)}`);
        try { return /^y(es)?$/i.test(await ask(cyan('  Allow once? [y/N] › '))); }
        finally { if (busy && !quitting) {workMeter?.start();session.setWorking(true);} activity = 'Working'; dashboard?.refresh(); }
      },
    });
    connection = selected;
    features?.remember(selected);
    settings.pendingContext=transfer;
    session.bindThread(engine.threadId);
    activity = 'Ready'; dashboard?.refresh();
    if (!once) {
      note(`Configured: ${selected.model} · ${new URL(selected.baseUrl).host}. API status is confirmed by its first response.`);
      note('Enter a task. / opens commands; Tab completes them. /switch selects a saved or local AI.');
      if(transfer)note('Full visible chat queued for the new AI with your next prompt.');
      if (!settings.webAccess && settings.permissions === 'allow-everything') note('Web tools are Off. Allow Everything still permits commands to use the OS network.');
      if (engine.runtimePolicy?.sandbox?.type === 'readOnly') note('Native engine is using a read-only sandbox here; writes may require approval.');
      if (!settings.webAccess && settings.mcp.size) note('HTTP MCP servers are disabled until /web on.');
    }
  };

  const turn = async (text, {recorded = false} = {}) => {
    if(!engine)throw new Error('No engine connected. Use /switch or /connect before sending a task.');
    const attachments=settings.attachments.flatMap(batch=>batch.files);
    const input=features ? features.prepareTurn(text,{consume:false}) : text;
    if(Array.isArray(input) && Buffer.byteLength(JSON.stringify(input))>8*1024*1024)throw new Error('Full chat plus attachments exceeds the request limit. Export /handoff and use /clear before continuing.');
    assistantFeatures?.interruptSpeech();
    const firstMessage=history.snapshot().messages.length;
    if(!recorded)history.addUser(text,{attachments,model:connection.model});
    await checkpoint();
    features?.prepareTurn(text);
    hasText = false; assistantOutput.reset(); busy = true;
    workMeter?.start();
    session.setWorking(true); activity = 'Waiting for AI'; dashboard?.refresh();
    if (!once) note('Working · Ctrl+C to interrupt');
    let completed=false;
    try {
      const result = await engine.startTurn(input, { model: connection.model, effort:settings.effort, supportedEfforts:connection.supportedEfforts });
      if (result.status === 'completed') {session.markOnline();completed=true;}
    } finally {
      if(!backgroundWorking)workMeter?.pause();
      await workMeter?.flush().catch(() => note('Worked-time totals could not be saved.'));
      busy = false; session.setWorking(false); activity = 'Ready'; dashboard?.refresh();
      write(assistantOutput.flush()); if (hasText) write('\n');
      const data=history.snapshot();for(const message of data.messages)if(message.role==='assistant'&&message.status==='streaming')message.status='interrupted';history.restore(data);
      await checkpoint();
    }
    if(completed){const message=history.snapshot().messages.slice(firstMessage).filter(m=>m.role==='assistant').at(-1);if(message)void assistantFeatures?.speak(message.content).catch(error=>note(`Speech: ${error.message}`));}
  };
  const compact = async () => {
    busy=true;workMeter?.start();session.setWorking(true);activity='Compacting context';dashboard?.refresh();
    try {await engine.compact();note('Context compacted. Whole visible chat remains in /handoff.');}
    finally {busy=false;if(!backgroundWorking)workMeter?.pause();await workMeter?.flush().catch(()=>{});session.setWorking(false);activity='Ready';dashboard?.refresh();}
  };
  const signal = () => {
    if(settings.serviceController){note('Cancelling service operation…');settings.serviceController.abort();return;}
    prompts.cancel();
    if (busy) { note('Interrupting…'); engine?.interrupt().catch(() => {}); }
    else if(assistantFeatures?.snapshot().voice?.running){void assistantFeatures.stopVoice();note('Live voice stopped.');}
    else { quitting = true; prompts.close(); rl?.close(); }
  };
  const terminate = () => { quitting = true;settings.serviceController?.abort(); prompts.close(); rl?.close(); engine?.close().catch(() => {}); };
  process.on('SIGINT', signal);
  process.on('SIGTERM', terminate);
  process.on('SIGHUP', terminate);
  rl?.on('SIGINT', signal);
  rl?.once('close', terminate);
  rl?.on('line', text => {
    if(!busy || currentPrompt || !text.trim())return;
    if(text.trim()==='/stop'){signal();return;}
    if(text.startsWith('/steer ')){
      const message=text.slice(7).trim();history.addUser(message,{model:connection?.model});
      void checkpoint();
      engine?.steer(message).then(()=>note('Prompt sent to the active turn.')).catch(error=>note(error.message));return;
    }
    enqueue(text);note(`Queued prompt ${queuedInputs.length}; current work continues. /stop interrupts it.`);
  });
  try {
    dashboard?.start();
    const stateOptions=process.env.SUDO_CLI_STATE_DIR?{stateDir:resolve(process.env.SUDO_CLI_STATE_DIR)}:{};
    const selected = initialConnection;
    if(selected?.apiKey)secrets.push(selected.apiKey);
    workMeter = await createWorkMeter(stateOptions);profiles=await createModelProfiles(stateOptions);
    const store=await createChatStore({...stateOptions,cwd,secrets:()=>secrets});personalization=await createPersonalization({...stateOptions,secrets:()=>secrets});
    chatSession=createChatSession({store,history,getConnection:()=>connection,getPending:()=>queuedInputs.map(input=>input.text)});
    const resumed=await chatSession.resumeLast();
    features=createFeatureCommands({cwd,settings,profiles,history,note,ask,getConnection:()=>connection,getEngine:()=>engine,reconnect:connect,configure,runTurn:turn,runCompact:compact,getSnapshot:snapshot,rememberSecret:key=>{if(!secrets.includes(key))secrets.push(key);},stop:()=>engine?.interrupt().catch(()=>{})});
    const restoreChat=async()=>{await assistantFeatures?.stop();queuedInputs.length=0;const record=chatSession.current();for(const text of record.pendingInputs||[])queuedInputs.push({text,recorded:false,literal:true});settings.attachments=[];settings.skills=[];await connect(connection||await configure(),{carryHistory:true});};
    assistantFeatures=createAssistantFeatures({cwd,stateDir:stateOptions.stateDir,settings,profiles,chatSession,personalization,note,ask,getConnection:()=>connection,reconnect:connect,onChatChange:restoreChat,enqueue,secrets:()=>secrets,
      rememberSecret:key=>{if(!secrets.includes(key))secrets.push(key);},interrupt:()=>{assistantFeatures?.interruptSpeech();if(busy&&!currentPrompt)void engine?.interrupt().catch(()=>{});},
      onVoiceState:state=>{if(!busy&&!backgroundWorking)activity=state?.status||'Ready';dashboard?.refresh();},
      onBackgroundState:state=>{const working=['assessing','working'].includes(state?.state);backgroundWorking=working;if(working)workMeter?.start();else if(!busy)workMeter?.pause();dashboard?.refresh();},
      onBackgroundResult:async({job,text,model})=>{history.addUser(`[24/7 task ${job.id}] ${job.prompt}`,{model});history.finishAssistant(`background:${randomUUID()}`,text,{model});await checkpoint();note(`24/7 task ${job.id} completed: ${text}`);},
      onApproval:async({method,params})=>{if(!interactive||quitting)return false;if(currentPrompt?.input)prompts.cancel();backgroundWorking=false;if(!busy)workMeter?.pause();dashboard?.refresh();note(`24/7 permission: ${method} · ${params.command||params.reason||'approval required'}`);try{return /^y(es)?$/i.test(await ask('  Allow once? [y/N] › '));}finally{backgroundWorking=!quitting&&['assessing','working'].includes(assistantFeatures?.snapshot().agent?.state);if(backgroundWorking)workMeter?.start();dashboard?.refresh();}},
    });
    if(interactive){await network.start();if(resumed&&!opts.model&&!process.env.SUDO_CLI_MODEL&&resumed.connection){let apiKey=resumed.connection.apiKeyEnv?process.env[resumed.connection.apiKeyEnv]:undefined;if(!apiKey)apiKey=(await ask('  Last AI key [hidden; Enter for none] › ',true))||undefined;if(apiKey)secrets.push(apiKey);await connect(validateConnection({...resumed.connection,apiKey}),{carryHistory:true});}else if(!opts.model && !process.env.SUDO_CLI_MODEL && await features.hasSavedProfiles())await features.chooseProfile();}
    if(!connection)await connect(selected || await configure());
    if(resumed){settings.pendingContext=history.snapshot().messages.length?history.toPrompt():'';for(const text of resumed.pendingInputs||[])queuedInputs.push({text,recorded:false,literal:true});if(!once)note(`Resumed chat: ${resumed.title}. /new starts another; /chatt opens saved chats.`);}
    await chatSession.ensure();await checkpoint();
    saveTimer=setInterval(()=>{if((busy||backgroundWorking)&&saving===0)void checkpoint();},1000);saveTimer.unref();
    if (once) { await turn(opts.once); return; }
    while (!quitting) {
      const queued=queuedInputs.shift();
      let text;
      try{if(queued)text=queued.text;else text=await ask(cyan('\n  you › '),false,{input:true});}
      catch(error){if(error.name==='AbortError'){if(quitting)break;continue;}throw error;}
      if (!text) continue;
      if (!queued?.literal&&(text === '/quit' || text === '/exit')) break;
      try {
        const command=queued?.literal?null:parseCommand(text);
        if(command){if(['/permissions','/web','/computer-use','/mcp','/personalize','/preferences'].includes(command.name)&&command.args.length&&!['status','list','tools'].includes(command.args[0]))await assistantFeatures.stopForPolicyChange();if(!await assistantFeatures.handle(command)&&!await features.handle(command))note('Unknown command. Enter / or /help for the menu.');await checkpoint();}
        else {
          try { await turn(text,{recorded:queued?.recorded}); }
          catch (error) { if (!quitting) note(`Task failed: ${error.message}`); }
        }
      } catch (error) { if (!quitting) note(error.message); }
    }
  } catch (error) {
    if (!quitting) throw new Error(safe(error.message));
  } finally {
    quitting=true;clearInterval(saveTimer);
    process.removeListener('SIGINT', signal);
    process.removeListener('SIGTERM', terminate);
    process.removeListener('SIGHUP', terminate);
    prompts.close();
    rl?.close();
    await assistantFeatures?.stop().catch(error=>note(error.message));
    await cleanup();
    await checkpoint();await chatSession?.flush().catch(()=>note('The final chat checkpoint could not be saved.'));
    network.stop();
    await workMeter?.close().catch(() => note('Worked-time totals could not be saved.'));
    session.setWorking(false); session.markOffline(); activity = 'Session closed'; dashboard?.refresh(); dashboard?.stop();
    secrets = [];
  }
}
