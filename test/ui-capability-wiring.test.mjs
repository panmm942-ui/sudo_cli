import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,readFile,rm} from 'node:fs/promises';
import {join} from 'node:path';
import {createServer} from 'node:http';
import {once} from 'node:events';
import {tmpdir} from './fixtures/temp-root.mjs';
import {trackNativeFixture} from './fixtures/native-cleanup.mjs';
import {createModelProfiles} from '../src/model-profiles.mjs';
import {createPrivateRecord} from '../src/private-state.mjs';
import {credentialIdentity} from '../src/credential-vault.mjs';
import {startBridge} from '../src/bridge.mjs';
import {startResponsesMonitor} from '../src/responses-monitor.mjs';

// Run the current UI's connection metadata merge and transport startup branch.
// Both transports and their loopback HTTP requests are real; terminal/native
// startup and user state are outside this narrowly scoped caller fixture.
const source=(await readFile(new URL('../src/ui.mjs',import.meta.url),'utf8')).replace(/\r\n/g,'\n');
const extract=(start,end)=>{const first=source.indexOf(start),last=source.indexOf(end,first);assert.ok(first>=0&&last>first,'Current UI connection branch is unavailable.');return source.slice(first,last);};
const merge=extract('    const identity=credentialIdentity(selected);','    const nextEffort=');
const startup=extract('    let baseUrl = selected.baseUrl;','    checkStartup();\n    const args');
const connect=new Function('selected','settings','credentialIdentity','startBridge','startResponsesMonitor',`return (async()=>{
  const env={},secrets=[],metrics=()=>{},requestHooks=undefined,policyError=()=>{};
  let bridge,connection=selected;
  ${merge}${startup}
  return {bridge,selected};
})()`);

for(const transport of ['chat-completions','responses'])test(`UI ${transport} keeps a persisted parallel-call setting scoped to the selected AI`,async t=>{
  const directory=await mkdtemp(join(tmpdir(),'sudocli-ui-capability-')),requests=[],bridges=[];
  const server=createServer(async(req,res)=>{
    let raw='';for await(const chunk of req)raw+=chunk;requests.push(JSON.parse(raw));
    res.writeHead(200,{'content-type':'application/json'});
    res.end(transport==='chat-completions'?JSON.stringify({id:'ui-chat',object:'chat.completion',choices:[{index:0,message:{role:'assistant',content:'UI capability fixture completed.'},finish_reason:'stop'}]}):JSON.stringify({id:'ui-response',object:'response',status:'completed',output:[{type:'message',id:'ui-item',role:'assistant',content:[{type:'output_text',text:'UI capability fixture completed.',annotations:[]}]}]}));
  });
  server.listen(0,'127.0.0.1');await once(server,'listening');
  trackNativeFixture(t,{server,cleanup:async()=>{await Promise.all(bridges.map(bridge=>bridge.close()));await rm(directory,{recursive:true,force:true});}});
  const baseUrl=`http://127.0.0.1:${server.address().port}/v1`,profiles=await createModelProfiles({stateDir:directory});
  const first={name:'Unsupported parallel calls',model:'first-model',transport,baseUrl,capabilities:{tools:true}};
  await profiles.save(first);await profiles.save({...first,name:'Default parallel calls',model:'second-model'});
  const record=await createPrivateRecord({directory:join(directory,'configuration'),filename:'fixture.json'});
  await record.write({capabilityByIdentity:{[credentialIdentity(first)]:{tools:true,parallelToolCalls:false}}});
  const settings=await record.read();
  for(const name of [first.name,'Default parallel calls',first.name]){
    const {bridge,selected}=await connect(await profiles.get(name),settings,credentialIdentity,startBridge,startResponsesMonitor);bridges.push(bridge);
    const response=await fetch(`${bridge.baseUrl}/responses`,{method:'POST',headers:{authorization:`Bearer ${bridge.token}`,'content-type':'application/json'},body:JSON.stringify({model:selected.model,input:'Reply with the fixture confirmation.',stream:false,tools:[{type:'function',name:'exec_command',parameters:{type:'object'}}],parallel_tool_calls:true})});
    assert.equal(response.status,200);
    assert.match(await response.text(),/UI capability fixture completed\./);
    const outgoing=requests.at(-1);
    assert.equal(Object.hasOwn(outgoing,'parallel_tool_calls'),selected.model==='second-model');
    if(selected.model==='second-model')assert.equal(outgoing.parallel_tool_calls,true);
    assert.equal(outgoing.tools.length,1);
    assert.equal(transport==='responses'?outgoing.tools[0].name:outgoing.tools[0].function.name,'exec_command');
  }
  assert.deepEqual(requests.map(request=>request.model),['first-model','second-model','first-model']);
});
