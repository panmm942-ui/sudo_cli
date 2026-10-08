# sudo cli progress

Scope: custom UI using open-source Codex engine; runtime-only setup; no ChatGPT changes.
Ruling: replaced initial saved-profile/native-TUI design with in-memory wizard and isolated app-server, per explicit user clarification.
Ruling: reuse app-server through its documented protocol rather than compiling duplicate Rust engine; source/license are documented.
Pre-flight: bridge returns baseUrl/token/close; runtime builds providerArgs; root passes isolated home/env into engine. Events are {method,params}; file ownership is separate.
Tasks1-4 complete: runtime, bridge, engine client, custom UI and launchers implemented with tests.
Review fixes: serialize/abort prompts, handle stdin closure and termination, runtime reconnection ignores launch defaults, bridge respects model changes and keyless endpoints, stream redaction handles split keys and terminal controls.
Verification: included Node runtime ran 87 tests; 87 passed, zero failed or skipped. Actual engine integrations exercised Chat Completions, a workspace file write with a narrowly approved fixture command, and native Responses streaming with a split credential.
Packaging: Windows x64 runtimes copied into this independent project; complete matching upstream source archive, license notices, binary hashes and user guide included.
External model/provider verification remains a follow-up after the user selects a model. Search/computer tools require a supplied MCP server; no training/cloud host is provisioned.
