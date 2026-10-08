# 24/7 mode

24/7 mode keeps a lightweight local coordinator alive. It polls a durable task inbox and invokes the configured local supervisor when an actual task arrives. The supervisor decides whether to complete the task locally, ask for more information, or wake the cloud worker. When the inbox is empty and no standing goal is configured, polling makes **zero model calls**.

The computer must remain powered on and awake. A detached worker can survive closing the terminal; it cannot run while the operating system is shut down or suspended. Use the 24/7 stop command to stop the worker explicitly.

## Decisions and task states

Tasks persist through these states: `pending`, `assessing`, `running`, `completed`, `blocked` and `failed`.

- `cloud`: wake the cloud provider if a wake hook exists, then run the approved cloud worker. A wake failure blocks the task without invoking the cloud model.
- `local`: finish with the supervisor's nonempty result. No cloud model is called.
- `wait`: block the task with a reason. More information or an explicit retry is required.

Malformed supervisor decisions block a task instead of invoking the cloud worker. Failed, blocked and interrupted tasks do not retry automatically. If a native tool requires human approval, unattended Ask mode blocks the task; the worker does not grant that approval automatically.

Only one worker may own a project's inbox. Starting a new worker acquires that exclusive lease and marks tasks left `assessing` or `running` by an interrupted worker as `blocked`. Merely opening the CLI or listing tasks does not interrupt a live worker. Stop aborts the active task, records its interrupted state, attempts the configured provider sleep hook, and releases the lease.

## Cloud billing

An idle coordinator stops submitting inference requests. Stopping inference requests alone does **not** stop a separately rented GPU's hourly charge. Configure wake and sleep HTTP hooks that actually start and release your provider's compute resources if you want to stop that charge. Their precise effect is controlled by your provider and hook service.

The coordinator invokes the sleep hook after the configured idle interval, including an initially idle worker. It wakes before the next cloud task. Sleep failures are reported once for that idle period and appear in status; they do not silently count as successful shutdown or create a retry loop.

## Optional folder watches and standing goals

Folder watches are opt-in and limited to real directories inside the current project. They debounce nearby changes into one task. Files under the CLI's state directory, `.git`, `node_modules`, `.sudocli` and `.codexcli` are ignored. Symlinks leading outside the selected project are excluded. Paths are passed as data for inspection; a changed file is not automatically treated as a new instruction.

Watches pause while the supervisor or cloud worker handles a task. Before watching resumes, the coordinator records current file versions so delayed events from the worker's own edits do not create another task. Later external edits, including edits to the same file, still create tasks. Submit important additional work explicitly to the inbox while a task is running.

The baseline is limited to 10,000 eligible entries and a 2.5-second scan. Select smaller folders if the coordinator reports that the baseline cannot be established. It leaves folder watching disabled when a complete safe baseline cannot be obtained; explicit inbox tasks remain available.

An explicit standing goal enables periodic **local** supervisor assessments even when the inbox is empty. A waiting local assessment never wakes the cloud. Cloud decisions create durable tasks, and identical consecutive task prompts are suppressed until the supervisor returns to waiting/local handling or identifies a different task. The latest standing-goal task also seeds this protection after a worker restart.

## Internal APIs

`await createTaskInbox({stateDir, cwd, secrets})` returns `submit({prompt, source?})`, `list()`, `get(id)`, `update(id, {status, reason?, result?})`, `recoverInterrupted()`, `acquireWorker()`, `redact(text)`, `warnings()`, `directory`, `cwd` and `stateDir`. `acquireWorker()` returns an idempotent asynchronous `release()` method. Recovery requires an acquired lease. Explicitly updating a terminal task back to `pending` clears its previous reason/result and retries it.

`createAlwaysOn({inbox, assess, runCloud, onState?, onError?, wake?, sleep?, idleSleepMs?, pollMs?, standingGoal?, heartbeatMs?, watchPaths?, watchDebounceMs?, watchEntryLimit?, watchScanTimeoutMs?})` returns asynchronous `start()`, `stop()`, `submit()` and synchronous `snapshot()`.

Callbacks:

```js
assess(job, { signal })
// -> { action: 'cloud' | 'local' | 'wait', prompt?, reason?, result? }

runCloud(job, { signal })
// -> resultText | { result: resultText }

wake({ signal })
sleep({ signal })
```

Callbacks must honor cancellation. An error with `code: 'APPROVAL_REQUIRED'` blocks the task. Other cloud failures record a failed task. Error messages are redacted before reporting; state snapshots contain only worker metadata, task IDs, counts and a generic failure notice, never task prompts or results.

Inbox records use private atomic writes and project-specific directories. Task prompts and results are plaintext after known credential and terminal-control redaction. Corrupt records are skipped with warnings and preserved for inspection. Linked storage and task records are refused. Task prompts are bounded to 1 MiB and each persisted record to 2 MiB.
