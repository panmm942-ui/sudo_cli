"""Read the actual latest Events notice through compact view and PTY scrolling."""
import fcntl
import os
import re
import signal
import struct

def latest_event_text(terminal, starts_with=None):
    if not terminal.view.positioned:
        return ''
    original_rows, original_columns = terminal.view.rows, terminal.view.columns
    # The compact Events view exposes ordinary notice text across 107 cells,
    # retaining exact text assertions without joining unrelated message rows.
    terminal.view.resize(44, 108)
    fcntl.ioctl(terminal.master, __import__('termios').TIOCSWINSZ, struct.pack('HHHH', 44, 108, 0, 0))
    os.kill(terminal.child.pid, signal.SIGWINCH)
    terminal.drain(.15)
    terminal.send('\t\x1b[F')
    terminal.drain(.12)
    collected = []
    try:
        for _ in range(32):
            rows = []
            for index, row in enumerate(terminal.view.grid):
                if 'Events / Notifications' in ''.join(row):
                    rows = [''.join(value[:-2]).rstrip() for value in terminal.view.grid[index+1:terminal.view.rows-4]]
                    break
            if not rows:
                raise AssertionError('Actual compact Events title was absent')
            overlap = 0
            for count in range(1, min(len(rows), len(collected))+1):
                if rows[-count:] == collected[:count]:
                    overlap = count
            collected = rows[:-overlap] + collected if overlap else rows + collected
            starts = [index for index, value in enumerate(collected) if re.match(r'^\d{2}:\d{2} · ', value)]
            for offset, start in reversed(list(enumerate(starts))):
                end = starts[offset+1] if offset+1 < len(starts) else len(collected)
                entry = '\n'.join(collected[start:end]).rstrip()
                body = re.sub(r'^\d{2}:\d{2} · ', '', entry)
                if starts_with is None or body.startswith(starts_with):
                    return entry
            terminal.send('\x1b[5~')
            terminal.drain(.12)
        raise AssertionError('Requested actual Events entry exceeded bounded scroll capture')
    finally:
        terminal.send('\x1b[F\t')
        terminal.view.resize(original_rows, original_columns)
        fcntl.ioctl(terminal.master, __import__('termios').TIOCSWINSZ, struct.pack('HHHH', original_rows, original_columns, 0, 0))
        os.kill(terminal.child.pid, signal.SIGWINCH)
        terminal.drain(.15)
