# Detached 24/7 worker

`/24.7 detach` runs 24/7 mode as a separate native Node process. Closing sudocli leaves that detached worker running; `/24.7 stop` stops it through its authenticated local control channel. The computer must remain on and awake. This mode does not register an operating-system service or automatically restart after a reboot.

The worker requires administrator/root privileges independently of the terminal launch check. It never requests elevation or bypasses a standard Windows token. Run the terminal as Administrator on Windows, or launch sudocli with sudo on Linux/macOS.

Use `/24.7 setup` to select the local guardian, working model and optional scope/services. `/24.7 start` starts the coordinator in the current terminal; `/24.7 detach` starts the independent worker. Submit work with `/24.7 add TASK`, view jobs with `/24.7 list`, and open a saved outcome with `/24.7 result ID`. `/24.7 retry ID` explicitly requeues a reviewed blocked or failed job. `/24.7 status` shows the current coordinator/worker; `/24.7 stop` stops it.

The old `/247` spelling remains a compatibility alias. Help and command completion show `/24.7`.

## Work and idle behavior

The worker reads the durable task inbox for the current project. With an empty inbox, no selected folder watches, and no standing goal, it makes no model requests. It wakes on an explicit submitted task, a change in a selected project folder, or the configured standing goal's local assessment interval.

A local AI endpoint assesses each task through the actual Codex coding engine. It can complete the task locally, request the selected working AI, or wait for missing information or permission. Invalid decisions block the job rather than silently invoking a cloud model. The working AI runs only after the local assessment requests it. Both sessions use the configured project, web policy, MCP tools, computer-use policy and permissions.

Personalization is applied separately to each selected AI connection. The guardian's preferences precede its mandatory JSON routing instruction; the working AI receives its own developer instructions. A guardian must supply a nonempty actual result to claim local completion, and its decision text is bounded.

Permissions set to Ask cannot receive human approval in a detached worker. Approval requests are declined and the affected job is blocked with an explanation. Run it interactively or explicitly select Allow Everything before restarting 24/7 mode. Launching as administrator/root does not itself change this permission policy.

Completed results and blocked/failed explanations remain in the task inbox so they can be viewed after reopening sudocli. Interrupted work is recovered as blocked; a restart does not repeat partially executed commands automatically.

Selected folder watches and standing goals are explicit scope. The worker does not invent a personal objective or start unrelated projects while idle. Runtime settings are captured when the worker starts. Stop and restart it when changing those settings, especially when reducing permissions or turning off web/computer access.

## GPU lifecycle hooks

You may supply separate wake and sleep URLs. The worker sends authenticated JSON `{"action":"wake"}` before cloud work and `{"action":"sleep"}` after the configured idle interval or a normal stop. Requests have deadlines and reject redirects. URLs must use HTTPS, or HTTP on loopback, with keys supplied separately from the URL.

These hooks call a service you configure. That service must actually start and stop/deallocate your chosen GPU provider's resources. Making no model requests by itself does not stop a rented GPU's hourly billing. A successful hook response indicates that the configured service accepted the request, not independently verified billing or power state.

## Control and credentials

Each project has one control record under `stateDir/agents/worker-PROJECTHASH.json`. It contains the worker ID, PID, loopback port, start time, project path and a random control token. API keys, model endpoints, chat messages, developer instructions, and lifecycle-service keys are excluded from this record. Creation uses private mode 0600; the agents directory uses 0700 on Unix. Windows filesystem access follows the state directory's NTFS permissions.

Startup data and keys travel through Node's private parent/child IPC channel. The child is launched without a shell, with hidden windows and independent standard streams. After registration, the parent disconnects IPC and unreferences the child. These lifecycle requirements follow the [Node child-process documentation](https://nodejs.org/download/release/latest-jod/docs/api/child_process.html).

The control server binds only to `127.0.0.1` on a random available port. `/status` and `/stop` require the random bearer token, compared with a constant-time operation. Status exposes bounded metadata and recent sanitized events; it contains no raw prompts, audio, API secrets or model result bodies.

Control records and directories refuse symbolic links, non-regular records, malformed/oversized data and project mismatches. Startup uses a project lock and the task inbox's worker lease. An existing healthy worker is reused. An unreachable record with a live PID is left untouched, because PID reuse or an authentication failure cannot justify killing a process. A confirmed stale record can be replaced during a later start.

Stop is authenticated. It aborts active model work, updates the affected task, runs configured cleanup, releases the worker lease and removes only its own control record. The controller never kills an arbitrary PID taken from disk. The only direct process termination it performs is cleanup of the exact child it has just launched if startup fails.

## Integration API

```js
import { startAgentWorker, getAgentWorker, stopAgentWorker } from '../src/agent-control.mjs';

await startAgentWorker({
  stateDir, cwd,
  config: {
    localConnection, cloudConnection,
    settings: { permissions: 'ask', webAccess: false, mcp: {} },
    developerInstructions,
    localDeveloperInstructions,
    watchPaths: [],
    // Optional explicit goal and lifecycle services:
    standingGoal,
    wake: { url: wakeUrl, apiKey: wakeKey },
    sleep: { url: sleepUrl, apiKey: sleepKey },
  },
});

const status = await getAgentWorker({ stateDir, cwd });
await stopAgentWorker({ stateDir, cwd });
```

The local guardian connection must point to a loopback endpoint. A saved configuration supplies connection metadata through the foreground setup; this controller holds credentials in memory and does not persist them. Public return values omit the control token. Missing worker status returns `{ running: false }` without creating state directories.

## Verification

Tests verify missing/corrupt/symbolic control storage, authenticated identity checks, standard Windows elevation refusal, safe configuration validation and the absence of arbitrary PID termination. Root Linux integration starts a real detached worker, verifies private credential-free records and idle behavior, closes its launching process, then submits an explicit task that runs actual native local and working-model sessions against a local fixture endpoint. Stop is verified after those sessions. Real cloud resources, paid model endpoints and GPU service deployments are not used by these tests.
