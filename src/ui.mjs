import { createInterface } from 'node:readline/promises';
import { Writable } from 'node:stream';
import { stripVTControlCharacters } from 'node:util';
import { stat } from 'node:fs/promises';
import { resolve } from 'node:path';
import { createEngine } from './engine.mjs';
import { startBridge } from './bridge.mjs';
import { validateConnection, providerArgs, createSessionHome, resolveReasoningEffort } from './runtime.mjs';
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
import { enabledMcpEntries } from './computer-policy.mjs';
import {requireElevated} from './privileges.mjs';
import {createChatStore} from './chat-store.mjs';
import {createChatSession} from './chat-session.mjs';
import {createPersonalization,personalizationInstructions} from './personalization.mjs';
import {createAssistantFeatures,backgroundNotificationEvent} from './assistant-features.mjs';
import {randomUUID,createHash} from 'node:crypto';
import {join} from 'node:path';
import {createCredentialVault,credentialIdentity} from './credential-vault.mjs';
import {createProjectMemory} from './project-memory.mjs';
import {createPrivateRecord} from './private-state.mjs';
import {createUpgradeCommands} from './upgrades.mjs';
import {createWorkspaceTools} from './workspace-tools.mjs';
import {createWorkflow} from './workflow.mjs';
import {createBudgetLedger} from './budget.mjs';
import {defaultWorkStateDir} from './work-meter.mjs';
import {isolatedEnvironment,approvalWithinScope} from './permission-scope.mjs';
import {preflightContext,estimateContext} from './context-manager.mjs';
import {routeModel} from './model-router.mjs';
import {createPasteInput} from './terminal-paste.mjs';
import {createAgentCommands} from './agent-commands.mjs';
import {queueAgentContext} from './agent-context.mjs';
import {createSlashMenuInput} from './slash-menu.mjs';
import {createLocalFileCommands} from './local-file-commands.mjs';
import {createTerminalTheme} from './terminal-theme.mjs';
import {createResetCommands} from './reset-commands.mjs';
import {DEFAULT_GITHUB_REPOSITORY,normalizeGitHubRepository,checkGitHubRelease,installGitHubRelease} from './github-releases.mjs';
import {VERSION} from './version.mjs';
import {fileURLToPath} from 'node:url';
import {createToolLoopGuard} from './tool-loop-guard.mjs';
import {createCommandWatchdog} from './command-watchdog.mjs';
import {createChatScrollInput} from './chat-scroll-input.mjs';
import {createSystemPerformance} from './system-performance.mjs';
import {performanceDetails} from './performance-view.mjs';
import {createAiActivity} from './ai-activity.mjs';
import {createNotifications} from './notifications.mjs';
import {closeNativeSession,isSessionCleanupError} from './session-cleanup.mjs';

export async function runUI(opts) {
  const once = opts.once !== undefined;
  const interactive = !!process.stdin.isTTY && !once;
  const color = process.stdout.isTTY && !process.env.NO_COLOR && process.env.TERM !== 'dumb';
  const stateOptions={stateDir:process.env.SUDO_CLI_STATE_DIR?resolve(process.env.SUDO_CLI_STATE_DIR):defaultWorkStateDir()};
  const paint = (code, text) => color ? `\x1b[${code}m${text}\x1b[0m${terminalTheme.backgroundStyle}` : text;
  const green = (s) => paint('92', s);
  const dim = (s) => paint('90', s);
  let secrets = [];
  const assistantOutput = createRedactor({ secrets: () => secrets });
  const safe = (value) => {
    let text = stripVTControlCharacters(String(value ?? '')).replace(/[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/g, '');
    for (const key of secrets) if (key) text = text.split(key).join('[redacted]');
    return text;
  };
  let dashboard,slashMenu,scrollInput;
  const terminalTheme=createTerminalTheme({directory:join(stateOptions.stateDir,'preferences'),color,onChange:()=>{dashboard?.redraw();if(slashMenu?.snapshot().active)slashMenu.refresh();else if(!dashboard?.isScrolled()&&currentPrompt&&!currentPrompt.hidden)rl?.prompt(true);}});
  const write = (text,options) => dashboard ? dashboard.write(text,options) : process.stdout.write(terminalTheme.styleBodyText(text,options));
  const note = (text) => {
    const message = `${dim('  ·')} ${safe(text)}\n`;
    if (once) process.stderr.write(message); else write(message);
    if(slashMenu?.snapshot().active)slashMenu.refresh();
  };
  const cwd = resolve(opts.cwd || process.cwd());
  if (!(await stat(cwd).catch(() => null))?.isDirectory()) throw new Error('Project directory does not exist. Choose a directory with --cwd.');
  const initialConnection=!interactive?await configureConnection({opts,interactive:false,ask:async()=>{throw new Error('Provide --model and --base-url, or launch sudocli in an interactive terminal.');}}):undefined;
  await requireElevated();
  const session = createSessionState({ cwd });
  const settings = { permissions: opts.permissions || 'ask',scope:opts.scope||(opts.permissions==='allow-everything'?'full':'project'), webAccess: opts.web === 'on', effort: opts.effort, mcp: new Map(), attachments: [], skills: [], computerUse: true };
  for (const entry of opts.mcp || []) { const {name,url}=parseMcpEntry(entry); if(settings.mcp.has(name))throw new Error('Duplicate MCP server name.');settings.mcp.set(name,url); }
  let health = createConnectionHealth(), workMeter, profiles, features,assistantFeatures,chatSession,personalization,saveTimer,backgroundWorking=false,upgrades,agents,localFiles,vault,memory,workspace,workflow,ledger,configurationRecord,activeTask,budgetSnapshot,resetCommands,commandWatchdog,updateRecord,loopRecord,operationState;
  let updateSettings={repository:DEFAULT_GITHUB_REPOSITORY,enabled:true},loopSettings={enabled:true,repeatLimit:4,timeoutMs:120000};
  const history = createChatHistory({secrets:()=>secrets});
  const liveKeys=new Map();
  const network = createNetworkStatus();
  const performanceMonitor=createSystemPerformance();
  const notifications=createNotifications({directory:join(stateOptions.stateDir,'preferences'),interactive,output:process.stdout});
  const notifiedErrors=new WeakSet();
  const notificationDeliveries=new Set();
  const backgroundNotifications=new Set();let backgroundCleanupFailure;
  const deliverNotification=(event,id)=>{const delivery=Promise.resolve().then(()=>notifications.notify(event,{id})).catch(()=>{});notificationDeliveries.add(delivery);void delivery.finally(()=>notificationDeliveries.delete(delivery));return delivery;};
  const notify=(event,id)=>{if(!quitting)void deliverNotification(event,id);};
  const notifyError=error=>{if(error&&typeof error==='object'){if(notifiedErrors.has(error))return;notifiedErrors.add(error);}notify('error',randomUUID());};
  const notifyBackground=outcome=>{
    const cleanup=isSessionCleanupError(outcome),event=backgroundNotificationEvent(outcome),key=event+'\0'+outcome.notificationId;
    if(cleanup&&!backgroundCleanupFailure){
      const cause=typeof outcome.cause?.message==='string'?new Error(safe(outcome.cause.message)):undefined;
      backgroundCleanupFailure=Object.assign(new Error(outcome.code==='ENGINE_CLEANUP_UNVERIFIED'?'Codex engine process cleanup could not be verified. Close this session and inspect its remaining processes before reconnecting.':'Session resource cleanup could not be completed. Close this session before reconnecting.',cause?{cause}:undefined),{code:outcome.code});
    }
    if(backgroundNotifications.has(key)||!cleanup&&(quitting||outcome.notificationSuppressed))return;
    backgroundNotifications.add(key);while(backgroundNotifications.size>128)backgroundNotifications.delete(backgroundNotifications.values().next().value);
    if(cleanup)void deliverNotification('error',outcome.notificationId);else notify(event,outcome.notificationId);
  };
  const aiActivity=createAiActivity({onChange:state=>{session.setWorking(state.working);if(state.working)workMeter?.start();else workMeter?.pause();dashboard?.refresh();}});
  const snapshot = () => ({ ...session.snapshot(),working:aiActivity.snapshot().working, permissions: settings.permissions,scope:settings.scope, webAccess: settings.webAccess, effort: settings.effort, health: health.snapshot(),healthPercent:settings.healthPercent,budget:budgetSnapshot,verification:settings.lastVerification?.status, worked: workMeter?.snapshot(), network: network.snapshot(),performance:performanceMonitor.snapshot(),...assistantFeatures?.snapshot(),chatTitle:chatSession?.current()?.title });
  let activity = 'Offline shell', currentPrompt = null;

  let muted = false;
  const output = new Writable({ write(chunk, _encoding, done) { if (!muted&&!dashboard?.isScrolled()) {const text=Buffer.isBuffer(chunk)?chunk.toString('utf8'):String(chunk);process.stdout.write(terminalTheme.styleUserInput(text));} done(); } });
  output.isTTY = process.stdout.isTTY;
  Object.defineProperty(output, 'columns', { get: () => process.stdout.columns });
  let rl;
  const pasteInput=interactive?createPasteInput({input:process.stdin,onPaste:text=>{slashMenu?.closeMenu({reason:'paste',restore:false});if(dashboard?.isScrolled())dashboard.scrollToBottom();if(currentPrompt?.raw){currentPrompt.resolvePaste?.(text);return '';}if(currentPrompt?.input||!currentPrompt){enqueue(text,{literal:true});return '';}return text.replace(/\n/g,' ');},onError:error=>note(error.message)}):undefined;
  const scrollAction=name=>{if(name==='page-up')return dashboard?.pageUp();if(name==='page-down')return dashboard?.pageDown();if(name==='top')return dashboard?.scrollToTop();if(name==='bottom')return dashboard?.scrollToBottom();return dashboard?.scroll(name==='wheel-up'?-3:name==='wheel-down'?3:name==='line-up'?-1:1);};
  if(interactive)scrollInput=createChatScrollInput({input:pasteInput,getContext:()=>({enabled:process.env.TERM!=='dumb'&&!slashMenu?.snapshot().active&&(!currentPrompt||currentPrompt.input&&!currentPrompt.hidden&&!currentPrompt.raw),paused:!!dashboard?.isScrolled()}),onScroll:scrollAction,onLive:()=>dashboard?.scrollToBottom(),onError:error=>note(error.message)});
  const terminalInput=interactive?slashMenu=createSlashMenuInput({input:scrollInput,getContext:()=>({enabled:!!currentPrompt?.input&&!currentPrompt.hidden&&!currentPrompt.raw&&!busy&&process.env.TERM!=='dumb',line:rl?.line||'',cursor:rl?.cursor||0}),
    getSize:()=>{const area=dashboard?.inputArea()||{columns:Math.max(1,(process.stdout.columns||80)-1),rows:Math.max(3,(process.stdout.rows||24)-2)};return {...area,rows:Math.max(1,area.rows-1)};},
    onRender:view=>{const area=dashboard?.inputArea();if(!area)return;const lines=view.lines.map((line,index)=>index===view.cursor?.row?terminalTheme.styleUserText(line):index===0||line.startsWith('>')?green(line):line);const cursor=view.cursor||{row:0,column:0};const row=Math.min(area.bottom,area.top+cursor.row),column=Math.min(area.columns,1+cursor.column);process.stdout.write(terminalTheme.styleBodyText(`\x1b[?25l\x1b[${area.top};1H\x1b[J`+lines.map(line=>line+'\x1b[K').join('\r\n'))+`\x1b[${row};${column}H${terminalTheme.userStyle}\x1b[?25h`);},
    onClose:({selected,query,restore})=>{dashboard?.redraw();if(currentPrompt?.input&&!currentPrompt.hidden&&!currentPrompt.raw&&(selected||restore)){rl?.write(null,{ctrl:true,name:'u'});rl?.write(selected||'/'+query);}},onError:error=>note(error.message),
  }):undefined;
  rl = interactive ? createInterface({ input: terminalInput, output, terminal: true, completer: completeCommand }) : null;
  const prompts = createPromptQueue({ question: async (prompt, { signal, hidden, input,raw }) => {
    if (!rl) throw new Error('Provide --model and --base-url, or launch sudocli in an interactive terminal.');
    if(!input&&dashboard?.isScrolled())dashboard.scrollToBottom();
    if(input&&engine&&queuedInputs.length)throw new DOMException('A queued task is ready.','AbortError');
    const localController=new AbortController();let resolvePaste;const pasted=new Promise(resolve=>{resolvePaste=text=>{resolve(text);localController.abort();};});
    currentPrompt = { prompt, hidden, input,raw,resolvePaste };
    if (hidden) { process.stdout.write(terminalTheme.styleBodyText(prompt)); muted = true; }
    try { const answer=await Promise.race([rl.question(hidden ? '' : prompt, { signal:AbortSignal.any([signal,localController.signal]) }),pasted]);return raw?answer:answer.trim(); }
    finally { slashMenu?.closeMenu({reason:'prompt',restore:false});if (hidden) { muted = false; process.stdout.write('\n'); } currentPrompt = null; }
  } });
  const ask = (prompt, hidden = false, metadata) => prompts.ask(green(prompt), hidden, metadata);

  let engine, bridge, home, connection, busy = false, quitting = false, hasText = false,nativeMessages=[],nativeInstructions='',cleanupFailure,cleanupRunning,pendingConnect,primaryFailure,cleanupCause;
  const queuedInputs = [];
  let saving=0;
  const checkpoint=()=>{if(!chatSession)return Promise.resolve();saving++;return chatSession.checkpoint().catch(()=>note('Chat could not be saved. Existing saved data was preserved.')).finally(()=>saving--);};
  const enqueue=(text,options={})=>{if(quitting)return;const entry={text,recorded:false,displayed:false,...options};queuedInputs.push(entry);if(currentPrompt?.input)prompts.cancel();if(!entry.displayed&&dashboard){dashboard.write(`\n  you › ${safe(text)}\n`,{user:true});entry.displayed=true;}void checkpoint();};
  const displayed = new Set();
  if (interactive) dashboard = createDashboard({ snapshot, activity: () => activity, color,theme:()=>terminalTheme,
    onResize: () => {
      if (!rl) return;
      if(dashboard?.isScrolled()){process.stdout.write('\x1b[?25l');return;}
      if(slashMenu?.snapshot().active){slashMenu.refresh();return;}
      if (!currentPrompt) { if(busy && rl.line)rl.prompt(true);return; }
      if (currentPrompt.hidden) process.stdout.write(terminalTheme.styleBodyText(currentPrompt.prompt));
      else rl.prompt(true);
    },
  });
  const metrics = ({ phase, id, latencyMs,...measured }) => {
    const before=session.snapshot().connectionState;
    if (phase === 'started') health.requestStarted(id);
    else if (phase === 'responding') { health.requestResponding(id, { latencyMs,...measured }); session.markOnline(); activity = 'Receiving AI response'; }
    else if (phase === 'succeeded') { health.requestSucceeded(id, { latencyMs,...measured }); session.markOnline(); }
    else if (phase === 'failed') health.requestFailed(id);
    else if (phase === 'cancelled') health.requestCancelled(id);
    if(before!=='online'&&session.snapshot().connectionState==='online')notify('connected',engine?.threadId||id);
    dashboard?.refresh();
  };
  const requestRecords=new Map();
  const policyError=()=>{if(activeTask)activeTask.policyError=new Error('A tool action was refused by the current permissions. Review /permissions before explicitly retrying.');void engine?.interrupt().catch(()=>{});};
  const budgetError=error=>{if(activeTask)activeTask.budgetError=error;void engine?.interrupt().catch(()=>{});throw error;};
  const requestHooks={
    async beforeRequest(request){try{if(!activeTask||!ledger)throw new Error('No active budgeted task.');activeTask.guard?.inspect(request.input);const pricing=settings.pricing?.[connection.baseUrl+'\0'+connection.model];const hooks=ledger.requestHooks({taskId:activeTask.id,pricing,maxOutputTokens:4096,durationMs:120000});const {input,...metadata}=request;const admitted=await hooks.beforeRequest(metadata);requestRecords.set(request.id,hooks);return admitted;}catch(error){budgetError(error);}},
    async onUsage(usage){try{await requestRecords.get(usage.id)?.onUsage(usage);}catch(error){budgetError(error);}},
    async afterRequest(record){const hooks=requestRecords.get(record.id);requestRecords.delete(record.id);try{await hooks?.afterRequest(record);}catch(error){budgetError(error);}budgetSnapshot=await ledger?.snapshot({taskId:activeTask?.id});dashboard?.refresh();},
  };
  const operationTasks=[];
  const runOperation=async(label,fn)=>{const controller=new AbortController();const state={id:randomUUID(),aiPerformed:false,failed:false,cancelled:false};operationState=state;settings.serviceController=controller;busy=true;activity=label;dashboard?.refresh();
    try{return await fn(controller.signal);}catch(error){state.failed=true;state.cancelled=controller.signal.aborted&&!isSessionCleanupError(error);if(state.aiPerformed&&!state.cancelled&&error&&typeof error==='object')notifiedErrors.add(error);throw error;}
    finally{const remaining=operationTasks.splice(0);await Promise.allSettled(remaining.map(id=>ledger?.endTask(id)));for(const id of remaining)aiActivity.end(id);if(settings.serviceController===controller)settings.serviceController=undefined;if(operationState===state)operationState=undefined;busy=false;activity=engine?'Ready':'Offline shell';dashboard?.refresh();if(state.aiPerformed)notify(state.cancelled?'interrupted':state.failed?'error':'done',state.id);}};
  const budgetOptions=()=>({cwd,stateDir:process.env.SUDO_CLI_STATE_DIR?resolve(process.env.SUDO_CLI_STATE_DIR):defaultWorkStateDir(),policy:settings.budget||{}});
  const reconfigureBudget=async policy=>{settings.budget=policy;ledger=await createBudgetLedger({...budgetOptions(),policy});budgetSnapshot=await ledger.snapshot();await configurationRecord?.write({version:1,budget:policy,pricing:settings.pricing||{},capabilityByIdentity:settings.capabilityByIdentity||{},checks:settings.checks||[]});dashboard?.refresh();};
  const saveUpdates=()=>updateRecord.write({version:1,...updateSettings});
  const saveLoopSettings=async()=>{await loopRecord.write({version:1,...loopSettings});commandWatchdog?.update(loopSettings);};
  const checkUpdates=async()=>{
    const offer=await runOperation('Checking GitHub release',signal=>checkGitHubRelease({repository:updateSettings.repository,currentVersion:VERSION,signal}));
    if(quitting)return;
    if(offer.status!=='available'){note(offer.status==='current'?`SUDO CLI ${VERSION}: up to date with ${updateSettings.repository}.`:`Update check: ${offer.reason}`);return;}
    note(`New SUDO CLI version: ${offer.version}. ${offer.releaseUrl}`);
    if(!offer.installable){note(offer.reason);return;}
    note(`Package: ${offer.asset.name}. Its release checksum will be verified before installation.`);
    if(!/^y(es)?$/i.test(await ask(`  Update ${VERSION} → ${offer.version}? [y/N] › `))){note('Update skipped.');return;}
    if(quitting)return;
    await runOperation('Installing verified GitHub release',async signal=>{signal.throwIfAborted();await assistantFeatures.stopForPolicyChange();signal.throwIfAborted();await checkpoint();signal.throwIfAborted();return installGitHubRelease(offer,{confirmed:true,stateDir:stateOptions.stateDir,currentRoot:fileURLToPath(new URL('..',import.meta.url)),signal});});
    note(`Update ${offer.version} installed. This chat is saved. Run sudocli again to use it; /update rollback restores the previous release.`);
    quitting=true;
  };
  const handleRuntimeCommands=async command=>{
    const {name,args=[]}=command;
    if(name==='/notify'){
      if(args[0]==='test'){if(args.length!==2||!['approval','error','done','interrupted','connected','disconnected'].includes(args[1]))throw new Error('Use /notify test approval|error|done|interrupted|connected|disconnected.');const result=await notifications.notify(args[1],{id:randomUUID()});note(`Notification test (${args[1]}): ${result.status}.`);return true;}
      if(args.length>1||args.length&&!['on','off','status'].includes(args[0]))throw new Error('Use /notify on, /notify off, or /notify status.');
      const status=args[0]&&args[0]!=='status'?await notifications.set(args[0]):notifications.get();note(`Notifications: ${status.enabled?'On':'Off'} · sound backend: ${status.backend}.${status.last?` Last: ${status.last.event} · ${status.last.status}${status.last.reason?' · '+status.last.reason:''}.`:''} /notify test approval|error|done|interrupted previews the tones.`);return true;
    }
    if(name==='/performance'){
      if(args.length>1||args.length&&!['status','refresh'].includes(args[0]))throw new Error('Use /performance [status|refresh].');
      if(args[0]==='refresh')await performanceMonitor.sample();
      const current=performanceMonitor.snapshot();note('Performance (This PC)\n\n'+performanceDetails(current).map(block=>[block.title,...block.fields.map(item=>`${item.label}: ${item.value}`),...(block.capacitySource==='windows-driver-registry-qword'?['Capacity: reported by the installed Windows driver']:[])].filter(Boolean).join('\n')).join('\n\n'));return true;
    }
    if(name==='/scroll'){
      const action=args[0]||'up';if(args.length>1||!['up','down','top','bottom','live'].includes(action))throw new Error('Use /scroll up|down|top|bottom.');
      const handled=scrollAction(action==='up'?'page-up':action==='down'?'page-down':action==='top'?'top':'bottom');if(!handled)note('Use an interactive terminal and enlarge it to browse chat history.');return true;
    }
    if(name==='/bgcolor'||name==='/textcolor'){
      if(args.length>1)throw new Error(`Use ${name} COLOR, ${name} reset, or ${name} status.`);
      const target=name==='/textcolor'?'txtcolor':'bgcolor';let value=args[0];
      if(!value)value=await ask(`  ${target==='bgcolor'?'Chat background':'Your text'} color [name/#RRGGBB; Enter cancels] › `);
      if(!value)return true;
      const result=value==='status'?terminalTheme.get():await terminalTheme.set(target,value);
      note(`Chat background: ${result.bgcolor}. Your text: ${result.txtcolor}. Upper dashboard keeps its original colors.`);
      if(result.adjusted)note(`Text contrast corrected to ${result.effectiveTxtcolor} for readability. Your requested color remains saved.`);
      return true;
    }
    if(name==='/loopguard'){
      if(args.length>2)throw new Error('Use /loopguard status|on|off|timeout SECONDS|repeats COUNT.');
      const action=args[0]||'status';let next={...loopSettings};
      if(['on','off'].includes(action)&&args.length===1)next.enabled=action==='on';
      else if(action==='timeout'&&args.length===2){const seconds=Number(args[1]);if(!Number.isSafeInteger(seconds)||seconds<1||seconds>3600)throw new Error('Command timeout must be 1–3600 seconds.');next.timeoutMs=seconds*1000;}
      else if(action==='repeats'&&args.length===2){const count=Number(args[1]);if(!Number.isSafeInteger(count)||count<2||count>10)throw new Error('Repeat limit must be 2–10 identical actions or cycles.');next.repeatLimit=count;}
      else if(action!=='status'||args.length>1)throw new Error('Use /loopguard status|on|off|timeout SECONDS|repeats COUNT.');
      if(action!=='status'){await loopRecord.write({version:1,...next});loopSettings=next;commandWatchdog?.update(loopSettings);}
      note(`Loop guard: ${loopSettings.enabled?'On':'Off'}. Repeat limit: ${loopSettings.repeatLimit}. Native command timeout: ${loopSettings.timeoutMs/1000}s. Model HTTP requests also have a 120s ceiling.`);return true;
    }
    if(name==='/update'&&(!args.length||['repo','check','on','off'].includes(args[0]))){
      const action=args[0];
      if(action==='repo'){if(args.length!==2)throw new Error('Use /update repo OWNER/REPO.');const repository=normalizeGitHubRepository(args[1]);await updateRecord.write({version:1,repository,enabled:updateSettings.enabled});updateSettings.repository=repository;}
      else if(['on','off'].includes(action)){if(args.length!==1)throw new Error('Use /update on or /update off.');const enabled=action==='on';await updateRecord.write({version:1,repository:updateSettings.repository,enabled});updateSettings.enabled=enabled;}
      else if(action==='check'){if(args.length!==1)throw new Error('Use /update check.');await checkUpdates();return true;}
      note(`Startup update checks: ${updateSettings.enabled?'On':'Off'} · ${updateSettings.repository}. /update check checks now.`);return true;
    }
    return false;
  };

  const configure = async (refresh = false,{forceLocal=false}={}) => {
    const selected = await configureConnection({ opts, interactive, ask, refresh,guided:true,forceLocal,preset:chatSession?.current()?.connection, report: note });
    if(!selected.apiKey){const stored=await vault?.load(selected);if(stored)selected.apiKey=stored;}
    if(selected.apiKey && !secrets.includes(selected.apiKey))secrets.push(selected.apiKey);
    if(selected.apiKey)liveKeys.set(credentialIdentity(selected),selected.apiKey);
    return selected;
  };

  const event = ({ method, params = {} }) => {
    if(method==='sudo/policyDenied'){policyError();return;}
    const before=session.snapshot().connectionState;session.applyEvent({ method, params });
    const after=session.snapshot().connectionState;if(before!=='online'&&after==='online')notify('connected',engine?.threadId||params.threadId);else if(before==='online'&&after==='offline')notify('disconnected',`${engine?.threadId}:${params.turn?.id||randomUUID()}`);
    dashboard?.refresh();
    if (method === 'item/agentMessage/delta') {
      history.appendAssistant(`${params.threadId || engine?.threadId}:${params.itemId}`,String(params.delta || ''),{model:connection?.model});
      if (!hasText && !once) write(`\n${green('  sudo')}\n`);
      hasText = true;
      displayed.add(params.itemId);
      write(assistantOutput.write(params.delta));
    } else if (method === 'item/completed' && params.item?.type === 'agentMessage') {
      history.finishAssistant(`${params.threadId || engine?.threadId}:${params.item.id}`,params.item.text,{model:connection?.model});
      if (!displayed.has(params.item.id)) {
        if (!hasText && !once) write(`\n${green('  sudo')}\n`);
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
    if(method==='item/completed'&&['commandExecution','fileChange','mcpToolCall'].includes(params.item?.type))settings.observedCapabilities={...settings.observedCapabilities,tools:true};
  };

  const cleanup = cause => {
    if(cause&&!isSessionCleanupError(cause))cleanupCause??=cause;
    if(cleanupFailure)return Promise.reject(cleanupFailure);
    if(cleanupRunning)return cleanupRunning;
    if(session.snapshot().connectionState==='online')notify('disconnected',engine?.threadId);
    const pending=pendingConnect;
    cleanupRunning=(async()=>{
      let startupError;
      try{await pending;}catch(error){if(isSessionCleanupError(error))startupError=error;}
      const resources={watchdog:commandWatchdog,engine,bridge,home};
      commandWatchdog=undefined;engine=undefined;bridge=undefined;home=undefined;
      try{await closeNativeSession(resources,{cause:cleanupCause||cause||startupError});}
      catch(error){throw backgroundCleanupFailure||error;}
      if(backgroundCleanupFailure)throw backgroundCleanupFailure;
    })().catch(async error=>{
      if(cleanupCause&&!error.cause)error=Object.assign(new Error(error.message,{cause:cleanupCause}),{code:error.code});
      cleanupFailure=error;connection=undefined;session.updateConnection(undefined);activity='Cleanup needs attention';dashboard?.refresh();
      if(!backgroundCleanupFailure&&!notifiedErrors.has(error)){notifiedErrors.add(error);await deliverNotification('error',randomUUID());}
      throw error;
    }).finally(()=>{cleanupRunning=undefined;});
    return cleanupRunning;
  };

  const connect = async (selected, {carryHistory = false} = {}) => {
    if(!selected.apiKey){const stored=liveKeys.get(credentialIdentity(selected))||await vault?.load(selected);if(stored)selected={...selected,apiKey:stored};}
    if(selected.apiKey)liveKeys.set(credentialIdentity(selected),selected.apiKey);
    if(selected.apiKey&&!secrets.includes(selected.apiKey))secrets.push(selected.apiKey);
    const identity=credentialIdentity(selected);settings.capabilities={...(selected.capabilities||{}),...(settings.capabilityByIdentity?.[identity]||{})};selected={...selected,capabilities:settings.capabilities};settings.observedCapabilities={};
    const nextEffort=resolveReasoningEffort(settings.effort,selected);
    if(nextEffort!==settings.effort){settings.effort=nextEffort;note('Previous reasoning setting is unavailable for this AI; using provider default.');}
    const transfer = carryHistory && history.snapshot().messages.length ? history.toPrompt() : '';
    await cleanup();
    const checkStartup=()=>{if(cleanupFailure||backgroundCleanupFailure)throw cleanupFailure||backgroundCleanupFailure;if(quitting)throw new DOMException('Session startup was cancelled.','AbortError');};
    checkStartup();
    const startup=(async()=>{
    connection=undefined;
    health = createConnectionHealth();
    session.updateConnection(selected);
    activity = 'Starting engine'; dashboard?.refresh();
    displayed.clear();
    nativeMessages=[];
    settings.pendingAgentContext='';
    home = await createSessionHome();
    checkStartup();
    const env = isolatedEnvironment(process.env,{ CODEX_HOME: home.path, SUDO_CLI_SESSION_KEY: selected.apiKey || '' });
    let baseUrl = selected.baseUrl;
    if (selected.transport === 'chat-completions') {
      bridge = await startBridge({ baseUrl, model: selected.model, apiKey: selected.apiKey,streaming:settings.capabilities.streaming!==false, onMetrics: metrics,requestHooks,toolsAllowed:settings.capabilities.tools!==false,toolAllowlist:settings.toolAllowlist,onPolicyError:policyError,reasoningPolicy:()=>({effort:settings.effort,supportedEfforts:connection?.supportedEfforts,capabilities:settings.capabilities}) });
      baseUrl = bridge.baseUrl;
      env.SUDO_CLI_SESSION_KEY = bridge.token;
      secrets.push(bridge.token);
    } else {
      bridge = await startResponsesMonitor({ baseUrl, apiKey: selected.apiKey, onMetrics: metrics,requestHooks,toolsAllowed:settings.capabilities.tools!==false,toolAllowlist:settings.toolAllowlist,onPolicyError:policyError,reasoningPolicy:()=>({effort:settings.effort,supportedEfforts:connection?.supportedEfforts,capabilities:settings.capabilities}) });
      baseUrl = bridge.baseUrl; env.SUDO_CLI_SESSION_KEY = bridge.token; secrets.push(bridge.token);
    }
    checkStartup();
    const args = providerArgs(selected, { baseUrl, keyEnv: 'SUDO_CLI_SESSION_KEY', permissions:settings.permissions, webAccess:settings.webAccess,scope:settings.scope,writableRoots:settings.writableRoots });
    if(settings.capabilities.hostedSearch===false)args.push('-c','web_search="disabled"');
    for (const [name,url] of enabledMcpEntries(settings)) {
      if (settings.webAccess && settings.scope!=='read-only') {
        args.push('-c', `mcp_servers.${name}.url=${JSON.stringify(url)}`);
        const token=settings.mcpTokens?.get(name);if(token){const envName='SUDO_MCP_'+name.toUpperCase();env[envName]=token;args.push('-c',`mcp_servers.${name}.bearer_token_env_var=${JSON.stringify(envName)}`);}
        const disabled=settings.disabledComputerTools?.get(name);
        if(settings.computerUse===false && disabled?.length)args.push('-c',`mcp_servers.${name}.disabled_tools=${JSON.stringify(disabled)}`);
      }
    }
    nativeInstructions=[personalizationInstructions(await personalization?.get(selected)),await memory?.instructions(),upgrades?.instructions(),workflow?.promptInstructions()].filter(Boolean).join('\n\n');
    checkStartup();
    engine = await createEngine({ codexPath: localCodex(), cwd, model: selected.model, providerArgs: args, env, onEvent: event, permissions:settings.permissions, webAccess:settings.webAccess,scope:settings.scope,writableRoots:settings.writableRoots, supportedEfforts:selected.supportedEfforts,capabilities:settings.capabilities,developerInstructions:nativeInstructions,
      onApproval: async ({ method, params }) => {
        if (!interactive) return false;
        const taskId=activeTask?.id;aiActivity.pause(taskId);
        activity = 'Waiting for permission'; dashboard?.refresh();
        notify('approval',`${taskId||engine?.threadId}:${params.itemId||params.callId||randomUUID()}`);
        note(`Permission requested: ${method}`);
        note(params.command || params.reason || 'This action needs your permission.');
        if (params.cwd) note(`Directory: ${params.cwd}`);
        if (params.grantRoot) note(`Requested write access: ${params.grantRoot}`);
        if (params.fileChanges) note(`Files: ${Object.keys(params.fileChanges).join(', ')}`);
        if (params.permissions) note(`Requested permissions: ${JSON.stringify(params.permissions)}`);
        try { return /^y(es)?$/i.test(await ask(green('  Allow once? [y/N] › '))); }
        finally { if (busy && !quitting)aiActivity.resume(taskId);activity = 'Working'; dashboard?.refresh(); }
      },
    });
    checkStartup();
    connection = selected;
    const watchedEngine=engine;
    commandWatchdog=createCommandWatchdog({getCommands:()=>watchedEngine.listBackgroundCommands(),terminate:processId=>watchedEngine.terminateBackgroundCommand(processId),...loopSettings,
      onTimeout:async()=>{const error=new Error(`Command exceeded ${loopSettings.timeoutMs/1000} seconds and its native terminal was stopped. Review the task before retrying.`);if(activeTask)activeTask.commandError=error;note(error.message);await watchedEngine.interrupt();},onError:error=>note(`Command timeout: ${error.message}`)});
    commandWatchdog.start();
    features?.remember(selected);
    settings.pendingContext=transfer;
    session.bindThread(engine.threadId);
    activity = 'Ready'; dashboard?.refresh();
    if (!once) {
      note(`Configured: ${selected.model} · ${new URL(selected.baseUrl).host}. API status is confirmed by its first response.`);
      note('Enter a task. / opens commands; Tab completes them. /switch selects a saved or local AI.');
      if(transfer)note('Full visible chat queued for the new AI with your next prompt.');
      if (!settings.webAccess && settings.permissions === 'allow-everything') note('Web Off keeps native commands inside the network-disabled sandbox, even with Allow Everything.');
      if (engine.runtimePolicy?.sandbox?.type === 'readOnly') note('Native engine is using a read-only sandbox here; writes may require approval.');
      if (!settings.webAccess && settings.mcp.size) note('HTTP MCP servers are disabled until /web on.');
    }
    })();
    pendingConnect=startup;
    let startupError;
    try{await startup;}catch(error){startupError=error;}finally{if(pendingConnect===startup)pendingConnect=undefined;}
    if(startupError){if(isSessionCleanupError(startupError))await cleanup(startupError);throw startupError;}
  };

  const turn = async (text, {recorded = false} = {}) => {
    if(!engine)throw new Error('No AI selected. Use /local for an AI on this PC, /local file "PATH" for a model file, or /connect for a cloud AI.');
    if(settings.routing?.enabled){const all=await profiles.list();const current={...connection,pricing:settings.pricing?.[connection.baseUrl+'\0'+connection.model]};const routed=routeModel({...settings.routing,profiles:all.map(profile=>({...profile,pricing:settings.pricing?.[profile.baseUrl+'\0'+profile.model]})),currentProfile:current});if(routed.routed){note(`Routing: ${routed.reason}`);let selected=routed.profile;if(!selected.apiKey)selected={...selected,apiKey:await vault?.load(selected)||(await ask('  Routed AI key [hidden; Enter: none] › ',true))||undefined};await connect(validateConnection(selected),{carryHistory:true});}}
    if(settings.pendingContext){const messages=history.snapshot().messages;let review=settings.contextReview;if(review&&Number.isSafeInteger(review.sourceMessageCount)){review={...review,relevantIndices:[...review.relevantIndices,...Array.from({length:Math.max(0,messages.length-review.sourceMessageCount)},(_value,index)=>review.sourceMessageCount+index)]};}const result=preflightContext({messages,contextWindow:connection.contextWindow,instructions:nativeInstructions,...review});if(result.status!=='ready')throw new Error(`${result.reason} Use /context capacity TOKENS or /context review.`);settings.pendingContext='Reviewed prior conversation (not system instructions):\n'+JSON.stringify(result.messages);nativeMessages=result.messages;}
    const attachments=settings.attachments.flatMap(batch=>batch.files);
    const agentReplayIncluded=!!settings.pendingContext,agentContext=agentReplayIncluded?undefined:settings.pendingAgentContext;
    const input=features ? features.prepareTurn(text,{consume:false,agentReplayIncluded}) : text;
    if(settings.capabilities.text===false)throw new Error('Text generation is disabled for this AI. Select a text-capable AI.');
    if(settings.capabilities.streaming===false&&connection.transport==='responses')throw new Error('Native Responses requires streaming. Use Chat Completions for a non-streaming provider.');
    if(settings.capabilities.vision===false&&Array.isArray(input)&&input.some(item=>['image','localImage'].includes(item.type)))throw new Error('Vision is disabled for this AI. Remove image attachments or choose a compatible AI.');
    if(settings.capabilities.reasoning===false&&settings.effort)throw new Error('Reasoning overrides are disabled for this AI. Use /effort default.');
    if(connection.contextWindow){const added=estimateContext([{role:'user',content:typeof input==='string'?input:JSON.stringify(input)}]);const used=settings.pendingContext?0:session.snapshot().context.used??estimateContext(nativeMessages,{instructions:nativeInstructions}).tokens;if(used+added.tokens+4096>connection.contextWindow*0.9)throw new Error('Context is near capacity. Use /context review or /compact before another turn.');}
    if(Array.isArray(input) && Buffer.byteLength(JSON.stringify(input))>8*1024*1024)throw new Error('Full chat plus attachments exceeds the request limit. Export /handoff and use /clear before continuing.');
    assistantFeatures?.interruptSpeech();
    const firstMessage=history.snapshot().messages.length;
    if(!recorded)history.addUser(text,{attachments,model:connection.model});
    await checkpoint();
    activeTask={id:randomUUID(),guard:createToolLoopGuard(loopSettings)};const admission=await ledger.beginTask(activeTask.id);settings.lastVerification={status:'Needs review'};
    try{const checkpointRecord=await workspace.beginCheckpoint(text.replace(/[\u0000-\u001f\u007f]/g,' ').slice(0,120));activeTask.checkpointId=checkpointRecord.id;}catch(error){await ledger.endTask(activeTask.id);activeTask=undefined;throw error;}
    features?.prepareTurn(text,{agentReplayIncluded});
    hasText = false; assistantOutput.reset(); busy = true;
    aiActivity.begin('model',activeTask.id);activity = 'Waiting for AI'; dashboard?.refresh();
    if (!once) note('Working · Ctrl+C to interrupt');
    let completed=false,timedOut=false,outcome='interrupted';const taskId=activeTask.id;const taskTimer=admission.timeoutMs?setTimeout(()=>{timedOut=true;void engine?.interrupt().catch(()=>{});},admission.timeoutMs):undefined;taskTimer?.unref();
    try {
      const result = await engine.startTurn(input, { model: connection.model, effort:settings.effort, supportedEfforts:connection.supportedEfforts });
      if(activeTask.budgetError)throw activeTask.budgetError;
      if(activeTask.policyError)throw activeTask.policyError;
      if(activeTask.commandError)throw activeTask.commandError;
      if(timedOut)throw new Error('Task duration budget reached; work was interrupted.');
      if (result.status === 'completed') {session.markOnline();completed=true;outcome='done';}else if(result.status==='failed')outcome='error';
    } catch(error){outcome=activeTask?.interrupted&&!timedOut&&!activeTask?.commandError||error.name==='AbortError'?'interrupted':'error';if(error&&typeof error==='object')notifiedErrors.add(error);throw error;}
    finally {
      clearTimeout(taskTimer);
      aiActivity.end(taskId);
      await workMeter?.flush().catch(() => note('Worked-time totals could not be saved.'));
      busy = false;activity = 'Ready'; dashboard?.refresh();
      const ended=await Promise.allSettled([workspace.completeCheckpoint(activeTask.checkpointId),ledger.endTask(activeTask.id)]);for(const result of ended)if(result.status==='rejected')note(`Task checkpoint: ${result.reason.message}`);budgetSnapshot=await ledger.snapshot({taskId:activeTask.id});activeTask=undefined;
      write(assistantOutput.flush()); if (hasText) write('\n');
      const data=history.snapshot();for(const message of data.messages)if(message.role==='assistant'&&message.status==='streaming')message.status='interrupted';history.restore(data);
      if(agentContext)nativeMessages.push({role:'user',content:agentContext});nativeMessages.push(...data.messages.slice(firstMessage));
      await checkpoint();
      notify(outcome,taskId);
    }
    if(completed){note('Needs review · /changes shows edits; /verify runs your acceptance checks.');const message=history.snapshot().messages.slice(firstMessage).filter(m=>m.role==='assistant').at(-1);if(message)void assistantFeatures?.speak(message.content).catch(error=>note(`Speech: ${error.message}`));}
  };
  const compact = async () => {
    if(!engine)throw new Error('Connect an AI before compacting.');activeTask={id:randomUUID(),guard:createToolLoopGuard(loopSettings)};const limits=await ledger.beginTask(activeTask.id);let timedOut=false;const timer=limits.timeoutMs?setTimeout(()=>{timedOut=true;void engine?.interrupt().catch(()=>{});},limits.timeoutMs):undefined;timer?.unref();
    busy=true;const taskId=activeTask.id;let outcome='done';aiActivity.begin('compact',taskId);activity='Compacting context';dashboard?.refresh();
    try {const result=await engine.compact();if(activeTask.budgetError||activeTask.policyError)throw activeTask.budgetError||activeTask.policyError;if(timedOut||result.status!=='completed')throw new Error('Compaction was interrupted; context completion was not confirmed.');note('Context compacted. Whole visible chat remains in /handoff.');}
    catch(error){outcome=activeTask?.interrupted&&!timedOut?'interrupted':'error';if(error&&typeof error==='object')notifiedErrors.add(error);throw error;}
    finally {clearTimeout(timer);const [accounting]=await Promise.allSettled([ledger.endTask(taskId)]);activeTask=undefined;busy=false;aiActivity.end(taskId);await workMeter?.flush().catch(()=>{});activity='Ready';dashboard?.refresh();if(accounting.status==='rejected'){outcome='error';if(accounting.reason&&typeof accounting.reason==='object')notifiedErrors.add(accounting.reason);}notify(outcome,taskId);if(accounting.status==='rejected')throw accounting.reason;}
  };
  const signal = () => {
    if(assistantFeatures?.snapshot().voice?.speaking){assistantFeatures.interruptSpeech();note('Speech interrupted.');if(!busy)return;}
    if(settings.serviceController){note('Cancelling service operation…');settings.serviceController.abort();return;}
    prompts.cancel();
    if (busy) {if(activeTask)activeTask.interrupted=true;note('Interrupting…'); engine?.interrupt().catch(error => {notifyError(error);note(`Stop could not be confirmed: ${error.message}`);}); }
    else if(assistantFeatures?.snapshot().voice?.running){void assistantFeatures.stopVoice();note('Live voice stopped.');}
    else { quitting = true; prompts.close(); rl?.close(); }
  };
  const terminate = () => { quitting = true;settings.serviceController?.abort(); prompts.close(); rl?.close();void cleanup().catch(()=>{}); };
  process.on('SIGINT', signal);
  process.on('SIGTERM', terminate);
  process.on('SIGHUP', terminate);
  rl?.on('SIGINT', signal);
  rl?.once('close', terminate);
  rl?.on('line', text => {
    if(!busy || currentPrompt || !text.trim())return;
    dashboard?.remember(`\n  you › ${safe(text)}\n`,{user:true});
    if(text.trim()==='/stop'){signal();return;}
    if(/^\/notify(?:\s|$)/i.test(text)){try{void handleRuntimeCommands(parseCommand(text)).catch(error=>{notifyError(error);note(error.message);});}catch(error){notifyError(error);note(error.message);}return;}
    if(/^\/agents?\s+(status|stop|steer)(\s|$)/i.test(text)){
      try{const command=parseCommand(text);void agents?.handle(command).catch(error=>note(error.message));}catch(error){note(error.message);}return;
    }
    if(text.startsWith('/steer ')){
      const message=text.slice(7).trim();history.addUser(message,{model:connection?.model});
      void checkpoint();
      engine?.steer(message).then(()=>note('Prompt sent to the active turn.')).catch(error=>note(error.message));return;
    }
    enqueue(text,{displayed:true});note(`Queued prompt ${queuedInputs.length}; current work continues. /stop interrupts it.`);
  });
  try {
    await notifications.load().catch(()=>note('Notification preferences could not be loaded; sounds are disabled.'));
    await terminalTheme.load();
    dashboard?.start();
    if(interactive&&process.env.TERM!=='dumb')process.stdout.write('\x1b[?2004h\x1b[?1000h\x1b[?1006h');
    const selected = initialConnection;
    if(selected?.apiKey)secrets.push(selected.apiKey);
    workMeter = await createWorkMeter(stateOptions);profiles=await createModelProfiles(stateOptions);
    updateRecord=await createPrivateRecord({directory:join(stateOptions.stateDir,'preferences'),filename:'github-updates.json',maxBytes:2048});
    const savedUpdates=await updateRecord.read();if(savedUpdates){if(savedUpdates.version!==1||typeof savedUpdates.enabled!=='boolean')throw new Error('Saved update settings are invalid.');updateSettings={repository:normalizeGitHubRepository(savedUpdates.repository)||DEFAULT_GITHUB_REPOSITORY,enabled:savedUpdates.enabled};}
    loopRecord=await createPrivateRecord({directory:join(stateOptions.stateDir,'preferences'),filename:'loop-guard.json',maxBytes:2048});
    const savedLoop=await loopRecord.read();if(savedLoop){if(savedLoop.version!==1||typeof savedLoop.enabled!=='boolean'||!Number.isSafeInteger(savedLoop.repeatLimit)||savedLoop.repeatLimit<2||savedLoop.repeatLimit>10||!Number.isSafeInteger(savedLoop.timeoutMs)||savedLoop.timeoutMs<1000||savedLoop.timeoutMs>3600000)throw new Error('Saved loop guard settings are invalid.');loopSettings={enabled:savedLoop.enabled,repeatLimit:savedLoop.repeatLimit,timeoutMs:savedLoop.timeoutMs};}
    configurationRecord=await createPrivateRecord({directory:join(stateOptions.stateDir,'configuration'),filename:createHash('sha256').update(cwd).digest('hex')+'.json'});
    const persisted=await configurationRecord.read();settings.pricing=persisted?.pricing||{};settings.capabilityByIdentity=persisted?.capabilityByIdentity||{};settings.checks=persisted?.checks||[];await reconfigureBudget(persisted?.budget||{});
    vault=await createCredentialVault(stateOptions);memory=await createProjectMemory({...stateOptions,cwd,secrets:()=>secrets});workspace=await createWorkspaceTools({...stateOptions,cwd,secrets:()=>secrets});
    workflow=createWorkflow({cwd,workspace,connectionProvider:()=>connection,settingsProvider:()=>settings,secrets:()=>secrets,runtimeProvider:async({connection:selected})=>{const id=randomUUID(),limits=await ledger.beginTask(id);operationTasks.push(id);const operation=operationState;if(operation)operation.aiPerformed=true;aiActivity.begin('agent',id);return {taskTimeoutMs:limits.timeoutMs,requestHooks:ledger.requestHooks({taskId:id,pricing:settings.pricing[selected.baseUrl+'\0'+selected.model]}),onTaskEnd:async({status}={})=>{aiActivity.end(id);if(operation){if(status==='cancelled')operation.cancelled=true;else if(status!=='completed')operation.failed=true;}await ledger.endTask(id);const index=operationTasks.indexOf(id);if(index>=0)operationTasks.splice(index,1);budgetSnapshot=await ledger.snapshot();dashboard?.refresh();}};}});
    const store=await createChatStore({...stateOptions,cwd,secrets:()=>secrets});personalization=await createPersonalization({...stateOptions,secrets:()=>secrets});
    chatSession=createChatSession({store,history,getConnection:()=>connection,getPending:()=>queuedInputs.map(input=>input.text)});
    const resumed=await chatSession.resumeLast();
    features=createFeatureCommands({cwd,settings,profiles,history,note,ask,getConnection:()=>connection,getEngine:()=>engine,reconnect:connect,configure,loadCredential:async selected=>liveKeys.get(credentialIdentity(selected))||await vault.load(selected),runTurn:turn,runCompact:compact,getSnapshot:snapshot,rememberSecret:key=>{if(!secrets.includes(key))secrets.push(key);},stop:()=>{assistantFeatures?.interruptSpeech();settings.serviceController?.abort();return engine?.interrupt().catch(()=>{});}});
    const chatBody=()=>history.snapshot().messages.map(message=>({text:`\n  ${message.role==='user'?'you':'sudo'}${message.model?' · '+safe(message.model):''}\n${safe(message.content)}\n`,user:message.role==='user'}));
    const restoreChat=async({reason}={})=>{await assistantFeatures?.stop();queuedInputs.length=0;settings.contextReview=undefined;settings.pendingAgentContext='';const record=chatSession.current();for(const text of record.pendingInputs||[])queuedInputs.push({text,recorded:false,literal:true});settings.attachments=[];settings.skills=[];if(reason==='new')dashboard?.clearBody();else dashboard?.replaceBody(chatBody());if(connection)await connect(connection,{carryHistory:true});else settings.pendingContext=history.snapshot().messages.length?history.toPrompt():'';if(reason==='new')dashboard?.clearBody();else dashboard?.replaceBody(chatBody());};
    assistantFeatures=createAssistantFeatures({cwd,stateDir:stateOptions.stateDir,settings,profiles,chatSession,personalization,note,ask,getConnection:()=>connection,reconnect:connect,onChatChange:restoreChat,enqueue,secrets:()=>secrets,loadCredential:async selected=>liveKeys.get(credentialIdentity(selected))||await vault.load(selected),extraInstructions:async()=>[await memory.instructions(),upgrades?.instructions()].filter(Boolean).join('\n\n'),capabilitiesFor:selected=>({...selected.capabilities,...settings.capabilityByIdentity?.[credentialIdentity(selected)]}),
      rememberSecret:key=>{if(!secrets.includes(key))secrets.push(key);},interrupt:()=>{assistantFeatures?.interruptSpeech();if(busy&&!currentPrompt)void engine?.interrupt().catch(()=>{});},
      onVoiceState:state=>{if(!busy&&!backgroundWorking)activity=state?.status||'Ready';dashboard?.refresh();},
      onBackgroundState:state=>{const working=['assessing','working'].includes(state?.state);backgroundWorking=working;if(working)aiActivity.begin('background','background');else aiActivity.end('background');dashboard?.refresh();},
      onBackgroundResult:async outcome=>{notifyBackground(outcome);const {job,text,reason,model,status}=outcome;history.addUser(`[24/7 task ${job.id}] ${job.prompt}`,{model});if(text)history.finishAssistant(`background:${randomUUID()}`,`Task status: ${status||'Needs review'}\n${text}`,{model});await checkpoint();note(`24/7 task ${job.id} ${status||'Needs review'}: ${text||reason||'Inspect /247 result for details.'}`);},
      onBackgroundError:notifyBackground,
      onApproval:async({method,params})=>{if(!interactive||quitting)return false;if(currentPrompt?.input)prompts.cancel();aiActivity.pause('background');dashboard?.refresh();notify('approval',`background:${params.itemId||params.callId||randomUUID()}`);note(`24/7 permission: ${method} · ${params.command||params.reason||'approval required'}`);try{return /^y(es)?$/i.test(await ask('  Allow once? [y/N] › '));}finally{backgroundWorking=!quitting&&['assessing','working'].includes(assistantFeatures?.snapshot().agent?.state);if(backgroundWorking)aiActivity.resume('background');else aiActivity.end('background');dashboard?.refresh();}},
    });
    upgrades=await createUpgradeCommands({cwd,...stateOptions,settings,memory,vault,workspace,workflow,profiles,history,note,ask:(prompt,hidden)=>ask(prompt,hidden,{raw:prompt==='  | '}),getConnection:()=>connection,getEngine:()=>engine,getToolCatalog:()=>bridge?.getToolCatalog?.()||[],secrets:()=>secrets,reconnect:connect,runTurn:turn,enqueue,runOperation,reconfigureBudget,getBudget:()=>ledger,stopBackground:()=>assistantFeatures.stopForPolicyChange(),getBackgroundConfig:()=>assistantFeatures.backgroundConfig(),rememberSecret:key=>{if(!secrets.includes(key))secrets.push(key);}});
    agents=await createAgentCommands({cwd,...stateOptions,settings,profiles,personalization,workspace,workflow,note,ask,getConnection:()=>connection,secrets:()=>secrets,
      loadCredential:async selected=>liveKeys.get(credentialIdentity(selected))||await vault.load(selected),rememberSecret:key=>{if(!secrets.includes(key))secrets.push(key);},
      extraInstructions:async()=>[await memory.instructions(),upgrades.instructions()].filter(Boolean).join('\n\n'),capabilitiesFor:selected=>({...selected.capabilities,...settings.capabilityByIdentity?.[credentialIdentity(selected)]}),runOperation,
      onState:state=>{if(state.name)activity=`Agent ${state.name}: ${state.status}`;dashboard?.refresh();},
      onTask:async({task,mode})=>{history.addUser(`[Agents ${mode}] ${task}`);await checkpoint();},onGuidance:async({name,text})=>{history.addUser(`[Agent ${name} guidance] ${text}`);await checkpoint();},
      onResult:async record=>{for(const result of record.results)history.finishAssistant(`agent:${record.id}:${result.name}`,`Agent ${result.name} (${result.model}) · ${result.status}\n${result.text||result.error||'No text returned.'}`,{model:result.model});const queued=queueAgentContext(settings,record);if(queued.truncated)note('Agent text was shortened for the next AI prompt. Full reports remain in /agents result.');await checkpoint();},
    });
    localFiles=createLocalFileCommands({cwd,settings,profiles,ask,note,reconnect:connect,runOperation});
    let resetRefresh=false;
    const resetPolicy=async change=>{await assistantFeatures.stopForPolicyChange();await change();resetRefresh=true;};
    const resetAction=(description,reset,extra={})=>({description,reset,...extra});
    resetCommands=createResetCommands({note,ask,actions:{
      bgcolor:resetAction('Restore the lower chat background.',()=>terminalTheme.reset('bgcolor'),{includeInAll:false}),
      textcolor:resetAction('Restore your text color.',()=>terminalTheme.reset('txtcolor'),{includeInAll:false}),
      notify:resetAction('Enable distinct AI event sounds.',()=>notifications.set('on')),
      colors:resetAction('Restore both chat colors.',()=>terminalTheme.reset('colors')),
      permissions:resetAction('Ask before actions requiring approval.',()=>resetPolicy(()=>{settings.permissions='ask';})),
      scope:resetAction('Use the project scope; planning and review remain read-only.',()=>resetPolicy(()=>{const readOnly=['plan','review'].includes(workflow.snapshot().mode);settings.scope=readOnly?'read-only':'project';settings.workflowWriteScope=readOnly?'project':undefined;})),
      web:resetAction('Turn web access off and close browser tools.',()=>resetPolicy(async()=>{await upgrades.stopBrowser();settings.webAccess=false;})),
      effort:resetAction('Use the model provider’s default reasoning.',()=>resetPolicy(()=>{settings.effort=undefined;})),
      tools:resetAction('Restore the full available tool catalog under current permissions.',()=>resetPolicy(()=>{settings.toolAllowlist=undefined;})),
      folders:resetAction('Remove additional writable folders.',()=>resetPolicy(()=>{settings.writableRoots=[];})),
      attachments:resetAction('Clear files queued for the next prompt; keep originals.',async()=>{settings.attachments=[];}),
      skills:resetAction('Clear skills queued for the next prompt.',async()=>{settings.skills=[];}),
      preferences:resetAction('Remove personalization for the selected AI only.',()=>resetPolicy(async()=>{await personalization.remove(connection);}),{available:()=>!!connection,includeInAll:false}),
      readability:resetAction('Enable clear reading.',()=>upgrades.handle({name:'/readability',args:['on']})),
      context:resetAction('Remove the reviewed replay summary; keep the complete chat and model capacity.',async()=>{settings.contextReview=undefined;if(connection)resetRefresh=true;}),
      routing:resetAction('Disable automatic AI routing.',async()=>{settings.routing={enabled:false};}),
      budget:resetAction('Disable local spending limits; keep counters and provider bills.',()=>upgrades.handle({name:'/budget',args:['off']})),
      voice:resetAction('Stop live voice and clear session voice services.',async()=>{await assistantFeatures.stopVoice();settings.microphone=false;settings.voiceService=undefined;settings.speechService=undefined;settings.voiceWakePhrase='';settings.voiceEchoMode=undefined;settings.lastSpokenReply=undefined;}),
      microphone:resetAction('Release the microphone and clear its selected device.',async()=>{await assistantFeatures.stopVoice();settings.microphone=false;settings.microphoneDevice=undefined;}),
      mcp:resetAction('Disconnect session MCP services and close browser tools.',()=>resetPolicy(async()=>{await upgrades.stopBrowser();settings.mcp.clear();settings.mcpTokens?.clear();settings.computerServers?.clear();settings.disabledComputerTools?.clear();})),
      'computer-use':resetAction('Turn computer control off.',()=>resetPolicy(()=>{settings.computerUse=false;})),
      memory:resetAction('Clear user-approved project memory.',()=>resetPolicy(()=>memory.clear()),{includeInAll:false}),
      updates:resetAction('Enable launch checks for panmm942-ui/sudo_cli.',async()=>{updateSettings={repository:DEFAULT_GITHUB_REPOSITORY,enabled:true};await saveUpdates();}),
      loopguard:resetAction('Enable repetition protection and a 120-second native command timeout.',async()=>{loopSettings={enabled:true,repeatLimit:4,timeoutMs:120000};await saveLoopSettings();}),
      workflow:resetAction('Restore editing workflow under the project scope.',()=>resetPolicy(()=>{workflow.setMode('edit');settings.workflowWriteScope=undefined;settings.scope='project';})),
      checks:resetAction('Clear configured acceptance commands; keep past results.',()=>upgrades.handle({name:'/checks',args:['clear']})),
      status:resetAction('Hide the optional connection percentage estimate.',()=>upgrades.handle({name:'/status',args:['percent','off']})),
      ai:resetAction('Disconnect this AI; preserve saved AIs, credentials and chat.',async()=>{await assistantFeatures.stopForPolicyChange();await cleanup();connection=undefined;settings.pendingContext=history.toPrompt();session.updateConnection(undefined);activity='Offline shell';dashboard?.refresh();},{includeInAll:false}),
    }});
    const handleReset=async command=>{resetRefresh=false;const normalized=command.name==='/reset'&&command.args?.[0]?.toLowerCase()==='txtcolor'?{...command,args:['textcolor',...command.args.slice(1)]}:command;try{return await resetCommands.handle(normalized);}finally{if(resetRefresh&&connection)await connect(connection,{carryHistory:true});}};
    if(interactive){await network.start();performanceMonitor.start();}
    if(selected||opts.model){try{await connect(selected||await configure());}catch(error){if(once)throw error;await cleanup();connection=undefined;session.updateConnection(undefined);note(`Connection setup failed: ${error.message}. Continuing offline; /chat remains available.`);}}
    else {note('Ready. Local AI on this PC: /local. Model file: /local file "PATH". Cloud AI: /connect.');note('Type / to choose a command. Saved AIs: /switch. Saved chats: /chat.');note('Customize each AI: /personalize setup or /preferences setup. Saved specialists: /agents.');}
    if(resumed){dashboard?.replaceBody(chatBody());settings.pendingContext=history.snapshot().messages.length?history.toPrompt():'';for(const text of resumed.pendingInputs||[])queuedInputs.push({text,recorded:false,literal:true});if(!once)note(`Resumed chat: ${resumed.title}. /new starts another; /chat opens saved chats.`);}
    await chatSession.ensure();await checkpoint();
    if(interactive&&updateSettings.enabled){try{await checkUpdates();}catch(error){if(error.name!=='AbortError'&&!quitting)note(`Update check: ${error.message}`);}}
    saveTimer=setInterval(()=>{if((busy||backgroundWorking)&&saving===0)void checkpoint();},1000);saveTimer.unref();
    if (once) { await turn(opts.once); return; }
    while (!quitting) {
      const queued=engine?queuedInputs.shift():undefined;
      let text;
      try{if(queued)text=queued.text;else text=await ask(green('\n  you › '),false,{input:true});}
      catch(error){if(error.name==='AbortError'){if(quitting)break;continue;}throw error;}
      if (!text) continue;
      if(!queued)dashboard?.remember(`\n  you › ${safe(text)}\n`,{user:true});
      else if(!queued.displayed&&dashboard){dashboard.write(`\n  you › ${safe(text)}\n`,{user:true});queued.displayed=true;}
      if (!queued?.literal&&(text === '/quit' || text === '/exit')) break;
      try {
        const command=queued?.literal?null:parseCommand(text);
        if(command){if(['/permissions','/web','/computer-use','/mcp','/personalize','/preferences'].includes(command.name)&&command.args.length&&!['status','list','tools'].includes(command.args[0])){await assistantFeatures.stopForPolicyChange();if((command.name==='/web'&&command.args[0]==='off')||(command.name==='/computer-use'&&command.args[0]==='off'))await upgrades.stopBrowser();}if(command.name==='/switch')settings.routing={enabled:false};if(!await handleRuntimeCommands(command)&&!await handleReset(command)&&!await localFiles.handle(command)&&!await agents.handle(command)&&!await upgrades.handle(command)&&!await assistantFeatures.handle(command)&&!await features.handle(command))note('Unknown command. Enter / or /help for the menu.');await checkpoint();}
        else {
          try { await turn(text,{recorded:queued?.recorded}); }
          catch (error) { if (!quitting){notifyError(error);note(`Task failed: ${error.message}`);} }
        }
      } catch (error) { if (!quitting){notifyError(error);note(error.message);} }
    }
  } catch (error) {
    if (!quitting||isSessionCleanupError(error)) {const visible=new Error(safe(error.message));if(isSessionCleanupError(error))visible.code=error.code;primaryFailure=visible;throw visible;}
  } finally {
    quitting=true;clearInterval(saveTimer);
    aiActivity.clear();
    process.removeListener('SIGINT', signal);
    process.removeListener('SIGTERM', terminate);
    process.removeListener('SIGHUP', terminate);
    prompts.close();
    rl?.close();
    terminalInput?.detach();scrollInput?.detach();pasteInput?.detach();if(interactive&&process.env.TERM!=='dumb')process.stdout.write('\x1b[?1000l\x1b[?1006l\x1b[?2004l');
    await assistantFeatures?.stop().catch(error=>note(error.message));
    await upgrades?.close().catch(error=>note(error.message));
    agents?.close();
    let finalCleanupError;
    try{await cleanup(primaryFailure);}catch(error){finalCleanupError=error;}
    await checkpoint();await chatSession?.flush().catch(()=>note('The final chat checkpoint could not be saved.'));
    network.stop();
    await performanceMonitor.stop();
    await workMeter?.close().catch(() => note('Worked-time totals could not be saved.'));
    session.setWorking(false); session.markOffline(); activity = 'Session closed'; dashboard?.refresh(); dashboard?.stop();
    await Promise.allSettled([...notificationDeliveries]);
    await notifications.close().catch(()=>note('Notification sound cleanup needs review.'));
    liveKeys.clear();secrets = [];
    finalCleanupError??=backgroundCleanupFailure;
    if(finalCleanupError){process.exitCode=1;throw finalCleanupError;}
  }
}
