# sudo cli

Build a runnable personal CLI named **sudo cli**, invoked as `sudo-cli`. Reuse the open-source Codex app-server engine for file/shell tools, context management, approvals and MCP. The frontend is a different terminal UI, not the Codex screen. OpenAI model weights and managed services are separate.

The user authorized implementation and clarified: select/configure the model while the app runs; never require changing or saving a config file; do not change the ChatGPT app. No model selection is required before building.

## Architecture

Node.js22+ ESM, built-in libraries only. A custom readline/ANSI frontend shows streamed messages, tool activity, one-time approvals, and commands for help/connect/model/status/clear/quit. A runtime wizard asks model ID, API base URL, API format and optional hidden API key; a flag can set context length. Flags/environment support noninteractive work. Settings and credentials stay in memory.

The engine is `codex --no-daemon app-server --listen stdio://`, with an isolated temporary CODEX_HOME and ephemeral thread. No existing settings/auth are read or copied. This temporary engine directory is cleaned on exit; it may contain engine-generated transient files but contains no saved connection settings. Workspace changes happen only through the requested agent tools. Default permission is workspace-write with on-request approvals.

Responses endpoints connect directly with per-invocation `-c` provider flags. Chat Completions endpoints use a random-token authenticated ephemeral 127.0.0.1 bridge, translating text/images/history/function/custom tool calls and outputs into Chat Completions and back to Responses SSE. Generation can initially be buffered upstream; document this. Preserve reasoning_content required for tool history when possible. Reject unsupported hosted tools explicitly. Search and browser/computer use are possible via user-connected MCP tools; they are not automatically provisioned.

Commands: `sudo-cli`, `--model ID --base-url URL --transport responses|chat-completions --api-key-env ENV`, `--once PROMPT`, `--cwd PATH`, `--context-window N`, `--mcp NAME=URL`, `doctor`, `--version`, `--help`. Interactive: `/help`, `/connect`, `/model ID`, `/status`, `/clear`, `/quit`; Ctrl+C interrupts work. No upstream config/login management passthrough. A project-local `sudo.cmd cli ...` supplies literal two-word invocation without global OS sudo collision.

## Completion

- Runnable version0.1.0 with Windows launchers, no npm runtime dependencies.
- Prefer the independently bundled engine, honor SUDO_CLI_CODEX overrides, then discover via PATH with useful missing-runtime errors.
- Validate settings; no secrets in argv or diagnostics, no persisted connection file.
- Preserve cwd, subprocess exits/interrupts, and close engine/bridge/temp resources.
- Test real HTTP bridge text/tool/image/errors and real process client RPC/events/approvals; fake only unavailable external model boundary.
- Verify actual installed Codex app-server with a local deterministic model fixture and file/shell tool loop, without paid API calls.
- Document source reuse, limitations, runtime setup and MCP integration; package portable ZIP.
- Model quality and actual cloud endpoint compatibility remain unverified until the user supplies a working connection. Saved sessions/configured plugins/managed services are not included in this initial ephemeral UI.
