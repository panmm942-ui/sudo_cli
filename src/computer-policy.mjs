const computerNames = /browser|desktop|computer|screenshot|mouse|keyboard|click|navigate/i;

export function isComputerTool(tool) {
  return computerNames.test(`${tool.serverName}/${tool.tool?.name || tool.name}`);
}

/** Raw MCP names, rather than flattened catalog keys, are used by the engine. */
export function computerToolFilters(tools, serverNames) {
  const configured=new Set(serverNames),filters=new Map();
  for (const tool of tools) {
    const name = tool.tool?.name || tool.name;
    if(typeof name!=='string' || !configured.has(tool.serverName))continue;
    if(!filters.has(tool.serverName))filters.set(tool.serverName,[]);
    if(isComputerTool(tool))filters.get(tool.serverName).push(name);
  }
  return new Map([...filters].map(([name, values]) => [name, [...new Set(values)]]));
}

/** Unknown/new servers stay disabled until inspected with computer tools On. */
export function enabledMcpEntries(settings) {
  if (!settings.webAccess) return [];
  return [...settings.mcp].filter(([name]) => settings.computerUse !== false ||
    (!settings.computerServers?.has(name) && settings.disabledComputerTools?.has(name)));
}
