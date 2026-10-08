# sudo cli Implementation Plan

> **For agentic workers:** Native integration with isolated parallel component workers, test-first development and final independent review. User explicitly requested implementation, then runtime-only setup and a different UI.

**Goal:** Ship sudo cli with its own terminal UI and cloud-model selection at runtime.
**Architecture:** Branded readline/ANSI frontend; JSON-RPC client of open-source Codex app-server; optional loopback Responses-to-Chat-Completions bridge. Temporary isolated engine home, ephemeral threads, connection settings and keys in memory.
**Tech stack:** Node.js22+, ESM, node:test and builtins only.
**Spec:** [design.md](design.md)

## Global constraints
- Brand `sudo cli`; executable `sudo-cli`; no global OS sudo override.
- No external npm dependencies, ChatGPT changes, saved model configuration, or copied credentials.
- No elevation/sandbox bypass; workspace-write and one-time approvals.
- Secrets never appear in process arguments or diagnostics.
- Unsupported hosted capabilities fail explicitly.

## Review focus
- Shell metacharacters remain literal input through shell:false execution.
- Invalid connection information produces actionable errors without secret leaks.
- Loopback bridge authenticates clients and closes on exit/abort.
- Engine notifications/approvals/exits settle pending requests and turns.
- Verify actual Codex protocol rather than trusting only unit tests.

## Task1: Runtime
Files `src/runtime.mjs`, `test/runtime.test.mjs`.
Interfaces `resolveCodex({env})`, `validateConnection(connection)`, `providerArgs(connection,{baseUrl,keyEnv})`, `createSessionHome({baseDir})` -> `{path,cleanup()}`.
- [x] Tests first for URL/identifier/environment validation, literal TOML quoting, discovery and temporary-home cleanup.
- [x] Implement and pass tests.

## Task2: Bridge
Files `src/bridge.mjs`, `test/bridge.test.mjs`.
Interface `startBridge({baseUrl,model,apiKey,timeoutMs})` -> `{baseUrl,token,close()}`.
- [x] Real HTTP tests first for text/tool/image/history/auth/errors.
- [x] Translate protocol, emit Responses SSE and pass tests.

## Task3: Engine client
Files `src/engine.mjs`, `test/engine.test.mjs`.
Interface `createEngine({codexPath,cwd,model,providerArgs,env,onEvent,onApproval})` -> `{threadId,startTurn(text,{model}),interrupt(),close()}`. Events/approvals are `{method,params}`; approvals boolean for this turn only.
- [x] Process-boundary tests first for RPC/framing/turns/permissions/failures/interrupts/cleanup.
- [x] Implement client; verify actual installed initialization and pass tests.

## Task4: UI and launchers
Files `bin/sudo-cli.mjs`, `src/ui.mjs`, `test/cli.test.mjs`, `sudo-cli.cmd`, `sudo.cmd`, `README.md`.
- [x] Executable and input-validation tests first.
- [x] Implement wizard, branded UI, events/approvals/modelchanges/interrupt/doctor/once.
- [x] Add launchers, license/attribution and source instructions.

## Task5: Integration and package
- [x] Real Codex plus local fake-model HTTP boundary including file/shell tool loop.
- [x] Fresh review, regression fixes, full suite.
- [x] Build ZIP; distinguish verified implementation from future live-model verification.

