#!/usr/bin/env python3
"""Actual Linux PTY acceptance for picker, colors, notifications and AI activity.

Run as root on Linux/WSL with Node >=22 after sealing the release. Private
HOME/XDG/state/project directories disable startup update checks. No AI endpoint,
API key, package installation or real user settings are used. The optional
--with-native-ai scenario uses only a deterministic delayed loopback provider;
its actual request count is reported separately from zero paid model calls.
The ECMA-48 screen decoder checks cursor geometry and cell colors, not physical
cursor blinking or Windows ConsoleHost appearance. --self-test checks the decoder
and proves that a cursor left on the picker footer fails the geometry assertion.
"""
import argparse
import codecs
import fcntl
import json
import os
from pathlib import Path
import pty
import re
import select
import shutil
import signal
import struct
import subprocess
import sys
import tempfile
import termios
import time
import shlex
import http.server
import socketserver
import threading

PROJECT = Path(__file__).resolve().parents[2]
HEADER, DEFAULT_USER, BODY = '#0b0f14', '#00ff00', '#dce3eb'
INACTIVE = '#ddbdb8'
ANTENNA_TOP = '⠀⠀⠀⢠⡄⠀⠀⣠⡄⠀⠀⣠⠄'
LEFT_WAVES = [{0:[11,12],1:[11],2:[11],3:[11,12]},
              {0:[7,8],1:[7],2:[7,8],3:[7,8,9],4:[8,9,10]},
              {0:[3,4],1:[3],2:[3,4],3:[3,4],4:[4,5],5:[5,6,7],6:[7,8,9]}]
CSI = re.compile(r'\x1b\[([0-?]*)([ -/]*)([@-~])')
ANSI = re.compile(r'\x1b(?:\[[0-?]*[ -/]*[@-~]|[@-_])')
STANDARD = ['#000000','#800000','#008000','#808000','#000080','#800080','#008080','#c0c0c0','#808080','#ff0000','#00ff00','#ffff00','#0000ff','#ff00ff','#00ffff','#ffffff']
PAGE_UP, PAGE_DOWN = '\x1b[5~', '\x1b[6~'
TOP, BOTTOM = '\x1b[1;5H', '\x1b[1;5F'
WHEEL_UP, WHEEL_DOWN = '\x1b[<64;10;30M', '\x1b[<65;10;30M'
terminals, results, provider_records = [], {}, []


def plain(raw):
    text = raw.decode('utf-8', errors='replace')
    text = re.sub(r'\x1b7.*?\x1b8', '', text, flags=re.S)
    return ANSI.sub('', text)


# Copied from the v0.6.4 scrolling acceptance; this harness has no runtime import
# of another acceptance script and therefore never runs its full main routine.
class Screen:
    def __init__(self, rows=44, columns=150):
        self.rows, self.columns = rows, columns
        self.row = self.column = 0
        self.fg = self.bg = None
        self.top, self.bottom = 0, rows-1
        self.saved, self.visible = None, True
        self.grid = [self.blank() for _ in range(rows)]
        self.pending = ''
        self.frame_depth = self.frames = 0
        self.decoder = codecs.getincrementaldecoder('utf-8')('replace')
    def blank(self):
        return [(' ', self.fg, self.bg) for _ in range(self.columns)]
    def linefeed(self):
        if self.row == self.bottom:
            del self.grid[self.top]
            self.grid.insert(self.bottom, self.blank())
        else:
            self.row = min(self.rows-1, self.row+1)
    def sgr(self, numbers):
        index = 0
        while index < len(numbers):
            code = numbers[index]
            if code == 0: self.fg = self.bg = None
            elif code == 39: self.fg = None
            elif code == 49: self.bg = None
            elif 30 <= code <= 37: self.fg = STANDARD[code-30]
            elif 90 <= code <= 97: self.fg = STANDARD[code-90+8]
            elif 40 <= code <= 47: self.bg = STANDARD[code-40]
            elif code in (38,48) and index+4 < len(numbers) and numbers[index+1] == 2:
                value = '#'+''.join(f'{n:02x}' for n in numbers[index+2:index+5])
                if code == 38: self.fg = value
                else: self.bg = value
                index += 4
            index += 1
    def csi(self, parameters, final):
        if parameters.startswith('?'):
            if parameters == '?25': self.visible = final == 'h'
            return
        numbers = [int(n or 0) for n in parameters.split(';')] if parameters else [0]
        n = numbers[0] or 1
        if final == 'm': self.sgr(numbers)
        elif final in ('H','f'):
            self.row = min(self.rows-1,max(0,n-1))
            self.column = min(self.columns-1,max(0,(numbers[1] if len(numbers)>1 else 1)-1))
        elif final == 'G': self.column = min(self.columns-1,n-1)
        elif final == 'A': self.row = max(0,self.row-n)
        elif final == 'B': self.row = min(self.rows-1,self.row+n)
        elif final == 'C': self.column = min(self.columns-1,self.column+n)
        elif final == 'D': self.column = max(0,self.column-n)
        elif final == 'r':
            self.top = max(0,(numbers[0] or 1)-1)
            self.bottom = min(self.rows-1,(numbers[1] if len(numbers)>1 and numbers[1] else self.rows)-1)
            self.row = self.column = 0
        elif final == 'J':
            if numbers[0] == 2: self.grid = [self.blank() for _ in range(self.rows)]
            elif numbers[0] == 0:
                self.grid[self.row][self.column:] = self.blank()[self.column:]
                for row in range(self.row+1,self.rows): self.grid[row] = self.blank()
        elif final == 'K':
            if numbers[0] == 2: self.grid[self.row] = self.blank()
            elif numbers[0] == 0: self.grid[self.row][self.column:] = self.blank()[self.column:]
    def feed(self, data):
        self.pending += self.decoder.decode(data)
        index = 0
        while index < len(self.pending):
            char = self.pending[index]
            if char == '\x1b':
                if index+1 >= len(self.pending): break
                match = CSI.match(self.pending,index)
                if match:
                    self.csi(match[1],match[3]);index=match.end();continue
                following = self.pending[index+1]
                if following == '[': break
                if following == '7':
                    self.saved = (self.row,self.column,self.fg,self.bg);self.frame_depth += 1;self.frames += 1
                elif following == '8':
                    self.frame_depth -= 1
                    assert self.frame_depth >= 0, 'Unmatched terminal saved-cursor restore'
                    if self.saved:self.row,self.column,self.fg,self.bg = self.saved
                index += 2;continue
            if char == '\r': self.column = 0
            elif char == '\n': self.linefeed()
            elif char == '\b': self.column = max(0,self.column-1)
            elif char == '\t': self.column = min(self.columns-1,(self.column//8+1)*8)
            elif ord(char) >= 32:
                if self.column >= self.columns: self.column=0;self.linefeed()
                self.grid[self.row][self.column] = (char,self.fg,self.bg)
                self.column += 1
            index += 1
        self.pending = self.pending[index:]
    def balanced(self):
        return self.frame_depth == 0 and not self.pending and not self.decoder.getstate()[0]
    def text(self):
        return '\n'.join(''.join(cell[0] for cell in row) for row in self.grid)
    def lines(self):
        return [''.join(cell[0] for cell in row).rstrip() for row in self.grid]
    def find(self, text, *, header=False):
        for index,row in enumerate(self.grid[:self.top] if header else self.grid):
            offset = ''.join(cell[0] for cell in row).find(text)
            if offset >= 0: return index,offset
        raise AssertionError(f'Missing rendered text {text!r}:\n{self.text()}')
    def cells(self, text):
        row,column = self.find(text)
        return self.grid[row][column:column+len(text)]
    def resize(self, rows, columns):
        self.rows,self.columns=rows,columns;self.row=self.column=0
        self.top,self.bottom=0,rows-1;self.saved=None
        self.grid=[self.blank() for _ in range(rows)]
    def assert_regions(self, bg):
        assert self.top > 1, 'Sticky header region missing'
        assert all(cell[2] == HEADER for row in self.grid[:self.top] for cell in row), 'Chat background leaked into dashboard'
        assert all(cell[2] == bg for row in self.grid[self.top:] for cell in row), 'Chat and empty rows lost their background'
        assert any(cell[1] == '#ef2929' for row in self.grid[:5] for cell in row), 'Original logo color changed'
        assert any(cell[1] == BODY for row in self.grid[5:self.top] for cell in row), 'Original antenna tower color changed'


def assert_search_cursor(screen, query, color=None):
    assert screen.balanced(), 'Cursor sampled inside an incomplete terminal redraw'
    label = 'Search: /'+query
    row,column = screen.find(label)
    expected = (row,column+len(label))
    assert (screen.row,screen.column) == expected, f'Picker cursor is {(screen.row,screen.column)}, expected editable suffix {expected}'
    assert screen.visible, 'Picker editing cursor is hidden'
    assert 0 <= screen.column < screen.columns and 0 <= screen.row < screen.rows
    if color:
        assert all(cell[1] == color for cell in screen.cells(label)), 'Search line did not use the live user text color'
    return {'row':screen.row+1,'column':screen.column+1,'visible':screen.visible,'search':label}


def assert_live_input(screen, draft, color, bg=HEADER):
    assert screen.balanced(), 'Live cursor sampled inside an incomplete terminal redraw'
    label = '  you › '+draft
    row = screen.row
    line = ''.join(cell[0] for cell in screen.grid[row])
    offset = line.find(label)
    assert offset >= 0, f'Active cursor row does not contain live prompt/draft {label!r}: {line!r}'
    assert screen.column == offset+len(label) and screen.visible, 'Live Readline cursor is not at the draft suffix'
    assert all(cell[1] == color and cell[2] == bg for cell in screen.grid[row][offset:offset+len(label)]), 'Live prompt/draft color differs from the saved user color'


def assert_literal_paste_view(screen, probe):
    count=screen.text().count(probe)
    assert count==1,f'Queued paste has {count} visible copies; expected one retained user entry'
    row,_=screen.find(probe)
    assert row+1<screen.rows and screen.lines()[row+1].strip()=='/quit','Pasted slash line was not retained as literal multiline text'
    assert all(cell[1]==DEFAULT_USER for cell in screen.cells(probe)),'Queued paste lost the live user foreground'
    return count


def seed_preferences(root):
    preferences=root/'state/preferences';preferences.mkdir(parents=True,exist_ok=True,mode=0o700)
    updates=preferences/'github-updates.json'
    updates.write_text(json.dumps({'version':1,'repository':'panmm942-ui/sudo_cli','enabled':False}))
    updates.chmod(0o600)
    notifications=preferences/'notifications.json'
    if not notifications.exists():
        notifications.write_text(json.dumps({'version':1,'enabled':False}));notifications.chmod(0o600)


class Terminal:
    def __init__(self, root, *, term='xterm-256color', no_color=False, extra_env=None, extra_args=None):
        self.root,self.term=root,term
        self.raw=bytearray();self.screen=Screen()
        for name in ('project','home','tmp','xdg-config','xdg-data','xdg-state'):
            (root/name).mkdir(parents=True,exist_ok=True,mode=0o700)
        seed_preferences(root)
        self.master,slave=pty.openpty()
        fcntl.ioctl(self.master,termios.TIOCSWINSZ,struct.pack('HHHH',44,150,0,0))
        self.env={'PATH':os.environ.get('PATH','/usr/bin:/bin'),'TERM':term,'LANG':'C.UTF-8','HOME':str(root/'home'),
                  'TMPDIR':str(root/'tmp'),'XDG_CONFIG_HOME':str(root/'xdg-config'),'XDG_DATA_HOME':str(root/'xdg-data'),
                  'XDG_STATE_HOME':str(root/'xdg-state'),'SUDO_CLI_STATE_DIR':str(root/'state')}
        if no_color: self.env['NO_COLOR']='1'
        if args.engine:self.env['SUDO_CLI_CODEX']=args.engine
        if extra_env:self.env.update(extra_env)
        self.child=subprocess.Popen([args.node,str(PROJECT/'bin/sudocli.mjs'),'--cwd',str(root/'project'),*(extra_args or [])],
                                    cwd=root/'project',env=self.env,stdin=slave,stdout=slave,stderr=slave,start_new_session=True)
        os.close(slave);terminals.append(self)
    def drain(self, seconds=.2, settle_timeout=2):
        start=time.monotonic();end=start+seconds;deadline=end+settle_timeout;last_data=start
        while time.monotonic()<deadline:
            now=time.monotonic()
            if now>=end and self.screen.balanced() and now-last_data>=.012:return
            readable,_,_=select.select([self.master],[],[],.012)
            if readable:
                try: data=os.read(self.master,65536)
                except OSError:
                    assert self.screen.balanced(),'Terminal closed during an incomplete redraw';return
                if not data:
                    assert self.screen.balanced(),'Terminal closed during an incomplete redraw';return
                self.raw.extend(data);self.screen.feed(data)
                last_data=time.monotonic()
        raise AssertionError(f'Terminal redraw did not settle within {settle_timeout}s: saves/restores depth={self.screen.frame_depth}, pending={self.screen.pending!r}, utf8={self.screen.decoder.getstate()[0]!r}')
    def send(self, text):
        self.drain(.03);marker=len(self.raw);os.write(self.master,text.encode());return marker
    def ready(self, marker=0, timeout=20):
        end=time.monotonic()+timeout
        while time.monotonic()<end:
            if re.search(r'(?:^|\n)  you › $',plain(bytes(self.raw[marker:]))): self.drain(.1);return
            if self.child.poll() is not None: break
            self.drain(.1)
        raise AssertionError('CLI input prompt missing: '+plain(bytes(self.raw[-3000:])))
    def command(self, text):
        marker=self.send('\x15'+text+'\n');self.ready(marker)
        output=plain(bytes(self.raw[marker:]))
        assert 'Unknown command' not in output, text
        return output
    def keys(self, text):
        marker=self.send(text);self.drain(.2);return bytes(self.raw[marker:])
    def resize(self, rows, columns):
        self.drain(.03);self.screen.resize(rows,columns)
        fcntl.ioctl(self.master,termios.TIOCSWINSZ,struct.pack('HHHH',rows,columns,0,0))
        self.child.send_signal(signal.SIGWINCH);self.drain(.3)
        assert self.child.poll() is None,'Resize terminated the CLI'
    def saved(self):
        records=list((self.root/'state').rglob('terminal-theme.json'))
        assert len(records)==1,records
        return json.loads(records[0].read_text())
    def notification_preference(self):
        return json.loads((self.root/'state/preferences/notifications.json').read_text())
    def until(self, predicate, timeout=20, label='PTY expectation'):
        end=time.monotonic()+timeout
        while time.monotonic()<end:
            self.drain(.04)
            if predicate():return
            if self.child.poll() is not None:break
        raise AssertionError(label+' missing: '+plain(bytes(self.raw[-3000:])))
    def pending_literal(self, payload, timeout=4):
        end=time.monotonic()+timeout
        while time.monotonic()<end:
            records=list((self.root/'state/chats').glob('chat-*.json'))
            if len(records)==1:
                record=json.loads(records[0].read_text())
                if record.get('pendingInputs')==[payload]:
                    assert not record.get('connection'),'Offline paste unexpectedly acquired an AI connection'
                    return record['pendingInputs']
            self.drain(.1)
        raise AssertionError('Saved chat did not retain exactly one literal multiline pending input')
    def capture(self, name):
        self.drain(.04)
        (OUTPUT/f'{name}.txt').write_text(sanitize(self.screen.text()),encoding='utf-8')
        snapshot={'rows':self.screen.rows,'columns':self.screen.columns,'cursor':{'row':self.screen.row+1,'column':self.screen.column+1,'visible':self.screen.visible},
                  'scrollRegion':{'top':self.screen.top+1,'bottom':self.screen.bottom+1},'redraw':{'balanced':self.screen.balanced(),'frames':self.screen.frames},'cells':self.screen.grid}
        (OUTPUT/f'{name}.json').write_text(sanitize(json.dumps(snapshot,ensure_ascii=False,indent=2)),encoding='utf-8')
    def finish(self):
        self.send('\x15/quit\n');end=time.monotonic()+8
        while self.child.poll() is None and time.monotonic()<end:self.drain(.1)
        self.child.wait(timeout=3);self.drain(.05)
        assert self.child.returncode==0,self.child.returncode
        if self.term!='dumb':
            assert b'\x1b[?1049l' in self.raw,'Alternate screen not restored'
            assert b'\x1b[?1000l' in self.raw and b'\x1b[?1006l' in self.raw,'Mouse reporting not disabled'
            assert b'\x1b[?2004l' in self.raw,'Bracketed paste not disabled'
            assert self.screen.visible,'Exit left the terminal cursor hidden'
    def close(self):
        if self.child.poll() is None:
            self.child.terminate()
            try:self.child.wait(timeout=3)
            except subprocess.TimeoutExpired:self.child.kill();self.child.wait()
        os.close(self.master)


def seed_replay(root):
    (root/'project').mkdir(parents=True,exist_ok=True,mode=0o700)
    seed_preferences(root)
    script=r'''
      import {createChatStore} from './src/chat-store.mjs';
      import {join} from 'node:path';
      const root=process.argv[1];
      const history={version:1,messages:[{id:'user-probe',role:'user',model:null,content:'COLOR_REPLAY_PROBE'},
        {id:'body-probe',role:'assistant',model:null,content:'BODY_REPLAY_PROBE',status:'completed'}]};
      const store=await createChatStore({cwd:join(root,'project'),stateDir:join(root,'state')});
      await store.create({title:'UI acceptance',history});
    '''
    subprocess.run([args.node,'--input-type=module','-e',script,str(root)],cwd=PROJECT,check=True,timeout=15)


def local_counters(terminal):
    script=r'''
      import {createSystemPerformance} from './src/system-performance.mjs';
      const monitor=createSystemPerformance();
      monitor.start();await new Promise(resolve=>setTimeout(resolve,1100));await monitor.sample();
      const value=monitor.snapshot();monitor.stop();console.log(JSON.stringify(value));
    '''
    return json.loads(subprocess.check_output([args.node,'--input-type=module','-e',script],cwd=PROJECT,env=terminal.env,text=True,timeout=15))


def assert_performance(output, counters):
    assert 'Performance (This PC)' in output, 'Performance scope was not identified as this PC'
    metrics={label:re.search(r'\b'+label+r': ([^\r\n]+)',output) for label in ('CPU','RAM','GPU','VRAM')}
    assert all(metrics.values()), 'A CPU/RAM/GPU/VRAM status was omitted'
    values={label:match[1].strip() for label,match in metrics.items()}
    cpu=re.fullmatch(r'(\d+(?:\.\d+)?)%',values['CPU'])
    assert cpu and 0<=float(cpu[1])<=100,'CPU counter was not measured after the warm-up interval'
    ram=re.match(r'(\d+(?:\.\d+)?)/(\d+(?:\.\d+)?) GiB',values['RAM'])
    assert ram and 0<=float(ram[1])<=float(ram[2]) and float(ram[2])>0,'RAM counters were invalid'
    total=os.sysconf('SC_PAGE_SIZE')*os.sysconf('SC_PHYS_PAGES')/1024**3
    assert abs(float(ram[2])-total)<.15, 'RAM total differs from this computer’s OS memory counter'
    assert counters['scope']=='local-computer' and counters['ram']['status']=='available'
    if counters['gpu']['status']=='unavailable' and counters['gpu']['percent'] is None:
        assert values['GPU']=='Unavailable', 'Unavailable GPU was presented as a numeric usage'
    else:
        gpu=re.match(r'(\d+(?:\.\d+)?)%',values['GPU'])
        assert values['GPU'] in ('Unavailable','Measuring') or gpu and 0<=float(gpu[1])<=100
    if counters['vram']['usedBytes'] is None:
        assert values['VRAM'] in ('Unavailable','Shared RAM; usage unavailable'), 'Unavailable VRAM was presented as zero bytes'
    else:
        assert 'GiB' in values['VRAM'],'Available VRAM omitted its units'
    return values


def assert_no_color(raw):
    assert not re.search(rb'\x1b\[(?:3[0-9]|4[0-9]|9[0-9]|10[0-7])(?:;[0-9]+)*m',raw), 'Plain terminal emitted color sequences'


def sanitize(text):
    return text.replace(str(root),'[isolated-root]').replace(str(PROJECT),'[release-root]').replace('V067-private-loopback-test-key','[fixture-key]')


def antenna_signature(screen):
    assert screen.balanced(),'Antenna sampled inside an incomplete terminal redraw'
    row,column=screen.find(ANTENNA_TOP,header=True)
    cells=[]
    for ring in LEFT_WAVES:
        for y,columns in ring.items():
            for x in columns:
                for offset in (x,29-x):cells.append(screen.grid[row+y][column+offset])
    return tuple(cells)


def assert_idle_antenna(screen, initial=None, *, zero_work=True):
    signature=antenna_signature(screen)
    assert all(cell[1]==INACTIVE for cell in signature),'Offline curved antenna waves were animated instead of inactive'
    if initial is not None:assert signature==initial,'Non-AI operation advanced the antenna phase'
    header='\n'.join(screen.lines()[:screen.top])
    assert 'Status: Not Working' in header,'Local-only operation incorrectly marked AI Working'
    if zero_work:assert 'Worked: 00:00:00 | In Total: 00:00:00' in header,'Local-only operation increased AI worked time'
    return signature


def worked_seconds(screen):
    header='\n'.join(screen.lines()[:screen.top])
    match=re.search(r'Worked: (\d+):(\d+):(\d+)',header)
    assert match,'Worked-time status missing from native header'
    return int(match[1])*3600+int(match[2])*60+int(match[3])


def assert_frozen_antenna(cli, name):
    cli.drain(.08);signature=antenna_signature(cli.screen);worked=worked_seconds(cli.screen)
    assert 'Status: Not Working' in '\n'.join(cli.screen.lines()[:cli.screen.top]),'Finished/paused AI still marked Working'
    cli.drain(1.3)
    assert antenna_signature(cli.screen)==signature,'Paused/finished AI antenna phase kept advancing'
    assert worked_seconds(cli.screen)==worked,'Paused/finished AI worked-time meter kept advancing'
    cli.capture(name);return {'workedSeconds':worked,'waveCells':len(signature)}


def run_native_activity_acceptance():
    key='V067-private-loopback-test-key';model='fixture-native-chat-completions'
    errors=[];gates={label:threading.Event() for label in ('DONE','APPROVAL','INTERRUPT')};received={label:threading.Event() for label in gates}
    class Server(socketserver.ThreadingMixIn,http.server.HTTPServer):daemon_threads=True
    class Fixture(http.server.BaseHTTPRequestHandler):
        def log_message(self,*_):pass
        def chunk(self,delta,finish=None):
            values={'role':None,'content':None,'reasoning_content':None,'tool_calls':None,**delta}
            payload={'id':'chatcmpl-v067-fixture','object':'chat.completion.chunk','model':model,'choices':[{'index':0,'delta':values,'finish_reason':finish}]}
            self.wfile.write(('data: '+json.dumps(payload)+'\n\n').encode());self.wfile.flush()
        def completed(self,text):
            self.chunk({'role':'assistant','content':text},'stop')
            self.wfile.write(b'data: {"choices":[],"usage":{"prompt_tokens":200,"completion_tokens":20,"total_tokens":220}}\n\ndata: [DONE]\n\n');self.wfile.flush()
        def do_POST(self):
            try:
                assert self.path=='/v1/chat/completions',self.path
                assert self.headers.get('authorization')=='Bearer '+key,'Loopback fixture credential missing'
                length=int(self.headers['content-length']);assert 0<length<2*1024*1024,'Fixture request exceeded bound'
                body=json.loads(self.rfile.read(length));assert body['model']==model and body.get('stream') is True
                latest='';outputs=[]
                for message in body['messages']:
                    if message['role']=='user':latest=str(message.get('content',''))
                    elif message['role']=='tool':outputs.append(message)
                label=next((label for label in gates if 'V067_'+label in latest),None);assert label,'Unexpected loopback AI prompt'
                provider_records.append({'path':self.path,'scenario':label,'request':body});received[label].set()
                self.send_response(200);self.send_header('content-type','text/event-stream');self.end_headers()
                assert gates[label].wait(20),'Fixture release gate timed out'
                if label=='APPROVAL' and not any(output.get('tool_call_id')=='v067-approval-call' for output in outputs):
                    tool=next((item['function']['name'] for item in body['tools'] if item.get('type')=='function' and (item['function']['name']=='exec_command' or item['function']['name'].endswith('__exec_command'))),None)
                    assert tool,'Native exec_command tool missing'
                    values={'cmd':"python3 -c 'print(\"V067_DECLINED_LOCAL_TOOL\")'",'workdir':str(native_root/'project'),'login':False,'sandbox_permissions':'require_escalated','justification':'Disposable UI fixture approval; decline this harmless print command.','max_output_tokens':1000}
                    self.chunk({'role':'assistant','reasoning_content':'Fixture asks for an explicit approval so the paused antenna can be observed.'})
                    self.chunk({'tool_calls':[{'index':0,'id':'v067-approval-call','type':'function','function':{'name':tool,'arguments':json.dumps(values)}}]},'tool_calls')
                    self.wfile.write(b'data: [DONE]\n\n');self.wfile.flush()
                else:self.completed('V067_'+label+'_FIXTURE_DONE')
            except (BrokenPipeError,ConnectionResetError):pass
            except BaseException as error:
                errors.append(sanitize(repr(error)))
                try:self.send_error(500,'Fixture validation failed')
                except (BrokenPipeError,ConnectionResetError):pass
    server=Server(('127.0.0.1',0),Fixture);threading.Thread(target=server.serve_forever,daemon=True).start()
    native_root=root/'native-ai';native_root.mkdir(mode=0o700)
    events=OUTPUT/'native-events.jsonl';events.write_text('')
    observer=native_root/'observe-native.mjs'
    # The installed native runtime is real. This preload only disables its
    # unrelated public plugin catalog and observes app-server lifecycle JSON.
    observer.write_text('import cp from "node:child_process";import {syncBuiltinESMExports} from "node:module";import {appendFileSync} from "node:fs";\n'
        'const original=cp.spawn;cp.spawn=function(command,args,options){if(String(command).endsWith("/codex")&&args?.includes("app-server"))args=[...args,"-c","features.plugins=false"];const child=original(command,args,options);'
        'if(String(command).endsWith("/codex")&&args?.includes("app-server")){let buffer="";child.stdout.on("data",chunk=>{buffer+=chunk.toString();let index;while((index=buffer.indexOf("\\n"))>=0){const line=buffer.slice(0,index);buffer=buffer.slice(index+1);try{const event=JSON.parse(line);if(event.method)appendFileSync('+json.dumps(str(events))+',JSON.stringify(event)+"\\n");}catch{}}});}return child;};syncBuiltinESMExports();\n')
    cli=Terminal(native_root,extra_env={'SUDO_CLI_API_KEY':key,'NODE_OPTIONS':'--import '+str(observer)},extra_args=['--model',model,'--base-url',f'http://127.0.0.1:{server.server_port}/v1','--transport','chat-completions','--context-window','131072','--permissions','ask','--scope','full','--web','on'])
    try:
        cli.ready();assert_idle_antenna(cli.screen);assert 'Notifications: Off' in cli.command('/notify status')
        start=cli.send('V067_DONE: delayed deterministic local response.\n');cli.until(lambda:received['DONE'].is_set(),label='actual native loopback model request')
        assert 'Status: Working' in '\n'.join(cli.screen.lines()[:cli.screen.top]);first=antenna_signature(cli.screen)
        cli.drain(.28);second=antenna_signature(cli.screen);assert first!=second,'Actual native AI task did not animate curved waves'
        cli.drain(1.0);assert worked_seconds(cli.screen)>=1,'Actual model task did not advance worked time';cli.capture('native-ai-working')
        gates['DONE'].set();cli.until(lambda:'V067_DONE_FIXTURE_DONE' in plain(bytes(cli.raw[start:])),label='native fixture response completion');cli.ready(start)
        done=assert_frozen_antenna(cli,'native-ai-completed-frozen')
        start=cli.send('V067_APPROVAL: request the disposable approval and continue after decline.\n');cli.until(lambda:received['APPROVAL'].is_set(),label='approval fixture request')
        cli.drain(.35);gates['APPROVAL'].set();cli.until(lambda:'Allow once? [y/N] › ' in cli.screen.text(),label='actual native permission prompt')
        approval=assert_frozen_antenna(cli,'native-ai-approval-paused');cli.send('n\n')
        cli.until(lambda:'V067_APPROVAL_FIXTURE_DONE' in plain(bytes(cli.raw[start:])),label='native response after declined approval');cli.ready(start)
        assert_frozen_antenna(cli,'native-ai-after-approval-frozen')
        start=cli.send('V067_INTERRUPT: wait for interruption during the actual request.\n');cli.until(lambda:received['INTERRUPT'].is_set(),label='interrupt fixture request')
        cli.drain(.25);before=antenna_signature(cli.screen);cli.drain(.25);assert before!=antenna_signature(cli.screen),'Interrupt scenario was not actually working'
        stop_marker=cli.send('/stop\n');cli.ready(stop_marker);stopped=assert_frozen_antenna(cli,'native-ai-interrupted-frozen')
        assert not errors,errors;assert key.encode() not in cli.raw,'Fixture key leaked to terminal'
        cli.finish();assert b'\x07' not in cli.raw,'Seeded disabled notifications emitted a physical bell'
        lifecycle=[json.loads(line) for line in events.read_text().splitlines()]
        assert any(item.get('method')=='item/commandExecution/requestApproval' for item in lifecycle),'Native approval lifecycle evidence missing'
        results['actualNativeAiWorkingApprovalDoneInterruptedFreeze']={'transport':'chat-completions','nativeRequests':len(provider_records),'paidRequests':0,'workingAnimationChanged':True,'done':done,'approvalPaused':approval,'interrupted':stopped,'approvalDecision':'declined','notifications':'disabled throughout'}
    finally:
        for gate in gates.values():gate.set()
        server.shutdown();server.server_close()
        events.write_text(sanitize(events.read_text()),encoding='utf-8')
        (OUTPUT/'provider-requests.json').write_text(sanitize(json.dumps(provider_records,indent=2)),encoding='utf-8')


def decoder_self_test():
    screen=Screen(12,80)
    screen.feed(b'\x1b[4;1HSearch: /color\x1b[7;1HArrows / PgUp/PgDn | Enter select | Esc close\x1b[4;15H\x1b[?25h')
    assert_search_cursor(screen,'color')
    screen.feed(b'\x1b7\x1b[1;1Hheader tick\x1b8')
    assert_search_cursor(screen,'color')
    screen.feed(b'\x1b7\x1b[1;1Hpartial header (11.')
    assert not screen.balanced()
    try:assert_search_cursor(screen,'color')
    except AssertionError:pass
    else:raise AssertionError('Geometry accepted the v066 incomplete-redraw sampling race')
    screen.feed(b'2 GiB)\x1b8');assert_search_cursor(screen,'color')
    screen.feed(b'\x1b[');assert not screen.balanced();screen.feed(b'0m');assert screen.balanced()
    screen.feed(b'\xe2');assert not screen.balanced();screen.feed(b'\x80\xba');assert screen.balanced()
    screen.feed(b'\x1b[4;15H')
    screen.feed(b'\x1b[7;44H')
    try:assert_search_cursor(screen,'color')
    except AssertionError:pass
    else:raise AssertionError('Geometry assertion accepted the original footer-cursor defect')
    screen=Screen(12,80)
    screen.feed(b'\x1b[38;2;0;255;0m\x1b[3;1H  you \xe2\x80\xba MULTILINE_PASTE_VIEW_PROBE\r\n/quit')
    assert_literal_paste_view(screen,'MULTILINE_PASTE_VIEW_PROBE')
    screen.feed(b'\x1b[7;1H  you \xe2\x80\xba MULTILINE_PASTE_VIEW_PROBE\r\n/quit')
    try:assert_literal_paste_view(screen,'MULTILINE_PASTE_VIEW_PROBE')
    except AssertionError:pass
    else:raise AssertionError('Paste assertion accepted duplicate retained entries')
    print(json.dumps({'passed':True,'selfTest':'ANSI cursor geometry; rejected footer and half-redraw regressions; fragmented CSI/UTF-8; rejected duplicate pasted viewport entries'}))


def run_acceptance():
    primary=root/'cli';seed_replay(primary)
    cli=Terminal(primary);cli.ready();cli.screen.assert_regions(HEADER)
    initial_antenna=assert_idle_antenna(cli.screen);cli.drain(1.3);assert_idle_antenna(cli.screen,initial_antenna)
    cli.capture('initial-offline-inactive-antenna')
    assert_live_input(cli.screen,'',DEFAULT_USER)
    assert all(cell[1]==BODY for cell in cli.screen.cells('BODY_REPLAY_PROBE')),'Default assistant/body text lost soft white'
    cli.keys('/')
    results['emptyPickerCursor']=assert_search_cursor(cli.screen,'',DEFAULT_USER)
    cli.capture('picker-empty')
    cli.keys('color');assert_search_cursor(cli.screen,'color',DEFAULT_USER)
    option_rows=[index for index,line in enumerate(cli.screen.lines()) if re.match(r'^[ >] /(?:bgcolor|textcolor)\b',line)]
    assert len(option_rows)==2,'Color filter did not render both command options'
    assert option_rows[1]-option_rows[0]>=2 and cli.screen.lines()[option_rows[1]-1]=='','Command options lost their blank separation'
    selected=[line for line in cli.screen.lines() if line.startswith('> /')]
    cli.drain(1.3);assert_search_cursor(cli.screen,'color',DEFAULT_USER)
    cli.keys('\x1b[B');assert_search_cursor(cli.screen,'color',DEFAULT_USER)
    assert selected!=[line for line in cli.screen.lines() if line.startswith('> /')],'Arrow navigation did not change selection'
    cli.keys(PAGE_DOWN);assert_search_cursor(cli.screen,'color',DEFAULT_USER)
    cli.keys(PAGE_UP);assert_search_cursor(cli.screen,'color',DEFAULT_USER)
    cli.capture('picker-filter-after-ticks')
    cli.resize(8,35);assert_search_cursor(cli.screen,'color',DEFAULT_USER)
    assert 'Enlarge terminal' in cli.screen.text(),'Tiny terminal fallback missing'
    cli.capture('picker-narrow')
    cli.resize(44,150);assert_search_cursor(cli.screen,'color',DEFAULT_USER)
    cli.keys('\x1b');assert_live_input(cli.screen,'/color',DEFAULT_USER);cli.keys('\x15')
    results['pickerSpacingNavigationTicksResizeEscape']=True

    cli.command('/textcolor red');cli.keys('LIVE_RED_PROBE')
    assert_live_input(cli.screen,'LIVE_RED_PROBE','#ff0000');cli.drain(1.3)
    assert_live_input(cli.screen,'LIVE_RED_PROBE','#ff0000');cli.capture('live-red-input')
    cli.keys('\x15');cli.keys(TOP)
    assert all(cell[1]=='#ff0000' for cell in cli.screen.cells('COLOR_REPLAY_PROBE')),'Replayed user text differs from live custom red'
    assert all(cell[1]==BODY for cell in cli.screen.cells('BODY_REPLAY_PROBE')),'User setting changed assistant/body foreground'
    cli.keys(BOTTOM);cli.keys('/');cli.keys('color')
    assert_search_cursor(cli.screen,'color','#ff0000');cli.drain(1.3);assert_search_cursor(cli.screen,'color','#ff0000')
    cli.capture('picker-custom-red');cli.keys('\x1b');cli.keys('\x15')
    results['livePromptDraftReplayAndSearchCustomRed']=True

    cli.command('/bgcolor white');cli.command('/textcolor white');cli.screen.assert_regions('#ffffff')
    cli.keys('LOW_CONTRAST_PROBE');assert_live_input(cli.screen,'LOW_CONTRAST_PROBE','#000000','#ffffff')
    cli.capture('white-background-readable-input');cli.keys('\x15');cli.keys(TOP)
    assert all(cell[1]=='#000000' for cell in cli.screen.cells('COLOR_REPLAY_PROBE')),'Replay did not use corrected black on white'
    cli.keys(BOTTOM);cli.command('/bgcolor reset');cli.screen.assert_regions(HEADER)
    assert cli.saved()['bgcolor']==HEADER and cli.saved()['txtcolor']=='#ffffff'
    cli.command('/textcolor reset');assert cli.saved()['txtcolor']==DEFAULT_USER
    assert_live_input(cli.screen,'',DEFAULT_USER)
    cli.command('/bgcolor navy');cli.command('/textcolor yellow');cli.command('/reset colors')
    cli.screen.assert_regions(HEADER);assert_live_input(cli.screen,'',DEFAULT_USER)
    assert cli.saved()['bgcolor']==HEADER and cli.saved()['txtcolor']==DEFAULT_USER
    status=cli.command('/textcolor status')
    assert 'Chat background: '+HEADER in status and 'Your text: '+DEFAULT_USER in status
    assert all(cell[1]==BODY for cell in cli.screen.cells('Chat background:')),'Reset changed normal body text foreground'
    results['whiteContrastAndAllColorResetForms']=True

    counters=local_counters(cli)
    metrics=assert_performance(cli.command('/performance refresh'),counters)
    panel_row,panel_column=cli.screen.find('Performance (This PC)',header=True)
    assert panel_row<cli.screen.top and panel_column>cli.screen.columns//2,'Performance panel is not at the right of the wide dashboard'
    cli.capture('local-performance')
    (OUTPUT/'local-performance-counters.json').write_text(sanitize(json.dumps(counters,indent=2)),encoding='utf-8')
    results['performanceLocalCountersAndRightHeader']={'displayed':metrics,'gpuStatus':counters['gpu']['status'],'vramStatus':counters['vram']['status']}
    assert_idle_antenna(cli.screen,initial_antenna)

    assert 'Notifications: Off' in cli.command('/notify status');assert_idle_antenna(cli.screen,initial_antenna)
    assert 'Notifications: On' in cli.command('/notify on');assert cli.notification_preference()=={'version':1,'enabled':True}
    assert 'Notifications: Off' in cli.command('/notify off');assert cli.notification_preference()=={'version':1,'enabled':False}
    bell_count=cli.raw.count(b'\x07')
    for event in ('approval','error','done','interrupted'):
        assert f'Notification test ({event}): disabled.' in cli.command('/notify test '+event)
    assert cli.raw.count(b'\x07')==bell_count,'Disabled notification test emitted terminal bells'
    assert not list((primary/'state/preferences').glob('notification-sounds-*')),'Disabled notifications created WAV assets'
    assert 'Reset completed: notify.' in cli.command('/reset notify');assert cli.notification_preference()['enabled'] is True
    cli.command('/notify off');assert_idle_antenna(cli.screen,initial_antenna);cli.drain(1.3);assert_idle_antenna(cli.screen,initial_antenna)
    cli.capture('notifications-off-and-antenna-inactive')
    results['notificationOnOffStatusResetPersistenceAndDisabledTests']={'savedEnabled':False,'disabledTestEvents':4,'terminalBells':0,'soundAssets':0}

    check_code="import time; time.sleep(1.3); print('LOCAL_VERIFY_NO_AI_PROBE')"
    check_command='python3 -c '+shlex.quote(check_code)
    marker=cli.send('\x15/verify '+check_command+'\n')
    cli.until(lambda:'Verifying work' in cli.screen.text(),label='actual local verification operation')
    assert_idle_antenna(cli.screen,initial_antenna);cli.capture('local-verify-in-progress-no-ai')
    cli.drain(.4);assert_idle_antenna(cli.screen,initial_antenna);cli.ready(marker)
    verified=plain(bytes(cli.raw[marker:]));assert 'LOCAL_VERIFY_NO_AI_PROBE' in verified and 'Verified' in verified,'Explicit local acceptance check did not run successfully'
    assert_idle_antenna(cli.screen,initial_antenna)
    results['offlineAntennaWaitCommandsAndLocalVerificationStayIdle']={'waveCells':len(initial_antenna),'localCheck':'python3 disposable print after delay','workedSeconds':0}

    attachment=primary/'project/offline attachment.txt';attachment.write_text('PTY_UPLOAD_PROBE\n')
    assert 'Queued 1 file' in cli.command('/upload '+json.dumps(str(attachment))), 'Offline path selection did not queue the text file'
    assert attachment.name in cli.command('/attachments'),'Queued attachment metadata missing'
    cli.command('/attachments clear');assert 'No queued attachments' in cli.command('/attachments')
    assert 'No HTTP MCP servers configured' in cli.command('/mcp list'),'Offline MCP list attempted to require a model'
    assert 'Effort: Provider default' in cli.command('/effort default')
    assert 'No AI selected' in cli.command('/status'),'Offline fixture unexpectedly connected to an AI'
    guidance=cli.command('/help credentials')
    assert '/credentials' in guidance and 'Optional' in guidance,'Optional credential metadata missing from help'
    results['offlineUploadMcpEffortStatusAndCredentialGuidance']=True

    probe='MULTILINE_PASTE_VIEW_PROBE';payload=probe+'\n/quit'
    marker=cli.send('\x1b[200~'+payload+'\x1b[201~');cli.ready(marker)
    assert cli.child.poll() is None,'Pasted /quit was executed instead of queued literally'
    counts={'immediate':assert_literal_paste_view(cli.screen,probe)}
    cli.pending_literal(payload);cli.capture('queued-literal-paste-immediate')
    cli.keys(TOP);assert 'COLOR_REPLAY_PROBE' in cli.screen.text(),'Paste replaced retained conversation history'
    cli.keys(BOTTOM);counts['afterTopBottom']=assert_literal_paste_view(cli.screen,probe)
    cli.resize(10,55);counts['afterNarrowResize']=assert_literal_paste_view(cli.screen,probe)
    cli.resize(44,150);counts['afterWideResize']=assert_literal_paste_view(cli.screen,probe)
    cli.pending_literal(payload);cli.capture('queued-literal-paste-retained')
    results['offlineLiteralPasteImmediateRetainedAndSaved']={'visibleCopies':counts,'pendingInputs':1,'literalSlash':'/quit'}

    assert b'\x1b[?1000h' in cli.raw and b'\x1b[?1006h' in cli.raw,'Mouse reporting was not enabled'
    cli.keys(WHEEL_UP);assert not cli.screen.visible and 'Chat history' in cli.screen.text(),'Mouse wheel did not browse history'
    cli.keys(WHEEL_DOWN);cli.keys(BOTTOM);assert_live_input(cli.screen,'',DEFAULT_USER)
    cli.finish();results['mouseAndTerminalCleanup']=True
    restarted=Terminal(primary);restarted.ready();restarted.keys('RESTORED_DEFAULT_PROBE')
    assert restarted.notification_preference()['enabled'] is False
    assert_live_input(restarted.screen,'RESTORED_DEFAULT_PROBE',DEFAULT_USER);restarted.keys('\x15');restarted.finish()
    results['defaultGreenPersistsAfterRestart']=True

    plain_cli=Terminal(root/'no-color',no_color=True);plain_cli.ready()
    plain_cli.command('/bgcolor white');plain_cli.command('/textcolor red')
    plain_cli.keys('/');assert_search_cursor(plain_cli.screen,'');plain_cli.keys('\x1b');plain_cli.keys('\x15')
    plain_cli.command('/performance status');plain_cli.capture('no-color');plain_cli.finish();assert_no_color(plain_cli.raw)
    dumb=Terminal(root/'dumb',term='dumb');dumb.ready();dumb.command('/performance status');dumb.command('/reset colors');dumb.finish()
    assert_no_color(dumb.raw);assert b'\x1b[?1049h' not in dumb.raw,'TERM=dumb entered the alternate screen'
    results['noColorAndDumbCleanup']=True


def main():
    global args,OUTPUT,root
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--node',default=shutil.which('node'))
    parser.add_argument('--output-directory',type=Path)
    parser.add_argument('--self-test',action='store_true')
    parser.add_argument('--engine',help='Pinned installed native Codex executable; discovered locally if omitted.')
    parser.add_argument('--with-native-ai',action='store_true',help='Also exercise delayed loopback native AI working/freeze/approval/stop, with zero paid calls.')
    args=parser.parse_args()
    if args.self_test:decoder_self_test();return
    if sys.platform!='linux' or os.geteuid()!=0:raise SystemExit('Run this actual Linux PTY acceptance as root (WSL: --user root).')
    if not args.node:raise SystemExit('Node >=22 must be available or supplied with --node.')
    if not args.engine:
        args.engine=subprocess.check_output([args.node,'--input-type=module','-e','import {localCodex} from "./src/local-engine.mjs";process.stdout.write(localCodex());'],cwd=PROJECT,text=True,timeout=15).strip()
    args.engine=args.engine if Path(args.engine).is_absolute() else shutil.which(args.engine)
    if not args.engine or not Path(args.engine).is_file():raise SystemExit('A pinned native Linux runtime is needed for the actual sandboxed local /verify check.')
    OUTPUT=args.output_directory.resolve() if args.output_directory else Path(tempfile.mkdtemp(prefix='sudocli-ui-proof-'))
    OUTPUT.mkdir(parents=True,exist_ok=True)
    temporary=tempfile.TemporaryDirectory(prefix='sudocli-ui-test-');root=Path(temporary.name)
    try:
        run_acceptance()
        if args.with_native_ai:run_native_activity_acceptance()
        proof={'passed':True,'checks':results,'terminalSize':{'columns':150,'rows':44},'modelRequests':len(provider_records),'paidModelRequests':0,
               'limitation':'Actual Linux PTY plus ANSI cell/cursor decoding. Physical blinking and Windows ConsoleHost still need visual acceptance.'}
        (OUTPUT/'result.json').write_text(sanitize(json.dumps(proof,indent=2)),encoding='utf-8')
        print(json.dumps({**proof,'evidence':str(OUTPUT)},indent=2))
    except Exception as error:
        (OUTPUT/'result.json').write_text(sanitize(json.dumps({'passed':False,'checks':results,'modelRequests':len(provider_records),'paidModelRequests':0,'error':str(error)},indent=2)),encoding='utf-8')
        raise
    finally:
        for index,terminal in enumerate(terminals):
            (OUTPUT/f'terminal-{index+1}.log').write_text(sanitize(terminal.raw.decode('utf-8',errors='replace')),encoding='utf-8')
            (OUTPUT/f'screen-{index+1}.txt').write_text(sanitize(terminal.screen.text()),encoding='utf-8')
            terminal.close()
        temporary.cleanup()


if __name__=='__main__':main()
