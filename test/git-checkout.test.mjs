import test from 'node:test';
import assert from 'node:assert/strict';
import {verify} from 'node:crypto';
import {spawnSync} from 'node:child_process';
import {mkdtemp,readFile,writeFile,mkdir,rm} from 'node:fs/promises';
import {tmpdir} from './fixtures/temp-root.mjs';
import {join,dirname} from 'node:path';
import {RELEASE_PUBLIC_KEY} from '../src/release-public-key.mjs';
import {isolatedEnvironment} from '../src/permission-scope.mjs';

function gitFailure(result,stage,directory){
  const cause=String(result.stderr||result.error?.code||result.signal||'No child diagnostic was returned.')
    .replaceAll(directory,'[fixture]')
    .replace(/[A-Z]:[\\/]+Users[\\/]+[^\\/\s]+/gi,'[user-home]')
    .replace(/\/(?:home|Users)\/[^/\s]+/g,'[user-home]')
    .replace(/gh[pousr]_[A-Za-z0-9]+|github_pat_[A-Za-z0-9_]+|sk-(?:proj-)?[A-Za-z0-9_-]{24,}/g,'[redacted-token]')
    .replace(/Bearer\s+\S+/gi,'Bearer [redacted]')
    .replace(/https?:\/\/[^\s/"'<>:]+:[^\s/"'<>@]+@/g,'https://[redacted]@')
    .replace(/[\u0000-\u001f\u007f]/g,' ').slice(0,1400);
  return `Disposable Git checkout failed at ${stage} (exit=${result.status}, signal=${result.signal||'none'}): ${cause}`;
}

test('Git fixture failures retain the bounded cause without credentials or private host paths',()=>{
  const secret='ghp_'+'x'.repeat(36),directory='C:\\Users\\fixture-user\\fixture';
  const message=gitFailure({status:128,stderr:`fatal: could not read configuration in ${directory} ${secret} Authorization: Bearer ${secret}\n`+'x'.repeat(3000)},'init',directory);
  assert.match(message,/exit=128/);assert.match(message,/could not read configuration/);
  assert.doesNotMatch(message,/fixture-user|ghp_|Bearer [x]/);assert.ok(message.length<=1600);
});

test('Git checkout with autocrlf enabled preserves signed release bytes and its publisher signature',async t=>{
  const directory=await mkdtemp(join(tmpdir(),'codexcli-checkout-test-'));
  t.after(()=>rm(directory,{recursive:true,force:true}));
  const globalConfig=join(directory,'isolated-global-config');await writeFile(globalConfig,'');
  const env=isolatedEnvironment(process.env);
  Object.assign(env,{GIT_CONFIG_NOSYSTEM:'1',GIT_CONFIG_GLOBAL:globalConfig,GIT_TERMINAL_PROMPT:'0'});
  const run=(...args)=>{
    const result=spawnSync('git',['-c','core.hooksPath='+join(directory,'disabled-hooks'),'-c','commit.gpgsign=false','-c','core.autocrlf=false','-C',directory,...args],{env,encoding:'utf8',windowsHide:true,timeout:15000,maxBuffer:256*1024});
    assert.equal(result.status,0,gitFailure(result,args[0],directory));
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
  assert.equal(checkout.status,0,gitFailure(checkout,'checkout-index',directory));
  for(const [name,bytes]of expected)assert.deepEqual(await readFile(join(directory,name)),bytes,'Autocrlf checkout altered signed bytes: '+name);
  assert.equal(verify(null,await readFile(join(directory,'release-integrity.json')),RELEASE_PUBLIC_KEY,await readFile(join(directory,'release-integrity.sig'))),true,'Publisher signature must remain valid after checkout');
});
