import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,writeFile,readFile} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {createBackgroundWork} from '../src/background-work.mjs';
test('background completion remains Needs review without checks and gets a durable checkpoint',async()=>{
  const cwd=await mkdtemp(join(tmpdir(),'sudocli-background-check-'));await writeFile(join(cwd,'source.txt'),'before');const work=await createBackgroundWork({cwd,stateDir:join(cwd,'state')});await work.beginTask('test-job');await writeFile(join(cwd,'source.txt'),'after');const result=await work.result({id:'test-job'},{status:'completed',result:'Model says done.'});assert.equal(result.status,'completed');assert.match(result.result,/Acceptance: Needs review/);assert.match(result.result,/Checkpoint:/);await work.endTask('test-job');assert.equal(await readFile(join(cwd,'source.txt'),'utf8'),'after');
});
test('failed explicit background check fails acceptance rather than accepting model success',async()=>{
  const cwd=await mkdtemp(join(tmpdir(),'sudocli-background-fail-'));await writeFile(join(cwd,'source.txt'),'source');const work=await createBackgroundWork({cwd,stateDir:join(cwd,'state'),settings:{scope:'full',permissions:'allow-everything',webAccess:true},checks:[{command:process.execPath,args:['-e','process.exit(7)'],label:'Acceptance fixture'}]});await work.beginTask('failed-job');const result=await work.result({id:'failed-job'},{status:'completed',result:'Done'});assert.equal(result.status,'failed');assert.match(result.result,/Acceptance: Failed/);
});
test('background acceptance preserves read-only scope for explicitly selected checks',{skip:process.platform!=='linux',timeout:20000},async()=>{
  const cwd=await mkdtemp(join(tmpdir(),'sudocli-background-read-only-'));
  const work=await createBackgroundWork({cwd,stateDir:join(cwd,'state'),settings:{scope:'read-only',permissions:'allow-everything',webAccess:true},checks:[{command:process.execPath,args:['-e','require("node:fs").writeFileSync("forbidden.txt","escaped")'],label:'Read-only boundary'}]});
  await work.beginTask('restricted-job');
  const result=await work.result({id:'restricted-job'},{status:'completed',result:'Model claims success.'});
  assert.equal(result.status,'failed');assert.match(result.result,/Acceptance: Failed/);
  await assert.rejects(readFile(join(cwd,'forbidden.txt')),{code:'ENOENT'});
});
test('a check that changes the inspected source state blocks background acceptance',async()=>{
  const cwd=await mkdtemp(join(tmpdir(),'sudocli-background-source-change-'));
  await writeFile(join(cwd,'source.txt'),'before');
  const work=await createBackgroundWork({cwd,stateDir:join(cwd,'state'),settings:{scope:'full',permissions:'allow-everything',webAccess:true},checks:[{command:process.execPath,args:['-e','require("node:fs").writeFileSync("source.txt","after")'],label:'Mutating check'}]});
  await work.beginTask('changing-job');
  const result=await work.result({id:'changing-job'},{status:'completed',result:'Model claims success.'});
  assert.equal(result.status,'blocked');assert.match(result.result,/Acceptance: Needs review/);
});
