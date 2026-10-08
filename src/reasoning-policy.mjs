import {validateCapabilities,validateReasoningEffort} from './runtime.mjs';

const record=value=>value!==null&&typeof value==='object'&&!Array.isArray(value);
function invalid(code,message){const error=new Error(message);error.code=code;throw error;}

/** The user's current selection takes precedence over native catalog defaults. */
export function applyReasoningPolicy(request,policy,{format='responses'}={}){
  if(!record(policy))invalid('INVALID_REASONING_POLICY','A current reasoning selection is required.');
  if(!['responses','chat-completions'].includes(format))invalid('INVALID_REASONING_POLICY','Unknown reasoning request format.');
  let effort;
  try{
    const capabilities=validateCapabilities(policy.capabilities);
    effort=validateReasoningEffort(policy.effort,{supportedEfforts:policy.supportedEfforts});
    if(capabilities?.reasoning===false&&effort!==undefined)throw new Error('Reasoning overrides are disabled.');
  }catch{invalid('INVALID_REASONING_POLICY','The selected reasoning effort is incompatible with this AI. Use /effort default or a declared supported level.');}
  const result={...request};
  if(format==='chat-completions'){
    if(effort===undefined)delete result.reasoning_effort;else result.reasoning_effort=effort;
    return result;
  }
  if(request.reasoning!==undefined){
    if(!record(request.reasoning))invalid('INVALID_REASONING_REQUEST','Reasoning must be a JSON object.');
    const nativeEffort=request.reasoning.effort;
    if(nativeEffort!==undefined&&(typeof nativeEffort!=='string'||!/^[a-z][a-z0-9_-]{0,63}$/.test(nativeEffort)))invalid('INVALID_REASONING_REQUEST','Reasoning effort must be a valid effort identifier.');
  }
  const reasoning={...request.reasoning};
  if(effort===undefined)delete reasoning.effort;else reasoning.effort=effort;
  if(Object.keys(reasoning).length)result.reasoning=reasoning;else delete result.reasoning;
  return result;
}
