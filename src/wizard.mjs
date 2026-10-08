import { validateConnection } from './runtime.mjs';

export async function configureConnection({ opts, env = process.env, interactive, ask, refresh = false,guided=false,preset, report = () => {} }) {
  let initial = refresh ? {} : opts;
  const environment = refresh ? {} : env;
  if(guided&&interactive&&!initial.model&&!environment.SUDO_CLI_MODEL){
    const choice=await ask(`  AI setup [1 Cloud/custom / 2 Ollama / 3 LM Studio${preset?' / 4 Last AI':''}] › `);
    if(choice==='4'&&preset)initial={...preset};
    else if(choice==='2'||choice==='3'){const base=choice==='2'?'http://localhost:11434/v1':'http://localhost:1234/v1';const baseUrl=(await ask(`  Local API URL [${base}] › `))||base;initial={baseUrl,transport:'chat-completions'};
      try{const {discoverModels}=await import('./provider-capabilities.mjs');const result=await discoverModels({...initial,model:'catalog'});result.models.forEach((model,index)=>report(`${index+1}. ${model}`));const model=await ask('  Local model [number or exact ID] › ');initial.model=/^\d+$/.test(model)?result.models[Number(model)-1]:model;}catch{report('Local catalog unavailable; ensure the server is running and enter its exact model ID.');}}
    else if(choice!==''&&choice!=='1')throw new Error('Choose cloud/custom, Ollama, LM Studio or the last AI.');
  }
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
  let contextWindow=initial.contextWindow??opts.contextWindow;
  if(guided&&interactive&&contextWindow===undefined){const answer=await ask('  Model context capacity [tokens if known; Enter: unknown] › ');if(answer)contextWindow=Number(answer);}
  const selected = validateConnection({ model, baseUrl, transport, apiKeyEnv, contextWindow: contextWindow === undefined ? undefined : Number(contextWindow) });
  let apiKey = apiKeyEnv ? env[apiKeyEnv] : environment.SUDO_CLI_API_KEY;
  if (apiKeyEnv && !apiKey) throw new Error(`Environment variable ${apiKeyEnv} is empty or missing.`);
  if (!apiKey && interactive) apiKey = await ask('  API key [hidden; Enter for none] › ', true);
  return validateConnection({ ...selected, apiKey: apiKey || undefined });
}
