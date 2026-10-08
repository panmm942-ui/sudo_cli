#!/usr/bin/env python3
"""Real CLI/native Codex tool-loop acceptance with deterministic loopback providers.

Run as root on Linux, with the pinned runtime installed:
  python3 -B test/manual/verify-v0.6.3-model-loop-linux.py --output-directory /tmp/model-loop-proof

Exercises both the Chat Completions adapter and native Responses transport. Model
decisions are fixtures, not MiMo inference. No weights, paid service, user project,
saved credentials, microphone or external application is touched. Private HOME,
XDG, state and projects are temporary. Logs redact fixture credentials and roots.
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
parser.add_argument('--skip-repetition', action='store_true', help='Diagnostic only: skip the new guard scenario.')
args = parser.parse_args()
if sys.platform != 'linux' or os.geteuid() != 0:
    raise SystemExit('Run as root on Linux (WSL: --user root).')
if not args.node:
    raise SystemExit('Node >=22 must be installed or supplied with --node.')
PROJECT = Path(__file__).resolve().parents[2]
NODE = args.node
ENGINE = subprocess.check_output([NODE, '--input-type=module', '-e',
    'import {localCodex} from "./src/local-engine.mjs"; process.stdout.write(localCodex());'],
    cwd=PROJECT, text=True).strip()
ENGINE = ENGINE if Path(ENGINE).is_absolute() else shutil.which(ENGINE)
if not ENGINE or not Path(ENGINE).is_file():
    raise SystemExit('Install the pinned native Linux Codex runtime first.')
OUTPUT = args.output_directory.resolve() if args.output_directory else Path(tempfile.mkdtemp(prefix='sudocli-model-loop-proof-'))
OUTPUT.mkdir(parents=True, exist_ok=True)
KEY = 'V063-private-loopback-test-key'
ANSI = re.compile(rb'\x1b(?:\][^\x07]*(?:\x07|\x1b\\)|\[[0-?]*[ -/]*[@-~]|[@-_])')
records, errors, terminals, roots, results = [], [], [], [], {}
scenarios = {}
print(f'Sanitized native model-loop evidence: {OUTPUT}', flush=True)


def plain(raw):
    raw = re.sub(rb'\x1b7.*?\x1b8', b'', raw, flags=re.DOTALL)
    return ANSI.sub(b'', raw).decode('utf-8', errors='replace')


def sanitized(value):
    text = value if isinstance(value, str) else json.dumps(value, indent=2)
    text = text.replace(KEY, '[redacted]')
    for root in roots:
        text = text.replace(str(root), '[isolated-root]')
    return text


class Server(socketserver.ThreadingMixIn, http.server.HTTPServer):
    daemon_threads = True


class Fixture(http.server.BaseHTTPRequestHandler):
    def do_POST(self):
        try:
            assert self.headers.get('authorization') == 'Bearer '+KEY, 'Fixture key was not used'
            body = json.loads(self.rfile.read(int(self.headers['content-length'])))
            transport = 'chat-completions' if self.path == '/v1/chat/completions' else 'responses'
            assert self.path in ['/v1/chat/completions', '/v1/responses'], self.path
            assert body['model'] == 'fixture-native-'+transport, body['model']
            assert body.get('stream') is True, 'Actual native request did not stream'
            scenario = scenarios[transport]
            record = {'transport': transport, 'path': self.path, 'body': body}
            records.append(record)
            scenario['requests'].append(record)
            calls, outputs, latest = self.history(body, transport)
            # Every replayed result must preserve an actual call ID exactly once.
            for call_id, output in outputs.items():
                assert call_id in calls, f'Orphan result {call_id}'
                assert call_id in scenario['issued'], f'Unknown fixture call {call_id}'
                if transport == 'chat-completions':
                    assistant = calls[call_id]
                    assert assistant.get('reasoning_content') == scenario['reasoning'][call_id], f'Reasoning replay missing for {call_id}'
            scenario['replayed'].update(outputs)
            if 'V063_LOOP_WORKFLOW' in latest:
                self.workflow(body, transport, scenario, outputs)
            elif any(label in latest for label in ['V063_LONG_COMMAND', 'V063_YIELDED_COMMAND', 'V063_TIMEOUT_COMMAND']):
                suffix = 'yielded' if 'V063_YIELDED_COMMAND' in latest else 'timeout' if 'V063_TIMEOUT_COMMAND' in latest else 'long'
                if transport+'-'+suffix in outputs:
                    self.answer(transport, 'V063 native command yielded.' if suffix == 'yielded' else 'V063 native command ended.')
                    return
                command = 'python3 -c '+shlex_quote("from pathlib import Path; import os,time; Path('long-started').write_text(str(os.getpid())); time.sleep(30); Path('must-not-exist').write_text('completed')")
                self.tools(body, transport, scenario, [(suffix, 'exec_command', {'cmd': command, 'workdir': str(scenario['workspace']), 'login': False, 'yield_time_ms': 250 if suffix == 'yielded' else 30000, 'max_output_tokens': 1000})])
            elif 'V063_REPEAT_ACTION' in latest:
                count = scenario.setdefault('repeats', 0)+1
                scenario['repeats'] = count
                assert count <= 12, 'Repeated actions were not bounded by the runtime'
                self.tools(body, transport, scenario, [(f'repeat-{count}', 'exec_command', {'cmd': 'cat math_fixture.py', 'workdir': str(scenario['workspace']), 'login': False, 'max_output_tokens': 1000})])
            elif 'V063_CONTINUE' in latest:
                self.answer(transport, 'V063 continued after interruption.')
            else:
                raise AssertionError('Unexpected native prompt: '+latest[-300:])
        except (BrokenPipeError, ConnectionResetError):
            pass
        except BaseException as error:
            errors.append(sanitized(repr(error)))
            self.send_error(500, 'Fixture validation failed')

    def history(self, body, transport):
        calls, outputs, latest = {}, {}, ''
        if transport == 'chat-completions':
            for message in body['messages']:
                if message['role'] == 'user':
                    latest = str(message.get('content', ''))
                for call in message.get('tool_calls', []):
                    assert call['id'] not in calls, 'Duplicate replayed call ID'
                    calls[call['id']] = message
                if message['role'] == 'tool':
                    identifier = message['tool_call_id']
                    assert identifier not in outputs, 'Duplicate replayed tool result'
                    outputs[identifier] = str(message.get('content', ''))
        else:
            for item in body['input']:
                if item.get('role') == 'user':
                    latest = str(item.get('content', ''))
                if item.get('type') in ['function_call', 'custom_tool_call']:
                    assert item['call_id'] not in calls, 'Duplicate native call ID'
                    calls[item['call_id']] = item
                if item.get('type') in ['function_call_output', 'custom_tool_call_output']:
                    identifier = item['call_id']
                    assert identifier not in outputs, 'Duplicate native tool result'
                    outputs[identifier] = str(item.get('output', ''))
        return calls, outputs, latest

    def workflow(self, body, transport, scenario, outputs):
        prefix = transport+'-'
        done = {key.removeprefix(prefix): value for key, value in outputs.items()}
        workspace = str(scenario['workspace'])
        execute = lambda command: {'cmd': command, 'workdir': workspace, 'login': False, 'yield_time_ms': 1000, 'max_output_tokens': 2000}
        def edit(suffix, before, after):
            # Unknown native model families can expose patching through the shell
            # interceptor instead of a declared freeform apply_patch tool.
            try:
                select_tool(body['tools'], 'apply_patch', transport)
                self.tools(body, transport, scenario, [(suffix, 'apply_patch', {'input': patch(before, after)})])
            except AssertionError as error:
                if str(error) != 'Native tool was not declared: apply_patch':
                    raise
                scenario['patchRoute'] = 'native shell apply_patch interception'
                self.tools(body, transport, scenario, [(suffix, 'exec_command', execute("apply_patch <<'V063_PATCH'\n"+patch(before, after)+'\nV063_PATCH'))])
        if 'read-code' not in done:
            self.tools(body, transport, scenario, [('read-code', 'exec_command', execute('cat math_fixture.py')), ('read-test', 'exec_command', execute('cat test_math_fixture.py'))])
        elif 'bad-edit' not in done:
            assert 'a - b' in done['read-code'] and 'assert add(2, 3) == 5' in done['read-test'], done
            edit('bad-edit', 'a - b', 'a + b + 1')
        elif 'failed-test' not in done:
            assert (scenario['workspace']/'math_fixture.py').read_text().endswith('return a + b + 1\n')
            self.tools(body, transport, scenario, [('failed-test', 'exec_command', execute('python3 test_math_fixture.py'))])
        elif 'good-edit' not in done:
            assert 'AssertionError' in done['failed-test'] and re.search(r'(?:exit(?:ed with)?(?: code)?|code)\D*1', done['failed-test'], re.I), done['failed-test']
            edit('good-edit', 'a + b + 1', 'a + b')
        elif 'passed-test' not in done:
            self.tools(body, transport, scenario, [('passed-test', 'exec_command', execute('python3 test_math_fixture.py'))])
        else:
            assert 'V063 TEST PASS' in done['passed-test'], done['passed-test']
            self.answer(transport, 'V063 read, edited, recovered and tested successfully.')

    def tools(self, body, transport, scenario, entries):
        selected = []
        for suffix, logical, values in entries:
            call_id = transport+'-'+suffix
            name, namespace, kind = select_tool(body['tools'], logical, transport)
            reasoning = 'Fixture reasoning for '+', '.join(item[0] for item in entries)+'.'
            scenario['issued'].add(call_id)
            scenario['reasoning'][call_id] = reasoning
            selected.append({'id': call_id, 'name': name, 'namespace': namespace, 'kind': kind, 'values': values})
        if transport == 'chat-completions':
            self.headers_stream()
            self.chat_chunk({'role': 'assistant', 'reasoning_content': reasoning[:12]})
            self.chat_chunk({'reasoning_content': reasoning[12:]})
            # Interleave two tool names and JSON arguments over several chunks.
            for index, item in enumerate(selected):
                self.chat_chunk({'tool_calls': [{'index': index, 'id': item['id'], 'type': 'function', 'function': {'name': item['name'][:4], 'arguments': ''}}]})
            for index, item in reversed(list(enumerate(selected))):
                encoded = json.dumps(item['values'])
                midpoint = max(1, len(encoded)//2)
                self.chat_chunk({'tool_calls': [{'index': index, 'function': {'name': item['name'][4:], 'arguments': encoded[:midpoint]}}]})
            for index, item in enumerate(selected):
                encoded = json.dumps(item['values'])
                midpoint = max(1, len(encoded)//2)
                self.chat_chunk({'tool_calls': [{'index': index, 'function': {'arguments': encoded[midpoint:]}}]})
            self.chat_chunk({}, 'tool_calls')
            self.chat_finish()
        else:
            items = []
            for selected_item in selected:
                item = {'id': 'fc_'+selected_item['id'], 'call_id': selected_item['id'], 'name': selected_item['name']}
                if selected_item['namespace']:
                    item['namespace'] = selected_item['namespace']
                if selected_item['kind'] == 'custom':
                    item.update(type='custom_tool_call', input=selected_item['values']['input'])
                else:
                    item.update(type='function_call', status='completed', arguments=json.dumps(selected_item['values']))
                items.append(item)
            self.reply_responses(items)

    def headers_stream(self):
        self.send_response(200)
        self.send_header('content-type', 'text/event-stream')
        self.end_headers()

    def chat_chunk(self, delta, finish=None):
        # Xiaomi's documented streamed payloads include null optional fields.
        delta = {'role': None, 'content': None, 'reasoning_content': None, 'tool_calls': None, **delta}
        payload = {'id': 'chatcmpl-fixture', 'object': 'chat.completion.chunk', 'model': 'fixture-native-chat-completions', 'choices': [{'index': 0, 'delta': delta, 'finish_reason': finish}]}
        self.wfile.write(('data: '+json.dumps(payload)+'\n\n').encode())
        self.wfile.flush()

    def chat_finish(self):
        self.wfile.write(b'data: {"choices":[],"usage":{"prompt_tokens":200,"completion_tokens":40,"total_tokens":240}}\n\ndata: [DONE]\n\n')
        self.wfile.flush()

    def answer(self, transport, text):
        if transport == 'chat-completions':
            self.headers_stream()
            self.chat_chunk({'role': 'assistant', 'content': text[:10]})
            self.chat_chunk({'content': text[10:]}, 'stop')
            self.chat_finish()
        else:
            self.reply_responses([{'id': 'msg_fixture', 'type': 'message', 'status': 'completed', 'role': 'assistant', 'content': [{'type': 'output_text', 'text': text, 'annotations': []}]}])

    def reply_responses(self, items):
        self.headers_stream()
        response = {'id': 'resp_fixture_'+str(len(records)), 'object': 'response', 'status': 'in_progress', 'output': [], 'usage': None}
        sequence = 0
        def emit(kind, **values):
            nonlocal sequence
            payload = {'type': kind, 'sequence_number': sequence, **values}
            sequence += 1
            self.wfile.write(('event: '+kind+'\ndata: '+json.dumps(payload)+'\n\n').encode())
            self.wfile.flush()
        emit('response.created', response=response)
        for index, item in enumerate(items):
            field = 'input' if item['type'] == 'custom_tool_call' else 'arguments' if item['type'] == 'function_call' else None
            pending = {**item, 'status': 'in_progress'}
            if field:
                pending[field] = ''
            else:
                pending['content'] = []
            emit('response.output_item.added', output_index=index, item=pending)
            if field:
                event_field = 'custom_tool_call_input' if field == 'input' else 'function_call_arguments'
                for offset in range(0, len(item[field]), 17):
                    emit('response.'+event_field+'.delta', item_id=item['id'], output_index=index, delta=item[field][offset:offset+17])
                emit('response.'+event_field+'.done', item_id=item['id'], output_index=index, **{field: item[field]})
            else:
                emit('response.output_text.delta', item_id=item['id'], output_index=index, content_index=0, delta=item['content'][0]['text'])
            emit('response.output_item.done', output_index=index, item=item)
        emit('response.completed', response={**response, 'status': 'completed', 'output': items, 'usage': {'input_tokens': 200, 'output_tokens': 40, 'total_tokens': 240}})

    def log_message(self, *_):
        pass


def shlex_quote(value):
    import shlex
    return shlex.quote(value)


def patch(before, after):
    return '*** Begin Patch\n*** Update File: math_fixture.py\n@@\n-    return '+before+'\n+    return '+after+'\n*** End Patch'


def workspace_processes(workspace):
    # Sandbox PID namespaces make os.getpid() unsuitable for /proc in the host.
    # Identify only this fixture's Python command in its exact temporary project.
    found = []
    for entry in Path('/proc').iterdir():
        if not entry.name.isdecimal():
            continue
        try:
            if (entry/'cwd').resolve() == workspace and b'long-started' in (entry/'cmdline').read_bytes() and b'python3\x00-c\x00' in (entry/'cmdline').read_bytes():
                found.append(int(entry.name))
        except (FileNotFoundError, PermissionError, OSError):
            pass
    return found


def process_gone(process_id):
    try:
        return '\nState:\tZ' in Path(f'/proc/{process_id}/status').read_text()
    except FileNotFoundError:
        return True


def select_tool(tools, logical, transport):
    for tool in tools:
        if transport == 'chat-completions':
            name = tool['function']['name']
            if name == logical or name.endswith('__'+logical):
                return name, None, 'function'
        elif tool['type'] == 'namespace':
            for child in tool['tools']:
                if child.get('name') == logical:
                    return logical, tool['name'], child['type']
        elif tool.get('name') == logical:
            return logical, None, tool['type']
    raise AssertionError('Native tool was not declared: '+logical)


server = Server(('127.0.0.1', 0), Fixture)
threading.Thread(target=server.serve_forever, daemon=True).start()


class Terminal:
    def __init__(self, root, transport):
        self.transcript = bytearray()
        self.workspace, self.state = root/'project', root/'state'
        self.native_events = OUTPUT/f'native-events-{len(terminals)+1}.jsonl'
        self.native_events.write_text('')
        for name in ['project', 'home', 'tmp', 'xdg-config', 'xdg-data', 'xdg-state', 'xdg-cache', 'xdg-runtime']:
            (root/name).mkdir(parents=True, exist_ok=True, mode=0o700)
        (self.workspace/'math_fixture.py').write_text('def add(a, b):\n    return a - b\n')
        (self.workspace/'test_math_fixture.py').write_text('from math_fixture import add\nassert add(2, 3) == 5\nprint("V063 TEST PASS")\n')
        observer = root/'observe-native.mjs'
        # Pinned native plugins default on and can clone their public catalog in
        # the background. Disable that unrelated facility for this deterministic
        # loopback test, so cleanup cannot race an external catalog clone.
        observer.write_text('import cp from "node:child_process"; import {syncBuiltinESMExports} from "node:module"; import {appendFileSync} from "node:fs";\n'
            'const original=cp.spawn; cp.spawn=function(command,args,options){ if(String(command).endsWith("/codex") && args?.includes("app-server"))args=[...args,"-c","features.plugins=false"]; const child=original(command,args,options);\n'
            'if(String(command).endsWith("/codex") && args?.includes("app-server")){let buffer="";child.stdout.on("data",chunk=>{buffer+=chunk.toString();let index;while((index=buffer.indexOf("\\n"))>=0){const line=buffer.slice(0,index);buffer=buffer.slice(index+1);'
            'try{const event=JSON.parse(line);if(event.method)appendFileSync('+json.dumps(str(self.native_events))+',JSON.stringify(event)+"\\n");}catch{}}});}return child;};syncBuiltinESMExports();\n')
        scenarios[transport] = {'workspace': self.workspace, 'requests': [], 'issued': set(), 'reasoning': {}, 'replayed': {}}
        self.master, slave = pty.openpty()
        fcntl.ioctl(self.master, termios.TIOCSWINSZ, struct.pack('HHHH', 44, 150, 0, 0))
        env = {'PATH': os.environ.get('PATH', '/usr/bin:/bin'), 'TERM': 'xterm-256color', 'LANG': 'C.UTF-8',
               'HOME': str(root/'home'), 'TMPDIR': str(root/'tmp'), 'XDG_CONFIG_HOME': str(root/'xdg-config'),
               'XDG_DATA_HOME': str(root/'xdg-data'), 'XDG_STATE_HOME': str(root/'xdg-state'), 'XDG_CACHE_HOME': str(root/'xdg-cache'),
               'XDG_RUNTIME_DIR': str(root/'xdg-runtime'), 'SUDO_CLI_CODEX': str(ENGINE), 'SUDO_CLI_STATE_DIR': str(self.state), 'SUDO_CLI_API_KEY': KEY, 'NODE_OPTIONS': '--import '+str(observer)}
        self.child = subprocess.Popen([NODE, str(PROJECT/'bin/sudocli.mjs'), '--cwd', str(self.workspace),
            '--model', 'fixture-native-'+transport, '--base-url', f'http://127.0.0.1:{server.server_port}/v1',
            '--transport', transport, '--context-window', '131072', '--permissions', 'allow-everything', '--scope', 'project'],
            cwd=self.workspace, env=env, stdin=slave, stdout=slave, stderr=slave, start_new_session=True)
        os.close(slave)
        terminals.append(self)

    def drain(self, duration=.1):
        end = time.monotonic()+duration
        while time.monotonic() < end:
            if errors:
                raise AssertionError('Fixture validation failed: '+str(errors))
            readable, _, _ = select.select([self.master], [], [], .04)
            if readable:
                try:
                    self.transcript.extend(os.read(self.master, 65536))
                except OSError:
                    return

    def until(self, predicate, timeout=30, label='native acceptance expectation'):
        end = time.monotonic()+timeout
        while time.monotonic() < end:
            if predicate():
                return
            self.drain()
            if self.child.poll() is not None:
                if predicate():
                    return
                break
        raise AssertionError(f'{label} absent; exit={self.child.poll()}; recent={plain(bytes(self.transcript[-3000:]))!r}; fixture={errors!r}')

    def send(self, text):
        self.drain(.05)
        marker = len(self.transcript)
        os.write(self.master, text.encode())
        return marker

    def ready(self, marker=0):
        self.until(lambda: re.search(r'(?:\r?\n|^)  you › ', plain(bytes(self.transcript[marker:]))), label='CLI ready prompt')

    def task(self, text, response):
        marker = self.send(text+'\n')
        self.until(lambda: response in plain(bytes(self.transcript[marker:])), label=response)
        self.ready(marker)
        assert not errors, errors

    def command(self, text):
        marker = self.send(text+'\n')
        self.ready(marker)
        return plain(bytes(self.transcript[marker:]))

    def finish(self):
        self.send('/quit\n')
        self.until(lambda: self.child.poll() is not None, timeout=10, label='clean CLI exit')
        self.drain()
        assert self.child.returncode == 0, self.child.returncode
        assert KEY.encode() not in self.transcript, 'Fixture credential printed'
        assert b'\x1b[?1049h' in self.transcript and b'\x1b[?1049l' in self.transcript, 'Terminal screen was not restored'

    def close(self):
        if self.child.poll() is None:
            self.child.terminate()
            try:
                self.child.wait(timeout=5)
            except subprocess.TimeoutExpired:
                self.child.kill()
                self.child.wait()
        os.close(self.master)


try:
    with tempfile.TemporaryDirectory(prefix='sudocli-v063-model-loop-') as temporary:
        root = Path(temporary)
        roots.append(root)
        for transport in ['chat-completions', 'responses']:
            terminal = Terminal(root/transport, transport)
            terminal.ready()
            terminal.task('V063_LOOP_WORKFLOW: read the files, edit, test, recover the failure and test again.', 'V063 read, edited, recovered and tested successfully.')
            scenario = scenarios[transport]
            expected = {transport+'-'+suffix for suffix in ['read-code', 'read-test', 'bad-edit', 'failed-test', 'good-edit', 'passed-test']}
            assert expected.issubset(scenario['replayed']), expected-scenario['replayed'].keys()
            assert (terminal.workspace/'math_fixture.py').read_text() == 'def add(a, b):\n    return a + b\n'
            result = subprocess.run([sys.executable, 'test_math_fixture.py'], cwd=terminal.workspace, text=True, capture_output=True)
            assert result.returncode == 0 and 'V063 TEST PASS' in result.stdout, result
            print('Observed: '+transport+' read / actual patches / failed test / repaired test / complete ID replay', flush=True)
            marker = terminal.send('V063_LONG_COMMAND: begin the disposable long command.\n')
            terminal.until(lambda: (terminal.workspace/'long-started').exists(), label='actual long-running process')
            process_ids = workspace_processes(terminal.workspace)
            assert process_ids, 'Could not identify the actual fixture process outside its PID namespace'
            stop_marker = terminal.send('/stop\n')
            terminal.ready(stop_marker)
            terminal.until(lambda: all(process_gone(process_id) for process_id in process_ids), timeout=8, label='native command process terminated')
            assert not (terminal.workspace/'must-not-exist').exists(), 'Interrupted process finished its delayed write'
            terminal.task('V063_CONTINUE: continue after cancellation.', 'V063 continued after interruption.')
            print('Observed: '+transport+' interrupted real command / process gone / subsequent turn completed', flush=True)
            # A yielded command remains a native background session even after
            # the model has completed its turn. Stop must still terminate it.
            (terminal.workspace/'long-started').unlink()
            terminal.task('V063_YIELDED_COMMAND: yield the disposable command and finish this turn.', 'V063 native command yielded.')
            process_ids = workspace_processes(terminal.workspace)
            assert process_ids, 'Yielded native command was not running'
            native_events = [json.loads(line) for line in terminal.native_events.read_text().splitlines()]
            yielded_events = [item for item in native_events if item.get('params', {}).get('item', {}).get('id') == transport+'-yielded']
            assert any(item['method'] == 'item/started' for item in yielded_events), 'Yielded command lifecycle start was absent'
            lifecycle_completed_while_running = any(item['method'] == 'item/completed' for item in yielded_events)
            terminal.command('/stop')
            terminal.until(lambda: all(process_gone(pid) for pid in process_ids), timeout=8, label='idle stop terminated yielded process')
            terminal.task('V063_CONTINUE: continue after stopping yielded command.', 'V063 continued after interruption.')
            print('Observed: '+transport+' yielded command / idle stop / continuation', flush=True)
            # The watchdog uses native process IDs and persists across polls.
            assert '1s' in terminal.command('/loopguard timeout 1')
            (terminal.workspace/'long-started').unlink()
            marker = terminal.send('V063_TIMEOUT_COMMAND: start the disposable long command and allow timeout.\n')
            terminal.until(lambda: (terminal.workspace/'long-started').exists(), label='actual timeout command started')
            process_ids = workspace_processes(terminal.workspace)
            assert process_ids, 'Timeout process was not running'
            terminal.until(lambda: 'Command exceeded 1 seconds and its native terminal was stopped.' in plain(bytes(terminal.transcript[marker:])), timeout=10, label='command timeout notification')
            terminal.until(lambda: all(process_gone(pid) for pid in process_ids), timeout=8, label='timeout terminated native command')
            terminal.ready(marker)
            assert not (terminal.workspace/'must-not-exist').exists(), 'Timed-out or stopped command completed its delayed write'
            terminal.task('V063_CONTINUE: continue after the timeout.', 'V063 continued after interruption.')
            terminal.command('/loopguard timeout 120')
            print('Observed: '+transport+' native command timeout / process gone / continuation', flush=True)
            if not args.skip_repetition:
                marker = terminal.send('V063_REPEAT_ACTION: keep reading the unchanged file.\n')
                terminal.until(lambda: scenario.get('repeats', 0) >= 3, label='repeated identical actions')
                terminal.ready(marker)
                visible = plain(bytes(terminal.transcript[marker:])).lower()
                assert any(word in visible for word in ['progress', 'repeated', 'repetition', 'loop']), visible[-1500:]
                assert scenario.get('repeats', 0) < 12, 'Fixture emergency cap, not runtime guard, stopped repetition'
                terminal.task('V063_CONTINUE: continue after the repetition guard.', 'V063 continued after interruption.')
                print('Observed: '+transport+' repeated action guard / subsequent turn completed', flush=True)
            terminal.finish()
            results[transport] = {'readEditFailRepairPass': True, 'interleavedFragmentedToolCalls': transport == 'chat-completions',
                'reasoningContentReplayed': transport == 'chat-completions', 'allWorkflowCallIDsReturned': True, 'patchRoute': scenario.get('patchRoute', 'declared native apply_patch'),
                'actualLongCommandInterrupted': True, 'cancelledProcessGone': True, 'nextTurnCompleted': True,
                'yieldedProcessStoppedWhileIdle': True, 'yieldedLifecycleCompletedWhileProcessRunning': lifecycle_completed_while_running,
                'commandTimeoutKilledActualProcess': True, 'timeoutContinuationCompleted': True,
                'repeatedActionGuard': not args.skip_repetition, 'repeatRequests': scenario.get('repeats', 0), 'nativeRequests': len(scenario['requests']), 'cliExitCode': terminal.child.returncode}
        results.update(status='passed', model='deterministic loopback fixtures; no actual MiMo inference', fixtureErrors=errors,
                       limitations=['Does not certify model quality, real MiMo server configuration, or physical Windows/macOS terminal behavior.'])
except BaseException as error:
    results.update(status='failed', error=sanitized(repr(error)), fixtureErrors=errors)
    raise
finally:
    for index, terminal in enumerate(terminals):
        (OUTPUT/f'terminal-{index+1}.txt').write_text(sanitized(plain(bytes(terminal.transcript))), encoding='utf-8')
        if terminal.native_events.exists():
            (OUTPUT/f'native-events-{index+1}.jsonl').write_text(sanitized(terminal.native_events.read_text()), encoding='utf-8')
        terminal.close()
    (OUTPUT/'provider-requests.json').write_text(sanitized(records), encoding='utf-8')
    (OUTPUT/'receipt.json').write_text(sanitized(results), encoding='utf-8')
    server.shutdown()
    server.server_close()
print(json.dumps(results, indent=2), flush=True)
