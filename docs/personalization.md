# Optional personalization for each AI

Personalization is off until you configure it. Each saved choice belongs to the combination of API base URL, model identifier and transport (`responses` or `chat-completions`). Renaming a model profile or changing its API key keeps the same preferences; choosing another model, endpoint or transport selects another record. Equivalent URL host casing, default ports and trailing slashes use the same identity.

Use `/personalize setup` to configure a persona and `/preferences setup` to configure language, tone, response length, response format and additional instructions. These fields accept custom text; they are preferences for the model rather than settings that guarantee its behavior. `/personalize status` and `/preferences status` show the selected AI's saved choices. `/personalize on` enables them, `/personalize off` retains them without applying them, and `/personalize clear` removes that AI's record.

When enabled, codexcli builds readable developer instructions for the native engine. Changing the preference setup requires the UI to start the next engine connection with the updated instructions. The current task and higher-priority instructions still take precedence. This does not train the model, change its weights or guarantee that every provider follows the instructions.

## Storage and limits

Records are stored under `personalization/` inside codexcli's state directory:

| System | Default state directory |
| --- | --- |
| Windows | `%LOCALAPPDATA%\codexcli` |
| Linux | `$XDG_STATE_HOME/codexcli`, when XDG_STATE_HOME is absolute; otherwise `~/.local/state/codexcli` |
| macOS | `~/Library/Application Support/codexcli` |

Launching with a different OS account selects that account's state directory. In particular, `sudo` commonly uses root's home and state rather than the original user's saved choices.

Each filename contains a SHA-256 hash of the connection identity. The record contains a version, that hash, an enabled boolean, persona and the five selected preference fields. It contains no API key, model profile name, session permission policy or chat messages. Preferences themselves are saved as text, so use them for behavior choices rather than credentials. The store removes currently known secrets, including the selected connection's API key, before saving and when returning a record.

Persona and additional instructions each allow 8,192 JavaScript string characters. Language allows 128; tone, length and format each allow 512. The serialized record is capped at 64 KiB. Terminal control characters are rejected while normal newlines and tabs are allowed. If redaction expands a value beyond a bound, saving fails before creating a record.

On Unix, new directories use mode `0700` and records use `0600`; Windows uses the containing account's normal filesystem ACLs. Writes use a private temporary file, flush it, and rename it atomically. A per-AI exclusive lock prevents concurrent edits to the same record. A stale lock from an interrupted edit is reported and preserved rather than deleted automatically. Corrupt, oversized or mismatched records are reported and left unchanged. Symbolic-link records, storage directories and ancestor paths are refused. The store does not claim protection from an administrator who can replace the filesystem while the process is running.

## Module API

```js
import { createPersonalization, personalizationInstructions } from './src/personalization.mjs';

const store = await createPersonalization({ stateDir, secrets: () => knownSecrets });
const saved = await store.get(connection); // undefined when unset
await store.save(connection, {
  enabled: true,
  persona: 'Act as a careful programming assistant.',
  preferences: { language: 'English', tone: 'direct' },
});
const developerInstructions = personalizationInstructions(await store.get(connection));
await store.remove(connection); // boolean: whether a record was removed
```

`save` replaces the selected record and returns `{enabled, persona, preferences}`. To toggle an existing record, spread `await get(connection)` before setting `enabled`; an omitted persona becomes `''` and omitted preferences become `{}`. `personalizationInstructions(undefined)` and disabled records return an empty string. The secret callback returns an array of known strings; it is never serialized.

Tests use temporary directories and synthetic secrets. Windows and native Linux verification cover identity separation, persistence, redaction, validation, bounded records and exclusive locks; native Linux also verifies private modes and symbolic-link refusal. Native macOS has not been exercised.
