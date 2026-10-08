import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from './fixtures/temp-root.mjs';
import { join } from 'node:path';

async function waitFor(predicate, milliseconds = 4000) {
  const end = Date.now() + milliseconds;
  while (Date.now() < end) { if (await predicate()) return; await new Promise(resolve => setTimeout(resolve, 20)); }
  assert.fail('Expected voice behavior did not occur within the fixture deadline.');
}
async function service(t, handler) {
  const server = createServer(handler);
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => { server.closeAllConnections(); server.close(resolve); }));
  return `http://127.0.0.1:${server.address().port}/v1`;
}
function recorder(phrases = [{ delay: 100, frames: 20 }]) {
  const script = `const keep=setInterval(()=>{},1000); for(const phrase of ${JSON.stringify(phrases)})setTimeout(()=>{const b=Buffer.alloc((30+phrase.frames+30)*640);for(let i=30*320;i<(30+phrase.frames)*320;i++)b.writeInt16LE(Math.round(6000*Math.sin(2*Math.PI*220*i/16000)),i*2);process.stdout.write(b)},phrase.delay);`;
  return [process.execPath, '-e', script, '--'];
}

function pcm({ frames, amplitude = 0, frequency = 220 } = {}) {
  const bytes = Buffer.alloc(frames * 640);
  for (let i = 0; i < bytes.length / 2; i++) bytes.writeInt16LE(Math.round(amplitude * Math.sin(2 * Math.PI * frequency * i / 16000) * 32767), i * 2);
  return bytes;
}
test('voice segmentation ignores sustained background noise and short clicks, then preserves speech onset and ends at silence', async () => {
  const { createVoiceSegmenter, pcmToWav } = await import('../src/live-voice.mjs');
  const phrases = [], starts = [];
  const segmenter = createVoiceSegmenter({ onPhrase: phrase => phrases.push(phrase), onSpeechStart: () => starts.push(true) });
  segmenter.feed(pcm({ frames: 100, amplitude: 0.004 }));
  segmenter.feed(pcm({ frames: 2, amplitude: 0.2 }));
  segmenter.feed(pcm({ frames: 30 }));
  assert.equal(starts.length, 0);
  const audio = Buffer.concat([pcm({ frames: 20 }), pcm({ frames: 25, amplitude: 0.15 }), pcm({ frames: 30 })]);
  // Odd byte boundaries must not scramble 16-bit samples or drop the beginning of a phrase.
  for (let i = 0; i < audio.length; i += 997) segmenter.feed(audio.subarray(i, i + 997));
  assert.equal(starts.length, 1);
  assert.equal(phrases.length, 1);
  assert.equal(phrases[0].reason, 'silence');
  assert.ok(phrases[0].speechMs >= 480 && phrases[0].speechMs <= 520);
  assert.ok(phrases[0].pcm.subarray(0, 640 * 5).every(byte => byte === 0), 'Pre-roll retains audio before detection.');
  assert.ok(phrases[0].pcm.some(byte => byte !== 0));
  const wav = pcmToWav(phrases[0].pcm);
  assert.equal(wav.toString('ascii', 0, 4), 'RIFF');
  assert.equal(wav.readUInt32LE(24), 16000);
  assert.equal(wav.readUInt32LE(28), 32000);
  assert.equal(wav.readUInt16LE(22), 1);
  assert.equal(wav.readUInt16LE(34), 16);
  assert.equal(wav.readUInt32LE(40), phrases[0].pcm.length);
  assert.deepEqual(wav.subarray(44), phrases[0].pcm);
});
test('voice segmentation caps continuous speech at twenty seconds and adapts to quiet background noise', async () => {
  const { createVoiceSegmenter } = await import('../src/live-voice.mjs');
  const phrases = [];
  const segmenter = createVoiceSegmenter({ onPhrase: phrase => phrases.push(phrase) });
  segmenter.feed(pcm({ frames: 200, amplitude: 0.012 }));
  assert.equal(phrases.length, 0);
  assert.ok(segmenter.snapshot().noiseRms > 0.004);
  segmenter.feed(pcm({ frames: 1020, amplitude: 0.2 }));
  assert.equal(phrases.length, 1);
  assert.equal(phrases[0].reason, 'limit');
  assert.ok(phrases[0].pcm.length <= 640000);
  segmenter.reset();
  assert.equal(segmenter.snapshot().hearing, false);
});
test('continuous microphone commands use native devices and pipe bounded PCM without shell interpolation', async () => {
  const { continuousMicrophoneArgs } = await import('../src/live-voice.mjs');
  const windows = continuousMicrophoneArgs({ platform: 'win32', device: 'Mic & $(literal)' });
  assert.deepEqual(windows.slice(-9), ['-ac', '1', '-ar', '16000', '-c:a', 'pcm_s16le', '-f', 's16le', 'pipe:1']);
  assert.equal(windows[windows.indexOf('-i') + 1], 'audio=Mic & $(literal)');
  assert.ok(!windows.includes('-t'), 'Capture is continuous, not fixed-duration clips.');
  const mac = continuousMicrophoneArgs({ platform: 'darwin', device: '2' });
  assert.equal(mac[mac.indexOf('-i') + 1], ':2');
  const linux = continuousMicrophoneArgs({ platform: 'linux' });
  assert.equal(linux[linux.indexOf('-i') + 1], 'default');
  assert.throws(() => continuousMicrophoneArgs({ platform: 'win32' }), /microphone device/i);
});
test('continuous voice transcribes segmented WAV while listening and streams a spoken reply into a native player', async t => {
  const { createLiveVoice } = await import('../src/live-voice.mjs');
  const dir = await mkdtemp(join(tmpdir(), 'codexcli-voice-test-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const output = join(dir, 'played.bin'), audio = Buffer.from('synthetic encoded audio fixture');
  const requests = [], transcripts = [], states = [], errors = [];
  const baseUrl = await service(t, async (req, res) => {
    const chunks = []; for await (const chunk of req) chunks.push(chunk);
    const body = Buffer.concat(chunks); requests.push({ url: req.url, headers: req.headers, body });
    if (req.url === '/v1/audio/transcriptions') {
      res.setHeader('content-type', 'application/json'); res.end(JSON.stringify({ text: 'Please inspect this project.' }));
    } else { res.setHeader('content-type', 'audio/mpeg'); res.write(audio.subarray(0, 10)); setTimeout(() => res.end(audio.subarray(10)), 30); }
  });
  const player = [process.execPath, '-e', `const fs=require('node:fs');const chunks=[];process.stdin.on('data',b=>chunks.push(b));process.stdin.on('end',()=>fs.writeFileSync(${JSON.stringify(output)},Buffer.concat(chunks)));`, '--'];
  const voice = createLiveVoice({ transcription: { baseUrl, model: 'fixture-asr', apiKey: 'test-secret' }, speech: { baseUrl, model: 'fixture-tts', voice: 'fixture-voice', apiKey: 'test-secret' }, platform: 'linux', captureCommand: recorder(), playbackCommand: player, onTranscript: text => transcripts.push(text), onState: state => states.push(state), onError: error => errors.push(error) });
  t.after(() => voice.stop());
  await voice.start();
  assert.equal(voice.snapshot().listening, true);
  await waitFor(() => transcripts.length === 1);
  await voice.speak('I will inspect the project now.');
  assert.deepEqual(await readFile(output), audio);
  assert.deepEqual(transcripts, ['Please inspect this project.']);
  assert.equal(errors.length, 0);
  assert.ok(states.some(state => state.transcribing && state.listening));
  assert.ok(states.some(state => state.speaking && state.listening));
  assert.equal(requests[0].headers.authorization, 'Bearer test-secret');
  assert.ok(requests[0].body.includes(Buffer.from('fixture-asr')));
  const riff = requests[0].body.indexOf('RIFF');
  assert.ok(riff >= 0);
  assert.equal(requests[0].body.readUInt32LE(riff + 24), 16000);
  assert.deepEqual(JSON.parse(requests[1].body), { model: 'fixture-tts', voice: 'fixture-voice', input: 'I will inspect the project now.', response_format: 'mp3' });
  await voice.stop();
  assert.equal(voice.snapshot().running, false);
  assert.equal(voice.snapshot().listening, false);
  assert.ok(!JSON.stringify(voice.snapshot()).includes('test-secret'));
});
test('speech onset interrupts streamed playback without stopping microphone capture or dropping the next transcript', async t => {
  const { createLiveVoice } = await import('../src/live-voice.mjs');
  let interrupted = false, onset = 0;
  const transcripts = [];
  const baseUrl = await service(t, async (req, res) => {
    for await (const _ of req) {}
    if (req.url.endsWith('/transcriptions')) { res.setHeader('content-type', 'application/json'); res.end('{"text":"Stop and do this instead."}'); }
    else { res.setHeader('content-type', 'audio/mpeg'); res.write(Buffer.from('stream-start')); res.on('close', () => { interrupted = true; }); }
  });
  const voice = createLiveVoice({ transcription: { baseUrl, model: 'fixture-asr' }, speech: { baseUrl, model: 'fixture-tts', voice: 'alloy' }, platform: 'linux', captureCommand: recorder([{ delay: 500, frames: 20 }]), playbackCommand: [process.execPath, '-e', "process.stdin.resume();process.stdin.on('end',()=>process.exit(0));", '--'], onSpeechStart: () => { onset++; }, onTranscript: text => transcripts.push(text) });
  t.after(() => voice.stop());
  await voice.start();
  const speaking = voice.speak('A long response still streaming.');
  await waitFor(() => voice.snapshot().speaking);
  await waitFor(() => onset === 1 && interrupted && transcripts.length === 1);
  const result = await speaking;
  assert.equal(result.interrupted, true);
  assert.equal(voice.snapshot().listening, true);
  assert.equal(voice.snapshot().speaking, false);
  assert.equal(transcripts[0], 'Stop and do this instead.');
});
test('speaker echo mode ignores capture during playback and keeps a manual interruption', async t => {
  const {createLiveVoice}=await import('../src/live-voice.mjs');let asr=0,onset=0;const baseUrl=await service(t,async(req,res)=>{for await(const _ of req){}if(req.url.endsWith('/transcriptions')){asr++;res.end('{"text":"echo"}');}else{res.writeHead(200,{'content-type':'audio/mpeg'});res.write('voice');}});
  const voice=createLiveVoice({transcription:{baseUrl,model:'asr'},speech:{baseUrl,model:'tts'},echoMode:'speaker',platform:'linux',captureCommand:recorder([{delay:350,frames:20}]),playbackCommand:[process.execPath,'-e',"process.stdin.resume();process.stdin.on('end',()=>process.exit(0));",'--'],onSpeechStart:()=>onset++});t.after(()=>voice.stop());await voice.start();const reply=voice.speak('Reply still playing.');await waitFor(()=>voice.snapshot().speaking);await new Promise(resolve=>setTimeout(resolve,750));assert.equal(asr,0);assert.equal(onset,0);voice.interruptSpeech();assert.equal((await reply).interrupted,true);assert.equal(voice.snapshot().listening,true);assert.equal(voice.snapshot().speaking,false);
});

test('transcription backlog retains one pending phrase and reports overflow while recording continues', async t => {
  const { createLiveVoice } = await import('../src/live-voice.mjs');
  const pending = [], errors = [], transcripts = [];
  const baseUrl = await service(t, async (req, res) => {
    for await (const _ of req) {}
    pending.push(res);
  });
  const voice = createLiveVoice({ transcription: { baseUrl, model: 'fixture-asr' }, speech: { baseUrl, model: 'fixture-tts' }, platform: 'linux', captureCommand: recorder([{ delay: 100, frames: 20 }, { delay: 250, frames: 20 }, { delay: 400, frames: 20 }]), onTranscript: text => transcripts.push(text), onError: error => errors.push(error) });
  t.after(() => voice.stop());
  await voice.start();
  await waitFor(() => errors.some(error => /backlog|repeat/i.test(error.message)));
  assert.equal(pending.length, 1);
  assert.equal(voice.snapshot().queuedPhrases, 1);
  assert.equal(voice.snapshot().droppedPhrases, 1);
  assert.equal(voice.snapshot().listening, true);
  pending[0].setHeader('content-type', 'application/json'); pending[0].end('{"text":"First phrase"}');
  await waitFor(() => pending.length === 2);
  pending[1].setHeader('content-type', 'application/json'); pending[1].end('{"text":"Second phrase"}');
  await waitFor(() => transcripts.length === 2);
  assert.deepEqual(transcripts, ['First phrase', 'Second phrase']);
});
test('stopping live voice aborts pending HTTP requests and suppresses late transcripts, then permits a clean restart', async t => {
  const { createLiveVoice } = await import('../src/live-voice.mjs');
  let requests = 0, aborted = 0;
  const transcripts = [], errors = [];
  const baseUrl = await service(t, async (req, res) => {
    for await (const _ of req) {}
    requests++; res.on('close', () => { aborted++; });
    if (requests > 1) { res.setHeader('content-type', 'application/json'); res.end('{"text":"Restarted successfully"}'); }
  });
  const voice = createLiveVoice({ transcription: { baseUrl, model: 'fixture-asr' }, speech: { baseUrl, model: 'fixture-tts' }, platform: 'linux', captureCommand: recorder(), onTranscript: text => transcripts.push(text), onError: error => errors.push(error) });
  t.after(() => voice.stop());
  await voice.start(); await waitFor(() => requests === 1);
  await voice.stop(); await waitFor(() => aborted === 1);
  assert.deepEqual(transcripts, []);
  assert.deepEqual(errors, []);
  assert.equal(voice.snapshot().queuedPhrases, 0);
  await voice.start(); await waitFor(() => transcripts.length === 1);
  assert.deepEqual(transcripts, ['Restarted successfully']);
  assert.equal(voice.snapshot().transcribedPhrases, 1);
});
test('voice never forwards credentials across redirects or echoes provider error text', async t => {
  const { createLiveVoice } = await import('../src/live-voice.mjs');
  let forwarded = 0;
  const destination = await service(t, (req, res) => { forwarded++; res.end('{"text":"should never be requested"}'); });
  const errors = [];
  const baseUrl = await service(t, async (req, res) => {
    for await (const _ of req) {}
    if (req.url.endsWith('/transcriptions')) { res.writeHead(302, { location: `${destination}/audio/transcriptions` }); res.end('private-secret'); }
    else { res.writeHead(401); res.end('private-secret provider traceback'); }
  });
  const voice = createLiveVoice({ transcription: { baseUrl, model: 'fixture-asr', apiKey: 'private-secret' }, speech: { baseUrl, model: 'fixture-tts', apiKey: 'private-secret' }, platform: 'linux', captureCommand: recorder(), onError: error => errors.push(error) });
  t.after(() => voice.stop());
  await voice.start(); await waitFor(() => errors.length === 1);
  await assert.rejects(voice.speak('Say this'), /HTTP 401/);
  assert.equal(forwarded, 0);
  assert.ok(errors.every(error => !error.message.includes('private-secret') && !error.message.includes('traceback')));
  assert.equal(voice.snapshot().listening, true);
});
test('external abort stops listening and cancels speech generation, and missing native executables fail safely', async t => {
  const { createLiveVoice } = await import('../src/live-voice.mjs');
  const controller = new AbortController();
  let startedSpeech = false, abortedSpeech = false;
  const baseUrl = await service(t, async (req, res) => { for await (const _ of req) {} startedSpeech = true; res.on('close', () => { abortedSpeech = true; }); });
  const options = { transcription: { baseUrl, model: 'fixture-asr' }, speech: { baseUrl, model: 'fixture-tts' }, platform: 'linux' };
  const voice = createLiveVoice({ ...options, captureCommand: recorder([]), signal: controller.signal });
  t.after(() => voice.stop());
  await voice.start(); const speaking = voice.speak('An unfinished reply.');
  await waitFor(() => startedSpeech); controller.abort();
  assert.equal((await speaking).interrupted, true);
  await waitFor(() => !voice.snapshot().running && abortedSpeech);
  await assert.rejects(voice.start(), /cancelled/i);
  const missing = createLiveVoice({ ...options, captureCommand: join(tmpdir(), 'nonexistent-codexcli-voice-ffmpeg-native') });
  await assert.rejects(missing.start(), /FFmpeg|recorder/i);
  assert.equal(missing.snapshot().running, false);
});
test('spoken replies split into supported chunks without losing Unicode text and silence never reaches an ASR service', async t => {
  const { splitSpeechText, createLiveVoice } = await import('../src/live-voice.mjs');
  const input = '🙂'.repeat(2500);
  const chunks = splitSpeechText(input);
  assert.equal(chunks.join(''), input);
  assert.ok(chunks.every(chunk => chunk.length <= 3500 && !/^[\uDC00-\uDFFF]/.test(chunk) && !/[\uD800-\uDBFF]$/.test(chunk)));
  let requests = 0;
  const baseUrl = await service(t, (req, res) => { requests++; res.end('{}'); });
  const voice = createLiveVoice({ transcription: { baseUrl, model: 'fixture-asr' }, speech: { baseUrl, model: 'fixture-tts' }, platform: 'linux', captureCommand: recorder([{ delay: 20, frames: 0 }]) });
  await voice.start(); await new Promise(resolve => setTimeout(resolve, 150)); await voice.stop();
  assert.equal(requests, 0);
});
test('oversized ASR and TTS responses stop their request without stopping continuous capture', async t => {
  const { createLiveVoice } = await import('../src/live-voice.mjs');
  const errors = [];
  let speechRequestClosed = false;
  const baseUrl = await service(t, async (req, res) => {
    for await (const _ of req) {}
    if (req.url.endsWith('/transcriptions')) { res.setHeader('content-type', 'application/json'); res.end(JSON.stringify({ text: 'x'.repeat(300000) })); }
    else {
      res.setHeader('content-type', 'audio/mpeg');
      res.on('close', () => { speechRequestClosed = true; });
      const block = Buffer.alloc(64 * 1024, 42);
      let blocks = 0;
      function write() { while (blocks++ < 145) { if (!res.write(block)) { res.once('drain', write); return; } } res.end(); }
      write();
    }
  });
  const voice = createLiveVoice({ transcription: { baseUrl, model: 'fixture-asr' }, speech: { baseUrl, model: 'fixture-tts' }, platform: 'linux', captureCommand: recorder(), playbackCommand: [process.execPath, '-e', "process.stdin.resume();", '--'], onError: error => errors.push(error) });
  t.after(() => voice.stop());
  await voice.start(); await waitFor(() => errors.some(error => /transcription.*size limit/i.test(error.message)));
  await assert.rejects(voice.speak('This should exceed the output size bound.'), /audio.*size limit/i);
  await waitFor(() => speechRequestClosed);
  assert.equal(voice.snapshot().listening, true);
  assert.equal(voice.snapshot().speaking, false);
});
test('microphone loss stops the mode and malformed ASR errors cannot leak input or retain a stale working state', async t => {
  const { createLiveVoice } = await import('../src/live-voice.mjs');
  const errors = [];
  const baseUrl = await service(t, async (req, res) => { for await (const _ of req) {} res.setHeader('content-type', 'application/json'); res.end('private-secret invalid-json'); });
  const voice = createLiveVoice({ transcription: { baseUrl, model: 'fixture-asr', apiKey: 'private-secret' }, speech: { baseUrl, model: 'fixture-tts' }, platform: 'linux', captureCommand: recorder(), onError: error => errors.push(error) });
  t.after(() => voice.stop());
  await voice.start(); await waitFor(() => errors.length === 1);
  assert.match(errors[0].message, /invalid JSON/i);
  assert.ok(!errors[0].message.includes('private-secret'));
  assert.equal(voice.snapshot().transcribing, false);
  assert.equal(voice.snapshot().listening, true);
  await voice.stop();
  const lost = createLiveVoice({ transcription: { baseUrl, model: 'fixture-asr' }, speech: { baseUrl, model: 'fixture-tts' }, platform: 'linux', captureCommand: [process.execPath, '-e', "setTimeout(()=>process.exit(3),100);", '--'], onError: error => errors.push(error) });
  t.after(() => lost.stop());
  await lost.start(); await waitFor(() => !lost.snapshot().running);
  assert.equal(lost.snapshot().listening, false);
  assert.match(errors.at(-1).message, /capture stopped/i);
});
test('rejected asynchronous UI callbacks are isolated while the microphone remains available', async t => {
  const { createLiveVoice } = await import('../src/live-voice.mjs');
  let stateErrors = 0;
  const baseUrl = await service(t, (req, res) => res.end('{}'));
  const voice = createLiveVoice({ transcription: { baseUrl, model: 'fixture-asr' }, speech: { baseUrl, model: 'fixture-tts' }, platform: 'linux', captureCommand: recorder([]), onState: async () => { throw new Error('private callback state'); }, onError: async error => { if (/state callback/i.test(error.message)) stateErrors++; throw new Error('private callback error'); } });
  t.after(() => voice.stop());
  await voice.start();
  await waitFor(() => stateErrors > 0);
  assert.equal(voice.snapshot().listening, true);
});
test('stop waits until a recorder ignoring SIGTERM has actually exited', { skip: process.platform === 'win32' }, async t => {
  const { createLiveVoice } = await import('../src/live-voice.mjs');
  const dir = await mkdtemp(join(tmpdir(), 'codexcli-voice-stop-test-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const pidFile = join(dir, 'recorder.pid');
  const script = `process.on('SIGTERM',()=>{});require('node:fs').writeFileSync(${JSON.stringify(pidFile)},String(process.pid));setInterval(()=>{},1000);`;
  const baseUrl = await service(t, (req, res) => res.end('{}'));
  const voice = createLiveVoice({ transcription: { baseUrl, model: 'fixture-asr' }, speech: { baseUrl, model: 'fixture-tts' }, platform: 'linux', captureCommand: [process.execPath, '-e', script, '--'] });
  t.after(() => voice.stop());
  await voice.start();
  let pid;
  await waitFor(async () => { try { pid = Number(await readFile(pidFile, 'utf8')); return true; } catch { return false; } });
  await voice.stop();
  assert.throws(() => process.kill(pid, 0), error => error.code === 'ESRCH');
});
