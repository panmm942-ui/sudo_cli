export const COMMANDS = [
  {name:'/help',usage:'',description:'All commands; / also opens this menu'},
  {name:'/status',usage:'',description:'Session, model, WiFi, context and timers'},
  {name:'/switch',usage:'[NAME|add|local|save NAME|remove NAME]',description:'Saved cloud/local AIs; transfer full chat on switch'},
  {name:'/model',usage:'[ID|list]',description:'Current model or endpoint model list'},
  {name:'/connect',usage:'',description:'New endpoint, model and hidden key'},
  {name:'/effort',usage:'[default|LEVEL|supported LEVELS]',description:'Reasoning request and declared model capabilities'},
  {name:'/permissions',usage:'[ask|allow-everything]',description:'Runtime agent execution permissions'},
  {name:'/web',usage:'[on|off]',description:'Runtime web tools / sandbox networking'},
  {name:'/upload',usage:'FILE_OR_FOLDER ...',description:'Queue bounded text/images for the next prompt'},
  {name:'/attachments',usage:'[clear]',description:'List or remove queued files'},
  {name:'/handoff',usage:'[DIRECTORY]',description:'Export the whole user/AI chat as Markdown and JSON'},
  {name:'/history',usage:'[clear]',description:'Visible chat history kept in this session'},
  {name:'/compact',usage:'',description:'Run native context compaction; keep full export history'},
  {name:'/clear',usage:'',description:'Fresh engine context; keep session export history'},
  {name:'/mcp',usage:'[list|tools|add NAME URL|remove NAME]',description:'Connect HTTP tool servers at runtime'},
  {name:'/computer-use',usage:'[status|on|off|setup NAME URL]',description:'Inspect/use your computer-tool MCP server'},
  {name:'/skills',usage:'[list|load NAME|clear]',description:'Discover skills and attach one to the next task'},
  {name:'/ide',usage:'[code|cursor]',description:'Open this project in an installed editor'},
  {name:'/microphone',usage:'[on|off|device NAME]',description:'Arm/disable explicit microphone recording'},
  {name:'/voice',usage:'[setup|status|record SECONDS|file PATH|off]',description:'Transcribe audio, review text and send a prompt'},
  {name:'/training',usage:'[export|setup|start FILE|status ID|cancel ID]',description:'Export chat dataset or use a compatible fine-tuning service'},
  {name:'/review',usage:'[FOCUS]',description:'Ask the model to review the workspace changes'},
  {name:'/diff',usage:'',description:'Show local Git diff without calling a model'},
  {name:'/doctor',usage:'',description:'Native engine and optional-service diagnostics'},
  {name:'/stop',usage:'',description:'Interrupt current model work; retain queued prompts'},
  {name:'/steer',usage:'MESSAGE',description:'Send guidance to the active turn while it is working'},
  {name:'/quit',usage:'',description:'Save worked totals and restore the terminal'},
];
export function commandMenu() {
  return COMMANDS.map(command => `${command.name}${command.usage ? ' '+command.usage : ''}\n    ${command.description}`).join('\n');
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
  const name = separator < 0 ? line.toLowerCase() : line.slice(0,separator).toLowerCase();
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
