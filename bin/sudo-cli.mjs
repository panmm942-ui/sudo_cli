#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
import { VERSION } from '../src/version.mjs';

const HELP = `sudo cli ${VERSION}
Your terminal. Your model. Powered by the open-source Codex engine.

Start: sudo-cli
Choose a model, endpoint and key interactively. Settings last only this session.

Options:
  --model ID                Model served by your endpoint
  --base-url URL            API base URL, usually ending /v1
  --transport FORMAT        chat-completions (default) or responses
  --api-key-env NAME        Read an API key from an environment variable
  --context-window TOKENS   Optional model context limit
  --cwd DIRECTORY          Project directory (default: current directory)
  --mcp NAME=URL            Connect an HTTP MCP tool server; repeatable
  --once PROMPT             Run one task without the interactive UI
  doctor                    Check the local engine without calling a model
  --help, --version

Environment: SUDO_CLI_MODEL, SUDO_CLI_BASE_URL, SUDO_CLI_TRANSPORT,
SUDO_CLI_API_KEY, SUDO_CLI_CODEX (optional engine executable).
No settings or API keys are saved. sudo cli does not elevate privileges.
`;

function parse(args) {
  if (args[0] === 'cli') args = args.slice(1);
  const opts = { mcp: [] };
  const values = { '--model': 'model', '--base-url': 'baseUrl', '--transport': 'transport', '--api-key-env': 'apiKeyEnv', '--context-window': 'contextWindow', '--cwd': 'cwd', '--once': 'once' };
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
  return opts;
}

async function main() {
  const opts = parse(process.argv.slice(2));
  if (opts.help) { process.stdout.write(HELP); return; }
  if (opts.version) { process.stdout.write(`sudo cli ${VERSION}\n`); return; }
  if (opts.doctor) {
    const { localCodex } = await import('../src/local-engine.mjs');
    process.stdout.write(`sudo cli ${VERSION}\nNode ${process.versions.node}\n`);
    const engine = localCodex();
    const result = spawnSync(engine, ['--version'], { encoding: 'utf8', windowsHide: true, timeout: 10000, shell: false });
    if (result.error || result.status !== 0) throw new Error('The Codex engine could not start. Set SUDO_CLI_CODEX to a working executable.');
    process.stdout.write(`Engine: ${result.stdout.trim()}\nReady. Model configuration happens at launch; no connection was made.\n`);
    return;
  }
  const { runUI } = await import('../src/ui.mjs');
  await runUI(opts);
}

main().catch((error) => {
  const text = String(error.message || error).replace(/[\u001b\u0000-\u0008\u000b-\u001f\u007f]/g, '');
  process.stderr.write(`sudo cli: ${text}\n`);
  process.exitCode = 1;
});
