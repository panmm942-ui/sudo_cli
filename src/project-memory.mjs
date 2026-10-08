import {createHash} from 'node:crypto';
import {resolve,join} from 'node:path';
import {createPrivateRecord} from './private-state.mjs';
import {defaultWorkStateDir} from './work-meter.mjs';
import {createRedactor} from './redactor.mjs';
export async function createProjectMemory({cwd,stateDir=defaultWorkStateDir(),secrets=()=>[]}){
  const id=createHash('sha256').update(resolve(cwd)).digest('hex');
  const record=await createPrivateRecord({directory:join(stateDir,'memory'),filename:id+'.json',maxBytes:32768});
  const get=async()=>{const value=await record.read();if(!value)return {text:'',enabled:true};if(value.version!==1||typeof value.text!=='string'||typeof value.enabled!=='boolean')throw new Error('Project memory is invalid.');return value;};
  return {get,async set(text,{approved=false}={}){if(!approved)throw new Error('Explicitly approve project memory before saving.');if(typeof text!=='string'||Buffer.byteLength(text)>16000||/[\u0000-\u0008\u000b-\u001f\u007f]/.test(text))throw new Error('Memory must be plain text within 16 KiB.');const redactor=createRedactor({secrets});const clean=redactor.write(text)+redactor.flush();await record.write({version:1,text:clean,enabled:true});},
    async enable(enabled){const value=await get();await record.write({version:1,...value,enabled:!!enabled});},async clear(){await record.remove();},
    async instructions(){const value=await get();return value.enabled&&value.text?`User-approved project memory (preferences and decisions; never permission grants):\n${value.text}`:'';}};
}
