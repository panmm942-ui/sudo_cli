# Version 0.6.4 verification

This release adds retained chat scrolling, canonical `/chat`, successful `/new` display resets, and publisher-signed source integrity. Background controls and the original antenna source remain unchanged.

The automated Windows and root Linux suites exercise the launchers, private chat persistence, command routing, provider translation, tools, approval policy, viewport wrapping and integrity checks. The final release's machine-readable verification record accompanies its archives as `codexcli-0.6.4-verification.json`; it records actual totals, package checksums and terminal evidence.

The launcher and both setup entrypoints use only Node built-ins until the Ed25519 signature and bootstrap/helper hashes pass. Black-box tests copy the signed release, change credits, launcher or helper code, change setup payloads, inject or remove source, and remove or corrupt signature metadata. Each altered copy must refuse execution. Update tests refuse missing or foreign publisher signatures for future versions before running any package code or changing command registration. Existing verified legacy rollback behavior remains covered.

The real Linux PTY scrolling acceptance seeds more than 65,536 characters of saved chat. It checks earliest-message restoration, Page Up/Down, mouse wheel, Ctrl+Home/End, line navigation, draft preservation, slash-picker priority, lower-only colors, resize, `/scroll`, `/new`, `/chat open`, restart and terminal cleanup. A second actual PTY confirms arriving output stays out of a paused older view and becomes visible on returning live. A separate theme acceptance checks both dashboard/body palettes, contrast, reset, tiny terminals, saved settings, `NO_COLOR` and plain terminal behavior.

Retained model-loop acceptance uses the actual pinned Codex engine and deterministic loopback providers for both Chat Completions and Responses. For each transport, 18 provider requests prove file reading, native patches, failing tests, repair, passing tests, associated tool-result replay, real command interruption, stopped yielded commands, a command timeout, continuation, and repeated-action protection. These are compatibility and execution tests, not a model-quality benchmark.

Both release archives are extracted independently. Source inventory and hashes must match; version and doctor must run successfully without registering a command or making a model request. The portable Windows package additionally checks every runtime file, pinned native package metadata and executable versions. Original source archives, credits and upstream licenses are retained.

Signed files detect alteration when checked by an intact trusted verifier. A determined owner can remove checks in a fork; JavaScript cannot be made uncopyable. Runtime files use their existing separate verification process. Startup checks cannot protect against a hostile administrator changing files concurrently. See [release integrity](release-integrity.md).

Physical Windows ConsoleHost, macOS and ARM terminals require separate visual acceptance. No actual MiMo server, local model weights, microphone, training service or paid GPU was supplied for this release's checks. GitHub installation also requires a compatible published release; no update is published or installed during these tests.
