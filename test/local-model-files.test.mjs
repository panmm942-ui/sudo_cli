import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, open, rm, lstat, symlink } from 'node:fs/promises';
import { join, resolve, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { inspectLocalModel, importLocalModel } from '../src/local-model-files.mjs';

async function fixture(t) {
  const parent=resolve(tmpdir()),directory=await mkdtemp(join(parent,'sudocli-model-file-test-'));
  t.after(async()=>{assert.equal(dirname(directory),parent);assert.ok(directory.startsWith(join(parent,'sudocli-model-file-test-')));await rm(directory,{recursive:true,force:true});});
  return directory;
}
function gguf(version=3) {const b=Buffer.alloc(64);b.write('GGUF');b.writeUInt32LE(version,4);b.writeBigUInt64LE(1n,8);return b;}
function safetensors(metadata={format:'pt'}) {const header=Buffer.from(JSON.stringify({__metadata__:metadata,'layer.weight':{dtype:'F32',shape:[1],data_offsets:[0,4]}}));const length=Buffer.alloc(8);length.writeBigUInt64LE(BigInt(header.length));return Buffer.concat([length,header,Buffer.alloc(4)]);}
async function inspected(path) {let value;await assert.doesNotReject(async()=>{value=await inspectLocalModel(path);});return value;}

test('recognizes GGUF content under any extension without reading all weights',async t=>{
  const directory=await fixture(t),path=join(directory,'weights.whatever');await writeFile(path,gguf());const file=await open(path,'r+');await file.truncate(64*1024*1024);await file.close();
  const value=await inspected(path);assert.equal(value.kind,'gguf');assert.equal(value.bytes,64*1024*1024);assert.deepEqual(value.supportedRunners,['ollama']);assert.equal(value.path,path);
});
test('does not trust a GGUF suffix or unsupported container version',async t=>{
  const directory=await fixture(t),fake=join(directory,'fake.gguf'),future=join(directory,'future.gguf');await writeFile(fake,'ordinary text');await writeFile(future,gguf(999));
  assert.equal((await inspected(fake)).kind,'unknown');const bad=await inspected(future);assert.deepEqual(bad.supportedRunners,[]);assert.match(bad.reason,/version|unsupported/i);
});
test('recognizes bounded Safetensors content and explains a single shard needs its model folder',async t=>{
  const directory=await fixture(t),path=join(directory,'weights.data');await writeFile(path,safetensors({format:'pt',architecture:'LlamaForCausalLM'}));
  const value=await inspected(path);assert.equal(value.kind,'safetensors');assert.equal(value.architecture,'LlamaForCausalLM');assert.deepEqual(value.supportedRunners,[]);assert.match(value.requirements.join(' '),/folder|directory/i);
});
test('rejects giant or invalid Safetensors header lengths without allocating them',async t=>{
  const directory=await fixture(t),path=join(directory,'evil.safetensors');const b=Buffer.alloc(16);b.writeBigUInt64LE(2n**62n);await writeFile(path,b);
  const value=await inspected(path);assert.equal(value.kind,'unknown');assert.deepEqual(value.supportedRunners,[]);
});
test('inspects complete Hugging Face Safetensors folders and detects missing index shards',async t=>{
  const directory=await fixture(t);await writeFile(join(directory,'config.json'),JSON.stringify({model_type:'llama',architectures:['LlamaForCausalLM']}));await writeFile(join(directory,'tokenizer.json'),'{}');await writeFile(join(directory,'model.safetensors'),safetensors());
  const complete=await inspected(directory);assert.equal(complete.kind,'huggingface');assert.equal(complete.architecture,'llama');assert.deepEqual(complete.supportedRunners,['ollama']);
  await writeFile(join(directory,'model.safetensors.index.json'),JSON.stringify({weight_map:{a:'model.safetensors',b:'missing.safetensors'}}));const missing=await inspected(directory);assert.equal(missing.kind,'incomplete');assert.deepEqual(missing.supportedRunners,[]);assert.match(missing.reason,/missing/i);
});
test('blocks index traversal and custom-code model loading while detecting MLX and adapters',async t=>{
  const directory=await fixture(t),mlx=join(directory,'mlx'),adapter=join(directory,'adapter'),custom=join(directory,'custom');for(const path of [mlx,adapter,custom])await mkdir(path);
  await writeFile(join(mlx,'config.json'),JSON.stringify({model_type:'llama',quantization:{bits:4,group_size:64}}));await writeFile(join(mlx,'tokenizer.json'),'{}');await writeFile(join(mlx,'model.safetensors'),safetensors({format:'mlx'}));assert.equal((await inspected(mlx)).kind,'mlx');
  await writeFile(join(adapter,'adapter_config.json'),JSON.stringify({base_model_name_or_path:'base-model'}));await writeFile(join(adapter,'adapter_model.safetensors'),safetensors());const ad=await inspected(adapter);assert.equal(ad.kind,'adapter');assert.deepEqual(ad.supportedRunners,[]);assert.match(ad.requirements.join(' '),/base model/i);
  await writeFile(join(custom,'config.json'),JSON.stringify({model_type:'llama',auto_map:{AutoModelForCausalLM:'custom.py'}}));await writeFile(join(custom,'tokenizer.json'),'{}');await writeFile(join(custom,'model.safetensors'),safetensors());assert.deepEqual((await inspected(custom)).supportedRunners,[]);
  await writeFile(join(custom,'model.safetensors.index.json'),JSON.stringify({weight_map:{x:'../model.safetensors'}}));assert.equal((await inspected(custom)).kind,'incomplete');
});
test('reports ONNX and pickle-like files truthfully without executing or importing them',async t=>{
  const directory=await fixture(t),onnx=join(directory,'model.onnx'),pickle=join(directory,'model.pt');await writeFile(onnx,Buffer.from([8,9,18,3,97,98,99]));await writeFile(pickle,Buffer.from([128,4,149,1,0,0,0]));
  assert.equal((await inspected(onnx)).kind,'onnx');const value=await inspected(pickle);assert.equal(value.kind,'pytorch');assert.deepEqual(value.supportedRunners,[]);
  await assert.rejects(importLocalModel({model:value,runner:'ollama',name:'local-test',runCommand:()=>assert.fail('Unsupported files must never invoke a runner.')}),/unsupported|support|cannot/i);
});
test('refuses symbolic links and cancels inspection before opening files',async t=>{
  const directory=await fixture(t),path=join(directory,'weights.gguf'),link=join(directory,'link.gguf');await writeFile(path,gguf());
  try{await symlink(path,link);}catch(error){if(process.platform==='win32'&&['EPERM','EACCES'].includes(error.code)){t.diagnostic('Windows file symlinks require privileges; cancellation still checked.');}else throw error;}
  if(await lstat(link).catch(()=>false))await assert.rejects(inspectLocalModel(link),/symbolic|symlink/i);
  const controller=new AbortController();controller.abort();await assert.rejects(inspectLocalModel(path,{signal:controller.signal}),/abort|cancel/i);
});
test('imports a renamed GGUF through Ollama using only the inspected local file and cleans temporary metadata',async t=>{
  const directory=await fixture(t),path=join(directory,'weights with spaces.other');const bytes=gguf();await writeFile(path,bytes);const model=await inspected(path);let metadataPath;const commands=[];
  const result=await importLocalModel({model,runner:'ollama',name:'my-local-ai',runCommand:async(command,args,options)=>{
    commands.push({command,args,options});if(args[0]==='--version')return{code:0,stdout:'ollama version 1.0',stderr:''};assert.equal(args[0],'create');metadataPath=args[args.indexOf('-f')+1];assert.equal(await readFile(metadataPath,'utf8'),`FROM "${path}"\n`);return{code:0,stdout:'success',stderr:''};
  }});
  assert.equal(result.connection.model,'my-local-ai');assert.equal(result.connection.baseUrl,'http://localhost:11434/v1');assert.equal(result.connection.apiKey,undefined);assert.deepEqual(await readFile(path),bytes);assert.equal(await lstat(metadataPath).catch(()=>false),false);assert.equal(commands.length,2);assert.equal(commands[1].options.env.OLLAMA_HOST,'127.0.0.1:11434');assert.equal(commands[1].options.shell,false);
});
test('LM Studio import copies an actual GGUF and returns honest load instructions without inventing a connected model',async t=>{
  const directory=await fixture(t),path=join(directory,'weights.gguf');await writeFile(path,gguf());const calls=[];
  const result=await importLocalModel({model:await inspected(path),runner:'lmstudio',runCommand:async(command,args)=>{calls.push([command,args]);return{code:0,stdout:'ok',stderr:''};}});
  assert.deepEqual(calls,[['lms',['--version']],['lms',['import',path,'--copy','--yes']]]);assert.equal(result.connection,undefined);assert.match(result.instructions.join(' '),/lms load/);assert.ok(await lstat(path));
});
test('rejects invalid import names, unsupported runner choices and missing runner before changing model storage',async t=>{
  const directory=await fixture(t),path=join(directory,'weights.gguf');await writeFile(path,gguf());const model=await inspected(path);
  await assert.rejects(importLocalModel({model,runner:'ollama',name:'../../bad',runCommand:()=>assert.fail('Invalid names must not invoke a runner.')}),/name/i);
  await assert.rejects(importLocalModel({model,runner:'python',name:'okay',runCommand:()=>assert.fail('Unknown runners must not execute.')}),/runner/i);
  await assert.rejects(importLocalModel({model,runner:'ollama',name:'okay',runCommand:async()=>{throw Object.assign(new Error('not found'),{code:'ENOENT'});}}),/install|not found|available/i);
});
test('failed or cancelled imports never claim a connected model and clean temporary Modelfiles',async t=>{
  const directory=await fixture(t),path=join(directory,'weights.gguf');await writeFile(path,gguf());const model=await inspected(path);let metadataPath;
  await assert.rejects(importLocalModel({model,runner:'ollama',name:'okay',runCommand:async(_command,args)=>{if(args[0]==='--version')return{code:0};metadataPath=args.at(-1);return{code:1,stderr:'unsupported architecture'};}}),/failed|unsupported architecture/i);
  assert.equal(await lstat(metadataPath).catch(()=>false),false);const controller=new AbortController();controller.abort();await assert.rejects(importLocalModel({model,runner:'ollama',name:'okay',signal:controller.signal,runCommand:()=>assert.fail('Cancelled import must not execute.')}),/abort|cancel/i);
});
test('import re-inspects changed files and refuses unsafe runner globs before command execution',async t=>{
  const directory=await fixture(t),path=join(directory,'changed.gguf');await writeFile(path,gguf());const model=await inspected(path);await writeFile(path,'no longer a model');
  await assert.rejects(importLocalModel({model,runner:'ollama',name:'okay',runCommand:()=>assert.fail('Stale inspection must never authorize a loader.')}),/cannot|support/i);
  const wildcard=join(directory,'weights[1].gguf');await writeFile(wildcard,gguf());await assert.rejects(importLocalModel({model:await inspected(wildcard),runner:'ollama',name:'okay',runCommand:()=>assert.fail('Runner wildcard expansion must be rejected.')}),/wildcard/i);
});
test('nested model folders and unmatched Safetensors names do not authorize a broad runner folder import',async t=>{
  const directory=await fixture(t);await writeFile(join(directory,'config.json'),JSON.stringify({model_type:'llama'}));await writeFile(join(directory,'tokenizer.json'),'{}');await writeFile(join(directory,'arbitrary.safetensors'),safetensors());
  assert.deepEqual((await inspected(directory)).supportedRunners,[]);
  await rm(join(directory,'arbitrary.safetensors'));await writeFile(join(directory,'model.safetensors'),safetensors());await mkdir(join(directory,'nested'));await writeFile(join(directory,'nested','model.safetensors'),safetensors());
  assert.deepEqual((await inspected(directory)).supportedRunners,[]);
});
test('model directories with more than the bounded entry inventory are rejected',async t=>{
  const directory=await fixture(t);await Promise.all(Array.from({length:513},(_,i)=>writeFile(join(directory,`file-${i}`),'x')));
  await assert.rejects(inspectLocalModel(directory),/too many|bounded/i);
});
