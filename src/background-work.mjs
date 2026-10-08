import {createWorkspaceTools} from './workspace-tools.mjs';
import {acceptSandboxedWork} from './sandbox-checks.mjs';
/** Checkpoints and acceptance are independent of a model's completion claims. */
export async function createBackgroundWork(options){
  const workspace=await createWorkspaceTools(options),active=new Map(),checks=options.checks||[];
  return {
    async beginTask(id){const checkpoint=await workspace.beginCheckpoint('Background task '+id);active.set(id,checkpoint.id);},
    async endTask(id){const checkpointId=active.get(id);if(checkpointId){active.delete(id);await workspace.completeCheckpoint(checkpointId);}},
    async result(job,patch,{signal}={}){
      const checkpointId=active.get(job.id);if(!checkpointId)return patch;
      await workspace.completeCheckpoint(checkpointId);active.delete(job.id);
      if(patch.status!=='completed')return patch;
      let acceptance;try{acceptance=await acceptSandboxedWork({workspace,settings:options.settings||{},checkpointId,checks,signal});}catch{acceptance={status:signal?.aborted||checks.length?'Failed':'Needs review'};}
      return {...patch,...(signal?.aborted?{status:'blocked',reason:'Task stopped during acceptance checks. Review and explicitly retry.'}:acceptance.status==='Failed'?{status:'failed',reason:'Selected acceptance checks failed. Review /changes and /verify.'}:checks.length&&acceptance.status!=='Verified'?{status:'blocked',reason:'Selected checks could not verify this source state. Review /changes and /verify before explicitly retrying.'}:{}),result:(patch.result||'')+`\n\nAcceptance: ${acceptance.status}. Checkpoint: ${checkpointId}.`};
    },
  };
}
