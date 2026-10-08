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
  let activity = 'Configure connection', currentPrompt = null;

  let muted = false;
  const output = new Writable({ write(chunk, encoding, done) { if (!muted) process.stdout.write(chunk, encoding); done(); } });
  output.isTTY = process.stdout.isTTY;
  Object.defineProperty(output, 'columns', { get: () => process.stdout.columns });
  const rl = interactive ? createInterface({ input: process.stdin, output, terminal: true }) : null;
  const prompts = createPromptQueue({ question: async (prompt, { signal, hidden }) => {
    if (!rl) throw new Error('Provide --model and --base-url, or launch sudo-cli in an interactive terminal.');
    currentPrompt = { prompt, hidden };
    if (hidden) { process.stdout.write(prompt); muted = true; }
    try { return (await rl.question(hidden ? '' : prompt, { signal })).trim(); }
    finally { if (hidden) { muted = false; process.stdout.write('\n'); } currentPrompt = null; }
  } });
  const ask = (prompt, hidden = false) => prompts.ask(cyan(prompt), hidden);

  let engine, bridge, home, connection, busy = false, quitting = false, hasText = false;
  const displayed = new Set();
  if (interactive) dashboard = createDashboard({ snapshot: () => session.snapshot(), activity: () => activity, color,
    onResize: () => {
      if (!currentPrompt || !rl) return;
      if (currentPrompt.hidden) process.stdout.write(currentPrompt.prompt);
      else rl.prompt(true);
    },
  });

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
    session.updateConnection(selected);
    activity = 'Starting engine'; dashboard?.refresh();
    displayed.clear();
    home = await createSessionHome();
    const env = { ...process.env, CODEX_HOME: home.path, SUDO_CLI_SESSION_KEY: selected.apiKey || '' };
    let baseUrl = selected.baseUrl;
    if (selected.transport === 'chat-completions') {
      bridge = await startBridge({ baseUrl, model: selected.model, apiKey: selected.apiKey });
      baseUrl = bridge.baseUrl;
      env.SUDO_CLI_SESSION_KEY = bridge.token;
      secrets.push(bridge.token);
    }
    const args = providerArgs(selected, { baseUrl, keyEnv: 'SUDO_CLI_SESSION_KEY' });
    for (const entry of opts.mcp) {
      const match = /^([A-Za-z][A-Za-z0-9_-]*)=(https?:\/\/.+)$/.exec(entry);
      if (!match) throw new Error('Use --mcp NAME=URL with a simple server name and HTTP URL.');
      const url = new URL(match[2]);
      if (url.username || url.password || url.hash) throw new Error('MCP URLs must not contain credentials or fragments.');
      args.push('-c', `mcp_servers.${match[1]}.url=${JSON.stringify(url.href)}`);
    }
    engine = await createEngine({ codexPath: localCodex(), cwd, model: selected.model, providerArgs: args, env, onEvent: event,
      onApproval: async ({ method, params }) => {
        if (!interactive) return false;
        activity = 'Waiting for permission'; dashboard?.refresh();
        note(`Permission requested: ${method}`);
        note(params.command || params.reason || 'This action needs your permission.');
        if (params.cwd) note(`Directory: ${params.cwd}`);
        if (params.grantRoot) note(`Requested write access: ${params.grantRoot}`);
        if (params.fileChanges) note(`Files: ${Object.keys(params.fileChanges).join(', ')}`);
        if (params.permissions) note(`Requested permissions: ${JSON.stringify(params.permissions)}`);
        try { return /^y(es)?$/i.test(await ask(cyan('  Allow once? [y/N] › '))); }
        finally { activity = 'Working'; dashboard?.refresh(); }
      },
    });
    connection = selected;
    session.bindThread(engine.threadId);
    activity = 'Ready'; dashboard?.refresh();
    if (!once) {
      note(`Configured: ${selected.model} · ${new URL(selected.baseUrl).host}. API status is confirmed by its first response.`);
      note('Enter a task. /model changes the model; /connect starts a new connection.');
    }
  };

  const turn = async (text) => {
    hasText = false; assistantOutput.reset(); busy = true;
    session.setWorking(true); activity = 'Waiting for AI'; dashboard?.refresh();
    if (!once) note('Working · Ctrl+C to interrupt');
    try {
      const result = await engine.startTurn(text, { model: connection.model });
      if (result.status === 'completed') session.markOnline();
    } finally {
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
  rl?.on('SIGINT', signal);
  rl?.once('close', terminate);
  try {
    dashboard?.start();
    await connect(await configure());
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
          note('/quit — close sudo cli · Ctrl+C interrupts work');
        } else if (text === '/status') {
          note(`${connection.model} · ${new URL(connection.baseUrl).host} · ${connection.transport}`);
          const current = session.snapshot();
          note(`Status: ${current.status} · Working: ${current.working ? 'Working' : 'Not working'}`);
          note(`Context (last reported): ${current.context.used ?? 'unknown'} / ${current.context.limit ?? 'unknown'} tokens · ${current.context.percent == null ? 'unknown' : current.context.percent + '%'}`);
          note('Settings and credentials are held in memory only.');
        } else if (text.startsWith('/model ')) {
          const model = text.slice(7).trim();
          connection = validateConnection({ ...connection, model });
          session.updateConnection(connection); dashboard?.refresh();
          note(`Model: ${model}`);
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
    prompts.close();
    rl?.close();
    await cleanup();
    session.setWorking(false); session.markOffline(); activity = 'Session closed'; dashboard?.refresh(); dashboard?.stop();
    secrets = [];
  }
}
