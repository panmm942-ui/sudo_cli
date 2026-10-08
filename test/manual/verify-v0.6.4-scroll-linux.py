#!/usr/bin/env python3
"""Real PTY acceptance for saved chat scrolling, Readline, and paused streams.

Run as root on Linux/WSL with Node >=22. The actual offline CLI receives a
>65536-character saved transcript fixture in private HOME/XDG/state/project
directories. No model, package installation, or real user settings are used.
A second actual PTY exercises the production dashboard and scroll input while
new output arrives. ANSI cell decoding is evidence of layout, not a Windows
ConsoleHost visual acceptance.
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

parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument('--node', default=shutil.which('node'))
parser.add_argument('--output-directory', type=Path)
args = parser.parse_args()
if sys.platform != 'linux' or os.geteuid() != 0:
    raise SystemExit('Run this real Linux PTY acceptance as root (WSL: --user root).')
if not args.node:
    raise SystemExit('Node >=22 must be available or supplied with --node.')
PROJECT = Path(__file__).resolve().parents[2]
OUTPUT = args.output_directory.resolve() if args.output_directory else Path(tempfile.mkdtemp(prefix='sudocli-scroll-proof-'))
OUTPUT.mkdir(parents=True, exist_ok=True)
CSI = re.compile(r'\x1b\[([0-?]*)([ -/]*)([@-~])')
ANSI = re.compile(r'\x1b(?:\[[0-?]*[ -/]*[@-~]|[@-_])')
HEADER = '#0b0f14'
STANDARD = ['#000000','#800000','#008000','#808000','#000080','#800080','#008080','#c0c0c0','#808080','#ff0000','#00ff00','#ffff00','#0000ff','#ff00ff','#00ffff','#ffffff']
PAGE_UP, PAGE_DOWN = '\x1b[5~', '\x1b[6~'
TOP, BOTTOM = '\x1b[1;5H', '\x1b[1;5F'
WHEEL_UP, WHEEL_DOWN = '\x1b[<64;10;30M', '\x1b[<65;10;30M'
terminals, results = [], {}

def plain(raw):
    text = raw.decode('utf-8', errors='replace')
    text = re.sub(r'\x1b7.*?\x1b8', '', text, flags=re.S)
    return ANSI.sub('', text)

class Screen:
    def __init__(self, rows=44, columns=150):
        self.rows, self.columns = rows, columns
        self.row = self.column = 0
        self.fg = self.bg = None
        self.top, self.bottom = 0, rows-1
        self.saved, self.visible = None, True
        self.grid = [self.blank() for _ in range(rows)]
        self.pending = ''
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
                if following == '7': self.saved = (self.row,self.column,self.fg,self.bg)
                elif following == '8' and self.saved: self.row,self.column,self.fg,self.bg = self.saved
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
    def text(self):
        return '\n'.join(''.join(cell[0] for cell in row) for row in self.grid)
    def lines(self):
        return [''.join(cell[0] for cell in row).rstrip() for row in self.grid]
    def cells(self, text):
        for row in self.grid:
            offset = ''.join(cell[0] for cell in row).find(text)
            if offset >= 0: return row[offset:offset+len(text)]
        raise AssertionError(f'Missing rendered text {text!r}:\n{self.text()}')
    def resize(self, rows, columns):
        self.rows,self.columns=rows,columns;self.row=self.column=0
        self.top,self.bottom=0,rows-1;self.saved=None
        self.grid=[self.blank() for _ in range(rows)]
    def assert_colors(self, bg):
        assert self.top > 1, 'Sticky header region missing'
        assert all(cell[2] == HEADER for row in self.grid[:self.top] for cell in row), 'Chat background leaked into dashboard'
        assert all(cell[2] == bg for row in self.grid[self.top:] for cell in row), 'Chat and empty rows lost their background'
        assert any(cell[1] == '#ef2929' for row in self.grid[:5] for cell in row), 'Original logo color changed'
        assert any(cell[1] == '#dce3eb' for row in self.grid[5:self.top] for cell in row), 'Original antenna tower color changed'

class Terminal:
    def __init__(self, root, *, harness=None, term='xterm-256color', no_color=False):
        self.root,self.term,self.harness=root,term,harness
        self.raw=bytearray();self.screen=Screen()
        for name in ('project','home','tmp','xdg-config','xdg-data','xdg-state'):
            (root/name).mkdir(parents=True,exist_ok=True,mode=0o700)
        self.master,slave=pty.openpty()
        fcntl.ioctl(self.master,termios.TIOCSWINSZ,struct.pack('HHHH',44,150,0,0))
        env={'PATH':os.environ.get('PATH','/usr/bin:/bin'),'TERM':term,'LANG':'C.UTF-8','HOME':str(root/'home'),
             'TMPDIR':str(root/'tmp'),'XDG_CONFIG_HOME':str(root/'xdg-config'),'XDG_DATA_HOME':str(root/'xdg-data'),
             'XDG_STATE_HOME':str(root/'xdg-state'),'SUDO_CLI_STATE_DIR':str(root/'state')}
        if no_color: env['NO_COLOR']='1'
        command=[args.node,str(harness)] if harness else [args.node,str(PROJECT/'bin/sudocli.mjs'),'--cwd',str(root/'project')]
        self.child=subprocess.Popen(command,cwd=root/'project',env=env,stdin=slave,stdout=slave,stderr=slave,start_new_session=True)
        os.close(slave);terminals.append(self)
    def drain(self, seconds=.2):
        end=time.monotonic()+seconds
        while time.monotonic()<end:
            readable,_,_=select.select([self.master],[],[],min(.04,max(.001,end-time.monotonic())))
            if readable:
                try: data=os.read(self.master,65536)
                except OSError: return
                if not data: return
                self.raw.extend(data);self.screen.feed(data)
    def send(self, text):
        self.drain(.03);marker=len(self.raw);os.write(self.master,text.encode());return marker
    def ready(self, marker=0, timeout=15):
        end=time.monotonic()+timeout
        while time.monotonic()<end:
            if re.search(r'(?:^|\n)  you › $',plain(bytes(self.raw[marker:]))): self.drain(.1);return
            if self.child.poll() is not None: break
            self.drain(.1)
        raise AssertionError('CLI input prompt missing: '+plain(bytes(self.raw[-3000:])))
    def command(self, text, *, paused=False):
        marker=self.send('\x15'+text+'\n')
        if paused:
            # Browsing intentionally hides the live prompt. Wait for the
            # history cells and hidden cursor instead of a prompt byte string.
            end=time.monotonic()+10
            while time.monotonic()<end:
                self.drain(.1)
                if 'Chat history' in self.screen.text() and not self.screen.visible: break
                if self.child.poll() is not None: break
            assert 'Chat history' in self.screen.text() and not self.screen.visible, 'Command did not enter the paused viewport'
        else:
            self.ready(marker)
        assert 'Unknown command' not in plain(bytes(self.raw[marker:])), text
    def keys(self, text):
        marker=self.send(text);self.drain(.2);return bytes(self.raw[marker:])
    def resize(self, rows, columns):
        self.drain(.03);self.screen.resize(rows,columns)
        fcntl.ioctl(self.master,termios.TIOCSWINSZ,struct.pack('HHHH',rows,columns,0,0))
        self.child.send_signal(signal.SIGWINCH);self.drain(.3)
        assert self.child.poll() is None,'Resize terminated the CLI'
    def finish(self):
        self.send('q' if self.harness else '\x15/quit\n')
        end=time.monotonic()+8
        while self.child.poll() is None and time.monotonic()<end:self.drain(.1)
        self.child.wait(timeout=3);self.drain(.05)
        assert self.child.returncode==0,self.child.returncode
        if self.term!='dumb':
            assert b'\x1b[?1049l' in self.raw,'Alternate screen not restored'
            assert b'\x1b[?1000l' in self.raw and b'\x1b[?1006l' in self.raw,'Mouse reporting not disabled'
    def close(self):
        if self.child.poll() is None:
            self.child.terminate()
            try:self.child.wait(timeout=3)
            except subprocess.TimeoutExpired:self.child.kill();self.child.wait()
        os.close(self.master)

def seed(root):
    (root/'project').mkdir(parents=True,exist_ok=True,mode=0o700)
    preferences=root/'state/preferences';preferences.mkdir(parents=True,exist_ok=True,mode=0o700)
    updates=preferences/'github-updates.json'
    updates.write_text(json.dumps({'version':1,'repository':'panmm942-ui/sudo_cli','enabled':False}));updates.chmod(0o600)
    script=r'''
      import {createChatStore} from './src/chat-store.mjs';
      import {join} from 'node:path';
      const root=process.argv[1];
      const content=Array.from({length:1200},(_,i)=>`SAVED-LINE-${String(i).padStart(4,'0')} ${'x'.repeat(80)}`).join('\n')+'\nLAST_SAVED_ANSWER';
      const history={version:1,messages:[{id:'first-user',role:'user',model:null,content:'FIRST_SAVED_USER'},
        {id:'first-answer',role:'assistant',model:null,content,status:'completed'}]};
      const store=await createChatStore({cwd:join(root,'project'),stateDir:join(root,'state')});
      const record=await store.create({title:'Scroll proof',history});
      console.log(JSON.stringify({id:record.id,characters:content.length}));
    '''
    record=json.loads(subprocess.check_output([args.node,'--input-type=module','-e',script,str(root)],cwd=PROJECT,text=True))
    assert record['characters']>65536
    return record

temporary=tempfile.TemporaryDirectory(prefix='sudocli-scroll-test-');root=Path(temporary.name)
try:
    saved=seed(root/'cli')
    cli=Terminal(root/'cli');cli.ready()
    assert 'LAST_SAVED_ANSWER' in cli.screen.text(),'Saved chat tail was not hydrated at startup'
    cli.screen.assert_colors(HEADER)
    marker=cli.keys(TOP)
    assert 'FIRST_SAVED_USER' in cli.screen.text(),'First saved message lost beyond the former 65536-character cutoff'
    assert 'Chat history' in cli.screen.text() and not cli.screen.visible,'History indicator/cursor state missing'
    assert b'\x1b[2J' not in marker,'Scroll cleared the dashboard'
    before=cli.screen.text();cli.keys(PAGE_DOWN);assert before!=cli.screen.text(),'PageDown did not navigate'
    cli.keys(PAGE_UP);assert 'FIRST_SAVED_USER' in cli.screen.text(),'PageUp did not return to earliest page'
    before=cli.screen.text();cli.keys(WHEEL_DOWN);assert before!=cli.screen.text(),'Wheel down did not navigate'
    cli.keys(WHEEL_UP);assert 'FIRST_SAVED_USER' in cli.screen.text(),'Wheel up did not return to earliest row'
    cli.keys('\x1b[1;2B');assert 'FIRST_SAVED_USER' in cli.screen.text(),'Shift+Down skipped more than one row'
    cli.keys('\x1b[1;2A');cli.keys(BOTTOM)
    assert 'LAST_SAVED_ANSWER' in cli.screen.text() and cli.screen.visible,'Ctrl+End did not restore live output/cursor'
    results['completeSavedHistoryAndPageWheelKeys']=True

    cli.keys('UNFINISHED_DRAFT');cli.keys(PAGE_UP)
    assert 'UNFINISHED_DRAFT' not in cli.screen.text(),'Draft input overlays the paused transcript'
    cli.keys(BOTTOM);assert 'UNFINISHED_DRAFT' in cli.screen.text(),'Returning live lost unfinished Readline input'
    cli.keys(PAGE_UP);cli.keys('X')
    assert 'UNFINISHED_DRAFTX' in cli.screen.text(),'Typing did not restore and extend the same draft'
    cli.keys('\x15')
    cli.keys('/');assert 'Commands' in cli.screen.text(),'Slash picker did not open'
    cli.keys(PAGE_DOWN);assert 'Commands' in cli.screen.text() and 'Chat history' not in cli.screen.text(),'Chat scrolling stole picker PageDown'
    cli.keys('\x1b');cli.keys('\x15')
    results['readlineDraftAndSlashPickerPriority']=True

    cli.command('/bgcolor white');cli.command('/txtcolor maroon');cli.keys(TOP)
    cli.screen.assert_colors('#ffffff')
    assert all(cell[1]=='#800000' for cell in cli.screen.cells('FIRST_SAVED_USER')),'Replayed user color lost'
    cli.resize(8,35)
    assert 'Enlarge terminal' in cli.screen.text() and 'FIRST_SAVED_USER' in cli.screen.text(),'Tiny resize lost paused anchor'
    assert all(cell[2]==HEADER for cell in cli.screen.grid[0]),'Tiny header inherited lower color'
    cli.resize(44,150);assert 'FIRST_SAVED_USER' in cli.screen.text(),'Enlarging lost paused text anchor'
    cli.screen.assert_colors('#ffffff');cli.keys(BOTTOM)
    cli.command('/scroll top',paused=True);assert 'FIRST_SAVED_USER' in cli.screen.text(),'/scroll top did not navigate'
    cli.command('/scroll bottom');assert 'LAST_SAVED_ANSWER' in cli.screen.text(),'/scroll bottom did not restore live'
    results['resizeThemeAndScrollCommands']=True

    marker=cli.send('\x15/new\n');end=time.monotonic()+10
    while 'Keep the current saved chat? [Y/n]' not in cli.screen.text() and time.monotonic()<end:
        cli.drain(.1)
    assert 'Keep the current saved chat? [Y/n]' in cli.screen.text(), 'New chat did not offer to retain the saved fixture'
    cli.send('y\n');cli.ready(marker);cli.keys(TOP)
    assert 'FIRST_SAVED_USER' not in cli.screen.text() and 'LAST_SAVED_ANSWER' not in cli.screen.text(),'New chat retained previous viewport text'
    cli.command('/chat open '+saved['id']);cli.keys(TOP)
    assert 'FIRST_SAVED_USER' in cli.screen.text(),'Opening saved chat failed to replace full visible history'
    cli.keys(BOTTOM);cli.finish()
    restart=Terminal(root/'cli');restart.ready();restart.keys(TOP)
    assert 'FIRST_SAVED_USER' in restart.screen.text(),'Restart did not rehydrate saved history'
    restart.keys(BOTTOM);restart.finish()
    results['newChatOpenAndRestart']=True

    harness=root/'stream-harness.mjs'
    harness.write_text('''
      import {createDashboard} from '''+json.dumps((PROJECT/'src/dashboard.mjs').as_uri())+''';
      import {createChatScrollInput} from '''+json.dumps((PROJECT/'src/chat-scroll-input.mjs').as_uri())+''';
      const dashboard=createDashboard({snapshot:()=>({cwd:process.cwd(),working:true}),tickMs:25});
      dashboard.start();dashboard.replaceBody([{text:'STREAM_ANCHOR\\n'+('retained line\\n').repeat(100),user:false}]);
      process.stdout.write('\\x1b[?1000h\\x1b[?1006h');process.stdin.setRawMode(true);
      const input=createChatScrollInput({input:process.stdin,getContext:()=>({enabled:true,paused:dashboard.isScrolled()}),
        onLive:()=>dashboard.scrollToBottom(),onScroll:name=>{
          if(name==='top')dashboard.scrollToTop();else if(name==='bottom')dashboard.scrollToBottom();
          else if(name==='page-up')dashboard.pageUp();else if(name==='page-down')dashboard.pageDown();
          else dashboard.scroll(name==='wheel-up'?-3:name==='wheel-down'?3:name==='line-up'?-1:1);
        }});
      process.on('SIGUSR1',()=>dashboard.write('ARRIVED_WHILE_PAUSED\\n'));
      input.on('data',data=>{if(data.toString().includes('q')){input.detach();process.stdin.setRawMode(false);
        process.stdout.write('\\x1b[?1000l\\x1b[?1006l');dashboard.stop();process.exit(0);}});
    ''')
    stream=Terminal(root/'stream',harness=harness);stream.drain(.4);stream.keys(TOP)
    assert 'STREAM_ANCHOR' in stream.screen.text()
    before=stream.screen.lines()[stream.screen.top+1:]
    stream.child.send_signal(signal.SIGUSR1);stream.drain(.3)
    assert 'New output' in stream.screen.text(),'Paused output indicator missing'
    assert 'ARRIVED_WHILE_PAUSED' not in stream.screen.text(),'New output overwrote older view'
    assert stream.screen.lines()[stream.screen.top+1:]==before,'Visible old rows moved during stream'
    assert not stream.screen.visible,'Header refresh revealed cursor while paused'
    stream.keys(BOTTOM);assert 'ARRIVED_WHILE_PAUSED' in stream.screen.text(),'Unseen output missing after returning live'
    stream.finish();results['realPtyPausedStreamAndHeaderRefresh']=True

    plain_cli=Terminal(root/'cli',no_color=True);plain_cli.ready();plain_cli.keys(TOP)
    assert 'FIRST_SAVED_USER' in plain_cli.screen.text(),'NO_COLOR disabled chat navigation'
    plain_cli.keys(BOTTOM);plain_cli.finish()
    assert not re.search(rb'\x1b\[(?:3[0-9]|4[0-9]|9[0-9]|10[0-7])(?:;[0-9]+)*m',plain_cli.raw),'NO_COLOR emitted colors'
    results['noColorNavigationAndTerminalCleanup']=True
    proof={'passed':True,'checks':results,'savedFixtureCharacters':saved['characters'],
           'limitation':'Real Linux PTY and ANSI cells; Windows ConsoleHost still needs visual acceptance.'}
    (OUTPUT/'result.json').write_text(json.dumps(proof,indent=2))
    print(json.dumps({**proof,'evidence':str(OUTPUT)},indent=2))
except Exception as error:
    (OUTPUT/'result.json').write_text(json.dumps({'passed':False,'checks':results,'error':str(error).replace(str(root),'[isolated-root]')},indent=2))
    raise
finally:
    for index,terminal in enumerate(terminals):
        (OUTPUT/f'terminal-{index+1}.log').write_text(terminal.raw.decode('utf-8',errors='replace').replace(str(root),'[isolated-root]'))
        (OUTPUT/f'screen-{index+1}.txt').write_text(terminal.screen.text().replace(str(root),'[isolated-root]'))
        terminal.close()
    temporary.cleanup()
