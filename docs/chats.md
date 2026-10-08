# Saved chats

SUDO CLI saves the active chat automatically and restores the last chat for the current working folder on the next launch. Saving includes every visible user and AI message, the selected model connection metadata, partial assistant replies and queued text prompts. A completed response or normal exit flushes the latest checkpoint. An abrupt process termination can lose text since the most recent successful checkpoint.

Use `/new` to begin a new conversation. Choose whether to keep or discard the previous saved chat. Use `/chatt` to browse saved conversations and resume one. Resuming a conversation restores its visible transcript and asks for a connection key when one is needed; API key values are never stored in a chat record.

Each working folder has its own last-chat selection. Chats belonging to another folder may be listed explicitly, but they must be resumed from their original folder so that commands and file edits run in the intended project.

## What is saved

- The complete visible conversation, including Unicode, code and message order.
- Assistant completion state, including partial or interrupted replies.
- Model name, API base URL, transport, optional API key environment variable **name**, context window and declared effort levels.
- Attachment names, paths, media types and size metadata.
- Queued text prompts, when supplied by the session controller.

Source file contents, image bytes, audio bytes, API key values, arbitrary provider payloads, hidden model reasoning and live tool execution state are excluded. Files needed for a later task must be attached again. A resumed engine receives the saved visible conversation as prior conversation; interrupted commands are not replayed automatically.

Credentials known to the current session are redacted from titles, messages and queued prompts before writing. Saved chats contain plaintext conversation text after redaction. They are not encrypted backups. Unix records use mode `0600` inside directories created with mode `0700`; Windows files inherit the user's local application-data directory permissions.

## Storage and recovery

Records are stored in the `chats` subfolder of the SUDO CLI state directory. Every chat uses a random UUID filename such as `chat-<uuid>.json`. A separate `last-<project-hash>.json` file selects the last chat for each canonical project folder.

Each JSON record is limited to 50 MiB. Writes use a new private temporary file, flush its contents, then atomically replace the record. Per-record locks prevent two sessions from silently replacing each other's simultaneous edits. An interrupted edit can leave a `.lock` file: close other SUDO CLI sessions before investigating that lock. Storage directories and record files that are symbolic links are refused.

Corrupt chat files are skipped in the menu with a warning and are left unchanged. Selecting, overwriting or deleting a corrupt targeted record reports an error. Back up that file before repairing or removing it manually. An invalid last-chat pointer is also preserved and reported instead of being silently reset.

## Internal API

`await createChatStore({stateDir, cwd, secrets})` returns:

- `create({title?, connection?, history?, pendingInputs?})`: write a new chat and mark it as the current project chat.
- `save({id, history, title?, connection?, pendingInputs?})`: atomically checkpoint a known current-project chat. History must be supplied explicitly. Omitted connection and pending inputs retain their previous values; `connection: null` clears connection metadata and `pendingInputs: []` clears the queue.
- `list({allProjects: false})`: records ordered by latest update, normally from the current project only.
- `get(id)`: read a validated record, or return `undefined` when absent.
- `last()`: read the current project's last record, or return `undefined` when absent.
- `setLast(id)`: select a saved current-project chat.
- `remove(id)`: remove one current-project chat and its last selection if selected. Return whether a record existed.
- `warnings()`: copy the warnings from the most recent listing.
- `directory`: absolute saved-chat directory.

`createChatHistory().restore(snapshot)` imports a validated version-1 snapshot atomically, strips arbitrary fields and attachment payloads, redacts current session secrets, restores assistant IDs and permits continuation of partial replies without duplicate messages.
