import test from 'node:test';
import assert from 'node:assert/strict';
import {verify} from 'node:crypto';
import {spawnSync} from 'node:child_process';
import {mkdtemp,readFile,writeFile,mkdir,rm} from 'node:fs/promises';
import {tmpdir} from './fixtures/temp-root.mjs';
import {join,dirname} from 'node:path';
import {RELEASE_PUBLIC_KEY} from '../src/release-public-key.mjs';
import {isolatedEnvironment} from '../src/permission-scope.mjs';

test('Git checkout with autocrlf enabled preserves signed release bytes and its publisher signature',async t=>{
  const directory=await mkdtemp(join(tmpdir(),'codexcli-checkout-test-'));
  t.after(()=>rm(directory,{recursive:true,force:true}));
  const env=isolatedEnvironment(process.env);
  Object.assign(env,{GIT_CONFIG_NOSYSTEM:'1',GIT_CONFIG_GLOBAL:process.platform==='win32'?'NUL':'/dev/null',GIT_TERMINAL_PROMPT:'0'});
  const run=(...args)=>{
    const result=spawnSync('git',['-c','core.hooksPath='+join(directory,'disabled-hooks'),'-c','commit.gpgsign=false','-c','core.autocrlf=false','-C',directory,...args],{env,encoding:'utf8',windowsHide:true,timeout:15000,maxBuffer:256*1024});
    assert.equal(result.status,0,'Disposable Git checkout failed at '+args[0]);
  };
  run('init','--quiet');
  const names=['release-integrity.json','release-integrity.sig','src/ui.mjs'];
  const expected=new Map();
  for(const name of names){const bytes=await readFile(new URL('../'+name,import.meta.url));expected.set(name,bytes);await mkdir(dirname(join(directory,name)),{recursive:true});await writeFile(join(directory,name),bytes);}
  const attributes=await readFile(new URL('../.gitattributes',import.meta.url)).catch(error=>{if(error.code==='ENOENT')return undefined;throw error;});
  if(attributes)await writeFile(join(directory,'.gitattributes'),attributes);
  run('add','--all');
  for(const name of names)await rm(join(directory,name));
  const checkout=spawnSync('git',['-c','core.hooksPath='+join(directory,'disabled-hooks'),'-c','core.autocrlf=true','-C',directory,'checkout-index','--all','--force'],{env,encoding:'utf8',windowsHide:true,timeout:15000,maxBuffer:256*1024});
  assert.equal(checkout.status,0,'Disposable Git checkout failed');
  for(const [name,bytes]of expected)assert.deepEqual(await readFile(join(directory,name)),bytes,'Autocrlf checkout altered signed bytes: '+name);
  assert.equal(verify(null,await readFile(join(directory,'release-integrity.json')),RELEASE_PUBLIC_KEY,await readFile(join(directory,'release-integrity.sig'))),true,'Publisher signature must remain valid after checkout');
});
