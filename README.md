# sudo cli

Your terminal. Your model.

**sudo cli 0.2.0** is a terminal-only coding assistant built on the open-source Codex engine. Choose the cloud or self-hosted model while the program runs. Model settings and API keys stay in the current session; you do not edit a configuration file. There is no desktop window or web interface.

The frontend supports **Windows, Linux, and macOS** on x64 or arm64 with the matching native engine. The Windows x64 portable bundle includes Node.js and Codex. The cross-platform source bundle includes a local installer for the other runtimes. It does not change the ChatGPT/Codex desktop app, alter its configuration, or reuse its login.

The separately supplied cross-platform ZIP omits executable runtimes. It requires Node.js 22+. Install the matching engine locally with `node scripts/setup-runtime.mjs`; no global installation or configuration editing is needed. See the [platform guide](docs/platforms.md).

## Linux and macOS

Extract the cross-platform ZIP and open a terminal in its `sudo-cli` folder:

```sh
node scripts/setup-runtime.mjs
sh ./sudo cli
```

The setup script detects OS/architecture and downloads the pinned, SHA-256-verified official Codex runtime. It writes only into this project's runtime directory. `sh ./sudo-cli doctor` checks the runtime. `chmod +x sudo sudo-cli` enables `./sudo cli` directly.

Windows and native Linux execution are verified. macOS runtime selection and installer behavior are covered by automated tests; execution on a Mac is still pending. A three-OS CI workflow is included for that native check when this source is placed in a GitHub repository.

## Windows

Extract the portable ZIP, open PowerShell in the `sudo-cli` folder, and run:

```powershell
.\sudo-cli.cmd
```

The local two-word alias also works:

```powershell
.\sudo cli
```

For a coding project, choose its directory:

```powershell
.\sudo-cli.cmd --cwd "C:\Projects\my-project"
```

The wizard asks for a model ID, API base URL, API format, and a hidden API key. Use the provider's exact model ID and base URL, commonly ending in `/v1`. Select Chat Completions for a compatible `/chat/completions` endpoint, or Responses for a compatible `/responses` endpoint. Leave the key empty for an unauthenticated local server. Invalid wizard fields are explained and asked again.

No model is preselected. Kimi, MiMo, GLM, and other providers can be configured later when you have their endpoint and model ID. Their live endpoints and model-specific behavior have not been tested in this build.

## Terminal dashboard

A large `SUDO CLI` ASCII banner sits beside these live fields:

- **Time:** local date, clock, and timezone, updated each second.
- **Software System:** detected Windows, Linux, or macOS and architecture.
- **Working:** green `Working` during an AI turn and its tools; red `Not working` when idle.
- **Status:** green `Online` after an actual API response; red `Offline` before confirmation or after a connection/authentication failure. Initial setup is explicitly marked `not checked`.
- **Connected AI:** the confirmed model ID, or `No AI connected`.
- **Context:** percentage and tokens used/available from the engine's latest token report. Unknown values stay unknown. `~` indicates the last reported context, which can exclude later local tool results. This is context occupancy, not cumulative billing usage.
- **Activity** and **Project:** current action and working directory name.

The header stays above the scrolling conversation in supported terminals. It uses cyan for the banner, muted labels, and green/red state values. `NO_COLOR=1` disables colors. Narrow terminals stack the details; very small or legacy terminals show a plain header and state updates. No live header or terminal escape sequences are added to `--once` response output.

## During a session

| Input | Action |
| --- | --- |
| A normal message | Ask the agent to inspect, code, or work in the project |
| `/connect` | Choose a new endpoint, model, format, and key; start a new conversation |
| `/model MODEL_ID` | Change the model on the current endpoint and keep the conversation |
| `/clear` | Start a new conversation with the same connection |
| `/status` | Show the active model and endpoint without the key |
| `/help` | Show commands |
| `/quit` | Close the session |
| Ctrl+C | Interrupt active work, or exit when idle |

The interface displays assistant messages, tool activity, and one-time permission prompts. Prompts are serialized when several tools request permission. The engine uses workspace permissions and asks when extra permission is required. The name does not grant administrator privileges.

## Terminal options

```powershell
.\sudo-cli.cmd doctor
.\sudo-cli.cmd --help
```

Optional launch flags can supply initial settings without a file. Keep keys in environment variables or enter them in the hidden wizard; there is no API-key command-line option.

```powershell
# MY_MODEL_KEY is an environment variable you have already set.
.\sudo-cli.cmd --model "provider-model-id" --base-url "https://api.example.com/v1" --transport chat-completions --api-key-env MY_MODEL_KEY --cwd "C:\Projects\my-project"
```

`--once "task"` runs one task without the interactive screen. It declines permission requests because nobody is there to approve them. Use the interactive screen for operations requiring approval.

Other options: `--context-window TOKENS` and repeatable `--mcp NAME=URL`. Environment defaults: `SUDO_CLI_MODEL`, `SUDO_CLI_BASE_URL`, `SUDO_CLI_TRANSPORT`, `SUDO_CLI_API_KEY`. `SUDO_CLI_CODEX` explicitly selects another compatible native engine executable; otherwise the bundled engine is used first.

## Search, browser, and computer tools

The Codex engine can connect to HTTP MCP tool servers at launch:

```powershell
.\sudo-cli.cmd --mcp browser=http://127.0.0.1:8931/mcp --mcp search=https://your-search-server.example/mcp
```

These are illustrative URLs: you must run or have access to those tool servers. A server can supply search, browser interaction, desktop actions, or other tools. Screenshot content is carried through the Chat Completions bridge when the model supports image inputs. This bundle does not provision a browser/desktop tool server, search service, training service, or cloud GPU host. Tool availability and performance depend on the connected service and model. Servers requiring a separate authentication setup are not configured by this initial launcher.

## How it reuses Codex

The custom frontend in `bin/` and `src/` starts a private `codex --no-daemon app-server --listen stdio://` process and uses its JSON-RPC protocol. Codex provides the agent loop, project tools, execution approvals, MCP integration, and context handling. The frontend supplies its own screen, runtime wizard, and API compatibility bridge.

The bundle uses the official native Codex **0.160.1** release package in `runtime/win32-x64/`. Linux and macOS setup obtains the matching native package. The complete open-source snapshot is included as [`upstream/codex-rust-v0.160.1-source.zip`](upstream/codex-rust-v0.160.1-source.zip), from tag `rust-v0.160.1`, commit `d27764b82f7118f674371e6d6e76271d9d606edb`. The Rust engine is unchanged and was not recompiled for this build. The new interface builds on its public app-server layer. See [OpenAI's source repository](https://github.com/openai/codex/tree/rust-v0.160.1) for the engine's build instructions.

A temporary, empty `CODEX_HOME` isolates every session from desktop settings and authentication. The frontend passes settings for that process only and requires an ephemeral thread. It removes the temporary home when the UI exits, including idle Ctrl+C or stdin closure. Interrupting a task keeps the current session available. The engine may create transient runtime files there. Abrupt process termination or power loss can leave that temporary directory behind; conversation resume and saved profiles are not implemented in this version.

The Chat Completions bridge listens on an authenticated random localhost port. It translates text, images, tool history, functions, namespaced tools, and custom patch input. It buffers each upstream generation before emitting Responses events. Custom tool grammars are passed as model instructions rather than enforced by a grammar decoder. OpenAI-hosted search/tools and `previous_response_id` are rejected by the bridge; tool servers can provide equivalent external capabilities.

This is a working initial CLI with its own interface. It does not reproduce every Codex desktop feature, OpenAI-managed service, or provider-specific model feature.

## Development and verification

No npm packages are needed. With the included runtime:

```powershell
.\runtime\node.exe --test
.\runtime\node.exe bin\sudo-cli.mjs doctor
```

Tests exercise actual HTTP servers, spawned protocol processes, interruption and permission handling, streamed secret redaction, runtime setup, dashboard rendering, context reports, OS/architecture selection, and the real Codex engine. The external model boundary is replaced by a deterministic localhost fixture; integration checks include a real workspace file write and native Responses streaming. A Linux PTY check also verifies clock updates, state colors, hidden key entry during resizing, and typed-input preservation. No paid API was used.

See [`docs/verification.md`](docs/verification.md) for the final results, [`runtime/manifest.json`](runtime/manifest.json) for binary hashes, and [`THIRD_PARTY.md`](THIRD_PARTY.md) for licensing.
