import { spawn } from 'node:child_process';
import { Readable, Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { validateService } from './external-services.mjs';

const SAMPLE_RATE = 16000;
const FRAME_MS = 20;
const FRAME_BYTES = 640;
const controls = /[\u0000-\u001f\u007f]/;

export function continuousMicrophoneArgs({ device, platform = process.platform } = {}) {
  if (device !== undefined && (typeof device !== 'string' || !device || controls.test(device))) throw new Error('Microphone device must be a valid name or index.');
  let format, input;
  if (platform === 'win32') {
    if (!device) throw new Error('Choose the exact Windows microphone device name before starting live voice.');
    format = 'dshow'; input = `audio=${device}`;
  } else if (platform === 'darwin') { format = 'avfoundation'; input = `:${device ?? '0'}`; }
  else if (platform === 'linux') { format = 'pulse'; input = device ?? 'default'; }
  else throw new Error('Live microphone capture supports Windows, Linux and macOS.');
  return ['-hide_banner', '-loglevel', 'error', '-nostdin', '-f', format, '-i', input, '-vn', '-ac', '1', '-ar', String(SAMPLE_RATE), '-c:a', 'pcm_s16le', '-f', 's16le', 'pipe:1'];
}

export function pcmToWav(pcm) {
  if (!Buffer.isBuffer(pcm) || !pcm.length || pcm.length % 2 || pcm.length > 640000) throw new Error('Voice phrase must be nonempty 16-bit PCM within the twenty-second limit.');
  const header = Buffer.alloc(44);
  header.write('RIFF', 0); header.writeUInt32LE(36 + pcm.length, 4); header.write('WAVE', 8);
  header.write('fmt ', 12); header.writeUInt32LE(16, 16); header.writeUInt16LE(1, 20);
  header.writeUInt16LE(1, 22); header.writeUInt32LE(SAMPLE_RATE, 24); header.writeUInt32LE(SAMPLE_RATE * 2, 28);
  header.writeUInt16LE(2, 32); header.writeUInt16LE(16, 34); header.write('data', 36); header.writeUInt32LE(pcm.length, 40);
  return Buffer.concat([header, pcm]);
}

/** Local energy-based VAD. Audio is retained only for pre-roll and the current bounded phrase. */
export function createVoiceSegmenter({ threshold = 0.015, noiseRatio = 3, preRollMs = 200, startSpeechMs = 60, minSpeechMs = 180, endSilenceMs = 600, maxPhraseMs = 20000, onSpeechStart = () => {}, onSpeechEnd = () => {}, onPhrase = () => {} } = {}) {
  for (const [name, value, min, max] of [
    ['threshold', threshold, 0.001, 0.5], ['noiseRatio', noiseRatio, 1.5, 10],
    ['preRollMs', preRollMs, 0, 1000], ['startSpeechMs', startSpeechMs, 40, 500],
    ['minSpeechMs', minSpeechMs, 40, 2000], ['endSilenceMs', endSilenceMs, 100, 3000],
    ['maxPhraseMs', maxPhraseMs, 1000, 20000],
  ]) if (!Number.isFinite(value) || value < min || value > max) throw new Error(`Voice detection ${name} is outside its supported range.`);
  if (minSpeechMs < startSpeechMs || maxPhraseMs < preRollMs + minSpeechMs + endSilenceMs) throw new Error('Voice detection durations leave no room for a complete phrase.');
  const preRollFrames = Math.max(Math.ceil(preRollMs / FRAME_MS), Math.ceil(startSpeechMs / FRAME_MS));
  const startFrames = Math.ceil(startSpeechMs / FRAME_MS), minFrames = Math.ceil(minSpeechMs / FRAME_MS);
  const silenceLimit = Math.ceil(endSilenceMs / FRAME_MS), phraseLimit = Math.floor(maxPhraseMs / FRAME_MS);
  let pending = Buffer.alloc(0), preRoll = [], phrase = [], hearing = false, loudStreak = 0, silenceFrames = 0, speechFrames = 0, noiseRms = 0.002;
  const detectionThreshold = () => Math.max(threshold, Math.min(0.15, noiseRms * noiseRatio));
  function finish(reason) {
    const accepted = speechFrames >= minFrames;
    // Keep 100 ms after the last sound; avoid sending a long silent tail to ASR.
    const trim = reason === 'silence' ? Math.max(0, silenceFrames - 5) : 0;
    const frames = phrase.slice(0, phrase.length - trim);
    const speechMs = speechFrames * FRAME_MS;
    hearing = false; phrase = []; preRoll = []; loudStreak = 0; silenceFrames = 0; speechFrames = 0;
    onSpeechEnd({ accepted, reason, speechMs });
    if (accepted) onPhrase({ pcm: Buffer.concat(frames), speechMs, reason });
  }
  function consume(frame) {
    let sum = 0;
    for (let offset = 0; offset < FRAME_BYTES; offset += 2) { const sample = frame.readInt16LE(offset) / 32768; sum += sample * sample; }
    const rms = Math.sqrt(sum / (FRAME_BYTES / 2));
    const loud = rms >= detectionThreshold();
    if (!hearing) {
      // Do not learn speech as background. Low energy noise adapts over several seconds.
      if (!loud) noiseRms = Math.max(0.0001, noiseRms * 0.97 + rms * 0.03);
      preRoll.push(Buffer.from(frame));
      if (preRoll.length > preRollFrames) preRoll.shift();
      loudStreak = loud ? loudStreak + 1 : 0;
      if (loudStreak < startFrames) return;
      hearing = true; phrase = preRoll; preRoll = []; speechFrames = loudStreak; silenceFrames = 0;
      onSpeechStart();
    } else {
      phrase.push(Buffer.from(frame));
      if (loud) { speechFrames++; silenceFrames = 0; } else silenceFrames++;
    }
    if (phrase.length >= phraseLimit) finish('limit');
    else if (silenceFrames >= silenceLimit) finish('silence');
  }
  return {
    feed(chunk) {
      if (!Buffer.isBuffer(chunk) && !(chunk instanceof Uint8Array)) throw new Error('Microphone capture must provide raw PCM bytes.');
      const input = pending.length ? Buffer.concat([pending, chunk]) : Buffer.from(chunk.buffer, chunk.byteOffset, chunk.byteLength);
      let position = 0;
      while (position + FRAME_BYTES <= input.length) { consume(input.subarray(position, position + FRAME_BYTES)); position += FRAME_BYTES; }
      pending = Buffer.from(input.subarray(position));
    },
    reset() { pending = Buffer.alloc(0); preRoll = []; phrase = []; hearing = false; loudStreak = 0; silenceFrames = 0; speechFrames = 0; noiseRms = 0.002; },
    snapshot() { return { hearing, noiseRms, threshold: detectionThreshold(), bufferedBytes: pending.length + (preRoll.length + phrase.length) * FRAME_BYTES }; },
  };
}

function commandParts(value, fallback) {
  const command = value === undefined ? [fallback] : Array.isArray(value) ? value : [value];
  if (!command.length || command.some(part => typeof part !== 'string' || !part || controls.test(part))) throw new Error('Voice audio executable or arguments are invalid.');
  return command;
}
function launch(command, args, capture) {
  const child = spawn(command[0], [...command.slice(1), ...args], { shell: false, windowsHide: true, stdio: capture ? ['ignore', 'pipe', 'ignore'] : ['pipe', 'ignore', 'ignore'] });
  let failure;
  const message = () => new Error(failure?.code === 'ENOENT' ? `${capture ? 'FFmpeg' : 'FFplay'} was not found. Install native FFmpeg and FFplay and make them available on PATH.` : `Unable to start the ${capture ? 'microphone recorder' : 'audio player'}.`);
  const started = new Promise((resolve, reject) => { child.once('spawn', resolve); child.once('error', error => { failure = error; reject(message()); }); });
  const closed = new Promise(resolve => child.once('close', (code, signal) => resolve({ code, signal, failed: Boolean(failure) })));
  // Input error can arrive after a stop kills the player and must never become unhandled.
  child.stdin?.on('error', () => {});
  return { child, started, closed };
}
async function terminate(handle) {
  if (!handle) return;
  handle.child.kill();
  const timer = setTimeout(() => { handle.child.kill('SIGKILL'); }, 2000);
  timer.unref?.();
  // Sending SIGKILL does not mean the process has exited yet. Wait for reaping
  // before a restart can claim the microphone or audio output device.
  try { await handle.closed; } finally { clearTimeout(timer); }
}
async function voiceResponse(connection, endpoint, { body, json, signal, timeoutMs }) {
  const combined = AbortSignal.any([signal, AbortSignal.timeout(timeoutMs)]);
  const headers = {};
  if (connection.apiKey) headers.authorization = `Bearer ${connection.apiKey}`;
  if (json !== undefined) { headers['content-type'] = 'application/json'; body = JSON.stringify(json); }
  try {
    const response = await fetch(`${connection.baseUrl.replace(/\/+$/, '')}${endpoint}`, { method: 'POST', body, headers, signal: combined, redirect: 'error' });
    if (!response.ok) { await response.body?.cancel(); throw new Error(`Voice service request failed (HTTP ${response.status}).`); }
    return { response, signal: combined };
  } catch (error) {
    if (combined.aborted) throw new Error('Voice service request was cancelled or timed out.');
    if (error?.message?.startsWith('Voice service request failed (HTTP ')) throw error;
    throw new Error('Voice service request failed. Check the configured endpoint; redirects are not followed.');
  }
}
async function transcribePhrase(connection, pcm, { signal, timeoutMs }) {
  const form = new FormData();
  form.append('model', connection.model);
  form.append('response_format', 'json');
  form.append('file', new Blob([pcmToWav(pcm)], { type: 'audio/wav' }), 'voice-phrase.wav');
  const { response } = await voiceResponse(connection, '/audio/transcriptions', { body: form, signal, timeoutMs });
  let length = 0;
  const chunks = [];
  try {
    for await (const chunk of response.body ?? []) {
      length += chunk.length;
      if (length > 256 * 1024) throw new Error('Voice transcription response exceeded its size limit.');
      chunks.push(Buffer.from(chunk));
    }
    let value;
    try { value = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { throw new Error('Voice transcription service returned invalid JSON.'); }
    if (typeof value?.text !== 'string') throw new Error('Voice transcription service returned no transcription text.');
    // Empty silence transcripts are ignored; service error bodies and credentials never reach the UI.
    return value.text.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '').trim();
  } catch (error) {
    await response.body?.cancel().catch(() => {});
    if (signal.aborted) throw new Error('Voice transcription was cancelled.');
    if (error?.message?.startsWith('Voice transcription ')) throw error;
    throw new Error('Voice transcription response was interrupted or timed out.');
  }
}
export function splitSpeechText(text) {
  if (typeof text !== 'string' || Buffer.byteLength(text, 'utf8') > 128 * 1024) throw new Error('Spoken reply must be text within the 128 KiB limit.');
  let remaining = text.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '').trim();
  const result = [];
  while (remaining) {
    if (result.length >= 40) throw new Error('Spoken reply is too long; shorten the answer before reading it aloud.');
    let boundary = Math.min(3500, remaining.length);
    if (boundary < remaining.length) {
      const candidate = remaining.slice(0, boundary);
      const lastSentence = [...candidate.matchAll(/[.!?]\s+/g)].at(-1);
      const natural = lastSentence ? lastSentence.index + 1 : candidate.lastIndexOf(' ');
      if (natural >= boundary / 2) boundary = natural;
      // Preserve UTF-16 pairs when the text has no spaces at a chunk boundary.
      if (/^[\uDC00-\uDFFF]$/.test(remaining[boundary]) && /^[\uD800-\uDBFF]$/.test(remaining[boundary - 1])) boundary--;
    }
    result.push(remaining.slice(0, boundary).trim());
    remaining = remaining.slice(boundary).trim();
  }
  return result;
}

/** Continuous microphone -> local VAD -> compatible ASR -> coding engine callback, with interruptible TTS. */
export function createLiveVoice({ transcription, speech, device, platform = process.platform, onTranscript = () => {}, onSpeechStart = () => {}, onState = () => {}, onError = () => {}, captureCommand, playbackCommand, signal, timeoutMs = 60000, vad = {} } = {}) {
  const asr = validateService(transcription), tts = validateService(speech);
  if (!asr.model || !tts.model) throw new Error('Live voice requires configured transcription and speech models.');
  const voice = speech?.voice ?? 'alloy';
  if (typeof voice !== 'string' || !voice.trim() || voice.length > 128 || controls.test(voice)) throw new Error('Choose a valid speech voice name.');
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 100 || timeoutMs > 120000) throw new Error('Voice service timeout must be between 100 and 120,000 milliseconds.');
  const capture = commandParts(captureCommand, 'ffmpeg'), playback = commandParts(playbackCommand, 'ffplay');
  const captureArgs = continuousMicrophoneArgs({ device, platform });
  let running = false, listening = false, hearing = false, transcribing = false, speaking = false;
  let droppedPhrases = 0, transcribedPhrases = 0, generation = 0, pendingPhrase;
  let recorder, player, sessionController, speechController, transcriptionTask, speechTask, stopping;
  let lastState = '';
  function snapshot() {
    return { running, listening, hearing, transcribing, speaking, queuedPhrases: pendingPhrase ? 1 : 0, droppedPhrases, transcribedPhrases, status: !running ? 'Stopped' : hearing ? 'Hearing' : speaking ? 'Speaking' : transcribing ? 'Transcribing' : 'Listening' };
  }
  function report(error) { try { Promise.resolve(onError(error)).catch(() => {}); } catch { /* UI error handlers cannot terminate capture. */ } }
  function changed() {
    const value = snapshot(), serialized = JSON.stringify(value);
    if (serialized === lastState) return;
    lastState = serialized;
    try { Promise.resolve(onState(value)).catch(() => report(new Error('Voice state callback failed.'))); }
    catch { report(new Error('Voice state callback failed.')); }
  }
  function invoke(callback, ...args) {
    try { Promise.resolve(callback(...args)).catch(() => report(new Error('Voice conversation callback failed.'))); }
    catch { report(new Error('Voice conversation callback failed.')); }
  }
  function interruptSpeech() {
    speechController?.abort();
    player?.child.kill();
    if (speaking) { speaking = false; changed(); }
  }
  async function drain(initial, epoch, session) {
    let phrase = initial;
    while (phrase && running && generation === epoch && !session.signal.aborted) {
      transcribing = true; changed();
      try {
        const text = await transcribePhrase(asr, phrase.pcm, { signal: session.signal, timeoutMs });
        if (running && generation === epoch && !session.signal.aborted && text) { transcribedPhrases++; changed(); invoke(onTranscript, text); }
      } catch (error) { if (running && generation === epoch && !session.signal.aborted) report(error); }
      if (generation !== epoch || !running) break;
      phrase = pendingPhrase; pendingPhrase = undefined; changed();
    }
    if (generation === epoch) { transcribing = false; transcriptionTask = undefined; changed(); }
  }
  const segmenter = createVoiceSegmenter({ ...vad,
    onSpeechStart() { if (!running) return; hearing = true; interruptSpeech(); changed(); invoke(onSpeechStart); },
    onSpeechEnd() { hearing = false; changed(); },
    onPhrase(phrase) {
      if (!running) return;
      if (transcribing) {
        if (pendingPhrase) { droppedPhrases++; changed(); report(new Error('Voice transcription backlog is full. Please repeat the last phrase when transcription catches up.')); }
        else { pendingPhrase = phrase; changed(); }
      } else { transcriptionTask = drain(phrase, generation, sessionController); }
    },
  });
  const externalAbort = () => { void stop(); };
  async function stop() {
    if (stopping) return stopping;
    running = false; listening = false; hearing = false; transcribing = false; pendingPhrase = undefined;
    sessionController?.abort(); interruptSpeech(); segmenter.reset(); changed();
    signal?.removeEventListener('abort', externalAbort);
    const captureHandle = recorder, playbackHandle = player, tasks = [transcriptionTask, speechTask];
    recorder = undefined; player = undefined;
    stopping = Promise.allSettled([terminate(captureHandle), terminate(playbackHandle), ...tasks]).then(() => { stopping = undefined; });
    return stopping;
  }
  async function start() {
    await stopping;
    if (running) return;
    if (signal?.aborted) throw new Error('Live voice was cancelled before it started.');
    sessionController = new AbortController(); generation++;
    const epoch = generation;
    droppedPhrases = 0; transcribedPhrases = 0; pendingPhrase = undefined; segmenter.reset();
    running = true; listening = false; changed();
    signal?.addEventListener('abort', externalAbort, { once: true });
    recorder = launch(capture, captureArgs, true);
    const handle = recorder;
    handle.child.stdout.on('data', chunk => {
      if (running && generation === epoch) {
        try { segmenter.feed(chunk); } catch { report(new Error('Live microphone audio could not be processed.')); void stop(); }
      }
    });
    handle.closed.then(result => {
      if (running && generation === epoch) {
        report(new Error(result.failed ? 'Live microphone recorder could not be started. Check FFmpeg on PATH.' : 'Live microphone capture stopped. Check the selected device and operating-system microphone permission, then restart voice mode.'));
        void stop();
      }
    });
    try { await handle.started; }
    catch (error) { await stop(); throw error; }
    if (!running || generation !== epoch) throw new Error('Live voice stopped while the microphone was starting.');
    listening = true; changed();
  }
  async function streamSpeech(text, session, selectedSpeechController) {
    const combined = AbortSignal.any([session.signal, selectedSpeechController.signal]);
    let spokenCharacters = 0;
    try {
      for (const input of splitSpeechText(text)) {
        if (combined.aborted || hearing) return { interrupted: true, spokenCharacters };
        const { response, signal: deadline } = await voiceResponse(tts, '/audio/speech', { json: { model: tts.model, voice, input, response_format: 'mp3' }, signal: combined, timeoutMs });
        const type = response.headers.get('content-type')?.split(';')[0].trim();
        if (!response.body || (type && !type.startsWith('audio/') && type !== 'application/octet-stream')) { await response.body?.cancel(); throw new Error('Voice speech service returned no playable audio.'); }
        let handle;
        const cancel = () => { handle?.child.kill(); };
        try {
          handle = launch(playback, ['-hide_banner', '-loglevel', 'error', '-nodisp', '-autoexit', '-i', 'pipe:0'], false);
          player = handle;
          deadline.addEventListener('abort', cancel, { once: true });
          if (deadline.aborted) cancel();
          await handle.started;
          let total = 0;
          const bound = new Transform({ transform(chunk, encoding, callback) {
            total += chunk.length;
            callback(total > 8 * 1024 * 1024 ? new Error('Voice speech audio exceeded its size limit.') : null, chunk);
          } });
          await pipeline(Readable.fromWeb(response.body), bound, handle.child.stdin, { signal: deadline });
          const result = await handle.closed;
          if (deadline.aborted) throw new Error('Voice speech playback was cancelled or timed out.');
          if (result.failed || result.code !== 0) throw new Error('Voice audio playback failed. Check FFplay and the audio output device.');
          spokenCharacters += input.length;
        } finally {
          deadline.removeEventListener('abort', cancel);
          if (handle) await terminate(handle);
          if (player === handle) player = undefined;
          await response.body?.cancel().catch(() => {});
        }
      }
      return { interrupted: false, spokenCharacters };
    } catch (error) {
      if (combined.aborted) return { interrupted: true, spokenCharacters };
      const safe = error?.message?.startsWith('Voice ') || error?.message?.startsWith('FFplay ') || error?.message?.startsWith('Unable to start the audio') ? error : new Error('Voice speech streaming failed or timed out.');
      report(safe);
      throw safe;
    } finally {
      if (speechController === selectedSpeechController) { speaking = false; speechController = undefined; speechTask = undefined; changed(); }
    }
  }
  async function speak(text) {
    if (!running) throw new Error('Start live voice before requesting a spoken reply.');
    // Validate before interrupting a previous valid reply.
    const chunks = splitSpeechText(text);
    if (!chunks.length) return { interrupted: false, spokenCharacters: 0 };
    interruptSpeech();
    speechController = new AbortController(); speaking = true; changed();
    const selected = speechController;
    speechTask = streamSpeech(text, sessionController, selected);
    return speechTask;
  }
  return { start, stop, speak, interruptSpeech, snapshot };
}
