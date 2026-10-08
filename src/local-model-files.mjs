import { constants } from 'node:fs';
import { access, lstat, open, opendir, mkdtemp, writeFile, rm, realpath } from 'node:fs/promises';
import { basename, delimiter, dirname, extname, isAbsolute, join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { spawn } from 'node:child_process';

const HEADER_LIMIT=1024*1024, DIRECTORY_LIMIT=512;
const controls=/[\p{Cc}\p{Cf}]/u;
const ollamaArchitectures=new Set(['llama','mistral','gemma','gemma2','phi3']);
function cancel(signal){if(signal?.aborted)throw new Error('Local model operation cancelled.');}
function localPath(value){if(typeof value!=='string'||!value.trim()||value.length>32768||controls.test(value))throw new Error('Enter a valid local model file or folder path.');return resolve(value);}
function plain(value){return value&&typeof value==='object'&&!Array.isArray(value);}
function text(value){return typeof value==='string'&&value.length<=160&&!controls.test(value)?value:undefined;}
function same(a,b){return a.dev===b.dev&&a.ino===b.ino&&a.size===b.size&&a.mtimeMs===b.mtimeMs;}
function output(value){return String(value??'').replace(/\x1b\[[0-?]*[ -/]*[@-~]/g,'').replace(/[\x00-\x08\x0b-\x1f\x7f]/g,'').slice(0,4096);}
function record(path,kind,label,bytes,extra={}){return{path,kind,label,bytes,supportedRunners:[],requirements:[],...extra};}

async function readPrefix(path,limit,signal){
  cancel(signal);const before=await lstat(path);
  if(before.isSymbolicLink())throw new Error('Symbolic links are not accepted for model inspection. Choose the real file or folder.');
  if(!before.isFile())throw new Error('A model input must be a regular file or directory.');
  let file;
  try{
    file=await open(path,constants.O_RDONLY|(constants.O_NOFOLLOW??0));const current=await file.stat();
    if(!same(before,current)||!current.isFile())throw new Error('Model input changed during inspection.');
    const buffer=Buffer.alloc(Math.min(current.size,limit));let position=0;
    while(position<buffer.length){cancel(signal);const {bytesRead}=await file.read(buffer,position,buffer.length-position,position);if(!bytesRead)break;position+=bytesRead;}
    if(!same(current,await file.stat())||position!==buffer.length)throw new Error('Model input changed during inspection.');
    return{buffer,info:current};
  }finally{await file?.close();}
}
function safetensorsHeader(buffer,size){
  if(buffer.length<10)return undefined;
  const length=buffer.readBigUInt64LE(0);
  if(length<2n||length>BigInt(HEADER_LIMIT-8)||length>BigInt(size-8)||length>BigInt(buffer.length-8))return undefined;
  let header;try{header=JSON.parse(buffer.subarray(8,8+Number(length)).toString('utf8'));}catch{return undefined;}
  if(!plain(header))return undefined;
  const entries=Object.entries(header).filter(([key])=>key!=='__metadata__');if(!entries.length||entries.length>10000)return undefined;
  const payload=size-8-Number(length);
  for(const [,tensor]of entries){
    if(!plain(tensor)||typeof tensor.dtype!=='string'||tensor.dtype.length>40||!Array.isArray(tensor.shape)||tensor.shape.length>128||tensor.shape.some(x=>!Number.isSafeInteger(x)||x<0)||!Array.isArray(tensor.data_offsets)||tensor.data_offsets.length!==2||tensor.data_offsets.some(x=>!Number.isSafeInteger(x)||x<0)||tensor.data_offsets[1]<tensor.data_offsets[0]||tensor.data_offsets[1]>payload)return undefined;
  }
  if(header.__metadata__!==undefined&&(!plain(header.__metadata__)||Object.values(header.__metadata__).some(value=>typeof value!=='string')))return undefined;
  return{metadata:header.__metadata__??{},tensors:entries.length};
}
async function inspectFile(path,{signal}={}){
  const {buffer,info}=await readPrefix(path,HEADER_LIMIT,signal),bytes=info.size;
  if(buffer.subarray(0,4).toString('ascii')==='GGUF'){
    if(buffer.length<24)return record(path,'incomplete','Incomplete GGUF file',bytes,{reason:'The GGUF header is truncated.'});
    const version=buffer.readUInt32LE(4);
    if(![2,3].includes(version)||buffer.readBigUInt64LE(8)===0n)return record(path,'incomplete','Unsupported GGUF header',bytes,{reason:'The GGUF version is unsupported or the file contains no tensors.'});
    const supportedRunners=extname(path).toLowerCase()==='.gguf'?['ollama','lmstudio']:['ollama'];
    return record(path,'gguf',`GGUF model (version ${version})`,bytes,{supportedRunners,requirements:['An installed compatible model runner and enough RAM/VRAM.','Container detection does not guarantee that this model architecture can run.'],version});
  }
  const header=safetensorsHeader(buffer,bytes);
  if(header){
    const architecture=text(header.metadata.architecture??header.metadata.model_type);
    const adapter=/^adapter_model(?:\.|$)/i.test(basename(path));
    return record(path,adapter?'adapter':'safetensors',adapter?'Safetensors adapter weights':'Safetensors weights',bytes,{architecture,format:text(header.metadata.format),requirements:adapter?['The matching base model and adapter_config.json.']:['Choose the complete model folder containing config.json, tokenizer files and every weight shard.'],reason:'A weights file alone does not establish the full model or runner compatibility.'});
  }
  if(extname(path).toLowerCase()==='.onnx')return record(path,'onnx','Possible ONNX model',bytes,{reason:'ONNX is suggested by the filename; no compatible chat runner is configured for this file.',requirements:['An ONNX runner and the correct tokenizer/chat model pipeline, exposed through a compatible local server.']});
  if(buffer[0]===0x80&&buffer[1]>=2&&buffer[1]<=5||['.pt','.pth','.ckpt'].includes(extname(path).toLowerCase())&&buffer.subarray(0,2).toString()==='PK')return record(path,'pytorch','Possible PyTorch/pickle checkpoint',bytes,{reason:'This checkpoint is not executed or automatically deserialized.',requirements:['Identify the originating model and use its trusted, compatible local inference runner.']});
  return record(path,'unknown','Unrecognized model file',bytes,{reason:'The file contents do not match a supported model container. Changing its extension does not convert it.',requirements:['Identify the model format and use a compatible local runner.']});
}
async function jsonMetadata(path,signal){
  const {buffer,info}=await readPrefix(path,HEADER_LIMIT,signal);if(info.size>HEADER_LIMIT)throw new Error('Model metadata exceeds the inspection size limit.');
  let value;try{value=JSON.parse(buffer.toString('utf8'));}catch{throw new Error('Model metadata is not valid JSON.');}
  if(!plain(value))throw new Error('Model metadata must be a JSON object.');return value;
}
async function inspectDirectory(path,{signal}={}){
  const directory=await opendir(path),entries=[];
  try{for await(const entry of directory){cancel(signal);if(entries.length>=DIRECTORY_LIMIT)throw new Error('Model folder contains too many entries for bounded inspection. Choose its model subfolder.');entries.push(entry);}}finally{await directory.close().catch(()=>{});}
  const files=new Map();let bytes=0,nested=false;
  for(const entry of entries){cancel(signal);const info=await lstat(join(path,entry.name));if(info.isSymbolicLink())throw new Error('Symbolic links inside a model folder are not accepted. Choose a folder with real model files.');if(info.isDirectory())nested=true;if(info.isFile()){files.set(entry.name,info);bytes+=info.size;}}
  const inventory=[...files.keys()].sort(),extra={files:inventory};
  if(files.has('adapter_config.json'))return record(path,'adapter','Adapter model folder',bytes,{...extra,requirements:['The matching base model; adapter weights are not a complete model.'],reason:'Automatic adapter merging/loading is not available.'});
  if(!files.has('config.json'))return record(path,'unknown','Unrecognized model folder',bytes,{...extra,reason:'No config.json was found. Select a GGUF file directly or the complete model folder.',requirements:['Model configuration, tokenizer and model weights.']});
  let config;try{config=await jsonMetadata(join(path,'config.json'),signal);}catch(error){cancel(signal);return record(path,'incomplete','Invalid model configuration',bytes,{...extra,reason:error.message});}
  const architecture=text(config.model_type)??text(config.architectures?.[0]);extra.architecture=architecture;
  const weightNames=inventory.filter(name=>/\.(?:safetensors|bin|pth)$/i.test(name));
  if(!weightNames.length)return record(path,'incomplete','Model folder without weights',bytes,{...extra,reason:'No weight files were found.'});
  if(!files.has('tokenizer.json')&&!files.has('tokenizer.model')&&!files.has('vocab.json'))return record(path,'incomplete','Model folder without tokenizer',bytes,{...extra,reason:'Tokenizer files are missing.'});
  for(const name of inventory.filter(name=>/\.(?:safetensors|bin)\.index\.json$/i.test(name))){
    let index;try{index=await jsonMetadata(join(path,name),signal);}catch(error){cancel(signal);return record(path,'incomplete','Invalid weight index',bytes,{...extra,reason:error.message});}
    const shards=plain(index.weight_map)?Object.values(index.weight_map):[];
    if(!shards.length||shards.length>100000||shards.some(value=>typeof value!=='string'||value!==basename(value)||/[\\/]/.test(value)||!files.has(value)))return record(path,'incomplete','Missing or invalid weight shards',bytes,{...extra,reason:'The weight index contains missing shards or unsafe paths.'});
  }
  let format;
  for(const name of weightNames.filter(name=>name.endsWith('.safetensors'))){
    const item=await inspectFile(join(path,name),{signal});if(item.kind!=='safetensors')return record(path,'incomplete','Invalid Safetensors shard',bytes,{...extra,reason:'A weight file has an invalid or oversized Safetensors header.'});
    format=item.format??format;
  }
  if(config.quantization||config.quantization_config?.quant_method==='mlx'||format==='mlx')return record(path,'mlx','MLX-style model folder',bytes,{...extra,reason:'MLX requires a compatible Apple Silicon inference runner; automatic file import is not available.',requirements:['A compatible MLX model runner exposing a local chat API.']});
  if(config.auto_map)return record(path,'huggingface','Hugging Face model with custom-code metadata',bytes,{...extra,reason:'Automatic import does not execute custom model code.',requirements:['A trusted compatible runner configured separately, or a supported model export.']});
  const supportedRunners=!nested&&ollamaArchitectures.has(architecture)&&weightNames.every(name=>/^(?:model|consolidated).*\.safetensors$/.test(name))?['ollama']:[];
  return record(path,'huggingface','Hugging Face model folder',bytes,{...extra,supportedRunners,requirements:['A runner that supports this model architecture and tokenizer.','The installed runner validates actual model compatibility during import.'],reason:supportedRunners.length?undefined:'This architecture or weight layout is not enabled for automatic import; use a compatible local server.'});
}

/** Inspect bounded, non-executable metadata; an extension never grants loader support. */
export async function inspectLocalModel(value,{signal}={}){
  cancel(signal);const path=localPath(value),info=await lstat(path);
  if(info.isSymbolicLink())throw new Error('Symbolic links are not accepted for model inspection. Choose the real file or folder.');
  if(info.isDirectory())return inspectDirectory(path,{signal});
  if(info.isFile())return inspectFile(path,{signal});
  throw new Error('A model input must be a regular file or directory.');
}

async function installedCommand(command,env){
  // Resolve only explicit absolute PATH entries. Windows current-directory search
  // must not execute a same-named program stored beside untrusted model weights.
  const pathKey=Object.keys(env).find(name=>name.toUpperCase()==='PATH'),search=String(env[pathKey]??'').split(delimiter);
  for(const raw of search){const directory=raw.replace(/^"(.*)"$/,'$1');if(!isAbsolute(directory)||controls.test(directory))continue;
    for(const filename of process.platform==='win32'?[`${command}.exe`,command]:[command]){
      try{const path=await realpath(join(directory,filename)),info=await lstat(path);if(!info.isFile())continue;await access(path,constants.X_OK);return path;}catch{}
    }
  }
  throw Object.assign(new Error('Installed model runner executable not found.'),{code:'ENOENT'});
}
async function execute(command,args,{cwd,env,signal,timeoutMs=600000,onOutput}={}){
  cancel(signal);
  const executable=await installedCommand(command,env);cancel(signal);
  return new Promise((accept,reject)=>{
    const child=spawn(executable,args,{cwd,env,shell:false,windowsHide:true,stdio:['ignore','pipe','pipe']});let stdout='',stderr='',size=0,finished=false,timer,killTimer,stoppedError;
    const finish=(error,value)=>{if(finished)return;finished=true;clearTimeout(timer);clearTimeout(killTimer);signal?.removeEventListener('abort',abort);error?reject(error):accept(value);};
    const stop=error=>{if(stoppedError)return;stoppedError=error;child.kill();killTimer=setTimeout(()=>child.kill('SIGKILL'),1000);killTimer.unref();};
    const abort=()=>stop(new Error('Local model operation cancelled.'));
    const receive=(kind,chunk)=>{if(stoppedError)return;size+=chunk.length;if(size>1024*1024){stop(new Error('Model runner output exceeded its size limit.'));return;}const clean=output(chunk.toString('utf8'));if(kind==='stdout')stdout=(stdout+clean).slice(-65536);else stderr=(stderr+clean).slice(-65536);try{onOutput?.(clean);}catch(error){stop(error);}};
    child.stdout.on('data',chunk=>receive('stdout',chunk));child.stderr.on('data',chunk=>receive('stderr',chunk));child.once('error',error=>finish(stoppedError??error));child.once('close',(code)=>finish(stoppedError,{code,stdout,stderr}));
    signal?.addEventListener('abort',abort,{once:true});timer=setTimeout(()=>stop(new Error('Model runner timed out.')),timeoutMs);timer.unref();if(signal?.aborted)abort();
  });
}
function importName(value){if(typeof value!=='string'||!/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,63}$/.test(value))throw new Error('Choose an import name using letters, digits, dots, underscores or hyphens (maximum 64).');return value;}
function environment(runner){const env={...process.env};for(const name of Object.keys(env))if(/^(?:HTTP_PROXY|HTTPS_PROXY|ALL_PROXY|OLLAMA_HOST|LMS_SERVER_HOST)$/i.test(name)||/(?:API_KEY|TOKEN|SECRET|PASSWORD)$/i.test(name))delete env[name];if(runner==='ollama'){env.OLLAMA_HOST='127.0.0.1:11434';env.OLLAMA_NO_CLOUD='1';}return env;}

/** Import through an installed runner. Never install runtimes, execute model code or move original weights. */
export async function importLocalModel({model,runner,name,onOutput,signal,runCommand=execute}={}){
  cancel(signal);if(!['ollama','lmstudio'].includes(runner))throw new Error('Choose Ollama or LM Studio as the model runner.');
  const selected=await inspectLocalModel(typeof model==='string'?model:model?.path,{signal});
  if(!selected.supportedRunners.includes(runner))throw new Error(`This model format cannot be automatically imported with ${runner}. ${selected.reason??selected.requirements.join(' ')}`);
  const savedName=runner==='ollama'?importName(name??'my-local-ai'):undefined;
  if(runner==='ollama'&&/[*?\[\]]/.test(selected.path))throw new Error('The model path contains wildcard characters. Choose a path without *, ?, [ or ] to avoid importing other files.');
  const command=runner==='ollama'?'ollama':'lms',env=environment(runner);
  const run=async(args,timeoutMs)=>{
    cancel(signal);let result;
    try{result=await runCommand(command,args,{cwd:dirname(selected.path),env,shell:false,windowsHide:true,signal,timeoutMs,onOutput});}
    catch(error){if(error?.code==='ENOENT'||error?.code==='EINVAL')throw new Error(`${command} is not available as an executable command. Install/configure the runner's native CLI first; SUDO CLI does not install it.`);throw error;}
    cancel(signal);const code=result?.code??result?.exitCode;if(code!==0)throw new Error(`${command} failed. ${output(result?.stderr??result?.output??result?.stdout)||'Check that the installed runner and its local server are ready.'}`);return result;
  };
  await run(['--version'],10000);
  if(runner==='lmstudio'){
    await run(['import',selected.path,'--copy','--yes'],600000);
    return{runner,model:selected,instructions:['Imported a copy into LM Studio; the original file remains in place.','Run lms load and select the imported model, then lms server start --port 1234.','Use /local, choose LM Studio and select its model. No connected model is claimed before that setup.']};
  }
  const parent=resolve(tmpdir()),directory=await mkdtemp(join(parent,'sudocli-model-import-')),modelfile=join(directory,'Modelfile');
  try{
    await writeFile(modelfile,`FROM "${selected.path}"\n`,{encoding:'utf8',mode:0o600,flag:'wx'});
    await run(['create',savedName,'-f',modelfile],600000);
    return{runner,model:selected,connection:{model:savedName,baseUrl:'http://localhost:11434/v1',transport:'chat-completions'},instructions:['Imported into your running local Ollama server. The original model input remains in place.','The next AI response verifies that the imported model can run with your hardware and API.']};
  }finally{
    if(dirname(directory)!==parent||!directory.startsWith(join(parent,'sudocli-model-import-')))throw new Error('Temporary model metadata path could not be verified for cleanup.');
    await rm(directory,{recursive:true,force:true});
  }
}
