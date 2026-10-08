import test from 'node:test';
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {once} from 'node:events';
import {startBridge} from '../src/bridge.mjs';
import {startResponsesMonitor} from '../src/responses-monitor.mjs';

async function fixture(t,transport,initialPolicy){
  const requests=[];let policy=initialPolicy;
  const upstream=createServer(async(req,res)=>{
    const chunks=[];for await(const chunk of req)chunks.push(chunk);
    requests.push(JSON.parse(Buffer.concat(chunks).toString('utf8')));
    res.setHeader('content-type','application/json');
    res.end(JSON.stringify(transport==='responses'?{object:'response',status:'completed',output:[],usage:{input_tokens:1,output_tokens:1}}:{choices:[{message:{role:'assistant',content:'ready'},finish_reason:'stop'}],usage:{prompt_tokens:1,completion_tokens:1}}));
  }).listen(0,'127.0.0.1');await once(upstream,'listening');
  const options={baseUrl:`http://127.0.0.1:${upstream.address().port}/v1`,model:'fixture',...(initialPolicy===null?{}:{reasoningPolicy:()=>policy})};
  const connection=await (transport==='responses'?startResponsesMonitor:startBridge)(options);
  t.after(async()=>{await connection.close();upstream.closeAllConnections();await new Promise(resolve=>upstream.close(resolve));});
  return {requests,setPolicy:value=>{policy=value;},post:body=>fetch(connection.baseUrl+'/responses',{method:'POST',headers:{'content-type':'application/json',authorization:'Bearer '+connection.token},body:JSON.stringify({model:'fixture',input:'task',stream:false,...body})})};
}

for(const transport of ['chat-completions','responses']){
  test(`${transport} provider default omits a native catalog effort and retains other reasoning options`,async t=>{
    const f=await fixture(t,transport,{effort:undefined});
    const response=await f.post({reasoning:{effort:'high',summary:'concise',future:'retained'}});await response.text();assert.equal(response.status,200);
    const sent=f.requests[0];
    if(transport==='responses')assert.deepEqual(sent.reasoning,{summary:'concise',future:'retained'});
    else assert.equal(Object.hasOwn(sent,'reasoning_effort'),false);
  });

  test(`${transport} user effort replaces the native catalog level and is resolved anew for each request`,async t=>{
    const f=await fixture(t,transport,{effort:'low',supportedEfforts:['low','adaptive']});
    for(const [policy,want] of [[{effort:'low',supportedEfforts:['low','adaptive']},'low'],[{effort:'adaptive',supportedEfforts:['adaptive']},'adaptive'],[{effort:undefined},undefined]]){
      f.setPolicy(policy);const response=await f.post({reasoning:{effort:'high'}});await response.text();assert.equal(response.status,200);
      const sent=f.requests.at(-1);
      assert.equal(transport==='responses'?sent.reasoning?.effort:sent.reasoning_effort,want);
    }
  });

  test(`${transport} refuses unsupported user effort before contacting the model endpoint`,async t=>{
    const f=await fixture(t,transport,{effort:'adaptive'});
    for(const policy of [{effort:'adaptive'},{effort:'high',supportedEfforts:['low']},{effort:'high',capabilities:{reasoning:false}}]){
      f.setPolicy(policy);const response=await f.post({reasoning:{effort:'medium'}});await response.text();assert.equal(response.status,400);
      assert.equal(f.requests.length,0);
    }
  });

  test(`${transport} reasoning policy does not turn malformed native reasoning into a valid request`,async t=>{
    const f=await fixture(t,transport,{effort:undefined});
    for(const reasoning of [null,[],42,'high',{effort:null},{effort:'high\ninvalid'}]){
      const response=await f.post({reasoning});await response.text();assert.equal(response.status,400);assert.equal(f.requests.length,0);
    }
  });

  test(`${transport} absent reasoning policy preserves the public transport's native effort`,async t=>{
    const f=await fixture(t,transport,null),response=await f.post({reasoning:{effort:'high'}});await response.text();assert.equal(response.status,200);
    assert.equal(transport==='responses'?f.requests[0].reasoning.effort:f.requests[0].reasoning_effort,'high');
  });
}
