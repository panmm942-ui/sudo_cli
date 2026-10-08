import {resolve,relative,isAbsolute} from 'node:path';
export function permissionPolicy({permissions='ask',webAccess=false,scope='project',writableRoots=[]}={}){
  if(!['ask','allow-everything'].includes(permissions)||typeof webAccess!=='boolean'||!['read-only','project','full'].includes(scope))throw new Error('Invalid permission scope.');
  const unrestricted=permissions==='allow-everything'&&scope==='full'&&webAccess;
  if(!Array.isArray(writableRoots)||writableRoots.length>32||writableRoots.some(path=>typeof path!=='string'||!isAbsolute(path)||/[\p{Cc}\p{Cf}]/u.test(path)))throw new Error('Write folders must be up to 32 absolute paths.');
  return {permissions,scope,webAccess,writableRoots:scope==='read-only'?[]:[...new Set(writableRoots.map(path=>resolve(path)))],sandbox:scope==='read-only'?'read-only':unrestricted?'danger-full-access':'workspace-write',approvalPolicy:permissions==='ask'?'on-request':'never',networkAccess:webAccess&&scope!=='read-only',unrestricted};
}
export function approvalWithinScope({method,params={}},settings){
  const scope=settings.scope||'project';if(scope==='read-only')return false;
  // Native command approval may bypass its sandbox. With Web Off, no such grant
  // is accepted, even when an explanation describes the command as harmless.
  if(!settings.webAccess&&method!=='item/fileChange/requestApproval'&&method!=='applyPatchApproval')return false;
  if(method==='item/permissions/requestApproval')return scope==='full'&&settings.webAccess;
  if(scope==='full')return true;
  const root=resolve(settings.cwd||process.cwd());const paths=[params.cwd,params.grantRoot,...Object.keys(params.fileChanges||{})].filter(Boolean);
  if(paths.some(path=>![root,...(settings.writableRoots||[])].some(folder=>{const rel=relative(resolve(folder),resolve(root,path));return rel!== '..'&&!rel.startsWith('..'+(process.platform==='win32'?'\\':'/'))&&!isAbsolute(rel);})))return false;
  if(method==='item/commandExecution/requestApproval'||method==='execCommandApproval')return false; // Project scope never unsandboxes commands.
  return true;
}
export function isolatedEnvironment(env=process.env,overrides={}){
  const allowed=new Set(['PATH','PATHEXT','SYSTEMROOT','WINDIR','COMSPEC','TEMP','TMP','TMPDIR','HOME','USERPROFILE','LOCALAPPDATA','APPDATA','LANG','LC_ALL','LC_CTYPE','TERM','TZ','XDG_RUNTIME_DIR']);
  const result={};for(const [name,value] of Object.entries(env))if(allowed.has(name.toUpperCase()))result[name]=value;
  return {...result,...overrides};
}
