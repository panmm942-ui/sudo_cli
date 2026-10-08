# Using sudocli 0.6.4

Use `/bgcolor COLOR` and `/txtcolor COLOR` for saved colors below the dashboard. Similar text/background colors adjust for readability. `/reset` lets you choose settings to restore.

`/update check` checks stable releases from `panmm942-ui/sudo_cli`. Launch checks are enabled by default; installation requires your **y/n** answer and a verified compatible package. `/update off` disables launch checks.

`/loopguard` controls repeated tool action protection and native command timeouts. [Color examples](terminal-colors.md), [reset targets](reset-settings.md), [update setup](github-updates.md), [model connection and coding tests](model-compatibility.md).

Complete [first setup](platforms.md), then launch from the project you want to work on. Windows requires an Administrator terminal; Unix uses `sudo "$HOME/.local/bin/sudocli"` or the full local launcher path. Setup, help, version and doctor work normally without elevation. The CLI never elevates itself.

The original red SUDO CLI logo, Braille antenna, credits and timing are preserved. A UTF-8 truecolor terminal around 100 columns by 32 rows leaves room for the dashboard and conversation. `NO_COLOR=1` removes colors; `TERM=dumb` uses plain output. The terminal's previous screen returns on normal exit.

## Open saved work before connecting

A default interactive launch starts with no AI selected and no model request. You can use `/help`, `/status`, `/chat`, `/search-chat` and `/memory` in this shell. The last saved chat for the current project resumes automatically. It stays local until you connect an AI and send a task.

```text
/chat
/chat open CHAT_ID
/connect
```

`/chat` lists saved chats and asks which one to open. `/chat list` only lists them; `/chat rename TITLE`, `/chat save` and `/chat delete CHAT_ID` manage saved records. Opening one replaces the visible conversation with its saved history. See [chat commands](chat-commands.md) and [saved chats](chats.md).

Use `/new` or `/chat new` for a fresh conversation. The keep question defaults to **Y**: Enter, `y` or `yes` keeps the previous saved chat; `n` or `no` deletes its record. Only after the new chat is created successfully does the lower display clear, the scroll position reset and the AI context start fresh under a new chat ID. Canceling the question or failing to create the new record keeps the current display in place.

`/local` connects Ollama, LM Studio or another compatible server already running on this computer without a cloud API key. `/connect` offers both cloud and local setup. For a model file that has not been loaded yet, use `/local file "PATH"`. It detects the contents, offers supported installed runners and preserves your original file. `/local info "PATH"` inspects without importing. Unsupported formats explain the runner/model files needed. See [local model files](local-model-files.md).

For a server, select its exact model ID, base URL, API format and capacity if known. Supply a hidden key only if the server requires authentication. Chat Completions needs `/chat/completions`; Responses needs a compatible `/responses` endpoint.

Launch flags can supply the connection directly:

```sh
sudocli --model exact-model-id --base-url https://api.example.com/v1 --transport chat-completions --context-window 131072 --api-key-env MY_MODEL_KEY --cwd /path/to/project
```

Use the model's actual capacity; the number above is an example. Selected AI and configured endpoint are shown before generation. A completed response establishes execution; `/test-connection` only checks the catalog and cannot establish generation, tool or audio support.

## Save AIs, capabilities and protected keys

```text
/switch save Main coding
/switch add
/switch local
/switch Main coding
/model list
/model exact-model-id
/capabilities
```

Saved profiles retain nonsecret model/endpoint/protocol metadata, optional capacity and explicitly declared effort/capability information. They do not contain API-key values. `/switch remove NAME` removes a profile. `/switch` alone lists choices; switching sends no chat until your next task.

`/capabilities` distinguishes observed facts, declarations and unknown support for text, streaming, tools, vision, reasoning, audio, structured output, hosted search, training and model discovery. `/capabilities declare FEATURE on|off` records your known service support. An observation from one model is not proof about another model. Unsupported declared features are refused; unknown support stays labelled. For reasoning, `/effort supported low,medium,high` declares permitted values; `/effort default` reconnects without an override. A model name or parameter count never proves these capabilities.

The default credential lifetime is this process. `/credentials status` reports the backend; `/credentials save` explicitly uses Windows DPAPI, macOS Keychain or Linux Secret Service when installed/available. Protected storage belongs to that OS account and connection identity; a startup service may run as a different account. `/credentials forget` removes the stored credential while an already-connected session retains its in-memory key.

## Enter readable prompts and search

Enter a normal task, such as `Explain this project and identify its main entry point.` Type `/` at an empty idle prompt to open all commands in a selectable menu. Type to filter, use arrows or Page Up/Down, and press Enter to fill a command. Add arguments if needed and press Enter again to run it. Escape restores your slash query. `/help` prints the complete list; `TERM=dumb` uses `/` followed by Enter for that list. `/help work`, `/help access`, `/help voice` and `/help advanced` browse groups. `/help context` searches command descriptions; Tab completes names. `/search-chat parser` searches the visible archive locally.

Browse the conversation under the fixed dashboard with **PgUp/PgDn** or the mouse wheel. **Ctrl+Home** jumps to the first retained text; **Ctrl+End** returns to the newest output and your input prompt. `/scroll up` and `/scroll down` move one page; `/scroll top` and `/scroll bottom` jump to the beginning or return live. When new replies arrive while you browse, the older view stays in place and shows **New output**. Typing or pasting returns to live input. The command picker owns PgUp/PgDn while open, and secret questions and multiline prompts keep their own input behavior. See [chat scrolling](chat-scrolling.md) for terminal support, selection and display limits.

Clear reading is on by default: short initial answers, short lines and spaced actions. `/readability off` disables it. `/details` asks the connected AI to expand the last answer.

```text
/prompt
Explain this code and the edge case:
function total(values) {
  return values.reduce((sum, value) => sum + value, 0);
}
/end
```

`/prompt` preserves multiline text until `/end`. On terminals supporting bracketed paste, pasted text is queued as a literal prompt; embedded slash lines do not change permissions or execute commands. Unbracketed terminals should use `/prompt` for multiline content.

Prompts submitted during work queue in order. `/stop` or Ctrl+C interrupts model work without deleting the queue. `/steer TEXT` guides an active native turn when it accepts steering. Other commands entered while busy wait for the current work. Ctrl+C exits when idle.

## Use explicit coding checks and safe undo

```text
/workflow plan
Plan the parser fix and meaningful acceptance checks.
/workflow edit
Implement the approved parser fix.
/changes
/checks add node --test test/parser.test.mjs
/verify
```

Choose a real command appropriate to your project. The CLI records bounded before/after checkpoints around ordinary AI tasks. `/changes [CHECKPOINT_ID]` shows actual recorded changes, including a bounded diff. The default is the latest checkpoint. Files omitted by bounds/exclusions make coverage partial.

`/checks add COMMAND` adds a check; `/checks list` shows the list and `/checks clear` removes it. `/verify COMMAND` runs one explicit command; `/verify` runs the selected list. Results include exit code, stdout/stderr, elapsed time, cancellation and capture limits.

| Result | Meaning |
| --- | --- |
| Verified | All selected checks passed for the recorded source state with complete coverage |
| Failed | A selected check exited nonzero or failed to launch |
| Needs review | No checks, cancellation/timeout/output bound, source changes during checks, or incomplete source coverage |

A model saying “finished” does not set Verified. Verification is evidence about those checks and that source state, not untested behavior or external services.

`/undo [CHECKPOINT_ID]` restores only files whose current contents still match the recorded AI result. New recorded files are individually removed. Later human edits, unsafe/symbolic paths and replacement files become conflicts and stay untouched. Partial undo reports the restored paths and conflicts. Undo invalidates the associated verification. Checkpoints survive restart; unfinished checkpoints cannot be safely undone. See [workspace workflows](workspace-workflows.md).

`/workflow plan|edit|test|review` selects task guidance. Plan/review also select read-only scope; edit/test return to the previous write scope. `/review FOCUS` runs an independent reviewer; `/team TASK` runs a planner and reviewer with fresh native sessions and separate bounded source snapshots. Neither role changes the original project or accepts work. Reports are advisory, with stated snapshot/external-behavior limits.

## Bound long conversations and approved memory

```text
/context capacity 131072
/context status
/context review
/memory edit
/personalize setup
```

Full visible chat remains archived and is never silently shortened. Before replaying it after a model switch, runtime reconnect or restart, the CLI requires the selected AI's capacity. It estimates input size with framing/instructions and reserves output space. Provider tokenization and additional overhead can differ; the estimate is labelled.

If full replay exceeds the allowance, it stops before provider traffic. `/context review` displays numbered messages, accepts your reviewed summary until `/end`, then asks for comma-separated message numbers. Choose the relevant excerpts yourself. It retains the complete archive and replays the bounded summary/excerpts as conversation input, never as higher-trust developer instructions. An oversized reviewed selection is also refused.

`/compact` invokes native compaction while retaining the archive. `/clear` gives the engine fresh context and retains visible history. `/new` or `/chat new` creates a separate saved chat after the keep/discard choice and clears its display only on success. `/history clear` clears the current visible archive without resetting the active engine. `/handoff [DIRECTORY]` exports full Markdown/JSON separately; hidden reasoning/tool internals and original attachment bytes are not transferred.

`/memory edit` accepts project rules/preferences/decisions until `/end`; `on|off|clear` controls that approved memory. Model output and discovered files cannot silently become approved memory. `/personalize setup` separately saves persona, language, tone, reply length/format and other instructions per endpoint/model/protocol. `/preferences` is its alias. These are developer instructions, not training or execution permissions.

## Scope execution and tools

```text
/permissions ask
/permissions scope project
/permissions tools
/permissions tools none
/permissions folders add PATH
/web off
```

Administrator/root admission is distinct from agent permission. Defaults are Ask, project scope and Web Off. Read-only prevents native writes; project uses native workspace sandboxing plus your explicitly selected real write folders; full expands the boundary. Allow Everything skips approval prompts only within the resulting policy. Full unrestricted native execution requires full scope, Allow Everything and Web On together. The actual native policy is reported; Windows may use a stricter read-only fallback.

With Web Off, unsandboxed command escalation is denied, native command networking is disabled and supplied HTTP MCP servers are excluded. The host model API remains reachable. Explicit ASR/TTS/training/GPU commands use their separately configured endpoints. Web On permits selected sandbox networking/MCP; hosted search additionally requires a compatible provider.

`/permissions tools` shows observed exact wire names after a model request populates the catalog. Use `tools allow NAME ...`, `tools none` or `tools all`. The provider adapters reject tool calls outside the selected policy. `/permissions folders add PATH` selects an existing real folder; `folders clear` removes additions. Read-only still prevents writes.

Permission/web/tool/computer changes stop existing background workers before they continue under old access. Restart the guardian explicitly with the updated settings. Reconnects retain archived chat subject to context preflight.

## Limit spending and choose routing

```text
/route price 1 2
/budget setup
/budget status
/route cheap
/route local
/route manual Main coding
/route off
```

Replace the example rates with the selected provider/model's actual USD price per million input/output tokens. Budget setup asks for task/day money, tokens, model requests and minutes of active work; blank means unlimited. Provider requests reserve bounded estimated usage before network traffic, then reconcile reported usage. Missing pricing blocks money-limited work. `/budget off` explicitly disables caps. `/budget reset-day` resets only the local counters; provider charges remain unchanged.

Costs are estimates/accounting, not invoices. The default request output cap is 4096 tokens. Voice, training and GPU hourly bills are separate. Rejected admission does not call the provider.

Routing is opt-in and uses saved profiles. Local mode prefers a configured loopback endpoint; cheap mode uses your configured token prices. Manual selection takes priority, and `/switch` turns automatic routing off. A rationale is shown when the connection changes. No local AI is installed, and service price/capability metadata is not inferred from model names.

## Configure voice and echo avoidance

```text
/voice setup
/voice speech
/microphone devices
/microphone device Exact device name
/voice echo headphones
/voice wake assistant
/live
/voice pause
/voice resume
/voice repeat
/voice off
```

Transcription and speech need separately configured compatible endpoint/model/key choices. Native FFmpeg/FFplay and OS microphone permission are required. Windows uses an exact DirectShow device name, Linux uses PulseAudio, and macOS uses an AVFoundation audio index. Device discovery reports the installed tool's output; no device is assumed usable until tried.

This is composed ASR → coding AI → TTS. Detected phrases become ordinary literal prompts, and replies play through the configured speech service. Silence is handled locally. Headphones mode keeps listening and supports interruption; speaker mode pauses listening during playback to avoid feeding speech back into the microphone. Speaker mode is half-duplex and has no acoustic echo cancellation. Physical microphone/speaker acceptance has not been performed here.

Wake-phrase filtering happens after ASR, so it is not an offline wake-word engine and preceding speech still reaches the configured transcription service. Pause prevents recognized phrases from becoming prompts; resume permits them again. Repeat speaks the last completed reply. Spoken slash text cannot mutate settings or approve execution. `/voice off`, microphone Off or exit stops capture/playback and pending audio requests.

Explicit `/voice record 10` or `/voice file PATH` shows a transcript and asks before sending it. Record takes 1–60 seconds; audio files have a 25 MiB bound and require service format support. Arming the microphone alone does not record. Live recognized prompts/replies use normal chat autosave; service keys remain in memory. See [live voice](live-voice.md) and [services](services.md).

## Run durable background work

```text
/247 setup
/247 start
/247 add Check the failing build and explain the cause.
/247 list
/247 result JOB_ID
/247 retry JOB_ID
/schedule add
/startup setup
/startup plan
```

Setup chooses a saved, already-running local guardian AI on loopback and a working AI for heavier tasks. Explicit inbox jobs, selected folder changes or an optional standing goal trigger work. With no goal/job, idle makes no model calls. The guardian finishes locally, calls the working AI or blocks the job with a reason. Foreground `/247 start` stops on terminal exit; `/247 detach` survives terminal close. `/247 stop` stops either worker. Detached execution declines approvals requiring a person.

Tasks/results and schedule occurrences persist. Interrupted active work requires review/retry rather than assuming completion; occurrences are enqueued idempotently. `/schedule add` requires an ISO time with an explicit timezone and optional repeat minutes. List/pause/resume/remove manage a schedule. The guardian must run to process due work; machine sleep/off and unavailable local services still stop execution.

Startup is explicit: inspect `/startup plan`, then use `/startup install` if you want OS registration. It uses systemd on Linux, launchd on macOS or Task Scheduler on Windows. API-key values are excluded from startup configuration; supply runtime environment references or an explicitly trusted credential-loader executable. `/startup remove` disables it. Merely detaching does not install startup. OS registration and production reboot recovery were not installed/tested on this user's machine. See [operations](operations.md) and [worker behavior](agent-worker.md).

## Control GPU state, browser and search services

`/gpu setup` configures wake/sleep/status hooks; `/gpu status`, `/gpu wake` and `/gpu sleep` use them. A successful POST is only acknowledgement. An explicit provider status must report running/stopped/deallocated and billing state before resource state is treated as known. Storage-only or other charges may continue. No GPU is provisioned or deallocated merely by saving hooks, and no production GPU lifecycle was tested.

For browser tools, enable Web On and use `/browser start`, with installed Chromium/Chrome/Edge and explicit allowed origins. `/browser executable PATH` overrides discovery. This starts a dedicated headless browser/profile and authenticated loopback MCP adapter with navigation, text/links, screenshot, CSS click and field typing. Actions are displayed; `/browser stop` stops the adapter/child. The Windows adapter was exercised against a loopback page through actual CDP, including a 10,702-byte screenshot.

Root Unix Chromium launch refuses to disable its sandbox. Run a browser MCP service as a normal user and connect it using `/computer-use setup NAME URL`. External desktop/browser automation depends on that actual service and model vision/tools. `/computer-use off` excludes designated computer servers and detected computer tools in classified mixed servers; unknown/new servers are omitted while Off. Classification cannot identify every renamed tool. `/mcp remove NAME` excludes a whole server.

`/search QUERY` requests source-linked search through compatible Responses hosted search or configured search/browser MCP. It requires Web On and appropriate capability/tool setup. Fetched instructions remain untrusted. Source links and factual claims still need review; a connection alone does not establish search quality. `/ide code|cursor` opens an installed external editor without installing an extension.

## Defensive security, training and updates

`/security scan` runs bounded local source/dependency/credential-pattern heuristics. It suppresses matched credential values and reports coverage limits. `/security lab PATH` explicitly approves a relative local source target and makes a bounded disposable copy. `/security review PATH` uses an independent defensive reviewer. These operations do not authorize external targets, exploit execution or access to the original project outside that scope. Absence of findings is not proof of security; no advisory database is queried. See [workspace workflows](workspace-workflows.md).

Training is under `/help advanced`. `/training export` creates a bounded JSONL dataset from complete text exchanges; review it. `/training setup` needs compatible Files/Fine-tuning APIs and a fine-tunable model. `/training start FILE` asks before upload/job creation; `status ID` and `cancel ID` use the real service. Provider costs, compute and outcomes remain external. These commands do not train every connected AI.

`/update stage PACKAGE_OR_HTTPS_URL TRUSTED_SHA256` verifies a supplied trusted hash and stages a bounded ZIP. `/update install` validates compatible paths/package/runtime metadata, installs beside the old release and changes the registered launcher. `/update rollback` points it to the retained prior release. Review the checksum through a trusted channel and restart after switching versions. This is explicit update/rollback, not an automatic downloaded-code startup step.

Official 0.6.4 packages check an Ed25519-signed manifest before startup. Altered or missing signed files, including credits, licenses and upstream notices, refuse startup. A deliberate fork can replace the verifier, so signing cannot prevent someone modifying a fork. Preserve the included credits, license texts and upstream notices when distributing packages. See [signed release integrity](release-integrity.md) for the publishing process and limits.

## What persists and what was tested

| Data | Lifetime |
| --- | --- |
| Visible chats/partial replies/queued text, profiles, personalization and approved project memory | Private independent state, with project/connection identities |
| Checkpoints, verification evidence, jobs, schedules and budget records | Private durable records with bounded/safe-path validation |
| Optional protected credentials | OS account store only after explicit save |
| Runtime keys and active scope/tool/voice selections | Running process; background workers receive an in-memory snapshot |
| Original attachment bytes and unsent keystrokes | Not recovered on restart |
| Handoff Markdown/JSON and training datasets | Explicit project exports |
| Installed startup service or registered update | Explicit OS/launcher operation |

`SUDO_CLI_STATE_DIR` selects independent persistent storage. Normal `/quit` saves state/work totals, stops live audio and foreground background work, closes the private engine and restores the terminal. A deliberately detached worker continues until stopped.

Actual Linux x64 PTY acceptance used the native Codex engine and 22 loopback streamed model requests with isolated HOME/XDG/state/project; all four CLI children exited 0. Multiline input and bracketed paste reached the model literally without changing permissions. Local Windows/Linux automated checks and actual Windows browser CDP acceptance are distinct from the six-target CI definition. macOS/ARM CI jobs, physical audio, external desktop services, production providers and rented GPU billing remain unverified here. See [terminal evidence](v0.6-terminal-evidence.md), [22-area evidence](v0.6-feature-evidence.md) and [release verification](verification-v0.6.md).

The frontend is MIT; bundled OpenAI Codex 0.160.1 and its matching source/notices retain Apache-2.0, and Node.js 24.19.0 retains its license/dependency notices. [Instagram: @mimilidhcc](https://www.instagram.com/mimilidhcc/) · [GitHub: panmm942-ui](https://github.com/panmm942-ui). See [THIRD_PARTY.md](../THIRD_PARTY.md).
