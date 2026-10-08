# Verification — codexcli 0.5 / sudocli

October 7, 2026; Node.js 24.19.0; unchanged official Codex 0.160.1. Fresh complete `node --test` results:

| Host | Tests | Passed | Skipped | Failed |
| --- | ---: | ---: | ---: | ---: |
| Windows x64, standard user token | 360 | 342 | 18 | 0 |
| Native Linux x64, Kali WSL, effective UID 0 | 360 | 355 | 5 | 0 |

Platform-specific filesystem/device cases are skipped on other hosts. The Windows process is not elevated: actual model-session admission is rejected before engine startup/state writes, while help, version and doctor work. Elevated CLI integrations and root-only detached-worker cases are skipped on this Windows host and exercised on native root Linux. Direct native runtime/library tests still execute on Windows against localhost fixtures. macOS and ARM have not been run locally.

## Native terminal verification

Three root Linux terminal launches exit cleanly and make eleven real native-engine model requests against a deterministic localhost service. Checks cover saved new/open/restart chat chronology and isolation, per-AI developer instructions in actual prompts, local and cloud 24/7 tasks, working dashboard, idle zero-model calls, malformed decisions with zero cloud calls, detached survival after terminal close, durable result inspection, and stopping foreground/detached workers before permission/Web changes. Known fixture keys appear in neither terminal transcripts nor saved JSON.

An additional root Linux live-voice terminal launch exits cleanly. Private fake FFmpeg/FFplay executables supply synthetic continuous PCM and discard playback; four detected utterances reach compatible localhost transcription and four speech requests. The real native agent receives recognized text. Tests demonstrate literal slash recognition preserving Ask, playback barge-in, active native model interruption, spoken `yes` remaining a task rather than permission approval, a typed denial unblocking the queued prompt, and `/voice off` ending capture/transcription. No physical microphone/speaker or paid service is used.

The reusable [Linux terminal regression runner](../test/manual/verify-terminal-linux.py) requires Python 3, Node.js, the installed native engine and effective UID 0. It uses temporary projects and local fixtures; it does not use physical audio. The exact antenna, wave masks, colors, timing and idle phase are also covered by automated dashboard/antenna tests. Earlier terminal/Windows ConPTY checks are recorded in [v0.4 verification](verification-v0.4.md).

## Storage, runtime and background behavior

Tests cover complete Unicode history/partial reply restore, queued prompts, project identity, secret filtering, corrupt record preservation, symlink refusal, private Unix modes, serialized chat changes and atomic read/write generations. Concurrent readers and Windows temporary rename conflicts retry only bounded filesystem cases. Per-AI identity isolates endpoint/model/transport; disabled preferences remain optional and native developer instructions are validated.

Native runtime tests execute real workspace tools and Responses streams against local fixtures. Typed input, MCP filters, reasoning, manual compaction, steering, approval decisions, engine startup cancellation, bridge deadlines, bounded messages and cleanup are exercised. Temporary engine settings/authentication remain private; no desktop settings/login are reused.

Audio tests verify PCM/WAV, adaptive detection, silence making zero requests, bounded ASR backlog, compatible multipart/speech requests, callback safety, interruption/restart and full child reaping. Recorder/player processes are hidden and spawned without a shell.

Background tests launch an actual detached child, verify it survives its launcher, deny unauthenticated controls, refuse duplicate ownership, enforce parent/child elevation, block needed unattended approvals even if the provider fails afterward, and run actual local/working native-model sessions. Model and power-hook keys travel via IPC and never enter arguments/control records. Task recovery blocks interrupted work; explicit retry is required. Folder watches are project scoped and suppress worker feedback; repeated standing-goal cloud prompts are suppressed across restart.

Wake/sleep tests use actual localhost POST hooks, validate order, block cloud work after failed wake, expose sleep failures, reject redirects/remote plaintext/URL credentials and enforce bounded time/body sizes. Hooks are interfaces to a separately supplied GPU power service. Provider GPU state and billing have not been verified by these fixtures.

## Release boundaries

The portable Windows package includes Node.js, Codex, complete pinned upstream source and notices. The source package selects/downloads verified native engines for Linux, macOS and Windows; it requires Node.js 22+. Setup registers the current-user command and does not elevate. Runtime file hashes and sibling release SHA-256 sums accompany the archives.

Both archives contain the same 112 source/document/test files, verified against the project by SHA-256. The Windows archive adds 47 verified runtime files plus their manifest; its extracted bundled-Node suite passes 342 tests with 18 skips. The extracted source archive passes 355 tests with 5 skips on root Linux using the installed pinned native engine. Version, doctor and setup help work from the extracted Windows bundle without model calls. Generated Python caches are excluded. Optional cleanup of one generated cache was rejected by automatic approval review with “blocked by policy”; it remains outside the release archives.

Physical audio, acoustic echo cancellation, native macOS/ARM execution, paid model compatibility, production web/computer-use MCP services, fine-tuning jobs and GPU billing are unverified. Continuous ASR/TTS voice depends on separately compatible services and FFmpeg/FFplay; it does not claim ChatGPT's proprietary voice backend. API inactivity alone does not stop hourly GPU charges, and stopped resources can still have provider storage charges. No cloud host or boot service was provisioned. The desktop app remains unchanged.
