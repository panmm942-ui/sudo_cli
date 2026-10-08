# Release verification — codexcli 0.6.0

Verified on October 8, 2026 with Node.js 24.19.0 and the unchanged official Codex 0.160.1 engine. All 22 approved upgrade areas have concrete implementations; see [feature evidence](v0.6-feature-evidence.md) and the [user guide](user-guide.md).

## Complete automated suites

Both final commands exited 0: `node --test --test-concurrency=4`. Linux explicitly ran as root. Each suite discovered 510 tests.

| Host | Passed | Platform skips | Failed | Cancelled |
| --- | ---: | ---: | ---: | ---: |
| Windows x64, standard user token | 487 | 23 | 0 | 0 |
| Linux x64, Kali WSL, effective UID 0 | 501 | 9 | 0 | 0 |

Windows verification covers actual native runtime/library fixtures, protected-key storage, browser actions and refusal of non-administrator model-session admission. Elevated Windows sessions and root-only worker integrations are skipped on that host and exercised on root Linux. Platform-specific filesystem/device cases are skipped on other hosts. macOS and ARM jobs are defined in CI but have not run here.

## Actual terminal and tool behavior

The final [Linux PTY runner](../test/manual/verify-v0.6-linux.py) passed against the real native engine: 22 streamed loopback model requests, zero offline requests and four clean CLI exits. It checked file edits, checkpoint review/undo, explicit checks, saved-chat isolation/restart, per-model settings, literal multiline/busy paste, invalid-connection offline recovery, reviewed context replay and budget admission. Synthetic keys appeared in neither terminal output nor saved JSON. See [terminal evidence](v0.6-terminal-evidence.md).

Native sandbox probes separately confirmed that restricted checks cannot write outside the project or selected roots, read-only checks cannot write project files, Web Off receives an explicit network denial, and unrelated synthetic credentials do not reach the check. Output limits and timeouts terminate owned check processes. Windows enforcement either blocks the outside write or refuses the whole check; neither path falls back to unrestricted execution.

Background acceptance runs before durable completion. Selected failed checks fail a job; selected uncertain checks block it for review. A result without selected checks remains Needs review. A real Windows read-handle regression and concurrent session test also confirm bounded worked-time checkpoint retries without overwriting other sessions.

The dedicated Windows Chromium adapter passed actual navigate/read/click/type/screenshot actions against a local page. The screenshot was 10,702 bytes and the owned browser closed cleanly. Voice tests use synthetic PCM and temporary recorder/player fixtures; no physical audio device was used.

## Packages and dependencies

The Windows x64 ZIP includes Node.js, the official native engine/helpers, complete matching upstream source and notices. The cross-platform ZIP includes the same frontend/source/docs/tests and runtime installer; Node.js 22+ is required. Windows ZIP creation does not retain Unix executable bits, so source installation uses `sh ./setup`.

Sibling SHA256SUMS and build records identify the releases and every source/runtime file. The independent release verifier uses Python's ZIP/CRC implementation, compares extracted source hashes with this project, verifies runtime metadata/hashes and executes the extracted CLI version and doctor. It never registers a command or installs a service.

Actual model/provider capabilities, physical microphone/speaker behavior, acoustic echo cancellation, external desktop services, production web search, fine-tuning, GPU provisioning/billing and native macOS/ARM execution remain unverified. Voice needs compatible ASR/TTS plus FFmpeg/FFplay. GPU hooks need a separate provider power service; inactivity alone does not stop hourly charges. No cloud host or OS startup service was provisioned. The Codex/ChatGPT desktop app was not modified.
