#!/usr/bin/env python3
"""Actual native Linux terminal regression using loopback model/ASR/TTS fixtures.

From the product directory, after installing its matching native Codex runtime:
  sudo python3 test/manual/verify-terminal-linux.py
  sudo python3 test/manual/verify-terminal-linux.py --voice-only
  sudo python3 test/manual/verify-terminal-linux.py --output-directory /tmp/proof

Requires Linux, root, Python 3 standard library and Node on PATH. The real CLI and
native Codex engine run inside PTYs. Synthetic executables replace FFmpeg/FFplay;
no microphone, audio output, paid model endpoint, editor or training job is used.
All model/service traffic is loopback, keys are synthetic, HOME/XDG/state are
isolated under temporary directories. Results and redacted logs are written to
--output-directory or a printed temporary result directory. Exit 0 means every
requested flow passed; failure retains a redacted log/request trace for review.
"""
import argparse
import shutil
import sys
import tempfile
import subprocess
import os
from pathlib import Path

arguments_parser = argparse.ArgumentParser(description=__doc__)
arguments_parser.add_argument('--voice-only', action='store_true', help='Run only live voice/native approval regression.')
arguments_parser.add_argument('--output-directory', type=Path, help='Directory for redacted evidence; default is a temporary directory.')
arguments = arguments_parser.parse_args()
if sys.platform != 'linux' or os.geteuid() != 0:
    raise SystemExit('Run this Linux regression as root: sudo python3 test/manual/verify-terminal-linux.py')
PROJECT = Path(__file__).resolve().parents[2]
NODE = shutil.which('node')
if NODE is None:
    raise SystemExit('Node must be available on PATH.')
engine_value = subprocess.check_output([NODE, '--input-type=module', '-e',
    'import { localCodex } from "./src/local-engine.mjs"; process.stdout.write(localCodex());'], cwd=PROJECT, text=True).strip()
ENGINE = engine_value if Path(engine_value).is_absolute() else shutil.which(engine_value)
if ENGINE is None or not Path(ENGINE).is_file():
    raise SystemExit('Install the matching native runtime first: node scripts/setup-runtime.mjs')
OUTPUT = arguments.output_directory.resolve() if arguments.output_directory else Path(tempfile.mkdtemp(prefix='sudocli-terminal-proof-'))
OUTPUT.mkdir(parents=True, exist_ok=True)
print(f'Redacted verification evidence: {OUTPUT}', flush=True)
import fcntl
import http.server
import json
import os
from pathlib import Path
import pty
import re
import select
import signal
import socketserver
import struct
import subprocess
import tempfile
import termios
import threading
import time

requests = []
ansi = re.compile(rb'\x1b(?:\[[0-?]*[ -/]*[@-~]|[@-_])')
def plain(raw):
    return ansi.sub(b'', raw).decode('utf-8', errors='replace')

art = json.loads(subprocess.check_output([NODE, '--input-type=module', '-e',
    'import {ANTENNA_ROWS} from "./src/antenna.mjs"; console.log(JSON.stringify(ANTENNA_ROWS));'], cwd=PROJECT))
def antenna_frames(raw):
    frames = []
    for line in raw.split(b'\r\n'):
        if art[0] in plain(line):
            frames.append(line.split(b'   ', 1)[0])
    return frames

class Server(socketserver.ThreadingMixIn, http.server.HTTPServer):
    daemon_threads = True
class Terminal:
    def __init__(self, workspace, state):
        self.transcript = bytearray()
        self.master, slave = pty.openpty()
        self.resize(40, 142, notify=False)
        env = {**os.environ, 'TERM': 'xterm-256color', 'SUDO_CLI_CODEX': str(ENGINE),
               'SUDO_CLI_STATE_DIR': str(state), 'HOME': str(workspace/'private-home'),
               'XDG_CONFIG_HOME': str(workspace/'private-config'), 'XDG_DATA_HOME': str(workspace/'private-data')}
        for name in ['SUDO_CLI_API_KEY', 'SUDO_CLI_MODEL', 'NO_COLOR']:
            env.pop(name, None)
        self.child = subprocess.Popen([NODE, str(PROJECT/'bin/sudocli.mjs'),
            '--model', 'fixture-primary', '--base-url', f'http://127.0.0.1:{server.server_port}/v1',
            '--transport', 'chat-completions', '--context-window', '10000', '--cwd', str(workspace)],
            env=env, stdin=slave, stdout=slave, stderr=slave, start_new_session=True)
        os.close(slave)
    def resize(self, rows, columns, notify=True):
        fcntl.ioctl(self.master, termios.TIOCSWINSZ, struct.pack('HHHH', rows, columns, 0, 0))
        if notify:
            self.child.send_signal(signal.SIGWINCH)
    def read_until(self, predicate, timeout=30):
        end = time.monotonic()+timeout
        while time.monotonic()<end:
            if predicate(bytes(self.transcript)):
                return
            readable, _, _ = select.select([self.master], [], [], .1)
            if readable:
                try:
                    chunk=os.read(self.master,65536)
                except OSError:
                    break
                if not chunk:
                    break
                self.transcript.extend(chunk)
        raise AssertionError('PTY expectation not observed before timeout')
    def drain(self, duration=.2):
        end=time.monotonic()+duration
        while time.monotonic()<end:
            readable, _, _ = select.select([self.master], [], [], .05)
            if readable:
                try:
                    self.transcript.extend(os.read(self.master,65536))
                except OSError:
                    return
    def send(self,text):
        marker=len(self.transcript)
        os.write(self.master,text.encode())
        return marker
    def ready(self, marker=0):
        self.read_until(lambda raw: re.search(r'(?:\r?\n|^)  you › $',plain(raw[marker:])))
    def command(self,text):
        self.drain(.15)
        marker=self.send(text+'\n')
        self.ready(marker)
        return plain(bytes(self.transcript[marker:]))
    def finish(self):
        self.send('/quit\n')
        end=time.monotonic()+8
        while self.child.poll() is None and time.monotonic()<end:
            self.drain(.1)
        self.child.wait(timeout=5)
        self.drain(.1)
        assert self.child.returncode==0, f'CLI exit:{self.child.returncode}'
        assert b'\x1b[?1049h' in self.transcript and b'\x1b[?1049l' in self.transcript
        assert b'\x1b[r' in self.transcript
        assert KEY.encode() not in self.transcript, 'Credential leaked to the terminal'
    def close(self):
        if self.child.poll() is None:
            self.child.terminate()
            try:
                self.child.wait(timeout=5)
            except subprocess.TimeoutExpired:
                self.child.kill();self.child.wait()
        os.close(self.master)

KEY='v5-only-loopback-fixture-key-private'
requests=[]
asr_texts=[]
asr_requests=[]
speech_requests=[]

class HandlerV5(http.server.BaseHTTPRequestHandler):
    def do_POST(self):
        raw=self.rfile.read(int(self.headers.get('content-length','0')))
        if self.path.endswith('/audio/transcriptions'):
            asr_requests.append(raw)
            assert b'RIFF' in raw and b'voice-phrase.wav' in raw
            content=json.dumps({'text':asr_texts.pop(0) if asr_texts else ''}).encode()
            self.reply(content,'application/json');return
        if self.path.endswith('/audio/speech'):
            speech_requests.append(json.loads(raw));self.reply(b'fixture-audio-only'*128,'audio/mpeg');return
        body=json.loads(raw)
        requests.append(body)
        index=len(requests)
        user='\n'.join(str(message.get('content','')) for message in body.get('messages',[]) if message.get('role')=='user')
        last_user=next((str(message.get('content','')) for message in reversed(body.get('messages',[])) if message.get('role')=='user'),'')
        time.sleep(5 if 'voice slow interrupted task' in last_user else 1.1)
        if body['model']=='fixture-local':
            if 'malformed-local-task' in user: content='{}'
            elif 'cloud job' in user:content=json.dumps({'action':'cloud','reason':'Main model needed.','prompt':'Complete the explicit background cloud job.'})
            else:content=json.dumps({'action':'local','reason':'Done locally.','result':'V5 local completed.'})
        else:content=f'V5 fixture response {index} from {body["model"]}. Credential {KEY}.'
        message={'role':'assistant','content':content};finish='stop'
        if 'voice approval probe' in last_user and not any(message.get('role')=='tool' for message in body.get('messages',[])):
            message={'role':'assistant','content':None,'tool_calls':[{'id':'voice-probe-call','type':'function','function':{'name':'exec_command','arguments':json.dumps({'cmd':"printf 'should require explicit approval' > voice-approval-sentinel.txt",'workdir':str(voice_workspace),'login':False,'sandbox_permissions':'require_escalated','justification':'Fixture needs your explicit permission to prove voice cannot approve native tools.','max_output_tokens':1000})}}]};finish='tool_calls'
        response=json.dumps({'id':f'chatcmpl-v5-{index}','object':'chat.completion','created':1,'model':body['model'],
            'choices':[{'index':0,'message':message,'finish_reason':finish}],
            'usage':{'prompt_tokens':530,'completion_tokens':40,'total_tokens':570}}).encode()
        self.reply(response,'application/json')
    def reply(self,content,kind):
        try:
            self.send_response(200);self.send_header('content-type',kind);self.send_header('content-length',str(len(content)));self.end_headers();self.wfile.write(content)
        except (BrokenPipeError,ConnectionResetError):pass
    def log_message(self,*_):pass
server=Server(('127.0.0.1',0),HandlerV5)
threading.Thread(target=server.serve_forever,daemon=True).start()

def wait_file(predicate,terminal,timeout=30):
    end=time.monotonic()+timeout
    while time.monotonic()<end:
        if predicate():return
        terminal.drain(.1)
    raise AssertionError('Saved-state expectation not observed')

def chats(state):return [json.loads(path.read_text()) for path in (state/'chats').glob('chat-*.json')]
def tasks(state):return [json.loads(path.read_text()) for path in (state/'tasks').glob('*/task-*.json')]
def pointer(state):return json.loads(next((state/'chats').glob('last-*.json')).read_text())['id']
def ask_answer(terminal,marker,label,answer):
    terminal.read_until(lambda raw:label.encode() in raw[marker:]);return terminal.send(answer+'\n')
def task(terminal,text):
    baseline=len(requests);marker=terminal.send(text+'\n')
    terminal.read_until(lambda raw:len(requests)>baseline)
    terminal.read_until(lambda raw:f'V5 fixture response {len(requests)}'.encode() in raw[marker:])
    terminal.ready(marker);return requests[-1]

terminals=[]
detached_record=None
try:
    assert os.geteuid()==0,'Run this compatibility test with WSL --user root'
    if not arguments.voice_only:
        with tempfile.TemporaryDirectory(prefix='sudocli-v5-pty-') as temporary:
            workspace=Path(temporary);state=workspace/'state'
            terminal=Terminal(workspace,state);terminals.append(terminal)
            marker=ask_answer(terminal,0,'API key',KEY);terminal.ready(marker)
            task(terminal,'first saved chat baseline')
            first_id=pointer(state)
            terminal.command('/chatt rename First Saved Chat')
            terminal.command('/switch save Primary')
            terminal.command('/model fixture-local');terminal.command('/switch save Guardian');terminal.command('/model fixture-primary')
            marker=terminal.send('/personalize setup\n')
            for label,answer in [('Optional persona','V5 careful test persona'),('Language','English'),('Tone','direct'),('Reply length','short'),('Reply format','Markdown'),('Other preferences','Explain real test outcomes.')]:
                marker=ask_answer(terminal,marker,label,answer)
            terminal.ready(marker)
            configured=task(terminal,'verify saved persona')
            assert 'V5 careful test persona' in json.dumps(configured['messages'])
            marker=terminal.send('/new\n');marker=ask_answer(terminal,marker,'Keep the current saved chat','y');terminal.ready(marker)
            fresh=task(terminal,'second saved chat independent task')
            second_id=pointer(state);assert second_id!=first_id
            assert 'first saved chat baseline' not in json.dumps(fresh['messages'])
            assert len(chats(state))==2
            terminal.command('/chatt open '+first_id)
            restored=task(terminal,'continue the first chat')
            assert 'first saved chat baseline' in json.dumps(restored['messages'])
            assert 'second saved chat independent task' not in json.dumps(restored['messages'])
            terminal.finish()

            second=Terminal(workspace,state);terminals.append(second)
            marker=ask_answer(second,0,'API key',KEY);second.ready(marker)
            resumed=task(second,'verify restart restoration')
            assert 'first saved chat baseline' in json.dumps(resumed['messages'])
            assert 'V5 careful test persona' in json.dumps(resumed['messages'])
            assert '24/7: Off' in second.command('/247 status')
            marker=second.send('/247 setup\n')
            for label,answer in [('Local coordinator AI','Guardian'),('Local AI key',KEY),('Standing goal',''),('Folder to watch',''),('GPU provider wake URL','')]:
                marker=ask_answer(second,marker,label,answer)
            second.ready(marker)
            second.command('/247 start')
            idle_count=len(requests);second.drain(1.3);assert len(requests)==idle_count,'Idle caused model traffic'
            marker=second.send('/247 add foreground local task\n')
            second.read_until(lambda raw:len(requests)>idle_count)
            second.drain(.5)
            active=plain(bytes(second.transcript[marker:]));assert 'Status: Working' in active,'Background task dashboard did not mark working'
            busy_frames=antenna_frames(bytes(second.transcript[marker:]));assert len(set(busy_frames))>=5,'Background task antenna did not animate'
            wait_file(lambda:any(job['status']=='completed' and job['prompt']=='foreground local task' for job in tasks(state)),second)
            assert requests[-1]['model']=='fixture-local'
            assert requests[-1].get('reasoning_effort') is None
            assert '24/7: running in this terminal' in second.command('/247 status')
            idle_marker=len(second.transcript);second.drain(1.3);idle_frames=antenna_frames(bytes(second.transcript[idle_marker:]));assert idle_frames and len(set(idle_frames))==1,'Idle background antenna did not freeze'
            marker=second.send('/247 add foreground cloud job\n')
            wait_file(lambda:any(job['status']=='completed' and job['prompt']=='foreground cloud job' for job in tasks(state)),second)
            assert [request['model'] for request in requests[-2:]]==['fixture-local','fixture-primary']
            marker=second.send('/247 add malformed-local-task\n')
            count=len(requests)
            wait_file(lambda:any(job['status']=='blocked' and job['prompt']=='malformed-local-task' for job in tasks(state)),second)
            assert len(requests)==count+1,'Malformed assessment called the cloud model'
            second.command('/permissions ask')
            assert '24/7: Off' in second.command('/247 status')
            second.command('/247 detach')
            detached_record=json.loads(next((state/'agents').glob('worker-*.json')).read_text())
            detached_pid=detached_record['pid']
            second.finish()
            os.kill(detached_pid,0)

            third=Terminal(workspace,state);terminals.append(third)
            marker=ask_answer(third,0,'API key',KEY);third.ready(marker)
            assert '24/7: background worker running' in third.command('/247 status')
            marker=third.send('/247 add detached cloud job\n')
            wait_file(lambda:any(job['status']=='completed' and job['prompt']=='detached cloud job' for job in tasks(state)),third)
            assert [request['model'] for request in requests[-2:]]==['fixture-local','fixture-primary']
            job=next(job for job in tasks(state) if job['prompt']=='detached cloud job')
            assert 'completed:' in third.command('/247 result '+job['id'])
            third.command('/web off')
            assert '24/7: Off' in third.command('/247 status')
            try:os.kill(detached_pid,0)
            except ProcessLookupError:pass
            else:raise AssertionError('Policy change did not stop detached worker')
            detached_record=None
            third.finish()
            assert len(chats(state))==2
            for path in state.rglob('*.json'):assert KEY not in path.read_text(),'Synthetic API key persisted'
            transcript=b''.join(terminal.transcript for terminal in terminals)
            assert KEY.encode() not in transcript
            (OUTPUT/'terminal-v5-linux.log').write_bytes(transcript)
            result={'exitCodes':[terminal.child.returncode for terminal in terminals],'modelRequests':len(requests),'nativeLinuxRoot':True,
                'savedChatNewOpenRestart':True,'perAiPersonaInNativePrompt':True,'unrelatedChatNotTransferred':True,'foregroundAgentLocalAndCloud':True,
                'backgroundWorkingDashboard':True,'backgroundBusyAntennaFrames':len(set(busy_frames)),'backgroundIdleAntennaFrozen':True,'idleNoModelCalls':True,'malformedDecisionNoCloud':True,'detachedSurvivesTerminalExit':True,
                'detachedTaskCompletesAndResultsReadable':True,'policyChangesStopForegroundAndDetached':True,'keysNotStoredOrPrinted':True,'physicalAudioUsed':False}
            (OUTPUT/'terminal-v5-linux-result.json').write_text(json.dumps(result,indent=2));print(json.dumps(result))

    # Continuous synthetic PCM and discard-only playback exercise the actual UI,
    # native engine, local VAD and HTTP transcription/TTS without hardware audio.
    with tempfile.TemporaryDirectory(prefix='sudocli-v5-voice-pty-') as temporary:
        voice_workspace=Path(temporary);voice_state=voice_workspace/'state';fake_bin=voice_workspace/'fake-bin';fake_bin.mkdir()
        trigger=fake_bin/'trigger';events=fake_bin/'events.log';trigger.write_text('0')
        (fake_bin/'ffmpeg').write_text(f"""#!{sys.executable}
import os,signal,struct,sys,time
from pathlib import Path
root=Path(sys.argv[0]).parent
(root/'events.log').open('a').write('capture-start\\n')
def stop(*_):
    (root/'events.log').open('a').write('capture-stop\\n');sys.exit(0)
signal.signal(signal.SIGTERM,stop)
zero=bytes(640);loud=struct.pack('<h',10000)*320;previous='0'
while True:
    selected=(root/'trigger').read_text()
    if selected!=previous:
        previous=selected
        for _ in range(20):sys.stdout.buffer.write(loud);sys.stdout.buffer.flush();time.sleep(.02)
        for _ in range(40):sys.stdout.buffer.write(zero);sys.stdout.buffer.flush();time.sleep(.02)
    else:sys.stdout.buffer.write(zero);sys.stdout.buffer.flush();time.sleep(.02)
""")
        (fake_bin/'ffplay').write_text(f"""#!{sys.executable}
import signal,sys,time
from pathlib import Path
root=Path(sys.argv[0]).parent
(root/'events.log').open('a').write('playback-start\\n')
def stop(*_):
    (root/'events.log').open('a').write('playback-interrupted\\n');sys.exit(0)
signal.signal(signal.SIGTERM,stop)
sys.stdin.buffer.read();time.sleep(4)
(root/'events.log').open('a').write('playback-finished\\n')
""")
        for name in ['ffmpeg','ffplay']:(fake_bin/name).chmod(0o700)
        original_path=os.environ['PATH'];os.environ['PATH']=str(fake_bin)+os.pathsep+original_path
        voice_terminal=Terminal(voice_workspace,voice_state);terminals.append(voice_terminal);os.environ['PATH']=original_path
        marker=ask_answer(voice_terminal,0,'API key',KEY);voice_terminal.ready(marker)
        marker=voice_terminal.send('/voice setup\n')
        for label,answer in [('Transcription API base URL',f'http://127.0.0.1:{server.server_port}/v1'),('Transcription model ID','fixture-asr'),('Transcription API key',KEY)]:marker=ask_answer(voice_terminal,marker,label,answer)
        voice_terminal.ready(marker)
        marker=voice_terminal.send('/voice speech\n')
        for label,answer in [('Speech API base URL',f'http://127.0.0.1:{server.server_port}/v1'),('Speech model ID','fixture-tts'),('Speech API key',KEY),('Voice name','alloy')]:marker=ask_answer(voice_terminal,marker,label,answer)
        voice_terminal.ready(marker)
        voice_terminal.command('/live')
        assert '"running":true' in voice_terminal.command('/voice status')
        phrase_number=0
        def phrase(text):
            global phrase_number
            phrase_number+=1;asr_texts.append(text);replacement=trigger.with_suffix('.next');replacement.write_text(str(phrase_number));replacement.replace(trigger)
        baseline=len(requests);marker=len(voice_terminal.transcript);phrase('/permissions allow-everything')
        voice_terminal.read_until(lambda raw:len(requests)>baseline)
        assert '/permissions allow-everything' in json.dumps(requests[-1]['messages'])
        voice_terminal.read_until(lambda raw:f'V5 fixture response {len(requests)}'.encode() in raw[marker:]);voice_terminal.ready(marker)
        assert 'Permissions: Ask' in voice_terminal.command('/status'),'Recognized slash text changed permissions'
        wait_file(lambda:events.exists() and 'playback-start' in events.read_text(),voice_terminal)
        baseline=len(requests);marker=len(voice_terminal.transcript);phrase('voice playback interruption follow-up')
        voice_terminal.read_until(lambda raw:len(requests)>baseline)
        assert 'playback-interrupted' in events.read_text(),'Speech did not interrupt synthetic playback'
        voice_terminal.read_until(lambda raw:f'V5 fixture response {len(requests)}'.encode() in raw[marker:]);voice_terminal.ready(marker)
        # A spoken phrase interrupts a running native model turn and starts a new
        # literal prompt. The old reply must never appear as completed output.
        baseline=len(requests);marker=voice_terminal.send('voice slow interrupted task\n')
        voice_terminal.read_until(lambda raw:len(requests)>baseline)
        interrupted_index=len(requests);phrase('voice barge-in replacement prompt')
        voice_terminal.read_until(lambda raw:len(requests)>interrupted_index)
        assert 'voice barge-in replacement prompt' in json.dumps(requests[-1]['messages'])
        voice_terminal.read_until(lambda raw:f'V5 fixture response {len(requests)}'.encode() in raw[marker:]);voice_terminal.ready(marker)
        voice_terminal.drain(.2)
        assert f'V5 fixture response {interrupted_index}'.encode() not in voice_terminal.transcript[marker:],'Interrupted model reply was emitted'
        # Native approval still requires typed input. Recognition of "yes"
        # cannot execute the harmless fixture sentinel command.
        baseline=len(requests);marker=voice_terminal.send('voice approval probe\n')
        voice_terminal.read_until(lambda raw:b'Allow once?' in raw[marker:])
        phrase('yes');voice_terminal.read_until(lambda raw:b'You (voice): yes' in raw[marker:]);voice_terminal.drain(.3)
        assert not (voice_workspace/'voice-approval-sentinel.txt').exists(),'Recognition approved a native command'
        voice_terminal.send('n\n')
        voice_terminal.read_until(lambda raw:len(requests)>=baseline+2)
        voice_terminal.read_until(lambda raw:f'V5 fixture response {len(requests)}'.encode() in raw[marker:]);voice_terminal.ready(marker)
        assert not (voice_workspace/'voice-approval-sentinel.txt').exists()
        voice_terminal.command('/voice off')
        assert '"running":false' in voice_terminal.command('/voice status')
        count=len(asr_requests);phrase('after stop must never be transcribed');voice_terminal.drain(1.4);assert len(asr_requests)==count
        voice_terminal.finish()
        assert 'capture-stop' in events.read_text()
        assert len(asr_requests)==4 and len(speech_requests)>=3
        assert all(KEY not in path.read_text() for path in voice_state.rglob('*.json'))
        voice_result={'exitCode':voice_terminal.child.returncode,'nativeLinuxRoot':True,'transcribedPhrases':len(asr_requests),'speechRequests':len(speech_requests),
            'syntheticContinuousPcm':True,'syntheticPlaybackOnly':True,'physicalAudioUsed':False,'slashRecognitionIsLiteral':True,'permissionsRemainAsk':True,
            'playbackBargeIn':True,'nativeModelBargeIn':True,'spokenYesNeverApprovesNativeCommand':True,'stopEndsCaptureAndTranscription':True,'keysNotStoredOrPrinted':True}
        (OUTPUT/'terminal-v5-live-voice-result.json').write_text(json.dumps(voice_result,indent=2))
        (OUTPUT/'terminal-v5-live-voice.log').write_bytes(voice_terminal.transcript);print(json.dumps(voice_result))
except BaseException:
    (OUTPUT/'terminal-v5-linux-failure.log').write_bytes(b''.join(terminal.transcript for terminal in terminals).replace(KEY.encode(),b'[redacted]'))
    (OUTPUT/'terminal-v5-linux-failure-requests.json').write_text(json.dumps({'requests':requests,'asrRequests':len(asr_requests),'speechRequests':speech_requests},indent=2).replace(KEY,'[redacted]'))
    raise
finally:
    if detached_record:
        try:
            import urllib.request
            request=urllib.request.Request(f'http://127.0.0.1:{detached_record["port"]}/stop',method='POST',headers={'Authorization':'Bearer '+detached_record['token']})
            urllib.request.urlopen(request,timeout=3).close()
        except Exception:pass
    for terminal in terminals:terminal.close()
    server.shutdown();server.server_close()
