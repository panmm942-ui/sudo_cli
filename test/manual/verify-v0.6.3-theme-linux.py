#!/usr/bin/env python3
"""Real Linux PTY acceptance for saved colors, contrast and resets.

Run as root: python3 -B test/manual/verify-v0.6.3-theme-linux.py --node /usr/bin/node
Only the offline CLI is exercised. HOME/XDG/project/state are temporary. Startup
update offers are declined. No model, package installation or real user settings
are used. A small ECMA-48 decoder verifies rendered cells, including blank rows.
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

parser=argparse.ArgumentParser(description=__doc__)
parser.add_argument('--node',default=shutil.which('node'))
parser.add_argument('--output-directory',type=Path)
args=parser.parse_args()
if sys.platform!='linux' or os.geteuid()!=0:
    raise SystemExit('Run this real Linux PTY acceptance as root (WSL: --user root).')
if not args.node:
    raise SystemExit('Node >=22 must be available on PATH, or pass --node /absolute/node.')
PROJECT=Path(__file__).resolve().parents[2]
OUTPUT=args.output_directory.resolve() if args.output_directory else Path(tempfile.mkdtemp(prefix='sudocli-theme-proof-'))
OUTPUT.mkdir(parents=True,exist_ok=True)
HEADER='#0b0f14'
ANSI=re.compile(r'\x1b(?:\[[0-?]*[ -/]*[@-~]|[@-_])')
CSI=re.compile(r'\x1b\[([0-?]*)([ -/]*)([@-~])')
STANDARD=['#000000','#800000','#008000','#808000','#000080','#800080','#008080','#c0c0c0','#808080','#ff0000','#00ff00','#ffff00','#0000ff','#ff00ff','#00ffff','#ffffff']

def plain(raw):
    value=raw.decode('utf-8',errors='replace')
    value=re.sub(r'\x1b7.*?\x1b8','',value,flags=re.S)
    return ANSI.sub('',value)

class Screen:
    def __init__(self,rows=44,columns=150):
        self.rows,self.columns=rows,columns
        self.row=self.column=0;self.fg=self.bg=None
        self.top,self.bottom=0,rows-1;self.saved=None
        self.grid=[[(' ',None,None) for _ in range(columns)] for _ in range(rows)]
        self.pending='';self.decoder=codecs.getincrementaldecoder('utf-8')('replace')
    def blank(self):return [(' ',self.fg,self.bg) for _ in range(self.columns)]
    def linefeed(self):
        if self.row==self.bottom:
            del self.grid[self.top];self.grid.insert(self.bottom,self.blank())
        else:self.row=min(self.rows-1,self.row+1)
    def sgr(self,numbers):
        index=0
        while index<len(numbers):
            code=numbers[index]
            if code==0:self.fg=self.bg=None
            elif code==39:self.fg=None
            elif code==49:self.bg=None
            elif 30<=code<=37:self.fg=STANDARD[code-30]
            elif 90<=code<=97:self.fg=STANDARD[code-90+8]
            elif 40<=code<=47:self.bg=STANDARD[code-40]
            elif code in (38,48) and index+4<len(numbers) and numbers[index+1]==2:
                value='#'+''.join(f'{n:02x}' for n in numbers[index+2:index+5])
                if code==38:self.fg=value
                else:self.bg=value
                index+=4
            index+=1
    def csi(self,parameters,final):
        if parameters.startswith('?'):return
        numbers=[int(n or 0) for n in parameters.split(';')] if parameters else [0]
        n=numbers[0] or 1
        if final=='m':self.sgr(numbers)
        elif final in ('H','f'):
            self.row=min(self.rows-1,max(0,n-1));self.column=min(self.columns-1,max(0,(numbers[1] if len(numbers)>1 else 1)-1))
        elif final=='G':self.column=min(self.columns-1,n-1)
        elif final=='A':self.row=max(0,self.row-n)
        elif final=='B':self.row=min(self.rows-1,self.row+n)
        elif final=='C':self.column=min(self.columns-1,self.column+n)
        elif final=='D':self.column=max(0,self.column-n)
        elif final=='r':
            self.top=max(0,(numbers[0] or 1)-1)
            self.bottom=min(self.rows-1,(numbers[1] if len(numbers)>1 and numbers[1] else self.rows)-1)
            self.row=self.column=0
        elif final=='J':
            if numbers[0]==2:self.grid=[self.blank() for _ in range(self.rows)]
            elif numbers[0]==0:
                self.grid[self.row][self.column:]=self.blank()[self.column:]
                for row in range(self.row+1,self.rows):self.grid[row]=self.blank()
        elif final=='K':
            if numbers[0]==2:self.grid[self.row]=self.blank()
            elif numbers[0]==0:self.grid[self.row][self.column:]=self.blank()[self.column:]
    def feed(self,data):
        self.pending+=self.decoder.decode(data)
        index=0
        while index<len(self.pending):
            char=self.pending[index]
            if char=='\x1b':
                if index+1>=len(self.pending):break
                match=CSI.match(self.pending,index)
                if match:self.csi(match[1],match[3]);index=match.end();continue
                following=self.pending[index+1]
                if following=='[':break
                if following=='7':self.saved=(self.row,self.column,self.fg,self.bg)
                elif following=='8' and self.saved:self.row,self.column,self.fg,self.bg=self.saved
                index+=2;continue
            if char=='\r':self.column=0
            elif char=='\n':self.linefeed()
            elif char=='\b':self.column=max(0,self.column-1)
            elif char=='\t':self.column=min(self.columns-1,(self.column//8+1)*8)
            elif ord(char)>=32:
                if self.column>=self.columns:self.column=0;self.linefeed()
                self.grid[self.row][self.column]=(char,self.fg,self.bg);self.column+=1
            index+=1
        self.pending=self.pending[index:]
    def text(self):return '\n'.join(''.join(cell[0] for cell in row) for row in self.grid)
    def resize(self,rows,columns):
        self.rows,self.columns=rows,columns;self.row=self.column=0;self.top,self.bottom=0,rows-1
        self.grid=[self.blank() for _ in range(rows)];self.saved=None
    def cells(self,text):
        for row in self.grid:
            offset=''.join(cell[0] for cell in row).find(text)
            if offset>=0:return row[offset:offset+len(text)]
        raise AssertionError(f'Text missing from rendered terminal: {text!r}\n{self.text()}')
    def assert_regions(self,bg):
        assert self.top>1,'A sticky header/scroll region was not established'
        assert all(cell[2]==HEADER for row in self.grid[:self.top] for cell in row),'Custom background leaked into upper dashboard'
        assert all(cell[2]==bg for row in self.grid[self.top:] for cell in row),'Lower blank rows or chat did not receive custom background'
        assert any(cell[1]=='#ef2929' for row in self.grid[:5] for cell in row),'Logo palette changed'
        assert any(cell[1]=='#dce3eb' for row in self.grid[5:self.top] for cell in row),'Antenna tower palette changed'
        waves=[cell[1] for row in self.grid[6:20] for cell in row[:30]
               if cell[0] not in (' ','\u2800') and cell[1] not in (None,'#dce3eb')]
        assert waves,'Antenna waves were removed'
        for value in waves:
            red,green,blue=[int(value[start:start+2],16) for start in (1,3,5)]
            assert 198<=red<=239 and 40<=green<=189 and 40<=blue<=184,'Antenna wave palette changed'

class Terminal:
    def __init__(self,root,*,term='xterm-256color',no_color=False):
        self.raw=bytearray();self.screen=Screen();self.root=root;self.term=term
        for name in ('project','home','tmp','xdg-config','xdg-data','xdg-state'):(root/name).mkdir(parents=True,exist_ok=True,mode=0o700)
        self.master,slave=pty.openpty()
        fcntl.ioctl(self.master,termios.TIOCSWINSZ,struct.pack('HHHH',44,150,0,0))
        env={'PATH':os.environ.get('PATH','/usr/bin:/bin'),'TERM':term,'LANG':'C.UTF-8','HOME':str(root/'home'),'TMPDIR':str(root/'tmp'),
             'XDG_CONFIG_HOME':str(root/'xdg-config'),'XDG_DATA_HOME':str(root/'xdg-data'),'XDG_STATE_HOME':str(root/'xdg-state'),'SUDO_CLI_STATE_DIR':str(root/'state')}
        if no_color:env['NO_COLOR']='1'
        self.child=subprocess.Popen([args.node,str(PROJECT/'bin/sudocli.mjs'),'--cwd',str(root/'project')],cwd=root/'project',env=env,stdin=slave,stdout=slave,stderr=slave,start_new_session=True)
        os.close(slave);terminals.append(self)
    def drain(self,seconds=.15):
        end=time.monotonic()+seconds
        while time.monotonic()<end:
            readable,_,_=select.select([self.master],[],[],min(.04,max(.001,end-time.monotonic())))
            if readable:
                try:data=os.read(self.master,65536)
                except OSError:return
                if not data:return
                self.raw.extend(data);self.screen.feed(data)
    def send(self,text):
        self.drain(.03);marker=len(self.raw);os.write(self.master,text.encode());return marker
    def ready(self,marker=0,timeout=20):
        end=time.monotonic()+timeout;declined=False
        while time.monotonic()<end:
            recent=plain(bytes(self.raw[marker:]))
            if re.search(r'(?:^|\n)  you › $',recent):self.drain(.1);return
            if not declined and re.search(r'(?:update|install).*\[[yYnN/]+\]',recent,re.I):self.send('n\n');declined=True
            if self.child.poll() is not None:break
            self.drain(.1)
        raise AssertionError('CLI prompt not observed: '+plain(bytes(self.raw[-3500:])))
    def command(self,text):
        marker=self.send('\x15'+text+'\n');self.ready(marker)
        result=plain(bytes(self.raw[marker:]))
        assert 'Unknown command' not in result,result
        return result
    def saved(self):
        records=list((self.root/'state').rglob('terminal-theme.json'));assert len(records)==1,records
        return json.loads(records[0].read_text())
    def resize(self,rows,columns):
        self.drain(.04);self.screen.resize(rows,columns)
        fcntl.ioctl(self.master,termios.TIOCSWINSZ,struct.pack('HHHH',rows,columns,0,0))
        self.child.send_signal(signal.SIGWINCH);self.drain(.3)
        assert self.child.poll() is None,'Resize terminated the CLI'
    def finish(self):
        self.send('\x15/quit\n');end=time.monotonic()+8
        while self.child.poll() is None and time.monotonic()<end:self.drain(.1)
        self.child.wait(timeout=3);self.drain(.05)
        assert self.child.returncode==0,self.child.returncode
        if self.term!='dumb':assert b'\x1b[?1049l' in self.raw,'Alternate screen not restored'
    def close(self):
        if self.child.poll() is None:
            self.child.terminate()
            try:self.child.wait(timeout=3)
            except subprocess.TimeoutExpired:self.child.kill();self.child.wait()
        os.close(self.master)

terminals=[];results={}
temporary=tempfile.TemporaryDirectory(prefix='sudocli-theme-test-');root=Path(temporary.name)
try:
    first=Terminal(root);first.ready();first.screen.assert_regions(HEADER)
    first.command('/bgcolor white');first.screen.assert_regions('#ffffff')
    first.command('/txtcolor white');first.screen.assert_regions('#ffffff')
    marker=first.send('LOW_CONTRAST_TYPED');first.drain(.3)
    assert all(cell[1]=='#000000' and cell[2]=='#ffffff' for cell in first.screen.cells('LOW_CONTRAST_TYPED')),'Readline user input became unreadable'
    first.send('\n');first.ready(marker)
    assert first.saved()['bgcolor']=='#ffffff' and first.saved()['txtcolor']=='#ffffff'
    first.command('/txtcolor #800000');first.screen.assert_regions('#ffffff')
    assert all(cell[1]=='#800000' for cell in first.screen.cells('LOW_CONTRAST_TYPED')),'Existing user text did not recolor'
    marker=first.send('/');first.drain(.3)
    assert 'Commands' in first.screen.text(),'Slash menu missing with custom colors'
    first.screen.assert_regions('#ffffff');first.send('\x1b');first.drain(.3)
    first.finish();results['lowerBackgroundPreservesUpperPalette']=True;results['liveUserContrastAndHistoryRecolor']=True;results['slashMenuUsesLowerBackground']=True
    second=Terminal(root);second.ready();second.screen.assert_regions('#ffffff')
    marker=second.send('SAVED_COLOR_TYPED');second.drain(.3)
    assert all(cell[1]=='#800000' for cell in second.screen.cells('SAVED_COLOR_TYPED')),'Text preference lost on restart'
    second.send('\n');second.ready(marker)
    second.resize(8,35)
    assert 'Enlarge terminal' in second.screen.text(),'Tiny terminal did not use its bounded fallback'
    assert all(cell[2]==HEADER for cell in second.screen.grid[0]),'Tiny upper header inherited lower chat background'
    assert all(cell[2]=='#ffffff' for row in second.screen.grid[1:] for cell in row),'Tiny chat did not retain its saved background'
    second.resize(44,150);second.screen.assert_regions('#ffffff');results['tinyResizePreservesSeparateBackgrounds']=True
    second.command('/reset txtcolor');assert second.saved()['txtcolor']=='#dce3eb' and second.saved()['bgcolor']=='#ffffff'
    second.command('/reset bgcolor');second.screen.assert_regions(HEADER)
    second.command('/bgcolor navy');second.command('/txtcolor yellow');second.command('/reset colors');second.screen.assert_regions(HEADER)
    assert second.saved()['bgcolor']==HEADER and second.saved()['txtcolor']=='#dce3eb'
    marker=second.send('/reset\n');end=time.monotonic()+4
    while 'Reset target (number/name; Enter cancels): ' not in plain(bytes(second.raw[marker:])) and time.monotonic()<end:second.drain(.1)
    listing=plain(bytes(second.raw[marker:]));assert 'txtcolor' in listing and 'bgcolor' in listing,'Reset targets are not discoverable'
    assert 'Reset target (number/name; Enter cancels): ' in listing,'Interactive reset selection was not offered'
    second.send('\n');second.ready(marker)
    second.finish();results['savedRestartAndIndependentReset']=True;results['resetColorsAndTargetMenu']=True
    third=Terminal(root,no_color=True);third.ready();third.command('/bgcolor white');third.command('/txtcolor white');third.finish()
    assert not re.search(rb'\x1b\[(?:3[0-9]|4[0-9]|9[0-9]|10[0-7])(?:;[0-9]+)*m',third.raw),'NO_COLOR introduced colors'
    fourth=Terminal(root,term='dumb');fourth.ready();fourth.command('/reset colors');fourth.finish()
    assert not re.search(rb'\x1b\[[0-9;]*m',fourth.raw),'TERM=dumb introduced styling'
    results['noColorAndDumbPreservePlainOutput']=True
    (OUTPUT/'result.json').write_text(json.dumps({'passed':True,'checks':results,'limitation':'PTY plus ANSI cell decoder; Windows ConsoleHost still requires separate visual acceptance.'},indent=2))
    print(json.dumps({'passed':True,'checks':results,'evidence':str(OUTPUT)},indent=2))
except Exception as error:
    (OUTPUT/'result.json').write_text(json.dumps({'passed':False,'checks':results,'error':str(error).replace(str(root),'[isolated-root]')},indent=2))
    raise
finally:
    for index,terminal in enumerate(terminals):
        (OUTPUT/f'terminal-{index+1}.log').write_text(terminal.raw.decode('utf-8',errors='replace').replace(str(root),'[isolated-root]'))
        terminal.close()
    temporary.cleanup()
