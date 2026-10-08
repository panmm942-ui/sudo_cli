import test from 'node:test';
import assert from 'node:assert/strict';
import {PassThrough} from 'node:stream';
import {readFile,writeFile,mkdtemp,rm} from 'node:fs/promises';
import {join} from 'node:path';
import {pathToFileURL} from 'node:url';
import {setTimeout as delay} from 'node:timers/promises';
import {tmpdir} from './fixtures/temp-root.mjs';
import {resetStartupGate,setStartupGate,performanceSnapshot} from './fixtures/performance-startup.mjs';

test('actual interactive UI samples local RAM while its first project scan is still pending',{timeout:10000},async t=>{
  const directory=await mkdtemp(join(tmpdir(),'sudo-performance-startup-'));
  t.after(()=>rm(directory,{recursive:true,force:true,maxRetries:5,retryDelay:100}));
  const original=new URL('../src/ui.mjs',import.meta.url),fixture=new URL('./fixtures/performance-startup.mjs',import.meta.url).href;
  const boundaries=new Set(['./privileges.mjs','./system-performance.mjs','./network-status.mjs','./project-changes.mjs','./dashboard.mjs','./notifications.mjs','./github-releases.mjs']);
  const source=(await readFile(original,'utf8')).replace(/from\s+(['"])(\.[^'"]+)\1/g,(_match,_quote,path)=>'from '+JSON.stringify(boundaries.has(path)?fixture:new URL(path,original).href));
  const target=join(directory,'ui.mjs');await writeFile(target,source);
  const module=await import(pathToFileURL(target));
  const input=new PassThrough();input.isTTY=true;input.setRawMode=()=>{};
  const descriptor=Object.getOwnPropertyDescriptor(process,'stdin'),write=process.stdout.write,state=process.env.SUDO_CLI_STATE_DIR;
  const gate=resetStartupGate();setStartupGate(gate);let running;
  try{
    process.env.SUDO_CLI_STATE_DIR=join(directory,'state');Object.defineProperty(process,'stdin',{configurable:true,value:input});process.stdout.write=()=>true;
    running=module.runUI({cwd:directory});running.catch(()=>{});
    await gate.started;
    const first=performanceSnapshot();
    assert.equal(first.ram.status,'available','The dashboard must sample RAM before waiting on the first file scan.');
    assert.equal(first.ram.totalBytes,8*1024**3);
    assert.equal(first.cpu.status,'warming-up');
    await delay(20);
    const later=performanceSnapshot();
    assert.equal(later.cpu.status,'available','CPU sampling must continue independently during startup.');
    assert.equal(later.cpu.percent,50);
  }finally{
    process.emit('SIGTERM');gate.stop();await running?.catch(()=>{});input.destroy();process.stdout.write=write;Object.defineProperty(process,'stdin',descriptor);
    if(state===undefined)delete process.env.SUDO_CLI_STATE_DIR;else process.env.SUDO_CLI_STATE_DIR=state;
  }
});
