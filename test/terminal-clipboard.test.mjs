import test from 'node:test';
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {once} from 'node:events';
import {ownProcess} from '../src/owned-process.mjs';
import {readTerminalClipboard} from '../src/terminal-clipboard.mjs';

function synthetic(t,wire,{silent=false}={}){
  let child,invocation;
  const spawnProcess=(command,args,options)=>{
    invocation={command,args,options};const script=`process.stdin.resume();setInterval(()=>{},1000);${silent?'':`process.stdout.write(${JSON.stringify(wire)});`}`;
    child=spawn(process.execPath,['-e',script],{...options,detached:process.platform!=='win32'});
    t.after(async()=>{if(child.exitCode!==null||child.signalCode!==null)return;const exit=once(child,'exit');let timer;const bounded=Promise.race([exit,new Promise((_resolve,reject)=>{timer=setTimeout(()=>reject(new Error('Synthetic clipboard fixture did not stop.')),1000);})]);void bounded.catch(()=>{});try{child.kill('SIGKILL');await bounded;}finally{clearTimeout(timer);}});return child;
  };
  return {spawnProcess,get child(){return child;},get invocation(){return invocation;}};
}
async function stopped(child){if(child.exitCode!==null||child.signalCode!==null)return;await once(child,'exit');}
test('fixed Windows clipboard command preserves synthetic multiline UTF-8 and verifies its owned helper exit',{timeout:25000},async t=>{
  const read=readTerminalClipboard,text='https://example.com/path?q=a&b=λ\n/quit',f=synthetic(t,Buffer.from(text).toString('base64')+'\n');
  assert.equal(await read({platform:'win32',env:{SystemRoot:'C:\\Windows',PATH:process.env.PATH,PRIVATE_TOKEN_CANARY:'never-child'},spawnProcess:f.spawnProcess,timeoutMs:5000}),text);
  await stopped(f.child);assert.ok(f.child.exitCode!==null||f.child.signalCode!==null);
  assert.equal(f.invocation.options.shell,false);assert.equal(f.invocation.options.windowsHide,true);assert.equal(f.invocation.options.env.PRIVATE_TOKEN_CANARY,undefined);
  assert.match(f.invocation.command,/System32\\WindowsPowerShell\\v1\.0\\powershell\.exe$/i);
  const script=Buffer.from(f.invocation.args.at(-1),'base64').toString('utf16le');assert.match(script,/Get-Clipboard -Raw/);assert.match(script,/PSModulePath=\$PSHOME/);assert.doesNotMatch(script,/example\.com|PRIVATE_TOKEN_CANARY/);
});
test('clipboard timeout with no output rejects without leaking helper stderr and reaps the exact child',{timeout:25000},async t=>{
  const read=readTerminalClipboard,f=synthetic(t,'',{silent:true});
  await assert.rejects(read({platform:'win32',spawnProcess:f.spawnProcess,timeoutMs:250}),/Clipboard/);await stopped(f.child);
  assert.ok(f.child.exitCode!==null||f.child.signalCode!==null);
});
test('oversized clipboard and unsupported hosts do not return partial clipboard text',{timeout:25000},async t=>{
  const read=readTerminalClipboard,f=synthetic(t,Buffer.from('too many bytes').toString('base64')+'\n');
  await assert.rejects(read({platform:'win32',spawnProcess:f.spawnProcess,maxBytes:4,timeoutMs:5000}),/Clipboard/);await stopped(f.child);
  let spawned=false;await assert.rejects(read({platform:'linux',spawnProcess:()=>{spawned=true;}}),/terminal paste/i);assert.equal(spawned,false);
});
test('cleanup failure withholds clipboard text and retains a safe typed attention error',{timeout:25000},async t=>{
  const f=synthetic(t,Buffer.from('PRIVATE_CLIPBOARD_CANARY').toString('base64')+'\n');
  await assert.rejects(readTerminalClipboard({platform:'win32',spawnProcess:f.spawnProcess,timeoutMs:5000,ownerFactory:child=>{const owner=ownProcess(child);return {capture:deadline=>owner.capture(deadline),close:async()=>{await owner.close();throw new Error('PRIVATE_CLEANUP_CANARY');}};}}),error=>error.code==='SESSION_CLEANUP_FAILED'&&!/PRIVATE/.test(error.message));
  await stopped(f.child);
});
test('an already canceled clipboard request cannot spawn an OS helper',async()=>{
  const controller=new AbortController();controller.abort();let spawned=false;
  await assert.rejects(readTerminalClipboard({platform:'win32',signal:controller.signal,spawnProcess:()=>{spawned=true;}}),{name:'AbortError'});assert.equal(spawned,false);
});
