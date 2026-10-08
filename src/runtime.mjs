import { accessSync, constants, readdirSync, statSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { delimiter, extname, isAbsolute, join, resolve } from 'node:path';

const windows = process.platform === 'win32';
const environmentName = /^[A-Za-z_][A-Za-z0-9_]*$/;
const controlCharacters = /[\u0000-\u001f\u007f]/;

function environmentValue(env, name) {
  if (env[name] !== undefined) return env[name];
  if (windows) {
    const key = Object.keys(env).find(key => key.toUpperCase() === name);
    return key === undefined ? undefined : env[key];
  }
}

function isExecutable(path) {
  try {
    if (windows && extname(path).toLowerCase() !== '.exe') return false;
    if (!statSync(path).isFile()) return false;
    accessSync(path, windows ? constants.F_OK : constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

function pathDirectories(env) {
  const value = environmentValue(env, 'PATH') ?? '';
  return String(value).split(delimiter).filter(Boolean).map(path => {
    return path.startsWith('"') && path.endsWith('"') ? path.slice(1, -1) : path;
  });
}

/** Discover a native executable, without command interpretation or a shell. */
export function resolveCodex({ env = process.env } = {}) {
  const directories = pathDirectories(env);
  const override = environmentValue(env, 'SUDO_CLI_CODEX');
  if (override !== undefined) {
    if (typeof override !== 'string' || !override || controlCharacters.test(override)) {
      throw new Error('SUDO_CLI_CODEX override must identify an executable file.');
    }
    const candidates = isAbsolute(override) || /[/\\]/.test(override)
      ? [resolve(override)]
      : directories.map(directory => resolve(directory, override));
    const found = candidates.find(isExecutable);
    if (found) return found;
    throw new Error('SUDO_CLI_CODEX override does not identify an available native executable.');
  }

  const filename = windows ? 'codex.exe' : 'codex';
  for (const directory of directories) {
    const path = resolve(directory, filename);
    if (isExecutable(path)) return path;
  }

  const localAppData = environmentValue(env, 'LOCALAPPDATA');
  if (windows && typeof localAppData === 'string' && localAppData) {
    const bin = join(localAppData, 'OpenAI', 'Codex', 'bin');
    try {
      const candidates = readdirSync(bin, { withFileTypes: true })
        .filter(entry => entry.isDirectory())
        .map(entry => join(bin, entry.name, 'codex.exe'))
        .filter(isExecutable)
        .sort((a, b) => statSync(b).mtimeMs - statSync(a).mtimeMs || a.localeCompare(b));
      if (candidates.length) return resolve(candidates[0]);
    } catch {
      // The optional desktop bundle may be absent or inaccessible.
    }
  }
  throw new Error('Codex executable was not found. Run node scripts/setup-runtime.mjs in the sudo cli folder or set SUDO_CLI_CODEX to its executable path.');
}

function validatedUrl(value) {
  if (typeof value !== 'string' || !value.trim() || controlCharacters.test(value)) {
    throw new Error('Base URL must be an HTTP or HTTPS URL.');
  }
  let url;
  try {
    url = new URL(value);
  } catch {
    throw new Error('Base URL must be an HTTP or HTTPS URL.');
  }
  if (!['http:', 'https:'].includes(url.protocol) || !url.hostname) {
    throw new Error('Base URL must use HTTP or HTTPS.');
  }
  if (url.username || url.password || value.includes('?') || value.includes('#')) {
    throw new Error('Base URL cannot contain credentials, query parameters, or a fragment.');
  }
  return url.toString();
}

function validatedEnvironmentName(value) {
  if (typeof value !== 'string' || !environmentName.test(value)) {
    throw new Error('API key environment variable name is invalid.');
  }
  return value;
}

/** Keep runtime secrets in memory; never include their values in diagnostics. */
export function validateConnection(connection) {
  if (!connection || typeof connection !== 'object' || Array.isArray(connection)) {
    throw new Error('A model connection is required.');
  }
  const { transport, model, baseUrl, apiKeyEnv, apiKey, contextWindow } = connection;
  if (!['responses', 'chat-completions'].includes(transport)) {
    throw new Error('Transport must be responses or chat-completions.');
  }
  if (typeof model !== 'string' || !model.trim() || controlCharacters.test(model)) {
    throw new Error('Model must be a nonempty identifier without control characters.');
  }
  const normalized = { transport, model, baseUrl: validatedUrl(baseUrl) };
  if (apiKeyEnv !== undefined) normalized.apiKeyEnv = validatedEnvironmentName(apiKeyEnv);
  if (apiKey !== undefined) {
    if (typeof apiKey !== 'string' || !apiKey.trim()) throw new Error('API key must be a nonempty string.');
    normalized.apiKey = apiKey;
  }
  if (contextWindow !== undefined) {
    if (!Number.isSafeInteger(contextWindow) || contextWindow <= 0) {
      throw new Error('Context window must be a positive safe integer.');
    }
    normalized.contextWindow = contextWindow;
  }
  return normalized;
}

/** TOML basic strings use the same escapes as JSON for these validated values. */
export function providerArgs(connection, { baseUrl = connection.baseUrl, keyEnv = 'SUDO_CLI_SESSION_KEY' } = {}) {
  const normalized = validateConnection(connection);
  const options = {
    model: normalized.model,
    model_provider: 'sudo_session',
    'model_providers.sudo_session.name': 'sudo cli',
    'model_providers.sudo_session.base_url': validatedUrl(baseUrl),
    'model_providers.sudo_session.env_key': validatedEnvironmentName(keyEnv),
    'model_providers.sudo_session.wire_api': 'responses',
    'model_providers.sudo_session.requires_openai_auth': false,
    'model_providers.sudo_session.supports_websockets': false,
    web_search: 'disabled',
    model_supports_reasoning_summaries: false,
  };
  if (normalized.contextWindow !== undefined) options.model_context_window = normalized.contextWindow;
  return Object.entries(options).flatMap(([key, value]) => ['-c', `${key}=${JSON.stringify(value)}`]);
}

/** A new empty Codex home prevents reuse of saved auth or provider configuration. */
export async function createSessionHome({ baseDir = tmpdir() } = {}) {
  const path = await mkdtemp(join(resolve(baseDir), 'sudo-cli-session-'));
  return {
    path,
    async cleanup() {
      // This exact absolute path is the owned mkdtemp child, never a user-supplied deletion target.
      await rm(path, { recursive: true, force: true });
    },
  };
}
