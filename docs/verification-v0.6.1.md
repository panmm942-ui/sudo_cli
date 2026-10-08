# Release verification — codexcli 0.6.1

The update adds explicit keyless local setup, independent AI preferences, saved specialists, parallel source teams, coding pipelines, live guidance, saved follow-ups and conflict-aware proposal application. The original antenna, red logo, credits and Administrator/root admission remain.

## Actual native terminal acceptance

The Linux root PTY runner `test/manual/verify-v0.6.1-linux.py` passed with 25 streamed model requests, two keyless catalog calls and two CLI exits with code 0. It exercises the real terminal, native Codex 0.160.1 engine, bridges, source copies, sandboxed checks and saved state. The endpoint supplies deterministic model responses; no paid model or installed weights were used.

It proved offline startup despite inherited cloud configuration; local catalog and generation with no Authorization; separate model preferences across switching/restart; specialist model selection; parallel teams; coder changes kept in copies; reviewers reading proposed code; explicit apply and preserved human conflicts; saved follow-ups; status/cancellation; live guidance reaching native model continuation; and agent reports reaching the main AI's next prompt as advisory conversation input.

The broad regression runner `test/manual/verify-v0.6-linux.py` also passed on the current release: 22 streamed requests, zero offline model requests and five exits with code 0. Existing file edits, checks, undo, chat isolation/restart, multiline/literal paste, reviewed context, budget admission, invalid explicit model recovery and offline inherited configuration remain covered. Both runners are in the six-platform CI definition.

## Complete automated suites

Both final complete commands `node --test --test-concurrency=4` exited 0 and discovered 561 tests:

| Host | Passed | Platform skips | Failures | Cancelled |
| --- | ---: | ---: | ---: | ---: |
| Windows x64, standard user token | 537 | 24 | 0 | 0 |
| Linux x64, Kali WSL, effective UID 0 | 552 | 9 | 0 | 0 |

The suite covers separate model preferences and credential identities, local wizard catalog/authentication paths, protected profile loading, independent source teams, per-agent steering/cancellation/budget lifecycle, coding/follow-up proposals, durable diffs, symlink/hardlink guards, preserved human conflicts, source ownership/modes, bounded report continuation and replay deduplication.

An intermittent test teardown hang was traced to deleting the scheduled-worker inbox before stopping its extra coordinator. Its test now stops that worker in `finally` before fixture cleanup; production code was unchanged. The isolated 19-test coordinator suite then passed twice on Windows and once on Linux before these final full suites.

The registered Windows command reports `codexcli 0.6.1 | sudocli`. Doctor confirms Node 24.19.0 and the pinned native Codex 0.160.1 without a model connection. Release ZIP validation independently checks CRC, safe paths, exact source hashes and bundled runtime hashes, then executes the extracted version and doctor commands.

## Practical limits

Model fixtures verify protocol and execution behavior, not the quality of an installed local model or third-party paid model. Actual model weights, physical audio, GPU billing services, macOS and ARM64 machines were not exercised here. Their setup and CI paths are provided.

Named source agents have bounded credential-filtered copies, Web Off, no Computer Use/MCP and no external approval. Tester reports recommend checks; only explicitly selected `/verify` commands establish factual check results after applying. Saved results retain full bounded reports; model replay is separately bounded and labels omitted text. A local compatible endpoint may proxy cloud inference; its loopback address alone does not establish where the weights run.
