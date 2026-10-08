import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile, rm, readdir, unlink } from 'node:fs/promises';
import { tmpdir } from './fixtures/temp-root.mjs';
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

test('named agents run bounded parallel independent source sessions with role settings and preferences', async t => {
  const { cwd } = await fixture(t); const { createWorkflow } = await import('../src/workflow.mjs');
  await writeFile(join(cwd, 'code.mjs'), 'original source');
  const paths = [], accounts = []; let running = 0, peak = 0;
  const workflow = createWorkflow({ cwd, connectionProvider: () => connection,
    settingsProvider: () => ({ permissions: 'allow-everything', scope: 'full', writableRoots: [cwd], webAccess: true, computerUse: true }),
    runtimeProvider: ({ role, name, connection: selected }) => { accounts.push({ role, name, model: selected.model }); return {}; },
    runTask: async options => {
      paths.push(options.cwd); running++; peak = Math.max(peak, running);
      assert.equal(options.settings.scope, 'read-only'); assert.equal(options.settings.webAccess, false);
      assert.equal(options.settings.computerUse, false); assert.deepEqual(options.settings.writableRoots, []);
      assert.equal(options.onApproval({}), false);
      assert.match(options.developerInstructions, /never permission grants/i);
      assert.match(options.developerInstructions, /Short sentences/);
      await new Promise(resolve => setTimeout(resolve, 35)); running--;
      return { text: options.connection.model, threadId: `thread-${paths.indexOf(options.cwd)}` };
    } });
  assert.equal(typeof workflow.runAgents, 'function');
  const result = await workflow.runAgents({ task: 'Inspect source', concurrency: 2, agents: [
    { name: 'first', role: 'planner', instructions: 'Short sentences', developerInstructions: 'Preference: plain language', connection: { ...connection, model: 'local-first' } },
    { name: 'second', role: 'tester', instructions: 'Short sentences', connection: { ...connection, model: 'cloud-second' } },
    { name: 'third', role: 'security', instructions: 'Short sentences' },
  ] });
  assert.equal(peak, 2); assert.equal(new Set(paths).size, 3);
  assert.equal(result.advisory, true); assert.equal(result.verified, false);
  assert.deepEqual(result.results.map(item => [item.name, item.status, item.text]), [['first', 'completed', 'local-first'], ['second', 'completed', 'cloud-second'], ['third', 'completed', 'reviewer-fixture']]);
  assert.deepEqual(accounts.map(item => item.name), ['first', 'second', 'third']);
  assert.equal(await readFile(join(cwd, 'code.mjs'), 'utf8'), 'original source');
  for (const path of paths) await assert.rejects(readFile(join(path, 'code.mjs')), error => error.code === 'ENOENT');
});

test('named agents retain individual failures and redact each selected model credential', async t => {
  const { cwd } = await fixture(t); const { createWorkflow } = await import('../src/workflow.mjs');
  const secret = 'agent-profile-credential-fixture';
  const workflow = createWorkflow({ cwd, connectionProvider: () => connection, runTask: async options => {
    if (options.connection.model === 'broken') throw new Error(`Provider failed ${secret}`);
    return { text: 'Useful advisory', threadId: 'ok-thread' };
  } });
  const result = await workflow.runAgents({ task: 'Review', agents: [{ name: 'broken', role: 'reviewer', connection: { ...connection, model: 'broken', apiKey: secret } }, { name: 'healthy', role: 'planner' }] });
  assert.equal(result.status, 'partial');
  assert.deepEqual(result.results.map(item => item.status), ['failed', 'completed']);
  assert.ok(!JSON.stringify(result).includes(secret)); assert.equal(result.results[0].verified, false);
  await assert.rejects(workflow.runAgents({ task: 'x', concurrency: 4, agents: [{ name: 'a', role: 'tester' }] }), /concurrency/i);
  await assert.rejects(workflow.runAgents({ task: 'x', agents: [{ name: 'a', role: 'tester' }, { name: 'a', role: 'planner' }] }), /distinct|duplicate/i);
});

test('cancelling named agents cleans active snapshots, cancels queued roles and releases the workflow guard', async t => {
  const { cwd } = await fixture(t); const { createWorkflow } = await import('../src/workflow.mjs');
  const controller = new AbortController(); const paths = []; let releaseStarted;
  const started = new Promise(resolve => { releaseStarted = resolve; });
  const workflow = createWorkflow({ cwd, connectionProvider: () => connection, runTask: async ({ cwd: path, signal }) => {
    paths.push(path); releaseStarted();
    await new Promise((resolve, reject) => signal.addEventListener('abort', () => reject(new DOMException('Cancelled', 'AbortError')), { once: true }));
    return { text: '', threadId: 'unused' };
  } });
  const pending = workflow.runAgents({ task: 'Inspect', concurrency: 1, signal: controller.signal, agents: [{ name: 'one', role: 'planner' }, { name: 'two', role: 'reviewer' }] });
  await started;
  await assert.rejects(workflow.runReviewer(), /already active/i);
  controller.abort(); const result = await pending;
  assert.equal(paths.length, 1); assert.equal(result.status, 'cancelled');
  assert.deepEqual(result.results.map(item => item.status), ['cancelled', 'cancelled']);
  assert.equal(workflow.snapshot().active, false);
  for (const path of paths) await assert.rejects(readFile(path), error => error.code === 'ENOENT');
});

test('a named edit agent proposes bounded copy changes without changing the original source', async t => {
  const { cwd } = await fixture(t); const { createWorkflow } = await import('../src/workflow.mjs');
  await writeFile(join(cwd, 'code.mjs'), 'export const answer=1;');
  const workflow = createWorkflow({ cwd, connectionProvider: () => connection, runTask: async options => {
    assert.equal(options.settings.scope, 'project'); assert.equal(options.settings.permissions, 'ask');
    assert.deepEqual(options.settings.writableRoots, []); assert.equal(options.settings.webAccess, false);
    assert.equal(options.onApproval({}), false);
    await writeFile(join(options.cwd, 'code.mjs'), 'export const answer=2;');
    return { text: 'Proposed correction. Checks still needed.', threadId: 'coder-thread' };
  } });
  const result = await workflow.runAgents({ task: 'Correct source', agents: [{ name: 'coder', role: 'coder', mode: 'edit' }] });
  assert.equal(result.status, 'completed'); assert.equal(result.verified, false);
  assert.equal(result.results[0].mode, 'edit'); assert.equal(result.results[0].changes.files.length, 1);
  assert.equal(result.results[0].changes.files[0].path, 'code.mjs');
  assert.equal(await readFile(join(cwd, 'code.mjs'), 'utf8'), 'export const answer=1;');
});

test('named pipeline reviewers inspect proposed copy edits and reject conflicts before native launch', async t => {
  const { cwd } = await fixture(t); const { createWorkflow } = await import('../src/workflow.mjs');
  await writeFile(join(cwd, 'code.mjs'), 'original'); let reviewed = '', calls = 0;
  const workflow = createWorkflow({ cwd, connectionProvider: () => connection, runTask: async options => {
    calls++;
    if (options.settings.scope === 'project') await writeFile(join(options.cwd, 'code.mjs'), 'proposed');
    else reviewed = await readFile(join(options.cwd, 'code.mjs'), 'utf8');
    return { text: 'Advisory result', threadId: `role-${calls}` };
  } });
  const coder = await workflow.runAgents({ task: 'Fix', agents: [{ name: 'coder', role: 'coder', mode: 'edit' }] });
  const result = await workflow.runAgents({ task: 'Review proposed correction', agents: [{ name: 'reviewer', role: 'reviewer', inputChanges: coder.results[0].changes }] });
  assert.equal(result.status, 'completed'); assert.equal(reviewed, 'proposed');
  await writeFile(join(cwd, 'code.mjs'), 'human edit');
  const conflict = await workflow.runAgents({ task: 'Review stale proposed correction', agents: [{ name: 'reviewer', role: 'reviewer', inputChanges: coder.results[0].changes }] });
  assert.equal(conflict.status, 'failed'); assert.match(conflict.results[0].error, /conflict|partial/i); assert.equal(calls, 2);
  assert.equal(await readFile(join(cwd, 'code.mjs'), 'utf8'), 'human edit');
});

test('individual agent cancellation leaves another role running and ends each accounting task', async t => {
  const { cwd } = await fixture(t); const { createWorkflow } = await import('../src/workflow.mjs');
  const ends = [], statuses = []; let bothStarted, starts = 0;
  const started = new Promise(resolve => { bothStarted = resolve; });
  let finishHealthy;
  const healthy = new Promise(resolve => { finishHealthy = resolve; });
  const workflow = createWorkflow({ cwd, connectionProvider: () => connection,
    runtimeProvider: ({ name }) => ({ onTaskEnd: result => { ends.push({ name, status: result.status }); } }),
    runTask: async ({ signal, developerInstructions }) => {
      if (++starts === 2) bothStarted();
      if (developerInstructions.includes('Cancel this role')) await new Promise((resolve, reject) => signal.addEventListener('abort', () => reject(new DOMException('Cancelled', 'AbortError')), { once: true }));
      else await healthy;
      return { text: 'Still useful', threadId: 'healthy-thread' };
    } });
  const pending = workflow.runAgents({ task: 'Review', concurrency: 2, onStatus: status => statuses.push(status), agents: [{ name: 'cancel-me', role: 'reviewer', instructions: 'Cancel this role' }, { name: 'healthy', role: 'tester' }] });
  await started;
  assert.equal(workflow.snapshot().activeAgents.length, 2);
  assert.equal(workflow.cancelAgent('unknown'), false); assert.equal(workflow.cancelAgent('cancel-me'), true);
  finishHealthy(); const result = await pending;
  assert.deepEqual(result.results.map(item => item.status), ['cancelled', 'completed']);
  assert.equal(result.status, 'partial'); assert.deepEqual(new Set(ends.map(item => item.name)), new Set(['cancel-me', 'healthy']));
  assert.ok(statuses.some(item => item.name === 'cancel-me' && item.status === 'cancelled'));
  assert.equal(workflow.snapshot().activeAgents.length, 0);
});

test('partial copy coverage still lets pipeline specialists review safe proposed files and follow edits compare to the original', async t => {
  const { cwd } = await fixture(t); const { createWorkflow } = await import('../src/workflow.mjs');
  await writeFile(join(cwd, 'code.mjs'), 'original'); await writeFile(join(cwd, 'binary.bin'), Buffer.from([0, 1, 2]));
  let observed;
  const workflow = createWorkflow({ cwd, connectionProvider: () => connection, runTask: async options => {
    if (options.settings.scope === 'project') {
      const before = await readFile(join(options.cwd, 'code.mjs'), 'utf8');
      await writeFile(join(options.cwd, 'code.mjs'), before === 'original' ? 'first proposal' : 'final proposal');
    } else observed = await readFile(join(options.cwd, 'code.mjs'), 'utf8');
    return { text: 'Source coverage is partial.', threadId: 'partial-role' };
  } });
  const first = await workflow.runAgents({ task: 'First correction', agents: [{ name: 'coder', role: 'coder', mode: 'edit' }] });
  assert.equal(first.results[0].changes.partial, true);
  const reviewed = await workflow.runAgents({ task: 'Review', agents: [{ name: 'reviewer', role: 'reviewer', inputChanges: first.results[0].changes }] });
  assert.equal(reviewed.status, 'completed'); assert.equal(reviewed.results[0].partial, true); assert.equal(observed, 'first proposal');
  const follow = await workflow.runAgents({ task: 'Improve the proposal', agents: [{ name: 'coder', role: 'coder', mode: 'edit', inputChanges: first.results[0].changes }] });
  assert.equal(follow.status, 'completed');
  const file = follow.results[0].changes.files.find(item => item.path === 'code.mjs');
  assert.equal(Buffer.from(file.beforeContent, 'base64').toString(), 'original');
  assert.equal(Buffer.from(file.content, 'base64').toString(), 'final proposal');
  assert.equal(await readFile(join(cwd, 'code.mjs'), 'utf8'), 'original');
});

test('steering a running named agent sends bounded guidance only to that agent and is unavailable after cleanup', { timeout: 3000 }, async t => {
  const { cwd } = await fixture(t); const { createWorkflow } = await import('../src/workflow.mjs');
  let controlReady, finish; const messages = [];
  const ready = new Promise(resolve => { controlReady = resolve; });
  const done = new Promise(resolve => { finish = resolve; });
  const workflow = createWorkflow({ cwd, connectionProvider: () => connection, runTask: async ({ onControl }) => {
    onControl({ steer: async text => { messages.push(text); } }); controlReady();
    await done; onControl(undefined);
    return { text: 'Advisory outcome', threadId: 'steered-role' };
  } });
  assert.equal(typeof workflow.steerAgent, 'function');
  const pending = workflow.runAgents({ task: 'Review', agents: [{ name: 'reviewer', role: 'reviewer' }] });
  await ready;
  assert.equal(await workflow.steerAgent('unknown', 'Other guidance'), false);
  await assert.rejects(workflow.steerAgent('reviewer', 'x'.repeat(8193)), /bounded/i);
  assert.equal(await workflow.steerAgent('reviewer', 'Focus on the parser'), true);
  assert.deepEqual(messages, ['Focus on the parser']); finish(); await pending;
  assert.equal(await workflow.steerAgent('reviewer', 'Late guidance'), false);
});

test('refused copy cleanup preserves captured proposed edits and reports the copy needing inspection', async t => {
  const { cwd, homes } = await fixture(t); const { createWorkflow } = await import('../src/workflow.mjs');
  await writeFile(join(cwd, 'code.mjs'), 'before'); let copy;
  const workflow = createWorkflow({ cwd, snapshotBaseDir: join(homes, 'copies'), connectionProvider: () => connection, runTask: async options => {
    copy = options.cwd; await writeFile(join(copy, 'code.mjs'), 'after'); await unlink(join(copy, '.snapshot-owner'));
    return { text: 'Proposed edit', threadId: 'ownership-change' };
  } });
  const result = await workflow.runAgents({ task: 'Propose edit', agents: [{ name: 'coder', role: 'coder', mode: 'edit' }] });
  assert.equal(result.results[0].changes.files[0].path, 'code.mjs');
  assert.equal(result.results[0].partial, true); assert.match(result.results[0].error, /cleanup|ownership/i);
  assert.equal(await readFile(join(copy, 'code.mjs'), 'utf8'), 'after');
  assert.equal(await readFile(join(cwd, 'code.mjs'), 'utf8'), 'before');
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
