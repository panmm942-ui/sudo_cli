# Terminal colors

`/bgcolor COLOR` changes the conversation and input area's background. The upper
dashboard, logo and animated antenna keep their original colors. Empty rows in
the lower area receive the new background, and visible chat redraws immediately.

`/txtcolor COLOR` changes your typed text and your displayed conversation text.
Assistant responses and notices use a separate readable foreground. Both settings
are saved privately and restored when the CLI starts again.

```text
/bgcolor white
/txtcolor navy
/bgcolor #182230
/txtcolor #DCE3EB
```

Supported names are black, white, red, green, lime, blue, cyan/aqua,
magenta/fuchsia, yellow, orange, purple, pink, gray/grey, silver, darkgray/darkgrey,
lightgray/lightgrey, navy, teal, olive, maroon, brown and nearblack. Hex colors
require all six digits: `#RRGGBB`. `default` and `normal` restore a color's default.

When the chosen text color is too similar to the background, the CLI temporarily
uses black or white to reach a contrast ratio of at least 4.5:1. It retains your
requested text color, reports the adjustment, and restores that color whenever a
later background makes it readable. Notices and prompt accents receive the same
contrast protection. The default background is `#0B0F14`; default user text is
`#DCE3EB`.

```text
/reset txtcolor
/reset bgcolor
/reset colors
/reset
```

The first two restore only the named color. `/reset colors` restores both colors.
`/reset` lists the available reset targets and asks for a number or name; Enter
cancels. `/reset list` shows targets without asking. Color changes do not reset a model,
erase chats or modify project files.

`NO_COLOR`, `TERM=dumb` and redirected output suppress color escapes. Preferences
remain saved so a later color-capable terminal can use them. Terminal apps may
map RGB colors to their available palette; full RGB support gives the intended
contrast and colors.
