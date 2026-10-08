"""Exercise the acceptance harness's exact Terminal class without launching it."""
import ast
import errno
import fcntl
import hashlib
import json
import os
from pathlib import Path
import pty
import select
import signal
import subprocess
import sys
import time
import tty


DONE = b'\nPTY_DUPLEX_DONE\n'
CHUNK = 256
PADDING = b'E'*4096
# XNU sets this read-only history bit after a positive write (sys/fcntl.h,
# kern/sys_generic.c). F_SETFL cannot clear it; every other bit must match.
DARWIN_FWASWRITTEN = 0x10000 if sys.platform == 'darwin' else 0
ERROR_TYPES = {'AssertionError', 'EOFError', 'TimeoutError', 'FixtureDeadline', 'OSError',
               'BlockingIOError', 'InterruptedError', 'PermissionError', 'FileNotFoundError',
               'ChildProcessError', 'ProcessLookupError', 'ValueError', 'RuntimeError'}


def primitive_error(error):
    name = type(error).__name__
    number = getattr(error, 'errno', None)
    return {'errorType': name if name in ERROR_TYPES else 'OtherError',
            'errno': number if isinstance(number, int) and 0 <= number <= 255 else None}


def peer(mode, size):
    if mode == 'exit':
        return
    if mode == 'eof':
        for descriptor in [0, 1, 2]:
            os.close(descriptor)
    elif mode == 'duplex':
        remaining = size
        while remaining:
            wanted = min(CHUNK, remaining)
            data = b''
            while len(data) < wanted:
                part = os.read(0, wanted-len(data))
                if not part:
                    raise RuntimeError('Fixture input closed early.')
                data += part
            output = b'echo:'+data+b'|'+PADDING
            while output:
                output = output[os.write(1, output):]
            remaining -= len(data)
        os.write(1, DONE)
    time.sleep(30)


if sys.argv[1:2] == ['--peer']:
    try:
        peer(sys.argv[2], int(sys.argv[3]))
    except BaseException as error:
        print('PTY_PEER_CAUSE '+json.dumps(primitive_error(error)), file=sys.stderr, flush=True)
        raise SystemExit(1)
    else:
        raise SystemExit(0)


class FixtureDeadline(TimeoutError):
    pass


def deadline(*_):
    raise FixtureDeadline('Bounded outer PTY fixture deadline exceeded.')


signal.signal(signal.SIGALRM, deadline)
harness = Path(__file__).resolve().parents[2]/'test/manual/verify-v0.6-linux.py'
tree = ast.parse(harness.read_text())
terminal_class = next(node for node in tree.body if isinstance(node, ast.ClassDef) and node.name == 'Terminal')
namespace = {'os': os, 'errno': errno, 'fcntl': fcntl, 'select': select, 'time': time, 'subprocess': subprocess}
exec(compile(ast.Module(body=[terminal_class], type_ignores=[]), str(harness), 'exec'), namespace)
Terminal = namespace['Terminal']
prefix = '\x1b[200~/permissions allow-everything\nΔοκιμή e\u0301 😀\x1b[201~\n'.encode()
payload = prefix+b'x'*(17871-len(prefix))
text = payload.decode()
expected_output = b''.join(b'echo:'+payload[index:index+CHUNK]+b'|'+PADDING
                           for index in range(0, len(payload), CHUNK))+DONE
results = []


def run(mode):
    master, slave = pty.openpty()
    tty.setraw(slave)
    child = None
    terminal = Terminal.__new__(Terminal)
    terminal.master = master
    terminal.transcript = bytearray()
    original_flags = fcntl.fcntl(master, fcntl.F_GETFL)
    before_send_flags = None
    begin = time.monotonic()
    stage = 'spawn'
    diff_class = 'none'
    try:
        child = subprocess.Popen([sys.executable, str(Path(__file__).resolve()), '--peer', mode, str(len(payload))],
                                 stdin=slave, stdout=slave, stderr=slave, start_new_session=True)
        terminal.child = child
        os.close(slave)
        slave = None
        signal.setitimer(signal.ITIMER_REAL, 4)
        before_send_flags = fcntl.fcntl(master, fcntl.F_GETFL)
        if mode == 'duplex':
            stage = 'send'
            marker = terminal.send(text)
            stage = 'receipt'
            terminal.read_until(lambda raw: raw.endswith(DONE), timeout=2, expectation='duplex receipt')
            stage = 'marker'
            diff_class = 'marker' if marker != 0 else 'none'
            assert marker == 0
            stage = 'wire'
            actual = bytes(terminal.transcript)
            diff_class = 'length' if len(actual) != len(expected_output) else 'byte' if actual != expected_output else 'none'
            assert bytes(terminal.transcript) == expected_output, 'Duplex input or output bytes changed.'
            result = {'mode': mode, 'inputExact': True, 'outputExact': True,
                      'inputBytes': len(payload), 'outputBytes': len(expected_output),
                      'outputSha256': hashlib.sha256(bytes(terminal.transcript)).hexdigest()}
        elif mode == 'nonconsuming':
            stage = 'send'
            try:
                terminal.send(text, timeout=.35)
            except TimeoutError as error:
                assert not isinstance(error, FixtureDeadline)
                assert 'PTY input timed out' in str(error)
            else:
                raise AssertionError('A stopped PTY consumer must reach the send deadline.')
            assert time.monotonic()-begin < 2
            result = {'mode': mode, 'boundedTimeout': True}
        elif mode == 'exit':
            stage = 'exit'
            child.wait(timeout=2)
            try:
                terminal.send('after-exit\n')
            except AssertionError as error:
                assert 'PTY child exited' in str(error)
            else:
                raise AssertionError('A child exit must be detected before accepting input.')
            result = {'mode': mode, 'childExitDetected': True}
        elif mode == 'eof':
            stage = 'send'
            try:
                terminal.send(text, timeout=1)
            except EOFError:
                pass
            else:
                raise AssertionError('A closed PTY must be detected.')
            result = {'mode': mode, 'ptyEofDetected': True}
        stage = 'flags'
        after_send_flags = fcntl.fcntl(master, fcntl.F_GETFL)
        expected_flags = original_flags | (after_send_flags & DARWIN_FWASWRITTEN)
        diff_class = 'flags' if after_send_flags != expected_flags else 'none'
        assert after_send_flags == expected_flags, 'Master flags were not restored.'
        result.update(flagsRestored=True, elapsedMs=round((time.monotonic()-begin)*1000))
    except BaseException as error:
        cause = {'phase': mode, 'stage': stage, **primitive_error(error),
                 'childStatus': child.poll() if child else None, 'diffClass': diff_class,
                 'actualBytes': len(terminal.transcript), 'expectedBytes': len(expected_output)}
        if stage == 'flags':
            cause.update(flagsOriginal=original_flags, flagsBeforeSend=before_send_flags,
                         flagsAfterSend=fcntl.fcntl(master, fcntl.F_GETFL),
                         nonblockBit=os.O_NONBLOCK, accessMask=os.O_ACCMODE)
        peer_line = bytes(terminal.transcript[-512:]).rsplit(b'PTY_PEER_CAUSE ', 1)
        if len(peer_line) == 2:
            try:
                peer_cause = json.loads(peer_line[1].splitlines()[0])
                if peer_cause.get('errorType') in ERROR_TYPES | {'OtherError'}:
                    cause['peerErrorType'] = peer_cause['errorType']
                if isinstance(peer_cause.get('errno'), int) and 0 <= peer_cause['errno'] <= 255:
                    cause['peerErrno'] = peer_cause['errno']
            except (ValueError, UnicodeError, IndexError):
                pass
        error.fixture_cause = cause
        raise
    finally:
        signal.setitimer(signal.ITIMER_REAL, 0)
        try:
            if child and child.poll() is None:
                assert os.getpgid(child.pid) == child.pid, 'Owned process group changed.'
                os.killpg(child.pid, signal.SIGKILL)
            if child:
                child.wait(timeout=2)
        finally:
            try:
                if slave is not None:
                    os.close(slave)
            finally:
                os.close(master)
    result['childReaped'] = child.returncode is not None
    return result


phase = None
try:
    for phase in ['duplex', 'nonconsuming', 'exit', 'eof']:
        print('PTY_PHASE_'+phase, file=sys.stderr, flush=True)
        results.append(run(phase))
except BaseException as error:
    cause = getattr(error, 'fixture_cause', {'phase': phase, 'stage': 'cleanup', **primitive_error(error)})
    print('PTY_CAUSE '+json.dumps(cause), file=sys.stderr, flush=True)
    raise SystemExit(1)
print(json.dumps({'results': results, 'productLaunched': False, 'modelCalls': 0}))
