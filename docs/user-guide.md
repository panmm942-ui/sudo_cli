# Using sudocli 0.5

Complete [first setup](platforms.md), then open a terminal as Administrator on Windows and run `sudocli` from your project. On Linux/macOS, use `sudo "$HOME/.local/bin/sudocli"`, or sudo with the full launcher path. Model sessions require verified administrator/root privileges; setup, help, version and doctor remain available normally. The CLI does not request elevation for you.

A UTF-8 terminal with Braille/truecolor support displays the original supplied antenna. Its characters, spacing and 30 FPS / 1.5-second pulse / 0.20-second delay are preserved. The tower stays soft white; only the red waves animate, and they freeze when AI work stops. A wide, tall window such as 100 columns by 32 rows leaves room for the dashboard and conversation. Plain output remains available with `NO_COLOR=1` or `TERM=dumb`.

## Connect your first AI

Enter the exact model ID served by your endpoint, its API base URL, and the protocol. The default Chat Completions transport requires `/chat/completions`; Responses requires a compatible `/responses` endpoint. Base URLs normally end in `/v1`. Enter an API key at the hidden prompt, or leave it blank for an unauthenticated server. Keys also can come from `--api-key-env NAME`. The CLI does not select, download or host an AI model.

Enter a task such as `Explain the project and identify its main entry point.` Status becomes Working during the agent turn. Connected AI is confirmed by a real response. WiFi Yes does not establish model connectivity, and the Connection percentage is a measured model-response estimate.

Use `/` or `/help` for the command menu and Tab for command-name completion. A regular prompt entered during work goes into an ordered queue. The current task continues, and queued commands/prompts run afterward. A queued model switch takes effect before a later queued task. `/stop` or Ctrl+C interrupts active model work without deleting that queue. Ctrl+C exits when idle.

For an immediate instruction to an active model turn, use:

```text
/steer Focus on the failing tests first.
```

Steering is accepted only while a native turn remains active and supports it; manual compaction cannot accept steering. Other slash commands entered while busy are queued.

## Save and switch AIs

```text
/switch save Main coding
/switch add
/switch local
/switch Main coding
/model list
/model exact-model-id
```

`/switch` alone lists saved choices and can select by number or name. `add` walks through cloud/custom endpoint setup; `local` offers editable shortcuts for an already-running Ollama, LM Studio or other local compatible server. The local model must already be served. `/model list` queries the current endpoint rather than treating Codex's native catalog as third-party provider capabilities.

Saved profiles retain name/model/endpoint/protocol and optional context limit, key environment-variable name and explicitly declared effort levels. **API-key values are not stored.** A key can be reused in this running session or requested again after reopening. `/switch remove NAME` deletes a saved choice. See [profile storage](profiles.md).

Model/endpoint/runtime-option reconnects retain the complete visible chat. The sanitized user/assistant transcript is added to the new AI's next prompt. It is not a summary, and no chat is sent merely by selecting a profile. Hidden reasoning/tool internals and original attachment bytes do not transfer. Context capacity can differ or be unknown; a smaller provider can reject the full conversation. Requests above the CLI's 8 MiB limit fail explicitly rather than silently shortening the chat.

## Personalize each AI

```text
/personalize setup
/personalize status
/personalize on
/personalize off
/preferences
```

Setup optionally saves a persona, language, tone, answer length, format and additional instructions for the connected endpoint/model/protocol. A profile nickname does not change that identity. `/preferences` is an alias for `/personalize`; `clear` removes that connection's personalization. Nothing is enabled until you choose it. These are developer instructions applied alongside task and permission rules; they do not change model weights or make unsupported capabilities available. The 24/7 guardian and working AI use their own separate preferences. See [personalization](personalization.md).

## Resume or start a chat

```text
/chatt
/chatt open CHAT_ID
/chatt save
/chatt rename New title
/new
```

Visible prompts, received assistant text and queued text prompts automatically persist locally for this project. Reopen sudocli in the same project to resume its last chat. An interrupted assistant reply keeps the text already received; reopening provides that partial transcript as context rather than rerunning an old tool operation. Remaining queued prompts are restored. Unsaved keystrokes and original queued attachment bytes are not recovered.

`/chatt` lists saved project chats; use the displayed ID to reopen one. `/chatt save` checkpoints the current chat and `rename TITLE` changes its title. `/new` or `/chatt new` asks whether to keep or discard the current saved chat, then creates a fresh conversation. `/chatt delete ID` explicitly removes the selected saved chat after confirmation. Separate projects have separate last-chat pointers.

The current connection metadata is saved without an API key. Re-enter a key or use its configured environment variable after reopening. Known connection/service keys and terminal controls are removed from saved text; the transcript still contains other personal or confidential text you choose to enter. Storage is bounded and refuses corrupted or symbolic-link records. See [saved chat behavior](chats.md).

## Reasoning, context and history

```text
/effort
/effort high
/effort supported low,medium,high
/effort default
/compact
/handoff
```

`/effort` reports whether this connection has a declared support list. Standard native request values are none, minimal, low, medium, high, xhigh, max, ultra and persistent; unknown providers may reject them. `/effort supported` records your known model capabilities for this session; `/switch save NAME` persists that metadata. Custom values require a declared list. The CLI does not infer capacity from a model's name or parameter count.

Default sends no reasoning override. Native overrides are sticky across turns, so `/effort default` reconnects to clear a prior value and queues the visible chat for the next task. `/compact` calls native compaction and waits for completion; it changes model context while preserving the complete separate export history.

`/history` shows the full visible chat. `/handoff [DIRECTORY]` writes a separate portable Markdown and canonical JSON export; the default directory is `.sudocli/handoffs` under the project. Known runtime keys and terminal controls are removed; attachment metadata is included without original file bytes. Autosave continues independently of handoff exports.

`/clear` gives the engine fresh context and keeps visible history. `/history clear` removes that visible history from the current stored chat while leaving the active engine context intact. Neither deletes an already exported handoff file. Use `/new` for a fresh saved chat and fresh engine context together.

## Attach files and skills

```text
/upload "src/my file.js" "docs/screenshots"
/attachments
/attachments clear
/skills list
/skills load review
```

`/upload` reads and queues a snapshot locally. Sending the next prompt sends the queued text/images to the selected AI endpoint; inspecting the queue alone makes no network request. The queue is used once. Supported content is bounded UTF-8 text and PNG/JPEG/GIF/WebP images. Folder scans exclude dependencies, common credential files/content, symlinks and unsupported/binary formats with reported reasons. Defaults are 100 files per collection, 2 MiB total queued raw content, 512 KiB per text file, 5,000 inspected entries and 20 directory levels. Image/tool support still depends on the AI. See [attachment details](attachments.md).

For workspace skills, put a valid `SKILL.md` beneath `.agents/skills/NAME/`. `/skills list` shows native metadata/errors and actual loaded instruction sources such as AGENTS.md. `/skills load NAME` attaches an enabled native skill to the next prompt; `/skills clear` clears that skill queue. Skills are instructions, not model weight training.

## Permissions, web and computer tools

```text
/permissions ask
/web on
/mcp add browser http://127.0.0.1:8931/mcp
/mcp list
/mcp tools
/computer-use status
```

The URL above is an example; your service must already be running. Ask requests workspace sandboxing plus one-time execution approvals. Windows can report a stricter read-only fallback. `/permissions allow-everything` deliberately grants commands the elevated process's full local access without execution approval prompts. Administrator/root launch does not automatically select Allow Everything.

Web On permits sandboxed command networking and configured HTTP MCP services. Hosted web search additionally requires a compatible Responses provider. The Chat adapter uses command/MCP alternatives rather than hosted search. Web Off excludes hosted search and supplied HTTP MCP servers and requests sandbox networking Off in Ask. It keeps the host model API connection available and is not a firewall for full-access or approved escalated commands. Explicit voice/training service commands use their separately configured APIs.

`/computer-use setup NAME URL` designates a running MCP service for browser/desktop use. Model vision/tool support and that service determine what works. `on` permits its supplied tools. `off` reconnects and removes designated computer servers entirely; detected computer tools in previously classified mixed servers are denied through native raw-name filtering. Unknown/new servers are omitted while Off; a failed classification omits all supplied MCP servers. Adding/replacing a server invalidates its old classification. Inspect it with Computer Use On before retaining non-computer tools while Off.

Name-based detection cannot identify every renamed tool. Computer Use Off controls supplied MCP tools; it does not prevent terminal commands from launching OS software under the selected permission policy. `/mcp remove NAME` removes an entire server. The CLI does not install a browser/desktop automation service.

Changing permissions, Web Access, MCP configuration or computer policy stops foreground and detached background workers. Restart 24/7 mode explicitly to use the new policy. Ordinary model tasks reconnect under the new settings and retain chat history.

## Continuous voice and explicit transcription

```text
/voice setup
/voice speech
/microphone device "Exact Windows microphone name"
/microphone on
/voice live
/voice status
/voice off
```

`/voice setup` configures a compatible transcription endpoint/model/key. `/voice speech` separately configures the speech endpoint/model/voice/key. `/voice live` or `/live` starts continuous listening: detected utterances become ordinary prompts, and assistant replies play using an AI-generated voice. Listening continues during transcription, AI work and speech playback. New speech stops playback and interrupts an active AI turn. `/voice off`, `/microphone off`, or exiting stops audio capture/playback and pending audio requests.

Live voice requires native FFmpeg and FFplay on PATH and OS microphone permission. Windows needs an exact DirectShow device name, Linux uses PulseAudio, and macOS uses an AVFoundation audio index. Silence remains local and makes no transcription call. Speech is segmented with pre-roll and silence detection, with a 20-second phrase bound and one queued transcription phrase. A slow service that fills the queue asks you to repeat the dropped phrase.

Use headphones for reliable interruption. Energy detection has no acoustic echo cancellation, so speakers can feed the assistant's voice back into its microphone. Recognition quality and latency depend on the microphone, ASR, coding model, TTS and network. A chat-only model endpoint does not automatically supply audio APIs; this is continuous ASR/coding/TTS conversation rather than ChatGPT's exact proprietary backend. See [live voice details](live-voice.md).

With a configured transcription service, explicit input is also available:

```text
/voice record 10
/voice file "recording.wav"
```

`/voice file` uploads a selected audio file to `/audio/transcriptions`; `/upload` does not transcribe audio. Files are bounded to 25 MiB. Supported extensions are WAV, MP3, M4A, MP4, OGG, FLAC, WEBM and MPEG, subject to service support.

Microphone arming alone does not record. `/voice record SECONDS` starts an explicit 1–60-second FFmpeg recording; FFmpeg must be installed on PATH and the OS must permit microphone access. Windows needs an exact DirectShow device name, Linux uses PulseAudio, and macOS uses an AVFoundation audio index. Recordings use an owned temporary WAV that is removed when the command finishes normally.

Explicit `record`/`file` modes display the transcript first and ask Yes before sending it. Microphone arming alone does not record; continuous capture begins only with an explicit live-mode command. Service keys/settings remain in memory. Live capture writes no recordings to disk; recognized prompts and assistant replies use normal chat autosave. Spoken text is not treated as a permission approval or automatically executed slash command.

`/ide code` or `/ide cursor` opens the project in installed VS Code or Cursor. The assistant remains in this terminal; this command does not install or attach an editor extension. Missing editors/FFmpeg/backends receive setup errors. See [service details](services.md).

## Keep a guardian available 24/7

```text
/247 setup
/247 start
/247 add Check the failing build and fix its cause.
/247 list
/247 result JOB_ID
/247 retry JOB_ID
/247 stop
```

Setup selects a saved, already-running local AI on a loopback endpoint as the guardian and a working AI for heavier tasks. You can optionally supply a standing goal, checked by the local guardian every 60 seconds, and choose project folders to watch. Without a standing goal or queued task, it makes no model calls. Folder changes become explicit inbox jobs; task-generated changes are suppressed while work is active to avoid a feedback loop.

`/247 start` runs in this terminal and stops when the terminal session exits. Use `/247 detach` to launch a separate elevated worker that continues after you close sudocli. `/247 status` reports either worker, and `/247 stop` stops it. Detached operation requires the computer and local model service to remain running; reboot autostart is not installed.

The guardian assesses each job and either completes it locally, sends it to the working AI, or blocks it with a reason. It uses the same permission, web, MCP and computer policies as when started. A detached worker cannot ask you for an execution approval, so required approvals block the job. Changing those policies stops existing workers; restart explicitly with the updated settings. The two AIs retain their separate personalization instructions.

Jobs, reasons and results persist in a separate project inbox. `/247 list` shows their states, `result` displays a saved result, and `retry` requeues a blocked or failed job. Results do not automatically enter your resumed chat; view and use them when relevant. Runtime model/service keys are passed to the worker in memory and are not saved with jobs. See [guardian behavior](always-on.md) and [detached worker details](agent-worker.md).

Optional HTTPS or loopback wake/sleep hooks can start and stop cloud compute around work. This saves hourly GPU charges only if your provider's hook actually stops or deallocates the billed resource. An idle model request or sleeping worker alone does not release a rented GPU, and storage or other provider charges can continue.

## Export data or run a supported training job

```text
/training export
/training setup
/training start "training/conversation-EXAMPLE.jsonl"
/training status JOB_ID
/training cancel JOB_ID
```

Export writes a local JSONL dataset under `training/` by default, using complete text user/assistant exchanges. It can include repeated conversation prefixes for successive examples and excludes nontext/unfinished exchanges; review the result before uploading. The example filename above must be replaced with the actual exported path. Exports have 25 MiB/1,000-example bounds.

Setup requires a backend implementing compatible Files and Fine-tuning APIs and an actually fine-tunable model ID. Start asks before uploading the selected JSONL file and creating a provider job. Status reads the real job; Cancel asks before requesting cancellation. Provider charges, GPU resources, supported models and training outcomes belong to that backend. The CLI does not provide compute or modify an arbitrary connected model's weights. A user-supplied training MCP service can provide another workflow through its own tools.

## What persists

| Data | Storage/action |
| --- | --- |
| Command wrapper and installed runtime | First setup |
| Numeric worked-time totals | Automatic per-user checkpoints |
| Named AI metadata | Explicit profile save; no key values |
| Per-AI personalization | Explicit setup/save, independently enabled per connection |
| Visible chat, received partial replies and queued text prompts | Automatic project chat checkpoints; separate optional `/handoff` exports |
| 24/7 tasks, status reasons and results | Durable project task inbox |
| Detached worker control token | Private local record used only to authenticate status/stop |
| Training JSONL | Explicit `/training export` |
| Model/service keys, active permission/Web/effort settings and original queued attachment bytes | Running process only; detached workers receive a snapshot in memory |

`SUDO_CLI_STATE_DIR` can choose a different persistent state directory for profiles, personalization, chats, work totals and the task inbox. `/status` reports timers/context/connection state; `/doctor` diagnoses optional configuration. Normal `/quit` checkpoints the chat and numeric work totals, stops live audio and foreground guardian work, cleans the private engine and restores the terminal. A detached worker intentionally continues until stopped. Native macOS/ARM, physical audio capture/playback, production third-party models, desktop automation and real training services remain conditional/unverified. See [verification](verification.md) for the tested platforms and boundaries.
