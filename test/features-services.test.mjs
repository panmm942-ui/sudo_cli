import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir, realpath, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from './fixtures/temp-root.mjs';
import { join } from 'node:path';
import { createChatHistory } from '../src/chat-history.mjs';
import { createModelProfiles } from '../src/model-profiles.mjs';
import { createFeatureCommands } from '../src/features.mjs';
import {configureConnection} from '../src/wizard.mjs';

async function router(t, answers = []) {
  const cwd = await realpath(await mkdtemp(join(tmpdir(), 'codexcli-command-services-')));
  t.after(() => rm(cwd, { recursive: true, force: true }));
  const profiles = await createModelProfiles({ stateDir: join(cwd, 'state') });
  const knownSecrets = new Set();
  const history = createChatHistory({ secrets: () => [...knownSecrets] });
  const settings = { permissions: 'ask', webAccess: false };
  const notes = [], asks = [], turns = [], reconnects = [];
  let connection = { model: 'initial', baseUrl: 'http://localhost:8000/v1', transport: 'chat-completions' };
  const features = createFeatureCommands({
    cwd, settings, profiles, history,
    note: value => notes.push(String(value)),
    ask: async (question, hidden = false) => {
      asks.push({ question, hidden });
      assert.ok(answers.length, `Unexpected prompt: ${question}`);
      return answers.shift();
    },
    getConnection: () => connection,
    getEngine: () => ({}),
    reconnect: async (selected, options) => { connection = selected; reconnects.push({ selected, options }); },
    configure: async (refresh,{forceLocal}={}) => {
      assert.equal(forceLocal,true,'Cloud setup is outside this fixture.');
      return configureConnection({refresh,forceLocal,interactive:true,env:{},report:value=>notes.push(value),ask:async(question,hidden=false)=>{asks.push({question,hidden});assert.ok(answers.length,`Unexpected prompt: ${question}`);return answers.shift();}});
    },
    runTurn: async text => { turns.push(text); history.addUser(text, { model: connection.model }); },
    runCompact: async () => {}, getSnapshot: () => ({}),
    rememberSecret: value => knownSecrets.add(value), stop: () => {},
  });
  return { cwd, settings, profiles, history, notes, asks, turns, reconnects, features, knownSecrets };
}

async function endpoint(t, handler) {
  const server = createServer((request, response) => {
    Promise.resolve(handler(request, response)).catch(error => { response.destroy(error); });
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => { server.closeAllConnections(); server.close(resolve); }));
  return `http://127.0.0.1:${server.address().port}/v1`;
}
async function body(request) {
  const chunks = []; for await (const chunk of request) chunks.push(chunk);
  return Buffer.concat(chunks).toString('utf8');
}

test('voice file command uses the configured ASR endpoint and sends only after accepting the transcript', { timeout: 5000 }, async t => {
  const requests = [];
  const baseUrl = await endpoint(t, async (request, response) => {
    requests.push({ path: request.url, authorization: request.headers.authorization, body: await body(request) });
    response.end(JSON.stringify({ text: 'Please inspect this project.' }));
  });
  const f = await router(t, [baseUrl, 'speech-fixture', 'private-asr-fixture', 'yes']);
  const path = join(f.cwd, 'audio with spaces.wav'); await writeFile(path, 'synthetic audio bytes');
  await f.features.handle({ name: '/voice', args: ['setup'] });
  assert.equal(f.settings.voiceService.model, 'speech-fixture');
  assert.equal(f.asks[2].hidden, true);
  assert.equal(f.knownSecrets.has('private-asr-fixture'), true);
  await f.features.handle({ name: '/voice', args: ['file', path] });
  assert.deepEqual(f.turns, ['Please inspect this project.']);
  assert.equal(requests.length, 1);
  assert.equal(requests[0].path, '/v1/audio/transcriptions');
  assert.equal(requests[0].authorization, 'Bearer private-asr-fixture');
  assert.match(requests[0].body, /speech-fixture/);
  assert.match(requests[0].body, /audio with spaces\.wav/);
  assert.doesNotMatch(requests[0].body, /private-asr-fixture/);
  assert.ok(f.notes.some(note => note.includes('Transcript: Please inspect this project.')));
  assert.equal(f.settings.serviceController, undefined);
  assert.deepEqual(await f.profiles.list(), []);
});

test('declining a recognized transcript performs no model turn', { timeout: 5000 }, async t => {
  let calls = 0;
  const baseUrl = await endpoint(t, async (request, response) => { await body(request); calls++; response.end(JSON.stringify({ text: 'Recognized text.' })); });
  const f = await router(t, [baseUrl, 'speech-fixture', '', 'no']);
  await writeFile(join(f.cwd, 'sample.mp3'), 'synthetic audio');
  await f.features.handle({ name: '/voice', args: ['setup'] });
  await f.features.handle({ name: '/voice', args: ['file', 'sample.mp3'] });
  assert.equal(calls, 1);
  assert.deepEqual(f.turns, []);
  assert.equal(f.history.snapshot().messages.length, 0);
});

test('aborting a stalled voice service rejects promptly and clears its active controller', { timeout: 5000 }, async t => {
  let f;
  const baseUrl = await endpoint(t, async request => { await body(request); f.settings.serviceController.abort(); });
  f = await router(t, [baseUrl, 'speech-fixture', 'private-asr-fixture']);
  await writeFile(join(f.cwd, 'sample.wav'), 'synthetic audio');
  await f.features.handle({ name: '/voice', args: ['setup'] });
  await assert.rejects(f.features.handle({ name: '/voice', args: ['file', 'sample.wav'] }), error => /cancelled/.test(error.message) && !error.message.includes('private-asr-fixture'));
  assert.equal(f.settings.serviceController, undefined);
  assert.deepEqual(f.turns, []);
  assert.equal(f.asks.length, 3); // No send prompt after cancellation.
});

test('training commands upload, start, inspect and cancel the provider job with explicit confirmation', { timeout: 5000 }, async t => {
  const requests = [];
  const baseUrl = await endpoint(t, async (request, response) => {
    requests.push({ method: request.method, path: request.url, authorization: request.headers.authorization, body: await body(request) });
    response.end(JSON.stringify(request.url === '/v1/files' ? { id: 'file-dataset' } : {
      id: 'ftjob-dataset', status: request.url.endsWith('/cancel') ? 'cancelled' : request.method === 'GET' ? 'succeeded' : 'queued',
      ...(request.method === 'GET' ? { fine_tuned_model: 'trained-fixture' } : {}),
    }));
  });
  const f = await router(t, [baseUrl, 'tunable-fixture', 'private-training-fixture', 'yes', 'yes']);
  const path = join(f.cwd, 'reviewed dataset.jsonl');
  await writeFile(path, '{"messages":[{"role":"user","content":"Q"},{"role":"assistant","content":"A"}]}\n');
  await f.features.handle({ name: '/training', args: ['setup'] });
  await f.features.handle({ name: '/training', args: ['start', path] });
  await f.features.handle({ name: '/training', args: ['status', 'ftjob-dataset'] });
  await f.features.handle({ name: '/training', args: ['cancel', 'ftjob-dataset'] });
  assert.deepEqual(requests.map(({ method, path }) => ({ method, path })), [
    { method: 'POST', path: '/v1/files' }, { method: 'POST', path: '/v1/fine_tuning/jobs' },
    { method: 'GET', path: '/v1/fine_tuning/jobs/ftjob-dataset' },
    { method: 'POST', path: '/v1/fine_tuning/jobs/ftjob-dataset/cancel' },
  ]);
  assert.match(requests[0].body, /name="purpose"\r\n\r\nfine-tune/);
  assert.match(requests[0].body, /reviewed dataset\.jsonl/);
  assert.deepEqual(JSON.parse(requests[1].body), { training_file: 'file-dataset', model: 'tunable-fixture' });
  assert.deepEqual(JSON.parse(requests[3].body), {});
  assert.ok(requests.every(request => request.authorization === 'Bearer private-training-fixture' && !request.body.includes('private-training-fixture')));
  assert.ok(f.notes.some(note => note.includes('provider charges')));
  assert.ok(f.notes.some(note => note.includes('trained-fixture')));
  assert.ok(f.notes.some(note => note.includes('cancelled')));
  assert.equal(f.settings.serviceController, undefined);
});

test('declining training creation or cancellation makes no provider calls', { timeout: 5000 }, async t => {
  let requests = 0;
  const baseUrl = await endpoint(t, (request, response) => { requests++; response.end('{}'); });
  const f = await router(t, [baseUrl, 'tunable-fixture', '', 'no', 'no']);
  await f.features.handle({ name: '/training', args: ['setup'] });
  await f.features.handle({ name: '/training', args: ['start', join(f.cwd, 'nonexistent.jsonl')] });
  await f.features.handle({ name: '/training', args: ['cancel', 'ftjob-fixture'] });
  assert.equal(requests, 0);
  assert.ok(f.notes.some(note => note.includes('Training was not started')));
});

test('training export uses complete sanitized history and remains entirely local', { timeout: 5000 }, async t => {
  const f = await router(t);
  f.knownSecrets.add('private-export-fixture');
  f.history.addUser('First private-export-fixture question');
  f.history.finishAssistant('first', 'First private-export-fixture answer');
  f.history.addUser('Second question');
  f.history.finishAssistant('second', 'Second answer');
  f.history.addUser('Unfinished question');
  f.history.appendAssistant('unfinished', 'Interrupted partial answer');
  const directory = join(f.cwd, 'review training');
  await f.features.handle({ name: '/training', args: ['export', directory] });
  const files = await readdir(directory); assert.equal(files.length, 1);
  const content = await readFile(join(directory, files[0]), 'utf8');
  const examples = content.trim().split('\n').map(line => JSON.parse(line));
  assert.equal(examples.length, 2);
  assert.equal(examples[1].messages.length, 4);
  assert.doesNotMatch(content, /private-export-fixture|Unfinished question|Interrupted partial answer/);
  assert.match(content, /First|Second/);
  assert.equal(f.asks.length, 0);
  assert.equal(f.settings.trainingService, undefined);
});

test('local model wizard saves key-free capabilities and reconnects the selected running endpoint', { timeout: 5000 }, async t => {
  const baseUrl=await endpoint(t,(_request,response)=>response.end(JSON.stringify({data:[{id:'installed-local-model'}]})));
  const f = await router(t, ['1', baseUrl, 'yes','private-local-fixture','1','','Local coding', 'low,high']);
  await f.features.handle({ name: '/switch', args: ['local'] });
  assert.ok(f.notes.some(note => note.includes('Ollama')));
  assert.equal(f.reconnects.length, 1);
  assert.equal(f.reconnects[0].selected.baseUrl, baseUrl);
  assert.equal(f.reconnects[0].selected.apiKey, 'private-local-fixture');
  assert.deepEqual(f.reconnects[0].selected.supportedEfforts, ['low', 'high']);
  const saved = await f.profiles.get('Local coding');
  assert.equal(saved.apiKey, undefined);
  assert.equal(saved.model, 'installed-local-model');
  assert.deepEqual(saved.supportedEfforts, ['low', 'high']);
  const records = await readdir(f.profiles.directory);
  const body = await readFile(join(f.profiles.directory, records[0]), 'utf8');
  assert.doesNotMatch(body, /private-local-fixture/);
  assert.equal(f.asks[3].hidden, true);
  await f.features.handle({ name: '/switch', args: ['Local coding'] });
  assert.equal(f.reconnects.length, 2);
  assert.equal(f.reconnects[1].selected.apiKey, 'private-local-fixture'); // Session-only cached key, no second key prompt.
  assert.equal(f.asks.length, 8);
});

test('invalid model effort metadata never saves hidden keys or reconnects a partial profile', { timeout: 5000 }, async t => {
  const baseUrl=await endpoint(t,(_request,response)=>response.end(JSON.stringify({data:[{id:'installed-model'}]})));
  const f = await router(t, ['2',baseUrl,'yes','private-invalid-fixture','1','','Invalid capabilities','high,not a level']);
  await assert.rejects(f.features.handle({ name: '/switch', args: ['local'] }), /effort|capabilities|identifier/i);
  assert.deepEqual(await f.profiles.list(), []);
  assert.deepEqual(await readdir(f.profiles.directory), []);
  assert.equal(f.reconnects.length, 0);
  assert.equal(f.asks[3].hidden, true);
});
