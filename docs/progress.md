# sudo cli progress

Current release: **0.6.3**. Saved lower chat colors with contrast correction, runtime reset targets, GitHub release checks with confirmed verified updates, custom model editing tools, MiMo-shaped stream parsing, native command termination and loop/timeout protection are implemented. See [terminal colors](terminal-colors.md), [GitHub updates](github-updates.md), [model compatibility](model-compatibility.md), [reset settings](reset-settings.md) and [current verification](verification-v0.6.3.md).

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
