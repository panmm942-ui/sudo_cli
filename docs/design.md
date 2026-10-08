# codexcli 0.5 design

Project `codexcli`, command `sudocli`, SUDO CLI terminal identity. The custom Node.js frontend uses the unchanged official Codex 0.160.1 app-server over private stdio JSON-RPC. Each connection receives an isolated temporary `CODEX_HOME` and ephemeral thread. It does not reuse desktop authentication or settings. Node builtins supply the implementation; no npm packages are needed.

## Terminal and input

The dashboard reports time, detected system/architecture, Working/Not Working Status, WiFi, current interface traffic, confirmed AI, measured connection health, reported context, permissions, Web Access, effort, worked totals and project/activity. Status describes active work, not API reachability. Connection/model confirmation is tracked separately.

The supplied 14-row Braille antenna is preserved. Only the six wave regions change color; the tower remains constant. The pulse uses a 1.5-second period and 0.20-second ring delay, with a 30 FPS refresh target. A monotonic accumulated clock pauses on idle and resumes the phase when work returns. Local date/time continues independently. Alternate-screen entry/restoration, scroll-region restoration, erased line tails and resize handling keep terminal input usable. Hidden key input is not replayed during refresh or resize. Small/plain terminals degrade to compact output.

The command registry drives slash help and Tab completion. Quoted arguments group paths while preserving literal Windows backslashes. Regular prompts submitted during a turn are queued in order; the current work continues. `/stop` and Ctrl+C interrupt active work while preserving queued prompts. `/steer TEXT` uses the native active-turn precondition and cannot steer manual compaction. Normal command handling resumes when the current operation ends.

## State and persistence

Live model keys, session permissions/Web/effort, queued file contents and optional-service settings stay in memory. Sanitized visible chats, pending prompt text, task-inbox jobs/results and optional per-AI preferences intentionally persist. Explicit saved profiles retain only name, model, base URL, transport, optional context window, key environment-variable name, and user-declared supported effort levels. Key values are excluded. Private atomic records, project identity and bounded storage checks protect saved data; corrupt records and symbolic links are not overwritten.

The chat history stores complete visible user/assistant messages, with final text replacing streamed deltas. It preserves code, Unicode and whitespace after credential/terminal-control filtering. Previously used session keys remain known for export redaction. Tool internals and hidden reasoning are excluded. Attachment metadata is retained; file/image bytes are not embedded in chat exports.

Reconnects for model, endpoint and runtime-policy changes create a fresh engine. The complete sanitized visible transcript is queued as a text context item on the next task. No summary or truncation is substituted. Original attachment files must be queued again when needed. The target model's context limit and the 8 MiB request ceiling still apply; a handoff does not guarantee the new model can accept or reason over the whole conversation.

The project-specific last chat resumes automatically. Streamed checkpoints run at most once a second while work is active; turn/queue/exit boundaries also save. Partial replies remain distinguishable from completed replies. `/chatt` opens, renames or deletes saved chats; `/new` asks whether to retain the previous record. `/handoff` explicitly writes canonical JSON and readable Markdown; `/training export` explicitly writes JSONL. `/clear` clears model context while retaining history; `/history clear` clears and checkpoints visible history while preserving current engine context. Existing exports remain on disk.

Per-AI personalization is keyed by canonical endpoint, exact model and transport, then supplied through native `thread/start.developerInstructions`. Changing preferences reconnects with visible history. Disabling personalization retains its optional settings without applying them.

Worked uses monotonic active agent/tool time and pauses during idle input and approval waits. Session duration resets each launch. Unique atomic numeric records retain lifetime totals without overwriting concurrent sessions. Five-second checkpoints bound normal crash loss to the last successful write. These records contain no model, endpoint, key or chat.

## Measurements

Connection health comes from real upstream latency/errors and live pending waits. Native Responses stops pending decay on first semantic output; Chat Completions measures buffered completion readiness. Cancellation is excluded. The ten-request estimate uses green above 70%, orange 51–70%, and red at 50% or below. It is a transport-dependent heuristic.

The network sampler reads OS interface state/cumulative receive/transmit byte counters. Windows uses hidden NetAdapter PowerShell, Linux uses sysfs, and macOS uses hardware-port mapping plus ifconfig/netstat. It never runs a bandwidth probe or contacts a remote service. Ethernet is not classified as WiFi; unavailable or ambiguous samples stay Unknown. Rates aggregate connected OS-visible physical interfaces and require valid counter deltas. Resets/new interfaces restart baselines. WSL reports guest visibility, not host WiFi. See [history/network details](history-network.md).

## Native engine and adapters

`startTurn` accepts text or validated native input items, including text, image/localImage, audio/localAudio, skill and mention. Availability of audio/image interpretation belongs to the selected backend; accepting a native input shape does not establish support in the Chat adapter or model. User input cannot inject turn permission/settings fields.

Explicit reasoning effort reaches native `turn/start.effort`; Chat translation maps Responses `reasoning.effort` to `reasoning_effort`. Omitted effort stays omitted. Native standard strings include none/minimal/low/medium/high/xhigh/max/ultra/persistent. Declared profiles enforce their supported list and may add custom strings. Unknown provider support is never inferred from native catalog entries, model names or parameter counts. Native effort overrides persist across turns; `/effort default` reconnects to clear an earlier override.

Manual compaction sends `thread/compact/start` and waits for matching native turn completion, rather than treating its empty RPC acknowledgement as completion. Early notifications, missing-start timeout, interruption before turn ID and child shutdown are handled. Native context changes do not delete the separate complete visible transcript. Skill activation uses actual typed skill input; `skills/list` discovers enabled workspace skills. Instruction sources expose the AGENTS files loaded by the engine.

Discovery uses `model/list`, `skills/list`, `mcpServerStatus/list`, and `modelProvider/capabilities/read`. MCP catalog results retain raw tool identities for policy. Steering sends `turn/steer` with `expectedTurnId` after an active ID is known.

Both model transports use a private authenticated loopback adapter. Responses preserves native traffic with bounded in-memory timing observation. Chat converts supported text/images/tool history, translates namespaced/custom tools, retains reasoning content needed for tool rounds, and emits valid Responses JSON/SSE after buffering a complete Chat reply. Hosted native tools and `previous_response_id` are rejected. Raw upstream error bodies/credentials are not echoed.

## Policies and conditional services

Model-session admission requires effective UID zero on Linux/macOS or an elevated Administrator token on Windows. Detection fails closed and never requests elevation itself. Help, version, doctor and setup remain available without elevation. Ask requests workspace-write/on-request, including a stricter read-only Windows fallback when returned by the engine. Allow Everything is explicit never/danger-full-access under the admitted process's privileges. The actual returned policy is validated and exposed.

Web Off disables hosted search and supplied HTTP MCP servers and requests sandboxed-command networking Off in Ask. The host model API stays reachable. Allow Everything and approved escalation can still use OS networking; Web Off is not a system firewall. Web On permits sandboxed networking/MCP; hosted search additionally requires native Responses/provider support. The CLI does not provision a search service.

Computer/browser automation is supplied by configured HTTP MCP services. Computer Use Off reconnects with raw-name `disabled_tools` for detected automation tools in classified mixed servers. Setup-designated computer servers and unclassified/new servers are omitted; failed discovery omits all supplied MCP servers. Adding/replacing a server invalidates its classification. Detection depends on advertised names and is not a universal desktop-security boundary. Shell commands remain governed by the selected execution policy.

Explicit transcription clips remain available. `/voice live` additionally keeps FFmpeg microphone capture open, segments local PCM with adaptive energy detection, sends WAV phrases to compatible transcription, and plays compatible MP3 speech through hidden FFplay. Barge-in aborts playback and interrupts native model work. Voice transcripts enter a literal task queue; they never execute slash commands or answer permission questions. Audio queues and requests are bounded and cancellation reaps owned child processes. This uses ASR/TTS backends rather than claiming ChatGPT's proprietary realtime audio service or acoustic echo cancellation. Physical audio/server access still depends on the host.

The 24/7 coordinator owns an exclusive durable project inbox. Native local-model sessions assess explicit tasks, chosen folder events or an optional standing goal. Local results complete locally; wait/invalid decisions block without cloud work; cloud decisions launch isolated native working-model tasks. Standing-goal duplicates are suppressed across restart. Idle polling makes no model calls unless a local standing-goal heartbeat was explicitly configured. Provider wake/sleep HTTP hooks control GPU power only when configured; their actual billing effect belongs to the provider.

A hidden detached Node worker can survive terminal exit. Runtime credentials travel once over private IPC. A bounded private control record contains an authentication token and loopback server identity, never model keys. Authenticated status/stop requests do not kill arbitrary PIDs. Detached Ask declines needed approvals and leaves tasks blocked. Foreground policy or personalization changes stop background workers before new permissions apply. Worker startup settings are snapshots; credentials need to be supplied again after worker shutdown/reboot. No automatic boot service is installed.

Training export prepares complete text exchanges for review. Optional job controls call compatible `/files` and `/fine_tuning/jobs` APIs, with explicit upload/start and cancellation decisions. They do not train arbitrary connected models or allocate GPU/cloud resources. `/ide` opens the project in installed VS Code/Cursor; the assistant remains in the terminal and does not attach an editor extension.

## Delivery and validation

Setup verifies/installs pinned OS/architecture runtimes and registers a current-user command without administrator access. The portable Windows x64 package includes Node/native engine; source delivery supports Windows/Linux/macOS x64/arm64 selection. Installer/registration guards preserve unrelated files and PATH/profile content. Matching upstream source and notices accompany the unchanged engine.

Windows x64 and native Linux x64 are verified against deterministic localhost model/MCP fixtures. Native macOS/ARM, live third-party model capabilities, physical microphone operation and real provider training/computer-use jobs remain unverified. See [verification](verification.md) and [platforms](platforms.md).
