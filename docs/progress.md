# sudo cli progress

Scope: custom terminal CLI using open-source Codex engine; runtime-only setup; no ChatGPT changes. Version 0.2 adds Linux/macOS launch and runtime setup plus a live ASCII dashboard.
Ruling: replaced initial saved-profile/native-TUI design with in-memory wizard and isolated app-server, per explicit user clarification.
Ruling: reuse app-server through its documented protocol rather than compiling duplicate Rust engine; source/license are documented.
Pre-flight: bridge returns baseUrl/token/close; runtime builds providerArgs; root passes isolated home/env into engine. Events are {method,params}; file ownership is separate.
Tasks1-4 complete: runtime, bridge, engine client, custom UI and launchers implemented with tests.
Review fixes: serialize/abort prompts, handle stdin closure and termination, runtime reconnection ignores launch defaults, bridge respects model changes and keyless endpoints, stream redaction handles split keys and terminal controls.
Verification: Windows run: 121 tests, 120 passed, one platform-specific skip. Actual engine integrations exercised Chat Completions, a workspace file write with a narrowly approved fixture command, and native Responses streaming with a split credential. Native Linux integrations and PTY interaction passed; native macOS execution is pending.
Packaging: 0.2 Windows portable package includes Node and the SHA-256-verified official native Windows Codex release. Cross-platform package includes Unix/Windows launchers, runtime installer, OS-native CI workflow, complete matching upstream source archive and license notices. Linux runtime is tested locally and excluded from the Windows ZIP.
External model/provider verification remains a follow-up after the user selects a model. Search/computer tools require a supplied MCP server; no training/cloud host is provisioned.
