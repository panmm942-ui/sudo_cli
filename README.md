# codexcli

**Project: codexcli · Command: `sudocli` · Version: 0.3.0**

A terminal coding assistant built on the open-source Codex engine, with its own SUDO CLI ASCII dashboard. Choose the model, API endpoint, format and hidden key while it runs. Model settings stay in memory. It does not change the ChatGPT/Codex desktop app or reuse its login.

## First setup

Keep the extracted `codexcli` directory in its final location. Setup registers a command pointing there; rerun setup after moving it.

On Windows, extract the portable x64 ZIP, open PowerShell in the folder, and run:

```powershell
.\setup.cmd
```

On Linux or macOS, install Node.js 22+ and run from the cross-platform folder:

```sh
sh ./setup
```

Setup verifies or downloads the pinned official native engine, checks its SHA-256, and registers `sudocli` for the current user. Windows adds a user PATH entry; Linux/macOS use `~/.local/bin` and one managed block in the active shell startup file. No administrator access is required. See [platform details](docs/platforms.md).

Open a new terminal, navigate to your coding project, and run:

```sh
sudocli
```

Local launchers also work: `.\sudocli.cmd` on Windows, or `sh ./sudocli` on Unix. `sudocli doctor` checks engine startup without calling a model. The Windows x64 portable bundle includes Node.js and Codex; the source bundle requires Node.js 22+.

## Dashboard

The large cyan ASCII logo sits beside the fields in a wide terminal. Labels are muted; state values use green, orange and red.

| Field | Meaning |
| --- | --- |
| Time | Local date, current time and timezone; updates each second |
| Software System | Detected Windows, Linux or macOS, with architecture |
| Working | Green Working during an agent turn; red Not working when idle |
| Status | Online after a real model response; Offline before confirmation or after connection failure |
| Connected AI | Confirmed model ID, or No AI connected |
| Connection | Response health estimate: above 70% green/Good, 51–70% orange/Fair, 50% or lower red/Bad |
| Context | Last reported context percentage and used/available tokens; missing values remain unknown |
| Permissions | Ask or Allow Everything |
| Web Access | On or Off |
| Worked | Active AI/tool time for this launch; resets on reopen |
| In Total | Worked time accumulated across launches, beside Worked |
| Activity / Project | Current operation and working directory |

Connection is a **latency/error heuristic**, not a literal network signal or guarantee. It starts Not measured. Successful requests within two seconds score 100; each additional 400 ms costs one point. Errors score zero in a recent ten-request window. A pending request starts lowering the live estimate after five seconds. Interruptions do not count as model errors. Native Responses measures first semantic output; Chat Completions buffers generation and measures when the complete reply is ready. Those measurements are not directly comparable between transports. The footer and `/status` identify the estimate.

Worked counts active agent and tool time. Idle typing and waiting for your permission are excluded. Only numeric duration records are saved in the current user's codexcli state directory. Normal exit saves immediately; a crash can lose time since the last five-second checkpoint. Concurrent sessions use separate records. No keys, models, endpoints or conversations are saved by the counter.

The temporary alternate screen uses the supplied Python snippet's entry/restore sequences, erases stale line tails, handles resize, Ctrl+C, SIGTERM and SIGHUP. Your previous screen/scrollback returns on exit. The cursor is visible while you type. Narrow terminals stack fields; terminals too small to fit them say **Enlarge terminal**. `NO_COLOR=1` disables colors; `TERM=dumb` uses a plain header. A piped launch prints the ASCII art and exits. `--once` runs a task in pipelines without the live screen.

## Runtime commands

| Input | Action |
| --- | --- |
| A normal message | Ask the agent to inspect, edit or work in the project |
| `/connect` | Choose endpoint/model/format/key; fresh conversation |
| `/model MODEL_ID` | Change model on the same endpoint; keep conversation |
| `/permissions ask` | Workspace permissions and escalation prompts; fresh conversation |
| `/permissions allow-everything` | Full local access without execution approval prompts; fresh conversation |
| `/web on` / `/web off` | Change agent web access; fresh conversation |
| `/clear` | Fresh conversation with the same connection/options |
| `/status` | Connection, context, access choices and worked totals |
| `/help` / `/quit` | List commands / exit |
| Ctrl+C | Interrupt work and return to the prompt, or exit when idle |

Defaults: **Ask, Web Off**. Ask uses the Codex workspace sandbox and one-time approval prompts. Windows can fall back to a stricter read-only sandbox when its native sandbox is unconfigured; the UI reports this. Allow Everything is explicit opt-in and gives commands your user's access; it does not elevate to administrator/root.

Web Off disables native hosted search and supplied HTTP MCP servers. In Ask mode it requests disabled network access for sandboxed commands. The model API connection remains available. **Web Off is not a firewall for Allow Everything or explicitly approved escalation**: those commands can still use the OS network. The UI states this when Allow Everything and Web Off are combined.

Web On permits sandboxed command networking and supplied HTTP MCP servers. Native Responses also enables hosted web search if the provider supports it. Chat Completions keeps hosted search disabled because its adapter cannot translate it; use shell tools or an MCP server. Web On does not provision a search, browser, desktop or training service.

## Model and tool connections

No model is preselected. Enter the provider's exact model ID and API base URL, usually ending `/v1`. Choose Chat Completions for `/chat/completions` or Responses for a compatible `/responses` endpoint. An unauthenticated local server can use an empty key. Kimi, MiMo, GLM and other providers can be selected later; their live endpoints and model-specific tool behavior are not verified by this release.

Optional flags supply session settings without a file:

```sh
sudocli --model provider-model-id --base-url https://api.example.com/v1 --transport chat-completions --api-key-env MY_MODEL_KEY --cwd /path/to/project
sudocli --permissions allow-everything --web on
sudocli --web on --mcp browser=http://127.0.0.1:8931/mcp
sudocli --once "Explain this project" --model provider-model-id --base-url https://api.example.com/v1
```

The MCP URL is illustrative: supply a running HTTP tool server. Such servers can provide computer/browser tools; this package does not install them. Image inputs and tool calling depend on the selected model/service. Enter keys through the hidden wizard or environment; there is no key command-line option.

Other options: `--context-window TOKENS`, repeatable `--mcp NAME=URL`, `--help`, `--version`. Optional environment defaults: `SUDO_CLI_MODEL`, `SUDO_CLI_BASE_URL`, `SUDO_CLI_TRANSPORT`, `SUDO_CLI_API_KEY`. `SUDO_CLI_CODEX` selects a compatible native engine; `SUDO_CLI_STATE_DIR` changes counter storage. `--once` in Ask mode declines approvals because nobody is there to approve them.

## Source and verification

The custom Node frontend starts a private `codex --no-daemon app-server --listen stdio://`. Codex supplies the agent loop, project tools, approvals, MCP and context handling. A temporary empty `CODEX_HOME` and ephemeral thread isolate each session from desktop settings/authentication. Temporary engine files are removed on normal exit; abrupt termination can leave that temporary directory behind.

The engine is official Codex **0.160.1**, unchanged and not locally recompiled. Its complete Apache-2.0 source snapshot is included in [upstream/codex-rust-v0.160.1-source.zip](upstream/codex-rust-v0.160.1-source.zip), tag `rust-v0.160.1`, commit `d27764b82f7118f674371e6d6e76271d9d606edb`. See [upstream source](https://github.com/openai/codex/tree/rust-v0.160.1) and [licenses](THIRD_PARTY.md).

Both API transports use a private authenticated localhost connection. Responses passes through with a bounded in-memory timing monitor. Chat Completions translates text/images/tool history and buffers generation; hosted tools and `previous_response_id` are unsupported. The adapters do not log or save model credentials/content.

This CLI does not reproduce every desktop feature or provide a cloud model/GPU/training host. Windows x64 and native Linux x64 are exercised locally. macOS/arm64 selection is tested; native execution there remains unverified. The included CI matrix exercises Windows, Linux and macOS when placed in a GitHub repository.

No npm dependencies are needed. Run `node --test` for unit and real-engine tests with deterministic localhost model fixtures. See [verification results](docs/verification.md) and [binary hashes](runtime/manifest.json) in the portable Windows bundle.
