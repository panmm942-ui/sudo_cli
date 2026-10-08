# GitHub release checks

Interactive startup checks the public releases of [panmm942-ui/sudo_cli](https://github.com/panmm942-ui/sudo_cli). A newer stable version is reported, and a compatible update asks for `y/n`. Only `y` or `yes` approves downloading and installing that offered release; declining continues the current CLI session. Restart the registered `sudocli` command after a successful installation.

The startup check reads bounded release metadata with a five-second deadline. Unavailable networking, an API rate limit, a private or missing repository, or a release without update assets leaves the CLI usable. It does not use a GitHub token, model key or ambient cloud credentials. `doctor`, version output and noninteractive commands do not need to check GitHub.

Use `/update check` to check manually, `/update on` or `/update off` to set startup checks, and `/update repo OWNER/REPO` to select a different trusted publisher. `/reset updates` restores startup checks and the default repository.

## Publishing compatible releases

Publish a stable GitHub Release with a tag such as `v0.6.8` (plain `0.6.8` is also accepted). The ZIP root must be `codexcli/` and the package version must exactly match the release tag. Attach a compatible package using one of these exact naming patterns:

- `codexcli-VERSION-windows-x64.zip` or `codexcli-VERSION-windows-arm64.zip`
- `codexcli-VERSION-linux-x64.zip` or `codexcli-VERSION-linux-arm64.zip`
- `codexcli-VERSION-macos-x64.zip` or `codexcli-VERSION-macos-arm64.zip`
- `codexcli-VERSION-cross-platform.zip` as a source-package fallback

Also attach `codexcli-VERSION-SHA256SUMS.txt`, `SHA256SUMS.txt` or `SHA256SUMS` to that same release. Use ordinary SHA-256 sum lines, with two spaces (or a space and `*`) between the 64-character hash and a simple filename:

```text
0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef  codexcli-0.6.8-windows-x64.zip
```

That line is an illustrative hash; generate the real checksum from the final archive. Do not use paths or duplicate filenames in the sums file. Each supported platform selects its exact package first, then the source fallback. Other platform binaries are never chosen. Source packages require a suitable installed Node runtime and may install the pinned native runtime during the normal verification stage.

## Integrity and installation

After approval, the checker reloads the offered release by its GitHub release ID and refuses changed package or checksum metadata. Both assets must belong to the configured repository and exact release tag. HTTPS asset redirects are restricted to `github.com`, `release-assets.githubusercontent.com` and `objects.githubusercontent.com`; redirects from release API metadata are refused. Requests have deadlines and bounded bodies, and signed redirect URLs are never included in status messages.

The checksum file is fetched only after approval. Its size and GitHub-provided digest are checked when present. The selected archive hash must match the sums file and GitHub's archive digest when present. The existing updater then streams the bounded archive, verifies its SHA-256, checks safe ZIP paths, package version, Node and pinned native runtime, and runs `doctor` before registering the new command. Its retained previous release permits `/update rollback`. See [verified updates](updates.md) for the existing installer and rollback behavior.

A checksum from the same release identifies the publisher's selected bytes. It does not protect against an authorized publisher account publishing harmful code; choose a repository you trust.

The implementation uses GitHub's official [latest-release metadata](https://docs.github.com/en/rest/releases/releases#get-the-latest-release) and [release asset](https://docs.github.com/en/rest/releases/assets#get-a-release-asset) contracts. No release was published or repository modified while implementing this feature. The configured repository's latest-release endpoint returned HTTP 404 during local verification on 2026-10-08; live update availability therefore remains dependent on publishing a public compatible release.

## Module API

`checkGitHubRelease({repository?,currentVersion,platform?,arch?,fetchImpl?,signal?,timeoutMs?})` returns a frozen result with `status` equal to `unconfigured`, `unavailable`, `current` or `available`. An available result includes `version`, `releaseUrl` and `installable`; missing assets yield `installable: false` with a reason. Checks use the default repository when omitted; an explicit empty/null repository returns `unconfigured` without networking.

`installGitHubRelease(offer,{confirmed:true,stateDir?,signal?,currentRoot?,register?,nodePath?,runtimePath?,commandRunner?})` accepts only a live installable result from that checker. It passes `expectedVersion` into the verified installer before launcher registration. The caller is responsible for obtaining the user's affirmative response first. The injected fetch client, stage and install functions used by the tests do not require external CI networking.
