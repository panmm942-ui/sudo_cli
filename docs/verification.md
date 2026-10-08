# Verification — sudo cli 0.2.0

Verified on Windows x64 and native Linux x64 in an existing WSL2 distribution, October 7, 2026, using Node.js 24.19.0 and Codex 0.160.1.

Windows `node --test`: **120 passed**, 1 Unix-only test skipped, zero failed or cancelled, 121 total.

Linux `node --test`: **118 passed**, 3 Windows-only tests skipped, zero failed or cancelled, 121 total. It uses the project-local installed native ELF engine, without the user's unrelated Codex shell wrapper. Its three real-engine integration checks pass. macOS and arm64 runtime mappings are tested; native execution on those systems is pending. `.github/workflows/test.yml` supplies Ubuntu/Windows/macOS native CI checks.

The suite covers the localhost HTTP bridge, native process protocol, settings validation, isolated-home cleanup, launch behavior, serialized and cancellable readline prompts, the connection wizard, and streamed output sanitization. It also runs three integrations through the real Codex engine:

1. The custom CLI sends a task through the Chat Completions bridge and displays the fixture's answer.
2. Codex requests a terminal tool, a narrowly matched fixture command receives a one-time approval, and the command actually creates the asserted workspace file. The next model request contains the tool result.
3. A native Responses endpoint sends a credential across multiple text deltas. The custom CLI displays the expected redacted answer.

`sudo-cli.cmd doctor` reports Node 24.19.0 and `codex-cli 0.160.1`, without calling a model. Both Windows launchers return the branded version.

Terminal checks: large ASCII banner and all requested header fields; live clock; green Working and Online; red Not working; actual context occupancy; hidden credentials during clock updates and resize; partial typed input preserved across 132-to-78-to-132 column changes; `/connect` asks for new settings despite launch flags; invalid wizard input is reported and retried; idle Ctrl+C and `/quit` restore terminal scrolling and exit cleanly.

The Windows and Linux installers were also executed against the official release. Pinned archive digests passed, native helpers were retained, doctor passed, and repeat installation reused the existing local Linux runtime. The 0.2 Windows portable archive uses the full native release package, including its bundled search and sandbox resources.

Review corrections were independently identified and then covered by regressions. Generation fixtures run on localhost; no live Kimi/MiMo/GLM endpoint, paid API, third-party MCP service, or training system was used. Compatibility with a specific cloud model requires a subsequent live connection check.

The original ChatGPT/Codex installation and settings were not edited. The bundled engine files are independent copies with hashes in `runtime/manifest.json`; the full upstream source snapshot and required notices accompany them.
