import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp, mkdir, copyFile, readFile, writeFile, rm, unlink} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join, dirname} from 'node:path';
import {fileURLToPath} from 'node:url';
import {spawnSync} from 'node:child_process';
import {verifyReleaseIntegrity} from '../src/release-integrity.mjs';
import {VERSION} from '../src/version.mjs';

test('official launcher authenticates itself and helpers before loading changed release code', async t => {
  const source = fileURLToPath(new URL('..',import.meta.url));
  await verifyReleaseIntegrity({root:source,expectedVersion:VERSION});
  const directory = await mkdtemp(join(tmpdir(),'sudo-bootstrap-integrity-'));
  t.after(()=>rm(directory,{recursive:true,force:true}));
  const root = join(directory,'release');
  const manifest = JSON.parse(await readFile(join(source,'release-integrity.json'),'utf8'));
  for(const name of [...manifest.files.map(file=>file.path),'release-integrity.json','release-integrity.sig']) {
    const target = join(root,name);await mkdir(dirname(target),{recursive:true});await copyFile(join(source,name),target);
  }
  const run = (entry='bin/sudocli.mjs',args=['--version']) => spawnSync(process.execPath,[join(root,entry),...args],{encoding:'utf8',shell:false,windowsHide:true,timeout:20000});
  const failure = result => {
    assert.equal(result.status,1,result.stderr);
    assert.match(result.stderr,/integrity|signature|release.*changed/i);
    assert.equal(result.stdout,'');
    assert.ok(!result.stderr.includes('UNTRUSTED_HELPER_EXECUTED'));
  };
  const original = run();assert.equal(original.status,0,original.stderr);assert.match(original.stdout,new RegExp(`codexcli ${VERSION.replaceAll('.','\\.')} \\| sudocli`));
  for(const name of ['scripts/setup.mjs','scripts/setup-runtime.mjs']) {const result=run(name,['--help']);assert.equal(result.status,0,result.stderr);assert.match(result.stdout,/setup/i);}
  for(const [name,change] of [
    ['src/dashboard.mjs',text=>text.replace('instagram.com/mimilidhcc','instagram.com/changed-credit')],
    ['bin/sudocli.mjs',text=>text+'\n// unauthorized launcher change\n'],
    ['src/release-integrity.mjs',text=>"throw new Error('UNTRUSTED_HELPER_EXECUTED');\n"+text],
    ['src/release-public-key.mjs',text=>"throw new Error('UNTRUSTED_HELPER_EXECUTED');\n"+text],
    ['src/setup-cli.mjs',text=>"throw new Error('UNTRUSTED_HELPER_EXECUTED');\n"+text],
    ['src/setup-runtime-cli.mjs',text=>"throw new Error('UNTRUSTED_HELPER_EXECUTED');\n"+text],
  ]) await t.test('refuses changed '+name,async()=>{
    const path=join(root,name),bytes=await readFile(path);const altered=change(bytes.toString('utf8'));assert.notEqual(altered,bytes.toString('utf8'));
    try {await writeFile(path,altered);failure(run());for(const entry of ['scripts/setup.mjs','scripts/setup-runtime.mjs'])failure(run(entry,['--help']));}
    finally {await writeFile(path,bytes);}
  });
  await t.test('refuses injected source files',async()=>{
    const path=join(root,'src','injected.mjs');try {await writeFile(path,'throw new Error("injected")');failure(run());}finally {await unlink(path);}
  });
  await t.test('refuses missing signed files',async()=>{
    const path=join(root,'README.md'),bytes=await readFile(path);try {await unlink(path);failure(run());}finally {await writeFile(path,bytes);}
  });
  await t.test('refuses altered or missing signed manifest metadata',async()=>{
    for(const name of ['release-integrity.json','release-integrity.sig']) {
      const path=join(root,name),bytes=await readFile(path);
      try {await writeFile(path,Buffer.alloc(bytes.length));failure(run());await unlink(path);failure(run());}
      finally {await writeFile(path,bytes);}
    }
  });
  const restored=run();assert.equal(restored.status,0,restored.stderr);
});
