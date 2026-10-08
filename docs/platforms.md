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

Setup saves the command wrapper, its PATH registration and any required executable runtime. The wrapper contains only paths to Node.js and this project's entry point. Setup saves no model identifier, endpoint, API key or conversation. Model selection happens while `sudocli` runs. Runtime sessions separately autosave visible chats and work totals, and explicit profile/personalization/inbox actions save their local records. Model and service key values remain in memory. `SUDO_CLI_STATE_DIR` can choose the persistent state location; normal state ownership follows the elevated account and OS permissions.

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

Windows x64 and Linux x64 under an existing WSL2 distribution have native runtime and command tests. Windows tests also verify refusal under a standard token; actual detached native workers are exercised under root on Linux. Setup's registration tests use temporary homes and an injected Windows PATH store to avoid changing real user settings. Actual command registration is a separate first setup action. macOS and arm64 package mappings are present, but native execution still needs validation on those hosts.

Underlying shell permissions and filesystem sandboxes remain platform-dependent. Linux uses the bundled Bubblewrap helper and may need working user namespaces; WSL uses the Linux package. macOS permissions follow the user's operating-system policy. Root launch does not automatically enable Allow Everything: Ask remains the default, and a detached worker cannot approve an action for you. The [upstream installation guide](https://github.com/openai/codex/blob/rust-v0.160.1/docs/install.md) documents supported system versions.

## Version 0.5 runtime features

The [user guide](user-guide.md) covers saved AI selection, local model endpoints, automatic chat resumption, per-AI personalization, complete visible-chat transfer on the next prompt, queued tasks, steering, attachments, skills and optional services. Saved profiles contain nonsecret model metadata; chats contain sanitized visible user/assistant text and queued text prompts. Keys, active execution choices and service settings remain in the running process. Worked totals persist separately as numbers. Setup itself does not save a model connection. Third-party models need compatible APIs and real tool support; a model name alone does not establish compatibility.

The WiFi monitor reads local interfaces only: NetAdapter PowerShell on Windows, sysfs on Linux, and networksetup/ifconfig/netstat on macOS. It measures current physical-interface traffic rather than maximum bandwidth and cannot infer host WiFi from WSL guest interfaces. Missing tools, permissions or ambiguous data remain Unknown.

Microphone recording additionally needs FFmpeg and OS microphone permission. Its backend is DirectShow on Windows (an exact device name is required), PulseAudio on Linux, and AVFoundation on macOS. `/microphone on` only arms access; `/voice record` starts a bounded recording. `/voice live` starts continuous capture with silence-segmented compatible transcription, ordinary coding turns and compatible text-to-speech played through FFplay. Configure transcription and speech separately with `/voice setup` and `/voice speech`. New speech interrupts playback and active AI work. Use headphones: this energy detector has no acoustic echo cancellation. Synthetic native recorder/player children and local HTTP services are tested; physical microphone/speaker operation remains unverified. See [live voice](live-voice.md).

The 24/7 guardian uses a saved loopback local model plus a working model, an explicit durable task inbox and optional chosen-folder/standing-goal triggers. Foreground mode ends with this terminal session; `/247 detach` runs a separate authenticated loopback-controlled elevated worker that survives terminal closure. Reboot autostart is not installed. Detached Ask-mode approvals block the job, and permission/web/MCP/computer policy changes stop active workers until explicitly restarted. Saved results remain in the task inbox, viewed through `/247 result`, rather than being merged automatically into chats. GPU wake/sleep hooks require a provider service that actually releases billed compute. See [guardian behavior](always-on.md) and [worker control](agent-worker.md).

`/ide` requires installed VS Code/Cursor. Browser/desktop automation requires your running HTTP MCP service and model tool/vision support. Fine-tuning controls require a compatible provider service and fine-tunable model; they do not supply GPU resources. Native macOS and Windows/Linux ARM execution remain unverified. The [verification record](verification.md) distinguishes actual native tests from fixtures and pending host/service coverage.
