import test from 'node:test';
import assert from 'node:assert/strict';

test('slash registry includes requested features and one discoverable command menu', async () => {
  const { COMMANDS, commandMenu, completeCommand } = await import('../src/commands.mjs');
  for (const name of ['/switch','/handoff','/web','/upload','/permissions','/effort','/ide','/voice','/microphone','/mcp','/compact','/skills','/training','/computer-use']) assert.ok(COMMANDS.some(command => command.name === name), name);
  const menu = commandMenu();
  assert.ok(menu.includes('/switch') && menu.includes('/training'));
  assert.ok(completeCommand('/sw')[0].includes('/switch'));
});

test('quoted file paths preserve Windows slashes, escaped spaces and user text', async () => {
  const { parseCommand } = await import('../src/commands.mjs');
  assert.deepEqual(parseCommand('/upload "C:\\My Project\\a.txt" "folder name"').args, ['C:\\My Project\\a.txt','folder name']);
  assert.deepEqual(parseCommand('/switch "Local coding AI"').args, ['Local coding AI']);
  assert.throws(() => parseCommand('/upload "broken'), /quote/i);
  assert.equal(parseCommand('normal task'), null);
});

test('MCP configuration rejects unsafe or duplicate server names and credentials', async () => {
  const { parseMcpEntry } = await import('../src/commands.mjs');
  assert.deepEqual(parseMcpEntry('browser=http://localhost:8931/mcp'), { name:'browser',url:'http://localhost:8931/mcp' });
  for (const value of ['a.b=http://localhost','bad=file:///tmp/mcp','a=https://key@example.com/mcp','a=http://localhost/mcp#secret','a=http://localhost/mcp?api_key=secret']) assert.throws(() => parseMcpEntry(value));
});
