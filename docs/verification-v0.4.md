# Verification — codexcli 0.4 / sudocli

October 7, 2026; Node.js 24.19.0; unchanged official Codex 0.160.1. Final v0.4 full-suite results:

| Host | Total | Passed | Platform skips | Failures |
| --- | ---: | ---: | ---: | ---: |
| Windows x64 | 257 | 251 | 6 | 0 |
| Native Linux x64 in the existing WSL2 distribution | 257 | 254 | 3 | 0 |

No tests were cancelled. Commands were `node --test` on Windows and the same command in Linux with the project-local Linux Codex executable selected. Model/MCP/service boundaries use deterministic local fixtures. A final MCP-readiness filter fix also passes its six targeted command tests on both hosts. The eight real command-router integrations cover local AI/profile setup, voice multipart/accept/decline/abort, and training upload/start/status/cancel/export with actual local HTTP requests.

## Real native engine checks

Five integration tests pass on both hosts:

1. A task reaches the Chat Completions model boundary and returns its response without leaking the fixture key.
2. A model tool call executes a narrowly approved fixture command that writes a proof file inside the selected workspace.
3. Native Responses streaming preserves bytes, redacts a key split across deltas, confirms a real response, and retains numeric work records across two launches.
4. Workspace SKILL.md discovery and typed skill loading insert actual instructions into a model request; AGENTS instruction sources are reported; high reasoning reaches `reasoning_effort`; native manual compaction makes a model request and the next task includes its summary.
5. A harmless MCP server advertises browser_click and add_numbers. Native `disabled_tools` removes browser_click from both the catalog and actual model declarations while retaining arithmetic. No browser/desktop action occurs.

Native manual compaction emits its contextCompaction item through notifications; its completed turn can have an empty items array. The client waits for native turn completion, handles completion before RPC response, matches thread/turn IDs and interrupts safely before the compact turn ID arrives. A missing-start notification times out. Process-boundary steering tests verify the required active-turn ID and refusal during manual compaction.

## Other covered behavior

The suite covers typed native input validation, optional effort/profile support, Chat reasoning payloads, text/images/function/custom/namespace tool history, rejected hosted tools, redaction across stream splits and terminal controls, hidden wizard input, isolated engine homes, interruption, child failure and clean shutdown.

Profile tests check nonsecret allowlisted metadata, per-name locks/atomic writes, concurrent records, corrupt records, size limits and symlink refusal. Attachment tests check immutable bounded text/image context, UTF-8/signatures, quoted paths, common credentials, excluded directories, changed files, limits and explicit warnings. History tests preserve complete text/code/Unicode/whitespace, reconcile final messages without duplication and export canonical JSON/Markdown. Optional-service tests exercise transcription multipart requests, explicit fine-tuning API calls, dataset export, literal editor arguments, and microphone argument/cancellation handling with fake processes. These do not establish physical microphone or real provider behavior.

Dashboard tests cover exact antenna artwork/timing constants, fixed tower colors, work/idle phase, detected systems, Working/Not Working and WiFi values, context/health/permission/work fields, small/plain terminals, clock/cursor/resize/terminal restoration. Network tests cover actual interface counter deltas, 64-bit precision, reset/new-interface baselines, OS parsing, unavailable samples, Ethernet classification and overlapping reads. They do not run Internet speed tests.

Health tests cover measured latency/errors, long pending waits, first semantic output, partial stream failures, intentional cancellation and bounded recent history. Work tests cover idle/approval pauses, session reset, numeric-only lifetime persistence, concurrent instances, crash checkpoints and retry after storage failure.

## Terminal and platform evidence

The v0.4 native Linux PTY main check exits 0 after seven real local model requests. It preserves every original antenna row, produces 50 distinct busy frames, freezes idle/completed colors, preserves hidden keys and typed prompts across resize, delivers queued prompts, lists the full menu, switches profiles/models with complete sanitized chat, renames saved profiles correctly, sends immutable one-turn file contents, completes native compaction and exports all 12 visible messages in chronological Markdown/JSON. `/clear` resets model context while preserving export history; the alternate screen and scroll region restore on exit.

A supplemental native Linux PTY check has two clean exits and five additional model requests. Native `/steer` reaches the active turn and is recorded once. A queued `/switch` runs before the queued task; the task appears once under the new model and is absent from the prior-history copy. Saved-profile startup keeps keys hidden during resize. Session time resets and lifetime numeric records retain 3,409 ms + 3,296 ms. No chat is automatically persisted across launches. Headers fit the complete logo/antenna, traffic, context and timers at 100/110 columns by 32 rows.

A native Windows ConPTY smoke verifies the Windows header/antenna, help menu, one model request, complete redacted two-message handoff and `/quit` exit 0. It uses ASCII synthetic input. That harness cannot verify raw alternate-screen escape restoration because ConPTY transforms those bytes; synthetic Unicode input is also unverified by this harness. These limitations are not established product failures. Restoration is covered by the rendering tests and native Linux PTY tests. No visible windows, real microphone, paid service, or real home/profile data was used in these smoke checks.

The earlier v0.3 Linux PTY check additionally covered Ctrl+C and runtime Web/Permissions combinations across two launches; v0.4 reconnects preserve visible transcript history for the next prompt instead of discarding it.

All four permission/Web combinations were previously probed with real engines. Linux Ask returned workspaceWrite with networkAccess matching Off/On. Windows Ask returned the stricter readOnly/networkfalse fallback, which the UI exposes. Both returned never/dangerFullAccess for Allow Everything. Web Off remains a tool/sandbox choice, not a full-access OS firewall; the model API remains reachable.

Actual Windows `setup.cmd --command-only` registered the current-user wrapper; discovery, doctor and version passed. Native Unix setup/command execution passed in a temporary home. Tests cover installer hash/size/host checks, safe extraction, interrupted/concurrent installation, foreign commands, quote handling, Windows raw PATH preservation and shell-profile preservation. New terminals can be needed to inherit PATH.

## Verification boundaries

The final Windows portable archive was extracted into an owned verification directory. Its bundled launchers report codexcli 0.4.0 / Codex 0.160.1; `doctor` and setup help pass without model traffic. All 47 runtime manifest hashes match the extracted files. The extracted bundle's full suite also passes 257 total / 251 passed / 6 platform skips / 0 failures. The source archive has 82 files, including hidden CI configuration, complete upstream source and notices, and no platform binaries. Sibling `codexcli-0.4.0-SHA256SUMS.txt` records release archive hashes.

Automatic approval review blocked optional removal of one earlier temporary Windows ConPTY test folder with the reason “blocked by policy.” It was left in place; no cleanup retry or workaround was used.

Native macOS, Windows/Linux ARM, physical audio recording, live Kimi/MiMo/GLM compatibility, actual browser/desktop automation and real fine-tuning jobs are not verified on this Windows/WSL host. Platform selection and fixture parsing cover those code paths without proving native execution. The three-OS CI matrix can add host coverage when run in a repository.

No cloud model/GPU/training host, external search provider or production computer-use service was provisioned. Keys remain in memory/environment; named profiles contain metadata only; work records are numeric; chat and dataset exports are explicit. The desktop app's settings/authentication/install are untouched. Archives include the complete pinned source and notices; portable runtime hashes and release SHA-256 sums accompany the release.
