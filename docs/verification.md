# Verification — sudo cli 0.1.0

Verified on Windows x64, October 7, 2026, using the included Node.js 24.19.0 and Codex 0.160.1 runtime.

`runtime/node.exe --test`: **87 tests passed**, zero failed, cancelled, or skipped.

The suite covers the localhost HTTP bridge, native process protocol, settings validation, isolated-home cleanup, launch behavior, serialized and cancellable readline prompts, the connection wizard, and streamed output sanitization. It also runs three integrations through the real Codex engine:

1. The custom CLI sends a task through the Chat Completions bridge and displays the fixture's answer.
2. Codex requests a terminal tool, a narrowly matched fixture command receives a one-time approval, and the command actually creates the asserted workspace file. The next model request contains the tool result.
3. A native Responses endpoint sends a credential across multiple text deltas. The custom CLI displays the expected redacted answer.

`sudo-cli.cmd doctor` reports Node 24.19.0 and `codex-cli 0.160.1`, without calling a model. Both Windows launchers return the branded version.

Manual terminal checks: custom banner; hidden key entry without echo; `/connect` asks for new settings despite launch flags; invalid wizard input is reported and retried; idle Ctrl+C exits after a real engine connection.

Review corrections were independently identified and then covered by regressions. Generation fixtures run on localhost; no live Kimi/MiMo/GLM endpoint, paid API, third-party MCP service, or training system was used. Compatibility with a specific cloud model requires a subsequent live connection check.

The original ChatGPT/Codex installation and settings were not edited. The bundled engine files are independent copies with hashes in `runtime/manifest.json`; the full upstream source snapshot and required notices accompany them.
