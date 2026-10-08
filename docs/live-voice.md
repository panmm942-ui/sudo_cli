# Continuous voice conversation

Live voice composes microphone capture, compatible speech recognition, normal coding-model turns and compatible generated speech. Recognized text enters the model's conversation with its coding tools. Headphones mode permits speech to interrupt a reply; speaker mode pauses hearing during playback to reduce echo and uses `/stop` for interruption. This is an ASR/AI/TTS flow, with no acoustic echo cancellation or universal native realtime audio claim. Physical microphone/speaker behavior has not been verified here.

The terminal remains the interface. Voice starts only after an explicit command and stops when you turn it off or exit. A missing microphone or speech service produces an actionable error; it never silently substitutes recorded text or a simulated conversation.

## Terminal commands

1. Run `/voice setup` to configure the transcription endpoint and model.
2. Run `/voice speech` to configure the speech endpoint, model and voice.
3. Inspect `/microphone devices`, select `/microphone device "DEVICE NAME"` when needed, then `/microphone on`. Discovery reports installed FFmpeg/device output; it does not prove capture permission or quality.
4. Run `/voice live` or `/live` to start continuous listening and spoken conversation.
5. Use `/voice status` to inspect the mode and `/voice off` to stop it.

`/voice echo headphones|speaker` selects the mode and stops any current voice session before restart. `/voice pause` stops capture and releases the microphone; `/voice resume` starts listening again. `/voice repeat` replays the last spoken reply. `/voice wake PHRASE` filters recognized prompts for a wake phrase, and `/voice wake off` removes that filter. Wake matching occurs after ASR, so the configured transcription service still receives detected audio; it is not a local wake-word detector.

`/voice record SECONDS` and `/voice file PATH` remain available for explicit transcription when you want to review recognized text before submitting it. Live mode submits accepted recognized utterances automatically as literal prompts, without executing slash commands or answering permission questions. It retains the terminal's typed permission approval flow.

## Requirements

- Native FFmpeg and FFplay available on PATH, with an audio input backend for your system.
- An accessible microphone and operating-system permission to use it.
- A transcription endpoint implementing `POST /audio/transcriptions` with WAV multipart uploads and a JSON `text` response.
- A speech endpoint implementing `POST /audio/speech` with `model`, `voice`, `input`, and MP3 `response_format`.
- A running coding-model connection. Local transcription and speech services can be used alongside a local or cloud coding model.

The transcription and speech service can have different URLs, models, and keys. Compatibility with a chat endpoint does not imply that it supports either audio API. The endpoint paths follow the [official transcription API](https://developers.openai.com/api/reference/resources/audio/subresources/transcriptions/methods/create) and [speech API](https://developers.openai.com/api/reference/resources/audio/subresources/speech/methods/create); compatible services must supply these operations themselves.

On Windows, select the exact microphone device name for the DirectShow input. On macOS, select the AVFoundation audio device index, usually `0`. On Linux, capture uses the PulseAudio source name, usually `default`; FFmpeg must support PulseAudio. Device naming and enumeration are described in the [FFmpeg device documentation](https://ffmpeg.org/ffmpeg-devices.html). When launching with sudo on Linux, the elevated process must also have access to the intended user audio server; choose that server/device through your normal PulseAudio configuration.

FFplay runs with `-nodisp -autoexit` and receives audio through standard input. It does not open an application window. See [FFplay's audio playback options](https://ffmpeg.org/ffplay.html).

## Conversation behavior

Microphone samples are mono 16-bit PCM at 16 kHz. A local detector examines 20 ms frames. It adapts its threshold to quiet background noise, keeps 200 ms of pre-roll, starts after 60 ms of detected sound, and finishes after 600 ms of silence. Very short sounds do not become prompts. An uninterrupted phrase is split at a maximum of 20 seconds to bound memory and uploads.

The detector sends a WAV phrase to transcription only after speech ends. Listening continues during transcription. One transcription request runs at a time and one additional phrase can wait. If you speak more phrases before a slow service catches up, the terminal asks you to repeat the dropped phrase instead of accumulating unbounded audio or costs.

In headphones mode, detected speech cancels the speech request/player. Without a wake phrase it also interrupts active AI work immediately; with a wake phrase, AI interruption waits for a matching transcript after ASR. Speaker mode resets the detector and ignores microphone samples during playback, so speech cannot interrupt the reply then; use `/stop`. Speech playback begins while the service streams its response. Long replies are split into requests below that API's input limit while retaining Unicode characters.

Wear headphones when using speech interruption. Energy detection has no acoustic echo cancellation: speaker output entering the microphone can be mistaken for speech in headphones mode. Speaker mode uses half-duplex listening, not echo cancellation. Fans, background conversation, a quiet microphone or long pauses can require adjusting levels/detection thresholds. Latency depends on ASR, the coding model, TTS and the network.

This supports continuous listening and spoken conversation with your selected coding AI. ChatGPT's exact voice backend and a provider's native speech-to-speech model are separate services. The [Realtime API](https://developers.openai.com/api/docs/guides/realtime) requires a compatible realtime model and audio session; an arbitrary coding endpoint cannot acquire that protocol simply by enabling voice.

## Data and shutdown

This module writes no audio recordings to disk. It retains only bounded audio needed for the current phrase and queued transcription, uploads detected speech to your configured transcription service, and streams generated audio into FFplay. Silence stays local and creates no transcription requests. The main conversation records recognized prompts and assistant replies through its normal chat history.

Keys remain in memory and are omitted from status snapshots and errors. Endpoint redirects are rejected so credentials are never forwarded to another URL. Requests have deadlines, response buffers have size limits, and provider error bodies are not printed.

Stopping aborts transcription and speech requests, discards pending phrases, terminates both audio processes, and waits for them to exit. A microphone failure stops the mode and asks you to check the device before restarting. Restart uses a fresh detector and does not deliver an old cancelled transcript.

## Integration API

```js
import { createLiveVoice } from '../src/live-voice.mjs';

const voice = createLiveVoice({
  transcription: { baseUrl: asrUrl, model: asrModel, apiKey: asrKey },
  speech: { baseUrl: speechUrl, model: speechModel, apiKey: speechKey, voice: voiceName },
  device: microphoneName,
  echoMode: 'headphones', // or 'speaker': hearing pauses during playback
  onSpeechStart: () => interruptActiveAiTurn(),
  onTranscript: text => queueNormalUserPrompt(text),
  onState: state => refreshVoiceStatus(state),
  onError: error => displaySafeMessage(error.message),
});

await voice.start();
await voice.speak(assistantReply); // { interrupted, spokenCharacters }
voice.interruptSpeech();         // Microphone keeps listening.
await voice.stop();
```

The factory is synchronous. `start`, `stop`, and `speak` return promises; `snapshot` and `interruptSpeech` are synchronous. `onTranscript` should enqueue the prompt promptly; the audio subsystem does not await an entire AI task. Spoken transcripts are user prompts, not permission approvals or automatically executed slash commands.

`snapshot()` exposes `running`, `listening`, `hearing`, `transcribing`, `speaking`, `echoMode`, `queuedPhrases`, `droppedPhrases`, `transcribedPhrases`, and a display `status`. No endpoint keys, raw audio, or transcript contents appear in the snapshot. An optional `signal` stops the entire mode. The optional `vad` settings can adjust `threshold`, `noiseRatio`, `preRollMs`, `startSpeechMs`, `minSpeechMs`, `endSilenceMs`, and `maxPhraseMs` within validated bounds; the maximum phrase duration remains 20 seconds. The terminal handles pause/resume/repeat and the post-ASR wake filter around this low-level module.

Native executable boundaries can be supplied with `captureCommand` and `playbackCommand` as an executable or executable-and-prefix-argument array. Both are launched without a shell and with hidden windows. Native capture/output arguments are appended, preserving device text literally. These boundaries also permit verification with synthetic recorders and players without accessing a real microphone or playing audio.

## Verification

Tests use synthesized speech-like PCM, silence, actual child processes, and local HTTP services. They verify phrase onset and pre-roll, noise rejection, original sample alignment across odd chunk boundaries, bounded continuous speech, multipart WAV transcription, streamed playback, interruption, backlog behavior, redirect/secret handling, malformed or oversized responses, asynchronous callback isolation, cancellation, restart, and child exit before restart.

The same fixtures run under Windows and native Linux. The POSIX child that deliberately ignores SIGTERM is skipped on Windows. Hardware microphone permission, real speaker/headphone behavior, provider quality, and native macOS audio still need testing on the user's configured devices and services.
