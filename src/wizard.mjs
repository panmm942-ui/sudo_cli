import { validateConnection } from './runtime.mjs';
import { localEndpointPresets } from './model-profiles.mjs';
import { discoverModels } from './provider-capabilities.mjs';

function loopbackUrl(value) {
  const baseUrl = validateConnection({ model: 'local', baseUrl: value, transport: 'chat-completions' }).baseUrl;
  const hostname = new URL(baseUrl).hostname.toLowerCase();
  if (hostname !== 'localhost' && hostname !== '[::1]' && !/^127\.\d+\.\d+\.\d+$/.test(hostname)) {
    throw new Error('Local AI must use localhost, 127.0.0.1 or ::1. Use Cloud/API for a server on another machine.');
  }
  return baseUrl;
}

export function isLocalEndpoint(value) {
  try { loopbackUrl(typeof value === 'string' ? value : value?.baseUrl); return true; } catch { return false; }
}

const localInstructions = {
  ollama: 'Start your installed Ollama server with: ollama serve. Select a model you already installed.',
  lmstudio: 'Open LM Studio, load your installed model, then start its Local Server.',
  customLocal: 'Start your installed llama.cpp, vLLM or other OpenAI-compatible local server. Use its server URL and model ID.',
};

/** Configure a running endpoint; local setup never installs weights or borrows cloud credentials. */
export async function configureConnection({ opts = {}, env = process.env, interactive, ask, refresh = false, guided = false, forceLocal = false, preset, report = () => {} }) {
  let initial = refresh ? {} : opts;
  let environment = refresh ? {} : env;
  let localSetup = false, localApiKey;
  const choose = async (provided, prompt, validate, hidden = false) => {
    if (provided) return validate(provided);
    while (true) {
      const value = await ask(prompt, hidden);
      try { return validate(value); }
      catch (error) { if (!interactive) throw error; report(error.message); }
    }
  };
  const askLocalAuthentication = async () => {
    const answer = await choose(undefined, '  Does this local server require authentication? [y/N] › ', value => {
      if (['', 'n', 'no'].includes(value.toLowerCase())) return false;
      if (['y', 'yes'].includes(value.toLowerCase())) return true;
      throw new Error('Choose yes or no. Most local servers need no key.');
    });
    if (answer) localApiKey = await choose(undefined, '  Local server key [hidden] › ', value => {
      if (!value || !value.trim()) throw new Error('Enter the key configured on your local server.');
      return value;
    }, true);
  };

  if (forceLocal && !interactive) {
    // Explicit command-line local use still supports an intentionally named local key.
    initial = { ...opts, baseUrl: loopbackUrl(opts.baseUrl), transport: opts.transport || 'chat-completions' };
    environment = {};
    localSetup = true;
  } else if (forceLocal || (guided && interactive && !initial.model)) {
    const choice = forceLocal ? '2' : await choose(undefined,
      `  AI setup [1 Cloud/API / 2 Local AI on this PC${preset ? ' / 3 Last AI' : ''}] › `,
      value => {
        if (['', '1', '2'].includes(value) || (value === '3' && preset)) return value || '1';
        throw new Error('Choose Cloud/API, Local AI on this PC or the last AI.');
      });
    if (choice === '3' && preset) {
      initial = { ...preset };
      localSetup = isLocalEndpoint(initial);
      if (localSetup) {
        environment = {};
        report('Using your saved local AI. Keep its local model server running.');
        if (!initial.apiKeyEnv) await askLocalAuthentication();
      }
    } else if (choice === '2') {
      localSetup = true;
      environment = {};
      const provider = await choose(undefined, '  Local AI [1 Ollama / 2 LM Studio / 3 Other local server] › ', value => {
        if (['', '1', '2', '3'].includes(value)) return localEndpointPresets[Number(value || '1') - 1];
        throw new Error('Choose Ollama, LM Studio or another local server.');
      });
      report(localInstructions[provider.id]);
      const baseUrl = await choose(undefined, `  Local server URL [${provider.baseUrl}] › `, value => loopbackUrl(value || provider.baseUrl));
      await askLocalAuthentication();
      initial = { baseUrl, transport: provider.transport };
      const result = await discoverModels({ ...initial, model: 'catalog', apiKey: localApiKey });
      if (result.ok && result.models.length) {
        result.models.forEach((model, index) => report(`${index + 1}. ${model}`));
        initial.model = await choose(undefined, '  Local model [number or exact ID] › ', value => {
          if (/^\d+$/.test(value)) {
            const selected = result.models[Number(value) - 1];
            if (!selected) throw new Error('Choose a model number shown above, or enter its exact ID.');
            return selected;
          }
          return validateConnection({ ...initial, model: value }).model;
        });
      } else {
        report(result.status === 'authentication-required'
          ? 'Local catalog requires authentication. Reconnect with /local and choose yes if your server uses a key.'
          : 'Local catalog unavailable. Keep the local server running and enter your installed model\'s exact ID.');
      }
    }
  }

  const model = await choose(initial.model || environment.SUDO_CLI_MODEL, localSetup ? '  Local model ID › ' : '  Model ID › ', value => validateConnection({ model: value, baseUrl: 'http://localhost', transport: 'responses' }).model);
  const baseUrl = await choose(initial.baseUrl || environment.SUDO_CLI_BASE_URL, localSetup ? '  Local server URL › ' : '  API base URL › ', value => localSetup ? loopbackUrl(value) : validateConnection({ model, baseUrl: value, transport: 'responses' }).baseUrl);
  let transport = initial.transport || environment.SUDO_CLI_TRANSPORT;
  if (!transport) {
    if (interactive) {
      let answer;
      do {
        answer = await ask('  API format [1 Chat Completions / 2 Responses] › ');
        if (!['', '1', '2'].includes(answer)) report('Choose 1 for Chat Completions or 2 for Responses.');
      } while (!['', '1', '2'].includes(answer));
      transport = answer === '2' ? 'responses' : 'chat-completions';
    } else transport = 'chat-completions';
  }
  const apiKeyEnv = initial.apiKeyEnv;
  let contextWindow = initial.contextWindow;
  if ((guided || forceLocal) && interactive && contextWindow === undefined) {
    const answer = await ask('  Model context capacity [tokens if known; Enter: unknown] › ');
    if (answer) contextWindow = Number(answer);
  }
  const selected = validateConnection({ model, baseUrl, transport, apiKeyEnv, contextWindow: contextWindow === undefined ? undefined : Number(contextWindow), capabilities: initial.capabilities, supportedEfforts: initial.supportedEfforts });
  let apiKey = apiKeyEnv ? env[apiKeyEnv] : localSetup ? localApiKey : environment.SUDO_CLI_API_KEY;
  if (apiKeyEnv && !apiKey) throw new Error(`Environment variable ${apiKeyEnv} is empty or missing.`);
  if (!apiKey && interactive && !localSetup) apiKey = await ask('  API key [hidden; Enter for none] › ', true);
  return validateConnection({ ...selected, apiKey: apiKey || undefined });
}
