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

Elevation and the AI permission settings are separate. `/permissions ask` still selects the configured native approval/sandbox policy; `/permissions allow-everything` still explicitly opts into the native unrestricted policy. Running the parent process as root/administrator does not turn every native sandbox implementation into an equivalent security boundary on every platform. Web and computer-use settings retain their documented tool-exposure scope.

Elevated launches can use another account's home, state directory and environment. Saved profiles, personalization and model API-key environment variables must be available to the account that runs the process. Environment variables are not forwarded or persisted by the privilege-check module.

## Module API

```js
import { isElevated, requireElevated } from './src/privileges.mjs';

const elevated = await isElevated();
await requireElevated(); // true when verified; otherwise throws ELEVATION_REQUIRED
```

`isElevated({platform, geteuid, probe, timeoutMs})` provides injectable OS detection for tests. `geteuid` is a synchronous function returning the effective numeric UID. The optional Windows `probe(executable, args, options)` returns the child-process result `{stdout}`; only an unambiguous `True` string grants elevated status. The default probe uses `execFile` with `shell:false`, `windowsHide:true`, bounded output and a timeout. `timeoutMs` accepts 1–10,000 milliseconds and defaults to 5,000.

Tests verify Unix root/non-root decisions, Windows true/false/ambiguous token results, errors, timeouts and platform-specific error instructions. The actual local Windows token was inspected without changing its privileges; native Linux runs exercise the effective-UID check. Native macOS launch behavior remains unverified.
