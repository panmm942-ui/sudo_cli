import { validateConnection } from './runtime.mjs';

export async function configureConnection({ opts, env = process.env, interactive, ask, refresh = false, report = () => {} }) {
  const initial = refresh ? {} : opts;
  const environment = refresh ? {} : env;
  const choose = async (provided, prompt, validate) => {
    if (provided) return validate(provided);
    while (true) {
      const value = await ask(prompt);
      try { return validate(value); }
      catch (error) { if (!interactive) throw error; report(error.message); }
    }
  };
  const model = await choose(initial.model || environment.SUDO_CLI_MODEL, '  Model ID › ', value => validateConnection({ model: value, baseUrl: 'http://localhost', transport: 'responses' }).model);
  const baseUrl = await choose(initial.baseUrl || environment.SUDO_CLI_BASE_URL, '  API base URL › ', value => validateConnection({ model, baseUrl: value, transport: 'responses' }).baseUrl);
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
  const selected = validateConnection({ model, baseUrl, transport, apiKeyEnv, contextWindow: opts.contextWindow === undefined ? undefined : Number(opts.contextWindow) });
  let apiKey = apiKeyEnv ? env[apiKeyEnv] : environment.SUDO_CLI_API_KEY;
  if (apiKeyEnv && !apiKey) throw new Error(`Environment variable ${apiKeyEnv} is empty or missing.`);
  if (!apiKey && interactive) apiKey = await ask('  API key [hidden; Enter for none] › ', true);
  return validateConnection({ ...selected, apiKey: apiKey || undefined });
}
