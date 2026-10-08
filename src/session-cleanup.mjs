export const isSessionCleanupError = error => ['ENGINE_CLEANUP_UNVERIFIED','SESSION_CLEANUP_FAILED'].includes(error?.code);

/** Finish every owned resource, even when an earlier close rejects. Messages
 * are static; a redacted primary task error may be retained as the cause.
 */
export async function closeNativeSession({watchdog,engine,bridge,home}={}, {cause}={}) {
  let failed=false,engineFailed=false;
  for(const [resource,method,kind] of [[watchdog,'stop','watchdog'],[engine,'close','engine'],[bridge,'close','bridge'],[home,'cleanup','home']]) {
    try {await resource?.[method]();}
    catch {failed=true;if(kind==='engine')engineFailed=true;}
  }
  if(!failed&&!isSessionCleanupError(cause))return;
  const code=engineFailed||cause?.code==='ENGINE_CLEANUP_UNVERIFIED'?'ENGINE_CLEANUP_UNVERIFIED':'SESSION_CLEANUP_FAILED';
  throw Object.assign(new Error(code==='ENGINE_CLEANUP_UNVERIFIED'
    ?'Codex engine process cleanup could not be verified. Close this session and inspect its remaining processes before reconnecting.'
    :'Session resource cleanup could not be completed. Close this session before reconnecting.',cause?{cause}:undefined),{code});
}
