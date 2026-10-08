# sudo cli progress

Current release: **0.6.7**. `/textcolor` is the canonical user-text command. `/notify on|off` saves separate non-speaking sounds for approvals, completion, interruption and errors. The antenna and worked-time meter follow AI tasks; local commands, update checks and setup stay idle. Waiting for approval pauses that AI's activity while other active AI tasks can continue.

Version 0.6.6 shows each graphics card by name, with its own VRAM capacity and readings. Installed cards remain visible when Windows cannot provide live usage, including a device-error label when reported. This avoids presenting an integrated card's 512 MiB as the capacity of a separate 8 GiB card. Version 0.6.5 introduced the local performance panel, consistent colors/resets, Search-line cursor, spaced command choices and reasoning-policy fixes.

See [performance support](performance.md), [terminal colors](terminal-colors.md), [model compatibility](model-compatibility.md) and the [user guide](user-guide.md). Windows and WSL/Linux host probes read actual local counters; macOS GPU parsing uses fixtures. Real model inference remains a separate endpoint test. Historical verification records still describe their named releases.

Version 0.6.4 added conversation scrolling, `/chat`, fresh-chat display resets and signed source integrity. Version 0.6.3 added saved lower chat colors, runtime reset targets, GitHub release checks, custom model editing tools, MiMo-shaped stream parsing, command termination and loop protection. See [0.6.4 verification](verification-v0.6.4.md) and [0.6.3 verification](verification-v0.6.3.md).

Version 0.6.2 added green prompt accents, a selectable slash menu and local model file inspection/import. Any extension can be inspected; actual loading depends on the model format, installed runner and hardware. See [local model files](local-model-files.md) and [previous verification](verification-v0.6.2.md). Version 0.6.1 added local setup, per-AI personalization and saved specialists: [local AI and agents](local-ai-and-agents.md). Version 0.6.0 implemented the 22 approved roadmap areas: [feature evidence](v0.6-feature-evidence.md) and [user guide](user-guide.md).

The notes below describe the historical 0.2 build, not the current feature set.

Scope: custom terminal CLI using open-source Codex engine; runtime-only setup; no ChatGPT changes. Version 0.2 adds Linux/macOS launch and runtime setup plus a live ASCII dashboard.
Ruling: replaced initial saved-profile/native-TUI design with in-memory wizard and isolated app-server, per explicit user clarification.
Ruling: reuse app-server through its documented protocol rather than compiling duplicate Rust engine; source/license are documented.
Pre-flight: bridge returns baseUrl/token/close; runtime builds providerArgs; root passes isolated home/env into engine. Events are {method,params}; file ownership is separate.
Tasks1-4 complete: runtime, bridge, engine client, custom UI and launchers implemented with tests.
Review fixes: serialize/abort prompts, handle stdin closure and termination, runtime reconnection ignores launch defaults, bridge respects model changes and keyless endpoints, stream redaction handles split keys and terminal controls.
Verification: Windows run: 121 tests, 120 passed, one platform-specific skip. Actual engine integrations exercised Chat Completions, a workspace file write with a narrowly approved fixture command, and native Responses streaming with a split credential. Native Linux integrations and PTY interaction passed; native macOS execution is pending.
Packaging: 0.2 Windows portable package includes Node and the SHA-256-verified official native Windows Codex release. Cross-platform package includes Unix/Windows launchers, runtime installer, OS-native CI workflow, complete matching upstream source archive and license notices. Linux runtime is tested locally and excluded from the Windows ZIP.
External model/provider verification remains a follow-up after the user selects a model. Search/computer tools require a supplied MCP server; no training/cloud host is provisioned.
