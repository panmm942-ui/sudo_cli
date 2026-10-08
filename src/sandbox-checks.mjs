import {permissionPolicy,isolatedEnvironment,prepareSandboxRuntime,sandboxExecutionIdentity,sandboxChildEnvironment,createSandboxScratch} from './permission-scope.mjs';
import {createSessionHome,grantSessionHomeOwner} from './runtime.mjs';
import {localCodex} from './local-engine.mjs';

/** Explicit acceptance checks use the same native OS boundary as model commands. */
export async function acceptSandboxedWork({workspace,settings={},checks=[],checkpointId,signal,timeoutMs,maxOutputBytes}={}){
  if(!workspace||typeof workspace.cwd!=='string'||typeof workspace.acceptWork!=='function')throw new Error('Sandboxed acceptance requires a workspace.');
  const policy=permissionPolicy(settings);
  if(!Array.isArray(checks)||checks.length>16)throw new Error('Select at most 16 explicit checks.');
  if(signal!==undefined&&!(signal instanceof AbortSignal))throw new Error('Acceptance cancellation signal is invalid.');
  signal?.throwIfAborted();
  const bounds={...(timeoutMs===undefined?{}:{timeoutMs}),...(maxOutputBytes===undefined?{}:{maxOutputBytes})};
  if(!checks.length)return workspace.acceptWork({checks,checkpointId,signal,...bounds});
  if(!policy.unrestricted&&!['win32','linux','darwin'].includes(process.platform))throw new Error('No enforced native check sandbox is available on this platform.');
  let env=isolatedEnvironment();const home=await createSessionHome();
  env.CODEX_HOME=home.path;
  let sandboxRuntime,scratch;
  try{
    const identity=await sandboxExecutionIdentity({cwd:workspace.cwd,policy});
    if(identity)await grantSessionHomeOwner(home.path,identity);
    env=sandboxChildEnvironment(env,identity);
    sandboxRuntime=policy.unrestricted?undefined:await prepareSandboxRuntime(localCodex({env}),{cwd:workspace.cwd,env,identity});
    if(policy.sandbox==='workspace-write'){scratch=await createSandboxScratch({identity});env={...env,TMPDIR:scratch.path,TMP:scratch.path,TEMP:scratch.path};}
    const codexPath=sandboxRuntime?.path;
    const config={sandbox_mode:policy.sandbox,'sandbox_workspace_write.network_access':policy.networkAccess,
      'sandbox_workspace_write.exclude_tmpdir_env_var':true,'sandbox_workspace_write.exclude_slash_tmp':true,
      'shell_environment_policy.inherit':'core','shell_environment_policy.ignore_default_excludes':false,
      'shell_environment_policy.exclude':['SUDO_CLI_SESSION_KEY','SUDO_MCP_*','CODEX_HOME']};
    if(policy.writableRoots.length||scratch)config['sandbox_workspace_write.writable_roots']=[...policy.writableRoots,...(scratch?[scratch.path]:[])];
    const overrides=Object.entries(config).flatMap(([name,value])=>['-c',`${name}=${JSON.stringify(value)}`]);
    // runChecks already sets cwd to workspace.cwd. Native 0.160.1 requires a
    // named permission profile with -C; omit it so explicit legacy sandbox
    // overrides remain authoritative instead of selecting a broader profile.
    const commandWrapper=({command,args})=>{
      if(policy.unrestricted)return {command,args,env};
      const nativeArgs=['sandbox',...overrides,'--',command,...args];
      if(process.platform==='win32')return {command:codexPath,args:nativeArgs,env};
      // Node's captured stdio uses socket pairs on Unix. Restricted native
      // network policies can deny the child's socket-based stdio setup. A
      // fixed OS shell and cat bridge provide ordinary pipes for the native
      // launcher. User argv stays positional; only Codex runs the check.
      return {command:'/bin/bash',args:['-c','"$@" > >(/bin/cat) 2> >(/bin/cat >&2); status=$?; wait; exit "$status"','sudo-cli-native-check',codexPath,...nativeArgs],env,...identity};
    };
    // runChecks awaits each child's close event after cancellation or tree termination.
    // The private configuration home must outlive every native sandbox child.
    return await workspace.acceptWork({checks,checkpointId,signal,...bounds,commandWrapper});
  }finally{await Promise.all([home.cleanup(),sandboxRuntime?.cleanup(),scratch?.cleanup()]);}
}
