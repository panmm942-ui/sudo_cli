# Saved AI choices and local models

The `/switch` interface can list named AI connections and add another choice. A saved profile remembers the display name, model ID, compatible endpoint and protocol. It can also remember the context window, the name of an API-key environment variable, and effort levels explicitly declared as supported by that provider/model.

**API-key values are never saved in a profile.** Keys remain in the running process, come from an environment variable or are requested again when needed in a future launch. Profiles also exclude conversation content, work permissions and Web Access preferences.

Local presets are endpoint shortcuts:

| Preset | Default compatible endpoint |
| --- | --- |
| Ollama | `http://localhost:11434/v1` |
| LM Studio | `http://localhost:1234/v1` |
| Custom local server | `http://localhost:8000/v1`, editable |

The local server must already be running and the selected model must be available. These shortcuts do not download model weights, allocate a cloud host, start a server or imply that every loaded model supports tool use, images or effort controls. Ollama documents its [local OpenAI-compatible API](https://docs.ollama.com/api/openai-compatibility); LM Studio documents its [compatible endpoints and example port](https://lmstudio.ai/docs/developer/openai-compat). The presets use Chat Completions through codexcli's adapter; a compatible Responses endpoint can also be selected.

Profiles live in a dedicated `models` subdirectory of codexcli's per-user state directory: `%LOCALAPPDATA%\codexcli` on Windows, `~/Library/Application Support/codexcli` on macOS, and `$XDG_STATE_HOME/codexcli` or `~/.local/state/codexcli` on Linux. The UI manages these choices; editing configuration files is unnecessary.

Names are trimmed, Unicode-normalized and matched without case sensitivity. Storage filenames are hashes, so a profile name cannot become a filesystem path. Each record contains only allowlisted metadata, has a size limit, and is replaced atomically with a per-profile edit lock. Different profiles can be saved concurrently without replacing each other's state. Invalid records and symbolic links are reported and left untouched. Interrupted edit locks are reported rather than silently ignored.

## Module interface

```js
const profiles = await createModelProfiles({ stateDir });
await profiles.save({
  name: 'Local coding',
  model: 'your-installed-model-id',
  baseUrl: 'http://localhost:11434/v1',
  transport: 'chat-completions',
  contextWindow: 128000,          // optional
  apiKeyEnv: 'MY_MODEL_KEY',     // optional variable name, never its value
  supportedEfforts: ['low', 'high'], // optional, user-declared capabilities
});
const choices = await profiles.list();
const profile = await profiles.get('Local coding');
const removed = await profiles.remove('Local coding');
```

`get` returns `undefined` when absent. `remove` returns a boolean. `save` returns the sanitized saved profile and deliberately drops an incoming `apiKey` field and arbitrary extra fields. `localEndpointPresets` is a frozen array of `{id, label, baseUrl, transport, requiresRunningServer}`. Tests inject temporary state directories and make no writes to real saved profiles.
