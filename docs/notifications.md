# Notification sounds

`/notify on` enables sounds. `/notify off` stops sounds and cancels queued playback.
The preference is saved locally and works before connecting an AI.

| Event | Sound |
| --- | --- |
| Approval needed | A higher, repeating question-like motif |
| Error | Three low, descending notes |
| AI finished | Three rising notes |
| AI interrupted | Three falling notes |
| Connection established | Two rising notes |
| Connection lost | Two falling notes |

`/notify status` shows the preference, current backend and last delivery outcome.
`/notify test approval`, `/notify test error`, `/notify test done` and
`/notify test interrupted` preview the motifs. Tests respect the On/Off preference.
`/reset notify` restores On.

Approval, completion, interruption and error events use their corresponding
motifs. A saved model selection does not establish a live API connection. Local
commands and setup do not generate AI completion alerts. Notifications contain
no speech, prompt text or model output, and send nothing to a remote service.

Windows uses its built-in SoundPlayer. macOS uses `afplay`; Linux uses `paplay`
or `aplay` when installed. The original WAV files are generated in private
temporary storage and removed when sounds stop or the CLI closes. Missing audio
players can fall back to different terminal-bell rhythms; the status reports
that fallback. Terminal and operating-system mute settings can prevent audible
sound. Failed playback is reported as unavailable, not as played.

Sounds run asynchronously, with a bounded queue, cooldown, duplicate-event
protection and a timeout. Noninteractive commands remain silent. Enabling sounds
never grants microphone access or permission to run AI tools.
