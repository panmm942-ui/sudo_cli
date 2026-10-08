import { accessSync, constants, readdirSync, statSync } from 'node:fs';
import { mkdtemp, rm, lstat, realpath, readdir, chown } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { delimiter, extname, isAbsolute, join, resolve } from 'node:path';
import {permissionPolicy} from './permission-scope.mjs';

const windows = process.platform === 'win32';
const environmentName = /^[A-Za-z_][A-Za-z0-9_]*$/;
const controlCharacters = /[\u0000-\u001f\u007f]/;

// Pinned native ReasoningEffort strings. A provider may additionally declare
// its own values; accepting a native value is not a claim of model support.
export const REASONING_EFFORTS = Object.freeze(['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max', 'ultra', 'persistent']);
export const CAPABILITY_NAMES = Object.freeze(['text', 'streaming', 'tools', 'vision', 'reasoning', 'audio', 'structuredOutput', 'hostedSearch', 'training', 'modelDiscovery']);
const effortIdentifier = (value) => typeof value === 'string' && /^[a-z][a-z0-9_-]{0,63}$/.test(value);

export function validateCapabilities(value) {
  if (value === undefined) return undefined;
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).length > CAPABILITY_NAMES.length || Object.entries(value).some(([name, supported]) => !CAPABILITY_NAMES.includes(name) || typeof supported !== 'boolean')) throw new Error('Model capabilities must be known boolean declarations.');
  return { ...value };
}

export function validateSupportedEfforts(value) {
  if (value === undefined) return undefined;
  if (!Array.isArray(value) || value.length > 64 || value.some(effort => !effortIdentifier(effort)) || new Set(value).size !== value.length) {
    throw new Error('Supported reasoning efforts must be a list of unique effort identifiers.');
  }
  return [...value];
}

export function validateReasoningEffort(value, { supportedEfforts } = {}) {
  const supported = validateSupportedEfforts(supportedEfforts);
  if (value === undefined) return undefined; // Keep the provider's default.
  if (!effortIdentifier(value) || (!REASONING_EFFORTS.includes(value) && !supported?.includes(value))) throw new Error('Reasoning effort must be a native level or a declared model effort.');
  if (supported && !supported.includes(value)) throw new Error('Reasoning effort is not supported by the selected model profile.');
  return value;
}

/** Retain an override only when it is compatible with the newly selected AI. */
export function resolveReasoningEffort(value, {supportedEfforts,capabilities} = {}) {
  const supported = validateSupportedEfforts(supportedEfforts);
  const declared = validateCapabilities(capabilities);
  if (declared?.reasoning === false) return undefined;
  try { return validateReasoningEffort(value, {supportedEfforts:supported}); }
  catch { return undefined; }
}

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
  const { transport, model, baseUrl, apiKeyEnv, apiKey, contextWindow, supportedEfforts, capabilities } = connection;
  if (!['responses', 'chat-completions'].includes(transport)) {
    throw new Error('Transport must be responses or chat-completions.');
  }
  if (typeof model !== 'string' || !model.trim() || controlCharacters.test(model)) {
    throw new Error('Model must be a nonempty identifier without control characters.');
  }
  const normalized = { transport, model, baseUrl: validatedUrl(baseUrl) };
  if (capabilities !== undefined) normalized.capabilities = validateCapabilities(capabilities);
  if (supportedEfforts !== undefined) normalized.supportedEfforts = validateSupportedEfforts(supportedEfforts);
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

/** Permission and web choices are session-scoped and never inferred from strings. */
export function validateRuntimeOptions(options = {}) {
  if (!options || typeof options !== 'object' || Array.isArray(options)) throw new Error('Permissions and Web Access must be runtime options.');
  const { permissions = 'ask', webAccess = false } = options;
  if (!['ask', 'allow-everything'].includes(permissions)) throw new Error('Permissions must be ask or allow-everything.');
  if (typeof webAccess !== 'boolean') throw new Error('Web Access must be on or off as a boolean.');
  return { permissions, webAccess };
}

/** TOML basic strings use the same escapes as JSON for these validated values. */
export function providerArgs(connection, { baseUrl = connection.baseUrl, keyEnv = 'SUDO_CLI_SESSION_KEY', permissions = 'ask', webAccess = false,scope,writableRoots=[] } = {}) {
  const normalized = validateConnection(connection);
  const runtime = validateRuntimeOptions({ permissions, webAccess });
  const policy=permissionPolicy({...runtime,scope:scope||(permissions==='allow-everything'?'full':'project'),writableRoots});
  const options = {
    model: normalized.model,
    model_provider: 'sudo_session',
    'model_providers.sudo_session.name': 'sudo cli',
    'model_providers.sudo_session.base_url': validatedUrl(baseUrl),
    'model_providers.sudo_session.env_key': validatedEnvironmentName(keyEnv),
    'model_providers.sudo_session.wire_api': 'responses',
    'model_providers.sudo_session.requires_openai_auth': false,
    'model_providers.sudo_session.supports_websockets': false,
    approval_policy: runtime.permissions === 'ask' ? 'on-request' : 'never',
    sandbox_mode: policy.sandbox,
    'sandbox_workspace_write.network_access': policy.networkAccess,
    'sandbox_workspace_write.exclude_tmpdir_env_var': true,
    'sandbox_workspace_write.exclude_slash_tmp': true,
    // Chat Completions has no native hosted-search equivalent. Network-enabled
    // commands and explicitly supplied MCP servers remain available when on.
    web_search: policy.networkAccess && normalized.transport === 'responses' && normalized.capabilities?.hostedSearch !== false ? 'live' : 'disabled',
    model_supports_reasoning_summaries: false,
    'shell_environment_policy.inherit': 'core',
    'shell_environment_policy.ignore_default_excludes': false,
    'shell_environment_policy.exclude': ['SUDO_CLI_SESSION_KEY','SUDO_MCP_*','CODEX_HOME'],
  };
  if (normalized.contextWindow !== undefined) options.model_context_window = normalized.contextWindow;
  if(policy.writableRoots.length)options['sandbox_workspace_write.writable_roots']=policy.writableRoots;
  return Object.entries(options).flatMap(([key, value]) => ['-c', `${key}=${JSON.stringify(value)}`]);
}

const disposableSessionHomes=new Map();
/** Grant only this module's exact, empty temporary directory to an admitted child. */
export async function grantSessionHomeOwner(path,identity){
  if(!identity)return;
  if(process.platform!=='linux'||process.getuid?.()!==0||!Number.isSafeInteger(identity.uid)||identity.uid<=0||identity.uid>=0xffffffff||!Number.isSafeInteger(identity.gid)||identity.gid<0||identity.gid>=0xffffffff)throw new Error('Invalid native session home owner.');
  const registration=disposableSessionHomes.get(path);
  if(!registration)throw new Error('Scoped sudo execution requires a CLI-created disposable session home.');
  const info=await lstat(path);
  if(!info.isDirectory()||info.isSymbolicLink()||await realpath(path)!==path||info.ino!==registration.ino||info.dev!==registration.dev||(info.mode&0o777)!==0o700||info.uid!==registration.uid||info.gid!==registration.gid||(await readdir(path)).length)throw new Error('Disposable native session home changed before ownership admission.');
  await chown(path,identity.uid,identity.gid);registration.uid=identity.uid;registration.gid=identity.gid;
}
/** A new empty Codex home prevents reuse of saved auth or provider configuration. */
export async function createSessionHome({ baseDir = process.platform==='linux'&&process.getuid?.()===0?'/tmp':tmpdir() } = {}) {
  const path = await mkdtemp(join(resolve(baseDir), 'sudo-cli-session-'));
  const info=await lstat(path);disposableSessionHomes.set(path,{ino:info.ino,dev:info.dev,uid:info.uid,gid:info.gid});
  return {
    path,
    async cleanup() {
      // This exact absolute path is the owned mkdtemp child, never a user-supplied deletion target.
      await rm(path, { recursive: true, force: true });
      disposableSessionHomes.delete(path);
    },
  };
}
