# Browsing the complete chat

Chat and Events have separate scrollbars and retained text. Tab selects the
panel controlled by navigation keys. The fixed composer stays available while
you browse. The chat area keeps the visible conversation for the current session. Opening a
saved chat or resuming it at startup loads its full saved user and assistant
messages into that area. The dashboard and antenna remain fixed above it.

| Control | Action |
| --- | --- |
| Tab | Select Chat or Events |
| PageUp / PageDown | Move one page in the selected panel |
| Shift+Up / Shift+Down | Move one wrapped row |
| Home / Ctrl+Home | Jump to the first retained row in the selected panel |
| End / Ctrl+End | Return to the newest output in the selected panel |
| Mouse wheel | Move three rows, when the terminal sends SGR mouse events |
| Scrollbar click / drag | Choose a position in that panel |
| Ctrl+A / Ctrl+E | Move the editing caret to the start / end of your draft |
| `/scroll up`, `/scroll down` | Move one page |
| `/scroll top`, `/scroll bottom` | Jump to the beginning / return live |

When you browse older messages, their position stays fixed while new assistant
output arrives. The row immediately below the dashboard shows **New output**.
Ctrl+End returns to that output and restores your unfinished input. Typing or
pasting also returns to the live prompt before accepting the text. Resizing
rewraps the transcript and keeps the same text in view.

The slash command picker owns PageUp and PageDown while it is open. Secret
questions and raw multiline prompts keep their own input behavior. On terminals with mouse
reporting enabled, hold the terminal's usual selection modifier (often Shift)
to select text; support varies by terminal.

`/clear` resets the current visible conversation and scroll position without changing the chat ID, title or prompt counter. Its Yes/No question controls whether earlier AI context is forgotten or retained, including after reopening. `/new` starts a separate chat and resets its visible conversation and scroll position. `/chat open ID`
or the saved chat picker replaces the display with the selected conversation.
Saved data and exports remain controlled by the saved chat commands.

The display retains up to 64 Mi UTF-16 characters, which accommodates the full
50 MiB saved-chat format with its visible labels. An exceptionally large live
session can exceed this display limit; the oldest displayed text is then
removed and browsing shows **Older display text trimmed**. This display limit
does not remove saved messages. The saved-chat storage format has its own
50 MiB limit. Plain output and `TERM=dumb` use ordinary terminal output instead
of the managed viewport.

The renderer caches wrapping separately from header animation. Normal antenna
and clock frames do not scan or rewrap the chat. Color changes apply the current
lower chat theme to replayed user and assistant text; header colors retain
their original palette.

For real Linux or WSL terminal acceptance, run as root with Node 22 or newer:

```sh
python3 -B test/manual/verify-v0.6.9-interface-linux.py --output-directory /tmp/v069-interface-proof
```

This uses temporary settings and a loopback model fixture; it makes no paid
model requests. It checks the actual CLI, editing, separate panels, saved chats
and the GUI sharing the same session. A separate real PTY renderer fixture in
`verify-v0.6.9-panels-linux.py` checks resize/caret, scrollbar drag and terminal
cleanup. Historical manuals retain their original version attribution.
Physical Windows ConsoleHost appearance still needs visual acceptance.
