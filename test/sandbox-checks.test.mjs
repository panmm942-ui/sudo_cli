import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile,readFile,lstat,rm} from 'node:fs/promises';
import {join,resolve,relative,isAbsolute} from 'node:path';
import {tmpdir} from 'node:os';
import {createWorkspaceTools} from '../src/workspace-tools.mjs';
import * as module from '../src/sandbox-checks.mjs';

async function fixture(t){
  const root=await mkdtemp(join(tmpdir(),'sudocli-sandbox-check-'));
  const cwd=join(root,'project');await mkdir(cwd);
  const workspace=await createWorkspaceTools({cwd,stateDir:join(root,'state')});
  t.after(async()=>{const target=resolve(root),rel=relative(resolve(tmpdir()),target);assert.ok(rel&&!rel.startsWith('..')&&!isAbsolute(rel));await rm(target,{recursive:true,force:true});});
  return {root,cwd,workspace};
}

test('command wrapper replaces the executed command and child environment instead of running the selected host command',async t=>{
  const {workspace}=await fixture(t);
  const result=await workspace.runChecks([{command:process.execPath,args:['-e','process.exit(91)']}],{
    commandWrapper:async()=>({command:process.execPath,args:['-e','console.log(process.env.SUDO_WRAPPER_FIXTURE||"absent")'],env:{SUDO_WRAPPER_FIXTURE:'wrapped'}}),
  });
  assert.equal(result[0].status,'passed');assert.equal(result[0].stdout.trim(),'wrapped');
});

test('unrestricted checks still remove unrelated credentials and clean the private runtime home after exit',async t=>{
  assert.equal(typeof module.acceptSandboxedWork,'function');
  const {root,cwd,workspace}=await fixture(t),outside=join(root,'explicit-unrestricted.txt');
  const prior=process.env.SUDO_CHECK_SYNTHETIC_SECRET;process.env.SUDO_CHECK_SYNTHETIC_SECRET='synthetic-never-forward';
  t.after(()=>{if(prior===undefined)delete process.env.SUDO_CHECK_SYNTHETIC_SECRET;else process.env.SUDO_CHECK_SYNTHETIC_SECRET=prior;});
  const script='const fs=require("node:fs");fs.writeFileSync(process.argv[1],"selected unrestricted check");console.log(JSON.stringify({secretPresent:!!process.env.SUDO_CHECK_SYNTHETIC_SECRET,home:process.env.CODEX_HOME}));';
  const result=await module.acceptSandboxedWork({workspace,settings:{permissions:'allow-everything',scope:'full',webAccess:true},checks:[{command:process.execPath,args:['-e',script,outside]}]});
  assert.equal(result.checks[0].status,'passed');assert.equal(await readFile(outside,'utf8'),'selected unrestricted check');
  const output=JSON.parse(result.checks[0].stdout);assert.equal(output.secretPresent,false);assert.ok(isAbsolute(output.home));assert.notEqual(output.home,cwd);await assert.rejects(lstat(output.home),{code:'ENOENT'});
});

test('invalid permission policy refuses a check before any host side effect',async t=>{
  assert.equal(typeof module.acceptSandboxedWork,'function');
  const {root,workspace}=await fixture(t),target=join(root,'should-not-exist');
  await assert.rejects(module.acceptSandboxedWork({workspace,settings:{permissions:'invalid',webAccess:false},checks:[{command:process.execPath,args:['-e','require("node:fs").writeFileSync(process.argv[1],"unsafe")',target]}]}),/permission/i);
  await assert.rejects(lstat(target),{code:'ENOENT'});
});

test('native Linux project checks block host credentials network and outside writes while permitting project writes',{skip:process.platform!=='linux',timeout:20000},async t=>{
  assert.equal(typeof module.acceptSandboxedWork,'function');
  const {root,cwd,workspace}=await fixture(t),outside=join(root,'outside.txt');
  await writeFile(join(cwd,'source.txt'),'source');
  const prior=process.env.SUDO_CHECK_SYNTHETIC_SECRET;process.env.SUDO_CHECK_SYNTHETIC_SECRET='synthetic-never-forward';
  t.after(()=>{if(prior===undefined)delete process.env.SUDO_CHECK_SYNTHETIC_SECRET;else process.env.SUDO_CHECK_SYNTHETIC_SECRET=prior;});
  const script=`const fs=require('node:fs'),net=require('node:net');
    const result={secretPresent:!!process.env.SUDO_CHECK_SYNTHETIC_SECRET,outsideWrite:false,network:false,networkError:null};
    try{fs.writeFileSync(process.argv[1],'escaped');result.outsideWrite=true;}catch{}
    fs.writeFileSync('inside.txt','permitted');
    const socket=net.connect({host:'1.1.1.1',port:443});
    let finished=false;function finish(connected){if(finished)return;finished=true;result.network=connected;socket.destroy();console.log(JSON.stringify(result));}
    socket.once('connect',()=>finish(true));socket.once('error',error=>{result.networkError=error.code;finish(false)});socket.setTimeout(1500,()=>finish(false));`;
  const result=await module.acceptSandboxedWork({workspace,settings:{permissions:'allow-everything',scope:'full',webAccess:false},checks:[{command:process.execPath,args:['-e',script,outside]}],timeoutMs:10000});
  assert.equal(result.checks[0].status,'passed',result.checks[0].stderr);
  assert.ok(result.checks[0].stdout.trim(),JSON.stringify(result.checks[0]));
  const observed=JSON.parse(result.checks[0].stdout);assert.deepEqual({...observed,networkError:null},{secretPresent:false,outsideWrite:false,network:false,networkError:null});assert.ok(['EPERM','EACCES','ENETUNREACH'].includes(observed.networkError),`Expected a native network denial, got ${observed.networkError}`);
  await assert.rejects(lstat(outside),{code:'ENOENT'});assert.equal(await readFile(join(cwd,'inside.txt'),'utf8'),'permitted');assert.equal(result.status,'Needs review');
});

test('native read-only checks refuse project writes instead of falling back to host execution',{skip:process.platform!=='linux',timeout:20000},async t=>{
  assert.equal(typeof module.acceptSandboxedWork,'function');
  const {cwd,workspace}=await fixture(t);
  const result=await module.acceptSandboxedWork({workspace,settings:{scope:'read-only',webAccess:true},checks:[{command:process.execPath,args:['-e','require("node:fs").writeFileSync("forbidden.txt","escaped")']}],timeoutMs:10000});
  assert.equal(result.status,'Failed');assert.notEqual(result.checks[0].status,'passed');await assert.rejects(lstat(join(cwd,'forbidden.txt')),{code:'ENOENT'});
});

test('native checks honor explicitly granted write roots while denying neighboring folders',{skip:process.platform!=='linux',timeout:20000},async t=>{
  const {root,workspace}=await fixture(t),granted=join(root,'granted'),denied=join(root,'denied.txt');await mkdir(granted);
  const script='const fs=require("node:fs");fs.writeFileSync(process.argv[1],"granted");try{fs.writeFileSync(process.argv[2],"escaped");process.exit(9)}catch{console.log("neighbor denied")}';
  const result=await module.acceptSandboxedWork({workspace,settings:{scope:'project',writableRoots:[granted],webAccess:false},checks:[{command:process.execPath,args:['-e',script,join(granted,'allowed.txt'),denied]}],timeoutMs:10000});
  assert.equal(result.checks[0].status,'passed',result.checks[0].stderr);assert.match(result.checks[0].stdout,/neighbor denied/);assert.equal(await readFile(join(granted,'allowed.txt'),'utf8'),'granted');await assert.rejects(lstat(denied),{code:'ENOENT'});
});

test('native captured output and duration remain bounded through the sandbox bridge',{skip:process.platform!=='linux',timeout:20000},async t=>{
  const {workspace}=await fixture(t);
  const limited=await module.acceptSandboxedWork({workspace,settings:{scope:'project'},checks:[{command:process.execPath,args:['-e','process.stdout.write("x".repeat(20000));setInterval(()=>{},1000)']}],maxOutputBytes:1024,timeoutMs:5000});
  assert.equal(limited.checks[0].status,'output-limit',JSON.stringify(limited.checks[0]));assert.ok(Buffer.byteLength(limited.checks[0].stdout)+Buffer.byteLength(limited.checks[0].stderr)<=1024);assert.equal(limited.verified,false);
  const timed=await module.acceptSandboxedWork({workspace,settings:{scope:'project'},checks:[{command:process.execPath,args:['-e','console.log("started");setInterval(()=>{},1000)']}],timeoutMs:2500});
  assert.equal(timed.checks[0].status,'timed-out',JSON.stringify(timed.checks[0]));assert.match(timed.checks[0].stdout,/started/);assert.equal(timed.verified,false);
});

test('Windows native enforcement either blocks an outside write or refuses the entire check',{skip:process.platform!=='win32',timeout:20000},async t=>{
  assert.equal(typeof module.acceptSandboxedWork,'function');
  const {root,workspace}=await fixture(t),outside=join(root,'outside-windows.txt');
  const result=await module.acceptSandboxedWork({workspace,settings:{scope:'project',webAccess:false},checks:[{command:process.execPath,args:['-e','const fs=require("node:fs");try{fs.writeFileSync(process.argv[1],"escaped");console.log("outside-permitted");process.exit(9)}catch{console.log("outside-denied")}',outside]}],timeoutMs:10000});
  await assert.rejects(lstat(outside),{code:'ENOENT'});
  if(result.checks[0].status==='passed')assert.match(result.checks[0].stdout,/outside-denied/);
  else assert.equal(result.status,'Failed');
});
