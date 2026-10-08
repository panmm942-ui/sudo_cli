# Windows, Linux and macOS

sudo cli is a terminal application. Its JavaScript frontend runs on Node.js 22 or newer, with the native open-source Codex engine for the operating system and architecture running Node. The model endpoint is chosen during the session and remains in memory.

| Operating system | Architectures | Native Codex package |
| --- | --- | --- |
| Windows | x64, arm64 | `x86_64-pc-windows-msvc`, `aarch64-pc-windows-msvc` |
| Linux | x64, arm64 | `x86_64-unknown-linux-musl`, `aarch64-unknown-linux-musl` |
| macOS | Intel x64, Apple silicon arm64 | `x86_64-apple-darwin`, `aarch64-apple-darwin` |

The engine remains pinned to Codex **0.160.1**. These targets match the [upstream Codex launcher](https://github.com/openai/codex/blob/rust-v0.160.1/codex-cli/bin/codex.js) and the [official release packages](https://github.com/openai/codex/releases/tag/rust-v0.160.1). Upstream documents macOS 12+, Ubuntu 20.04+/Debian 10+, and Windows support in its [installation guide](https://github.com/openai/codex/blob/rust-v0.160.1/docs/install.md); this frontend also retains the native Windows runtime already tested in sudo cli. Filesystem sandbox and shell behavior depend on the underlying operating system.

## Start on Windows

The Windows x64 portable archive includes Node.js and Codex. Extract the archive, open a terminal in its `sudo-cli` directory and run:

```powershell
.\sudo cli
```

You can also run `.\sudo-cli.cmd`. The source archive requires Node.js 22+ on PATH and a native engine. To download a dedicated local engine, run:

```powershell
node scripts/setup-runtime.mjs
.\sudo-cli.cmd doctor
.\sudo-cli.cmd
```

The installer detects the architecture of Node.js, including native arm64 on Windows. The old Windows x64 bundle is not selected by native arm64 Node.

## Start on Linux or macOS

Extract the source archive and open a terminal in its `sudo-cli` directory. With Node.js 22+ available on PATH, run:

```sh
node scripts/setup-runtime.mjs
sh ./sudo-cli doctor
sh ./sudo cli
```

The shell launchers work even when an archive extractor does not preserve executable bits. To use them directly:

```sh
chmod +x sudo sudo-cli
./sudo cli
```

`./sudo` is a project-local alias. It does not install over the operating system's `sudo` command, elevate privileges or require administrator access. Launching through `node bin/sudo-cli.mjs` is also supported.

## Local runtime installation

`node scripts/setup-runtime.mjs` downloads the pinned official package and installs it under `runtime/<platform>-<architecture>/`, preserving the package's native helpers and resources. The script verifies both the archive size and SHA-256 digest before extraction. It accepts only HTTPS redirects to official GitHub asset hosts and extracts regular files and directories into a temporary project-local directory. A failed download is discarded; existing runtimes are never merged or overwritten.

The installer writes executable files and provenance, not model settings. It does not install global packages or edit shell profiles, saved Codex configuration, authentication or the ChatGPT app. Model connection settings still come from the running session.

Useful installer commands:

```sh
node scripts/setup-runtime.mjs --help
node scripts/setup-runtime.mjs --print-target
node scripts/setup-runtime.mjs --check
```

Runtime discovery gives an explicit `SUDO_CLI_CODEX` override priority, then a matching project-local runtime, then the original compatible portable bundle, then Codex on PATH. If PATH points to a wrapper that injects its own model settings, select the actual native executable with `SUDO_CLI_CODEX` or use the project-local installer. The override is read from the current process environment; no configuration file is edited.

On Linux, the upstream workspace sandbox may need working user namespaces and the bundled Bubblewrap helper. WSL is detected as Linux and uses the Linux native package. On macOS, filesystem permissions and security prompts still follow macOS policy; changing operating-system protection settings is outside this installer.

## Verification limits

Platform selection, archive safety, literal argument passing, cleanup and executable discovery have automated tests. Windows is tested on the current host. Linux verification uses an existing x64 WSL2 distribution and is recorded in the build's validation notes. macOS binaries are available from the pinned upstream release, but native macOS execution and arm64 execution require validation on those hosts. A supported package mapping is not evidence that every operating-system sandbox policy or model endpoint behaves identically.
