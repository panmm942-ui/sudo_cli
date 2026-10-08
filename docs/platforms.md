# codexcli on Windows, Linux and macOS

The project is **codexcli**. The terminal command is **sudocli**. Run first setup normally, then start model sessions in an Administrator terminal on Windows or through sudo on Linux/macOS. Launch requires verified administrator/root privileges and does not elevate itself. Help, version, doctor and setup remain available without elevation.

| System | Architectures | Native Codex runtime |
| --- | --- | --- |
| Windows | x64, arm64 | `x86_64-pc-windows-msvc`, `aarch64-pc-windows-msvc` |
| Linux | x64, arm64 | `x86_64-unknown-linux-musl`, `aarch64-unknown-linux-musl` |
| macOS | Intel x64, Apple silicon arm64 | `x86_64-apple-darwin`, `aarch64-apple-darwin` |

The engine is pinned to Codex **0.160.1**, matching the [upstream platform mapping](https://github.com/openai/codex/blob/rust-v0.160.1/codex-cli/bin/codex.js) and [official release](https://github.com/openai/codex/releases/tag/rust-v0.160.1). The frontend requires Node.js 22 or newer. The Windows x64 portable archive includes Node.js; source packages use Node.js already installed on the system.

## First setup on Windows

Extract the Windows archive into a permanent directory. Open PowerShell or Command Prompt in its `codexcli` folder and run:

```powershell
.\setup.cmd
```

Setup prefers bundled Node.js, checks for the compatible engine and downloads a verified local runtime only if needed. It creates the managed current-user command at `%LOCALAPPDATA%\codexcli\bin\sudocli.cmd` and adds that directory to the current user's PATH. Administrator access is not required; the system PATH and app installation are left untouched.

Open a new PowerShell or Command Prompt **as Administrator**, navigate to your working project and run:

```powershell
sudocli
```

To use an existing runtime without allowing a download, run `.\setup.cmd --command-only`. You can also run `.\sudocli.cmd` directly from the extracted directory before registration; model sessions still require an Administrator terminal. Standard-token launch is rejected before connecting to a model or writing session data.

## First setup on Linux or macOS

Extract the source archive into a permanent directory, with Node.js 22+ available, then run:

```sh
sh ./setup
```

Setup checks or downloads the correct native runtime, creates an executable wrapper at `~/.local/bin/sudocli` and adds one managed PATH block to the current shell's startup file. Run setup as your regular user so registration belongs to that user. Open a new terminal, navigate to your project, and start the installed command with its full path:

```sh
sudo "$HOME/.local/bin/sudocli"
```

The startup file is `.zshrc` for zsh, `.bashrc` for Linux bash, `.bash_profile` for macOS bash, `fish/config.fish` under the user configuration directory for fish, or `.profile` for other POSIX shells. Existing startup content is preserved. Setup updates only its own bounded block and command wrapper on subsequent runs; foreign commands and symbolic-link destinations are refused.

`sh ./setup --command-only` registers the command without downloading a runtime. `sudo sh ./sudocli` runs the project directly before registration. Shell launchers work even if the archive extractor does not preserve executable bits. You can use `chmod +x setup sudocli` to launch them as `./setup` and `sudo ./sudocli`. Sudo can reset PATH or environment variables, so the full launcher path and interactive key entry avoid relying on inherited shell settings.

## What setup saves

Setup saves the command wrapper, its PATH registration and any required executable runtime. The wrapper contains only paths to Node.js and this project's entry point. Setup saves no model identifier, endpoint, API key or conversation. Model selection happens while `sudocli` runs. Runtime sessions separately autosave visible chats and work totals; explicit profile/memory/check/budget/personalization/inbox actions save their own records. Keys are memory-only by default; `/credentials save` explicitly uses the available Windows DPAPI, macOS Keychain or Linux Secret Service backend for the elevated OS account. Key values stay out of profiles/chats. `SUDO_CLI_STATE_DIR` selects application state; normal ownership follows the elevated account and OS permissions.

Keep the extracted project directory: the command points to it. If you move the directory, rerun setup from the new location. Registration is idempotent and refuses to overwrite an unrelated `sudocli` command.

For runtime-only maintenance, `node scripts/setup-runtime.mjs` retains the project-local installer. It verifies the pinned official archive's size and SHA-256 digest before extracting into `runtime/<platform>-<architecture>/`. HTTPS redirects are limited to approved GitHub asset hosts, incomplete downloads are discarded, existing runtime directories are not merged, and concurrent installations are refused.

Useful checks:

```sh
node scripts/setup.mjs --help
node scripts/setup-runtime.mjs --print-target
sudocli doctor
```

An explicit `SUDO_CLI_CODEX` environment variable can select another compatible native engine. Runtime discovery otherwise prefers a matching project-local package, the compatible original Windows bundle, then Codex on PATH. The dedicated local package avoids personal PATH wrappers that inject their own model flags.

## Validation and operating-system behavior

Windows x64 and Linux x64 under an existing WSL2 distribution have native runtime and command tests; Windows also has actual browser CDP acceptance. Standard-token Windows launch refusal is tested, and root Linux exercises native PTY/detached workers. Setup registration tests use temporary homes and an injected Windows PATH store. Actual command registration is a separate setup action. CI defines Windows/Linux/macOS x64/ARM64 jobs, but remote jobs and local macOS/ARM execution have not been verified here.

Underlying shell permissions and filesystem sandboxes remain platform-dependent. Linux uses the bundled native helper/Bubblewrap and may need working user namespaces; WSL uses the Linux package. macOS permissions follow OS policy, and Windows may return a stricter read-only engine policy. Default project scope/Ask/Web Off remains sandboxed; unrestricted execution requires full scope, Allow Everything and Web On together. Explicit `/verify` checks use `codex sandbox` under the same policy. Unsupported or failed helper enforcement fails the check without an unrestricted retry. A detached worker cannot approve a needed action for you. The [upstream installation guide](https://github.com/openai/codex/blob/rust-v0.160.1/docs/install.md) documents supported system versions; [v0.6 verification](verification-v0.6.md) records observed host results.

Ubuntu 24.04 may deny capabilities inside an unprivileged user namespace through AppArmor. A Bubblewrap namespace, mount or loopback `Operation not permitted` error needs inspection of the matching kernel AppArmor denial; that error alone does not establish its cause. The [official Ubuntu guidance](https://github.com/ubuntu/ubuntu-release-notes/blob/main/docs/24.04/index.md#unprivileged-user-namespace-restrictions) recommends an executable-specific AppArmor profile using `flags=(unconfined)` and `userns,` for applications that implement their own sandbox. An administrator must review the trusted native executable and any private-runtime staging paths before adding such a profile on a real machine. Setup and CLI launch do not change AppArmor, sysctls or system profiles, and failed enforcement is never retried without its sandbox.

The Linux GitHub Actions job has a separate guarded preflight. It verifies the pinned x64/ARM64 Bubblewrap bytes and tests project/scratch write access, denied outside writes and denied network access as the admitted sudo account, at both the installed path and a digest-verified neutral staging path. Only a fresh AppArmor user-namespace/capability denial matching that probe's PID permits its two CI-specific `userns,` profiles: one exact installed executable and one bounded `/tmp/sudo-cli-sandbox-runtime-??????/codex-resources/bwrap` attachment. Both enforcement probes must then pass. The job unloads its byte-exact profiles at completion; it does not disable AppArmor or namespace restrictions globally. These checks make no model request and are not run by setup or normal user sessions.

## Version 0.6 runtime features

The [user guide](user-guide.md) covers the default offline shell, guided/saved AI selection, local endpoints, per-AI capability evidence, bounded context replay and approved memory. Last-chat restoration requires no model request. Invalid automatic settings report a connection failure and preserve offline `/chat` access. A new/reconnected model needs declared context capacity; oversized replay requires a reviewed summary/selected messages and retains the complete archive, including later messages. Chat Completions SSE is incremental, with provider usage/first-output timing and a buffered JSON fallback. Saved profiles/chats contain nonsecret metadata and sanitized visible/queued text. Setup itself saves no model connection, and a model name does not prove compatible tools or media support.

The WiFi monitor reads local interfaces only: NetAdapter PowerShell on Windows, sysfs on Linux, and networksetup/ifconfig/netstat on macOS. It measures current physical-interface traffic rather than maximum bandwidth and cannot infer host WiFi from WSL guest interfaces. Missing tools, permissions or ambiguous data remain Unknown.

Microphone recording needs FFmpeg and OS permission: DirectShow on Windows, PulseAudio on Linux and AVFoundation on macOS. `/microphone on` arms access; `/voice record` records a bounded clip. `/voice live` composes segmented ASR, ordinary coding turns and configured TTS/FFplay rather than universal native realtime audio. Headphones mode supports speech interruption; speaker mode pauses hearing during playback and uses `/stop`. Wake phrases are checked after ASR, so detected audio still reaches that service. Pause releases capture, resume restarts it, and repeat speaks the last reply. There is no acoustic echo cancellation. Synthetic recorder/player children and loopback services are tested; physical microphone/speaker operation remains unverified. See [live voice](live-voice.md).

The 24/7 guardian uses saved local/working models, a durable project inbox and chosen-folder/standing-goal triggers. Foreground mode ends with the terminal; `/24.7 detach` creates an authenticated elevated worker that survives terminal closure. `/schedule` adds durable occurrences; `/startup setup|plan|install` explicitly prepares/registers systemd, launchd or Task Scheduler startup. Detach installs no boot service, and no production reboot recovery was tested here. Detached Ask-mode approvals block the job; policy changes stop workers until explicitly restarted. All results remain in the inbox for `/24.7 result`; foreground outcomes also checkpoint into the active chat, while detached outcomes are not imported automatically. Selected checks determine acceptance after work, with failure/uncertainty producing failed/blocked jobs. GPU hooks require actual provider state/billing support. See [guardian behavior](always-on.md), [worker control](agent-worker.md) and [operations](operations.md).

`/browser start` uses installed Chromium/Chrome/Edge for a dedicated headless CDP browser and authenticated loopback MCP with explicit allowed origins. Root Unix refuses to disable Chromium's sandbox; use a browser MCP service running as a normal user through `/computer-use setup`. External desktop automation needs a supplied HTTP MCP service; screenshots additionally require model vision support. `/ide` requires installed VS Code/Cursor. Fine-tuning/GPU controls require real compatible provider services and do not provision them. Native macOS/ARM, physical audio, external desktop, production providers and GPU billing remain unverified. The [v0.6 verification record](verification-v0.6.md) distinguishes native acceptance from fixtures and pending coverage.
