"""Match one complete current Events entry across narrow terminal rows."""
import re


def current_event_contains(view, expected, *, latest=False):
    groups = []
    for index, row in enumerate(view.grid):
        title = ''.join(row).find('Events / Notifications')
        if title < 0:
            continue
        left = max(0, title - 2)
        for next_row in view.grid[index + 1:]:
            # The right-edge scrollbar is followed by the reserved terminal
            # margin. Exclude its cell, retaining all actual event text.
            line = ''.join(next_row[left:]).rstrip()
            if line.endswith(('█', '░', '│')):
                line = line[:-1]
            line = line.strip()
            if re.match(r'^\d{2}:\d{2} · ', line):
                groups.append(line)
            elif groups and line:
                groups[-1] += line
        break
    target = ''.join(expected.split())
    return bool(target) and any(target in ''.join(group.split()) for group in (groups[-1:] if latest else groups))

event_contains = current_event_contains
