import { spawnSync } from 'node:child_process';
import { VERSION } from './version.mjs';
import { validateReasoningEffort } from './runtime.mjs';

const HELP = `codexcli ${VERSION} | sudocli (sudo cli)
Your terminal. Your model. Powered by the open-source Codex engine.

First setup: node scripts/setup.mjs (or setup.cmd / sh ./setup)
Start: sudocli in an Administrator terminal (Windows), or sudo with the launcher path (Linux/macOS).
Start offline. /local connects a local runner; /connect configures a cloud/API model.
/local file "PATH" inspects a model file and offers supported installed runners.
Type / for the command picker. /switch saves optional model profiles.

Options:
  --model ID                Model served by your endpoint
  --base-url URL            API base URL, usually ending /v1
  --transport FORMAT        chat-completions (default) or responses
  --api-key-env NAME        Read an API key from an environment variable
  --context-window TOKENS   Optional model context limit
  --effort LEVEL            Optional standard reasoning request; provider-dependent
  --cwd DIRECTORY          Project directory (default: current directory)
  --mcp NAME=URL            Connect an HTTP MCP tool server; repeatable
  --permissions MODE        ask (default) or allow-everything
  --scope MODE              read-only, project (default), or full
  --web on|off              Agent web tools/network access (default: off)
  --once PROMPT             Run one task without the interactive UI
  doctor                    Check the local engine without calling a model
  --help, --version

Environment: SUDO_CLI_MODEL, SUDO_CLI_BASE_URL, SUDO_CLI_TRANSPORT,
SUDO_CLI_API_KEY, SUDO_CLI_CODEX (optional engine executable).
Keys stay in memory. Saved profiles exclude keys. Chats resume automatically per project.
/personalize sets per-AI preferences; /voice live starts configured continuous voice.
/247 starts the local-first agent; /247 detach survives terminal close.
Model sessions require administrator/root. Help/version/doctor/setup do not elevate.
`;

function parse(args) {
  if (args[0] === 'cli') args = args.slice(1);
  const opts = { mcp: [] };
  const values = { '--model': 'model', '--base-url': 'baseUrl', '--transport': 'transport', '--api-key-env': 'apiKeyEnv', '--context-window': 'contextWindow', '--effort':'effort', '--cwd': 'cwd', '--once': 'once', '--permissions': 'permissions','--scope':'scope', '--web': 'web' };
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === '--help' || arg === '-h') opts.help = true;
    else if (arg === '--version' || arg === '-V') opts.version = true;
    else if (arg === 'doctor' && args.length === 1) opts.doctor = true;
    else if (arg === '--mcp' || values[arg]) {
      const value = args[++i];
      if (value === undefined || value.startsWith('--')) throw new Error(`Missing value for ${arg}.`);
      if (arg === '--mcp') opts.mcp.push(value);
      else opts[values[arg]] = value;
    } else throw new Error(`Unknown option: ${arg.startsWith('--') ? arg : '(positional argument)'}. Use --help.`);
  }
  if (opts.permissions && !['ask', 'allow-everything'].includes(opts.permissions)) throw new Error('Use --permissions ask or allow-everything.');
  if(opts.scope&&!['read-only','project','full'].includes(opts.scope))throw new Error('Use --scope read-only, project or full.');
  if (opts.web && !['on', 'off'].includes(opts.web)) throw new Error('Use --web on or off.');
  if(opts.effort)opts.effort=validateReasoningEffort(opts.effort==='default'?undefined:opts.effort);
  return opts;
}

async function main() {
  const opts = parse(process.argv.slice(2));
  if (opts.help) { process.stdout.write(HELP); return; }
  if (opts.version) { process.stdout.write(`codexcli ${VERSION} | sudocli\n`); return; }
  if (opts.doctor) {
    const { localCodex } = await import('./local-engine.mjs');
    process.stdout.write(`codexcli ${VERSION} | sudocli\nNode ${process.versions.node}\n`);
    const engine = localCodex();
    const result = spawnSync(engine, ['--version'], { encoding: 'utf8', windowsHide: true, timeout: 10000, shell: false });
    if (result.error || result.status !== 0) throw new Error('The Codex engine could not start. Set SUDO_CLI_CODEX to a working executable.');
    process.stdout.write(`Engine: ${result.stdout.trim()}\nReady. Model configuration happens at launch; no connection was made.\n`);
    return;
  }
  if (!process.stdin.isTTY && opts.once === undefined) {
    const { ART } = await import('./dashboard.mjs');
    process.stdout.write(ART + '\n');
    return;
  }
  const { runUI } = await import('./ui.mjs');
  await runUI(opts);
}

main().catch((error) => {
  const text = String(error.message || error).replace(/[\u001b\u0000-\u0008\u000b-\u001f\u007f]/g, '');
  process.stderr.write(`sudocli: ${text}\n`);
  process.exitCode = 1;
});
