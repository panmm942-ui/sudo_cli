# codexcli

**Project: codexcli · Command: `sudocli` · Version: 0.6.0**

A terminal coding assistant built on the open-source Codex engine, with the original red SUDO CLI dashboard and animated antenna. Start in an offline shell, connect a cloud or local AI, resume saved chats, review actual file changes, run your acceptance checks, and undo recorded edits while preserving later human changes.

The CLI is separate from the Codex desktop app. It uses a private temporary engine home and its own persistent state. Interactive launches require administrator/root; agent access still defaults to **Ask, project scope, Web Off**. API keys stay in memory unless you explicitly choose OS-protected storage.

## First setup

Keep the extracted `codexcli` directory in its final location. Setup registers a command pointing there; rerun setup after moving it.

On Windows, extract the portable x64 ZIP, open PowerShell in the folder, and run:

```powershell
.\setup.cmd
```

On Linux or macOS, with Node.js 22+ installed, run:

```sh
sh ./setup
```

Setup verifies the pinned native engine download and registers `sudocli` for the current user. Windows adds a user PATH entry; Unix uses `~/.local/bin` and a managed shell startup block. Setup, help, version and doctor work without elevation.

Open a new Administrator terminal on Windows, navigate to your project, and run `sudocli`. On Unix, use the full registered path if sudo excludes your user command directory:

```sh
sudo "$HOME/.local/bin/sudocli"
```

Local launchers are `.\sudocli.cmd` on Windows and `sudo sh ./sudocli` on Unix. The Windows x64 portable package includes Node.js and Codex; source packages require Node.js 22+. `sudocli doctor` checks the engine without generating a model response. See [platform setup](docs/platforms.md) and the [user guide](docs/user-guide.md).

## Start offline, then connect

The default launch opens a usable shell with no model traffic. `/chatt` opens saved project chats, `/help` browses commands, and `/memory` shows your approved project rules. `/connect` guides cloud/custom or already-running Ollama/LM Studio setup. Enter the exact model ID, compatible API URL, API format, context capacity if known, and hidden key. A local unauthenticated service can use an empty key.

`/switch` selects saved/local AI profiles. `/switch save NAME` saves nonsecret connection metadata; `/model ID` changes the model. Selecting an AI shows its configured name immediately, while a real answer confirms response health. `/test-connection` probes the model catalog without generation; `/capabilities` separates observed, declared and unknown support. Tool, vision, reasoning, audio and training support depend on the endpoint/model.

```text
/connect
/switch save Main coding
/context capacity 131072
/chatt
Explain this project and its main entry point.
```

Keys are memory-only by default. `/credentials save` explicitly uses Windows DPAPI, macOS Keychain or Linux Secret Service when available; it is tied to that OS account. Saved profiles/chats contain no plaintext API-key values. `/credentials forget` removes the protected credential.

## Review work and verify it

Each ordinary AI task records a bounded before/after project checkpoint. `/changes` shows its actual file changes. `/undo` restores files still matching the recorded AI result and reports conflicts for later human edits or unsafe paths.

```text
/workflow plan
/workflow edit
Fix the failing parser case and preserve the public API.
/changes
/checks add node --test test/parser.test.mjs
/verify
/undo
```

Choose the check command for your project. **Verified** means the selected checks passed for the recorded source state. Zero checks, incomplete coverage, cancellation or a source change means **Needs review**; a failing check means **Failed**. A completed model answer never makes work Verified.

`/workflow plan|edit|test|review` selects coding guidance; plan/review use read-only scope. `/review` and `/team TASK` use fresh native sessions with bounded disposable source snapshots. Team reports are advisory and cannot accept or verify work. `/security scan`, `/security lab PATH` and `/security review PATH` provide defensive local source heuristics and isolated review; they do not contact targets or prove a project secure. See [workspace workflows](docs/workspace-workflows.md).

## Chats, context and readable input

Visible user/assistant messages, partial replies and queued text prompts autosave per project. `/new` starts another saved chat; `/chatt open ID` restores one. Replies retain their AI attribution. Reopening restores the last chat without requiring an AI connection first.

The complete visible transcript stays archived. Before replaying it to a new native session, the CLI requires a declared context capacity and checks an explicitly labelled token estimate. Oversized replay stops before provider traffic. `/context review` lets you write a reviewed summary and choose message numbers; the summary is conversation input. `/clear` starts fresh engine context and retains the archive. `/handoff` exports the full visible chat to Markdown/JSON; hidden reasoning, internal tool state and original attachment bytes do not transfer.

`/memory edit` saves only rules, decisions and preferences you approve. `/personalize setup` saves optional preferences separately for each endpoint/model/protocol. These are instructions, not model training or permission grants.

Clear reading is on by default; `/readability off` disables it and `/details` requests more explanation. `/prompt` accepts multiple lines until `/end`. Supported terminals use bracketed paste to keep pasted slash text literal. `/help work`, `/help voice` and `/help SEARCH` narrow the menu; `/search-chat TEXT` searches visible chat. Tab completes command names.

Additional prompts submitted during work queue in order. `/stop` or Ctrl+C interrupts work while retaining that queue; `/steer TEXT` guides an active native turn when supported. Ctrl+C exits when idle.

## Access, spending and routing

Administrator/root admission does not grant unrestricted agent access. `/permissions scope read-only|project|full` selects the boundary; `/permissions ask|allow-everything` controls approvals within it. `/permissions tools` shows observed tool names; `tools none`, `tools all`, or `tools allow NAME ...` selects exposure. `/permissions folders add PATH` adds an existing real write folder; `folders clear` removes additions.

Web Off keeps native command networking disabled and excludes supplied HTTP MCP servers while the host can still call the selected model API. Unsandboxed command escalation is denied with Web Off. Full unrestricted execution requires the explicit combination of full scope, Allow Everything and Web On. The actual native sandbox is reported; Windows can apply a stricter read-only fallback.

`/budget setup` sets optional task/day money, token, model-request and active-duration limits. Requests reserve bounded estimated usage before being sent, then record provider usage when supplied. `/route price INPUT OUTPUT` records your USD rates per million tokens; missing rates block money-limited requests. `/budget status` shows local accounting. Voice, training and GPU hourly fees are separate, and provider bills remain authoritative.

Routing is opt-in: `/route local`, `/route cheap`, `/route manual NAME`, or `/route off`. It uses configured profiles and your pricing metadata, displays its rationale, and respects an explicit `/switch`. It does not host a local model or independently discover provider prices.

## Voice, background work and optional services

| Feature | Entry points | Requirements and limits |
| --- | --- | --- |
| Continuous voice | `/voice setup`, `/voice speech`, `/live`, `/voice off` | Configured ASR/coding/TTS services, FFmpeg/FFplay and permitted audio devices |
| Voice controls | `/microphone devices`, `/voice wake PHRASE`, `pause`, `resume`, `repeat`, `echo headphones|speaker` | Wake filtering happens after ASR; speaker mode pauses listening during playback and has no acoustic echo cancellation |
| Local guardian | `/247 setup`, `start`, `detach`, `add TASK`, `list`, `result ID`, `retry ID`, `stop` | An already-running saved loopback AI; the computer and services must stay awake |
| Scheduled work | `/schedule add`, `list`, `pause ID`, `resume ID`, `remove ID` | Explicit timezone; schedules enqueue jobs for a running guardian |
| OS startup | `/startup setup`, `plan`, `install`, `remove` | Explicit installation, reviewed OS service plan and runtime credential environment/loader |
| GPU state | `/gpu setup`, `status`, `wake`, `sleep` | Your provider hooks; HTTP acknowledgement alone does not establish resource or billing state |
| Browser | `/browser executable PATH`, `start`, `stop` | Installed Chromium/Chrome/Edge, approved origins, Web On and compatible tools |
| External desktop/browser | `/computer-use setup NAME URL`, `/mcp add NAME URL` | Your running MCP service and appropriate model capabilities |
| Source-linked search | `/search QUERY` | Supported Responses hosted search or configured search/browser MCP; fetched instructions are untrusted |
| Editor | `/ide code`, `/ide cursor` | Installed VS Code or Cursor |
| Training | `/help advanced`, `/training export|setup|start|status|cancel` | Compatible Files/Fine-tuning service and a fine-tunable model |

Voice is composed ASR → coding AI → TTS, not a universal native realtime-audio backend. Headphones permit interruption while listening; speaker mode uses half-duplex echo avoidance. Physical microphone/speaker behavior remains untested in this release environment. Spoken slash text is literal and cannot approve native execution. See [voice details](docs/live-voice.md).

The built-in Chromium adapter uses a dedicated headless browser/profile and exposes scoped MCP actions, with displayed action names and immediate stop. Root Unix launches refuse to disable Chromium's sandbox: run an external browser MCP service as your normal user and connect it with `/computer-use setup`. External desktop support remains conditional on the service; the CLI does not ship universal OS desktop automation.

Background jobs and results persist. Interrupted jobs require review/retry, and policy changes stop existing workers before they can continue with old access. Detach survives terminal close; explicit startup can restart an OS service. Neither can run while the machine is asleep/off. GPU hooks must report actual stopped/deallocated and billing state before treating compute as stopped. No rented GPU, production ASR/TTS or training service is provisioned by this build. See [operations](docs/operations.md), [guardian](docs/always-on.md) and [services](docs/services.md).

## Dashboard, updates and verification

The supplied antenna characters, spacing and timing remain unchanged: 30 FPS, a 1.5-second pulse and 0.20-second wave delay. Only the six red waves animate; the tower/tip remain soft white on near-black. Animation freezes between tasks and resumes from the same phase. Narrow windows use a compact layout; very small windows show **Enlarge terminal**.

The dashboard shows local time/timezone, OS/architecture, working state, configured/confirmed AI, context, permissions, budget/verification, activity/project and active-work timers. AI measurements are first-response latency, recent errors and reported generation speed. Connection percentage is an optional heuristic via `/status percent on`. **Live Traffic** is OS interface receive/transmit traffic, including other programs; it is not a speed test. WSL cannot establish the host's WiFi state. Unknown measurements stay unknown. `NO_COLOR=1` removes colors; `TERM=dumb` uses plain output. Normal exit restores the previous screen.

`/update stage PACKAGE_OR_HTTPS_URL TRUSTED_SHA256` verifies and stages a bounded package. `/update install` checks compatible archive/runtime metadata and installs alongside the old release; `/update rollback` restores its registered launcher. Obtain the checksum through a trusted channel, and restart after changing the registered release. Existing files and old releases are retained for rollback.

The [22-area evidence table](docs/v0.6-feature-evidence.md) records mechanisms, tests and practical limits. [Native terminal acceptance](docs/v0.6-terminal-evidence.md) passed against actual Linux x64 Codex with 22 loopback streamed requests, four clean CLI exits and no paid models, including multiline input and literal bracketed paste. Local Windows/Linux tests are separate from the defined six-target Windows/Linux/macOS x64/ARM64 CI; remote macOS/ARM jobs have not been run here.

Final complete suites passed: Windows 487 tests with 23 platform skips; root Linux 501 tests with 9 platform skips; zero failures on both. See [release verification](docs/verification-v0.6.md).

## Launch options, source and licenses

```sh
sudocli --model provider-model-id --base-url https://api.example.com/v1 --transport chat-completions --context-window 131072 --api-key-env MY_MODEL_KEY --cwd /path/to/project
sudocli --once "Explain this project" --model provider-model-id --base-url https://api.example.com/v1
```

Other options include `--permissions ask|allow-everything`, `--scope read-only|project|full`, `--web on|off`, `--effort LEVEL`, repeatable `--mcp NAME=URL`, `--help` and `--version`. There is no command-line key-value flag. `SUDO_CLI_MODEL`, `SUDO_CLI_BASE_URL`, `SUDO_CLI_TRANSPORT` and `SUDO_CLI_API_KEY` supply session defaults; `--api-key-env` names a key variable. `SUDO_CLI_CODEX` selects a compatible engine; `SUDO_CLI_STATE_DIR` selects independent persistent state. Noninteractive Ask approvals are declined.

The unchanged official engine is **OpenAI Codex 0.160.1**, tag `rust-v0.160.1`, commit `d27764b82f7118f674371e6d6e76271d9d606edb`. Its complete Apache-2.0 source snapshot is included at [upstream/codex-rust-v0.160.1-source.zip](upstream/codex-rust-v0.160.1-source.zip). The frontend/tests use MIT; bundled **Node.js 24.19.0** retains its MIT/dependency notices. See [THIRD_PARTY.md](THIRD_PARTY.md), [LICENSE](LICENSE), [licenses](licenses) and [upstream source](https://github.com/openai/codex/tree/rust-v0.160.1). No npm runtime dependencies are required; run `node --test` for the automated suite.

## Credits

[Instagram: @mimilidhcc](https://www.instagram.com/mimilidhcc/) · [GitHub: panmm942-ui](https://github.com/panmm942-ui)
