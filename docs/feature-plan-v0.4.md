# codexcli 0.4 implementation and release plan

Goal: a terminal workspace with the supplied antenna/status design, discoverable commands, cloud/local model switching, complete visible-chat handoff, queued context, native engine controls and explicit optional-service operations.

Architecture: retain the private official native app-server and isolated home. Separate profiles/attachments, history/network, native protocol, optional services and terminal command handling. The desktop app stays untouched. Keys and service settings remain in memory; explicitly saved profiles contain nonsecret metadata only.

## Implemented

- [x] Dashboard uses Working/Not Working Status, real WiFi Yes/No/Unknown, current physical-interface RX/TX traffic, measured model connection estimate, reported context, permissions/Web/effort and worked totals.
- [x] Exact supplied 14-row antenna, fixed tower, six animated wave regions, 30 FPS target, 1.5-second pulse/0.20-second ring delay and frozen idle phase.
- [x] Slash command registry/menu and Tab completion, with quoted file paths and literal Windows backslashes.
- [x] Saved nonsecret AI profiles and local endpoint presets for already-running model servers; exact model/endpoint/key choices remain runtime actions.
- [x] Immutable bounded UTF-8/image/folder context queued for the next prompt; whole-file exclusions and limits are reported.
- [x] Complete visible user/assistant history, streamed/final reconciliation, secret/terminal-control filtering, explicit full Markdown/JSON handoff and complete transfer queued on the next prompt after reconnect.
- [x] Regular prompts submitted during work queue in order; native active-turn steering and interruption APIs preserve the active completion.
- [x] Native typed turn inputs, declared/unknown reasoning support and explicit reasoning propagation through the Chat adapter.
- [x] Native manual compaction completion/race/interrupt handling, actual skill loading, instruction-source reporting and model/skill/MCP/provider discovery.
- [x] Explicit external-editor launch, compatible transcription setup/audio-file requests/FFmpeg microphone recording, transcript review before sending.
- [x] Local JSONL dataset export and compatible Files/Fine-tuning job upload/start/status/cancel, with explicit start/cancel decisions.
- [x] Configured HTTP MCP inspection/computer-use controls and native tool-filter enforcement; unknown/designated computer servers remain omitted while Computer Use is Off.
- [x] Installer, current-user command registration, session isolation, secret handling and owned-resource cleanup retained from earlier releases.
- [x] Final full Windows/Linux suites and five real native integrations: Windows251 passed +6skips; Linux254 passed +3skips;257total per host,0failures.

## Final release checks

- [x] Final v0.4 Linux PTY review of queue/steering/command help, full-chat switch behavior, antenna phase and resize/hidden input/exit; bounded native Windows ConPTY smoke.
- [x] Refresh complete Windows/Linux suite counts after final integration/review changes.
- [x] Finish version0.4 metadata and portable/source archives with matching runtime/source/licenses and final hashes; extracted Windows bundle passes the full suite and 47 runtime hashes.
- [x] Record final test and terminal verification evidence in [verification.md](verification.md).

## Conditional or unavailable validation

Native macOS/ARM execution requires other hosts. Physical microphone capture requires FFmpeg/device permission and a transcription backend. Production browser/desktop use requires a working MCP service and model support. Real fine-tuning requires a provider/model/compute service. These services were not provisioned or exercised with live credentials during development.

There is no promise of universal model reasoning/image/tool compatibility, unlimited full-chat transfer or identical OS sandbox behavior. Web Off and Computer Use Off are native tool/sandbox controls with the documented scope; they are not system firewalls for full-access commands. Training does not change arbitrary connected model weights.

Review focus: no key persistence in profiles/exports; no silently shortened handoff or attachment; exact native policy/effort propagation; honest unknown capability/measurement states; safe subprocess arguments and filtered errors; explicit microphone/service invocation; clean queued-input and terminal lifecycle.
