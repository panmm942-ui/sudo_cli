# Voice, training and external editors

Voice transcription and training use separately configured compatible HTTP services. Their endpoint, model and optional API key stay in the running process. They are not inferred from the chat connection or saved to a configuration file. A provider must implement the requested API and support the selected model. Chat compatibility alone does not imply transcription or fine-tuning support.

## Voice input

Transcription sends the selected local audio file and transcription model to `POST /audio/transcriptions`, relative to the configured base URL. WAV, MP3, M4A, MP4, OGG, FLAC, WEBM and MPEG inputs are accepted up to 25 MiB. The service returns text, which the terminal can place in the next prompt. There is no background microphone listener.

Microphone capture is an explicit operation requiring an installed native FFmpeg executable and operating-system permission. It records mono 16 kHz PCM WAV for 1–60 seconds; the default is 10 seconds. The watchdog leaves time for device startup and WAV finalization, with a minimum of 30 seconds and a maximum of 70 seconds. Windows requires the exact DirectShow microphone name. macOS uses the AVFoundation audio device index, default `0`. Linux uses a PulseAudio source, default `default`, including PulseAudio-compatible PipeWire configurations. Device availability depends on the host. FFmpeg is launched directly without a shell, and device names are literal arguments.

Capture claims a new output file and refuses to overwrite existing files. Cancellation terminates the owned recording process and removes the owned incomplete file; failed captures are cleaned up too. A successful capture leaves the WAV for the caller to transcribe or remove. The UI owns temporary recordings and their final cleanup.

These request fields follow the [compatible transcription API](https://developers.openai.com/api/reference/resources/audio/subresources/transcriptions/methods/create). Native device selection follows FFmpeg's [DirectShow](https://ffmpeg.org/ffmpeg-devices.html#dshow), [AVFoundation](https://ffmpeg.org/ffmpeg-devices.html#avfoundation) and [PulseAudio](https://ffmpeg.org/ffmpeg-devices.html#pulse) documentation.

## Training

Dataset export creates a new local JSONL file. Only text `system`, `user` and `assistant` messages are included. Adjacent messages with the same role are merged; tool messages, unsupported content and assistant messages marked incomplete are excluded. Each complete user-and-assistant exchange produces one example with preceding conversation history. An unfinished final user turn is absent from the examples. The exporter copies only role and content fields; the caller supplies the sanitized conversation. Export is limited to 25 MiB and 1,000 examples, and creates files with private permissions where the OS supports them.

Uploading explicitly sends a JSONL file to `POST /files` with multipart `purpose=fine-tune`. Starting explicitly sends its returned file ID and a fine-tunable model to `POST /fine_tuning/jobs`. Inspecting uses `GET /fine_tuning/jobs/{id}`; cancellation uses `POST /fine_tuning/jobs/{id}/cancel`. Export alone creates no remote file or training job. Fine-tuning changes a provider-managed model through that provider's service; it does not train arbitrary locally loaded model weights or change the selected chat model automatically.

The terminal requires explicit confirmation before starting a potentially charged job. The low-level module exposes these calls separately so the UI can present the selected service, dataset and model before submission. Provider pricing, minimum example counts, supported models, upload retention and cancellation billing vary. Review the dataset before uploading; a remote file may persist after cancellation. API compatibility is based on the [file upload fields](https://developers.openai.com/api/reference/resources/files/methods/create) and [fine-tuning endpoints](https://developers.openai.com/api/reference/resources/fine_tuning).

All service requests reject URLs containing embedded credentials, queries or fragments. HTTP is available for explicitly selected local or private endpoints. Credentials are Bearer headers, redirects are refused, requests time out after 60 seconds, and JSON response bodies are bounded to 1 MiB. Errors report an HTTP status or an actionable local message without printing remote bodies or API keys. Job results expose only their ID, recognized status and selected metadata.

## IDE integration

Explicit editor launch opens the working directory in installed VS Code (`code`) or Cursor (`cursor`) as one literal argument in a new window. The codexcli interface remains in the terminal. Unix uses the installed native command from PATH; Windows discovers `Code.exe` or `Cursor.exe` and launches it directly rather than invoking a batch wrapper. This version opens the project; it does not install editor extensions, inject editor settings or promise an embedded chat panel.

## Module interface

```js
const connection = validateService({ baseUrl, model, apiKey }); // RAM only
const text = await transcribeAudio({ connection, path, signal });
const audio = await captureMicrophone({
  path, seconds: 10, device, ffmpegPath: 'ffmpeg', signal,
}); // {path, seconds, bytes}

const dataset = await createTrainingDataset({ messages, directory, cwd });
// {path, examples, bytes, skippedMessages}
const file = await uploadTrainingFile({ connection, path: dataset.path, signal });
// {id}
const job = await startTrainingJob({
  connection, trainingFileId: file.id, model: fineTunableModel, signal,
});
const current = await getTrainingJob({ connection, id: job.id, signal });
const cancelled = await cancelTrainingJob({ connection, id: job.id, signal });

await openIDE({ cwd, editor: 'code' }); // {editor, pid}
```

`validateService` permits an omitted model for file upload and job inspection; transcription and job creation require one. `createTrainingDataset` defaults to a `training` subdirectory of `cwd` when no directory is supplied. `skippedMessages` counts discarded unsupported or out-of-order messages; merging and leaving out an unfinished final turn do not increment it. `microphoneArgs` is exported for native backend verification, and `openIDE` accepts an injected `launch` function for tests.

Tests use local HTTP fixtures, owned temporary files, a synthetic child recorder and an injected editor launcher. They verify requests, bounds, cancellation, private error handling and native argument selection on Windows and Linux without paid service calls, real microphone access or real editor windows. Native macOS recording and editor launch still require verification on a Mac.
