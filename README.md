# codexcli

**Project: codexcli · Command: `sudocli` · Version: 0.5.0**

A terminal coding assistant built on the open-source Codex engine, with its own SUDO CLI dashboard and animated antenna. Choose a cloud or local model while it runs, resume saved chats, set preferences for each AI, use continuous voice, or run a local guardian for background tasks. Model sessions require administrator/root. Keys stay in memory; chat text, job outcomes and selected nonsecret metadata persist locally. The desktop app's settings and login are not used or changed.

## First setup

Keep the extracted `codexcli` directory in its final location. Setup registers a command pointing there; rerun setup after moving it.

On Windows, extract the portable x64 ZIP, open PowerShell in the folder, and run:

```powershell
.\setup.cmd
```

On Linux or macOS, with Node.js 22+ installed, run from the source folder:

```sh
sh ./setup
```

Setup checks or downloads the pinned official native engine, verifies its SHA-256, and registers `sudocli` for the current user. Windows adds a user PATH entry; Linux/macOS use `~/.local/bin` and one managed shell startup block. Setup, help, version and doctor do not require elevation. To start a model session on Windows, open a new terminal **as Administrator**, navigate to your project, and run:

```sh
sudocli
```

On Linux/macOS, launch the registered wrapper with sudo. Its full path works when sudo's PATH excludes the user command directory:

```sh
sudo "$HOME/.local/bin/sudocli"
```

Local model-session launchers are `.\sudocli.cmd` in an Administrator terminal on Windows and `sudo sh ./sudocli` on Unix. `sudocli doctor` checks the engine without calling a model. Windows x64 portable includes Node.js and Codex; the source bundle requires Node.js 22+. See [platform setup](docs/platforms.md) and the [user guide](docs/user-guide.md).

## Terminal dashboard

The large red ASCII logo and supplied Braille antenna appear beside the fields when the terminal is large enough. Every antenna character, space and original timing is preserved: 30 FPS, a 1.5-second pulse and 0.20-second wave delay. Only the six waves animate; the tower and central tip remain soft white on near-black. Waves use the supplied muted/deep/vivid reds. Animation freezes between tasks and continues from the same phase. Date/time and measurements remain live while idle. Narrow terminals use a compact layout; very small terminals show **Enlarge terminal**.

| Field | Meaning |
| --- | --- |
| Time | Local date, current time and timezone |
| Software System | Detected Windows, Linux or macOS, with architecture |
| Status | Green Working during an agent turn; red Not Working when idle or awaiting approval |
| WiFi Connection | Yes, No, or Unknown from local OS interface information; Ethernet is not WiFi |
| Download / Upload | Current receive/transmit traffic from OS-visible physical interface counters, shown when WiFi is Yes |
| Connected AI | Model confirmed by a response, or No AI connected |
| AI Connection | Measured model-response health estimate: above 70% green/Good, 51–70% orange/Fair, 50% or lower red/Bad |
| Context | Last reported used/available tokens and approximate percentage; unavailable values remain unknown |
| Permissions / Web Access | Current execution and agent web choices |
| Effort | Explicit reasoning request, or Provider default |
| Worked / In Total | Active AI/tool duration this launch and accumulated across launches |
| Activity / Project | Current operation and project |

WiFi is a local interface measurement. Download/Upload count actual current traffic, including other applications and connected physical interfaces; they are not maximum connection speed, a speed test, or model throughput. A second sample is needed before rates are available. In WSL/VMs, the guest's interfaces cannot establish the host's WiFi state.

Connection is a **latency/error heuristic**, not a network signal or guarantee. It starts Not measured. Requests ready within two seconds score 100; each additional 400 ms costs one point. Errors score zero in a recent ten-request window. Pending waits lower the live estimate after five seconds; intentional interruption is excluded. Native Responses measures first semantic output; Chat Completions buffers generation and measures full-reply readiness. These transport measurements are not directly comparable.

Worked excludes idle typing and approval waits. Numeric checkpoints persist every five seconds and on normal exit; a crash can lose time since the last successful checkpoint. Concurrent sessions use separate records. The terminal's previous screen returns on exit. `NO_COLOR=1` removes colors; `TERM=dumb` uses plain output. A piped launch prints the ASCII art and exits unless `--once` is supplied.

## Tasks, models and conversation

Enter a normal task to inspect or edit the project. `/` or `/help` lists commands; Tab completes command names. Additional prompts submitted while the AI works are queued in order and run afterward. `/stop` or Ctrl+C interrupts active model work while retaining that queue. `/steer TEXT` sends input to the active native turn, when it accepts steering. Ctrl+C exits when idle.

No model is preselected. Enter the provider's exact model ID, compatible API base URL, transport and hidden key. Chat Completions uses `/chat/completions`; Responses requires a compatible `/responses` endpoint. An unauthenticated local endpoint can use an empty key. Tool use, images, effort levels and context capacity depend on the actual model/service; a connection does not establish universal compatibility with Kimi, MiMo, GLM or other providers.

| Command | Action |
| --- | --- |
| `/switch`, `/switch add`, `/switch local` | Choose/save a named cloud or already-running local AI |
| `/switch save NAME`, `/switch remove NAME` | Save current nonsecret metadata or remove a saved profile |
| `/connect`, `/model ID`, `/model list` | Configure an endpoint, change its model, or query its model list |
| `/effort`, `/effort LEVEL`, `/effort default` | Inspect/request reasoning; Default reconnects without an override |
| `/effort supported low,high` | Declare known model effort support; save a profile to retain this metadata |
| `/upload FILE_OR_FOLDER ...`, `/attachments`, `/attachments clear` | Queue/list/clear bounded text and images for the next prompt |
| `/handoff [DIRECTORY]`, `/history` | Export the complete visible chat as Markdown/JSON, or inspect it in memory |
| `/chatt`, `/chatt open ID`, `/new` | Browse saved chats, return to a chat, or start a new chat with a keep/discard choice |
| `/personalize setup`, `/preferences` | Optional persona and preferences saved separately for the connected AI |
| `/compact` | Run native context compaction while retaining complete export history |
| `/clear`, `/history clear` | Fresh model context, or clear the current chat's stored visible history, respectively |
| `/skills list`, `/skills load NAME`, `/skills clear` | Discover native skills and attach an enabled skill to the next task |
| `/review [FOCUS]`, `/diff` | Ask the model for a workspace review, or show local Git diff |
| `/status`, `/doctor`, `/help`, `/quit` | Session state, diagnostics, commands, or exit |

Visible user/assistant messages, received partial replies and queued text prompts are automatically saved per project. Reopening resumes the last chat; `/chatt` lists saved chats and `/new` asks whether to keep the current chat before starting another. API keys remain outside saved connection metadata. Known runtime keys and terminal controls are removed from saved text, but transcripts remain local personal data and can contain other text you enter.

Switching models/endpoints or restoring a chat attaches its complete sanitized transcript to the **next prompt** sent to the new engine. It is not summarized or silently shortened; hidden reasoning, internal tool state and original attachment bytes are not transferred. A smaller model can reject it. `/handoff` writes a separate complete Markdown/JSON export. `/clear` starts fresh engine context while keeping visible history; `/history clear` removes the stored visible history of the current chat without resetting the engine. See [history and network behavior](docs/history-network.md).

`/personalize setup` lets you set an optional persona, language, tone, answer length, format and additional instructions. `/personalize on|off|clear` controls those preferences; `/preferences` is an alias. Records are tied to endpoint/model/protocol rather than a profile nickname. Preferences are developer instructions, not model training, and apply where compatible with task and permission requirements.

Standard reasoning request values are `none`, `minimal`, `low`, `medium`, `high`, `xhigh`, `max`, `ultra`, and `persistent`. Unknown providers may reject them. A declared profile restricts choices and can declare custom effort values. Default sends no effort override; the CLI does not infer a model's reasoning capacity from its name or parameter count.

## Permissions, web and optional services

Defaults are **Ask, Web Off**, even though launch requires administrator/root. `/permissions ask` requests Codex's workspace sandbox and one-time approvals. Windows may return a stricter read-only sandbox when its native sandbox is unconfigured; the UI reports the actual policy. `/permissions allow-everything` explicitly grants the elevated process full local access without execution approval prompts. The CLI verifies elevation but never requests or performs it for you.

`/web off` disables native hosted search and supplied HTTP MCP servers, and in Ask mode requests disabled networking for sandboxed commands. The host can still connect to the selected model API. **Web Off is not a firewall for Allow Everything or approved escalation**. `/web on` permits sandboxed command networking and supplied HTTP MCP servers. Hosted search additionally requires a supporting Responses provider; the Chat adapter keeps hosted search disabled.

| Optional feature | Commands and requirements |
| --- | --- |
| MCP tools | `/mcp add NAME URL`, `/mcp list`, `/mcp tools`, `/mcp remove NAME`; requires your running HTTP MCP service and Web On |
| Computer/browser use | `/computer-use setup NAME URL`, `status`, `on`, `off`; requires an appropriate MCP service and model tool/vision support |
| Editor | `/ide code` or `/ide cursor`; opens this project in an installed external editor |
| Continuous voice | `/voice setup`, `/voice speech`, `/voice live` or `/live`, `/voice off`; requires compatible transcription/speech services, FFmpeg/FFplay and microphone permission |
| Explicit voice input | `/voice file PATH`, `/voice record SECONDS`; review a transcription before submitting it |
| 24/7 tasks | `/247 setup`, `start`, `detach`, `add TASK`, `list`, `result ID`, `retry ID`, `stop`; requires an already-running saved local guardian AI |
| Training | `/training export`, `setup`, `start FILE`, `status ID`, `cancel ID`; job controls require compatible Files/Fine-tuning APIs and a fine-tunable model |

Computer Use Off reconnects with native filters for detected computer/browser tools in classified mixed MCP servers. Servers designated through `/computer-use setup` are excluded entirely, and unknown/new servers are excluded while Off. Failed discovery excludes all supplied MCP servers. Classification uses advertised names and cannot classify every renamed tool; Off controls MCP exposure, not terminal commands. Remove a server to exclude all its tools. Web Off excludes supplied HTTP MCP servers entirely.

`/voice live` continuously listens, transcribes detected utterances into normal prompts, and plays AI-generated spoken replies. Talking interrupts playback and an active AI turn; listening continues throughout. Silence is detected locally and creates no transcription requests. On Windows, choose an exact device with `/microphone device "DEVICE NAME"`; Linux uses PulseAudio and macOS uses AVFoundation. This requires your configured ASR/TTS services and FFmpeg/FFplay. Headphones are recommended: the detector has no acoustic echo cancellation, and latency/recognition quality depend on devices and services. It does not provide ChatGPT's proprietary voice backend. See [live voice](docs/live-voice.md).

`/voice record` still captures a reviewed 1–60-second prompt, and `/voice file` transcribes a selected audio file. Those explicit modes show the transcript and ask before sending it. Microphone arming alone does not record; live mode requires its explicit start. `/voice off` stops microphone and speech activity.

24/7 mode waits for explicit inbox jobs, selected project-folder changes or an optional standing goal assessed locally every 60 seconds. The local guardian can finish work, block it or call the selected working AI. `/247 start` runs in this terminal; `/247 detach` survives terminal close. `/247 stop` stops it. Required approvals are declined in detached Ask mode and leave blocked jobs. Permission/web/MCP/computer-policy changes stop active background workers; restart with the new settings. Jobs and results persist separately; `/247 result ID` displays a result without automatically inserting it into a resumed chat.

Wake/sleep hooks can call your configured GPU-control service. Avoiding cloud requests does not stop hourly instance billing; the service must actually stop/deallocate the rented resources. Detached mode does not install reboot autostart. See [worker behavior](docs/agent-worker.md) and [always-on coordination](docs/always-on.md).

`/training export` writes a local JSONL dataset from complete text exchanges; review it before upload. `/training start` asks before uploading the selected dataset and creating an actual provider job. Training support, model availability, charges, compute and job results belong to that service. The CLI does not supply a GPU/cloud host or train every connected model. Voice/training setup and keys remain in memory. See the [user guide](docs/user-guide.md) and [service details](docs/services.md).

## Launch options and source

```sh
sudocli --model provider-model-id --base-url https://api.example.com/v1 --transport chat-completions --api-key-env MY_MODEL_KEY --cwd /path/to/project
sudocli --web on --mcp browser=http://127.0.0.1:8931/mcp
sudocli --once "Explain this project" --model provider-model-id --base-url https://api.example.com/v1
```

The MCP URL is illustrative; supply a running service. Other options are `--permissions ask|allow-everything`, `--web on|off`, `--context-window TOKENS`, `--effort LEVEL`, repeatable `--mcp NAME=URL`, `--help`, and `--version`. There is no key-value command-line option. Session defaults can come from `SUDO_CLI_MODEL`, `SUDO_CLI_BASE_URL`, `SUDO_CLI_TRANSPORT`, and `SUDO_CLI_API_KEY`; `--api-key-env` names another key variable. `SUDO_CLI_CODEX` selects a compatible native engine; `SUDO_CLI_STATE_DIR` selects persistent storage for profiles, chats, personalization, work totals and the task inbox. Noninteractive `--once` declines Ask-mode approvals.

The frontend starts a private `codex --no-daemon app-server --listen stdio://`. Codex supplies the agent loop and project tools. A temporary empty `CODEX_HOME` and ephemeral thread isolate engine settings/authentication. Normal exit removes temporary engine files; abrupt termination can leave an owned temporary directory. Saved chats, task records, optional per-AI preferences, profiles and numeric work totals intentionally persist under the selected state directory. Explicit handoff and dataset exports create separate files. Detached workers retain their supplied credentials only in process memory until stopped; their private control record contains a random local control token.

The unchanged official engine is Codex **0.160.1**. The matching complete Apache-2.0 source snapshot is included at [upstream/codex-rust-v0.160.1-source.zip](upstream/codex-rust-v0.160.1-source.zip), tag `rust-v0.160.1`, commit `d27764b82f7118f674371e6d6e76271d9d606edb`. See [upstream](https://github.com/openai/codex/tree/rust-v0.160.1) and [licenses](THIRD_PARTY.md).

The private authenticated localhost adapters preserve Responses traffic or translate Chat text/images/tool history. Chat generation is buffered; native hosted tools and `previous_response_id` are unsupported. No npm dependencies are required. Run `node --test`; see [verification](docs/verification.md) and [design](docs/design.md). Windows x64 and native Linux x64 are exercised locally; native macOS and ARM execution remains unverified.

## Credits

[Instagram: @mimilidhcc](https://www.instagram.com/mimilidhcc/) · [GitHub: panmm942-ui](https://github.com/panmm942-ui)
