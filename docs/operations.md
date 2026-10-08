# Budgets, schedules, GPU state and startup

These modules use local files and native Node APIs. No cloud request occurs just because the inbox, ledger, schedule list, or worker status is opened. Administrator/root admission remains separate from the selected Ask/Allow Everything policy.

## Request budgets

`createBudgetLedger({stateDir,cwd,policy,clock?})` persists one project ledger. Policy has optional `task` and `day` objects with `costUsd`, `tokens`, `requests`, and `durationMs` caps. Days use UTC. Zero is a valid exhausted cap. Rates use `{inputUsdPerMillion,outputUsdPerMillion}`. No price table is downloaded or guessed.

Call `beginTask(taskId)` before a task and `endTask(taskId)` in its cleanup. Its optional returned `timeoutMs` is the remaining task/day wall duration; combine that deadline with the whole task's cancellation signal so it also bounds native tools between model requests. The always-on coordinator does this automatically. Use `requestHooks({taskId,pricing?,maxOutputTokens?,durationMs?})` at the provider boundary. The hooks reserve allowance before each request, clamp its output limit and deadline, account reported provider tokens, and settle every admitted request. Missing usage, transport cancellation and ambiguous failures keep the reservation estimate. They do not assume the provider issued a refund. Interrupted task cleanup closes outstanding reservations while keeping their charge.

A money cap refuses a request without configured rates. Token and currency reservations are estimates; native/provider tokenization and invoice pricing remain outside the CLI. Actual reported usage replaces token estimates. Currency remains a calculation from user supplied rates, not a billing receipt. A provider reporting more tokens than reserved may overrun the admitted request; later admission fails. Voice, training, rented GPU, storage, network and other service fees are separate and are not included in these text model totals.

`snapshot({taskId?})` returns task/day totals, estimated request count, in-flight count, policy and cost provenance. `reset({day:true})` or `reset({taskId})` requires an explicit call and refuses in-flight work. The ledger never contains prompts, responses or API keys. Atomic private files and exclusive locks stop concurrent spending of the same allowance. Corrupt records or interrupted foreign locks stop admission and preserve the evidence.

## Durable schedules

`createScheduler({inbox,clock?})` returns `add`, `list`, `remove`, `setEnabled`, `tick` and `reconcile`. `add({id?,prompt,at?,intervalMs?,maxAttempts?,retryDelayMs?})` accepts a UTC ISO timestamp or epoch milliseconds. An interval of zero runs once; positive intervals start at one second. A late repeating schedule coalesces missed intervals into one occurrence and computes its next time from the current local check.

The coordinator calls `tick` while it holds the project worker lease. The scheduler only submits tasks. The existing local guardian, permission policy and working model handle them normally. A recurring schedule waits while its previous occurrence is pending, assessing or running. A failed or blocked task is preserved for explicit review and retry. Automatic retries cover only enqueue failures, using a durable idempotency key. A crash after writing the task and before recording its acknowledgement produces the same task on retry. Reusing a key with different prompt/source is refused.

## GPU state contract

`createGpuController({wake?,sleep?,status?,clock?,wait?,fetchImpl?})` accepts HTTPS hooks or loopback HTTP hooks without URL credentials, queries or fragments. Wake/sleep use POST with `{"action":"wake"}` or `{"action":"sleep"}`. Status uses GET. Bearer keys travel in request headers. Redirects, oversized responses, invalid data and timeouts are refused.

An optional status response must be a JSON object:

```json
{"state":"stopped","billing":"storage-only","resourceId":"provider-resource-id"}
```

`state` is `running`, `stopped`, `deallocated`, `transitioning` or `unknown`. `billing` is `active`, `storage-only`, `stopped` or `unknown` (omission means unknown). The configured service must obtain actual provider state; a desired/target state is insufficient. The controller polls after a command until the requested execution state is observed. The coordinator displays awake/asleep only for verified running/stopped/deallocated state and separately displays reported billing. An HTTP command acknowledgement leaves both unknown. A running text endpoint, zero requests or a sleeping process never proves that instance/storage billing stopped.

## Explicit operating-system startup

`createAutostartPlan` renders a Linux systemd unit, macOS launchd plist, or Windows boot-trigger Task Scheduler XML. Merely planning writes no files and installs nothing. `installAutostart(plan)` and `removeAutostart(plan)` are explicit administrator/root commands. Install refuses to replace an existing saved template. Linux uses systemd link/enable; macOS copies the plist into `/Library/LaunchDaemons` then bootstraps the system domain; Windows registers a SYSTEM boot task. No service has been installed by the test suite.

The startup entry is a real foreground owner of the detached worker. It checks elevation again, refuses an already owned project, sends resolved credentials over IPC, observes authenticated local worker state, and stops its matching worker when receiving a normal stop signal. Interrupted worker tasks remain blocked on recovery. Stop the active worker before removing a Windows startup task. Computer sleep/off still prevents local work.

The bootstrap JSON contains connection settings and environment references only:

```json
{
  "version": 1,
  "cwd": "/trusted/project",
  "stateDir": "/private/codexcli-state",
  "credentialProvider": {"file":"/trusted/credential-loader","args":["codexcli"]},
  "agent": {
    "localConnection":{"baseUrl":"http://localhost:1234/v1","model":"local","transport":"chat-completions"},
    "cloudConnection":{"baseUrl":"https://provider.example/v1","model":"selected-model","transport":"responses","apiKeyEnv":"CLOUD_MODEL_KEY"},
    "settings":{"permissions":"ask","scope":"project","webAccess":false}
  }
}
```

Inline API keys, passwords, tokens and secrets are rejected. An explicit credential loader is an absolute executable invoked without a shell; its bounded stdout is JSON mapping environment names to secret values. Exit failure or missing/invalid referenced credentials prevents worker startup. Without a loader, referenced variables must be supplied by the OS startup environment. Values remain in process memory and IPC, and are never added to templates, control records or logs. POSIX configuration files must have no group/other permissions. Protect the executable, loader, configuration and their parent directories with root/administrator ownership and OS access controls before enabling elevated reboot startup. The application does not silently install a credential manager or obtain a user's interactive login secrets.

Template references: [systemd systemctl](https://www.freedesktop.org/software/systemd/man/latest/systemctl.html), [Apple launchd jobs](https://developer.apple.com/library/archive/documentation/MacOSX/Conceptual/BPSystemStartup/Chapters/CreatingLaunchdJobs.html), [Microsoft Task Scheduler schema](https://learn.microsoft.com/en-us/windows/win32/taskschd/task-scheduler-schema).
