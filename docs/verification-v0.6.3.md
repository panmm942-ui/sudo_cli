# Version 0.6.3 verification

Verified locally on 2026-10-08 with Node 24.19.0 and the pinned Codex native engine 0.160.1. No paid model service, actual MiMo inference, user weights, physical microphone or desktop automation service was used.

## Complete test suites

| Host | Discovered | Passed | Platform skips | Failures | Cancellations |
| --- | ---: | ---: | ---: | ---: | ---: |
| Windows x64, standard user token | 693 | 669 | 24 | 0 | 0 |
| Linux x64, Kali WSL root | 693 | 684 | 9 | 0 | 0 |

Both complete suites were run after the final JSON nullable-tool-field and declared-vision fixes. Tests include runtime admission, native execution, provider conversion, permissions, persistence, agents, verified updates, reset selection/confirmation, contrast, repetitive tool actions and command lifetime monitoring.

## Actual terminal and native engine checks

| Acceptance | Result |
| --- | --- |
| Saved colors and contrast | Seven real Linux PTY checks passed: lower background separation, live user text and old text recoloring, slash menu, 35×8 shrink and 150×44 restore, saved restart, independent/combined resets and plain modes. |
| Custom model tool loop | Both Chat Completions and Responses passed, with 18 fixture provider requests each and no fixture errors. Exact custom model IDs received declared native `apply_patch`. File reads, patches, a failed test, repair and a passed test completed. |
| Command cancellation and timeout | Actual long command processes ended after `/stop`, including a yielded process after its turn finished. A one-second watchdog stopped another actual process. Delayed writes did not occur; subsequent turns completed. |
| Repetition protection | Each transport stopped after four identical read actions/results, before a fifth provider request. Explicit subsequent work completed. |
| Live slash picker and local files | All 63 registered commands were selected without automatic execution. Literal paste, multiline input, busy interruption and content-based inspection of a renamed synthetic GGUF passed. Three provider requests; four clean exits. |
| Local AI, preferences and agents | Retained acceptance passed with 25 streamed fixture requests, two local catalog requests and two clean exits. Covered per-AI preferences, specialist selection, parallel teams, coding proposals, reviewed application, steering and cancellation. |
| Broad regression | Retained acceptance passed with 22 streamed fixture requests and five clean exits. Covered saved chats, memory, native edits, checks, conflict-preserving undo, reviewed replay and budgets. |

The [model-loop receipt](verification-v0.6.3-model-loop.json) and [theme receipt](verification-v0.6.3-theme.json) accompany the source. Manual reproduction scripts are under `test/manual/`.

## Update and review evidence

GitHub tests exercise bounded release metadata, exact platform selection, stable version ordering, y/n admission, changed-offer rejection, digest/checksum agreement, asset redirects, exact installed-version matching, native verification, command registration compensation and retained rollback. The configured public latest-release endpoint returned HTTP 404 during development, so no real GitHub upgrade was available or installed. [Publishing requirements](github-updates.md) list the necessary release tag, ZIP and checksum assets.

Independent review found and resolved cancellation during upgrade preparation, tiny terminal header background bleed, a declared-capabilities name collision and nullable tool fields in JSON responses. Full suites passed after the production fixes. The original antenna source, characters, spacing and animation timing were retained. The Codex desktop app was not changed.

## Practical limits

The provider decisions in acceptance are deterministic fixtures, not MiMo inference or a model-quality benchmark. A real endpoint still needs the [coding workflow check](model-compatibility.md). Repetition detection is conservative and bounded; deliberate quiet polling may trigger it. Command timeouts measure from the first observed native session and require its termination acknowledgement.

Windows code/runtime tests passed. Physical Windows ConsoleHost interaction, macOS/ARM hardware, real model weight loading, physical audio and paid GPU/training services were not exercised. The six-target CI definition exists, but remote CI runs are not claimed. The model-loop harness disables the unrelated native plugin catalog refresh inside its isolated test observer; actual model requests, tool execution, approvals and command processes use the native engine.
