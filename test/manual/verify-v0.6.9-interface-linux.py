#!/usr/bin/env python3
"""Integrated terminal/GUI shared-session acceptance, using only loopback AI.

Default: run the signed public bin after sealing. --direct-ui is a development
gate that imports runUI from a private temporary entry; it does not alter or
bypass the public bin's verifier. No real clipboard, GPU command or audio player
is invoked by this harness. Existing monitor observations are availability-only.
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
import signal
import socketserver
import struct
import subprocess
import tempfile
import termios
import threading
import time
import urllib.error
import urllib.parse
import urllib.request
from terminal_view import TerminalView, rendered_text, verify_ready_prompt_regression

PROJECT=Path(__file__).resolve().parents[2]
parser=argparse.ArgumentParser();parser.add_argument('--node',default='node');parser.add_argument('--engine',type=Path)
parser.add_argument('--output-directory',type=Path);parser.add_argument('--direct-ui',action='store_true');args=parser.parse_args()
KEY='v069-loopback-synthetic-key';requests=[];errors=[];terminals=[];holds={};results={}
OUTPUT=args.output_directory.resolve() if args.output_directory else Path(tempfile.mkdtemp(prefix='sudo-interface-proof-'))
OUTPUT.mkdir(parents=True,exist_ok=True)

class Server(socketserver.ThreadingMixIn,http.server.HTTPServer):
    daemon_threads=True
class Provider(http.server.BaseHTTPRequestHandler):
    def log_message(self,*_):pass
    def do_POST(self):
        try:
            assert self.path=='/v1/chat/completions'
            assert self.headers.get('authorization')=='Bearer '+KEY
            body=json.loads(self.rfile.read(int(self.headers['content-length'])))
            requests.append(body);index=len(requests)
            user=next(str(item.get('content','')) for item in reversed(body['messages']) if item.get('role')=='user')
            for marker,event in list(holds.items()):
                if user.splitlines()[-1]==marker:assert event.wait(12),'Controlled fixture was not released'
            self.send_response(200);self.send_header('content-type','text/event-stream');self.end_headers()
            def chunk(delta,finish=None,usage=None):
                value={'id':'interface-'+str(index),'object':'chat.completion.chunk','created':1,'model':body['model'],
                       'choices':[] if usage else [{'index':0,'delta':delta,'finish_reason':finish}]}
                if usage:value['usage']=usage
                self.wfile.write(('data: '+json.dumps(value)+'\n\n').encode());self.wfile.flush()
            chunk({'role':'assistant'});chunk({'content':f'V069 ANSWER {index}. Synthetic credential {KEY}.'});chunk({},'stop')
            chunk({},usage={'prompt_tokens':120,'completion_tokens':20,'total_tokens':140})
            self.wfile.write(b'data: [DONE]\n\n');self.wfile.flush()
        except (BrokenPipeError,ConnectionResetError):pass
        except BaseException as error:errors.append(type(error).__name__)

server=Server(('127.0.0.1',0),Provider);threading.Thread(target=server.serve_forever,daemon=True).start()
BASE=f'http://127.0.0.1:{server.server_port}/v1'

class Terminal:
    def __init__(self,root):
        self.root=root;self.raw=bytearray();self.view=TerminalView();self.expected={};self.tokens=[]
        self.forced_cleanup=False
        for name in ['project','home','tmp','xdg-config','xdg-data','xdg-state','state/preferences']:(root/name).mkdir(parents=True,exist_ok=True,mode=0o700)
        preferences=root/'state/preferences'
        for name,value in [('github-updates.json',{'version':1,'repository':'panmm942-ui/sudo_cli','enabled':False}),('notifications.json',{'version':1,'enabled':False})]:
            path=preferences/name;path.write_text(json.dumps(value));path.chmod(0o600)
        self.spawns=root/'native-spawns.jsonl';self.spawns.write_text('')
        self.questions=root/'questions.jsonl';self.questions.write_text('')
        self.lines=root/'input-lines.jsonl';self.lines.write_text('')
        observer=root/'observer.mjs'
        observer.write_text('import cp from "node:child_process";import readline from "node:readline/promises";import{stripVTControlCharacters}from"node:util";import{syncBuiltinESMExports}from"node:module";import{appendFileSync}from"node:fs";const original=cp.spawn,originalExecFile=cp.execFile;cp.execFile=function(command,...args){if(/(?:^|[\\\\/])(?:paplay|aplay|afplay)(?:\\.exe)?$/.test(String(command)))throw new Error("Synthetic audio fixture: unavailable");return originalExecFile.call(this,command,...args);};cp.spawn=function(command,args,options){if(/(?:^|[\\\\/])(?:nvidia-smi|ioreg|paplay|aplay|afplay)(?:\\.exe)?$/.test(String(command)))throw new Error("Synthetic device fixture: unavailable");const child=original(command,args,options);if(args?.includes("app-server")&&/codex(?:\\.exe)?$/.test(String(command)))appendFileSync('+json.dumps(str(self.spawns))+',JSON.stringify({spawned:!!child.pid})+"\\n");return child;};let serial=0,active=0;const create=readline.createInterface;readline.createInterface=function(...args){const value=create(...args),question=value.question;value.on("line",()=>appendFileSync('+json.dumps(str(self.lines))+',JSON.stringify({beforeFirstQuestion:serial===0,withoutQuestion:active===0})+"\\n"));value.question=function(prompt,...options){const id=++serial;active=id;const submission=/\\d{2}:\\d{2} \\d+@you > /.test(stripVTControlCharacters(String(prompt)));const record=phase=>appendFileSync('+json.dumps(str(self.questions))+',JSON.stringify({id,submission,phase})+"\\n");record("waiting");return question.call(value,prompt,...options).then(answer=>{if(active===id)active=0;record("done");return answer;},error=>{if(active===id)active=0;record("done");throw error;});};return value;};syncBuiltinESMExports();\n')
        self.master,slave=pty.openpty();fcntl.ioctl(self.master,termios.TIOCSWINSZ,struct.pack('HHHH',44,150,0,0))
        env={'PATH':'/usr/bin:/bin','TERM':'xterm-256color','LANG':'C.UTF-8','HOME':str(root/'home'),'TMPDIR':str(root/'tmp'),
             'XDG_CONFIG_HOME':str(root/'xdg-config'),'XDG_DATA_HOME':str(root/'xdg-data'),'XDG_STATE_HOME':str(root/'xdg-state'),
             'SUDO_CLI_STATE_DIR':str(root/'state'),'NODE_OPTIONS':'--import '+str(observer)}
        if args.engine:env['SUDO_CLI_CODEX']=str(args.engine.resolve())
        entry=PROJECT/'bin/sudocli.mjs'
        if args.direct_ui:
            entry=root/'development-entry.mjs';entry.write_text('import{runUI}from'+json.dumps((PROJECT/'src/ui.mjs').as_uri())+';await runUI({cwd:process.cwd()});\n')
        self.child=subprocess.Popen([args.node,str(entry),'--cwd',str(root/'project')],cwd=root/'project',env=env,stdin=slave,stdout=slave,stderr=slave,start_new_session=True)
        os.close(slave);terminals.append(self)
    def drain(self,seconds=.08):
        end=time.monotonic()+seconds
        while time.monotonic()<end:
            readable,_,_=select.select([self.master],[],[],min(.025,max(.001,end-time.monotonic())))
            if readable:
                try:data=os.read(self.master,65536)
                except OSError:return
                if not data:return
                self.raw.extend(data);self.view.feed(data)
    def wait(self,predicate,label,timeout=40):
        end=time.monotonic()+timeout
        while time.monotonic()<end:
            self.drain(.04)
            if predicate():return
            assert self.child.poll() is None,'CLI exited before '+label
        text=self.view.text().replace(str(self.root),'[isolated-root]').replace(KEY,'[redacted]')
        for token in self.tokens:text=text.replace(token,'[redacted]')
        (OUTPUT/'failure-screen.txt').write_text(text)
        raise AssertionError('Bounded expectation missing: '+label)
    def send(self,text):
        self.drain(.025);marker=len(self.raw);prior=self.view.composer()
        self.expected[marker]=prior['sequence'] if prior and prior['empty'] and text.endswith(('\n','\r')) else None
        data=text.encode();offset=0;end=time.monotonic()+10
        flags=fcntl.fcntl(self.master,fcntl.F_GETFL);fcntl.fcntl(self.master,fcntl.F_SETFL,flags|os.O_NONBLOCK)
        try:
            while offset<len(data):
                assert time.monotonic()<end,'Bounded input write failed'
                readable,writable,_=select.select([self.master],[self.master],[],.025)
                if readable:self.drain(.01)
                if writable:
                    try:offset+=os.write(self.master,data[offset:offset+2048])
                    except BlockingIOError:pass
        finally:fcntl.fcntl(self.master,fcntl.F_SETFL,flags)
        return marker
    def current_question(self):
        rows=[json.loads(row) for row in self.questions.read_text().splitlines()]
        if not rows:return None
        latest=max(row['id'] for row in rows);return [row for row in rows if row['id']==latest][-1]
    def ready(self,marker=0):self.wait(lambda:len(self.raw)>marker and self.view.ready(self.expected.get(marker)) and self.current_question() and self.current_question()['submission'] and self.current_question()['phase']=='waiting','empty active editable composer')
    def command(self,text):
        marker=self.send('\x15'+text+'\n');self.ready(marker);return rendered_text(bytes(self.raw[marker:]))
    def question(self,label):self.wait(lambda:label in self.view.text(),'current question '+label)
    def connect(self,already_submitted=False):
        if not already_submitted:self.send('/connect\n')
        for label,value in [('AI setup','1'),('Model ID','fixture-interface')]:self.question(label);self.send(value+'\n')
        self.question('API base URL');before=len(requests)
        self.send('\x1b[200~'+BASE[:-3]+'\x1b[201~');self.drain(.15)
        assert 'API base URL' in self.view.text() and BASE[:-3] in self.view.text() and len(requests)==before
        self.send('/v1\n')
        for label,value in [('API format','1'),('Model context capacity','131072'),('API key',KEY)]:self.question(label);last=self.send(value+'\n')
        self.ready(last);assert len(requests)==0 and KEY.encode() not in self.raw
    def task(self,text):
        before=len(requests);marker=self.send(text+'\n')
        self.wait(lambda:len(requests)==before+1,'one native request')
        self.wait(lambda:f'V069 ANSWER {before+1}.' in rendered_text(bytes(self.raw[marker:])),'native answer')
        self.ready(marker);assert len(requests)==before+1
    def spawn_count(self):return len(self.spawns.read_text().splitlines())
    def gui(self):
        self.send('/gui\n')
        self.wait(lambda:re.search(rb'http://127\.0\.0\.1:\d+/#token=[a-f0-9]{64}',self.raw) is not None,'local GUI address')
        match=list(re.finditer(rb'http://127\.0\.0\.1:\d+/#token=[a-f0-9]{64}',self.raw))[-1]
        url=match[0].decode();parsed=urllib.parse.urlsplit(url);token=urllib.parse.parse_qs(parsed.fragment)['token'][0]
        self.tokens.append(token);return Gui(parsed.scheme+'://'+parsed.netloc,token,self)
    def saved(self):
        records=list((self.root/'state/chats').glob('chat-*.json'));return [json.loads(path.read_text()) for path in records]
    def finish(self):
        self.send('\x15/quit\n');end=time.monotonic()+10
        while self.child.poll() is None and time.monotonic()<end:self.drain(.08)
        self.child.wait(timeout=3);self.drain(.05);assert self.child.returncode==0
        assert b'\x1b[?1049l' in self.raw and KEY.encode() not in self.raw
    def close(self):
        if self.child.poll() is None:
            self.forced_cleanup=True
            os.killpg(self.child.pid,signal.SIGTERM)
            try:self.child.wait(timeout=3)
            except subprocess.TimeoutExpired:os.killpg(self.child.pid,signal.SIGKILL);self.child.wait(timeout=3)
        os.close(self.master)

class Gui:
    def __init__(self,origin,token,terminal):self.origin,self.token,self.terminal=origin,token,terminal
    def request(self,path='/api/state',action=None,expected=200):
        # Return redraws the actual terminal before completing its HTTP reply.
        # Drain that PTY concurrently; a synchronous client can block both ends.
        values=[];failures=[];done=threading.Event()
        def fetch():
            try:values.append(self.fetch(path,action,expected))
            except BaseException as error:failures.append(error)
            finally:done.set()
        threading.Thread(target=fetch,daemon=True).start();deadline=time.monotonic()+5
        while not done.is_set() and time.monotonic()<deadline:self.terminal.drain(.01)
        assert done.is_set(),'Bounded GUI response observation failed'
        if failures:raise failures[0]
        return values[0]
    def fetch(self,path,action,expected):
        headers={'Authorization':'Bearer '+self.token,'Origin':self.origin}
        data=None
        if action is not None:data=json.dumps(action).encode();headers['Content-Type']='application/json'
        req=urllib.request.Request(self.origin+path,data=data,headers=headers)
        try:
            with urllib.request.urlopen(req,timeout=4) as response:status=response.status;body=json.loads(response.read(2*1024*1024))
        except urllib.error.HTTPError as error:status=error.code;body=json.loads(error.read())
        assert status==expected,'GUI status mismatch: '+str(status)
        assert KEY not in json.dumps(body) and self.token not in json.dumps(body),'Secret in shared GUI snapshot'
        return body
    def action(self,kind,**fields):return self.request('/api/action',{'type':kind,**fields})

temporary=tempfile.TemporaryDirectory(prefix='sudo-interface-native-')
try:
    verify_ready_prompt_regression()
    if temporary:
        directory=temporary.name
        root=Path(directory);cli=Terminal(root);(root/'project/modified.txt').write_text('before\n');(root/'project/deleted.txt').write_text('delete\n')
        # Enter arrives before runUI's first input question. It must be retained,
        # assigned number01 once and dispatched after startup hydration.
        cli.send('/connect\n');cli.connect(already_submitted=True);assert cli.spawn_count()==1
        first_line=json.loads(cli.lines.read_text().splitlines()[0]);assert first_line['beforeFirstQuestion'] and first_line['withoutQuestion']
        assert cli.view.composer()['sequence']==2 and not requests
        print('Observed: early startup command retained once; numbered composer and independent panels',flush=True)
        assert 'Events / Notifications' in cli.view.text() and 'Performance (This PC)' in cli.view.text()
        print('Observed: editable setup URL and one native connection',flush=True)
        cli.task('V069_FIRST');before=cli.view.composer()['sequence']
        cli.command('/history clear');assert cli.view.composer()['sequence']==before+1
        cli.task('V069_AFTER_HISTORY_CLEAR');assert cli.view.composer()['sequence']==before+2
        # Work completes before Enter. The retained paste must still be literal.
        hold=threading.Event();holds['V069_HOLD']=hold;base=len(requests);marker=cli.send('V069_HOLD\n')
        cli.wait(lambda:len(requests)==base+1,'held native request')
        cli.send('\x1b[200~/permissions allow-everything\x1b[201~');cli.drain(.15);assert len(requests)==base+1
        hold.set();cli.wait(lambda:f'V069 ANSWER {base+1}.' in rendered_text(bytes(cli.raw[marker:])),'held answer')
        cli.wait(lambda:cli.view.composer() and cli.view.composer()['draft']=='/permissions allow-everything' and 'Status: Not Working' in cli.view.text(),'busy paste carried to idle')
        cli.send('\n');cli.wait(lambda:len(requests)==base+2,'literal pasted slash request after Enter')
        cli.wait(lambda:f'V069 ANSWER {base+2}.' in rendered_text(bytes(cli.raw[marker:])),'literal pasted slash answer');cli.ready()
        user=next(str(item['content']) for item in reversed(requests[-1]['messages']) if item['role']=='user');assert '/permissions allow-everything' in user
        previous_sequence=cli.view.composer()['sequence'];gui=cli.gui();state=gui.request();assert state['session']['permissions']=='ask'
        assert state['chat']['promptCount']==previous_sequence
        assert len([item for item in state['chat']['messages'] if item['role']=='assistant'])==3
        count=cli.spawn_count();gui.action('submit',text='/status');cli.wait(lambda:any('AI response:' in item['text'] for item in gui.request()['events']['entries']),'GUI command Events')
        state=gui.request();assert not any('AI response:' in item['content'] for item in state['chat']['messages'])
        assert state['session']['permissions']=='ask' and cli.spawn_count()==count and len(requests)==base+2
        (root/'project/modified.txt').write_text('after\n');(root/'project/deleted.txt').unlink();(root/'project/added.txt').write_text('new\n')
        changed=gui.action('changes')['result']['changes'];by_path={item['path']:item['status'] for item in changed['files']}
        assert by_path=={'modified.txt':'modified','deleted.txt':'deleted','added.txt':'added'} and not changed['partial']
        diff=gui.action('changes',path='modified.txt')['result']['diff'];assert '-before' in diff and '+after' in diff
        assert '/gui' in [item['name'] for item in state['commands']] and '/performance' not in [item['name'] for item in state['commands']]
        gui.action('submit',text='/textcolor red');cli.wait(lambda:gui.request()['theme']['txtcolor']=='#ff0000','shared GUI user color')
        gui.action('submit',text='/reset textcolor');cli.wait(lambda:gui.request()['theme']['txtcolor']=='#00ff00','canonical user color reset')
        assert gui.request()['theme']['effectiveTxtcolor']=='#00ff00' and cli.spawn_count()==count
        preference=root/'state/preferences/notifications.json'
        gui.action('submit',text='/notify on');cli.wait(lambda:json.loads(preference.read_text())['enabled'] is True,'notification preference on')
        gui.action('submit',text='/notify off');cli.wait(lambda:json.loads(preference.read_text())['enabled'] is False,'notification preference off')
        assert len(requests)==base+2
        # Question answers are identity-scoped, consume no prompt number, and
        # survive return to the terminal without another engine connection.
        gui.action('submit',text='/switch save');cli.wait(lambda:gui.request()['currentPrompt'] is not None,'GUI current question')
        state=gui.request();question=state['currentPrompt'];accepted=state['chat']['promptCount']
        gui.request('/api/action',{'type':'answer','promptId':'stale-fixture-id','text':'no'},expected=409)
        gui.action('answer',promptId=question['id'],text='GUI profile')
        gui.request('/api/action',{'type':'answer','promptId':question['id'],'text':'duplicate'},expected=409)
        cli.wait(lambda:gui.request()['currentPrompt'] is None,'answered GUI question')
        assert gui.request()['chat']['promptCount']==accepted and cli.spawn_count()==count
        print('Observed: literal paste, numbered history clear, shared GUI engine/Events/changes and once-only question IDs',flush=True)
        hold=threading.Event();holds['V069_GUI_STOP']=hold;before=len(requests)
        gui.action('submit',text='V069_GUI_STOP');cli.wait(lambda:len(requests)==before+1,'GUI submitted native task')
        stop_prior_ids={item['id'] for item in gui.request()['events']['entries']}
        accepted=gui.request()['chat']['promptCount'];gui.action('stop')
        cli.wait(lambda:not gui.request()['session']['working'],'GUI native stop')
        hold.set();cli.wait(lambda:any(item['id'] not in stop_prior_ids and item['text']=='AI work stopped.' for item in gui.request()['events']['entries']),'current GUI stopped event')
        state=gui.request();assert state['chat']['promptCount']==accepted and state['session']['permissions']=='ask'
        assert cli.spawn_count()==count and len(requests)==before+1
        assert any('AI work stopped.' in item['text'] for item in state['events']['entries'])
        assert '/24.7' in [item['name'] for item in state['commands']]
        chat_id=cli.saved()[0]['id']
        for choice,marker in [('n','V0611_GUI_CLEAR_KEEP'),('y','V0611_GUI_CLEAR_FORGET')]:
            before=len(requests);old_spawns=cli.spawn_count()
            gui.action('submit',text='/clear')
            cli.wait(lambda:gui.request()['currentPrompt'] is not None,'GUI clear question')
            question=gui.request()['currentPrompt'];accepted=gui.request()['chat']['promptCount']
            assert 'Also forget previous messages?' in question['prompt']
            gui.action('answer',promptId=question['id'],text=choice)
            cli.wait(lambda:gui.request()['currentPrompt'] is None and not gui.request()['chat']['messages'] and cli.saved()[0]['history']['messages']==[], 'GUI cleared visible history')
            assert cli.saved()[0]['id']==chat_id and gui.request()['chat']['promptCount']==accepted
            if choice=='y':
                cli.wait(lambda:cli.spawn_count()==old_spawns+1,'fresh native context after GUI Yes')
                assert 'contextHistory' not in cli.saved()[0]
            else:
                assert cli.spawn_count()==old_spawns and cli.saved()[0]['contextHistory']['messages']
            gui.action('submit',text=marker)
            cli.wait(lambda:len(requests)==before+1 and not gui.request()['session']['working'] and any(item['role']=='assistant' for item in gui.request()['chat']['messages']), 'native task after GUI clear')
            request=json.dumps(requests[-1]['messages'])
            assert ('V069_AFTER_HISTORY_CLEAR' in request)==(choice=='n')
            assert cli.saved()[0]['id']==chat_id
        count=cli.spawn_count()
        print('Observed: GUI /clear Yes/No, same chat identity, numbered questions, native context retention/reset and /24.7 menu',flush=True)
        gui.action('submit',text='/switch save');cli.wait(lambda:gui.request()['currentPrompt'] is not None,'question before return')
        accepted=gui.request()['chat']['promptCount'];gui.action('return');cli.question('Save current AI as')
        last=cli.send('Terminal profile\n');cli.ready(last);assert cli.view.composer()['sequence']==accepted+1 and cli.spawn_count()==count
        try:gui.request();raise AssertionError('Returned GUI server remained reachable')
        except (urllib.error.URLError,ConnectionError,TimeoutError):pass
        # Pending submissions keep the originally accepted number/literal bit,
        # even with a later immediate administrative command in between.
        hold=threading.Event();holds['V069_QUEUE_HOLD']=hold;base=len(requests);cli.send('V069_QUEUE_HOLD\n');cli.wait(lambda:len(requests)==base+1,'pending held request')
        cli.send('V069_QUEUED\n');cli.send('/notify off\n')
        cli.wait(lambda:any(record.get('pendingInputs')==['V069_QUEUED'] and record.get('pendingSubmissions') and record['pendingSubmissions'][0]['sequence']<record['history']['promptCount'] for record in cli.saved()),'saved pending input and later command number')
        saved=next(record for record in cli.saved() if record.get('pendingInputs')==['V069_QUEUED'])
        meta=saved['pendingSubmissions'][0];assert meta['sequence']<saved['history']['promptCount'] and meta['literal'] is False
        hold.set();cli.wait(lambda:len(requests)==base+2,'queued native request');cli.wait(lambda:f'V069 ANSWER {base+2}.' in rendered_text(bytes(cli.raw)),'queued native answer');cli.ready()
        saved=cli.saved()[0];queued=[item for item in saved['history']['messages'] if item.get('content')=='V069_QUEUED']
        cli.wait(lambda:any(item.get('content')=='V069_QUEUED' and item.get('sequence')==meta['sequence'] for record in cli.saved() for item in record['history']['messages']),'saved original queued number')
        final_sequence=cli.view.composer()['sequence'];cli.finish()
        resumed=Terminal(root);resumed.ready();assert resumed.view.composer()['sequence']==final_sequence+1
        marker=resumed.send('/new\n');resumed.question('Keep the current saved chat');last=resumed.send('y\n');resumed.ready(last)
        assert resumed.view.composer()['sequence']==1;resumed.finish()
        assert not errors
        results={'passed':True,'entry':'private direct runUI' if args.direct_ui else 'signed bin','nativeRequests':len(requests),'paidRequests':0,
                 'cliExitCodes':[item.child.returncode for item in terminals],'physicalClipboardReads':0,'physicalAudioPlayback':False,
                 'checks':['early-startup-enter-retained-once','editable-connection-url','history-clear-numbering','busy-to-idle-literal-paste-ask','gui-shared-engine','events-chat-isolation',
                           'shared-user-color-and-canonical-reset','notification-preferences-without-playback','current-question-id-once','gui-native-stop-same-engine','gui-clear-yes-no-same-chat-native-context','gui-canonical-24.7-menu','return-with-current-question','current-project-add-modify-delete-diff','saved-pending-submission-metadata','resume-numbering','new-chat-first-number']}
except BaseException as error:
    results={'passed':False,'errorType':type(error).__name__,'message':str(error),'nativeRequests':len(requests),'paidRequests':0}
    raise
finally:
    for event in holds.values():event.set()
    for terminal in terminals:
        for token in terminal.tokens:results['message']=results.get('message','').replace(token,'[redacted]')
        try:terminal.close()
        except BaseException:results['cleanupFailed']=True
    results['forcedCleanup']=any(terminal.forced_cleanup for terminal in terminals)
    server.shutdown();server.server_close()
    try:temporary.cleanup()
    except BaseException:results['cleanupFailed']=True
    if results.get('cleanupFailed') or results['forcedCleanup']:results['passed']=False
    results['message']=results.get('message','').replace(KEY,'[redacted]')
    (OUTPUT/'receipt.json').write_text(json.dumps(results,indent=2)+'\n')
    print(json.dumps(results))
    if results.get('cleanupFailed') or results['forcedCleanup']:raise SystemExit(1)
