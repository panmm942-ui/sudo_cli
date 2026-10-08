import { access, lstat, mkdir, open, rm, stat } from 'node:fs/promises';
import { constants } from 'node:fs';
import { basename, delimiter, extname, join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { validateConnection } from './runtime.mjs';

const MAX_UPLOAD_BYTES = 25 * 1024 * 1024;
const audioTypes = new Map([['.wav', 'audio/wav'], ['.mp3', 'audio/mpeg'], ['.m4a', 'audio/mp4'], ['.mp4', 'audio/mp4'], ['.ogg', 'audio/ogg'], ['.flac', 'audio/flac'], ['.webm', 'audio/webm'], ['.mpeg', 'audio/mpeg']]);
const controls = /[\u0000-\u001f\u007f]/;
function safePath(path) {
  if (typeof path !== 'string' || !path || controls.test(path)) throw new Error('A valid local file or directory path is required.');
  return resolve(path);
}
function identifier(value) {
  if (typeof value !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/.test(value)) throw new Error('Service file or job identifier is invalid.');
  return value;
}
export function validateService(connection) {
  if (!connection || typeof connection !== 'object') throw new Error('Configure a compatible service endpoint first.');
  const validated = validateConnection({ baseUrl: connection.baseUrl, model: connection.model ?? 'service', transport: 'chat-completions', apiKey: connection.apiKey });
  const value = { baseUrl: validated.baseUrl };
  if (connection.model !== undefined) value.model = validated.model;
  if (validated.apiKey !== undefined) value.apiKey = validated.apiKey;
  return value;
}
async function boundedFile(path, limit = MAX_UPLOAD_BYTES) {
  const absolute = safePath(path);
  let file;
  try {
    const before = await lstat(absolute);
    if (!before.isFile() || before.isSymbolicLink() || before.size <= 0 || before.size > limit) throw new Error('Service input must be a nonempty regular file within the 25 MiB limit.');
    file = await open(absolute, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
    const info = await file.stat();
    if (info.ino !== before.ino || info.dev !== before.dev || info.size !== before.size) throw new Error('Service input changed while being opened.');
    const buffer = Buffer.alloc(info.size + 1);
    let position = 0;
    while (position < buffer.length) {
      const result = await file.read(buffer, position, buffer.length - position, position);
      if (!result.bytesRead) break;
      position += result.bytesRead;
    }
    const after = await file.stat();
    if (position !== info.size || after.size !== info.size || after.mtimeMs !== info.mtimeMs) throw new Error('Service input changed while being read.');
    return { path: absolute, bytes: buffer.subarray(0, position) };
  } finally { await file?.close().catch(() => {}); }
}
async function request(connection, endpoint, { method = 'POST', body, json, signal } = {}) {
  const selected = validateService(connection);
  const headers = {};
  if (selected.apiKey) headers.authorization = `Bearer ${selected.apiKey}`;
  if (json !== undefined) { headers['content-type'] = 'application/json'; body = JSON.stringify(json); }
  const combined = AbortSignal.any([AbortSignal.timeout(60000), ...(signal ? [signal] : [])]);
  let response;
  try {
    response = await fetch(`${selected.baseUrl.replace(/\/+$/, '')}${endpoint}`, { method, headers, body, signal: combined, redirect: 'error' });
    if (!response.ok) {
      await response.body?.cancel();
      throw new Error(`Compatible service request failed (HTTP ${response.status}).`);
    }
    const chunks = [];
    let length = 0;
    for await (const chunk of response.body ?? []) {
      length += chunk.length;
      if (length > 1024 * 1024) throw new Error('Compatible service response exceeded its size limit.');
      chunks.push(Buffer.from(chunk));
    }
    let value;
    try { value = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { throw new Error('Compatible service returned invalid JSON.'); }
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Compatible service returned an invalid response.');
    return value;
  } catch (error) {
    if (combined.aborted) throw new Error('Service request was cancelled or timed out.');
    if (error?.message?.startsWith('Compatible service')) throw error;
    throw new Error('Compatible service request failed. Check the endpoint and supported API; redirects are not followed.');
  }
}
export async function transcribeAudio({ connection, path, signal } = {}) {
  const selected = validateService(connection);
  if (!selected.model) throw new Error('Configure a transcription model before sending audio.');
  const mime = audioTypes.get(extname(String(path)).toLowerCase());
  if (!mime) throw new Error('Choose a WAV, MP3, M4A, MP4, OGG, FLAC, WEBM or MPEG audio file.');
  const input = await boundedFile(path);
  const form = new FormData();
  form.append('model', selected.model);
  form.append('file', new Blob([input.bytes], { type: mime }), basename(input.path));
  const result = await request(selected, '/audio/transcriptions', { body: form, signal });
  if (typeof result.text !== 'string' || !result.text.trim() || Buffer.byteLength(result.text, 'utf8') > 512 * 1024) throw new Error('Compatible service returned no usable transcription text.');
  return result.text;
}
export async function uploadTrainingFile({ connection, path, signal } = {}) {
  if (extname(String(path)).toLowerCase() !== '.jsonl') throw new Error('Training upload requires a JSONL dataset.');
  const input = await boundedFile(path);
  const form = new FormData();
  form.append('purpose', 'fine-tune');
  form.append('file', new Blob([input.bytes], { type: 'application/jsonl' }), basename(input.path));
  const value = await request(connection, '/files', { body: form, signal });
  return { id: identifier(value.id) };
}
function trainingJob(value) {
  const statuses = new Set(['validating_files', 'queued', 'running', 'pausing', 'paused', 'succeeded', 'failed', 'cancelled', 'cancelling']);
  const job = { id: identifier(value.id), status: statuses.has(value.status) ? value.status : 'unknown' };
  for (const name of ['model', 'training_file', 'fine_tuned_model']) if (typeof value[name] === 'string' && value[name].length <= 512 && !controls.test(value[name])) job[name] = value[name];
  for (const name of ['created_at', 'finished_at']) if (Number.isSafeInteger(value[name]) && value[name] >= 0) job[name] = value[name];
  return job;
}
export async function startTrainingJob({ connection, trainingFileId, model, signal } = {}) {
  identifier(trainingFileId);
  const selected = validateService({ ...connection, model });
  if (!selected.model) throw new Error('Select a fine-tunable service model before creating a training job.');
  return trainingJob(await request(selected, '/fine_tuning/jobs', { json: { training_file: trainingFileId, model: selected.model }, signal }));
}
export async function getTrainingJob({ connection, id, signal } = {}) { return trainingJob(await request(connection, `/fine_tuning/jobs/${identifier(id)}`, { method: 'GET', signal })); }
export async function cancelTrainingJob({ connection, id, signal } = {}) { return trainingJob(await request(connection, `/fine_tuning/jobs/${identifier(id)}/cancel`, { json: {}, signal })); }

export async function createTrainingDataset({ messages, directory, cwd = process.cwd() } = {}) {
  if (!Array.isArray(messages)) throw new Error('Dataset export requires text conversation messages.');
  const normalized = [];
  let skippedMessages = 0, inputBytes = 0;
  for (const message of messages) {
    if (!['system', 'user', 'assistant'].includes(message?.role) || typeof message.content !== 'string' || !message.content.trim() || (message.role === 'assistant' && message.status !== undefined && message.status !== 'completed')) { skippedMessages++; continue; }
    inputBytes += Buffer.byteLength(message.content, 'utf8');
    if (inputBytes > MAX_UPLOAD_BYTES) throw new Error('Dataset input exceeds the 25 MiB limit.');
    if (normalized.at(-1)?.role === message.role) normalized.at(-1).content += `\n\n${message.content}`;
    else normalized.push({ role: message.role, content: message.content });
  }
  const history = [], lines = [];
  let bytes = 0;
  for (const message of normalized) {
    if (message.role === 'system' && history.some(item => item.role !== 'system')) { skippedMessages++; continue; }
    if (message.role === 'assistant' && history.at(-1)?.role !== 'user') { skippedMessages++; continue; }
    history.push(message);
    if (message.role === 'assistant') {
      if (lines.length >= 1000) throw new Error('Dataset export exceeds the 1,000-example limit.');
      const line = JSON.stringify({ messages: history }) + '\n';
      bytes += Buffer.byteLength(line, 'utf8');
      if (bytes > MAX_UPLOAD_BYTES) throw new Error('Dataset export exceeds the 25 MiB limit.');
      lines.push(line);
    }
  }
  if (!lines.length) throw new Error('Dataset export needs at least one complete text user-and-assistant exchange.');
  const text = lines.join('');
  const target = safePath(directory ?? join(safePath(cwd), 'training'));
  await mkdir(target, { recursive: true, mode: 0o700 });
  const info = await lstat(target);
  if (!info.isDirectory() || info.isSymbolicLink()) throw new Error('Dataset directory must be a real local directory.');
  const path = join(target, `conversation-${randomUUID()}.jsonl`);
  const file = await open(path, 'wx', 0o600);
  try { await file.writeFile(text, 'utf8'); } finally { await file.close(); }
  return { path, examples: lines.length, bytes, skippedMessages };
}

export function microphoneArgs({ path, seconds = 10, device, platform = process.platform } = {}) {
  const target = safePath(path);
  if (extname(target).toLowerCase() !== '.wav') throw new Error('Microphone recording output must be a WAV file.');
  if (!Number.isSafeInteger(seconds) || seconds < 1 || seconds > 60) throw new Error('Recording duration must be an integer from 1 to 60 seconds.');
  if (device !== undefined && (typeof device !== 'string' || !device || controls.test(device))) throw new Error('Microphone device must be a valid name or index.');
  let format, input;
  if (platform === 'win32') {
    if (!device) throw new Error('Choose the exact Windows microphone device name before recording.');
    format = 'dshow'; input = `audio=${device}`;
  } else if (platform === 'darwin') { format = 'avfoundation'; input = `:${device ?? '0'}`; }
  else if (platform === 'linux') { format = 'pulse'; input = device ?? 'default'; }
  else throw new Error('Microphone recording supports Windows, Linux and macOS.');
  return ['-hide_banner', '-loglevel', 'error', '-nostdin', '-y', '-f', format, '-i', input, '-t', String(seconds), '-vn', '-ac', '1', '-ar', '16000', '-c:a', 'pcm_s16le', '-fs', String(MAX_UPLOAD_BYTES), target];
}
export async function captureMicrophone({ path, seconds = 10, device, platform = process.platform, ffmpegPath = 'ffmpeg', signal } = {}) {
  const args = microphoneArgs({ path, seconds, device, platform });
  const target = safePath(path);
  if (signal?.aborted) throw new Error('Microphone recording was cancelled.');
  let owned = false;
  try {
    let placeholder;
    try { placeholder = await open(target, 'wx', 0o600); owned = true; }
    catch (error) { if (error?.code === 'EEXIST') throw new Error('Recording output already exists and will not be overwritten.'); throw new Error('Recording output directory is unavailable.'); }
    finally { await placeholder?.close(); }
    const command = Array.isArray(ffmpegPath) ? ffmpegPath : [ffmpegPath];
    if (!command.length || command.some(part => typeof part !== 'string' || !part || controls.test(part))) throw new Error('FFmpeg executable is invalid.');
    await new Promise((resolveCapture, reject) => {
      const child = spawn(command[0], [...command.slice(1), ...args], { shell: false, windowsHide: true, stdio: 'ignore' });
      let failure;
      const cancel = () => { failure ??= new Error('Microphone recording was cancelled.'); child.kill(); };
      const timer = setTimeout(() => { failure ??= new Error('Microphone recording timed out. Check the selected device.'); child.kill(); }, Math.max(30000, (seconds + 10) * 1000));
      signal?.addEventListener('abort', cancel, { once: true });
      if (signal?.aborted) cancel();
      child.once('error', error => {
        failure = new Error(error?.code === 'ENOENT' ? 'FFmpeg was not found. Install FFmpeg and make its native executable available on PATH.' : 'Unable to start FFmpeg microphone recording.');
      });
      child.once('close', code => {
        clearTimeout(timer); signal?.removeEventListener('abort', cancel);
        if (failure) reject(failure);
        else if (code !== 0) reject(new Error('Microphone recording failed. Check the selected device and operating-system microphone permission.'));
        else resolveCapture();
      });
    });
    const audio = await boundedFile(target);
    if (audio.bytes.length < 44 || audio.bytes.toString('ascii', 0, 4) !== 'RIFF' || audio.bytes.toString('ascii', 8, 12) !== 'WAVE') throw new Error('Microphone recorder returned no usable WAV audio.');
    return { path: target, seconds, bytes: audio.bytes.length };
  } catch (error) {
    // Only delete the exact absent-before-call file claimed with wx by this capture.
    if (owned) await rm(target, { force: true }).catch(() => {});
    throw error;
  }
}

async function editorExecutable(editor) {
  const windows = process.platform === 'win32';
  const native = editor === 'code' ? 'Code.exe' : 'Cursor.exe';
  const candidates = [];
  for (const dir of (process.env.PATH ?? '').split(delimiter).filter(Boolean)) {
    if (windows) candidates.push(join(dir, native), join(dir, '..', native), join(dir, '..', '..', '..', native));
    else candidates.push(join(dir, editor));
  }
  if (windows) {
    const local = process.env.LOCALAPPDATA;
    const programs = process.env.ProgramFiles;
    for (const root of [local && join(local, 'Programs'), programs].filter(Boolean)) candidates.push(join(root, editor === 'code' ? 'Microsoft VS Code' : 'cursor', native));
  }
  for (const candidate of candidates) {
    try { if (!(await stat(candidate)).isFile()) continue; await access(candidate, windows ? constants.F_OK : constants.X_OK); return resolve(candidate); } catch { /* Next native candidate. */ }
  }
  throw new Error('The selected editor was not found. Install VS Code or Cursor and expose its native launcher on PATH.');
}
export async function openIDE({ cwd = process.cwd(), editor = 'code', launch } = {}) {
  if (!['code', 'cursor'].includes(editor)) throw new Error('Supported editors are code and cursor.');
  const directory = safePath(cwd);
  if (!(await lstat(directory)).isDirectory()) throw new Error('IDE workspace must be a local directory.');
  const executable = launch ? editor : await editorExecutable(editor);
  const options = { executable, args: ['--new-window', directory], cwd: directory, shell: false, windowsHide: false };
  if (launch) return launch(options);
  return new Promise((resolveLaunch, reject) => {
    const editorEnv = { ...process.env };
    delete editorEnv.ELECTRON_RUN_AS_NODE;
    const child = spawn(executable, options.args, { cwd: directory, env: editorEnv, shell: false, windowsHide: false, detached: true, stdio: 'ignore' });
    child.once('error', () => reject(new Error('Unable to open the selected editor.')));
    child.once('spawn', () => { child.unref(); resolveLaunch({ editor, pid: child.pid }); });
  });
}
