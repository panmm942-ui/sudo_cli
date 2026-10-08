# Verified updates and rollback

Updates run only after an explicit command. Staging downloads or copies a package; installation changes the registered `sudocli` command after verification. Restart the command to use the new release. An update does not replace files in the running release, change saved model settings, or install a startup service.

```text
/update stage SOURCE TRUSTED_SHA256
/update status
/update install
/update rollback
```

`SOURCE` is a local ZIP or an HTTPS URL without URL credentials. Obtain the SHA-256 checksum through a trusted release channel. A matching checksum verifies the selected bytes; it does not authenticate a publisher by itself. Redirects are refused. Downloads are bounded to 512 MiB and interrupted or failed staging removes its temporary download. A previously staged package remains available after a failed replacement attempt.

Installation rechecks the staged checksum and size, then extracts into a new private `releases/verified-*/codexcli` directory. ZIP validation compares local filenames, flags, sizes and compression methods with the central directory, checks every offset and overlap, and verifies the expanded payload's size and CRC. Paths must be inside `codexcli/`. Traversal, links, Windows reserved filenames, case collisions and conflicting file/directory paths are refused. The supported ZIP subset uses stored or deflated files, optional ordinary data descriptors, one disk and at most 10,000 entries; ZIP64 and encrypted archives are refused. Expanded data is limited to 1 GiB, with each file limited to 512 MiB. These fields follow the [PKWARE ZIP format specification](https://pkware.cachefly.net/webdocs/casestudies/APPNOTE.TXT).

Before installation changes command registration, both the previous release and the new release must pass:

1. Application identity, version and ESM package checks.
2. Runtime platform and architecture checks, accepting `windows-x64` as `win32`/`x64`, and every hash and size listed in a portable runtime manifest (`files[].file`, or `files[].path`).
3. Execution of the selected Node binary with `--version`: Node 22 or newer, satisfying the release's `engines.node` minimum. A bundled Node binary takes precedence because the registered command uses it.
4. Official native package pin and layout checks, required helper files, and a successful `codex-cli 0.160.1` version check. A release without a native package must run its `scripts/setup-runtime.mjs`, after which the pin, layout and version are checked again. An HTTP acknowledgment or setup exit code alone cannot satisfy these checks.
5. A successful execution of that release's `bin/sudocli.mjs doctor`, confirming the expected application and native engine. Verification processes receive the limited operational environment and the verified engine path; model credentials are not copied from the parent environment.

The first installation records the original release and the verified Node/native paths. Later installations retain the previous release. Rollback freshly verifies its retained target, changes command registration to that release, and swaps the retained references so a subsequent rollback can return to the other release. A retained doctor failure leaves the active command and record unchanged. A broken active release can still roll back to a verified target. The active release is checked as a potential recovery target; if it fails, a subsequent registration/publication failure reports uncertainty instead of claiming restoration. Reinstalling the same currently active package is idempotent, including concurrent calls in one process.

Staging, installation and rollback share an exclusive operation lock. A lock from another process or an interrupted session fails closed; it is never automatically taken over. If command registration or state publication fails, the updater attempts to restore the verified previous command and its state. If recovery also fails, it reports `UPDATE_REGISTRATION_UNCERTAIN` and retains the new release for manual command repair. Do not remove an interrupted lock until the other process has stopped and command registration has been checked. Releases referenced by the installation record are retained rather than deleted during successful install or rollback.

## Programmatic verification

The existing exported APIs remain available:

```js
await stageUpdate({source, sha256, stateDir, signal});
await updateStatus({stateDir});
await installStagedUpdate({stateDir, currentRoot});
await rollbackUpdate({stateDir});
validateUpdateManifest(manifest, {platform, arch});
inspectZip(buffer); // validated central names; extraction also checks payload CRC
```

`stageUpdate` also accepts `maxBytes` and `fetchImpl`. Install and rollback accept `nodePath`, `commandRunner`, and `register` for controlled integration. `commandRunner(executable, args, {cwd, env, signal, timeoutMs, maxBytes})` returns `{code, stdout, stderr?}`. The real runner uses separate arguments with no shell, bounded output and a timeout. `register({projectRoot, nodePath, runtimePath, version})` is called only after verification and is called with the previous verified release if recovery is needed. The default registrar uses the normal command setup module.

Fixtures may supply an existing `runtimePath` together with an explicit `register` callback. That external native runtime still requires the official package pin, layout, helpers and exact version. The callback must use the supplied path if its command depends on an external engine. A record containing external engine paths continues to require an explicit registrar for subsequent install or rollback; the ordinary launcher expects a runtime in its application directory. Tests redirect registration into a temporary fixture and never alter the host command, PATH or installation.

Run the focused checks with `node --test test/verified-update.test.mjs`. Real execution tests use the project's pinned native runtime; `CODEXCLI_TEST_UPDATE_RUNTIME` can select another existing pinned package for the current platform. The tests cover actual install/rollback execution, refusing old Node, doctor and manifest failures, ZIP integrity and path checks, concurrent installation, setup acknowledgment followed by pin checks, recovery, and interrupted locks.
