import test from 'node:test';
import assert from 'node:assert/strict';
import {EventEmitter} from 'node:events';

test('GUI launcher passes only a fixed opener and literal local URL argv without a shell',async()=>{
  const {openGui}=await import('../src/gui-launcher.mjs');
  for(const [platform,expected] of [['win32','C:\\Windows\\System32\\rundll32.exe'],['darwin','/usr/bin/open'],['linux','/usr/bin/xdg-open']]){
    let invocation;const result=await openGui('http://127.0.0.1:43123/#token='+'a'.repeat(64),{platform,geteuid:()=>1000,env:{SYSTEMROOT:'C:\\Windows'},spawn:(file,args,options)=>{invocation={file,args,options};const child=new EventEmitter();queueMicrotask(()=>child.emit('exit',0));return child;}});
    assert.equal(result.opened,true);assert.equal(invocation.file,expected);assert.equal(invocation.args.at(-1),result.url);assert.equal(invocation.options.shell,false);assert.equal(invocation.options.stdio,'ignore');assert.equal(invocation.options.windowsHide,true);
    if(platform==='win32')assert.equal(invocation.args[0],'C:\\Windows\\System32\\url.dll,FileProtocolHandler');
  }
});

test('GUI launcher refuses remote URLs and offers normal-user fallback for Unix root and unavailable browsers',async()=>{
  const {openGui}=await import('../src/gui-launcher.mjs');let launches=0;
  await assert.rejects(openGui('https://evil.example/'),/local/i);
  const root=await openGui('http://127.0.0.1:43123/#token='+'b'.repeat(64),{platform:'linux',geteuid:()=>0,spawn:()=>{launches++;}});assert.equal(root.opened,false);assert.equal(launches,0);assert.match(root.reason,/normal.*browser/i);
  const missing=await openGui(root.url,{platform:'win32',spawn:()=>{const child=new EventEmitter();queueMicrotask(()=>child.emit('error',new Error('private-host-path')));return child;}});assert.equal(missing.opened,false);assert.doesNotMatch(JSON.stringify(missing),/private-host-path/);
});

test('GUI launcher preserves only desktop routing alongside the isolated OS environment',async()=>{
  const {openGui}=await import('../src/gui-launcher.mjs');let environment;
  await openGui('http://127.0.0.1:43123/#token='+'c'.repeat(64),{platform:'linux',geteuid:()=>1000,env:{PATH:'/usr/bin',DISPLAY:':1',WAYLAND_DISPLAY:'wayland-0',DBUS_SESSION_BUS_ADDRESS:'unix:path=/run/user/1000/bus',OPENAI_API_KEY:'credential-canary',CODEX_HOME:'private-state'},spawn:(_file,_args,options)=>{environment=options.env;const child=new EventEmitter();queueMicrotask(()=>child.emit('exit',0));return child;}});
  assert.deepEqual(environment,{PATH:'/usr/bin',DISPLAY:':1',WAYLAND_DISPLAY:'wayland-0',DBUS_SESSION_BUS_ADDRESS:'unix:path=/run/user/1000/bus'});
});
