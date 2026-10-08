import {createHash} from 'node:crypto';
import {stageUpdate,installStagedUpdate} from './verified-update.mjs';

const MAX_PACKAGE=512*1024*1024,MAX_METADATA=512*1024,MAX_SUMS=1024*1024;
const offers=new WeakMap(),assetHosts=new Set(['github.com','release-assets.githubusercontent.com','objects.githubusercontent.com']);
const headers=Object.freeze({'Accept':'application/vnd.github+json','User-Agent':'codexcli-release-check'});
const versionPattern=/^(?:v)?(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;
export const DEFAULT_GITHUB_REPOSITORY='panmm942-ui/sudo_cli';

export function normalizeGitHubRepository(value){
  if(typeof value!=='string'||!value)return undefined;
  if(value.length>140||!/^([A-Za-z0-9](?:[A-Za-z0-9-]{0,37}[A-Za-z0-9])?)\/([A-Za-z0-9._-]{1,100})$/.test(value)||value.split('/')[1]==='.'||value.split('/')[1]==='..'||value.endsWith('.git'))throw new Error('Use a GitHub repository in OWNER/REPO form.');
  return value;
}
function version(value){const match=versionPattern.exec(value||'');if(!match)return;const parts=match.slice(1).map(Number);if(parts.some(part=>!Number.isSafeInteger(part)))return;return{value:parts.join('.'),parts};}
function newer(left,right){for(let index=0;index<3;index++){if(left[index]>right[index])return true;if(left[index]<right[index])return false;}return false;}
function safeUrl(value,hosts){
  let url;try{url=new URL(value);}catch{throw new Error('GitHub release URL is invalid.');}
  if(typeof value!=='string'||/[\u0000-\u0020\u007f]/.test(value)||url.protocol!=='https:'||url.username||url.password||url.hash||url.port&&!['443'].includes(url.port)||!hosts.has(url.hostname))throw new Error('GitHub release URL is outside the trusted HTTPS hosts.');
  return url;
}
function pinnedUrl(value,expected){const url=safeUrl(value,new Set(['github.com'])),target=new URL(expected),parts=url.pathname.split('/'),wanted=target.pathname.split('/');
  if(url.search||parts.length!==wanted.length||parts.some((part,index)=>index===1||index===2?part.toLowerCase()!==wanted[index].toLowerCase():part!==wanted[index]))throw new Error('GitHub release URL does not match the configured repository and release.');return url.href;}
function abortable(promise,signal){
  signal.throwIfAborted();return new Promise((resolve,reject)=>{const abort=()=>reject(signal.reason);signal.addEventListener('abort',abort,{once:true});Promise.resolve(promise).then(resolve,reject).finally(()=>signal.removeEventListener('abort',abort));});
}
function deadline(signal,timeoutMs){if(!Number.isSafeInteger(timeoutMs)||timeoutMs<100||timeoutMs>120000)throw new Error('GitHub request timeout is invalid.');const timeout=AbortSignal.timeout(timeoutMs);return signal?AbortSignal.any([signal,timeout]):timeout;}
async function request(value,{fetchImpl,signal,accept='application/vnd.github+json',redirects=false}={}){
  let url=safeUrl(value,redirects?assetHosts:new Set(['api.github.com']));
  for(let count=0;;count++){
    signal.throwIfAborted();const response=await abortable(fetchImpl(url,{method:'GET',headers:{...headers,Accept:accept},redirect:'manual',signal}),signal);
    if(response.redirected){await response.body?.cancel().catch(()=>{});throw new Error('GitHub request unexpectedly followed a redirect.');}
    if(![301,302,303,307,308].includes(response.status))return response;
    const location=response.headers.get('location');await response.body?.cancel().catch(()=>{});
    if(!redirects||count>=4||!location)throw new Error('GitHub request redirect was refused.');
    try{url=safeUrl(new URL(location,url).href,assetHosts);}catch{throw new Error('GitHub asset redirect left the trusted HTTPS hosts.');}
  }
}
async function bytes(response,maxBytes,signal){
  if(!response.ok||!response.body){await response.body?.cancel().catch(()=>{});throw new Error('GitHub request failed.');}
  const length=response.headers.get('content-length');if(length!==null&&(!/^\d+$/.test(length)||Number(length)>maxBytes)){await response.body.cancel().catch(()=>{});throw new Error('GitHub response exceeds its size limit.');}
  const reader=response.body.getReader(),chunks=[];let size=0;
  try{for(;;){const chunk=await abortable(reader.read(),signal);if(chunk.done)break;size+=chunk.value.byteLength;if(size>maxBytes)throw new Error('GitHub response exceeds its size limit.');chunks.push(Buffer.from(chunk.value));}return Buffer.concat(chunks,size);}
  finally{await reader.cancel().catch(()=>{});reader.releaseLock();}
}
function assetRecord(asset,{repository,tag,maxBytes}){
  if(!asset||!Number.isSafeInteger(asset.id)||asset.id<1||asset.state!=='uploaded'||typeof asset.name!=='string'||!/^[A-Za-z0-9._-]+$/.test(asset.name)||!Number.isSafeInteger(asset.size)||asset.size<1||asset.size>maxBytes)throw new Error('GitHub release asset metadata is invalid.');
  const url=pinnedUrl(asset.browser_download_url,`https://github.com/${repository}/releases/download/${encodeURIComponent(tag)}/${asset.name}`);
  let sha256;if(asset.digest!==undefined&&asset.digest!==null){if(typeof asset.digest!=='string'||!/^sha256:[a-f0-9]{64}$/i.test(asset.digest))throw new Error('GitHub release asset digest is invalid.');sha256=asset.digest.slice(7).toLowerCase();}
  return Object.freeze({name:asset.name,url,size:asset.size,id:asset.id,...(sha256?{sha256}:{})});
}
function releaseRecord(release,{repository,platform,arch,currentVersion}){
  if(!Number.isSafeInteger(release?.id)||release.id<1||release.draft!==false||release.prerelease!==false||!Array.isArray(release.assets)||release.assets.length>1000)throw new Error('GitHub release metadata is invalid or is not a stable public release.');
  const parsed=version(release.tag_name);if(!parsed)throw new Error('GitHub release tag must be a stable semantic version.');
  const releaseUrl=pinnedUrl(release.html_url,`https://github.com/${repository}/releases/tag/${encodeURIComponent(release.tag_name)}`);
  if(!newer(parsed.parts,currentVersion.parts))return{status:'current',repository,version:parsed.value,releaseUrl};
  const target=({win32:'windows',darwin:'macos',linux:'linux'})[platform];if(!target||!['x64','arm64'].includes(arch))return{status:'available',repository,version:parsed.value,releaseUrl,installable:false,reason:'This platform or architecture has no supported update package.'};
  const packageNames=[`codexcli-${parsed.value}-${target}-${arch}.zip`,`codexcli-${parsed.value}-cross-platform.zip`];
  const sumsNames=[`codexcli-${parsed.value}-SHA256SUMS.txt`,'SHA256SUMS.txt','SHA256SUMS'];
  const select=names=>{for(const name of names){const found=release.assets.filter(asset=>asset?.name===name);if(found.length>1)throw new Error('GitHub release contains duplicate update assets.');if(found.length)return found[0];}};
  const selected=select(packageNames),selectedSums=select(sumsNames);
  if(!selected||!selectedSums)return{status:'available',repository,version:parsed.value,releaseUrl,installable:false,reason:'The newer release needs a compatible ZIP and SHA256SUMS release asset.'};
  const identity={repository,tag:release.tag_name};
  return{status:'available',repository,version:parsed.value,releaseUrl,installable:true,asset:assetRecord(selected,{...identity,maxBytes:MAX_PACKAGE}),checksums:assetRecord(selectedSums,{...identity,maxBytes:MAX_SUMS}),releaseId:release.id};
}

// A check reads only bounded public release metadata. Downloads and execution occur after confirmation.
export async function checkGitHubRelease({repository=DEFAULT_GITHUB_REPOSITORY,currentVersion,platform=process.platform,arch=process.arch,fetchImpl=fetch,signal,timeoutMs=5000}={}){
  if(repository===undefined||repository===null||repository==='')return Object.freeze({status:'unconfigured',reason:'Set the release repository with /update repo OWNER/REPO.'});
  try{
    repository=normalizeGitHubRepository(repository);const current=version(currentVersion);if(!current)throw new Error('Installed version is not a stable semantic version.');
    const requestSignal=deadline(signal,timeoutMs),response=await request(`https://api.github.com/repos/${repository}/releases/latest`,{fetchImpl,signal:requestSignal});
    if(!response.ok){await response.body?.cancel().catch(()=>{});return Object.freeze({status:'unavailable',repository,reason:[403,429].includes(response.status)?'GitHub release checks are rate limited.':'No public GitHub release could be checked.'});}
    const raw=await bytes(response,MAX_METADATA,requestSignal);let release;try{release=JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(raw));}catch{throw new Error('GitHub release metadata is invalid.');}
    const offer=Object.freeze(releaseRecord(release,{repository,platform,arch,currentVersion:current}));
    if(offer.installable)offers.set(offer,{fetchImpl,platform,arch,currentVersion:current});return offer;
  }catch(error){if(signal?.aborted)throw signal.reason;return Object.freeze({status:'unavailable',reason:error?.name==='TimeoutError'?'GitHub release check timed out.':'GitHub release check failed validation or could not connect.'});}
}
function checksum(bytesValue,name){
  let text;try{text=new TextDecoder('utf-8',{fatal:true}).decode(bytesValue);}catch{throw new Error('GitHub release checksum file is invalid.');}
  const files=new Map();for(const line of text.split(/\r?\n/)){if(!line)continue;const match=/^([a-fA-F0-9]{64}) [ *]([A-Za-z0-9._-]+)$/.exec(line);if(!match||files.has(match[2]))throw new Error('GitHub release checksum file contains invalid or duplicate entries.');files.set(match[2],match[1].toLowerCase());}
  const hash=files.get(name);if(!hash)throw new Error('GitHub release checksum file has no checksum for the selected package.');return hash;
}
// The offer is an unforgeable in-process result of checkGitHubRelease; callers must obtain Y first.
export async function installGitHubRelease(offer,{confirmed=false,stateDir,signal,stageImpl=stageUpdate,installImpl=installStagedUpdate,...installOptions}={}){
  const known=offers.get(offer);if(confirmed!==true||!known)throw new Error('Confirm a checked GitHub release before updating.');
  signal?.throwIfAborted();const requestSignal=deadline(signal,120000);
  const response=await request(`https://api.github.com/repos/${offer.repository}/releases/${offer.releaseId}`,{fetchImpl:known.fetchImpl,signal:requestSignal});
  const raw=await bytes(response,MAX_METADATA,requestSignal);let release;try{release=JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(raw));}catch{throw new Error('GitHub release metadata is invalid.');}
  const fresh=releaseRecord(release,{repository:offer.repository,...known});
  if(fresh.version!==offer.version||fresh.releaseId!==offer.releaseId||!fresh.installable||JSON.stringify(fresh.asset)!==JSON.stringify(offer.asset)||JSON.stringify(fresh.checksums)!==JSON.stringify(offer.checksums))throw new Error('GitHub release changed after the offer. Check again before updating.');
  const sumsResponse=await request(offer.checksums.url,{fetchImpl:known.fetchImpl,signal:requestSignal,accept:'application/octet-stream',redirects:true});
  const sums=await bytes(sumsResponse,MAX_SUMS,requestSignal);
  if(sums.length!==offer.checksums.size||offer.checksums.sha256&&createHash('sha256').update(sums).digest('hex')!==offer.checksums.sha256)throw new Error('GitHub release checksum asset failed its size or digest check.');
  const sha256=checksum(sums,offer.asset.name);if(offer.asset.sha256&&offer.asset.sha256!==sha256)throw new Error('GitHub release package digest disagrees with SHA256SUMS.');
  const fetchPackage=async(url,options)=>{
    if(String(url)!==offer.asset.url)throw new Error('GitHub package download does not match the checked release.');
    return request(String(url),{fetchImpl:known.fetchImpl,signal:options.signal,accept:'application/octet-stream',redirects:true});
  };
  const staged=await stageImpl({source:offer.asset.url,sha256,stateDir,signal:requestSignal,maxBytes:offer.asset.size,fetchImpl:fetchPackage});
  if(staged.size!==offer.asset.size||staged.sha256!==sha256)throw new Error('GitHub release package failed its metadata integrity check.');
  signal?.throwIfAborted();return installImpl({...installOptions,stateDir,signal,expectedVersion:offer.version});
}
