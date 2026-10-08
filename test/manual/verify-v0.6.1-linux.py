#!/usr/bin/env python3
"""Verify keyless local AI, per-AI preferences and source agents through a real PTY.

Run as Linux root from the product directory:
  python3 test/manual/verify-v0.6.1-linux.py --output-directory /tmp/v061-proof

The loopback Chat Completions server is a deterministic model fixture. The CLI,
terminal input, provider bridges, native Codex engine, sandbox, source copies,
saved records and applying changes are real. No paid model, installed model
weights, microphone, GPU hook, OS service or desktop app is used. Each CLI child
has isolated HOME/XDG/TMPDIR, project and state. Retained evidence is sanitized.
"""
import argparse
import fcntl
import http.server
import json
import os
from pathlib import Path
import pty
import re
import select
import shutil
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
    cwd=PROJECT, text=True).strip()
ENGINE = ENGINE if Path(ENGINE).is_absolute() else shutil.which(ENGINE)
if not ENGINE or not Path(ENGINE).is_file():
    raise SystemExit('Install the pinned native Linux Codex runtime first.')
OUTPUT = arguments.output_directory.resolve() if arguments.output_directory else Path(tempfile.mkdtemp(prefix='sudocli-v061-proof-'))
OUTPUT.mkdir(parents=True, exist_ok=True)
CLOUD_SECRET = 'v061-unrelated-inherited-cloud-credential'
ANSI = re.compile(rb'\x1b(?:\][^\x07]*(?:\x07|\x1b\\)|\[[0-?]*[ -/]*[@-~]|[@-_])')
requests, headers, catalogs, fixture_errors, terminals, isolation_roots = [], [], [], [], [], []
request_lock = threading.Lock()
results = {}
print(f'Sanitized native acceptance evidence: {OUTPUT}', flush=True)


def plain(raw):
    body = re.sub(rb'\x1b7.*?\x1b8', b'', raw, flags=re.DOTALL)
    return ANSI.sub(b'', body).decode('utf-8', errors='replace')


def sanitized(value):
    text = value if isinstance(value, str) else json.dumps(value, indent=2)
    text = text.replace(CLOUD_SECRET, '[redacted]')
    for root in isolation_roots:
        text = text.replace(str(root), '[isolated-root]')
    return text


def role_of(body):
    instructions = '\n'.join(str(message.get('content', '')) for message in body['messages']
                             if message.get('role') in ['system', 'developer'])
    match = re.search(r'You are an independent (\w+), named ([\w-]+)', instructions)
    return (match.group(1), match.group(2)) if match else (None, None)


class Server(socketserver.ThreadingMixIn, http.server.HTTPServer):
    daemon_threads = True


class Fixture(http.server.BaseHTTPRequestHandler):
    def do_GET(self):
        try:
            assert self.path == '/v1/models', self.path
            assert self.headers.get('authorization') is None, 'Cloud key reached local catalog'
            catalogs.append({'path': self.path, 'authorization': None})
            self.reply_json({'data': [{'id': 'fixture-local-a'}, {'id': 'fixture-local-b'}]})
        except Exception as error:
            fixture_errors.append(repr(error))
            self.send_error(500, 'fixture validation failed')

    def do_POST(self):
        try:
            assert self.path == '/v1/chat/completions', self.path
            assert self.headers.get('authorization') is None, 'Cloud key reached local generation'
            body = json.loads(self.rfile.read(int(self.headers['content-length'])))
            with request_lock:
                requests.append(body)
                headers.append({'authorization': self.headers.get('authorization')})
                index = len(requests)
            user = next((str(message.get('content', '')) for message in reversed(body['messages'])
                         if message.get('role') == 'user'), '')
            role, name = role_of(body)
            if 'V061_STOP_PROBE' in user and role == 'reviewer':
                time.sleep(6)
            if 'V061_STEER_PROBE' in user and role == 'reviewer':
                time.sleep(2)
            command = None
            if role == 'coder' and 'V061_PIPELINE_EDIT' in user:
                command = "pwd; printf 'agent-proposed\\n' > tracked.txt; printf 'agent-created\\n' > created.txt"
            elif role == 'reviewer' and 'V061_PIPELINE_EDIT' in user:
                command = 'pwd; cat tracked.txt'
            call_id = f'v061-{role}-{name}-tool'
            already_called = any(message.get('tool_call_id') == call_id for message in body['messages'])
            if command and not already_called:
                native_tool = next(tool['function']['name'] for tool in body.get('tools', [])
                                   if tool['function']['name'].split('__')[-1] == 'exec_command')
                message = {'role': 'assistant', 'content': None, 'tool_calls': [{
                    'id': call_id, 'type': 'function', 'function': {'name': native_tool,
                    'arguments': json.dumps({'cmd': command, 'login': False, 'max_output_tokens': 1000})}}]}
            else:
                message = {'role': 'assistant', 'content': f'V061 response {index} from {body["model"]}; role {role or "main"}; specialist {name or "main"}.'}
            assert body.get('stream') is True, 'Native Chat Completions did not stream'
            self.reply_stream(index, body['model'], message)
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
            payload = {'id': f'chatcmpl-v061-{index}', 'object': 'chat.completion.chunk',
                       'created': 1, 'model': model,
                       'choices': [] if usage else [{'index': 0, 'delta': delta, 'finish_reason': finish}]}
            if usage:
                payload['usage'] = usage
            self.wfile.write(('data: ' + json.dumps(payload) + '\n\n').encode())
            self.wfile.flush()

        chunk({'role': 'assistant'})
        if message.get('tool_calls'):
            call = message['tool_calls'][0]
            chunk({'tool_calls': [{'index': 0, 'id': call['id'], 'type': 'function', 'function': call['function']}]})
            chunk({}, 'tool_calls')
        else:
            for start in range(0, len(message['content']), 17):
                chunk({'content': message['content'][start:start+17]})
                time.sleep(.02)
            chunk({}, 'stop')
        chunk({}, usage={'prompt_tokens': 650, 'completion_tokens': 40, 'total_tokens': 690})
        self.wfile.write(b'data: [DONE]\n\n')
        self.wfile.flush()

    def log_message(self, *_):
        pass


server = Server(('127.0.0.1', 0), Fixture)
threading.Thread(target=server.serve_forever, daemon=True).start()
BASE_URL = f'http://127.0.0.1:{server.server_port}/v1'


class Terminal:
    def __init__(self, root):
        self.transcript = bytearray()
        self.workspace, self.state = root/'project', root/'state'
        for name in ['project', 'home', 'xdg-config', 'xdg-data', 'xdg-state', 'xdg-cache', 'xdg-runtime', 'tmp']:
            (root/name).mkdir(exist_ok=True, mode=0o700)
        self.master, slave = pty.openpty()
        fcntl.ioctl(self.master, termios.TIOCSWINSZ, struct.pack('HHHH', 44, 150, 0, 0))
        env = {'PATH': os.environ.get('PATH', '/usr/bin:/bin'), 'TERM': 'xterm-256color', 'LANG': 'C.UTF-8',
               'HOME': str(root/'home'), 'TMPDIR': str(root/'tmp'),
               'XDG_CONFIG_HOME': str(root/'xdg-config'), 'XDG_DATA_HOME': str(root/'xdg-data'),
               'XDG_STATE_HOME': str(root/'xdg-state'), 'XDG_CACHE_HOME': str(root/'xdg-cache'),
               'XDG_RUNTIME_DIR': str(root/'xdg-runtime'), 'SUDO_CLI_CODEX': str(ENGINE),
               'SUDO_CLI_STATE_DIR': str(self.state), 'SUDO_CLI_MODEL': 'inherited-cloud-model',
               'SUDO_CLI_BASE_URL': 'https://unused-cloud.invalid/v1',
               'SUDO_CLI_TRANSPORT': 'responses', 'SUDO_CLI_API_KEY': CLOUD_SECRET}
        self.child = subprocess.Popen([NODE, str(PROJECT/'bin/sudocli.mjs'), '--cwd', str(self.workspace)],
            cwd=self.workspace, env=env, stdin=slave, stdout=slave, stderr=slave, start_new_session=True)
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

    def read_until(self, predicate, *, timeout=60, expectation='PTY expectation'):
        end = time.monotonic()+timeout
        while time.monotonic() < end:
            if predicate(bytes(self.transcript)):
                return
            self.drain(.1)
            if self.child.poll() is not None:
                break
        raise AssertionError(f'{expectation} not observed; exit={self.child.poll()}')

    def send(self, text):
        self.drain(.08)
        marker = len(self.transcript)
        os.write(self.master, text.encode())
        return marker

    def ready(self, marker=0):
        self.read_until(lambda raw: re.search(r'(?:\r?\n|^)  you › ', plain(raw[marker:])), expectation='ready prompt')

    def command(self, text):
        marker = self.send(text+'\n')
        self.ready(marker)
        assert not fixture_errors, fixture_errors
        return plain(bytes(self.transcript[marker:]))

    def answer(self, marker, label, value):
        self.read_until(lambda raw: label in plain(raw[marker:]), expectation=label)
        return self.send(value+'\n')

    def local(self, model, profile):
        marker = self.send('/local\n')
        for label, answer in [('Local AI [', '3'), ('Local server URL', BASE_URL),
                ('require authentication', ''), ('Local model [', str(model)),
                ('Model context capacity', '131072'), ('Save AI as', profile), ('Supported effort levels', '')]:
            marker = self.answer(marker, label, answer)
        self.ready(marker)

    def task(self, text):
        baseline = len(requests)
        marker = self.send(text+'\n')
        self.read_until(lambda raw: len(requests)>baseline, expectation='native provider request')
        self.read_until(lambda raw: f'V061 response {baseline+1} from ' in plain(raw[marker:]), expectation='actual streamed answer')
        self.ready(marker)
        assert not fixture_errors, fixture_errors
        return requests[baseline:]

    def finish(self):
        self.send('/quit\n')
        while self.child.poll() is None:
            self.drain(.1)
            self.child.wait(timeout=8)
        self.drain(.1)
        assert self.child.returncode == 0, self.child.returncode
        assert b'\x1b[?1049h' in self.transcript and b'\x1b[?1049l' in self.transcript
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


def developer(body):
    return '\n'.join(str(message.get('content', '')) for message in body['messages']
                     if message.get('role') in ['system', 'developer'])


def result_id(output):
    match = re.search(r'Saved agents result: ([0-9a-f-]{36})', output)
    assert match, output[-3000:]
    assert 'failed' not in output.split(match.group(0), 1)[1].splitlines()[0]
    return match.group(1)


def progress(label):
    print(f'Observed: {label} ({len(requests)} native requests)', flush=True)


try:
    with tempfile.TemporaryDirectory(prefix='sudocli-v061-native-') as temporary:
        root = Path(temporary)
        isolation_roots.append(root)
        terminal = Terminal(root)
        terminal.ready()
        startup = plain(terminal.transcript)
        assert 'Local AI on this PC: /local' in startup
        assert 'API key' not in startup and 'AI setup' not in startup
        assert 'No AI selected' in terminal.command('/status')
        assert '/local' in terminal.command('/help ai') and '/agents' in terminal.command('/help work')
        specialists = terminal.command('/agents list')
        for name in ['planner', 'coder', 'tester', 'reviewer', 'security', 'researcher']:
            assert name in specialists
        assert len(requests) == 0
        results.update(defaultStartupOfflineDespiteInheritedCloudEnvironment=True, offlineModelRequests=0)
        progress('offline startup despite inherited cloud settings')

        terminal.local(1, 'Local A')
        assert catalogs and all(item['authorization'] is None for item in catalogs)
        assert 'fixture-local-a' in terminal.command('/status')
        terminal.command('/personalize set persona V061_PERSONA_A')
        terminal.command('/preferences set language English')
        terminal.command('/preferences set tone V061_STYLE_A')
        terminal.command('/preferences set length Short')
        a = terminal.task('V061_MAIN_AI_A')[0]
        assert a['model'] == 'fixture-local-a'
        assert 'V061_PERSONA_A' in developer(a) and 'V061_STYLE_A' in developer(a)
        terminal.local(2, 'Local B')
        terminal.command('/personalize set persona V061_PERSONA_B')
        terminal.command('/preferences set tone V061_STYLE_B')
        b = terminal.task('V061_MAIN_AI_B')[0]
        assert b['model'] == 'fixture-local-b'
        assert 'V061_PERSONA_B' in developer(b) and 'V061_PERSONA_A' not in developer(b)
        assert 'V061_STYLE_A' not in developer(b)
        terminal.command('/local Local A')
        restored = terminal.task('V061_RESTORED_AI_A')[0]
        assert 'V061_PERSONA_A' in developer(restored) and 'V061_PERSONA_B' not in developer(restored)
        assert not re.search(r'API key[^\r\n]*›', plain(terminal.transcript)), 'Unexpected key prompt'
        results.update(keylessLocalCatalogAndNativeGeneration=True, inheritedCloudCredentialNeverSent=True,
                       perAiPersonaAndPreferencesTransmitted=True, aiPreferenceIsolationAndRestore=True)
        progress('keyless local models and isolated per-AI preferences')

        (terminal.workspace/'tracked.txt').write_text('human-original\n')
        (terminal.workspace/'README.md').write_text('Native source-agent fixture. Preserve human changes.\n')
        marker = terminal.send('/agents add copyreader\n')
        for label, answer in [('Role [', 'reviewer'), ('Access in its project copy', 'review'),
                ('Saved AI [', 'Local A'), ('Specialist instructions', 'V061_SPECIALIST_RULE')]:
            marker = terminal.answer(marker, label, answer)
        terminal.ready(marker)
        assert 'copyreader' in terminal.command('/agents list')
        terminal.command('/local Local B')
        baseline = len(requests)
        custom = terminal.command('/agents run copyreader V061_SAVED_SPECIALIST_REVIEW')
        custom_id = result_id(custom)
        custom_requests = requests[baseline:]
        assert len(custom_requests) == 1
        selected = custom_requests[0]
        assert role_of(selected) == ('reviewer', 'copyreader')
        assert selected['model'] == 'fixture-local-a', 'Specialist ignored its saved AI'
        assert 'V061_SPECIALIST_RULE' in developer(selected) and 'V061_PERSONA_A' in developer(selected)
        assert 'V061_PERSONA_B' not in developer(selected)
        assert 'V061_MAIN_AI_A' not in json.dumps(selected['messages']), 'Agent inherited the main chat'
        assert (terminal.workspace/'tracked.txt').read_text() == 'human-original\n'
        baseline = len(requests)
        team = terminal.command('/agents team planner,reviewer V061_TEAM_REVIEW')
        result_id(team)
        assert sorted(role_of(body)[0] for body in requests[baseline:]) == ['planner', 'reviewer']
        assert (terminal.workspace/'tracked.txt').read_text() == 'human-original\n'
        shared = terminal.task('V061_USE_AGENT_REPORTS in the next main response')[0]
        report_messages = [message for message in shared['messages']
                           if 'specialist copyreader.' in str(message.get('content', ''))]
        assert report_messages, 'Saved specialist reports never reached the next main model prompt'
        assert all(message['role'] == 'user' for message in report_messages), 'Advisory reports became model instructions'
        assert 'V061_SAVED_SPECIALIST_REVIEW' in json.dumps(report_messages)
        results.update(savedSpecialistUsesItsSelectedAiAndPreferences=True, independentNativeTeam=True)
        results['agentReportsReachNextMainTurnWithoutReconnect'] = True
        progress('saved specialist and independent native team')

        baseline = len(requests)
        pipeline = terminal.command('/agents pipeline V061_PIPELINE_EDIT implement the fixture proposal')
        pipeline_id = result_id(pipeline)
        pipeline_requests = requests[baseline:]
        assert {role_of(body)[0] for body in pipeline_requests} == {'planner', 'coder', 'tester', 'reviewer'}
        for body in pipeline_requests:
            assert 'web_search' not in json.dumps(body.get('tools', []))
            assert 'V061_MAIN_AI_A' not in json.dumps(body['messages'])
        coder_followups = [body for body in pipeline_requests if role_of(body)[0] == 'coder'
                           and any(message.get('role') == 'tool' for message in body['messages'])]
        assert coder_followups, 'Native coder did not execute its copy edit'
        assert str(terminal.workspace) not in json.dumps([message for message in coder_followups[0]['messages'] if message.get('role') == 'tool'])
        reviewer_followups = [body for body in pipeline_requests if role_of(body)[0] == 'reviewer'
                              and any(message.get('role') == 'tool' for message in body['messages'])]
        assert reviewer_followups and 'agent-proposed' in json.dumps(reviewer_followups[0]['messages']), 'Reviewer did not read the proposed copy'
        assert len([body for body in pipeline_requests if role_of(body)[0] == 'tester']) == 1, 'Tester unexpectedly executed checks'
        assert (terminal.workspace/'tracked.txt').read_text() == 'human-original\n'
        assert not (terminal.workspace/'created.txt').exists()
        diff = terminal.command('/agents diff '+pipeline_id+' coder')
        assert 'tracked.txt' in diff and 'agent-proposed' in diff and 'created.txt' in diff
        assert (terminal.workspace/'tracked.txt').read_text() == 'human-original\n'
        applied = terminal.command('/agents apply '+pipeline_id+' coder')
        assert 'Applied: 2 files. Conflicts: 0.' in applied
        assert (terminal.workspace/'tracked.txt').read_text() == 'agent-proposed\n'
        assert (terminal.workspace/'created.txt').read_text() == 'agent-created\n'
        assert 'Needs review' in terminal.command('/verify')
        terminal.command('/checks add test "$(cat tracked.txt)" = agent-proposed && test -f created.txt')
        verified = terminal.command('/verify')
        assert 'Verified' in verified and '"exitCode": 0' in verified
        results.update(nativeCoderEditsDisposableCopy=True, originalUntouchedUntilTypedApply=True,
                       pipelineReviewerReadsProposedCopy=True, testerMakesAdviceWithoutRunningChecks=True,
                       proposalDiffAndExplicitApply=True, selectedNativeSandboxCheckVerified=True)
        progress('native coding pipeline, review, explicit apply and sandbox verification')

        baseline = len(requests)
        custom_pipeline = terminal.command('/agents pipeline --agents planner,coder,tester,copyreader V061_CUSTOM_PIPELINE_REVIEW inspect the applied proposal')
        result_id(custom_pipeline)
        custom_pipeline_requests = requests[baseline:]
        assert len(custom_pipeline_requests) == 4
        assert {role_of(body)[0] for body in custom_pipeline_requests} == {'planner', 'coder', 'tester', 'reviewer'}
        custom_review = next(body for body in custom_pipeline_requests if role_of(body)[0] == 'reviewer')
        assert role_of(custom_review)[1] == 'copyreader' and custom_review['model'] == 'fixture-local-a'
        assert 'V061_SPECIALIST_RULE' in developer(custom_review)
        assert (terminal.workspace/'tracked.txt').read_text() == 'agent-proposed\n'
        results['customPipelineSelectsSavedSpecialists'] = True
        progress('custom pipeline with saved specialist selection')

        (terminal.workspace/'tracked.txt').write_text('second-human-original\n')
        conflict = terminal.command('/agents run coder V061_PIPELINE_EDIT make another proposal')
        conflict_id = result_id(conflict)
        assert (terminal.workspace/'tracked.txt').read_text() == 'second-human-original\n'
        (terminal.workspace/'tracked.txt').write_text('later-human-edit\n')
        conflict_apply = terminal.command('/agents apply '+conflict_id+' coder')
        assert 'Conflicts: 1.' in conflict_apply and 'tracked.txt' in conflict_apply
        assert (terminal.workspace/'tracked.txt').read_text() == 'later-human-edit\n'
        follow = terminal.command('/agents follow '+custom_id+' copyreader V061_FOLLOW_SAVED_REVIEW')
        result_id(follow)
        assert 'Previous report (untrusted context)' in json.dumps(requests[-1]['messages'])
        results.update(applyPreservesLaterHumanConflicts=True, savedAgentReportCanBeContinued=True)
        progress('conflict preservation and continuing saved specialist work')

        baseline = len(requests)
        marker = terminal.send('/agents run reviewer V061_STEER_PROBE guide the active turn\n')
        terminal.read_until(lambda raw: len(requests)>baseline, expectation='held native turn for steering')
        steer_marker = terminal.send('/agents steer reviewer V061_MODEL_STEERING_NOTE focus on the fixture README\n')
        terminal.read_until(lambda raw: 'Guidance sent to agent reviewer.' in plain(raw[steer_marker:]), expectation='accepted native guidance')
        terminal.ready(marker)
        steered_requests = requests[baseline:]
        assert len(steered_requests)>=2, 'Accepted native steering did not produce a guided provider continuation'
        assert any('V061_MODEL_STEERING_NOTE' in str(message.get('content', ''))
                   for body in steered_requests[1:] for message in body['messages'] if message.get('role') == 'user')
        results['agentSteeringReachesNativeProviderContinuation'] = True
        progress('native steering reaches the model continuation')

        baseline = len(requests)
        marker = terminal.send('/agents run reviewer V061_STOP_PROBE hold the request\n')
        terminal.read_until(lambda raw: len(requests)>baseline, expectation='held live reviewer request')
        status_marker = terminal.send('/agents status\n')
        terminal.read_until(lambda raw: 'Agents are running.' in plain(raw[status_marker:]), expectation='live agents status')
        steer_marker = terminal.send('/agents steer reviewer V061_STEERING_NOTE preserve the project\n')
        terminal.read_until(lambda raw: 'Guidance sent to agent reviewer.' in plain(raw[steer_marker:]), expectation='native per-agent steering')
        stop_marker = terminal.send('/agents stop reviewer\n')
        terminal.read_until(lambda raw: 'Cancelling agent reviewer.' in plain(raw[stop_marker:]), expectation='per-agent cancellation')
        terminal.ready(stop_marker)
        cancelled = plain(bytes(terminal.transcript[marker:]))
        assert 'cancelled' in cancelled.lower()
        assert 'No active agents.' in terminal.command('/agents status')
        idle_steer = terminal.command('/agents steer reviewer V061_IDLE_STEER_MUST_FAIL')
        assert 'Guidance sent to agent reviewer.' not in idle_steer
        assert any(word in idle_steer.lower() for word in ['not active', 'not running', 'not available', 'cannot', 'unavailable']), idle_steer
        assert (terminal.workspace/'tracked.txt').read_text() == 'later-human-edit\n'
        baseline = len(requests)
        marker = terminal.send('/agents run reviewer V061_STOP_PROBE global cancellation\n')
        terminal.read_until(lambda raw: len(requests)>baseline, expectation='held reviewer for global stop')
        stop_marker = terminal.send('/stop\n')
        terminal.ready(stop_marker)
        assert 'cancelled' in plain(bytes(terminal.transcript[marker:])).lower()
        results.update(liveAgentStatus=True, nativeAgentSteering=True, inactiveSteeringDoesNotClaimSuccess=True,
                       perAgentStop=True, globalStopCancelsAgents=True)
        progress('live status and individual/global agent cancellation')
        terminal.finish()

        restarted = Terminal(root)
        restarted.ready()
        assert 'copyreader' in restarted.command('/agents list')
        assert pipeline_id in restarted.command('/agents results')
        restarted.command('/local Local A')
        continued = restarted.task('V061_RESTART_LOCAL_AND_PREFERENCES')[0]
        assert continued['model'] == 'fixture-local-a' and 'V061_PERSONA_A' in developer(continued)
        assert 'V061_STYLE_A' in developer(continued)
        assert not re.search(r'API key[^\r\n]*›', plain(restarted.transcript)), 'Unexpected key prompt after restart'
        results.update(savedSpecialistsAndReportsSurviveRestart=True, localPreferenceRestartRestore=True)
        restarted.finish()
        for path in restarted.state.rglob('*.json'):
            assert CLOUD_SECRET not in path.read_text(), 'Inherited cloud credential persisted'
        assert not fixture_errors, fixture_errors

    results.update(nativeLinuxRoot=True,
        nodeVersion=subprocess.check_output([NODE, '--version'], text=True).strip(),
        nativeEngineVersion=subprocess.check_output([ENGINE, '--version'], text=True).strip(),
        modelRequests=len(requests), nativeStreamedRequests=sum(bool(body.get('stream')) for body in requests),
        localCatalogRequests=len(catalogs), exitCodes=[terminal.child.returncode for terminal in terminals],
        credentialsNotStoredOrPrinted=True, physicalAudioUsed=False, installedModelWeightsUsed=False,
        paidProviderUsed=False, desktopAppChanged=False)
    (OUTPUT/'terminal-v0.6.1-linux-result.json').write_text(sanitized(results)+'\n')
    (OUTPUT/'terminal-v0.6.1-linux.log').write_text(sanitized(plain(b''.join(terminal.transcript for terminal in terminals))))
    (OUTPUT/'terminal-v0.6.1-linux-requests.json').write_text(sanitized(requests)+'\n')
    print(json.dumps(results), flush=True)
except BaseException as error:
    (OUTPUT/'terminal-v0.6.1-linux-failure.log').write_text(sanitized(plain(b''.join(terminal.transcript for terminal in terminals))))
    (OUTPUT/'terminal-v0.6.1-linux-failure-requests.json').write_text(sanitized(requests)+'\n')
    (OUTPUT/'terminal-v0.6.1-linux-failure-result.json').write_text(sanitized({'completed': results, 'error': repr(error), 'fixtureErrors': fixture_errors})+'\n')
    raise
finally:
    for terminal in terminals:
        terminal.close()
    server.shutdown()
    server.server_close()
