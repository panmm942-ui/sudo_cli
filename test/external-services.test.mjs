import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, readFile, readdir, rm, open } from 'node:fs/promises';
import { tmpdir } from './fixtures/temp-root.mjs';
import { join } from 'node:path';
import { createServer } from 'node:http';
async function directory(t) {
  const path = await mkdtemp(join(tmpdir(), 'codexcli-services-test-'));
  t.after(() => rm(path, { recursive: true, force: true }));
  return path;
}
async function fixture(t, handler) {
  const server = createServer(handler);
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => { server.closeAllConnections(); server.close(resolve); }));
  return `http://127.0.0.1:${server.address().port}/v1`;
}
test('service URL validation rejects embedded credentials and query secrets without echoing them', async () => {
  const { validateService } = await import('../src/external-services.mjs');
  for (const baseUrl of ['https://user:private-key@example.com/v1', 'https://example.com/v1?api_key=private-key', 'ftp://example.com']) assert.throws(() => validateService({ baseUrl, apiKey: 'private-key' }), error => !error.message.includes('private-key'));
  assert.deepEqual(validateService({ baseUrl: 'http://localhost:1234/v1', model: 'local-audio', apiKey: 'session-only' }), { baseUrl: 'http://localhost:1234/v1', model: 'local-audio', apiKey: 'session-only' });
});
test('transcription sends bounded multipart audio with the configured model and returns text', async t => {
  const { transcribeAudio } = await import('../src/external-services.mjs');
  const dir = await directory(t);
  const path = join(dir, 'audio with spaces.wav');
  await writeFile(path, 'RIFF synthetic audio fixture');
  let body;
  const baseUrl = await fixture(t, async (req, res) => {
    assert.equal(req.url, '/v1/audio/transcriptions');
    assert.equal(req.headers.authorization, 'Bearer synthetic-secret');
    assert.match(req.headers['content-type'], /multipart\/form-data/);
    const chunks = []; for await (const chunk of req) chunks.push(chunk); body = Buffer.concat(chunks).toString();
    res.setHeader('content-type', 'application/json'); res.end(JSON.stringify({ text: 'Recognized words.' }));
  });
  const text = await transcribeAudio({ connection: { baseUrl, model: 'speech-fixture', apiKey: 'synthetic-secret' }, path });
  assert.equal(text, 'Recognized words.');
  assert.ok(body.includes('speech-fixture') && body.includes('audio with spaces.wav'));
  assert.ok(!body.includes('synthetic-secret'));
});
test('service errors and redirects never echo response bodies or forward credentials', async t => {
  const { transcribeAudio } = await import('../src/external-services.mjs');
  const dir = await directory(t), path = join(dir, 'sample.wav'); await writeFile(path, 'audio fixture');
  let reached = false;
  const destination = await fixture(t, (req, res) => { reached = true; res.end('{}'); });
  const redirect = await fixture(t, (req, res) => { res.writeHead(302, { location: `${destination}/audio/transcriptions` }); res.end(); });
  await assert.rejects(transcribeAudio({ connection: { baseUrl: redirect, model: 'm', apiKey: 'synthetic-secret' }, path }), error => !error.message.includes('synthetic-secret'));
  assert.equal(reached, false);
  const failure = await fixture(t, (req, res) => { res.writeHead(401); res.end('synthetic-secret private provider error'); });
  await assert.rejects(transcribeAudio({ connection: { baseUrl: failure, model: 'm', apiKey: 'synthetic-secret' }, path }), error => !error.message.includes('synthetic-secret') && !error.message.includes('private provider error'));
});
test('training endpoints upload purpose fine-tune, start, inspect and cancel jobs through explicit calls', async t => {
  const { uploadTrainingFile, startTrainingJob, getTrainingJob, cancelTrainingJob } = await import('../src/external-services.mjs');
  const dir = await directory(t), path = join(dir, 'training.jsonl');
  await writeFile(path, JSON.stringify({ messages: [{ role: 'user', content: 'Question' }, { role: 'assistant', content: 'Answer' }] }) + '\n');
  const requests = [];
  const baseUrl = await fixture(t, async (req, res) => {
    const chunks = []; for await (const chunk of req) chunks.push(chunk); const body = Buffer.concat(chunks).toString();
    requests.push({ method: req.method, url: req.url, body });
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify(req.url === '/v1/files' ? { id: 'file-fixture' } : { id: 'ftjob-fixture', status: req.url.endsWith('/cancel') ? 'cancelled' : 'queued' }));
  });
  const connection = { baseUrl, apiKey: 'synthetic-secret' };
  assert.equal((await uploadTrainingFile({ connection, path })).id, 'file-fixture');
  assert.ok(requests[0].body.includes('fine-tune'));
  assert.equal((await startTrainingJob({ connection, trainingFileId: 'file-fixture', model: 'fine-tunable-fixture' })).id, 'ftjob-fixture');
  assert.deepEqual(JSON.parse(requests[1].body), { training_file: 'file-fixture', model: 'fine-tunable-fixture' });
  assert.equal((await getTrainingJob({ connection, id: 'ftjob-fixture' })).status, 'queued');
  assert.equal((await cancelTrainingJob({ connection, id: 'ftjob-fixture' })).status, 'cancelled');
  assert.equal(requests[2].method, 'GET');
  assert.equal(requests[3].method, 'POST');
});
test('dataset export keeps complete text conversations, merges adjacent roles and excludes incomplete turns', async t => {
  const { createTrainingDataset } = await import('../src/external-services.mjs');
  const dir = await directory(t);
  const result = await createTrainingDataset({ directory: dir, messages: [
    { role: 'system', content: 'Be concise', apiKey: 'must-not-save' },
    { role: 'user', content: 'Question one' }, { role: 'assistant', content: 'First' }, { role: 'assistant', content: 'answer' },
    { role: 'user', content: 'Question two' }, { role: 'assistant', content: 'Second answer' }, { role: 'user', content: 'Incomplete question' },
    { role: 'tool', content: 'must not be in dataset' },
  ] });
  const body = await readFile(result.path, 'utf8');
  const examples = body.trim().split('\n').map(line => JSON.parse(line));
  assert.equal(result.examples, 2);
  assert.equal(examples.length, 2);
  assert.deepEqual(examples[0].messages.map(message => message.role), ['system', 'user', 'assistant']);
  assert.equal(examples[0].messages[2].content, 'First\n\nanswer');
  assert.equal(examples[1].messages.at(-1).role, 'assistant');
  assert.ok(!body.includes('Incomplete question') && !body.includes('must-not-save') && !body.includes('must not be in dataset'));
});
test('microphone argument generation chooses native audio backend and treats device text literally', async () => {
  const { microphoneArgs } = await import('../src/external-services.mjs');
  const path = join(tmpdir(), 'recording.wav');
  const windows = microphoneArgs({ path, seconds: 10, device: 'Device & $(literal)', platform: 'win32' });
  assert.ok(windows.includes('dshow') && windows.includes('audio=Device & $(literal)'));
  const mac = microphoneArgs({ path, seconds: 10, device: '0', platform: 'darwin' });
  assert.ok(mac.includes('avfoundation') && mac.includes(':0'));
  const linux = microphoneArgs({ path, seconds: 10, platform: 'linux' });
  assert.ok(linux.includes('pulse') && linux.includes('default'));
  assert.throws(() => microphoneArgs({ path, seconds: 100, platform: 'linux' }), /duration|seconds/i);
});
test('recording uses an owned output, actionable missing-tool errors and cancellation cleanup', async t => {
  const { captureMicrophone } = await import('../src/external-services.mjs');
  const dir = await directory(t), path = join(dir, 'audio.wav');
  await assert.rejects(captureMicrophone({ path, seconds: 1, platform: 'linux', ffmpegPath: 'not-an-installed-ffmpeg-fixture' }), /FFmpeg|ffmpeg/);
  assert.deepEqual(await readdir(dir), []);
  await writeFile(path, 'foreign file');
  await assert.rejects(captureMicrophone({ path, seconds: 1, platform: 'linux', ffmpegPath: 'missing' }), /exists|overwrite/i);
  assert.equal(await readFile(path, 'utf8'), 'foreign file');
  await rm(path);
  const controller = new AbortController(); setTimeout(() => controller.abort(), 50);
  await assert.rejects(captureMicrophone({ path, seconds: 1, platform: 'linux', signal: controller.signal, ffmpegPath: [process.execPath, '-e', 'setInterval(()=>{},1000)', '--'] }), /cancel|interrupt/i);
  assert.deepEqual(await readdir(dir), []);
});
test('IDE launch stays explicit and passes the workspace as one literal argument without opening a real window', async t => {
  const { openIDE } = await import('../src/external-services.mjs');
  const cwd = await directory(t);
  let requested;
  const result = await openIDE({ cwd, editor: 'code', launch: async value => { requested = value; return { pid: 123 }; } });
  assert.equal(result.pid, 123);
  assert.ok(requested.args.includes(cwd));
  assert.equal(requested.shell, false);
  await assert.rejects(openIDE({ cwd, editor: 'code;bad-command', launch: async () => {} }), /editor|supported/i);
});
test('synthetic recorder success returns owned PCM WAV without accessing a microphone', async t => {
  const { captureMicrophone } = await import('../src/external-services.mjs');
  const dir = await directory(t), path = join(dir, 'synthetic.wav');
  const script = "const fs=require('node:fs');const b=Buffer.alloc(46);b.write('RIFF',0);b.writeUInt32LE(38,4);b.write('WAVEfmt ',8);b.writeUInt32LE(16,16);b.writeUInt16LE(1,20);b.writeUInt16LE(1,22);b.writeUInt32LE(16000,24);b.writeUInt32LE(32000,28);b.writeUInt16LE(2,32);b.writeUInt16LE(16,34);b.write('data',36);b.writeUInt32LE(2,40);fs.writeFileSync(process.argv.at(-1),b)";
  const result = await captureMicrophone({ path, seconds: 1, platform: 'linux', ffmpegPath: [process.execPath, '-e', script, '--'] });
  assert.equal(result.path, path);
  assert.equal(result.bytes, 46);
  assert.equal((await readFile(path)).toString('ascii', 8, 12), 'WAVE');
});
test('invalid service response shapes and unsafe training identifiers are rejected', async t => {
  const { getTrainingJob, transcribeAudio } = await import('../src/external-services.mjs');
  await assert.rejects(getTrainingJob({ connection: { baseUrl: 'http://localhost:1234/v1' }, id: '../outside' }), /identifier/i);
  const dir = await directory(t), path = join(dir, 'sample.wav'); await writeFile(path, 'fixture');
  const baseUrl = await fixture(t, (req, res) => { res.end(JSON.stringify({ text: { private: 'must not echo body' } })); });
  await assert.rejects(transcribeAudio({ connection: { baseUrl, model: 'fixture' }, path }), error => /transcription/.test(error.message) && !error.message.includes('must not echo body'));
});

test('oversized local uploads and remote response bodies are bounded before use', async t => {
  const { transcribeAudio } = await import('../src/external-services.mjs');
  const dir = await directory(t), path = join(dir, 'large.wav');
  const file = await open(path, 'wx');
  try { await file.truncate(25 * 1024 * 1024 + 1); } finally { await file.close(); }
  await assert.rejects(transcribeAudio({ connection: { baseUrl: 'http://127.0.0.1:1/v1', model: 'fixture' }, path }), /25 MiB/);
  await writeFile(path, 'small fixture');
  const baseUrl = await fixture(t, (req, res) => { res.end(JSON.stringify({ text: 'private-response'.repeat(80000) })); });
  await assert.rejects(transcribeAudio({ connection: { baseUrl, model: 'fixture' }, path }), error => /size limit/.test(error.message) && !error.message.includes('private-response'));
});

test('caller cancellation interrupts a stalled service without echoing provider information', async t => {
  const { transcribeAudio } = await import('../src/external-services.mjs');
  const dir = await directory(t), path = join(dir, 'audio.wav'); await writeFile(path, 'fixture');
  const controller = new AbortController();
  const baseUrl = await fixture(t, () => { controller.abort(); });
  await assert.rejects(transcribeAudio({ connection: { baseUrl, model: 'fixture', apiKey: 'private-fixture' }, path, signal: controller.signal }), error => /cancelled/.test(error.message) && !error.message.includes('private-fixture'));
});

test('training status preserves supported paused states while dropping arbitrary provider fields', async t => {
  const { getTrainingJob } = await import('../src/external-services.mjs');
  const baseUrl = await fixture(t, (req, res) => { res.end(JSON.stringify({ id: 'ftjob-fixture', status: 'paused', error: { message: 'private body' }, arbitrary: 'must be dropped' })); });
  assert.deepEqual(await getTrainingJob({ connection: { baseUrl }, id: 'ftjob-fixture' }), { id: 'ftjob-fixture', status: 'paused' });
});

test('dataset export excludes an interrupted assistant response from training examples', async t => {
  const { createTrainingDataset } = await import('../src/external-services.mjs');
  const dir = await directory(t);
  const result = await createTrainingDataset({ directory: dir, messages: [
    { role: 'user', content: 'Complete question' },
    { role: 'assistant', content: 'Complete answer', status: 'completed' },
    { role: 'user', content: 'Unfinished question' },
    { role: 'assistant', content: 'Interrupted partial answer', status: 'streaming' },
  ] });
  assert.equal(result.examples, 1);
  const body = await readFile(result.path, 'utf8');
  assert.ok(!body.includes('Unfinished question') && !body.includes('Interrupted partial answer'));
});
