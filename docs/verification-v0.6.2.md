# Release verification — codexcli 0.6.2

This release adds green input accents, an immediate selectable slash menu and local model file inspection/import. The red SUDO CLI logo, original antenna characters/palette/timing, credits and Administrator/root launch requirement remain.

## Complete automated suites

Both final commands `node --test --test-concurrency=4` exited 0 and discovered 604 tests:

| Host | Passed | Platform skips | Failures | Cancelled |
| --- | ---: | ---: | ---: | ---: |
| Windows x64, standard user token | 580 | 24 | 0 | 0 |
| Linux x64, Kali WSL, effective UID 0 | 595 | 9 | 0 | 0 |

New coverage includes content-based GGUF and Safetensors inspection under unusual extensions, incomplete model folders, adapters/custom-code metadata, bounded file reading, source-preserving imports, missing runners, import failures/cancellation, keyless profile setup, cancellable initial inspection, picker pagination/filtering, hidden/raw/busy prompt bypass, split UTF-8/CRLF/paste markers, Escape delivery, resizing and actual Node Readline behavior through both input filters.

The Readline regressions select every registered command and prove that selection does not submit it. Typed arguments after an exact command remain ordinary input, and fast Escape followed by Enter or Ctrl+U works. Escape was previously trapped as a possible bracketed-paste prefix; a bounded delivery timer now preserves late paste recognition without forwarding pasted slash commands.

## Real native terminal acceptance

The final `test/manual/verify-v0.6.2-linux.py` run passed in four real root Linux PTYs with the pinned Codex 0.160.1 engine. It selected all 59 registered commands without executing them, then exercised local setup, hidden keys, filter/navigation, normal argument typing, Escape, literal paste and multiline prompts, active cancellation, resizing, narrow output, NO_COLOR and TERM=dumb. All four CLI exits were 0; supported terminals restored the alternate screen. See [terminal evidence](v0.6.2-terminal-evidence.md).

This run made 3 native model requests to a deterministic loopback fixture, with no fixture errors. Offline startup, picker selection and model file inspection made no generation requests. A renamed synthetic GGUF header was detected without modifying it; arbitrary text was reported unrecognized.

Retained native acceptance also passed during release verification: the local/agents runner made 25 streamed requests, two keyless catalog calls and two clean exits; the broad regression runner made 22 streamed requests and five clean exits. Their offline phases made zero model requests. Existing preferences, independent teams, reviewed proposal application, chat continuation, checks, undo, budgets and bounded context replay remain covered by the complete suites and these native workflows.

## Local model limits and release checks

Any valid local file extension can be inspected. That does not establish that every file is a runnable chat model. Automatic imports currently delegate to installed Ollama or native LM Studio CLIs for supported inputs. They preserve the original weights, use explicit arguments rather than a shell, and do not install runtimes or execute model custom code. Complete supported Safetensors folders can be offered to Ollama; adapters, unsupported layouts and other formats receive loading guidance. Split GGUF loading has manual instructions.

Import unit tests use synthetic files and an injected command boundary. No real model weights, GPU inference or runner imports were exercised. Hardware capacity and architecture compatibility remain subject to the installed runner. A configured local profile is labelled unconfirmed until a real response arrives. Physical Windows/macOS terminal input, audio devices and ARM64 hosts were not exercised here; their CI/setup paths are provided.

The registered Windows command reports `codexcli 0.6.2 | sudocli`. Doctor confirms Node 24.19.0 and the pinned native engine without calling an AI. Source packages contain the complete matching upstream source snapshot and license notices; the Windows package also contains the verified native runtime and Node.

Separate release ZIP verification checks safe paths, CRC, exact source hashes, bundled runtime hashes and the extracted version/doctor commands without installing or registering the extracted copy. Its results and archive checksums are recorded in the release verification receipt outside the project ZIPs. Previous release files are retained.
