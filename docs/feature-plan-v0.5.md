# Persistent assistant implementation plan

**Goal:** Extend codexcli with per-AI preferences, automatic saved chats, administrator/root admission, continuous interruptible voice, and a useful local-first always-on agent.

**Architecture:** Keep the unchanged private Codex engine and exact antenna. Separate storage, audio, privilege detection and background coordination. Runtime commands configure all services; keys remain in RAM/environment. Saved chat metadata and user-requested preferences intentionally persist.

**Stack:** Node.js 22+ standard library, Codex 0.160.1 native app-server, FFmpeg/FFplay for microphone/speaker, compatible ASR/TTS HTTP backends. Windows x64 and native WSL Linux are available; Mac/ARM and physical audio need other hosts.

## Constraints and review focus

- Require Administrator/root before starting any model session; help/version/doctor/setup remain available without elevation. No automatic UAC/sudo escalation.
- Preserve antenna glyphs, spacing, palette, 30 FPS, 1.5-second period and 0.20-second wave delay.
- Auto-save the current project chat, including partial responses; keys are redacted and attachment bytes are not persisted. Resume visible context rather than hidden model state or running OS processes.
- New chat asks whether to retain the old saved chat. `/chatt` lists/open/rename/delete saved chats with project identity checks.
- Live voice continuously captures while transcription, model work and speech occur; voice onset interrupts speech/work. Explicit start/stop, bounded queues, no implicit microphone access. Echo cancellation is a hardware/backend boundary.
- Always-on mode remains idle without cloud calls. Local model assessment and explicit jobs/folder events trigger cloud work; generation failure does not become a duplicate automatic job. GPU idle billing needs configured provider power hooks; API inactivity alone cannot guarantee that billing stops.
- Test restart/corrupt storage, interrupted audio, failed hooks, queued input races, unknown privileges, unsupervised approvals and shutdown. Use synthetic audio/local HTTP fixtures rather than real microphone/paid services.

## Tasks and interfaces

- [x] Saved chats: `chat-store.mjs` create/save/get/list/last/setLast/remove and `chat-history.mjs` restore; atomic bounded records, current-project pointers, safe metadata and transcript replay. Tests restore full chronology, redaction, interrupted messages, cross-project and concurrent storage.
- [x] Preferences/privileges: `personalization.mjs` per-connection get/save/remove and native developer instructions; `privileges.mjs` elevated token/effective UID checks. Tests verify known-secret exclusion, profile identity, optional disabling and fail-closed admission.
- [x] Live audio: `live-voice.mjs` start/stop/speak/interruptSpeech/snapshot, PCM segmentation and compatible speech APIs. Tests use speech/silence PCM, real fake child processes and localhost ASR/TTS, including interruption/cancellation.
- [x] Always-on: `always-on.mjs` persistent inbox and coordinator with injected local evaluation/cloud execution/power hooks; `agent-worker.mjs` detached worker, authenticated local status/stop control, no key files. Tests idle behavior, event deduplication, power lifecycle and restart-safe jobs.
- [x] Integrate: new `assistant-features.mjs` commands, main input queue shared by keyboard/voice/background; autosave start/end and streamed checkpoints; root gate and persona in native thread creation. Meaningful router and real native flow tests.
- [x] Verify/release: complete Windows library/privilege tests, root Linux full suite/native PTY, extracted Windows bundle, source/runtime consistency and SHA-256 archives for v0.5. Document conditional services and native host gaps.

Each implementation task starts with a failing behavior test, implements its public contract, runs targeted checks, then receives an independent integration review. Final release checks include the whole suite and actual native engine requests.

The user explicitly authorized implementation and useful improvements; execution uses parallel owners for independent subsystems and root integration. No extra design approval is required.

