# Terminal and GUI

SUDO CLI keeps one session, one native engine and one pending-input queue. Enter `/gui` to open its graphical view. Use **Return to terminal** to continue in the terminal; view changes do not repeat a prompt or reconnect the model. A previous GUI session cannot submit actions after it is revoked.

## Terminal controls

Chat and Events scroll independently. The composer stays separate from the chat viewport, with a local time and numbered `01@you >` prompt. Accepted top-level submissions increment the number once; setup and approval answers do not. A new chat starts at 01, while a saved chat resumes its sequence.

Tab changes the focused scroll panel. Page Up/Down and Home/End navigate that panel. Mouse wheel and scrollbar clicks work where the terminal supports mouse reporting. Narrow terminals use a compact panel layout. The command picker opens with `/`; arrows and Page Up/Down browse, Enter selects, and Escape returns to the composer.

Paste into an active setup field inserts editable text, including a connection URL. Supported bracketed paste keeps slash-prefixed prompts literal. `/prompt` provides multiline entry on other terminals; finish it with `/end`. Hidden credential fields retain hidden input. `/stop` or Ctrl+C interrupts active work; queued prompts remain available.

Operational notices, approvals, completion and errors appear in Events. Chat contains user prompts and AI replies. Performance remains a live panel; `/performance` is no longer a command. Your text defaults to green, and the dashboard retains its original red branding and antenna animation.

## GUI controls

The browser has Chat, Events, Performance, a command picker and changed files. Connection/setup questions and approval choices belong to the current question; submitting an old answer does not approve a later request. Credentials are not included in GUI snapshots or saved conversation views.

The server binds to loopback on a temporary port with a per-session token, bounded requests, and host/origin checks. The launch link contains an initial token that the frontend removes from visible browser history. Keep the GUI link private. Closing SUDO CLI closes the server; returning to the terminal revokes that graphical session.

If automatic browser launch is unavailable, use the local link shown by SUDO CLI. No external website or desktop-app connection is required.

## Changed files

`/changes` and the GUI share the current project view: **added**, **modified**, and **deleted** relative file paths. Selecting a file in the GUI opens a read-only preview. Explicit refresh and completed work update the inventory without changing files or the Git index.

For a project with a safe local Git directory, status includes staged, unstaged and untracked files. Previews separate staged and working-tree edits. Renames are represented as additions and deletions rather than guessed. Git worktrees with external metadata and folders without Git use the fallback below.

Git inspection uses a temporary detached metadata view with a fixed configuration and a copied index. Repository filter commands, hooks and external diff drivers are not loaded, and the original index and configuration remain unchanged. Temporary cleanup checks the captured directory identity before removing it. Conventional SHA-1 repositories are supported within an 8 MiB index and 50,000 object-metadata entries. Linked metadata, alternate object stores, unsafe links and other unsupported layouts use an explicitly partial baseline view that says staged changes are unavailable.

Without usable Git metadata, the view compares against a session-local baseline captured when SUDO CLI opens. Small files use content hashes; larger files use file metadata. This detects ordinary edits but is not a filesystem journal or proof of which actor made a change. Restarting the session establishes a new baseline.

The inventory excludes credentials, private state, Git data, generated dependencies, runtime/upstream directories, and unsafe links. Paths supplied as private-state exclusions are omitted even when inside the project. Default limits are 10,000 files, 20,000 entries and 32 directory levels; limited or unreadable coverage is marked partial. Previously covered missing paths are checked explicitly for deletion, rather than treating a bounded scan's omission as a deletion. Files outside a partial baseline cannot reliably be classified as new.

Text previews are capped at 64 KiB, redact known keys and credential patterns, and remove terminal control bytes. Binary or oversized content has an explicit unavailable message. Raw file contents and absolute project paths are not part of the changed-file snapshot. Treat arbitrary project text as untrusted even in a redacted preview.

`/changes CHECKPOINT_ID` retains historical checkpoint review. `/undo CHECKPOINT_ID` uses the existing conflict checks; opening the current view does not create or restore a checkpoint. `/verify COMMAND` records an acceptance check separately from model claims.

## Demo images and verification

The README images are actual terminal and browser captures of a synthetic local demo. They must contain no real conversations, account credentials or personal machine paths. Local fixture tests and platform CI establish tested behavior, with physical terminal, audio and driver limits reported separately.

See [setup](platforms.md), [permissions](privileges.md), [signed integrity](release-integrity.md) and [session cleanup](native-session-lifecycle.md).
