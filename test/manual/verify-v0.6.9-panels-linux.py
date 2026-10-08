#!/usr/bin/env python3
"""Real PTY acceptance of the terminal modules plus native Node Readline.

This does not invoke the CLI or native AI. The final integrated CLI acceptance
is a separate release gate. Clipboard requests return synthetic fixture text;
no physical clipboard, sound, GPU probe or paid provider is used.
"""
import argparse
import ast
import codecs
import fcntl
import json
import os
from pathlib import Path
import pty
import re
import select
import signal
import struct
import subprocess
import tempfile
import termios
import time

PROJECT=Path(__file__).resolve().parents[2]
parser=argparse.ArgumentParser();parser.add_argument('--output',type=Path);args=parser.parse_args()
# Extract only the existing decoder class/constants, never execute another
# manual's launch/setup/main code.
source=ast.parse((PROJECT/'test/manual/verify-v0.6.7-ui-linux.py').read_text())
needed=[]
for item in source.body:
    if isinstance(item,ast.ClassDef) and item.name=='Screen':needed.append(item)
    if isinstance(item,ast.Assign) and any(isinstance(target,ast.Name) and target.id in {'CSI','STANDARD','HEADER','BODY'} for target in item.targets):needed.append(item)
exec(compile(ast.Module(body=needed,type_ignores=[]),'<existing-screen-decoder>','exec'))

with tempfile.TemporaryDirectory(prefix='sudo-panels-pty-') as directory:
    state_path=Path(directory)/'state.json';master,slave=pty.openpty();screen=Screen(44,150);raw=bytearray()
    def dimensions(rows,columns):fcntl.ioctl(master,termios.TIOCSWINSZ,struct.pack('HHHH',rows,columns,0,0))
    dimensions(44,150)
    env={name:os.environ[name] for name in ['PATH','HOME','LANG','LC_ALL'] if name in os.environ};env['TERM']='xterm-256color';env['SUDO_CLI_UPDATES']='off'
    child=subprocess.Popen(['node',str(PROJECT/'test/fixtures/terminal-panels.mjs'),'--terminal-fixture',str(state_path)],stdin=slave,stdout=slave,stderr=subprocess.PIPE,env=env,cwd=PROJECT,start_new_session=True);os.close(slave)
    def drain(seconds=.08):
        end=time.monotonic()+seconds
        while time.monotonic()<end:
            ready,_,_=select.select([master],[],[],min(.02,max(0,end-time.monotonic())))
            if ready:
                try:chunk=os.read(master,65536)
                except OSError:return
                if not chunk:return
                raw.extend(chunk);screen.feed(chunk)
    def state():
        try:return json.loads(state_path.read_text())
        except (FileNotFoundError,json.JSONDecodeError):return None
    def wait(predicate,label):
        end=time.monotonic()+5
        while time.monotonic()<end:
            drain(.04);value=state()
            if value and predicate(value) and screen.balanced():return value
            assert child.poll() is None,'PTY fixture exited before '+label
        raise AssertionError('Bounded PTY readiness failed: '+label)
    def send(text):
        data=text.encode();offset=0;end=time.monotonic()+5
        while offset<len(data):
            assert time.monotonic()<end,'PTY input deadline';ready,write,_=select.select([master],[master],[],.05)
            if ready:drain(.01)
            if write:offset+=os.write(master,data[offset:offset+1024])
        drain()
    try:
        first=wait(lambda value:value['caret'] is not None,'editable composer')
        divider=first['layout']['divider']['left']-1
        assert all(row[divider][0]=='│' for row in screen.grid),'Right divider is not continuous'
        assert 'Credits:' in screen.lines()[0] and 'v0.' in screen.lines()[-1],'Credits/footer placement'
        url='https://example.com/a/b?q=one%20two&next=%2Fdocs#λ'
        send('\x1b[200~'+url+'\x1b[201~');value=wait(lambda value:value['input']['text']==url,'literal editable URL')
        assert value['submissions']==[],'Paste submitted before Enter'
        send('\x01EDIT ');value=wait(lambda value:value['input']['text']=='EDIT '+url,'editing pasted URL')
        screen.resize(24,70);dimensions(24,70);os.kill(child.pid,signal.SIGWINCH)
        value=wait(lambda value:value['layout']['compact'] and value['input']['text']=='EDIT '+url,'compact resize retained draft')
        assert screen.visible and (screen.row+1,screen.column+1)==(value['caret']['row'],value['caret']['column']),'Resize lost caret'
        send('\r');value=wait(lambda value:len(value['submissions'])==1,'one intentional URL submission')
        assert value['submissions']==['EDIT '+url]
        screen.resize(44,150);dimensions(44,150);os.kill(child.pid,signal.SIGWINCH);wait(lambda value:not value['layout']['compact'],'wide layout')
        send('\x1b[H\t\x1b[5~');value=wait(lambda value:value['chat']['top']==0 and value['events']['isScrolled'],'independent keyboard scrolling')
        assert value['events']['top']>0,'Events PageUp was confused with chat Home'
        column=value['events']['scrollbar']['column'];top=value['events']['scrollbar']['top'];bottom=value['events']['scrollbar']['bottom']
        send(f'\x1b[<0;{column};{top}M');value=wait(lambda value:value['events']['top']==0,'event scrollbar click');assert value['chat']['top']==0
        send(f'\x1b[<32;{column};{bottom}M\x1b[<0;{column};{bottom}m');wait(lambda value:not value['events']['isScrolled'],'event scrollbar drag')
        before=len(raw);drain(1.2);assert b'\x1b[?25l' not in raw[before:] and b'\x1b[?25h' not in raw[before:],'Header tick toggled cursor'
        send('\x16');value=wait(lambda value:value['input']['text']=='https://example.com/ctrl-v?value=λ','explicit synthetic Ctrl+V')
        assert len(value['submissions'])==1
        send('\r');wait(lambda value:len(value['submissions'])==2,'intentional Ctrl+V submission');send('/quit\r');child.wait(timeout=5);drain(.1);assert child.returncode==0,'Module fixture failure'
        report={'passed':True,'actualPTY':True,'nativeReadline':True,'integratedCLI':False,'paidRequests':0,'physicalClipboardReads':0,'forcedCleanup':False,'checks':['exact-editable-url','resize-caret','independent-scrollbars','keyboard-focus','mouse-click-drag','stable-cursor-visibility','alternate-screen-restored']}
        assert b'\x1b[?1049l' in raw and b'\x1b[?1002l' in raw
        if args.output:args.output.parent.mkdir(parents=True,exist_ok=True);args.output.write_text(json.dumps(report,indent=2)+'\n')
        print(json.dumps(report))
    finally:
        try:
            if child.poll() is None:
                os.killpg(child.pid,signal.SIGTERM)
                try:child.wait(timeout=1)
                except subprocess.TimeoutExpired:os.killpg(child.pid,signal.SIGKILL);child.wait(timeout=1)
        finally:os.close(master);child.stderr.close()
