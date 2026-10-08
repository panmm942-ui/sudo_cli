#!/usr/bin/env python3
"""Exercise v0.6 through the real Linux PTY, CLI, bridge and native Codex engine.

Run from the product directory as Linux root:
  python3 test/manual/verify-v0.6-linux.py --output-directory /tmp/v6-proof

Only Python's standard library, Node >=22 and the installed Linux Codex runtime
are required. A loopback Chat Completions fixture supplies streamed responses,
usage and native tool calls; the UI and engine are never mocked. Every child
runs with a fresh HOME, XDG directories, TMPDIR, project and application state.
No paid endpoint, microphone, speaker, real GPU hook, OS startup service or
desktop Codex configuration is used. Retained evidence is sanitized.
"""
import argparse
import errno
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
arguments = parser.parse_args()
if sys.platform != 'linux' or os.geteuid() != 0:
    raise SystemExit('Run this native Linux acceptance as root (WSL: --user root).')
if not arguments.node:
    raise SystemExit('Node >=22 must be on PATH, or pass --node /absolute/node.')
PROJECT = Path(__file__).resolve().parents[2]
NODE = arguments.node
ENGINE = subprocess.check_output([NODE, '--input-type=module', '-e',
    'import {localCodex} from "./src/local-engine.mjs"; process.stdout.write(localCodex());'],
    cwd=PROJECT, text=True, timeout=15).strip()
ENGINE = ENGINE if Path(ENGINE).is_absolute() else shutil.which(ENGINE)
if not ENGINE or not Path(ENGINE).is_file():
    raise SystemExit('Install the matching native Linux Codex runtime first.')
OUTPUT = arguments.output_directory.resolve() if arguments.output_directory else Path(tempfile.mkdtemp(prefix='sudocli-v6-proof-'))
OUTPUT.mkdir(parents=True, exist_ok=True)
KEY = 'v6-loopback-only-private-acceptance-key'
ANSI = re.compile(rb'\x1b(?:\][^\x07]*?(?:\x07|\x1b\\)|\[[0-?]*[ -/]*[@-~]|[@-_])')
requests = []
fixture_errors = []
terminals = []
results = {}
isolation_roots = []
fixture_workspace = None
print(f'Sanitized native acceptance evidence: {OUTPUT}', flush=True)


def plain(raw):
    # Sticky dashboard refreshes save the cursor, redraw the header and restore
    # the cursor. They may land between two response deltas in the byte stream;
    # remove those complete redraws before matching the visible body text.
    body = re.sub(rb'\x1b7.*?\x1b8', b'', raw, flags=re.DOTALL)
    return ANSI.sub(b'', body).decode('utf-8', errors='replace')


def ready_prompt_visible(raw):
    # A retained user message starts with the same label. Only the empty final
    # input line is an editable prompt; earlier prompts and Working echoes are
    # not evidence that the submitted operation has returned.
    # Notification BELs do not change cells or cursor position. Ignore only
    # standalone BELs left after ANSI/OSC removal, including delayed rhythms.
    return bool(re.search(r'(?:\r?\n|^)  you › \Z', plain(raw).replace('\x07', '')))


def sanitized(value):
    text = value if isinstance(value, str) else json.dumps(value, indent=2)
    text = text.replace(KEY, '[redacted]')
    for root in isolation_roots:
        text = text.replace(str(root), '[isolated-root]')
    return text


class Server(socketserver.ThreadingMixIn, http.server.HTTPServer):
    daemon_threads = True


class Fixture(http.server.BaseHTTPRequestHandler):
    def do_GET(self):
        if self.path != '/v1/models':
            self.send_error(404)
            return
        self.reply_json({'data': [{'id': 'fixture-primary'}, {'id': 'fixture-secondary'}]})

    def do_POST(self):
        try:
            assert self.path == '/v1/chat/completions', self.path
            assert self.headers.get('authorization') == 'Bearer ' + KEY
            body = json.loads(self.rfile.read(int(self.headers['content-length'])))
            requests.append(body)
            index = len(requests)
            user = next((str(message.get('content', '')) for message in reversed(body['messages'])
                         if message.get('role') == 'user'), '')
            # Hold one actual native request open so a paste plus Enter lands
            # while the UI is busy, rather than racing an idle prompt.
            if user.splitlines()[-1] == 'BUSY_PASTE_HOLD':
                time.sleep(2)
            # Replayed visible history shares one user message with the next
            # prompt. Only the final, explicit fixture task may trigger tools.
            edit = re.match(r'NATIVE_EDIT_(\d+)\b', user.splitlines()[-1] if user else '')
            call_id = 'v6-edit-' + edit[1] if edit else ''
            tools = body.get('tools', [])
            already_called = any(message.get('tool_call_id') == call_id for message in body['messages'])
            if edit and not already_called:
                native_tool = next(tool['function']['name'] for tool in tools
                                   if tool['function']['name'].split('__')[-1] == 'exec_command')
                command = "printf 'after-ai-%s\\n' > tracked.txt; printf 'created-ai-%s\\n' > created.txt" % (edit[1], edit[1])
                message = {'role': 'assistant', 'content': None, 'tool_calls': [{
                    'id': call_id, 'type': 'function', 'function': {'name': native_tool,
                    'arguments': json.dumps({'cmd': command, 'workdir': str(fixture_workspace),
                                             'login': False, 'max_output_tokens': 1000})}}]}
            else:
                message = {'role': 'assistant', 'content': f'V6 response {index} from {body["model"]}. Credential {KEY}.'}
            if body.get('stream'):
                self.reply_stream(index, body['model'], message)
            else:
                self.reply_json({'id': f'chatcmpl-v6-{index}', 'object': 'chat.completion',
                    'created': 1, 'model': body['model'], 'choices': [{'index': 0, 'message': message,
                    'finish_reason': 'tool_calls' if message.get('tool_calls') else 'stop'}],
                    'usage': {'prompt_tokens': 530, 'completion_tokens': 40, 'total_tokens': 570}})
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

    def reply_stream(self, index, model, message):
        self.send_response(200)
        self.send_header('content-type', 'text/event-stream')
        self.end_headers()
        def chunk(delta, finish=None, usage=None):
            payload = {'id': f'chatcmpl-v6-{index}', 'object': 'chat.completion.chunk',
                       'created': 1, 'model': model,
                       'choices': [] if usage else [{'index': 0, 'delta': delta, 'finish_reason': finish}]}
            if usage:
                payload['usage'] = usage
            self.wfile.write(('data: ' + json.dumps(payload) + '\n\n').encode())
            self.wfile.flush()
        chunk({'role': 'assistant'})
        if message.get('tool_calls'):
            call = message['tool_calls'][0]
            args = call['function']['arguments']
            split = len(args)//2
            chunk({'tool_calls': [{'index': 0, 'id': call['id'], 'type': 'function',
                    'function': {'name': call['function']['name'], 'arguments': args[:split]}}]})
            time.sleep(.08)
            chunk({'tool_calls': [{'index': 0, 'function': {'arguments': args[split:]}}]})
            chunk({}, 'tool_calls')
        else:
            content = message['content']
            for start in range(0, len(content), 17):
                chunk({'content': content[start:start+17]})
                time.sleep(.03)
            chunk({}, 'stop')
        chunk({}, usage={'prompt_tokens': 530, 'completion_tokens': 40, 'total_tokens': 570})
        self.wfile.write(b'data: [DONE]\n\n')
        self.wfile.flush()

    def log_message(self, *_):
        pass


server = Server(('127.0.0.1', 0), Fixture)
threading.Thread(target=server.serve_forever, daemon=True).start()
BASE_URL = f'http://127.0.0.1:{server.server_port}/v1'


class Terminal:
    def __init__(self, root, *, explicit=False, cli_arguments=None, env_overrides=None):
        self.transcript = bytearray()
        self.root = root
        self.workspace = root/'project'
        self.state = root/'state'
        for name in ['project', 'home', 'xdg-config', 'xdg-data', 'xdg-state', 'xdg-cache', 'xdg-runtime', 'tmp']:
            (root/name).mkdir(exist_ok=True, mode=0o700)
        self.master, slave = pty.openpty()
        fcntl.ioctl(self.master, termios.TIOCSWINSZ, struct.pack('HHHH', 44, 142, 0, 0))
        env = {'PATH': os.environ.get('PATH', '/usr/bin:/bin'), 'TERM': 'xterm-256color',
               'LANG': 'C.UTF-8', 'HOME': str(root/'home'), 'TMPDIR': str(root/'tmp'),
               'XDG_CONFIG_HOME': str(root/'xdg-config'), 'XDG_DATA_HOME': str(root/'xdg-data'),
               'XDG_STATE_HOME': str(root/'xdg-state'), 'XDG_CACHE_HOME': str(root/'xdg-cache'),
               'XDG_RUNTIME_DIR': str(root/'xdg-runtime'),
               'SUDO_CLI_CODEX': str(ENGINE), 'SUDO_CLI_STATE_DIR': str(self.state)}
        env.update(env_overrides or {})
        command = [NODE, str(PROJECT/'bin/sudocli.mjs'), '--cwd', str(self.workspace)]
        if explicit:
            command += ['--model', 'fixture-primary', '--base-url', BASE_URL,
                        '--transport', 'chat-completions', '--context-window', '131072']
        command += cli_arguments or []
        self.child = subprocess.Popen(command, cwd=self.workspace, env=env,
            stdin=slave, stdout=slave, stderr=slave, start_new_session=True)
        os.close(slave)
        terminals.append(self)

    def drain(self, duration=.15):
        end = time.monotonic()+duration
        while time.monotonic() < end:
            readable, _, _ = select.select([self.master], [], [], .05)
            if readable:
                try:
                    data = os.read(self.master, 65536)
                    if not data:
                        return
                    self.transcript.extend(data)
                except OSError:
                    return

    def read_until(self, predicate, *, timeout=40, expectation='PTY expectation'):
        end = time.monotonic()+timeout
        while time.monotonic() < end:
            if predicate(bytes(self.transcript)):
                return
            self.drain(.1)
            if self.child.poll() is not None:
                break
        raise AssertionError(f'{expectation} not observed; exit={self.child.poll()}')

    def send(self, text, *, timeout=10):
        end = time.monotonic()+timeout
        self.drain(min(.08, max(0, end-time.monotonic())))
        marker = len(self.transcript)
        pending = memoryview(text.encode())
        offset = 0
        original_flags = fcntl.fcntl(self.master, fcntl.F_GETFL)

        def closed(error=None):
            status = self.child.poll()
            if status is not None:
                raise AssertionError(f'PTY child exited while sending input; exit={status}') from error
            raise EOFError('PTY closed while sending input.') from error

        fcntl.fcntl(self.master, fcntl.F_SETFL, original_flags | os.O_NONBLOCK)
        try:
            while offset < len(pending):
                if self.child.poll() is not None:
                    closed()
                remaining = end-time.monotonic()
                if remaining <= 0:
                    raise TimeoutError('PTY input timed out before all bytes were written.')
                readable, writable, _ = select.select([self.master], [self.master], [], min(.05, remaining))
                if readable:
                    try:
                        data = os.read(self.master, 65536)
                    except (BlockingIOError, InterruptedError):
                        pass
                    except OSError as error:
                        if error.errno in (errno.EIO, errno.EPIPE):
                            closed(error)
                        raise
                    else:
                        if not data:
                            closed()
                        self.transcript.extend(data)
                if writable:
                    try:
                        written = os.write(self.master, pending[offset:])
                    except (BlockingIOError, InterruptedError):
                        continue
                    except OSError as error:
                        if error.errno in (errno.EIO, errno.EPIPE):
                            closed(error)
                        raise
                    if written <= 0:
                        closed()
                    offset += written
        finally:
            fcntl.fcntl(self.master, fcntl.F_SETFL, original_flags)
        return marker

    def ready(self, marker=0):
        self.read_until(lambda raw: ready_prompt_visible(raw[marker:]),
                        expectation='ready prompt')

    def command(self, text):
        marker = self.send(text+'\n')
        self.ready(marker)
        return plain(bytes(self.transcript[marker:]))

    def answer(self, marker, label, text):
        self.read_until(lambda raw: label in plain(raw[marker:]), expectation=label)
        return self.send(text+'\n')

    def connect(self):
        marker = self.send('/connect\n')
        for label, answer in [('AI setup', '1'), ('Model ID', 'fixture-primary'),
                ('API base URL', BASE_URL), ('API format', '1'),
                ('Model context capacity', '131072'), ('API key', KEY)]:
            marker = self.answer(marker, label, answer)
        self.ready(marker)

    def multiline(self, command, text, *, tail=None):
        marker = self.send(command+'\n')
        for line in text.split('\n'):
            marker = self.answer(marker, '  | ', line)
        marker = self.answer(marker, '  | ', '/end')
        if tail:
            marker = self.answer(marker, tail[0], tail[1])
        self.ready(marker)
        return marker

    def task(self, text):
        baseline = len(requests)
        marker = self.send(text+'\n')
        self.read_until(lambda raw: len(requests) > baseline, expectation='native provider request')
        self.read_until(lambda raw: re.search(r'V6 response \d+ from ', plain(raw[marker:])),
                        expectation='actual native streamed answer')
        self.ready(marker)
        assert not fixture_errors, fixture_errors
        return requests[baseline:]

    def finish(self):
        self.send('/quit\n')
        end = time.monotonic()+8
        while self.child.poll() is None and time.monotonic() < end:
            self.drain(.1)
        self.child.wait(timeout=5)
        self.drain(.1)
        assert self.child.returncode == 0, self.child.returncode
        assert b'\x1b[?1049h' in self.transcript and b'\x1b[?1049l' in self.transcript
        assert b'\x1b[r' in self.transcript, 'scroll region not restored'
        assert KEY.encode() not in self.transcript, 'key leaked in terminal output'

    def close(self):
        error = None
        try:
            if self.child.poll() is None:
                self.child.terminate()
                try:
                    self.child.wait(timeout=5)
                except subprocess.TimeoutExpired:
                    self.child.kill()
                    self.child.wait(timeout=5)
        except BaseException as failure:
            error = failure
        try:
            os.close(self.master)
        except BaseException as failure:
            error = error or failure
        if error is not None:
            raise error


def chat_pointer(state):
    return json.loads(next((state/'chats').glob('last-*.json')).read_text())['id']


def chat_records(state):
    return [json.loads(path.read_text()) for path in (state/'chats').glob('chat-*.json')]


def checkpoint_ids(state):
    return {path.stem for path in (state/'workspace-checkpoints').rglob('*.json')
            if json.loads(path.read_text()).get('before')}


def assert_no_requests(baseline, label):
    assert len(requests) == baseline, f'{label} sent {len(requests)-baseline} model requests'


def progress(label):
    print(f'Observed: {label} ({len(requests)} native model requests)', flush=True)


def verify_ready_prompt_regression():
    samples = [
        ('\n  you › V6_MULTILINE_PROMPT\n/permissions allow-everything\n  · Working · Ctrl+C to interrupt\n', False),
        ('\n  you › /status', False),
        ('\n  you › \n  · Working · Ctrl+C to interrupt\n', False),
        ('\n  you › /status\x07\x07', False),
        ('\n  you › \n  · Working · Ctrl+C to interrupt\n\x07\x07', False),
        ('\n  you › \n', False),
        ('\n  you › \x1b]0;Working\x1b\\VISIBLE\x07', False),
        ('\n  you › \x1b[39m', True),
        ('\n  you › \x1b7header redraw\x1b8', True),
        ('\n  you › \x1b[39m\x07\x07', True),
    ]
    for text, expected in samples:
        assert ready_prompt_visible(text.encode()) is expected, repr(text)
    results['readyPromptExcludesRenderedUserEchoWhileWorking'] = True


verify_ready_prompt_regression()


try:
    with tempfile.TemporaryDirectory(prefix='sudocli-v6-native-') as temporary:
        root = Path(temporary)
        isolation_roots.append(root)
        terminal = Terminal(root)
        fixture_workspace = terminal.workspace
        terminal.ready()
        assert 'Local AI on this PC: /local' in plain(terminal.transcript)
        baseline = len(requests)
        assert '/switch' in terminal.command('/help')
        assert 'No AI selected' in terminal.command('/status')
        terminal.command('/chat list')
        assert 'Project memory is empty' in terminal.command('/memory')
        terminal.multiline('/memory edit', 'V6 approved project rule: preserve human edits and report actual checks.')
        terminal.drain(.3)
        assert_no_requests(baseline, 'offline launch/help/status/chats/memory')
        results['offlineShellModelRequests'] = 0
        progress('offline shell and approved memory')

        terminal.connect()
        primary = terminal.task('FIRST_SAVED_CHAT_BASELINE')[0]
        assert primary['model'] == 'fixture-primary' and primary['stream'] is True
        assert primary.get('max_tokens') == 4096, primary.get('max_tokens')
        memory_messages = [message for message in primary['messages']
                           if 'V6 approved project rule' in str(message.get('content', ''))]
        assert memory_messages and all(message['role'] in ['system', 'developer'] for message in memory_messages)
        assert 'User-approved project memory' in str(memory_messages)
        first_id = chat_pointer(terminal.state)
        terminal.command('/chat rename V6 first saved chat')
        baseline = len(requests)
        declared = terminal.command('/capabilities declare vision on')
        assert re.search(r'"vision":\s*\{\s*"state": "declared"', declared)
        terminal.command('/effort supported low,high')
        assert 'Configured: fixture-secondary' in terminal.command('/model fixture-secondary')
        cleared = terminal.command('/capabilities')
        for field in ['vision', 'contextWindow', 'supportedEfforts']:
            assert re.search(r'"'+field+r'":\s*\{\s*"state": "unknown"', cleared), cleared
        assert 'needs-capacity' in terminal.command('/context status')
        assert_no_requests(baseline, 'model-specific metadata declarations and selection')
        terminal.command('/context capacity 131072')
        secondary = terminal.task('SECOND_MODEL_DISPLAY_PROBE')[0]
        assert secondary['model'] == 'fixture-secondary'
        status = terminal.command('/status')
        assert 'fixture-secondary' in status and 'AI response: not measured' not in status
        visible = json.loads(next(path for path in (terminal.state/'chats').glob('chat-*.json')
                                  if json.loads(path.read_text())['id'] == first_id).read_text())
        assert {'fixture-primary', 'fixture-secondary'} <= {message.get('model') for message in visible['history']['messages']}
        results.update(guidedConnectAndNativeStream=True, selectedModelDisplayed=True,
                       perMessageModelAttribution=True, approvedProjectMemoryInNativeInstructions=True,
                       modelChangeClearsCapabilityContextAndEffortMetadata=True)
        progress('guided native streaming, memory and model attribution')

        # Actual readline/stream composition must accept Enter and multiline
        # prompts, and pasted slash commands must remain literal model input.
        baseline = len(requests)
        literal_prompt = 'V6_MULTILINE_PROMPT\n/permissions allow-everything\nKeep these lines as literal context.'
        marker = terminal.multiline('/prompt', literal_prompt)
        terminal.read_until(lambda raw: len(requests)>baseline, expectation='ordinary multiline native request')
        terminal.read_until(lambda raw: f'V6 response {baseline+1} from ' in plain(raw[marker:]),
                            expectation='ordinary multiline native answer')
        terminal.ready(marker)
        assert len(requests) == baseline+1
        assert literal_prompt in json.dumps(requests[-1]['messages']).replace('\\n', '\n')
        assert 'Permissions: Ask' in terminal.command('/status')
        # A paste intercepted while /prompt is waiting for a raw line must
        # resolve that line as one value and preserve its embedded newlines.
        baseline = len(requests)
        pasted_multiline = 'V6_BRACKETED_MULTILINE\n/permissions allow-everything\nPreserve the final pasted line.'
        marker = terminal.send('/prompt\n')
        terminal.read_until(lambda raw: '  | ' in plain(raw[marker:]), expectation='multiline raw prompt')
        marker = terminal.send('\x1b[200~'+pasted_multiline+'\x1b[201~')
        marker = terminal.answer(marker, '  | ', '/end')
        terminal.read_until(lambda raw: len(requests)>baseline, expectation='bracketed multiline native request')
        terminal.read_until(lambda raw: re.search(r'V6 response \d+ from ', plain(raw[marker:])),
                            expectation='bracketed multiline native answer')
        terminal.ready(marker)
        assert len(requests) == baseline+1
        assert pasted_multiline in json.dumps(requests[-1]['messages']).replace('\\n', '\n')
        assert 'Permissions: Ask' in terminal.command('/status')
        baseline = len(requests)
        pasted = '/permissions allow-everything\nV6_LITERAL_PASTE_PROBE'
        marker = terminal.send('\x1b[200~'+pasted+'\x1b[201~')
        terminal.read_until(lambda raw: len(requests)>baseline, expectation='literal bracketed paste request')
        terminal.read_until(lambda raw: re.search(r'V6 response \d+ from ', plain(raw[marker:])),
                            expectation='literal paste native answer')
        terminal.ready(marker)
        assert len(requests) == baseline+1
        assert pasted in json.dumps(requests[-1]['messages']).replace('\\n', '\n')
        assert 'Permissions: Ask' in terminal.command('/status')
        # Enter after a busy bracketed paste must not re-submit its leading
        # slash command through readline as an executable control command.
        baseline = len(requests)
        marker = terminal.send('BUSY_PASTE_HOLD\n')
        terminal.read_until(lambda raw: len(requests)==baseline+1, expectation='held native busy request')
        assert not re.search(r'V6 response \d+ from ', plain(terminal.transcript[marker:]))
        busy_pasted = '/permissions allow-everything\nV6_BUSY_LITERAL_PASTE_PROBE'
        terminal.send('\x1b[200~'+busy_pasted+'\x1b[201~\n')
        terminal.read_until(lambda raw: len(requests)==baseline+2, expectation='queued busy literal request')
        terminal.read_until(lambda raw: f'V6 response {baseline+2} from ' in plain(raw[marker:]),
                            expectation='queued busy literal native answer')
        terminal.ready(marker)
        assert len(requests) == baseline+2
        assert busy_pasted in json.dumps(requests[-1]['messages']).replace('\\n', '\n')
        assert 'Permissions: Ask' in terminal.command('/status')
        results.update(ordinaryMultilinePromptReachesNativeModel=True,
                       bracketedMultilinePromptPreservesLines=True,
                       bracketedPasteSlashesRemainLiteral=True, busyPastePlusEnterRemainsLiteralAndAsk=True,
                       pastedAndMultilineTextCannotChangePermissions=True)
        progress('ordinary/multiline/busy literal bracketed paste')

        # Actual native tool edits are checkpointed, checked, and undone.
        terminal.command('/permissions scope full')
        terminal.command('/permissions allow-everything')
        terminal.command('/web on')
        (terminal.workspace/'tracked.txt').write_text('before-ai\n')
        previous = checkpoint_ids(terminal.state)
        edited = terminal.task('NATIVE_EDIT_1 make the two fixture edits')
        assert len(edited) == 2 and any(message.get('role') == 'tool' for message in edited[-1]['messages'])
        assert (terminal.workspace/'tracked.txt').read_text() == 'after-ai-1\n'
        assert (terminal.workspace/'created.txt').read_text() == 'created-ai-1\n'
        new_ids = checkpoint_ids(terminal.state)-previous
        assert len(new_ids) == 1, new_ids
        edit_checkpoint = new_ids.pop()
        changes = terminal.command('/changes '+edit_checkpoint)
        assert 'tracked.txt' in changes and 'created.txt' in changes and 'after-ai-1' in changes
        empty_check = terminal.command('/verify')
        assert 'Needs review' in empty_check
        check = "test \"$(cat tracked.txt)\" = after-ai-1 && test -f created.txt"
        terminal.command('/checks add '+check)
        verified = terminal.command('/verify')
        assert 'Verified' in verified and '"exitCode": 0' in verified
        failed = terminal.command('/verify exit 7')
        assert 'Failed' in failed and '"exitCode": 7' in failed
        undo = terminal.command('/undo '+edit_checkpoint)
        assert '"status": "undone"' in undo
        assert (terminal.workspace/'tracked.txt').read_text() == 'before-ai\n'
        assert not (terminal.workspace/'created.txt').exists()
        previous = checkpoint_ids(terminal.state)
        terminal.task('NATIVE_EDIT_2 make the fixture edits again')
        conflicting_checkpoint = (checkpoint_ids(terminal.state)-previous).pop()
        (terminal.workspace/'tracked.txt').write_text('later-human-change\n')
        conflict = terminal.command('/undo '+conflicting_checkpoint)
        assert 'partially-undone' in conflict and '"conflicts"' in conflict and 'tracked.txt' in conflict
        assert (terminal.workspace/'tracked.txt').read_text() == 'later-human-change\n'
        assert not (terminal.workspace/'created.txt').exists()
        results.update(nativeToolFileEdits=True, checkpointDiff=True,
                       explicitChecksPassAndFail=True, zeroChecksNeedsReview=True,
                       undoRestoresAndRemoves=True, undoPreservesHumanConflict=True)
        progress('native edits, checkpoints, checks and human-conflict undo')

        # Both team roles execute through fresh native sessions and bounded snapshots.
        terminal.command('/workflow plan')
        planned = terminal.task('WORKFLOW_PLAN_PROBE')[0]
        assert 'Workflow: plan' in json.dumps(planned['messages'])
        before_team = len(requests)
        team = terminal.command('/team V6_TEAM_REVIEW_PROBE')
        team_requests = requests[before_team:]
        assert len(team_requests) == 2, len(team_requests)
        for role, request in zip(['planner', 'reviewer'], team_requests):
            assert 'independent '+role in json.dumps(request['messages'])
            assert 'Snapshot coverage' in json.dumps(request['messages'])
            assert 'FIRST_SAVED_CHAT_BASELINE' not in json.dumps(request['messages'])
        assert '"verified": false' in team and '"advisory": true' in team
        assert (terminal.workspace/'tracked.txt').read_text() == 'later-human-change\n'
        results.update(workflowInstructions=True, teamFreshNativeAdvisorySessions=True)
        progress('workflow and independent native team')

        marker = terminal.send('/new\n')
        marker = terminal.answer(marker, 'Keep the current saved chat', 'y')
        terminal.ready(marker)
        unrelated = terminal.task('UNRELATED_SECOND_CHAT')[0]
        second_id = chat_pointer(terminal.state)
        assert second_id != first_id
        assert 'FIRST_SAVED_CHAT_BASELINE' not in json.dumps(unrelated['messages'])
        terminal.command('/chat open '+first_id)
        resumed = terminal.task('FIRST_CHAT_CONTINUATION')[0]
        assert 'FIRST_SAVED_CHAT_BASELINE' in json.dumps(resumed['messages'])
        assert 'UNRELATED_SECOND_CHAT' not in json.dumps(resumed['messages'])
        assert len(chat_records(terminal.state)) == 2
        terminal.finish()
        restarted = Terminal(root, explicit=True)
        marker = restarted.answer(0, 'API key', KEY)
        restarted.ready(marker)
        restored = restarted.task('RESTART_CONTINUATION_PROBE')[0]
        assert 'FIRST_SAVED_CHAT_BASELINE' in json.dumps(restored['messages'])
        assert 'UNRELATED_SECOND_CHAT' not in json.dumps(restored['messages'])
        results.update(storedChatIsolationAndContinuation=True, storedChatRestartContinuation=True,
                       explicitFlagsSkipGuidedSetup=True)
        progress('stored chat isolation and restart')

        # Over-capacity archive replay blocks before provider traffic, then a
        # user-reviewed summary/selection is passed as conversation, not rules.
        restarted.task('LONG_ARCHIVE_MARKER '+('context-fixture-text '*850))
        restarted.command('/context capacity 6500')
        baseline = len(requests)
        bounded_block = restarted.command('OVER_CAPACITY_MUST_BLOCK')
        assert 'context allowance' in bounded_block or 'near capacity' in bounded_block
        assert_no_requests(baseline, 'over-capacity replay')
        restarted.multiline('/context review', 'V6_REVIEWED_SUMMARY preserve only the first baseline.',
                            tail=('Keep message numbers', '0'))
        reviewed = restarted.task('AFTER_REVIEW_PROBE')[0]
        assert 'V6_REVIEWED_SUMMARY' in json.dumps(reviewed['messages'])
        assert 'LONG_ARCHIVE_MARKER' not in json.dumps(reviewed['messages'])
        summaries = [message for message in reviewed['messages'] if 'V6_REVIEWED_SUMMARY' in str(message.get('content', ''))]
        assert summaries and all(message['role'] == 'user' for message in summaries)
        # Reconnect after another reviewed turn: summary selection must retain
        # messages created after the review rather than replaying only its old
        # source indices and silently losing the new conversation.
        restarted.command('/context capacity 6500')
        reviewed_continuation = restarted.task('AFTER_REVIEW_RECONNECT_CONTINUATION')[0]
        assert 'AFTER_REVIEW_PROBE' in json.dumps(reviewed_continuation['messages'])
        assert 'V6_REVIEWED_SUMMARY' in json.dumps(reviewed_continuation['messages'])
        assert 'LONG_ARCHIVE_MARKER' not in json.dumps(reviewed_continuation['messages'])
        restarted.command('/clear')
        fresh = restarted.task('FRESH_AFTER_CLEAR')[0]
        assert 'V6_REVIEWED_SUMMARY' not in json.dumps(fresh['messages'])
        assert 'FIRST_SAVED_CHAT_BASELINE' not in json.dumps(fresh['messages'])
        archive = next(record for record in chat_records(restarted.state) if record['id'] == first_id)
        assert 'LONG_ARCHIVE_MARKER' in json.dumps(archive['history'])
        results.update(contextBlocksBeforeRequest=True, reviewedReplayIsBoundedConversation=True,
                       reviewedReplayRetainsLaterMessagesAfterReconnect=True,
                       clearStartsFreshNativeContextAndKeepsArchive=True)
        progress('bounded reviewed context and clear')

        # Reset only this isolated application's ledger, then prove a one-request
        # daily budget stops the second turn before loopback provider traffic.
        restarted.command('/budget reset-day')
        restarted.command('/route price 1 2')
        marker = restarted.send('/budget setup\n')
        for scope in ['task', 'day']:
            for label in ['USD', 'tokens', 'model requests', 'minutes of active work']:
                marker = restarted.answer(marker, 'Maximum '+scope+' '+label,
                                            '1' if scope == 'day' and label == 'model requests' else '')
        restarted.ready(marker)
        restarted.task('BUDGET_FIRST_ALLOWED')
        baseline = len(requests)
        blocked = restarted.command('BUDGET_SECOND_BLOCKED')
        assert 'budget' in blocked.lower() and any(word in blocked.lower() for word in ['exhausted', 'limit', 'cannot admit']), blocked[-2000:]
        assert_no_requests(baseline, 'exhausted request budget')
        ledger = restarted.command('/budget status')
        assert '"requests": 1' in ledger and 'costUsd' in ledger
        results.update(dailyBudgetBlocksBeforeRequest=True, usageAndConfiguredCostRecorded=True)
        progress('request budget admission and usage')
        restarted.finish()
        # Explicit stale startup flags are validated before connection.
        # Interactive startup catches that failure and retains saved chats.
        # Inherited model environment alone intentionally leaves the shell
        # offline, rather than forcing an unwanted API-key setup prompt.
        baseline = len(requests)
        for model, base_url in [('invalid-model\nid', BASE_URL), ('fixture-primary', 'not-a-url')]:
            fallback = Terminal(root, cli_arguments=['--model', model,
                                                     '--base-url', base_url,
                                                     '--transport', 'chat-completions'])
            fallback.ready()
            assert 'Connection setup failed:' in plain(fallback.transcript)
            assert 'Continuing offline; /chat remains available.' in plain(fallback.transcript)
            assert 'No AI selected' in fallback.command('/status')
            listing = fallback.command('/chat list')
            assert 'V6 first saved chat' in listing
            fallback.command('/chat open '+first_id)
            assert 'FIRST_SAVED_CHAT_BASELINE' in fallback.command('/history')
            assert_no_requests(baseline, 'invalid explicit connection offline fallback and saved chats')
            fallback.finish()
        results['invalidExplicitConnectionFallsBackToOfflineSavedChats'] = True
        inherited = Terminal(root, env_overrides={'SUDO_CLI_MODEL': 'invalid-model\nid',
                                                 'SUDO_CLI_BASE_URL': 'not-a-url',
                                                 'SUDO_CLI_TRANSPORT': 'chat-completions'})
        inherited.ready()
        assert 'Local AI on this PC: /local' in plain(inherited.transcript)
        assert 'API key' not in plain(inherited.transcript)
        assert 'No AI selected' in inherited.command('/status')
        assert 'V6 first saved chat' in inherited.command('/chat list')
        inherited.command('/chat open '+first_id)
        assert 'FIRST_SAVED_CHAT_BASELINE' in inherited.command('/history')
        assert_no_requests(baseline, 'inherited model environment leaves interactive startup offline')
        inherited.finish()
        results['inheritedModelEnvironmentLeavesInteractiveShellOffline'] = True
        progress('explicit invalid connection fallback and inherited environment stay offline with saved chats')
        for path in restarted.state.rglob('*.json'):
            assert KEY not in path.read_text(), 'key persisted in '+str(path)
        assert not fixture_errors, fixture_errors

    results.update(nativeLinuxRoot=True,
                   nodeVersion=subprocess.check_output([NODE, '--version'], text=True, timeout=15).strip(),
                   nativeEngineVersion=subprocess.check_output([ENGINE, '--version'], text=True, timeout=15).strip(),
                   modelRequests=len(requests), nativeStreamedRequests=sum(bool(request.get('stream')) for request in requests),
                   exitCodes=[terminal.child.returncode for terminal in terminals],
                   credentialsNotStoredOrPrinted=True, isolatedHomeXdgStateProject=True,
                   physicalAudioUsed=False, realGpuServiceUsed=False, paidProviderUsed=False)
    (OUTPUT/'terminal-v0.6-linux-result.json').write_text(sanitized(results)+'\n')
    (OUTPUT/'terminal-v0.6-linux.log').write_text(sanitized(plain(b''.join(terminal.transcript for terminal in terminals))))
    (OUTPUT/'terminal-v0.6-linux-requests.json').write_text(sanitized(requests)+'\n')
    print(json.dumps(results), flush=True)
except BaseException as error:
    (OUTPUT/'terminal-v0.6-linux-failure.log').write_text(sanitized(plain(b''.join(terminal.transcript for terminal in terminals))))
    (OUTPUT/'terminal-v0.6-linux-failure-ansi.log').write_text(sanitized(b''.join(terminal.transcript for terminal in terminals).decode('utf-8', errors='replace')))
    (OUTPUT/'terminal-v0.6-linux-failure-requests.json').write_text(sanitized(requests)+'\n')
    (OUTPUT/'terminal-v0.6-linux-failure-result.json').write_text(sanitized({'completed': results,
        'error': repr(error), 'fixtureErrors': fixture_errors})+'\n')
    raise
finally:
    primary_error = sys.exc_info()[1]
    cleanup_error = None
    for terminal in terminals:
        try:
            terminal.close()
        except BaseException as failure:
            cleanup_error = cleanup_error or failure
    for cleanup in [server.shutdown, server.server_close]:
        try:
            cleanup()
        except BaseException as failure:
            cleanup_error = cleanup_error or failure
    if cleanup_error is not None:
        if primary_error is None:
            raise cleanup_error
        if hasattr(primary_error, 'add_note'):
            primary_error.add_note('Native acceptance cleanup also reported a bounded failure.')
