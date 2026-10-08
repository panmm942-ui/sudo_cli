import { createInterface } from 'node:readline';

// Harmless protocol fixture: listing names never controls an actual computer.
if (!process.argv.includes('--serve-mcp')) process.exit(0);
const tools = [
  { name: 'browser_click', description: 'Fixture computer tool', inputSchema: { type: 'object', properties: {} } },
  { name: 'add_numbers', description: 'Fixture arithmetic tool', inputSchema: { type: 'object', properties: { a: { type: 'number' }, b: { type: 'number' } } } },
];
const input = createInterface({ input: process.stdin });
input.on('line', line => {
  const message = JSON.parse(line);
  if (message.id === undefined) return;
  let result;
  if (message.method === 'initialize') result = { protocolVersion: message.params.protocolVersion, capabilities: { tools: {} }, serverInfo: { name: 'codexcli-fixture', version: '1' } };
  else if (message.method === 'tools/list') result = { tools };
  else if (message.method === 'tools/call') result = { content: [{ type: 'text', text: String((message.params.arguments?.a ?? 0) + (message.params.arguments?.b ?? 0)) }] };
  else if (message.method === 'resources/list') result = { resources: [] };
  else if (message.method === 'resources/templates/list') result = { resourceTemplates: [] };
  else if (message.method === 'ping') result = {};
  if (result !== undefined) process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: message.id, result }) + '\n');
  else process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: message.id, error: { code: -32601, message: 'Unsupported fixture method.' } }) + '\n');
});
input.on('close', () => process.exit(0));
