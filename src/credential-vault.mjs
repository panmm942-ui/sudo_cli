import {createHash} from 'node:crypto';
import {spawn} from 'node:child_process';
import {join} from 'node:path';
import {createPrivateRecord} from './private-state.mjs';
import {defaultWorkStateDir} from './work-meter.mjs';
export function credentialIdentity(connection){return createHash('sha256').update([connection.baseUrl,connection.model,connection.transport].join('\0')).digest('hex');}
async function run(command,args,input=''){return new Promise((resolve,reject)=>{let text='',failed=false;const child=spawn(command,args,{stdio:['pipe','pipe','ignore'],shell:false,windowsHide:true});const timer=setTimeout(()=>{failed=true;child.kill();},15000);child.once('error',()=>{failed=true;});child.stdin.on('error',()=>{});child.stdout.on('data',chunk=>{text+=chunk;if(text.length>32768){failed=true;child.kill();}});child.once('close',code=>{clearTimeout(timer);if(failed||code!==0)reject(new Error('OS credential store is unavailable or refused this operation.'));else resolve(text.trim());});child.stdin.end(input);});}
const ps=(mode)=>`Add-Type -AssemblyName System.Security; $v=[Console]::In.ReadToEnd(); $b=[Convert]::FromBase64String($v); $r=[System.Security.Cryptography.ProtectedData]::${mode}($b,$null,[System.Security.Cryptography.DataProtectionScope]::CurrentUser); [Console]::Out.Write([Convert]::ToBase64String($r))`;
export async function createCredentialVault({stateDir=defaultWorkStateDir(),platform=process.platform}={}){
  const record=async connection=>createPrivateRecord({directory:join(stateDir,'credentials'),filename:credentialIdentity(connection)+'.json'});
  const path=connection=>join(stateDir,'credentials',credentialIdentity(connection)+'.json');
  return {backend:platform==='win32'?'Windows DPAPI':platform==='darwin'?'macOS Keychain':'Secret Service (secret-tool)',path,
    async save(connection,key,{approved=false}={}){if(!approved)throw new Error('Explicitly choose OS-protected credential storage.');if(typeof key!=='string'||!key||key.length>4096||/[\u0000-\u001f\u007f]/.test(key))throw new Error('Invalid API credential.');const id=credentialIdentity(connection);
      if(platform==='win32'){const encrypted=await run('powershell.exe',['-NoProfile','-NonInteractive','-Command',ps('Protect')],Buffer.from(key).toString('base64'));await(await record(connection)).write({version:1,backend:'dpapi',encrypted});}
      else if(platform==='darwin'){const quote=value=>'"'+value.replace(/\\/g,'\\\\').replace(/"/g,'\\"')+'"';await run('/usr/bin/security',['-i'],`add-generic-password -U -s sudocli -a ${id} -w ${quote(key)}\nquit\n`);const saved=await run('/usr/bin/security',['find-generic-password','-s','sudocli','-a',id,'-w']);if(saved!==key)throw new Error('OS credential store did not confirm the saved credential.');}
      else await run('secret-tool',['store','--label=SUDO CLI model credential','service','sudocli','identity',id],key);},
    async load(connection){const id=credentialIdentity(connection);
      if(platform==='win32'){const value=await(await record(connection)).read();if(!value)return undefined;if(value.version!==1||value.backend!=='dpapi'||typeof value.encrypted!=='string')throw new Error('Credential record is invalid.');const raw=await run('powershell.exe',['-NoProfile','-NonInteractive','-Command',ps('Unprotect')],value.encrypted);return Buffer.from(raw,'base64').toString('utf8');}
      try{return(await run(platform==='darwin'?'/usr/bin/security':'secret-tool',platform==='darwin'?['find-generic-password','-s','sudocli','-a',id,'-w']:['lookup','service','sudocli','identity',id]))||undefined;}catch{return undefined;}},
    async remove(connection){const id=credentialIdentity(connection);if(platform==='win32')await(await record(connection)).remove();else await run(platform==='darwin'?'/usr/bin/security':'secret-tool',platform==='darwin'?['delete-generic-password','-s','sudocli','-a',id]:['clear','service','sudocli','identity',id]);}
  };
}
