# Administrator/root launch requirement

The interactive and one-shot AI launch paths require an administrator/root process. This requirement was explicitly selected for codexcli. Help, version, doctor and setup remain available from a normal terminal so you can inspect and prepare the installation.

On Windows, open the terminal with **Run as Administrator**, then run `sudocli`. The check uses the current Windows process token's `WindowsPrincipal.IsInRole(Administrator)`, so membership in the administrators group without an elevated token is insufficient. The read-only PowerShell check runs hidden, without a shell, profile or interactive input, and has a five-second timeout.

On Linux and macOS, run:

```sh
sudo sudocli
```

If the registered user launcher is outside sudo's PATH, provide its full path:

```sh
sudo /absolute/path/to/sudocli
```

For a source checkout, the same principle applies to the Node entry point:

```sh
sudo /absolute/path/to/node /absolute/path/to/codexcli/bin/sudocli.mjs
```

The Unix check requires an effective UID of zero. codexcli does not invoke sudo, request UAC escalation, relaunch itself or modify the account's privileges. A missing, failed, timed-out or ambiguous check fails closed with an actionable launch error. Unsupported OS detection also fails closed.

Elevation and execution policy are separate. The default is project scope, Ask and Web Off. `/permissions scope read-only|project|full` sets the boundary; `/permissions ask|allow-everything` sets approval behavior. Unrestricted native execution requires full scope, Allow Everything and `/web on` together. With Web Off, commands remain network-disabled and unsandboxed escalation is refused even with Allow Everything. Project scope never unsandboxes commands, and plan/review workflows enforce read-only scope. Windows may return a stricter read-only policy; the returned engine policy is validated. There is no silent unrestricted fallback.

On Linux, launch with `sudo` from your normal account in the project you own. Scoped native commands run as that verified invoking account while the CLI retains its required root launch. The check matches sudo's UID/GID to the local account database and the project's owner. A direct root launch cannot impersonate an arbitrary project owner; inaccessible private projects produce an instruction to launch from the owning account. The native engine may be copied to a verified temporary location so the sandbox can start through private home paths, without changing permissions on your home.

Project scope permits writes to the selected project, additional folders you explicitly select, and one disposable scratch folder for compilers and tests. `TMPDIR`, `TMP` and `TEMP` point to that scratch folder. The entire system temporary folder and inherited temporary paths are excluded. Engine configuration and credentials remain in a separate private temporary home. Read-only scope has no writable project or scratch folder. Owned temporary resources are removed when the engine closes.

Explicit `/verify` checks use the matching native `codex sandbox` helper unless the three unrestricted settings were explicitly chosen. Helper/enforcement failure fails the check rather than retrying outside its sandbox. Root/administrator admission cannot establish equivalent native enforcement across platforms; that behavior still requires host-specific verification. Web and computer-use controls govern configured CLI tools rather than the whole operating system. See [v0.6 verification](verification-v0.6.md).

Elevated launches can use another account's home, state directory and environment. Saved profiles, personalization and model API-key environment variables must be available to the account that runs the process. Environment variables are not forwarded or persisted by the privilege-check module.

## Module API

```js
import { isElevated, requireElevated } from './src/privileges.mjs';

const elevated = await isElevated();
await requireElevated(); // true when verified; otherwise throws ELEVATION_REQUIRED
```

`isElevated({platform, geteuid, probe, timeoutMs})` provides injectable OS detection for tests. `geteuid` is a synchronous function returning the effective numeric UID. The optional Windows `probe(executable, args, options)` returns the child-process result `{stdout}`; only an unambiguous `True` string grants elevated status. The default probe uses `execFile` with `shell:false`, `windowsHide:true`, bounded output and a timeout. `timeoutMs` accepts 1–10,000 milliseconds and defaults to 5,000.

Tests verify Unix root/non-root decisions, Windows true/false/ambiguous token results, errors, timeouts and platform-specific error instructions. The actual local Windows token was inspected without changing its privileges; native Linux runs exercise the effective-UID check. The CI matrix includes native macOS admission and engine checks; desktop terminal interaction still needs a physical Mac check. OS-derived home paths are canonicalized before private state creation, including macOS's `/var/root` alias. Explicit state-directory links remain refused.
