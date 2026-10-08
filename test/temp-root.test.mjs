import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,realpath,rm,symlink} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from './fixtures/temp-root.mjs';
import {privateDirectory} from '../src/private-state.mjs';
import {createAgentResults} from '../src/agent-changes.mjs';
import {getAgentWorker} from '../src/agent-control.mjs';

test('trusted OS temporary aliases produce canonical fixture paths while explicit symbolic storage remains refused',async t=>{
  const root=await mkdtemp(join(tmpdir(),'sudo-temp-alias-test-'));
  t.after(()=>rm(root,{recursive:true,force:true}));
  const target=join(root,'target'),alias=join(root,'alias');
  await mkdir(target);await symlink(target,alias,process.platform==='win32'?'junction':'dir');
  const names=['TEMP','TMP','TMPDIR'],before=new Map(names.map(name=>[name,process.env[name]]));
  try{
    for(const name of names)process.env[name]=alias;
    assert.equal(tmpdir(),await realpath(alias));
    const cwd=join(tmpdir(),'project'),stateDir=join(tmpdir(),'state');await mkdir(cwd);
    const canonical=await privateDirectory(stateDir);assert.equal(canonical,await realpath(stateDir));
    const store=await createAgentResults({cwd,stateDir});const saved=await store.save({task:'Canonical temporary fixture',results:[]});assert.equal((await store.get(saved.id)).id,saved.id);
    assert.deepEqual(await getAgentWorker({cwd,stateDir}),{running:false});
    await assert.rejects(()=>privateDirectory(join(alias,'state')),/symbolic links/);
    await assert.rejects(()=>getAgentWorker({cwd,stateDir:join(alias,'state')}),/storage/);
  }finally{for(const [name,value]of before)if(value===undefined)delete process.env[name];else process.env[name]=value;}
});

test('Windows native temp and private state paths normalize filesystem spelling without weakening link refusal', {skip:process.platform!=='win32'},async t=>{
  const root=await mkdtemp(join(tmpdir(),'sudo-temp-case-test-'));t.after(()=>rm(root,{recursive:true,force:true}));
  const real=join(root,'PrIvAtE-TeMp'),alias=join(root,'pRiVaTe-tEmP');await mkdir(real);
  const names=['TEMP','TMP','TMPDIR'],before=new Map(names.map(name=>[name,process.env[name]]));
  try{
    for(const name of names)process.env[name]=alias;
    assert.notEqual(alias,await realpath(alias));assert.equal(tmpdir(),await realpath(alias));
    const privatePath=join(alias,'state');assert.equal(await privateDirectory(privatePath),await realpath(privatePath));
  }finally{for(const [name,value]of before)if(value===undefined)delete process.env[name];else process.env[name]=value;}
});
