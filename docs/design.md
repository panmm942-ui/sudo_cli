# codexcli 0.4 design

Project `codexcli`, command `sudocli`, SUDO CLI terminal identity. The custom Node.js frontend uses the unchanged official Codex 0.160.1 app-server over private stdio JSON-RPC. Each connection receives an isolated temporary `CODEX_HOME` and ephemeral thread. It does not reuse desktop authentication or settings. Node builtins supply the implementation; no npm packages are needed.

## Terminal and input

The dashboard reports time, detected system/architecture, Working/Not Working Status, WiFi, current interface traffic, confirmed AI, measured connection health, reported context, permissions, Web Access, effort, worked totals and project/activity. Status describes active work, not API reachability. Connection/model confirmation is tracked separately.

The supplied 14-row Braille antenna is preserved. Only the six wave regions change color; the tower remains constant. The pulse uses a 1.5-second period and 0.20-second ring delay, with a 30 FPS refresh target. A monotonic accumulated clock pauses on idle and resumes the phase when work returns. Local date/time continues independently. Alternate-screen entry/restoration, scroll-region restoration, erased line tails and resize handling keep terminal input usable. Hidden key input is not replayed during refresh or resize. Small/plain terminals degrade to compact output.

The command registry drives slash help and Tab completion. Quoted arguments group paths while preserving literal Windows backslashes. Regular prompts submitted during a turn are queued in order; the current work continues. `/stop` and Ctrl+C interrupt active work while preserving queued prompts. `/steer TEXT` uses the native active-turn precondition and cannot steer manual compaction. Normal command handling resumes when the current operation ends.

## State and persistence

Live model keys, session permissions/Web/effort, queued file contents, optional-service settings and visible conversation stay in memory. Explicit saved profiles retain only name, model, base URL, transport, optional context window, key environment-variable name, and user-declared supported effort levels. Key values are excluded. Profile records use hashed names, per-profile locks and atomic replacement. Corrupt records and symbolic links are not overwritten.

The chat history stores complete visible user/assistant messages, with final text replacing streamed deltas. It preserves code, Unicode and whitespace after credential/terminal-control filtering. Previously used session keys remain known for export redaction. Tool internals and hidden reasoning are excluded. Attachment metadata is retained; file/image bytes are not embedded in chat exports.

Reconnects for model, endpoint and runtime-policy changes create a fresh engine. The complete sanitized visible transcript is queued as a text context item on the next task. No summary or truncation is substituted. Original attachment files must be queued again when needed. The target model's context limit and the 8 MiB request ceiling still apply; a handoff does not guarantee the new model can accept or reason over the whole conversation.

`/handoff` explicitly writes canonical JSON and readable Markdown. `/training export` explicitly writes JSONL. There is no automatic conversation save. `/clear` clears model context while preserving export history; `/history clear` clears export history while preserving current engine context. Existing exported files remain on disk.

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

Ask requests workspace-write/on-request, including a stricter read-only Windows fallback when returned by the engine. Allow Everything is explicit never/danger-full-access under the user's privileges. The actual returned policy is validated and exposed.

Web Off disables hosted search and supplied HTTP MCP servers and requests sandboxed-command networking Off in Ask. The host model API stays reachable. Allow Everything and approved escalation can still use OS networking; Web Off is not a system firewall. Web On permits sandboxed networking/MCP; hosted search additionally requires native Responses/provider support. The CLI does not provision a search service.

Computer/browser automation is supplied by configured HTTP MCP services. Computer Use Off reconnects with raw-name `disabled_tools` for detected automation tools in classified mixed servers. Setup-designated computer servers and unclassified/new servers are omitted; failed discovery omits all supplied MCP servers. Adding/replacing a server invalidates its classification. Detection depends on advertised names and is not a universal desktop-security boundary. Shell commands remain governed by the selected execution policy.

Voice uses separately configured compatible `/audio/transcriptions` requests. FFmpeg recording is explicit, bounded to 1–60 seconds, requires microphone arming/device access, and has an owned temporary WAV. The user reviews the transcript and explicitly chooses whether to send it. Native realtime protocol/private voice-host code exists upstream, but this release does not expose a universal realtime speech backend.

Training export prepares complete text exchanges for review. Optional job controls call compatible `/files` and `/fine_tuning/jobs` APIs, with explicit upload/start and cancellation decisions. They do not train arbitrary connected models or allocate GPU/cloud resources. `/ide` opens the project in installed VS Code/Cursor; the assistant remains in the terminal and does not attach an editor extension.

## Delivery and validation

Setup verifies/installs pinned OS/architecture runtimes and registers a current-user command without administrator access. The portable Windows x64 package includes Node/native engine; source delivery supports Windows/Linux/macOS x64/arm64 selection. Installer/registration guards preserve unrelated files and PATH/profile content. Matching upstream source and notices accompany the unchanged engine.

Windows x64 and native Linux x64 are verified against deterministic localhost model/MCP fixtures. Native macOS/ARM, live third-party model capabilities, physical microphone operation and real provider training/computer-use jobs remain unverified. See [verification](verification.md) and [platforms](platforms.md).
