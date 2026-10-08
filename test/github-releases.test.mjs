import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {mkdtemp,rm,readFile} from 'node:fs/promises';
import {tmpdir} from './fixtures/temp-root.mjs';
import {join} from 'node:path';
import {checkGitHubRelease,installGitHubRelease,normalizeGitHubRepository,DEFAULT_GITHUB_REPOSITORY} from '../src/github-releases.mjs';
import {updateStatus} from '../src/verified-update.mjs';

const repository='owner/sudo_cli',tag='v0.6.4',name='codexcli-0.6.4-windows-x64.zip',packageBytes=Buffer.from('fixture archive bytes');
const digest=value=>createHash('sha256').update(value).digest('hex');
const sums=Buffer.from(`${digest(packageBytes)}  ${name}\n`);
function asset(name,id,size,hash){return{id,name,state:'uploaded',size,digest:hash?`sha256:${hash}`:null,browser_download_url:`https://github.com/${repository}/releases/download/${tag}/${name}`};}
function release(){return{id:42,tag_name:tag,html_url:`https://github.com/${repository}/releases/tag/${tag}`,draft:false,prerelease:false,assets:[asset(name,1,packageBytes.length,digest(packageBytes)),asset('codexcli-0.6.4-SHA256SUMS.txt',2,sums.length,digest(sums))]};}
function fixture({value=release(),checksumBytes=sums,assetReply,latestReply}={}){
  const calls=[];const fetchImpl=async(url,options)=>{calls.push({url:String(url),options});assert.equal(options.redirect,'manual');assert.equal(options.headers.Authorization,undefined);
    if(String(url).endsWith('/releases/latest'))return latestReply?latestReply():Response.json(value);
    if(String(url).endsWith('/releases/42'))return Response.json(value);
    if(String(url).endsWith('/codexcli-0.6.4-SHA256SUMS.txt'))return new Response(checksumBytes);
    if(String(url).endsWith(`/${name}`))return assetReply?assetReply():new Response(packageBytes);
    throw new Error('Unexpected request with fixture private information');
  };return{calls,fetchImpl,value};
}
const check=options=>checkGitHubRelease({repository,currentVersion:'0.6.3',platform:'win32',arch:'x64',...options});
function installers(){const stages=[],installs=[];return{stages,installs,stageImpl:async options=>{stages.push(options);return{size:packageBytes.length,sha256:digest(packageBytes)};},installImpl:async options=>{installs.push(options);return{version:options.expectedVersion};}};}

test('startup checks only bounded release metadata and selects the exact platform archive',async()=>{
  const f=fixture(),offer=await check(f);assert.equal(offer.status,'available');assert.equal(offer.installable,true);assert.equal(offer.version,'0.6.4');assert.equal(offer.asset.name,name);assert.equal(Object.isFrozen(offer),true);
  assert.equal(f.calls.length,1);assert.equal(f.calls[0].url,`https://api.github.com/repos/${repository}/releases/latest`);assert.equal(f.calls[0].options.method,'GET');assert.equal(f.calls[0].options.signal instanceof AbortSignal,true);
});

test('the user-selected public repository is the default, while an explicit empty repository disables discovery',async()=>{
  const calls=[];await checkGitHubRelease({currentVersion:'0.6.3',fetchImpl:async url=>{calls.push(String(url));return new Response(null,{status:404});}});
  assert.equal(DEFAULT_GITHUB_REPOSITORY,'panmm942-ui/sudo_cli');assert.equal(calls[0],`https://api.github.com/repos/${DEFAULT_GITHUB_REPOSITORY}/releases/latest`);
  assert.equal((await checkGitHubRelease({repository:null,fetchImpl:()=>assert.fail('unconfigured must not request')})).status,'unconfigured');
});

test('versions compare numerically and equal or older releases do not offer installation',async()=>{
  for(const currentVersion of ['0.6.4','0.7.0','1.0.0'])assert.equal((await check({...fixture(),currentVersion})).status,'current');
  const value=release();value.tag_name='v0.10.0';value.html_url=`https://github.com/${repository}/releases/tag/v0.10.0`;value.assets=[];
  assert.equal((await check({...fixture({value}),currentVersion:'0.9.9'})).status,'available');
});

test('source fallback is supported without accidentally selecting another architecture portable archive',async()=>{
  const value=release();value.assets.push(asset('codexcli-0.6.4-cross-platform.zip',3,packageBytes.length,digest(packageBytes)));
  for(const [platform,arch] of [['win32','arm64'],['linux','x64'],['linux','arm64'],['darwin','arm64']]){const offer=await check({...fixture({value}),platform,arch});assert.equal(offer.asset.name,'codexcli-0.6.4-cross-platform.zip');}
  const unsupported=await check({...fixture({value}),platform:'freebsd'});assert.equal(unsupported.status,'available');assert.equal(unsupported.installable,false);
});

test('a newer release without compatible package and checksum assets stays visible but cannot install',async()=>{
  for(const assets of [[],[release().assets[0]],[release().assets[1]]]){const value=release();value.assets=assets;const result=await check(fixture({value}));assert.equal(result.status,'available');assert.equal(result.installable,false);}
});

test('repository and installed version validation prevents unintended endpoints',async()=>{
  for(const value of ['https://github.com/o/r','owner/repo/extra','../secret','a/b.git','a/..','a/b?secret','a/b\n','a:/b']){assert.throws(()=>normalizeGitHubRepository(value));assert.equal((await check({repository:value,fetchImpl:()=>assert.fail('invalid repository must not request')})).status,'unavailable');}
  assert.equal((await check({currentVersion:'0.6.3-beta',fetchImpl:()=>assert.fail('invalid version must not request')})).status,'unavailable');
});

test('GitHub repository names are case insensitive while release tags and asset filenames remain exact',async()=>{
  const offer=await check({...fixture(),repository:'OWNER/SUDO_CLI'});assert.equal(offer.status,'available');assert.equal(offer.installable,true);
  const value=release();value.assets[0].browser_download_url=value.assets[0].browser_download_url.replace(name,name.toUpperCase());assert.equal((await check(fixture({value}))).status,'unavailable');
});

test('draft, prerelease and invalid semantic tags cannot offer an update',async()=>{
  for(const patch of [{draft:true},{prerelease:true},{tag_name:'v01.2.3'},{tag_name:'v1.2.3-beta'},{tag_name:'v999999999999999999.0.0'},{assets:{}},{id:0}]){const value={...release(),...patch};assert.equal((await check(fixture({value}))).status,'unavailable');}
});

test('release and selected asset URLs are pinned to HTTPS repository, tag and filename',async()=>{
  for(const url of ['https://evil.example/private?key=secret','http://github.com/owner/sudo_cli/releases/download/v0.6.4/'+name,`https://user:secret@github.com/${repository}/releases/download/${tag}/${name}`,`https://github.com/other/repo/releases/download/${tag}/${name}`,`https://github.com/${repository}/releases/download/v0.6.5/${name}`,`https://github.com/${repository}/releases/download/${tag}/${name}#secret`]){
    const value=release();value.assets[0].browser_download_url=url;const result=await check(fixture({value}));assert.equal(result.status,'unavailable');assert.equal(result.reason.includes('secret'),false);
  }
  const value=release();value.html_url='https://github.com/other/repo/releases/tag/v0.6.4';assert.equal((await check(fixture({value}))).status,'unavailable');
});

test('duplicate selected assets, invalid upload state, oversized files and bad digests fail closed',async()=>{
  for(const patch of [{state:'new'},{size:0},{size:512*1024*1024+1},{id:0},{digest:'md5:secret'}]){const value=release();Object.assign(value.assets[0],patch);assert.equal((await check(fixture({value}))).status,'unavailable');}
  const value=release();value.assets.push(value.assets[0]);assert.equal((await check(fixture({value}))).status,'unavailable');
});

test('HTTP failures, invalid JSON, response size limits and network errors keep startup usable without leaking details',async()=>{
  for(const status of [404,403,429,500])assert.equal((await check(fixture({latestReply:()=>new Response(null,{status})}))).status,'unavailable');
  for(const latestReply of [()=>new Response('invalid json'),()=>new Response('x'.repeat(512*1024+1)),()=>{throw new Error('private-token-secret');}]){const result=await check(fixture({latestReply}));assert.equal(result.status,'unavailable');assert.equal(result.reason.includes('private-token-secret'),false);}
  const redirected=fixture({latestReply:()=>new Response(null,{status:302,headers:{location:'https://evil.example/'}})});assert.equal((await check(redirected)).status,'unavailable');assert.equal(redirected.calls.length,1);
});

test('metadata timeout is bounded even when an injected client ignores the abort signal',async()=>{
  const keepAlive=setTimeout(()=>{},500);try{const start=Date.now();const result=await check({fetchImpl:()=>new Promise(()=>{}),timeoutMs:100});assert.equal(result.status,'unavailable');assert.match(result.reason,/timed out/i);assert.ok(Date.now()-start<1000);}finally{clearTimeout(keepAlive);}
});

test('explicit cancellation propagates and does not become a success or an ordinary check failure',async()=>{
  const abort=new AbortController();abort.abort(new Error('fixture canceled'));
  await assert.rejects(check({signal:abort.signal,fetchImpl:()=>assert.fail('canceled must not request')}),/fixture canceled/);
});

test('no checksum or archive is downloaded before explicit confirmation and forged offers are refused',async()=>{
  const f=fixture(),offer=await check(f);await assert.rejects(installGitHubRelease(offer),/confirm/i);await assert.rejects(installGitHubRelease({...offer},{confirmed:true}),/confirm/i);assert.equal(f.calls.length,1);
});

test('confirmed installation refreshes the same release and passes its verified hash and exact version to the existing updater',async()=>{
  const f=fixture(),offer=await check(f),i=installers();const result=await installGitHubRelease(offer,{confirmed:true,...i,stateDir:'fixture-state',currentRoot:'fixture-root'});
  assert.equal(result.version,'0.6.4');assert.equal(f.calls.length,3);assert.equal(f.calls[1].url,`https://api.github.com/repos/${repository}/releases/42`);
  assert.equal(i.stages.length,1);assert.equal(i.stages[0].source,offer.asset.url);assert.equal(i.stages[0].sha256,digest(packageBytes));assert.equal(i.stages[0].maxBytes,packageBytes.length);
  assert.equal(i.installs[0].expectedVersion,'0.6.4');assert.equal(i.installs[0].currentRoot,'fixture-root');
});

test('changed release asset metadata after confirmation is refused before downloading or staging',async()=>{
  const f=fixture(),offer=await check(f),i=installers();f.value.assets[0].size++;
  await assert.rejects(installGitHubRelease(offer,{confirmed:true,...i}),/changed/i);assert.equal(f.calls.length,2);assert.equal(i.stages.length,0);
});

test('checksum digest, missing entries, duplicate entries and disagreement with asset digest are refused',async()=>{
  const variants=[Buffer.from('not a checksum\n'),Buffer.from(`${'0'.repeat(64)}  ${name}\n`),Buffer.from(`${digest(packageBytes)}  another.zip\n`),Buffer.concat([sums,sums]),Buffer.from(`${digest(packageBytes)}  ../escape.zip\n`)];
  for(const checksumBytes of variants){const value=release();value.assets[1].size=checksumBytes.length;value.assets[1].digest=`sha256:${digest(checksumBytes)}`;const f=fixture({value,checksumBytes}),offer=await check(f),i=installers();await assert.rejects(installGitHubRelease(offer,{confirmed:true,...i}),/checksum|digest/i);assert.equal(i.stages.length,0);}
  const f=fixture({checksumBytes:Buffer.from(sums.toString().replace(/[a-f0-9]/,'0'))}),offer=await check(f);await assert.rejects(installGitHubRelease(offer,{confirmed:true,...installers()}),/digest|size/i);
});

test('real staging accepts an official GitHub asset redirect, verifies bytes and leaves installation to the verifier',async t=>{
  const stateDir=await mkdtemp(join(tmpdir(),'codexcli-github-stage-'));t.after(()=>rm(stateDir,{recursive:true,force:true}));
  const f=fixture({assetReply:()=>new Response(null,{status:302,headers:{location:'https://release-assets.githubusercontent.com/github-production-release-asset/1/package.zip?signature=private-signed-value'}})});
  const original=f.fetchImpl;f.fetchImpl=async(url,options)=>String(url).startsWith('https://release-assets.githubusercontent.com/')?new Response(packageBytes):original(url,options);
  const offer=await check(f);let installation;
  await installGitHubRelease(offer,{confirmed:true,stateDir,installImpl:async options=>{installation=options;return{version:options.expectedVersion};}});
  const staged=await updateStatus({stateDir});assert.deepEqual(await readFile(staged.path),packageBytes);assert.equal(staged.sha256,digest(packageBytes));assert.equal(installation.expectedVersion,'0.6.4');
});

test('asset redirects to HTTP, credentials, arbitrary hosts or loops are refused before installation',async t=>{
  const stateDir=await mkdtemp(join(tmpdir(),'codexcli-github-refused-'));t.after(()=>rm(stateDir,{recursive:true,force:true}));
  for(const location of ['http://release-assets.githubusercontent.com/package.zip','https://user:secret@release-assets.githubusercontent.com/package.zip','https://evil.example/package.zip',`https://github.com/${repository}/releases/download/${tag}/${name}`]){
    const f=fixture({assetReply:()=>new Response(null,{status:302,headers:{location}})}),offer=await check(f);let installs=0;
    await assert.rejects(installGitHubRelease(offer,{confirmed:true,stateDir,installImpl:async()=>{installs++;}}),error=>/redirect|trusted/i.test(error.message)&&!error.message.includes('secret'));
    assert.equal(installs,0);assert.ok(f.calls.length<=8);assert.equal(f.calls.some(call=>call.url.startsWith('https://evil.example')),false);
  }
});

test('real staging rejects package hash mismatch and preserves the active command',async t=>{
  const stateDir=await mkdtemp(join(tmpdir(),'codexcli-github-bad-hash-'));t.after(()=>rm(stateDir,{recursive:true,force:true}));
  const f=fixture({assetReply:()=>new Response(Buffer.alloc(packageBytes.length,'!'))}),offer=await check(f);let installs=0;
  await assert.rejects(installGitHubRelease(offer,{confirmed:true,stateDir,installImpl:async()=>{installs++;}}),/hash mismatch/i);assert.equal(installs,0);assert.equal(await updateStatus({stateDir}),undefined);
});
