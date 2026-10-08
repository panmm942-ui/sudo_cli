import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile,readFile,rm,symlink,readdir,realpath,rename} from 'node:fs/promises';
import {join,dirname,basename} from 'node:path';
import {tmpdir as osTmpdir} from 'node:os';
import {spawnSync} from 'node:child_process';
import {tmpdir} from './fixtures/temp-root.mjs';
import {createProjectChanges} from '../src/project-changes.mjs';
import {isolatedEnvironment} from '../src/permission-scope.mjs';

async function fixture(t){const root=await mkdtemp(join(tmpdir(),'project-changes-'));const cwd=join(root,'project');await mkdir(cwd);t.after(()=>rm(root,{recursive:true,force:true}));return{root,cwd};}
function git(cwd,...args){const run=spawnSync('git',['-c','core.hooksPath=','-c','commit.gpgsign=false',...args],{cwd,encoding:'utf8',env:isolatedEnvironment(process.env,{GIT_CONFIG_NOSYSTEM:'1',GIT_TERMINAL_PROMPT:'0'}),timeout:10000,windowsHide:true});assert.equal(run.status,0,'Fixture Git command must succeed.');return run.stdout;}
const files=service=>service.snapshot().files.map(file=>[file.path,file.status]);

test('non-Git baseline reports real additions, edits and deletions, then returns to clean',async t=>{
  const {cwd}=await fixture(t);await writeFile(join(cwd,'edit.txt'),'before\n');await writeFile(join(cwd,'gone.txt'),'deleted before\n');
  const service=createProjectChanges({cwd});t.after(()=>service.close());await service.initialize();assert.deepEqual(files(service),[]);
  await writeFile(join(cwd,'edit.txt'),'after\n');await rm(join(cwd,'gone.txt'));await writeFile(join(cwd,'new.txt'),'new\n');await service.refresh();
  assert.deepEqual(files(service),[['edit.txt','modified'],['gone.txt','deleted'],['new.txt','added']]);
  assert.match(await service.diff('gone.txt'),/-deleted before/);assert.match(await service.diff('edit.txt'),/-before[\s\S]*\+after/);
  await writeFile(join(cwd,'edit.txt'),'before\n');await writeFile(join(cwd,'gone.txt'),'deleted before\n');await rm(join(cwd,'new.txt'));await service.refresh();assert.deepEqual(files(service),[]);
});

test('Git combines staged, unstaged, untracked and deleted files without touching the index',async t=>{
  const {cwd}=await fixture(t);git(cwd,'init','--quiet');await writeFile(join(cwd,'tracked.txt'),'base\n');await writeFile(join(cwd,'deleted.txt'),'base\n');git(cwd,'add','--all');git(cwd,'-c','user.name=Fixture','-c','user.email=fixture@example.invalid','commit','--quiet','-m','base');
  await writeFile(join(cwd,'tracked.txt'),'staged\n');git(cwd,'add','tracked.txt');await writeFile(join(cwd,'tracked.txt'),'working\n');await rm(join(cwd,'deleted.txt'));await writeFile(join(cwd,'new.txt'),'new\n');await writeFile(join(cwd,'.env'),'SECRET=private fixture value\n');
  const indexBefore=await readFile(join(cwd,'.git','index'));const service=createProjectChanges({cwd});t.after(()=>service.close());await service.initialize();
  assert.deepEqual(files(service),[['deleted.txt','deleted'],['new.txt','added'],['tracked.txt','modified']]);
  const diff=await service.diff('tracked.txt');assert.match(diff,/base[\s\S]*staged[\s\S]*working/);assert.deepEqual(await readFile(join(cwd,'.git','index')),indexBefore);
});

test('outside symlinks, private files, known secrets and arbitrary diff paths stay private',async t=>{
  const {cwd,root}=await fixture(t);const secret='fixture-hidden-value-for-change-view';await writeFile(join(root,'outside.txt'),'outside private bytes\n');await writeFile(join(cwd,'safe.txt'),'public\n');await writeFile(join(cwd,'.env'),'private bytes\n');
  const service=createProjectChanges({cwd,secrets:()=>[secret]});t.after(()=>service.close());await service.initialize();await writeFile(join(cwd,'safe.txt'),`api_key="${secret}"\n`);await writeFile(join(cwd,secret),'secret filename\n');
  try{await symlink(join(root,'outside.txt'),join(cwd,'link.txt'));}catch(error){if(!['EPERM','EACCES'].includes(error.code))throw error;}
  await service.refresh();assert.deepEqual(files(service),[['safe.txt','modified']]);assert.doesNotMatch(JSON.stringify(service.snapshot()),new RegExp(secret));
  const diff=await service.diff('safe.txt');assert.match(diff,/\[redacted\]/);assert.ok(!diff.includes(secret));assert.ok(!diff.includes(root));
  for(const path of ['../outside.txt',join(root,'outside.txt'),'.env','link.txt','not-listed.txt'])await assert.rejects(service.diff(path),/excluded|outside|unavailable|listed/i);
});

test('partial scans preserve known deleted files and never invent added files',async t=>{
  const {cwd}=await fixture(t);await writeFile(join(cwd,'before.txt'),'before');const service=createProjectChanges({cwd,maxFiles:1});t.after(()=>service.close());await service.initialize();await mkdir(join(cwd,'many'));for(let i=0;i<4;i++)await writeFile(join(cwd,'many',`${i}.txt`),'new');await rm(join(cwd,'before.txt'));await service.refresh();
  assert.equal(service.snapshot().partial,true);assert.ok(files(service).some(([path,status])=>path==='before.txt'&&status==='deleted'));assert.ok(service.snapshot().reason);
});

test('binary and oversized previews are bounded, and file replacement with a symlink is refused',async t=>{
  const {cwd,root}=await fixture(t);await writeFile(join(cwd,'binary.bin'),Buffer.from([0,1,2]));await writeFile(join(cwd,'large.txt'),'a'.repeat(70000));const service=createProjectChanges({cwd});t.after(()=>service.close());await service.initialize();await writeFile(join(cwd,'binary.bin'),Buffer.from([0,1,3]));await writeFile(join(cwd,'large.txt'),'b'.repeat(70000));await service.refresh();
  assert.match(await service.diff('binary.bin'),/binary/i);assert.match(await service.diff('large.txt'),/limit|large/i);assert.ok(Buffer.byteLength(await service.diff('large.txt'))<=65536);
  await writeFile(join(root,'outside.txt'),'never display me');await rm(join(cwd,'large.txt'));try{await symlink(join(root,'outside.txt'),join(cwd,'large.txt'));}catch(error){if(['EPERM','EACCES'].includes(error.code))return;throw error;}
  await assert.rejects(service.diff('large.txt'),/unsafe|symbolic|outside|unavailable/i);
});

test('snapshot copies cannot change internal state and close refuses more reads',async t=>{
  const {cwd}=await fixture(t);const service=createProjectChanges({cwd});await service.initialize();await writeFile(join(cwd,'new.txt'),'new');await service.refresh();const copied=service.snapshot();copied.files[0].status='deleted';assert.deepEqual(files(service),[['new.txt','added']]);await service.close();await assert.rejects(service.refresh(),/closed/i);await assert.rejects(service.diff('new.txt'),/closed/i);
});

test('Git ignores user diff commands and handles literal wildcard paths',async t=>{
  const {cwd}=await fixture(t);git(cwd,'init','--quiet');await writeFile(join(cwd,'[literal].txt'),'before\n');await writeFile(join(cwd,'.gitattributes'),'*.txt diff=fixture\n');git(cwd,'add','--all');git(cwd,'-c','user.name=Fixture','-c','user.email=fixture@example.invalid','commit','--quiet','-m','base');
  git(cwd,'config','core.fsmonitor','echo unsafe > fsmonitor-marker.txt');git(cwd,'config','diff.external','echo unsafe > external-marker.txt');git(cwd,'config','diff.fixture.textconv','echo unsafe > textconv-marker.txt');
  await writeFile(join(cwd,'[literal].txt'),'after\n');const service=createProjectChanges({cwd});t.after(()=>service.close());await service.initialize();assert.deepEqual(files(service),[['[literal].txt','modified']]);assert.match(await service.diff('[literal].txt'),/-before[\s\S]*\+after/);
  for(const name of ['fsmonitor-marker.txt','external-marker.txt','textconv-marker.txt'])await assert.rejects(readFile(join(cwd,name)),{code:'ENOENT'});
});

test('Git staged deletion plus a recreated working file remains visible',async t=>{
  const {cwd}=await fixture(t);git(cwd,'init','--quiet');await writeFile(join(cwd,'file.txt'),'committed\n');git(cwd,'add','--all');git(cwd,'-c','user.name=Fixture','-c','user.email=fixture@example.invalid','commit','--quiet','-m','base');git(cwd,'rm','--quiet','file.txt');await writeFile(join(cwd,'file.txt'),'recreated\n');
  const service=createProjectChanges({cwd});t.after(()=>service.close());await service.initialize();assert.deepEqual(files(service),[['file.txt','modified']]);const diff=await service.diff('file.txt');assert.match(diff,/-committed/);assert.match(diff,/\+recreated/);
});

test('non-Git files above content limits still appear as changes with bounded preview',async t=>{
  const {cwd}=await fixture(t);await writeFile(join(cwd,'big.txt'),'a'.repeat(1024*1024+1));const service=createProjectChanges({cwd});t.after(()=>service.close());await service.initialize();await writeFile(join(cwd,'big.txt'),'b'.repeat(1024*1024+2));await service.refresh();assert.deepEqual(files(service),[['big.txt','modified']]);assert.equal(service.snapshot().partial,false);assert.match(await service.diff('big.txt'),/limit/);
});

test('terminal control bytes in file text never reach a preview',async t=>{
  const {cwd}=await fixture(t);await writeFile(join(cwd,'file.txt'),'before');const service=createProjectChanges({cwd});t.after(()=>service.close());await service.initialize();await writeFile(join(cwd,'file.txt'),'after\x1b[2J\x07');await service.refresh();const diff=await service.diff('file.txt');assert.doesNotMatch(diff,/[\x1b\x07]/);assert.match(diff,/after/);
});

test('an explicitly excluded private-state folder inside the project is never inventoried',async t=>{
  const {cwd}=await fixture(t);const privateState=join(cwd,'custom-state');await mkdir(privateState);await writeFile(join(privateState,'saved-conversation.json'),'private conversation bytes');const service=createProjectChanges({cwd,excludePaths:[privateState]});t.after(()=>service.close());await service.initialize();await writeFile(join(privateState,'saved-conversation.json'),'changed private conversation');await service.refresh();assert.deepEqual(files(service),[]);await assert.rejects(service.diff('custom-state/saved-conversation.json'),/excluded|unavailable/i);
});

for(const driver of ['clean','process'])test(`Git ${driver} filter never executes while inspecting staged and working changes`,async t=>{
  const {cwd,root}=await fixture(t);git(cwd,'init','--quiet');await writeFile(join(cwd,'.gitattributes'),'*.txt filter=fixture\n');await writeFile(join(cwd,'tracked.txt'),'base\n');git(cwd,'add','--all');git(cwd,'-c','user.name=Fixture','-c','user.email=fixture@example.invalid','commit','--quiet','-m','base');
  await writeFile(join(cwd,'tracked.txt'),'staged\n');git(cwd,'add','tracked.txt');await writeFile(join(cwd,'tracked.txt'),'working\n');
  const marker=join(root,`${driver}-marker`),script=join(root,`${driver}-fixture.mjs`);await writeFile(script,`import {readFileSync,writeFileSync} from 'node:fs';writeFileSync(${JSON.stringify(marker)},'synthetic marker');${driver==='clean'?'process.stdout.write(readFileSync(0));':'process.exit(1);'}`);
  const quote=value=>"'"+value.replace(/\\/g,'/').replace(/'/g,"'\\''")+"'";git(cwd,'config',`filter.fixture.${driver}`,quote(process.execPath)+' '+quote(script));
  const beforeIndex=await readFile(join(cwd,'.git','index')),beforeConfig=await readFile(join(cwd,'.git','config'));const service=createProjectChanges({cwd});t.after(()=>service.close());await service.initialize();const preview=await service.diff('tracked.txt');
  await assert.rejects(readFile(marker),{code:'ENOENT'});assert.match(preview,/Staged changes[\s\S]*-base[\s\S]*\+staged[\s\S]*Working tree changes[\s\S]*-staged[\s\S]*\+working/);
  assert.deepEqual(await readFile(join(cwd,'.git','index')),beforeIndex);assert.deepEqual(await readFile(join(cwd,'.git','config')),beforeConfig);
});

test('unsupported external Git objects visibly fall back without hiding missing staged coverage',async t=>{
  const {cwd,root}=await fixture(t);git(cwd,'init','--quiet');await writeFile(join(cwd,'tracked.txt'),'base\n');git(cwd,'add','--all');git(cwd,'-c','user.name=Fixture','-c','user.email=fixture@example.invalid','commit','--quiet','-m','base');
  await writeFile(join(cwd,'tracked.txt'),'staged\n');git(cwd,'add','tracked.txt');await writeFile(join(cwd,'.git','objects','info','alternates'),root+'\n');
  const service=createProjectChanges({cwd});t.after(()=>service.close());await service.initialize();const view=service.snapshot();assert.equal(view.partial,true);assert.match(view.reason,/Staged changes are unavailable/);
  await writeFile(join(cwd,'tracked.txt'),'working\n');await service.refresh();assert.deepEqual(files(service),[['tracked.txt','modified']]);assert.match(await service.diff('tracked.txt'),/-staged[\s\S]*\+working/);assert.strictEqual(service.close(),service.close());
});

test('Git view cleanup refuses a substituted temporary directory and preserves its contents',async t=>{
  const {cwd}=await fixture(t);git(cwd,'init','--quiet');await writeFile(join(cwd,'identity.txt'),basename(cwd)+' '+cwd);git(cwd,'add','--all');git(cwd,'-c','user.name=Fixture','-c','user.email=fixture@example.invalid','commit','--quiet','-m','unique identity fixture');
  const base=await realpath(osTmpdir()),before=new Set(await readdir(base)),commit=git(cwd,'rev-parse','HEAD').trim(),service=createProjectChanges({cwd});let directory,saved;
  try{
    await service.initialize();const candidates=[];for(const name of await readdir(base))if(!before.has(name)&&/^sudo-cli-git-view-[a-z0-9]{6}$/i.test(name)){try{if((await readFile(join(base,name,'HEAD'),'utf8')).trim()===commit)candidates.push(join(base,name));}catch{}}
    assert.equal(candidates.length,1);directory=candidates[0];saved=directory+'-saved';await rename(directory,saved);await mkdir(directory);await writeFile(join(directory,'replacement-marker'),'preserve me');
    await assert.rejects(service.close(),/temporary.*identity|cleanup.*refused/i);assert.equal(await readFile(join(directory,'replacement-marker'),'utf8'),'preserve me');
  }finally{
    await service.close().catch(()=>{});for(const path of [directory,saved])if(path){assert.equal(dirname(path),base);assert.match(basename(path),/^sudo-cli-git-view-[a-z0-9]{6}(?:-saved)?$/i);await rm(path,{recursive:true,force:true});}
  }
});

test('Git preview refuses an object store substituted after the inventory',async t=>{
  const {cwd,root}=await fixture(t);git(cwd,'init','--quiet');await writeFile(join(cwd,'tracked.txt'),'base\n');git(cwd,'add','--all');git(cwd,'-c','user.name=Fixture','-c','user.email=fixture@example.invalid','commit','--quiet','-m','base');await writeFile(join(cwd,'tracked.txt'),'working\n');
  const service=createProjectChanges({cwd});t.after(()=>service.close());await service.initialize();const objects=join(cwd,'.git','objects'),outside=join(root,'outside-objects');await rename(objects,outside);
  try{await symlink(outside,objects,process.platform==='win32'?'junction':'dir');}catch(error){await rename(outside,objects);if(['EPERM','EACCES'].includes(error.code)){t.skip('Directory links are unavailable');return;}throw error;}
  try{await assert.rejects(service.diff('tracked.txt'),/excluded|outside|unavailable/);}finally{await rm(objects,{force:true});await rename(outside,objects);}
});
