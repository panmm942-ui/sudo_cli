# Browsing the complete chat

The chat area keeps the visible conversation for the current session. Opening a
saved chat or resuming it at startup loads its full saved user and assistant
messages into that area. The dashboard and antenna remain fixed above it.

| Control | Action |
| --- | --- |
| PageUp / PageDown | Move one page toward older / newer messages |
| Shift+Up / Shift+Down | Move one wrapped row |
| Ctrl+Home | Jump to the first retained message |
| Ctrl+End | Return to the newest output and input prompt |
| Mouse wheel | Move three rows, when the terminal sends SGR mouse events |
| `/scroll up`, `/scroll down` | Move one page |
| `/scroll top`, `/scroll bottom` | Jump to the beginning / return live |

When you browse older messages, their position stays fixed while new assistant
output arrives. The row immediately below the dashboard shows **New output**.
Ctrl+End returns to that output and restores your unfinished input. Typing or
pasting also returns to the live prompt before accepting the text. Resizing
rewraps the transcript and keeps the same text in view.

The slash command picker owns PageUp and PageDown while it is open. Secret
questions and raw multiline prompts keep their own input behavior. Standard
Home and End retain their line-editing behavior. On terminals with mouse
reporting enabled, hold the terminal's usual selection modifier (often Shift)
to select text; support varies by terminal.

`/new` resets the visible conversation and its scroll position. `/chat open ID`
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
python3 -B test/manual/verify-v0.6.4-scroll-linux.py --output-directory /tmp/v064-scroll-proof
```

This uses temporary settings and a saved transcript fixture; it makes no model
requests. It checks the actual CLI, Readline, input controls, screen cells,
saved chat switching, colors, resizing, and terminal cleanup. A separate real
PTY renderer fixture verifies new output arriving while the viewport is paused.
Windows ConsoleHost still needs separate visual acceptance.
