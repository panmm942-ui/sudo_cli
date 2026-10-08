import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile, rm, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createServer } from 'node:http';
import { once } from 'node:events';

const connection = { model: 'reviewer-fixture', transport: 'chat-completions', baseUrl: 'http://127.0.0.1:1/v1' };
const engineFixture = fileURLToPath(new URL('./fixtures/engine-server.mjs', import.meta.url));
async function fixture(t, scenario = 'normal') {
  const root = await mkdtemp(join(tmpdir(), 'codexcli-workflow-test-')); const cwd = join(root, 'project'); const homes = join(root, 'homes'); await mkdir(cwd); await mkdir(homes);
  t.after(() => rm(root, { recursive: true, force: true }));
  const { createWorkflow } = await import('../src/workflow.mjs');
  return { cwd, homes, workflow: createWorkflow({ cwd, connectionProvider: () => connection, snapshotBaseDir: join(root, 'copies') }), runtime: { codexPath: [process.execPath, engineFixture], baseDir: homes, env: { ...process.env, ENGINE_SCENARIO: scenario }, requestTimeoutMs: 1000 } };
}
test('workflow selects bounded plan/edit/test/review guidance and rejects unknown modes', async t => {
  const { workflow } = await fixture(t);
  assert.equal(workflow.snapshot().mode, 'edit');
  workflow.setMode('plan'); assert.match(workflow.promptInstructions(), /plan/i); assert.match(workflow.promptInstructions(), /do not (change|edit)/i);
  workflow.setMode('test'); assert.match(workflow.promptInstructions(), /explicit/i);
  workflow.setMode('review'); assert.match(workflow.promptInstructions(), /review/i);
  assert.throws(() => workflow.setMode('unknown'), /mode/i);
});
test('independent reviewer uses a new native task on a disposable source snapshot', async t => {
  const { cwd, homes, workflow, runtime } = await fixture(t);
  await writeFile(join(cwd, 'code.mjs'), 'export const answer=42;');
  const result = await workflow.runReviewer({ focus: 'Find concrete regressions', runtime, settings: { permissions: 'allow-everything', webAccess: true, mcp: { arbitrary: 'https://tools.example.test/mcp' } } });
  assert.equal(result.advisory, true); assert.equal(result.verified, false);
  const audit = JSON.parse(result.text);
  assert.notEqual(audit.thread.cwd, cwd); assert.equal(audit.thread.ephemeral, true); assert.equal(audit.thread.approvalPolicy, 'on-request');
  assert.equal(audit.thread.sandbox, 'read-only');
  assert.equal(audit.thread.config['sandbox_workspace_write.network_access'], false); assert.ok(!audit.argv.some(value => value.startsWith('mcp_servers.')));
  assert.equal(await readFile(join(cwd, 'code.mjs'), 'utf8'), 'export const answer=42;'); assert.deepEqual(await readdir(homes), []);
});
test('reviewer refuses an out-of-scope native approval instead of claiming success', async t => {
  const { workflow, runtime,homes } = await fixture(t, 'approvals');
  await assert.rejects(workflow.runReviewer({runtime}),error=>error.code==='APPROVAL_REQUIRED');
  assert.deepEqual(await readdir(homes),[]);
});
test('bounded reviewer cancellation cleans source/native snapshots and team rejects excessive roles', async t => {
  const { workflow, runtime, homes } = await fixture(t, 'hang-turn');
  await assert.rejects(workflow.runReviewer({ runtime, timeoutMs: 80 }), /timeout|timed out/i);
  assert.deepEqual(await readdir(homes), []);
  await assert.rejects(workflow.runTeam({ task: 'task', roles: ['planner', 'reviewer', 'planner'] }), /roles/i);
});
test('team runs bounded sequential independent native planner/reviewer sessions', async t => {
  const { workflow, runtime } = await fixture(t);
  const result = await workflow.runTeam({ task: 'Inspect the change', runtime });
  assert.equal(result.advisory, true); assert.equal(result.verified, false); assert.deepEqual(result.results.map(item => item.role), ['planner', 'reviewer']);
  assert.notEqual(JSON.parse(result.results[0].text).thread.cwd, JSON.parse(result.results[1].text).thread.cwd);
});

test('workspace reviewer receives bounded actual checkpoint changes without original paths or credentials', async t => {
  const { cwd, runtime } = await fixture(t);
  const { createWorkspaceTools } = await import('../src/workspace-tools.mjs');
  const { createWorkflow } = await import('../src/workflow.mjs');
  const workspace = await createWorkspaceTools({ cwd, stateDir: join(cwd, 'state') });
  await writeFile(join(cwd, 'code.mjs'), 'before-marker'); const { id } = await workspace.beginCheckpoint(); await writeFile(join(cwd, 'code.mjs'), 'after-marker'); await workspace.completeCheckpoint(id);
  const workflow = createWorkflow({ workspace, connectionProvider: () => connection });
  const result = await workflow.runReviewer({ runtime, checkpointId: id }); const audit = JSON.parse(result.text);
  assert.ok(JSON.stringify(audit.params.input).includes('before-marker')); assert.ok(JSON.stringify(audit.params.input).includes('after-marker'));
  assert.ok(!JSON.stringify(audit.params.input).includes(cwd));
});

test('a selected reviewer source path does not widen to unrelated workspace files', async t => {
  const { cwd, runtime } = await fixture(t); const { createWorkflow } = await import('../src/workflow.mjs');
  await mkdir(join(cwd, 'src')); await writeFile(join(cwd, 'src', 'target.js'), 'const target=1;'); await writeFile(join(cwd, 'unrelated.js'), 'const unrelated=2;');
  const workflow = createWorkflow({ cwd, connectionProvider: () => connection });
  const result = await workflow.runReviewer({ path: 'src', runtime }); assert.equal(result.files, 1);
});

test('native reviewer requests obey runtimeProvider accounting hooks before contacting its model endpoint', { timeout: 45000 }, async t => {
  const { cwd, homes } = await fixture(t); const { createWorkflow } = await import('../src/workflow.mjs'); const { localCodex } = await import('../src/local-engine.mjs');
  let codexPath; try { codexPath = localCodex(); } catch { t.skip('Install the native Codex runtime'); return; }
  let requests = 0;
  const server = createServer((req, res) => { requests++; req.resume(); res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify({ id: 'chatcmpl-reviewer', object: 'chat.completion', model: connection.model, choices: [{ index: 0, message: { role: 'assistant', content: 'Native reviewer advisory.' }, finish_reason: 'stop' }] })); });
  server.listen(0, '127.0.0.1'); await once(server, 'listening'); t.after(async () => { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); });
  const workflow = createWorkflow({ cwd, connectionProvider: () => ({ ...connection, baseUrl: `http://127.0.0.1:${server.address().port}/v1` }),
    runtimeProvider: () => ({ requestHooks: { beforeRequest: async () => { throw new Error('Budget sentinel refuses reviewer'); } } }) });
  await assert.rejects(workflow.runReviewer({ timeoutMs: 30000, runtime: { codexPath, baseDir: homes, requestTimeoutMs: 10000 } }), /Budget sentinel/);
  assert.equal(requests, 0); assert.deepEqual(await readdir(homes), []);
});
