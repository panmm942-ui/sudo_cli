"""Small ECMA-48 observer shared by the current native CLI acceptances.

It observes rendered cells and the actual caret; it never runs a CLI or imports
another acceptance's main routine. Historical append-only text is not readiness.
"""
import codecs
import re

CSI = re.compile(r'\x1b\[([0-?]*)([ -/]*)([@-~])')
OSC = re.compile(r'\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)')
ANSI = re.compile(r'\x1b(?:\[[0-?]*[ -/]*[@-~]|[@-_])')
PROMPT = re.compile(r'^(\s*\d{2}:\d{2} (\d+)@you > )')


def install_gpu_fixture(root, env):
    """Keep PTY acceptances silent and block physical device utilities."""
    preferences = root / 'state/preferences'
    preferences.mkdir(parents=True, exist_ok=True, mode=0o700)
    preference = preferences / 'notifications.json'
    preference.write_text('{"version":1,"enabled":false}\n')
    preference.chmod(0o600)
    observer = root / 'synthetic-gpu-observer.mjs'
    observer.write_text('import cp from "node:child_process";import{syncBuiltinESMExports}from"node:module";const original=cp.spawn,originalExecFile=cp.execFile;cp.execFile=function(command,...args){if(/(?:^|[\\\\/])(?:paplay|aplay|afplay)(?:\\.exe)?$/.test(String(command)))throw new Error("Synthetic audio fixture: unavailable");return originalExecFile.call(this,command,...args);};cp.spawn=function(command,...args){if(/(?:^|[\\\\/])(?:nvidia-smi|ioreg|paplay|aplay|afplay)(?:\\.exe)?$/.test(String(command)))throw new Error("Synthetic GPU fixture: unavailable");return original.call(this,command,...args);};syncBuiltinESMExports();\n')
    env['PATH'] = '/usr/bin:/bin'
    env['NODE_OPTIONS'] = (env.get('NODE_OPTIONS', '') + ' --import ' + observer.resolve().as_uri()).strip()


def rendered_text(raw):
    """Search transcript text, retaining content painted inside saved frames."""
    text = raw.decode('utf-8', errors='replace') if isinstance(raw, bytes) else str(raw)
    text = OSC.sub('', text)
    # An absolute row write is a new visible line, not adjacent prose. Keep
    # spaces within each row; assertions still require the original responses.
    text = re.sub(r'\x1b\[[\d;]*[Hf]', '\n', text)
    return ANSI.sub('', text).replace('\x07', '')


class TerminalView:
    def __init__(self, rows=44, columns=150):
        self.decoder = codecs.getincrementaldecoder('utf-8')('replace')
        self.pending = ''
        self.visible = True
        self.saved = None
        self.depth = 0
        self.positioned = False
        self.tail = ''
        self.resize(rows, columns)

    def resize(self, rows, columns):
        self.rows, self.columns = rows, columns
        self.grid = [[' '] * columns for _ in range(rows)]
        self.row = self.column = 0
        self.top, self.bottom = 0, rows - 1

    def feed(self, data):
        decoded = self.decoder.decode(data)
        self.tail = (self.tail + decoded)[-8192:]
        self.pending += decoded
        index = 0
        while index < len(self.pending):
            char = self.pending[index]
            if char == '\x1b':
                if index + 1 == len(self.pending): break
                following = self.pending[index + 1]
                if following == ']':
                    match = OSC.match(self.pending, index)
                    if not match: break
                    index = match.end(); continue
                match = CSI.match(self.pending, index)
                if match:
                    self.csi(match[1], match[3]); index = match.end(); continue
                if following == '[': break
                if following == '7': self.saved = (self.row, self.column); self.depth += 1
                elif following == '8':
                    self.depth -= 1
                    if self.saved: self.row, self.column = self.saved
                index += 2; continue
            if char == '\r': self.column = 0
            elif char == '\n': self.linefeed()
            elif char == '\b': self.column = max(0, self.column - 1)
            elif char == '\t': self.column = min(self.columns - 1, (self.column // 8 + 1) * 8)
            elif ord(char) >= 32:
                if self.column >= self.columns: self.column = 0; self.linefeed()
                self.grid[self.row][self.column] = char; self.column += 1
            index += 1
        self.pending = self.pending[index:]

    def linefeed(self):
        if self.row == self.bottom:
            del self.grid[self.top]; self.grid.insert(self.bottom, [' '] * self.columns)
        else: self.row = min(self.rows - 1, self.row + 1)

    def csi(self, parameters, final):
        if parameters.startswith('?'):
            if parameters == '?25': self.visible = final == 'h'
            return
        values = [int(value or 0) for value in parameters.split(';')] if parameters else [0]
        count = values[0] or 1
        if final in ('H', 'f'):
            self.positioned = True
            self.row = min(self.rows - 1, max(0, count - 1))
            self.column = min(self.columns - 1, max(0, (values[1] if len(values) > 1 else 1) - 1))
        elif final == 'G': self.column = min(self.columns - 1, count - 1)
        elif final == 'A': self.row = max(0, self.row - count)
        elif final == 'B': self.row = min(self.rows - 1, self.row + count)
        elif final == 'C': self.column = min(self.columns - 1, self.column + count)
        elif final == 'D': self.column = max(0, self.column - count)
        elif final == 'r':
            self.top = max(0, (values[0] or 1) - 1)
            self.bottom = min(self.rows - 1, (values[1] if len(values) > 1 and values[1] else self.rows) - 1)
            self.row = self.column = 0
        elif final == 'J':
            if values[0] == 2: self.grid = [[' '] * self.columns for _ in range(self.rows)]
            elif values[0] == 0:
                self.grid[self.row][self.column:] = [' '] * (self.columns - self.column)
                for row in range(self.row + 1, self.rows): self.grid[row] = [' '] * self.columns
        elif final == 'K':
            if values[0] == 2: self.grid[self.row] = [' '] * self.columns
            elif values[0] == 0: self.grid[self.row][self.column:] = [' '] * (self.columns - self.column)

    def balanced(self):
        return self.depth == 0 and not self.pending and not self.decoder.getstate()[0]

    def text(self): return '\n'.join(''.join(row) for row in self.grid)

    def events_text(self):
        for index, row in enumerate(self.grid):
            text = ''.join(row)
            column = text.find('Events / Notifications')
            if column >= 0:
                left = max(0, column - 2)
                return '\n'.join(''.join(item[left:]).rstrip() for item in self.grid[index + 1:])
        return ''

    def composer(self):
        if not self.positioned:
            match = re.search(r'(?:\r?\n|^)(\d{2}:\d{2} (\d+)@you > )(.*)\Z', rendered_text(self.tail))
            return {'sequence': int(match[2]), 'draft': match[3], 'empty': not match[3]} if match else None
        # The composer is near the bottom; Chat retains numbered historical
        # prompts elsewhere. Its exact caret, not a text echo, owns input.
        if not self.balanced() or not self.visible or self.row < max(0, self.rows - 4): return None
        for start in range(max(0, self.rows - 4), self.row + 1):
            line = ''.join(self.grid[start]).split('│', 1)[0].rstrip()
            match = PROMPT.match(line + ' ')
            if not match: continue
            prefix = match[1]
            draft = line[len(prefix):] if len(line) >= len(prefix) else ''
            if self.row > start:
                draft += ''.join(''.join(self.grid[index]).split('│', 1)[0].rstrip() for index in range(start + 1, self.row + 1))
            return {'sequence': int(match[2]), 'draft': draft, 'empty': not draft and self.row == start and self.column == len(prefix)}
        return None

    def ready(self, previous=None):
        value = self.composer()
        if not value or not value['empty']: return False
        if self.positioned and re.search(r'Status:\s*Working\b', '\n'.join(''.join(row) for row in self.grid[:15])): return False
        return previous is None or value['sequence'] != previous


def ready_prompt_visible(raw, rows=44, columns=150):
    view = TerminalView(rows, columns); view.feed(raw)
    return view.ready()


def verify_ready_prompt_regression():
    prefix = '12:34 02@you > '
    def frame(draft='', *, status='Not Working', caret=None, suffix=''):
        return ('\x1b7\x1b[3;1HStatus: '+status+'\x1b[41;1H'+prefix+draft+' ' * 20+
                '\x1b8\x1b[41;'+str(len(prefix) + 1 if caret is None else caret)+'H'+suffix).encode()
    cases = [(frame(), True), (frame(suffix='\x07\x07'), True),
             (frame(suffix='\x1b]0;private title\x07\x07'), True),
             (frame('/permissions allow-everything'), False), (frame(status='Working'), False),
             (frame(caret=1), False), (frame(suffix='VISIBLE\x07'), False),
             (b'\n12:34 02@you > ', True), (b'\n12:34 02@you > /status', False),
             (b'\n12:34 02@you > \nWorking\n', False), (frame()[:-1], False)]
    for raw, expected in cases: assert ready_prompt_visible(raw) is expected, repr(raw)
    view = TerminalView()
    for value in frame(): view.feed(bytes([value]))
    assert view.ready() and not view.ready(previous=2)
    assert 'Status: Not Working' in rendered_text(frame())
    assert prefix in rendered_text(frame())
    return len(cases) + 3
