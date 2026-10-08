# Terminal colors

The default lower chat colors are:

| Area | Default |
| --- | --- |
| Background | Near-black, `#0B0F14` |
| Your input and saved user messages | Bright green, `#00FF00` |
| Assistant replies and notices | Soft white, `#DCE3EB` |

Existing saved choices are retained. Use a reset command to return to these defaults.

`/bgcolor COLOR` changes the conversation and input area's background. The upper
dashboard, logo and animated antenna keep their original colors. Empty rows in
the lower area receive the new background, and visible chat redraws immediately.

`/textcolor COLOR` changes your typed text and your displayed conversation text.
Assistant responses and notices use a separate soft-white foreground. Both settings
are saved privately and restored when the CLI starts again.

```text
/bgcolor white
/textcolor navy
/bgcolor #182230
/textcolor #DCE3EB
/bgcolor reset
/textcolor reset
```

Supported names are black, white, red, green, lime, blue, cyan/aqua,
magenta/fuchsia, yellow, orange, purple, pink, gray/grey, silver, darkgray/darkgrey,
lightgray/lightgrey, navy, teal, olive, maroon, brown and nearblack. Hex colors
require all six digits: `#RRGGBB`. `reset`, `default` and `normal` restore a color's default.

`/textcolor lime` is bright green (`#00FF00`). The named color `green` is darker (`#008000`).
`/bgcolor status` or `/textcolor status` prints the current saved choices.

When the chosen text color is too similar to the background, the CLI temporarily
uses black or white to reach a contrast ratio of at least 4.5:1. It retains your
requested text color, reports the adjustment, and restores that color whenever a
later background makes it readable. Notices and prompt accents receive the same
contrast protection. On a light background, assistant replies and notices may
use black instead of soft white for readability.

```text
/reset textcolor
/reset bgcolor
/reset colors
/reset
```

`/bgcolor reset` and `/textcolor reset` restore only their own setting. The first
two `/reset` examples do the same. `/reset colors` restores both colors.
`/reset` lists the available reset targets and asks for a number or name; Enter
cancels. `/reset list` shows targets without asking. Color changes do not reset a model,
erase chats or modify project files.

`NO_COLOR`, `TERM=dumb` and redirected output suppress color escapes. Preferences
remain saved so a later color-capable terminal can use them. Terminal apps may
map RGB colors to their available palette; full RGB support gives the intended
contrast and colors.
