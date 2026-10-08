# Using another model with sudocli

Sudocli uses the pinned open-source Codex native engine to read files, edit them,
run commands, request approvals, collect tool results, and continue the task.
Selecting MiMo changes the model making those decisions; it does not replace the
native execution engine. The model still has to produce valid tool calls and make
good decisions. Transport compatibility alone cannot establish model quality.

The screenshot showing `No engine connected` is an offline configuration state.
Use `/connect` for an API model, `/local` for a local server or runner, or `/switch`
to select a saved AI. An ordinary task sent before selecting an AI cannot run.

## Two supported connection paths

| Selected transport | Your model server | Sudocli connection |
| --- | --- | --- |
| `responses` | Streams compatible `/v1/responses` events | Private pass-through to the native engine, with accounting and tool policy checks. |
| `chat-completions` | Streams compatible `/v1/chat/completions` chunks, or returns compatible JSON | Private adapter translates Responses requests and replies, including tools and their results. |

Native Codex speaks Responses internally. This CLI already includes the adapter
for Chat Completions, so a Chat-only model server does **not** require installing
another translator. Choose the transport the actual endpoint supports. A working
chat answer is only the first check; also verify a real tool-execution task.

Enter the model ID returned by your endpoint, its base URL and its own key when
connecting. Saved profiles omit keys. Model sessions use a private temporary
Codex configuration so another installed Codex account is not silently selected.

## MiMo server requirements

For the MiMo V2.6 family, the current vLLM instructions use the checkpoint's chat
template and these server flags:

```text
--reasoning-parser mimo
--tool-call-parser mimo
--enable-auto-tool-choice
```

These are server settings. `/model` selects the endpoint's model; it cannot fix a
server parser. Follow the checkpoint's supported runner and deployment recipe,
including its hardware and version requirements. The [vLLM MiMo tool-calling
documentation](https://docs.vllm.ai/en/latest/features/tool_calling/#mimo-v26-models-mimo)
and [current MiMo Pro deployment recipe](https://recipes.vllm.ai/XiaomiMiMo/MiMo-V2.6-Pro-RL)
describe the details. Do not assume the same settings fit an unrelated MiMo
checkpoint or a different runner.

Thinking-mode Chat Completions servers may require the assistant's complete
`reasoning_content` to be returned alongside previous tool calls. Sudocli retains
that field in memory and replays it with the matching call IDs while the native
session is alive. It also accepts MiMo-style nullable streaming fields. Xiaomi
documents the requirement in [its reasoning replay
guide](https://platform.xiaomimimo.com/docs/en-US/usage-guide/passing-back-reasoning_content).

Xiaomi's MOPD checkpoint addresses repeated tool calls in the model. Its
[diagnosis](https://mimo.xiaomi.com/blog/mimo-v2-6-tool-call-repetition) includes
Codex evaluations, but explicitly uses a repetition metric narrower than every
possible loop. It is evidence that MiMo can operate in Codex harnesses, not a
certificate for your particular weights, server, CLI configuration or task.

## What to verify on your real endpoint

Use a disposable project with a tiny bug and an existing test, then ask the AI
to read the relevant files, change the code, run the test, recover from a failed
attempt and rerun it. Review the resulting files and actual test output. Next,
interrupt a deliberately long command with `/stop`, verify its process has
stopped, and send another task. Approve only actions you intend to run; the
default project scope and approval policy still apply.

For an unfamiliar custom model, Sudocli supplies a private native catalog under
that exact model ID. It declares native command execution and direct
`apply_patch` editing, with the pinned engine's ordinary coding instructions.
Known built-in model metadata and an explicitly supplied catalog remain intact.
The CLI preserves declared reasoning levels, honors explicitly disabled vision,
and does not invent a context-window size. Models must use the tools actually
declared in their request.

## Reasoning effort and provider defaults

```text
/effort default
/effort supported low,medium,high
/effort low
```

`default` leaves the effort choice to your provider. In version 0.6.5, the current
selection is applied again at the provider boundary for every request. A default
selection removes a native catalog's suggested effort before sending the request.

For Responses, the CLI omits `reasoning.effort` and retains other valid reasoning
options. For Chat Completions, it omits `reasoning_effort`. It does not send an
invented effort named `default` or silently choose `high`.

An explicit supported selection replaces the catalog suggestion. Invalid levels,
levels outside your declared list, and overrides for an AI with reasoning
explicitly disabled are refused before contacting the model endpoint. Switching
to a model that cannot use the previous level restores provider default.

Declare only levels supported by your real endpoint. The native engine, model
metadata and transport fixtures cannot establish which reasoning modes a
particular hosted model or local runner implements.

## Stopping commands and repeated actions

`/stop` interrupts the current turn and asks the native engine to terminate its
background command sessions. It also works after a model finishes a turn with a
command still running. Subsequent work waits for that cleanup to finish.

The command watchdog defaults to 120 seconds, measured from when it first
observes a running native command. It also watches yielded commands after the
turn ends. The guard stops a turn when it sees four identical completed tool
actions and results in succession, including short cycles of up to three
actions. Tool-call IDs and volatile command timing metadata are excluded from
that comparison. The check is conservative: intentional identical polling may
trigger it, and changing arguments or outputs can evade it. It cannot prove
that every possible loop makes progress.

```text
/loopguard status
/loopguard timeout 300
/loopguard repeats 6
/loopguard off
/loopguard on
```

Timeout accepts 1–3600 seconds and repeat count accepts 2–10. HTTP model requests
also have a 120-second ceiling. Review the interrupted task before retrying or
raising a limit. `/reset loopguard` restores the guard defaults.

## Regression evidence and its limits

Version 0.6.5 adds focused loopback tests for both reasoning request boundaries:
default omission, explicit selection, changed selections and invalid requests.
These inspect the actual request sent to a deterministic local fixture. They do
not run inference or establish how a provider interprets reasoning effort.

The native tool-loop evidence below belongs to version 0.6.3. Retaining its
receipt does not turn it into a 0.6.5 real-model test.

`test/manual/verify-v0.6.3-model-loop-linux.py` runs the real interactive CLI,
readline, the pinned native Linux engine and both provider paths inside real
PTYs. It creates private temporary projects and a deterministic loopback server.
It verifies interleaved fragmented calls, result IDs, thinking replay, native
patches, failed test output, successful repair, actual command-process
cancellation, idle cancellation of a yielded command, command timeout,
continued work and repeated-action protection. It records sanitized provider requests,
native events, terminal logs and a pass/fail receipt.

The recorded run on 2026-10-08 passed both transports with no fixture errors.
Each path completed 18 native requests, used the declared direct `apply_patch`
tool, and stopped the repetition scenario after four identical reads. Both
interactive CLI processes exited successfully. The sanitized
[verification receipt](verification-v0.6.3-model-loop.json) records those results;
the Chat-specific fragmentation and reasoning checks apply to that adapter.

```text
python3 -B test/manual/verify-v0.6.3-model-loop-linux.py --output-directory /tmp/model-loop-proof
```

Run as root on Linux with Node 22 or newer and the pinned Linux runtime installed.
The script disables the native plugin catalog facility for a deterministic,
isolated loopback run. It does not load model weights or call a paid service. Its fixture
decisions prove the connection and execution plumbing; they cannot establish
that a real MiMo deployment makes the same decisions. A diagnostic run using
`--skip-repetition` does not verify the repetition guard.
