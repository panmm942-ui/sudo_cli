import test from 'node:test';
import assert from 'node:assert/strict';
import {startBrowserMcp,validateBrowserOrigins} from '../src/browser-adapter.mjs';
test('browser origins require explicit HTTP origins and refuse URL credentials',()=>{
  assert.deepEqual(validateBrowserOrigins(['https://example.com']),['https://example.com']);
  assert.throws(()=>validateBrowserOrigins(['https://secret@example.com']),/origin/i);
  assert.throws(()=>validateBrowserOrigins(['file:///etc/passwd']),/origin/i);
});
test('browser adapter exposes real MCP tools and enforces origin before touching CDP',async t=>{
  const events=[];const browser={async command(method,params){events.push({method,params});if(method==='Page.captureScreenshot')return {data:Buffer.from('image').toString('base64')};if(method==='Runtime.evaluate')return {result:{value:'page text'}};return {};},async stop(){}};
  const adapter=await startBrowserMcp({browser,origins:['https://example.com'],policy:()=>({webAccess:true,permissions:'allow-everything'})});t.after(()=>adapter.stop());
  const call=async(name,args)=>{const r=await fetch(adapter.url,{method:'POST',headers:{'content-type':'application/json',authorization:`Bearer ${adapter.token}`},body:JSON.stringify({jsonrpc:'2.0',id:1,method:'tools/call',params:{name,arguments:args}})});return r.json();};
  const bad=await call('browser_navigate',{url:'https://outside.example/'});assert.equal(bad.result.isError,true);assert.equal(events.length,0);
  const good=await call('browser_navigate',{url:'https://example.com/'});assert.equal(good.result.isError,undefined);assert.equal(events.at(-1).method,'Page.navigate');
  const unauthorized=await fetch(adapter.url,{method:'POST',body:'{}'});assert.equal(unauthorized.status,401);
});
test('Web Off and declined browser approvals prevent all tool actions',async t=>{
  let count=0;const adapter=await startBrowserMcp({browser:{async command(){count++;},async stop(){}},origins:['https://example.com'],policy:()=>({webAccess:false,permissions:'ask'}),approve:async()=>false});t.after(()=>adapter.stop());
  const r=await fetch(adapter.url,{method:'POST',headers:{authorization:`Bearer ${adapter.token}`},body:JSON.stringify({jsonrpc:'2.0',id:1,method:'tools/call',params:{name:'browser_read',arguments:{}}})});assert.equal((await r.json()).result.isError,true);assert.equal(count,0);
});
test('changing policy while an approval is pending prevents the approved action',async t=>{
  let count=0,allow,started;const pending=new Promise(resolve=>{started=resolve;}),settings={webAccess:true,permissions:'ask'};
  const adapter=await startBrowserMcp({browser:{async command(){count++;},async stop(){}},origins:['https://example.com'],policy:()=>settings,approve:async()=>{started();return new Promise(resolve=>{allow=resolve;});}});t.after(()=>adapter.stop());
  const result=fetch(adapter.url,{method:'POST',headers:{authorization:`Bearer ${adapter.token}`},body:JSON.stringify({jsonrpc:'2.0',id:1,method:'tools/call',params:{name:'browser_read',arguments:{}}})});await pending;settings.webAccess=false;allow(true);assert.equal((await(await result).json()).result.isError,true);assert.equal(count,0);
});
