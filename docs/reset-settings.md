# Reset settings

Use `/reset` to see the available reset targets and choose a number or target name. Press Enter without a selection to cancel. `/reset list` shows the same target descriptions without opening a selection prompt.

Reset one setting directly by name:

```text
/reset txtcolor
/reset bgcolor
/reset colors
/reset updates
```

Target names are case insensitive. Each reset reports completion after its setting change finishes. Unknown targets, extra arguments and flags are rejected before any setting changes. The descriptions shown by `/reset list` identify exactly what each target restores or clears; unavailable actions are omitted.

`/reset all` shows the concrete setting changes it will apply and asks `y/n`. Only `y` or `yes` approves that displayed group. Other responses cancel without changing settings. The group restores eligible interface and runtime settings; individual color targets are omitted when the combined `colors` target is included, so colors reset once.

Bulk reset excludes project memory, AI preferences, model connections and stored user data. It does not remove chats, profiles, files, model weights, credentials or saved agents. A target such as `memory`, `preferences` or `ai` must be requested by its own name, and its displayed description explains its effect. Folder, attachment and skill targets concern the CLI's selections or working state; resetting those settings does not authorize deleting their underlying files.

If one grouped callback fails, later independent setting resets are still attempted. The CLI reports the completed and failed target names separately. A partial reset is not reported as a successful reset of everything. Re-run a failed target once its reported problem has been resolved.

## Action integration

`createResetCommands({actions,ask,note})` returns a command handler with `async handle({name,args})`. The handler returns `false` for another command and `true` after handling `/reset`; validation and callback failures reject normally so the UI can display the error.

`actions` is an object keyed by safe lowercase target IDs. Each value has:

- `description`: a plain, single-line description of the actual effect, limited to 500 characters.
- `reset`: an asynchronous or synchronous callback that performs and persists that setting reset.
- `includeInAll`: optional boolean, defaulting to `true`; use `false` for individual aliases or actions that should require an explicit target.
- `available`: an optional synchronous function returning a boolean for the current session.

At most 64 targets can be registered. IDs contain lowercase letters, digits and hyphens, begin with a letter and have at most 40 characters. `all` and `list` are reserved. Known stored-data and connection targets, including `memory`, `preferences` and `ai`, are excluded from bulk reset even when their action is mistakenly marked for inclusion.

The parent UI owns the setting callbacks and the exact defaults. A callback should resolve only after its reset and persistence are complete. Bulk callbacks run sequentially; availability is rechecked after confirmation before each callback executes. An `AggregateError` identifies partial failures without publishing callback exception details in the command's user-facing message.
