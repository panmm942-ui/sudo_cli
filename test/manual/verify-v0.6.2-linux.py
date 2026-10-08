#!/usr/bin/env python3
"""Exercise the live slash picker and local-file inspection through real Linux PTYs.

Run as root from the product directory:
  python3 -B test/manual/verify-v0.6.2-linux.py --output-directory /tmp/v062-proof

The CLI, readline, pinned native engine, sandbox, provider bridge and saved chat
are real. A deterministic loopback server supplies streamed model responses.
The renamed GGUF is a synthetic header, never usable model weights. This test
does not install a runner, import a real model, or use paid AI/audio/desktop apps.
Every CLI gets private HOME/XDG/TMPDIR, project and state. Evidence is redacted.
"""
import argparse
from event_scroll_fixture import latest_event_text
from question_fixture import install_question_fixture, active_submission_question
from terminal_view import TerminalView, rendered_text, ready_prompt_visible, install_gpu_fixture, verify_ready_prompt_regression as verify_terminal_readiness
import fcntl
import http.server
import json
import os
from pathlib import Path
import pty
import re
import select
import shutil
import signal
import socketserver
import struct
import subprocess
import sys
import tempfile
import termios
import threading
import time


parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument('--output-directory', type=Path)
parser.add_argument('--node', default=shutil.which('node'))
parser.add_argument('--skip-inventory', action='store_true', help='Diagnostic run only; skips the exhaustive registry selection pass.')
arguments = parser.parse_args()
if sys.platform != 'linux' or os.geteuid() != 0:
    raise SystemExit('Run this real Linux PTY acceptance as root (WSL: --user root).')
if not arguments.node:
    raise SystemExit('Node >=22 must be on PATH, or pass --node /absolute/node.')
PROJECT = Path(__file__).resolve().parents[2]
NODE = arguments.node
ENGINE = subprocess.check_output([NODE, '--input-type=module', '-e',
    'import {localCodex} from "./src/local-engine.mjs"; process.stdout.write(localCodex());'],
    cwd=PROJECT, text=True).strip()
ENGINE = ENGINE if Path(ENGINE).is_absolute() else shutil.which(ENGINE)
if not ENGINE or not Path(ENGINE).is_file():
    raise SystemExit('Install the pinned native Linux Codex runtime first.')
COMMANDS = json.loads(subprocess.check_output([NODE, '--input-type=module', '-e',
    'import {COMMANDS} from "./src/commands.mjs"; console.log(JSON.stringify(COMMANDS.map(x=>x.name)));'],
    cwd=PROJECT, text=True))
OUTPUT = arguments.output_directory.resolve() if arguments.output_directory else Path(tempfile.mkdtemp(prefix='sudocli-v062-proof-'))
OUTPUT.mkdir(parents=True, exist_ok=True)
SECRET = '/V062-hidden-local-credential'
CLOUD_SECRET = 'V062-unrelated-inherited-cloud-credential'
ANSI = re.compile(rb'\x1b(?:\][^\x07]*?(?:\x07|\x1b\\)|\[[0-?]*[ -/]*[@-~]|[@-_])')
SGR = re.compile(rb'\x1b\[[0-9;]*m')
requests, catalogs, fixture_errors, terminals, isolation_roots = [], [], [], [], []
request_lock = threading.Lock()
results = {}
print(f'Sanitized native acceptance evidence: {OUTPUT}', flush=True)


def plain(raw):
    return rendered_text(raw)




def sanitized(value):
    text = value if isinstance(value, str) else json.dumps(value, indent=2)
    for secret in [SECRET, CLOUD_SECRET]:
        text = text.replace(secret, '[redacted]')
    for root in isolation_roots:
        text = text.replace(str(root), '[isolated-root]')
    return text


class Server(socketserver.ThreadingMixIn, http.server.HTTPServer):
    daemon_threads = True


class Fixture(http.server.BaseHTTPRequestHandler):
    def do_GET(self):
        try:
            assert self.path == '/v1/models', self.path
            assert self.headers.get('authorization') == 'Bearer '+SECRET, 'Explicit local key was not used'
            catalogs.append({'path': self.path, 'explicitLocalAuthentication': True})
            self.reply_json({'data': [{'id': 'fixture-local-v062'}]})
        except Exception as error:
            fixture_errors.append(repr(error))
            self.send_error(500, 'fixture validation failed')

    def do_POST(self):
        try:
            assert self.path == '/v1/chat/completions', self.path
            assert self.headers.get('authorization') == 'Bearer '+SECRET, 'Explicit local key was not used'
            body = json.loads(self.rfile.read(int(self.headers['content-length'])))
            assert body.get('stream') is True, 'Native model request did not stream'
            with request_lock:
                requests.append(body)
                index = len(requests)
            latest = next((str(item.get('content', '')) for item in reversed(body['messages'])
                           if item.get('role') == 'user'), '')
            if 'V062_BUSY_STOP' in latest:
                time.sleep(12)
            self.reply_stream(index, body['model'])
        except (BrokenPipeError, ConnectionResetError):
            pass
        except Exception as error:
            fixture_errors.append(repr(error))
            self.send_error(500, 'fixture validation failed')

    def reply_json(self, value):
        raw = json.dumps(value).encode()
        self.send_response(200)
        self.send_header('content-type', 'application/json')
        self.send_header('content-length', str(len(raw)))
        self.end_headers()
        self.wfile.write(raw)

    def reply_stream(self, index, model):
        self.send_response(200)
        self.send_header('content-type', 'text/event-stream')
        self.end_headers()

        def chunk(delta, finish=None, usage=None):
            payload = {'id': f'chatcmpl-v062-{index}', 'object': 'chat.completion.chunk',
                       'created': 1, 'model': model,
                       'choices': [] if usage else [{'index': 0, 'delta': delta, 'finish_reason': finish}]}
            if usage:
                payload['usage'] = usage
            self.wfile.write(('data: '+json.dumps(payload)+'\n\n').encode())
            self.wfile.flush()

        chunk({'role': 'assistant'})
        answer = f'V062 response {index} from {model}.'
        for start in range(0, len(answer), 13):
            chunk({'content': answer[start:start+13]})
            time.sleep(.02)
        chunk({}, 'stop')
        chunk({}, usage={'prompt_tokens': 150, 'completion_tokens': 20, 'total_tokens': 170})
        self.wfile.write(b'data: [DONE]\n\n')
        self.wfile.flush()

    def log_message(self, *_):
        pass


server = Server(('127.0.0.1', 0), Fixture)
threading.Thread(target=server.serve_forever, daemon=True).start()
BASE_URL = f'http://127.0.0.1:{server.server_port}/v1'


class Terminal:
    def __init__(self, root, *, columns=150, rows=44, no_color=False, term='xterm-256color'):
        self.transcript = bytearray()
        self.view = TerminalView(rows, columns)
        self.ready_previous = {}
        self.alternate_screen = term != 'dumb'
        self.workspace, self.state = root/'project', root/'state'
        for name in ['project', 'home', 'xdg-config', 'xdg-data', 'xdg-state', 'xdg-cache', 'xdg-runtime', 'tmp']:
            (root/name).mkdir(parents=True, exist_ok=True, mode=0o700)
        self.master, slave = pty.openpty()
        fcntl.ioctl(self.master, termios.TIOCSWINSZ, struct.pack('HHHH', rows, columns, 0, 0))
        env = {'PATH': os.environ.get('PATH', '/usr/bin:/bin'), 'TERM': term, 'LANG': 'C.UTF-8',
               'HOME': str(root/'home'), 'TMPDIR': str(root/'tmp'),
               'XDG_CONFIG_HOME': str(root/'xdg-config'), 'XDG_DATA_HOME': str(root/'xdg-data'),
               'XDG_STATE_HOME': str(root/'xdg-state'), 'XDG_CACHE_HOME': str(root/'xdg-cache'),
               'XDG_RUNTIME_DIR': str(root/'xdg-runtime'), 'SUDO_CLI_CODEX': str(ENGINE),
               'SUDO_CLI_STATE_DIR': str(self.state), 'SUDO_CLI_MODEL': 'inherited-cloud-model',
               'SUDO_CLI_BASE_URL': 'https://unused-cloud.invalid/v1',
               'SUDO_CLI_TRANSPORT': 'responses', 'SUDO_CLI_API_KEY': CLOUD_SECRET}
        if no_color:
            env['NO_COLOR'] = '1'
        install_gpu_fixture(root, env)
        self.questions = install_question_fixture(root, env)
        self.child = subprocess.Popen([NODE, str(PROJECT/'bin/sudocli.mjs'), '--cwd', str(self.workspace)],
            cwd=self.workspace, env=env, stdin=slave, stdout=slave, stderr=slave, start_new_session=True)
        os.close(slave)
        terminals.append(self)

    def drain(self, duration=.15):
        end = time.monotonic()+duration
        while time.monotonic() < end:
            readable, _, _ = select.select([self.master], [], [], min(.05, max(.001, end-time.monotonic())))
            if readable:
                try:
                    data = os.read(self.master, 65536)
                    if not data:
                        return
                    self.transcript.extend(data)
                    self.view.feed(data)
                except OSError:
                    return

    def read_until(self, predicate, *, timeout=30, expectation='PTY expectation'):
        end = time.monotonic()+timeout
        while time.monotonic() < end:
            if predicate(bytes(self.transcript)):
                return
            self.drain(.1)
            if self.child.poll() is not None:
                break
        raise AssertionError(f'{expectation} not observed; exit={self.child.poll()}; recent={plain(bytes(self.transcript[-4000:]))!r}')

    def send(self, text):
        self.drain(.04)
        marker = len(self.transcript)
        prior = self.view.composer()
        reset = text.strip().startswith(('/new', '/chat open'))
        self.ready_previous[marker] = prior['sequence'] if prior and prior['empty'] and text.endswith(('\n','\r')) and not reset else None
        os.write(self.master, text.encode())
        return marker

    def ready(self, marker=0):
        self.read_until(lambda raw: len(raw)>marker and self.view.ready(self.ready_previous.get(marker)) and active_submission_question(self.questions), expectation='ready prompt')

    def command(self, text):
        marker = self.send(text+'\n')
        self.ready(marker)
        assert not fixture_errors, fixture_errors
        event = latest_event_text(self)
        return plain(bytes(self.transcript[marker:]))+'\n'+event

    def answer(self, marker, label, value):
        self.read_until(lambda raw: label in plain(raw[marker:]), expectation=label)
        return self.send(value+'\n')

    def picker(self):
        marker = self.send('/')
        self.read_until(lambda raw: 'Commands' in plain(raw[marker:]), timeout=3, expectation='immediate slash picker')
        return marker

    def resize(self, columns, rows):
        marker = len(self.transcript)
        self.view.resize(rows, columns)
        fcntl.ioctl(self.master, termios.TIOCSWINSZ, struct.pack('HHHH', rows, columns, 0, 0))
        os.kill(self.child.pid, signal.SIGWINCH)
        self.drain(.3)
        assert self.child.poll() is None, 'Resize ended the CLI'
        return marker

    def finish(self):
        self.send('\x15/quit\n')
        deadline = time.monotonic()+10
        while self.child.poll() is None and time.monotonic() < deadline:
            self.drain(.1)
        self.child.wait(timeout=5)
        self.drain(.1)
        assert self.child.returncode == 0, self.child.returncode
        if self.alternate_screen:
            assert b'\x1b[?1049h' in self.transcript and b'\x1b[?1049l' in self.transcript
        else:
            assert b'\x1b[?1049h' not in self.transcript and b'\x1b[?1049l' not in self.transcript
        assert SECRET.encode() not in self.transcript, 'Explicit local key printed'
        assert CLOUD_SECRET.encode() not in self.transcript, 'Inherited cloud key printed'

    def close(self):
        if self.child.poll() is None:
            self.child.terminate()
            try:
                self.child.wait(timeout=5)
            except subprocess.TimeoutExpired:
                self.child.kill()
                self.child.wait()
        os.close(self.master)


def assert_no_menu(raw, label):
    assert 'Commands' not in plain(raw), f'{label} opened the slash picker'


def assert_no_requests(baseline, label):
    assert len(requests) == baseline, f'{label} sent {len(requests)-baseline} model requests'


def latest_prompt():
    return next(str(item['content']) for item in reversed(requests[-1]['messages']) if item.get('role') == 'user')


def wait_answer(terminal, marker, baseline):
    terminal.read_until(lambda raw: len(requests)>baseline, expectation='real native model request')
    terminal.read_until(lambda raw: f'V062 response {baseline+1} from ' in plain(raw[marker:]), expectation='real streamed model answer')
    terminal.ready(marker)
    assert not fixture_errors, fixture_errors


def progress(label):
    print(f'Observed: {label} ({len(requests)} native requests)', flush=True)


def verify_ready_prompt_regression():
    verify_terminal_readiness()
    results['renderedEditableComposerReadiness'] = True


verify_ready_prompt_regression()


try:
    with tempfile.TemporaryDirectory(prefix='sudocli-v062-native-') as temporary:
        root = Path(temporary)
        isolation_roots.append(root)
        terminal = Terminal(root/'main')
        terminal.ready()
        startup = bytes(terminal.transcript)
        assert b'\x1b[92m' in startup or b'\x1b[38;2;0;255;0m' in startup, 'Prompts did not use bright green'
        assert b'\x1b[96m' not in startup, 'Old cyan prompt remains'
        assert b'\x1b[38;2;239;41;41m' in startup, 'Red SUDO CLI logo changed'
        assert b'\x1b[38;2;220;227;235m' in startup, 'Soft-white antenna changed'
        assert b'\x1b[38;2;221;189;184m' in startup, 'Idle antenna wave palette changed'
        assert len(requests) == 0

        # An isolated slash opens immediately, with no newline or provider work.
        marker = terminal.picker()
        menu = plain(bytes(terminal.transcript[marker:]))
        assert '/help' in menu and '/status' in menu
        terminal.send('\x1b[B\x1b[A\x1b[6~\x1b[5~')
        terminal.drain(.25)
        assert terminal.child.poll() is None
        marker = terminal.send('local')
        terminal.read_until(lambda raw: '/local' in plain(raw[marker:]), expectation='filtered local command')
        selected = terminal.send('\r')
        terminal.drain(.2)
        assert_no_menu(bytes(terminal.transcript[selected:]), 'selecting a command')
        assert 'Local AI [' not in plain(bytes(terminal.transcript[selected:])), 'Picker auto-executed /local'
        assert_no_requests(0, 'opening/filtering/selecting the picker')
        marker = terminal.send('\r')
        # The second Enter executes the inserted /local command normally.
        marker = terminal.answer(marker, 'Local AI [', '3')
        marker = terminal.answer(marker, 'Local server URL', BASE_URL)
        marker = terminal.answer(marker, 'require authentication', 'yes')
        terminal.read_until(lambda raw: 'Local server key [hidden]' in plain(raw[marker:]), expectation='hidden local key')
        hidden = terminal.send('/')
        terminal.drain(.3)
        assert_no_menu(bytes(terminal.transcript[hidden:]), 'hidden key beginning with slash')
        marker = terminal.send(SECRET[1:]+'\n')
        marker = terminal.answer(marker, 'Local model [', '1')
        marker = terminal.answer(marker, 'Model context capacity', '131072')
        marker = terminal.answer(marker, 'Save AI as', 'V062 Local')
        marker = terminal.answer(marker, 'Supported effort levels', '')
        terminal.ready(marker)
        assert catalogs and all(item['explicitLocalAuthentication'] for item in catalogs)
        assert SECRET.encode() not in terminal.transcript
        assert_no_requests(0, 'selecting/configuring a local model')
        results.update(immediateSlashWithoutEnter=True, pickerDoesNotAutoExecute=True,
                       hiddenSlashKeyNeverOpensPickerOrEchoes=True, pickerArrowAndPageKeys=True,
                       greenPromptsAndPreservedRedLogoAndAntenna=True)
        progress('live slash picker, safe selection and hidden key')

        # Every registered command can be selected into the prompt without running it.
        # Escape first makes the slash literal; Ctrl+U clears only the current input.
        chosen = []
        for name in ([] if arguments.skip_inventory else COMMANDS):
            terminal.send('\x15')
            terminal.picker()
            marker = terminal.send(name[1:])
            terminal.read_until(lambda raw, name=name: name in plain(raw[marker:]), timeout=3, expectation=f'filter {name}')
            marker = terminal.send('\r')
            terminal.read_until(lambda raw, name=name: terminal.view.composer() and terminal.view.composer()['draft']==name,
                                timeout=3, expectation=f'filled command {name}')
            assert_no_menu(bytes(terminal.transcript[marker:]), f'choosing {name}')
            assert terminal.view.composer() and terminal.view.composer()['draft']==name, f'{name} was not filled into the prompt'
            assert terminal.child.poll() is None
            chosen.append(name)
        terminal.send('\x15')
        results['registeredCommandsSelectable'] = chosen
        results['inventorySkipped'] = arguments.skip_inventory
        assert_no_requests(0, 'browsing all registered commands')

        # Escape preserves the typed query, then a complete line still runs once.
        terminal.picker()
        terminal.send('status')
        marker = terminal.send('\x1b')
        terminal.read_until(lambda raw: terminal.view.composer() and terminal.view.composer()['draft']=='/status', timeout=3, expectation='Escape restored /status')
        terminal.drain(.12)
        selected = terminal.send('\r')
        terminal.read_until(lambda raw: 'AI response:' in plain(raw[selected:]), timeout=3, expectation='escaped /status executed')
        terminal.ready(selected)
        event = latest_event_text(terminal)
        escaped_status = plain(bytes(terminal.transcript[selected:]))+'\n'+event
        assert 'AI response:' in escaped_status and 'fixture-local-v062 ·' in escaped_status, 'Escape did not preserve and execute /status'
        direct = terminal.command('/status')
        assert 'AI response:' in direct and 'fixture-local-v062 ·' in direct
        assert_no_menu(direct.encode(), 'a complete /status line')
        assert_no_requests(0, 'escaping and complete-line command')
        results.update(escapePreservesSlashQuery=True, completeLineRunsWithOneEnter=True)
        progress(f'all {len(chosen)} commands selectable without execution')

        baseline = len(requests)
        marker = terminal.send('\x1b[200~/permissions allow-everything\x1b[201~')
        terminal.drain(.15)
        assert_no_requests(baseline, 'editable literal paste before Enter')
        assert terminal.view.composer()['draft']=='/permissions allow-everything'
        terminal.send('\n')
        wait_answer(terminal, marker, baseline)
        assert '/permissions allow-everything' in latest_prompt()
        assert_no_menu(bytes(terminal.transcript[marker:]), 'bracketed paste')
        permissions = terminal.command('/permissions')
        permissions = terminal.view.events_text()
        assert re.search(r'\bPermissions:\s*ask\b', permissions)
        assert 'allow-everything' not in permissions.lower() and 'allow everything' not in permissions.lower()
        assert_no_requests(baseline+1, 'literal paste permissions inspection')
        baseline = len(requests)
        marker = terminal.send('/prompt\n')
        marker = terminal.answer(marker, '  | ', '/permissions allow-everything')
        raw_marker = marker
        marker = terminal.answer(marker, '  | ', 'V062 raw slash is literal')
        marker = terminal.answer(marker, '  | ', '/end')
        wait_answer(terminal, marker, baseline)
        assert '/permissions allow-everything\nV062 raw slash is literal' in latest_prompt()
        assert_no_menu(bytes(terminal.transcript[raw_marker:]), 'raw multi-line slash input')
        results.update(bracketedPasteRemainsLiteral=True, rawSlashLinesRemainLiteral=True,
                       pasteAndRawDoNotChangePermissions=True)
        progress('literal paste and multiline prompt reach the real engine')

        # The busy /stop fast path must not be captured by the idle command picker.
        baseline = len(requests)
        terminal.send('V062_BUSY_STOP\n')
        terminal.read_until(lambda raw: len(requests)>baseline, expectation='delayed live model turn')
        start = time.monotonic()
        marker = terminal.send('/stop\n')
        terminal.ready(marker)
        elapsed = time.monotonic()-start
        assert elapsed < 5, f'/stop was delayed for {elapsed:.2f}s'
        assert_no_menu(bytes(terminal.transcript[marker:]), 'busy /stop')
        results.update(busyStopIsImmediate=True, busyStopSeconds=round(elapsed, 3))

        # Content sniffing must identify a renamed supported format without running it.
        renamed = terminal.workspace/'synthetic-model.unknown-extension'
        synthetic_header = struct.pack('<4sIQQ', b'GGUF', 3, 1, 0)+b'\0'*40
        renamed.write_bytes(synthetic_header)
        baseline = len(requests)
        inspection = terminal.command(f'/local info "{renamed}"')
        assert 'GGUF' in inspection, inspection[-2500:]
        assert_no_requests(baseline, 'local model file inspection')
        assert renamed.read_bytes() == synthetic_header
        arbitrary = terminal.workspace/'not-model.unusual-extension'
        arbitrary.write_text('This is an arbitrary file, not AI model weights.\n')
        rejected = terminal.command(f'/local info "{arbitrary}"')
        assert 'Unrecognized model file' in rejected
        assert_no_requests(baseline, 'unrecognized file inspection')
        terminal.picker()
        for character in f'local info "{renamed.name}"':
            terminal.send(character)
        marker = terminal.send('\n')
        terminal.read_until(lambda raw: 'Local model: GGUF model' in plain(raw[marker:]), timeout=5, expectation='per-key command with arguments executed once')
        terminal.ready(marker)
        assert_no_requests(baseline, 'per-key local inspection command')
        results.update(renamedSyntheticGgufDetectedByContent=True,
                       modelInspectionDoesNotModifyWeightsOrCallModel=True,
                       arbitraryFileIsNotClaimedToBeRunnableModel=True,
                       perKeyCommandWithArgumentsRunsWithOneFinalEnter=True)
        progress('busy stop and renamed synthetic model inspection')

        # Resize an open chooser down to a narrow terminal, then restore it.
        terminal.picker()
        terminal.resize(28, 12)
        terminal.send('training')
        terminal.drain(.25)
        terminal.resize(150, 44)
        marker = terminal.send('\x1b')
        terminal.read_until(lambda raw: terminal.view.composer() and terminal.view.composer()['draft']=='/training', timeout=3, expectation='resized picker Escape restoration')
        terminal.send('\x15')
        assert 'fixture-local-v062' in terminal.command('/status')
        results['openPickerResizeNarrowAndRestore'] = True
        assert b'\x1b[96m' not in terminal.transcript, 'A later prompt/menu restored the old cyan color'
        terminal.finish()

        for label, options in [('no-color', {'no_color': True}), ('dumb', {'term': 'dumb'}),
                               ('narrow', {'columns': 24, 'rows': 10})]:
            extra = Terminal(root/label, **options)
            extra.ready()
            if label == 'dumb':
                marker = extra.send('/')
                extra.drain(.15)
                assert_no_menu(bytes(extra.transcript[marker:]), 'TERM=dumb isolated slash')
                extra.send('\x15')
                assert '/local' in extra.command('/')
                assert 'No AI selected' in extra.command('/status')
            else:
                marker = extra.picker()
                extra.send('status')
                escaped = extra.send('\x1b')
                extra.read_until(lambda raw: extra.view.composer() and extra.view.composer()['draft']=='/status', timeout=3, expectation=f'{label} Escape restoration')
                marker = extra.send('\r')
                extra.ready(marker)
                assert 'No AI selected' in plain(bytes(extra.transcript[marker:]))
            assert_no_requests(baseline, f'{label} offline picker')
            extra.finish()
            if label in ['no-color', 'dumb']:
                styles = SGR.findall(extra.transcript)
                assert all(style in [b'\x1b[m', b'\x1b[0m'] for style in styles), f'{label} emitted color styles'
            results[label+'PickerAndCleanExit'] = True
        progress('resize, narrow, NO_COLOR and TERM=dumb terminals')

        results.update(status='passed', nativeProviderRequests=len(requests),
                       cliExitCodes=[item.child.returncode for item in terminals],
                       supportedTerminalChildrenRestoredAlternateScreen=True,
                       dumbTerminalNeverEnteredAlternateScreen=True, fixtureErrors=fixture_errors,
                       modelFixtures='Loopback streaming response fixture; no real model weights or runner installation',
                       limitations=['Physical Windows/macOS terminal input was not exercised by this Linux PTY runner.',
                                    'Synthetic GGUF header identification does not demonstrate real weight loading or inference.'])
except BaseException as error:
    results.update(status='failed', error=sanitized(repr(error)), nativeProviderRequests=len(requests),
                   fixtureErrors=fixture_errors)
    raise
finally:
    for index, terminal in enumerate(terminals):
        (OUTPUT/f'terminal-{index+1}.txt').write_text(sanitized(plain(bytes(terminal.transcript))), encoding='utf-8')
        (OUTPUT/f'terminal-{index+1}.ansi.txt').write_text(sanitized(bytes(terminal.transcript).decode('utf-8', errors='replace')), encoding='utf-8')
        terminal.close()
    (OUTPUT/'provider-requests.json').write_text(sanitized(requests), encoding='utf-8')
    (OUTPUT/'receipt.json').write_text(sanitized(results), encoding='utf-8')
    server.shutdown()
    server.server_close()
print(json.dumps(results, indent=2), flush=True)
