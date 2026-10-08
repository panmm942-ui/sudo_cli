# Using sudocli 0.4

Complete [first setup](platforms.md), open a new terminal and run `sudocli` from your project. A UTF-8 terminal with Braille/truecolor support displays the supplied antenna. A wide, tall window such as 100 columns by 32 rows leaves room for the dashboard and conversation. Plain output remains available with `NO_COLOR=1` or `TERM=dumb`.

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

`/history` shows the full visible chat in memory. `/handoff [DIRECTORY]` writes both Markdown and canonical JSON; the default directory is `.sudocli/handoffs` under the project. Known connection keys and terminal controls are removed; attachment metadata is included without original file bytes. Chat is not automatically saved on exit. Export any transcript you want to keep.

`/clear` gives the engine fresh context and keeps export history. `/history clear` removes export history from memory and leaves the current engine context intact. Neither deletes an already exported handoff file.

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

The URL above is an example; your service must already be running. Ask requests workspace sandboxing plus one-time execution approvals. Windows can report a stricter read-only fallback. `/permissions allow-everything` deliberately grants commands your user's full local access without execution approval prompts; it does not grant administrator/root privileges.

Web On permits sandboxed command networking and configured HTTP MCP services. Hosted web search additionally requires a compatible Responses provider. The Chat adapter uses command/MCP alternatives rather than hosted search. Web Off excludes hosted search and supplied HTTP MCP servers and requests sandbox networking Off in Ask. It keeps the host model API connection available and is not a firewall for full-access or approved escalated commands. Explicit voice/training service commands use their separately configured APIs.

`/computer-use setup NAME URL` designates a running MCP service for browser/desktop use. Model vision/tool support and that service determine what works. `on` permits its supplied tools. `off` reconnects and removes designated computer servers entirely; detected computer tools in previously classified mixed servers are denied through native raw-name filtering. Unknown/new servers are omitted while Off; a failed classification omits all supplied MCP servers. Adding/replacing a server invalidates its old classification. Inspect it with Computer Use On before retaining non-computer tools while Off.

Name-based detection cannot identify every renamed tool. Computer Use Off controls supplied MCP tools; it does not prevent terminal commands from launching OS software under the selected permission policy. `/mcp remove NAME` removes an entire server. The CLI does not install a browser/desktop automation service.

## Voice input and editor

```text
/voice setup
/microphone device "Exact Windows microphone name"
/microphone on
/voice record 10
/voice file "recording.wav"
/voice off
/ide code
```

Voice setup requests a compatible transcription API base URL, transcription model and optional hidden key. `/voice file` uploads a supported local audio file to `/audio/transcriptions`; `/upload` does not transcribe audio. Files are bounded to 25 MiB. Supported extensions are WAV, MP3, M4A, MP4, OGG, FLAC, WEBM and MPEG, subject to service support.

Microphone arming alone does not record. `/voice record SECONDS` starts an explicit 1–60-second FFmpeg recording; FFmpeg must be installed on PATH and the OS must permit microphone access. Windows needs an exact DirectShow device name, Linux uses PulseAudio, and macOS uses an AVFoundation audio index. Recordings use an owned temporary WAV that is removed when the command finishes normally.

The transcript is displayed first. It becomes an AI task only when you explicitly answer Yes to sending it. `/microphone off` disarms recording; `/voice off` also clears the transcription-service configuration. Service keys/settings are not saved. This provides speech-to-text prompts, not universal realtime voice chat with any connected model.

`/ide code` or `/ide cursor` opens the project in installed VS Code or Cursor. The assistant remains in this terminal; this command does not install or attach an editor extension. Missing editors/FFmpeg/backends receive setup errors. See [service details](services.md).

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
| Complete visible chat | RAM until explicit `/handoff` export |
| Training JSONL | Explicit `/training export` |
| Model/service keys, permissions/Web/effort and queued inputs/files | Running process only |

`SUDO_CLI_STATE_DIR` can choose a different profile/work directory. `/status` reports timers/context/connection state; `/doctor` diagnoses optional configuration. Normal `/quit` saves numeric work totals, cleans the private engine and restores the terminal. Windows x64 and Linux x64 are tested; native macOS/ARM, physical audio capture, production third-party models, desktop automation and real training services remain conditional/unverified. See [verification](verification.md).
