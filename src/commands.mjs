export const COMMANDS = [
  {name:'/help',usage:'',description:'All commands; / also opens this menu'},
  {name:'/gui',usage:'',description:'Open the graphical view of this same session'},
  {name:'/status',usage:'',description:'Session, model, WiFi, context and timers'},
  {name:'/switch',usage:'[NAME|add|local|save NAME|remove NAME]',description:'Saved cloud/local AIs; transfer full chat on switch'},
  {name:'/model',usage:'[ID|list]',description:'Current model or endpoint model list'},
  {name:'/connect',usage:'[local]',description:'Choose cloud or local AI; cloud keys are optional for local servers'},
  {name:'/local',usage:'[add|SAVED_NAME|file PATH|info PATH]',description:'Load a model file or connect a local AI; no cloud API key needed'},
  {name:'/effort',usage:'[default|LEVEL|supported LEVELS]',description:'Reasoning request and declared model capabilities'},
  {name:'/permissions',usage:'[ask|allow-everything|scope read-only|project|full|tools|folders]',description:'Runtime permissions, scope, selected tools and write folders'},
  {name:'/web',usage:'[on|off]',description:'Runtime web tools / sandbox networking'},
  {name:'/upload',usage:'FILE_OR_FOLDER ...',description:'Queue bounded text/images for the next prompt'},
  {name:'/attachments',usage:'[clear]',description:'List or remove queued files'},
  {name:'/handoff',usage:'[DIRECTORY]',description:'Export the whole user/AI chat as Markdown and JSON'},
  {name:'/history',usage:'[clear]',description:'Visible chat history kept in this session'},
  {name:'/chat',usage:'[list|open ID|new|save|rename TITLE|delete ID]',description:'Saved project chats; last chat resumes automatically'},
  {name:'/new',usage:'',description:'New chat; choose whether to keep the current saved chat'},
  {name:'/scroll',usage:'[up|down|top|bottom]',description:'Browse the full chat; PageUp/PageDown and mouse wheel also work'},
  {name:'/personalize',usage:'[status|setup|set FIELD VALUE|unset FIELD|on|off|clear]',description:'Saved persona and preferences for this AI only'},
  {name:'/preferences',usage:'[status|setup|set FIELD VALUE|unset FIELD|on|off|clear]',description:'Per-AI language, tone, length, format and instructions'},
  {name:'/247',usage:'[setup|start|detach|stop|status|add TASK|list|result ID|retry ID]',description:'Always-on local coordinator and durable task inbox'},
  {name:'/compact',usage:'',description:'Run native context compaction; keep full export history'},
  {name:'/clear',usage:'',description:'Fresh engine context; keep session export history'},
  {name:'/mcp',usage:'[list|tools|add NAME URL|remove NAME]',description:'Connect HTTP tool servers at runtime'},
  {name:'/computer-use',usage:'[status|on|off|setup NAME URL]',description:'Inspect/use your computer-tool MCP server'},
  {name:'/skills',usage:'[list|load NAME|clear]',description:'Discover skills and attach one to the next task'},
  {name:'/ide',usage:'[code|cursor]',description:'Open this project in an installed editor'},
  {name:'/microphone',usage:'[on|off|devices|device NAME]',description:'List audio devices or arm explicit microphone recording'},
  {name:'/voice',usage:'[setup|speech|live|pause|resume|wake PHRASE|echo headphones|speaker|repeat|status|off]',description:'Continuous conversation and spoken replies'},
  {name:'/live',usage:'',description:'Start configured continuous live voice mode'},
  {name:'/training',usage:'[export|setup|start FILE|status ID|cancel ID]',description:'Export chat dataset or use a compatible fine-tuning service'},
  {name:'/review',usage:'[FOCUS]',description:'Ask the model to review the workspace changes'},
  {name:'/diff',usage:'',description:'Show local Git diff without calling a model'},
  {name:'/doctor',usage:'',description:'Native engine and optional-service diagnostics'},
  {name:'/stop',usage:'',description:'Interrupt current model work; retain queued prompts'},
  {name:'/steer',usage:'MESSAGE',description:'Send guidance to the active turn while it is working'},
  {name:'/quit',usage:'',description:'Save worked totals and restore the terminal'},
  {name:'/test-connection',usage:'',description:'Bounded model catalog probe; no generation charge'},
  {name:'/capabilities',usage:'[declare FEATURE on|off]',description:'Observed, declared and unknown model support'},
  {name:'/context',usage:'[capacity TOKENS|review|status]',description:'Preflight capacity and reviewed long-chat replay'},
  {name:'/route',usage:'[off|local|cheap|manual NAME|price INPUT OUTPUT]',description:'Optional model routing with manual override and rates per million tokens'},
  {name:'/checks',usage:'[add COMMAND|clear|list]',description:'Explicit project acceptance checks'},
  {name:'/verify',usage:'[COMMAND]',description:'Run acceptance checks and report factual results'},
  {name:'/changes',usage:'[CHECKPOINT_ID]',description:'Current project changes or a saved checkpoint'},
  {name:'/undo',usage:'[CHECKPOINT_ID]',description:'Restore recorded AI edits while preserving later user edits'},
  {name:'/workflow',usage:'[plan|edit|test|review]',description:'Guided coding workflow'},
  {name:'/team',usage:'TASK',description:'Bounded independent planner and reviewer in isolated snapshots'},
  {name:'/agents',usage:'[list|add|edit|run|team|pipeline|status|stop|results|result|follow|diff|apply]',description:'Saved specialists, parallel teams, isolated coding and reviewed proposals'},
  {name:'/security',usage:'[scan|lab PATH|review PATH]',description:'Defensive local scans and an explicitly approved isolated source lab'},
  {name:'/budget',usage:'[setup|status|reset-day|off]',description:'Task and daily money, token, request and duration limits'},
  {name:'/gpu',usage:'[setup|status|wake|sleep]',description:'GPU hooks with actual provider state verification'},
  {name:'/schedule',usage:'[add|list|remove ID|pause ID|resume ID]',description:'Persistent scheduled work; idempotent task enqueue'},
  {name:'/startup',usage:'[setup|plan|install|remove]',description:'Explicit OS background service with protected credential loading'},
  {name:'/credentials',usage:'[status|help|backend|list|save|forget]',description:'Optional OS-protected keys; memory-only remains the default'},
  {name:'/memory',usage:'[show|edit|on|off|clear]',description:'Only user-approved project rules, decisions and preferences'},
  {name:'/readability',usage:'[on|off]',description:'Short answers, spaced actions and clearer reading'},
  {name:'/details',usage:'',description:'Ask for details about the last AI answer'},
  {name:'/prompt',usage:'',description:'Multi-line prompt; finish with /end'},
  {name:'/search-chat',usage:'TEXT',description:'Literal search of the complete saved conversation'},
  {name:'/search',usage:'QUERY',description:'Guided source-linked search through supported web/MCP tools'},
  {name:'/browser',usage:'[start|stop|status|executable PATH]',description:'Dedicated scoped Chromium browser MCP adapter'},
  {name:'/bgcolor',usage:'[COLOR|reset|status]',description:'Saved chat background; keep the upper dashboard palette'},
  {name:'/textcolor',usage:'[COLOR|reset|status]',description:'Saved user text color with automatic readable contrast'},
  {name:'/notify',usage:'[on|off|status|test approval|error|done|interrupted]',description:'Distinct non-speaking sounds for AI approval, errors, completion and stops'},
  {name:'/reset',usage:'[TARGET|list|all]',description:'Choose settings to restore; keep saved chats and AI profiles'},
  {name:'/loopguard',usage:'[status|on|off|timeout SECONDS|repeats COUNT]',description:'Stop repeated tool actions and bound native terminal command lifetimes'},
  {name:'/update',usage:'[check|repo OWNER/REPO|on|off|stage PACKAGE_OR_URL SHA256|install|rollback|status]',description:'GitHub launch check, confirmed verified updates and rollback'},
];
const groups={
  'Chat':['/help','/chat','/new','/scroll','/history','/handoff','/prompt','/search-chat','/compact','/clear','/readability','/details','/quit'],
  'AI':['/switch','/model','/connect','/local','/test-connection','/capabilities','/context','/effort','/personalize','/preferences','/memory','/route','/credentials'],
  'Work':['/upload','/attachments','/checks','/verify','/changes','/undo','/workflow','/team','/agents','/review','/diff','/security','/stop','/steer'],
  'Access':['/permissions','/web','/search','/browser','/computer-use','/mcp','/skills','/ide'],
  'Voice':['/voice','/microphone','/live'],
  'Background':['/247','/schedule','/startup','/budget','/gpu'],
  'Advanced':['/gui','/training','/update','/doctor','/status','/bgcolor','/textcolor','/notify','/reset','/loopguard'],
};
export function commandMenu(query='',{compact=false}={}) {
  if(compact&&!query)return ['Common commands:','/local   Local AI      /switch Saved AIs','/agents  Specialists   /chat   Saved chats','/prompt  Multi-line    /voice  Voice mode','/changes Review edits /verify Check work','/undo    Undo edits    /247    Background work','/permissions          /budget Spending limits','','Browse: /help chat | ai | work | access | voice | background | advanced','Find a command: /help SEARCH'].join('\n');
  const lower=query.toLowerCase();return Object.entries(groups).map(([group,names])=>{const items=COMMANDS.filter(command=>names.includes(command.name)&&(!lower||group.toLowerCase()===lower||(command.name+' '+command.description).toLowerCase().includes(lower)));return items.length?group+'\n\n'+items.map(command=>`${command.name}${command.usage ? ' '+command.usage : ''}\n    ${command.description}`).join('\n\n'):'';}).filter(Boolean).join('\n\n');
}
export function completeCommand(line) {
  const names = COMMANDS.map(command => command.name);
  return [names.filter(name => name.startsWith(line)), line];
}
/** Quotes group paths; backslashes are literal so Windows paths remain intact. */
export function parseCommand(line) {
  if (!line.startsWith('/')) return null;
  if (line.trim() === '/') return {name:'/help',args:[],rawArgs:''};
  const separator = line.search(/\s/);
  const typedName = separator < 0 ? line.toLowerCase() : line.slice(0,separator).toLowerCase();
  const name = typedName==='/txtcolor'?'/textcolor':typedName;
  const rawArgs = separator < 0 ? '' : line.slice(separator).trim();
  const args = []; let token = '', quote = null, present = false;
  for (const character of rawArgs) {
    if (quote) { if (character === quote) quote = null; else token += character; present = true; }
    else if (character === '"' || character === "'") { quote = character; present = true; }
    else if (/\s/.test(character)) { if (present) { args.push(token); token = ''; present = false; } }
    else { token += character; present = true; }
  }
  if (quote) throw new Error('Close the quoted argument.');
  if (present) args.push(token);
  return {name,args,rawArgs};
}
export function parseMcpEntry(value) {
  const match = /^([A-Za-z][A-Za-z0-9_-]*)=(https?:\/\/.+)$/.exec(value);
  if (!match) throw new Error('Use a simple MCP name and HTTP URL: NAME=URL.');
  const url = new URL(match[2]);
  if (url.username || url.password || url.hash || url.search || /[\u0000-\u001f\u007f]/.test(value)) throw new Error('MCP URLs cannot contain credentials, queries, fragments or control characters.');
  return {name:match[1],url:url.href};
}
