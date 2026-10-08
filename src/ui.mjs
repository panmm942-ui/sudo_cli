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

export async function runUI(opts) {
  const once = opts.once !== undefined;
  const interactive = !!process.stdin.isTTY && !once;
  const color = process.stdout.isTTY && !process.env.NO_COLOR && process.env.TERM !== 'dumb';
  const paint = (code, text) => color ? `\x1b[${code}m${text}\x1b[0m` : text;
  const cyan = (s) => paint('96', s);
  const dim = (s) => paint('90', s);
  let secrets = [];
  const assistantOutput = createRedactor({ secrets: () => secrets });
  const safe = (value) => {
    let text = stripVTControlCharacters(String(value ?? '')).replace(/[\u0000-\u0008\u000b-\u001f\u007f]/g, '');
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
  const session = createSessionState({ cwd });
  let permissions = opts.permissions || 'ask', webAccess = opts.web === 'on';
  let health = createConnectionHealth(), workMeter;
  const snapshot = () => ({ ...session.snapshot(), permissions, webAccess, health: health.snapshot(), worked: workMeter?.snapshot() });
  let activity = 'Configure connection', currentPrompt = null;

  let muted = false;
  const output = new Writable({ write(chunk, encoding, done) { if (!muted) process.stdout.write(chunk, encoding); done(); } });
  output.isTTY = process.stdout.isTTY;
  Object.defineProperty(output, 'columns', { get: () => process.stdout.columns });
  const rl = interactive ? createInterface({ input: process.stdin, output, terminal: true }) : null;
  const prompts = createPromptQueue({ question: async (prompt, { signal, hidden }) => {
    if (!rl) throw new Error('Provide --model and --base-url, or launch sudocli in an interactive terminal.');
    currentPrompt = { prompt, hidden };
    if (hidden) { process.stdout.write(prompt); muted = true; }
    try { return (await rl.question(hidden ? '' : prompt, { signal })).trim(); }
    finally { if (hidden) { muted = false; process.stdout.write('\n'); } currentPrompt = null; }
  } });
  const ask = (prompt, hidden = false) => prompts.ask(cyan(prompt), hidden);

  let engine, bridge, home, connection, busy = false, quitting = false, hasText = false;
  const displayed = new Set();
  if (interactive) dashboard = createDashboard({ snapshot, activity: () => activity, color,
    onResize: () => {
      if (!currentPrompt || !rl) return;
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
    secrets = selected.apiKey ? [selected.apiKey] : [];
    return selected;
  };

  const event = ({ method, params = {} }) => {
    session.applyEvent({ method, params });
    dashboard?.refresh();
    if (method === 'item/agentMessage/delta') {
      if (!hasText && !once) write(`\n${cyan('  sudo')}\n`);
      hasText = true;
      displayed.add(params.itemId);
      write(assistantOutput.write(params.delta));
    } else if (method === 'item/completed' && params.item?.type === 'agentMessage') {
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

  const connect = async (selected) => {
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
    const args = providerArgs(selected, { baseUrl, keyEnv: 'SUDO_CLI_SESSION_KEY', permissions, webAccess });
    for (const entry of opts.mcp || []) {
      const match = /^([A-Za-z][A-Za-z0-9_-]*)=(https?:\/\/.+)$/.exec(entry);
      if (!match) throw new Error('Use --mcp NAME=URL with a simple server name and HTTP URL.');
      const url = new URL(match[2]);
      if (url.username || url.password || url.hash) throw new Error('MCP URLs must not contain credentials or fragments.');
      if (webAccess) args.push('-c', `mcp_servers.${match[1]}.url=${JSON.stringify(url.href)}`);
    }
    engine = await createEngine({ codexPath: localCodex(), cwd, model: selected.model, providerArgs: args, env, onEvent: event, permissions, webAccess,
      onApproval: async ({ method, params }) => {
        if (!interactive) return false;
        workMeter?.pause();
        activity = 'Waiting for permission'; dashboard?.refresh();
        note(`Permission requested: ${method}`);
        note(params.command || params.reason || 'This action needs your permission.');
        if (params.cwd) note(`Directory: ${params.cwd}`);
        if (params.grantRoot) note(`Requested write access: ${params.grantRoot}`);
        if (params.fileChanges) note(`Files: ${Object.keys(params.fileChanges).join(', ')}`);
        if (params.permissions) note(`Requested permissions: ${JSON.stringify(params.permissions)}`);
        try { return /^y(es)?$/i.test(await ask(cyan('  Allow once? [y/N] › '))); }
        finally { if (busy && !quitting) workMeter?.start(); activity = 'Working'; dashboard?.refresh(); }
      },
    });
    connection = selected;
    session.bindThread(engine.threadId);
    activity = 'Ready'; dashboard?.refresh();
    if (!once) {
      note(`Configured: ${selected.model} · ${new URL(selected.baseUrl).host}. API status is confirmed by its first response.`);
      note('Enter a task. /model changes the model; /connect starts a new connection.');
      if (!webAccess && permissions === 'allow-everything') note('Web tools are Off. Allow Everything still permits commands to use the OS network.');
      if (engine.runtimePolicy?.sandbox?.type === 'readOnly') note('Native engine is using a read-only sandbox here; writes may require approval.');
      if (!webAccess && opts.mcp?.length) note('HTTP MCP servers are disabled until /web on.');
    }
  };

  const turn = async (text) => {
    hasText = false; assistantOutput.reset(); busy = true;
    workMeter?.start();
    session.setWorking(true); activity = 'Waiting for AI'; dashboard?.refresh();
    if (!once) note('Working · Ctrl+C to interrupt');
    try {
      const result = await engine.startTurn(text, { model: connection.model });
      if (result.status === 'completed') session.markOnline();
    } finally {
      workMeter?.pause();
      await workMeter?.flush().catch(() => note('Worked-time totals could not be saved.'));
      busy = false; session.setWorking(false); activity = 'Ready'; dashboard?.refresh();
      write(assistantOutput.flush()); if (hasText) write('\n');
    }
  };
  const signal = () => {
    prompts.cancel();
    if (busy) { note('Interrupting…'); engine?.interrupt().catch(() => {}); }
    else { quitting = true; prompts.close(); rl?.close(); }
  };
  const terminate = () => { quitting = true; prompts.close(); rl?.close(); engine?.close().catch(() => {}); };
  process.on('SIGINT', signal);
  process.on('SIGTERM', terminate);
  process.on('SIGHUP', terminate);
  rl?.on('SIGINT', signal);
  rl?.once('close', terminate);
  try {
    dashboard?.start();
    const selected = await configure();
    workMeter = await createWorkMeter({ ...(process.env.SUDO_CLI_STATE_DIR ? { stateDir: resolve(process.env.SUDO_CLI_STATE_DIR) } : {}) });
    await connect(selected);
    if (once) { await turn(opts.once); return; }
    while (!quitting) {
      const text = await ask(cyan('\n  you › '));
      if (!text) continue;
      if (text === '/quit' || text === '/exit') break;
      try {
        if (text === '/help') {
          note('/connect — choose a new endpoint/model (fresh conversation)');
          note('/model ID — change model on the current endpoint');
          note('/clear — start a fresh conversation');
          note('/status — show current connection');
          note('/permissions ask|allow-everything — change access (fresh conversation)');
          note('/web on|off — enable/disable web tools (fresh conversation)');
          note('/quit — close sudocli · Ctrl+C interrupts work');
        } else if (text === '/status') {
          note(`${connection.model} · ${new URL(connection.baseUrl).host} · ${connection.transport}`);
          const current = snapshot();
          note(`Status: ${current.status} · Working: ${current.working ? 'Working' : 'Not working'}`);
          note(`Context (last reported): ${current.context.used ?? 'unknown'} / ${current.context.limit ?? 'unknown'} tokens · ${current.context.percent == null ? 'unknown' : current.context.percent + '%'}`);
          note(`Connection: ${current.health.percent == null ? 'Not measured' : current.health.percent + '%'} (observed latency/error estimate)`);
          note(`Permissions: ${permissions === 'ask' ? 'Ask' : 'Allow Everything'} · Web Access: ${webAccess ? 'On' : 'Off'}`);
          note(`Worked: ${workedTime(current.worked?.sessionMs)} | In Total: ${workedTime(current.worked?.totalMs)}`);
          note('Model settings and credentials stay in memory. Only worked-time totals persist.');
        } else if (text.startsWith('/model ')) {
          const model = text.slice(7).trim();
          connection = validateConnection({ ...connection, model });
          health = createConnectionHealth();
          session.updateConnection(connection); dashboard?.refresh();
          note(`Model: ${model}`);
        } else if (text.startsWith('/permissions ')) {
          const mode = text.slice(13).trim().toLowerCase().replace(/ /g, '-');
          if (!['ask', 'allow-everything'].includes(mode)) throw new Error('Use /permissions ask or /permissions allow-everything.');
          permissions = mode; await connect(connection);
        } else if (text.startsWith('/web ')) {
          const mode = text.slice(5).trim().toLowerCase();
          if (!['on', 'off'].includes(mode)) throw new Error('Use /web on or /web off.');
          webAccess = mode === 'on'; await connect(connection);
        } else if (text === '/clear') await connect(connection);
        else if (text === '/connect') await connect(await configure(true));
        else if (text.startsWith('/')) note('Unknown command. Use /help.');
        else {
          try { await turn(text); }
          catch (error) { if (!quitting) note(`Task failed: ${error.message}`); }
        }
      } catch (error) { if (!quitting) note(error.message); }
    }
  } catch (error) {
    if (!quitting) throw new Error(safe(error.message));
  } finally {
    process.removeListener('SIGINT', signal);
    process.removeListener('SIGTERM', terminate);
    process.removeListener('SIGHUP', terminate);
    prompts.close();
    rl?.close();
    await cleanup();
    await workMeter?.close().catch(() => note('Worked-time totals could not be saved.'));
    session.setWorking(false); session.markOffline(); activity = 'Session closed'; dashboard?.refresh(); dashboard?.stop();
    secrets = [];
  }
}
