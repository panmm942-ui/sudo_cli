import test from 'node:test';
import assert from 'node:assert/strict';
import {request} from 'node:http';

const snapshot={session:{connectedAI:'Local demo',working:false},chat:{messages:[{id:'one',role:'assistant',content:'<script>window.secret=true</script>',status:'completed'}]},events:[],currentPrompt:null,changes:{files:[],partial:false},commands:[],theme:{}};
async function fixture(t,options={}){
  const {startGuiServer}=await import('../src/gui-server.mjs');
  const actions=[];const server=await startGuiServer({getSnapshot:()=>snapshot,onAction:async action=>{actions.push(action);return {accepted:true};},...options});
  t.after(()=>server.close());const url=new URL(server.url),token=new URLSearchParams(url.hash.slice(1)).get('token');url.hash='';
  return {server,url,token,actions,headers:{authorization:`Bearer ${token}`,origin:url.origin,'content-type':'application/json'}};
}
function raw(url,{path='/api/state',headers={},method='GET',body}={}){return new Promise((resolve,reject)=>{const req=request(url,{path,method,headers},res=>{let text='';res.setEncoding('utf8');res.on('data',chunk=>text+=chunk);res.on('end',()=>resolve({status:res.statusCode,headers:res.headers,text}));});req.on('error',reject);req.end(body);});}

test('GUI serves a local shell but authenticates the actual shared state',async t=>{
  const {url,token,headers}=await fixture(t);assert.equal(url.hostname,'127.0.0.1');assert.ok(Number(url.port)>0);assert.match(token,/^[a-f0-9]{64}$/);
  const shell=await fetch(url);assert.equal(shell.status,200);assert.match(shell.headers.get('content-security-policy'),/frame-ancestors 'none'/);assert.equal(shell.headers.get('cache-control'),'no-store');assert.doesNotMatch(await shell.text(),/window.secret|Local demo|Bearer/);
  assert.equal((await fetch(new URL('/api/state',url))).status,401);
  const state=await fetch(new URL('/api/state',url),{headers});assert.equal(state.status,200);assert.deepEqual(await state.json(),snapshot);assert.equal(state.headers.get('access-control-allow-origin'),null);
});

test('GUI rejects rebinding hosts, foreign origins and cross-site fetches before invoking actions',async t=>{
  const {url,headers,actions}=await fixture(t);const body=JSON.stringify({type:'stop'});
  for(const extra of [{host:'evil.example'},{origin:'https://evil.example'},{origin:'null'},{'sec-fetch-site':'cross-site'}]){
    const response=await raw(url,{path:'/api/action',method:'POST',headers:{...headers,...extra},body});assert.equal(response.status,403);
  }
  assert.equal(actions.length,0);assert.equal((await fetch(new URL('/api/action',url),{method:'POST',headers:{authorization:headers.authorization,'content-type':'application/json'},body})).status,403);
});

test('GUI enforces the bounded action schema and preserves literal multiline text',async t=>{
  const {url,headers,actions}=await fixture(t);const post=body=>fetch(new URL('/api/action',url),{method:'POST',headers,body:JSON.stringify(body)});
  for(const body of [{type:'shell',text:'rm'},{type:'answer',text:'yes'},{type:'stop',apiKey:'private'},{type:'submit',text:''},{type:'submit',text:'x'.repeat(65537)}])assert.equal((await post(body)).status,400);
  assert.equal(actions.length,0);const response=await post({type:'submit',text:'/delete\nhttps://local.example/v1'});assert.equal(response.status,200);assert.deepEqual(actions,[{type:'submit',text:'/delete\nhttps://local.example/v1'}]);
  const huge=await fetch(new URL('/api/action',url),{method:'POST',headers,body:' '.repeat(131073)});assert.equal(huge.status,413);assert.equal(actions.length,1);
});

test('GUI delegates current prompt identity, stop and changes without exposing callback errors',async t=>{
  const seen=[];const {url,headers}=await fixture(t,{onAction:async action=>{seen.push(action);if(action.type==='answer')throw new Error('private-api-key-canary');return {diff:'<b>literal change</b>'};}});
  const post=async action=>fetch(new URL('/api/action',url),{method:'POST',headers,body:JSON.stringify(action)});
  const failure=await post({type:'answer',promptId:'current-id',text:'yes'});assert.equal(failure.status,409);assert.doesNotMatch(await failure.text(),/private-api-key-canary/);
  assert.equal((await post({type:'stop'})).status,200);const changes=await post({type:'changes',path:'src/file.mjs'});assert.deepEqual(await changes.json(),{result:{diff:'<b>literal change</b>'}});assert.deepEqual(seen.map(a=>a.type),['answer','stop','changes']);
});

test('GUI bounds snapshots and serves no arbitrary local file routes',async t=>{
  const {url,headers}=await fixture(t,{getSnapshot:()=>({chat:{messages:[{content:'x'.repeat(2*1024*1024)}]}})});
  assert.equal((await fetch(new URL('/api/state',url),{headers})).status,413);for(const path of ['/etc/passwd','/src/gui-server.mjs','/%2e%2e/package.json'])assert.equal((await raw(url,{path})).status,404);
});

test('return revokes the GUI only after delivering the controller response and close is idempotent',async t=>{
  const {server,url,headers,actions}=await fixture(t);const response=await fetch(new URL('/api/action',url),{method:'POST',headers,body:JSON.stringify({type:'return'})});assert.equal(response.status,200);await response.json();assert.deepEqual(actions,[{type:'return'}]);await server.close();await server.close();await assert.rejects(fetch(new URL('/api/state',url),{headers}));
});

test('a pending return refuses further mutations and a refused return leaves the view available',async t=>{
  let entered,release;const started=new Promise(resolve=>entered=resolve),held=new Promise(resolve=>release=resolve);const seen=[];
  const {url,headers}=await fixture(t,{onAction:async action=>{seen.push(action.type);if(action.type==='return'){entered();await held;throw new Error('private-return-error');}return {accepted:true};}});
  const post=action=>fetch(new URL('/api/action',url),{method:'POST',headers,body:JSON.stringify(action)}),returning=post({type:'return'});await started;
  let returned;try{assert.equal((await post({type:'stop'})).status,409);assert.deepEqual(seen,['return']);}finally{release();returned=await returning;}assert.equal(returned.status,409);assert.equal((await post({type:'stop'})).status,200);
});

test('GUI state failures and invalid credentials never expose callback details',async t=>{
  const {url,headers}=await fixture(t,{getSnapshot:()=>{throw new Error('private-state-canary');}});
  const wrong=await fetch(new URL('/api/state',url),{headers:{...headers,authorization:'Bearer '+'0'.repeat(64)}});assert.equal(wrong.status,401);
  const failed=await fetch(new URL('/api/state',url),{headers});assert.equal(failed.status,503);assert.doesNotMatch(await failed.text(),/private-state-canary/);
  assert.equal((await fetch(new URL('/api/state?token=secret',url),{headers})).status,404);
});
