import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm,writeFile,readFile} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {createHash} from 'node:crypto';
import {createAgentCommands} from '../src/agent-commands.mjs';
import {createModelProfiles} from '../src/model-profiles.mjs';
import {createPersonalization} from '../src/personalization.mjs';

async function fixture(t,{answers=[],runAgents}={}){
  const cwd=await mkdtemp(join(tmpdir(),'sudo-agent-commands-'));t.after(()=>rm(cwd,{recursive:true,force:true}));
  const stateDir=join(cwd,'state'),profiles=await createModelProfiles({stateDir}),personalization=await createPersonalization({stateDir});
  const connection={model:'current-model',baseUrl:'http://127.0.0.1:1234/v1',transport:'chat-completions'};
  const settings={scope:'project',permissions:'ask',webAccess:true,effort:'high'},messages=[],questions=[],calls=[],saved=[],checkpoints=[];
  const workflow={snapshot:()=>({mode:'edit',active:false,activeAgents:[]}),cancelAgent:()=>false,steerAgent:async()=>false,runAgents:async options=>{calls.push(options);return runAgents?runAgents(options):{task:options.task,status:'completed',results:options.agents.map(agent=>({name:agent.name,role:agent.role,mode:agent.mode,model:agent.connection.model,status:'completed',text:'advisory fixture',verified:false}))};}};
  const commands=await createAgentCommands({cwd,stateDir,settings,profiles,personalization,workflow,note:text=>messages.push(text),ask:async(prompt,hidden)=>{questions.push({prompt,hidden});return answers.shift()||'';},getConnection:()=>connection,loadCredential:async()=>undefined,extraInstructions:async()=> 'User-approved project memory.',onResult:async record=>saved.push(record),workspace:{stateDir,beginCheckpoint:async()=>{checkpoints.push('begin');return{id:'checkpoint'};},completeCheckpoint:async()=>{checkpoints.push('complete');}},runOperation:async(_label,fn)=>fn(new AbortController().signal)});
  return {cwd,commands,profiles,personalization,settings,messages,questions,calls,saved,checkpoints,connection};
}

test('parallel specialists use their saved AIs and each AI’s own preferences without a local key prompt',async t=>{
  const f=await fixture(t);await f.profiles.save({name:'Local reviewer',model:'local-review',baseUrl:'http://localhost:8000/v1',transport:'chat-completions'});
  await f.personalization.save(f.connection,{enabled:true,persona:'Current persona',preferences:{tone:'calm'}});
  await f.personalization.save(await f.profiles.get('Local reviewer'),{enabled:true,persona:'Reviewer persona',preferences:{language:'Greek'}});
  await f.commands.presets.save({name:'Audit',role:'reviewer',mode:'review',instructions:'Review errors.',profileName:'Local reviewer'});
  await f.commands.handle({name:'/agents',args:['team','planner,Audit','Find','bugs']});
  assert.equal(f.calls.length,1);assert.equal(f.calls[0].agents.length,2);assert.equal(f.calls[0].agents[1].connection.model,'local-review');
  assert.match(f.calls[0].agents[0].developerInstructions,/Current persona/);assert.match(f.calls[0].agents[1].developerInstructions,/Reviewer persona/);assert.doesNotMatch(f.calls[0].agents[1].developerInstructions,/Current persona/);
  assert.equal(f.questions.some(q=>q.hidden),false);assert.equal(f.saved.length,1);assert.equal(f.saved[0].verified,false);
});
test('read-only policy refuses coding agents before making a model call',async t=>{
  const f=await fixture(t);f.settings.scope='read-only';
  await assert.rejects(f.commands.handle({name:'/agents',args:['run','coder','Change','code']}),/read-only/i);assert.equal(f.calls.length,0);
});
test('pipeline plans first, gives proposed coder changes to independent reviewers, and never applies them',async t=>{
  const proposal={files:[{path:'example.txt',kind:'added',beforeHash:null,beforeContent:null,afterHash:createHash('sha256').update('proposal').digest('hex'),content:Buffer.from('proposal').toString('base64'),bytes:8,mode:420}],skipped:[],partial:false};
  const f=await fixture(t,{runAgents:async options=>({task:options.task,status:'completed',results:options.agents.map(agent=>({name:agent.name,role:agent.role,mode:agent.mode,status:'completed',model:agent.connection.model,text:agent.role==='planner'?'Plan from source':'Findings',...(agent.mode==='edit'?{changes:proposal}:{}),verified:false}))})});
  await f.commands.handle({name:'/agents',args:['pipeline','Build','example']});
  assert.deepEqual(f.calls.map(c=>c.agents.map(a=>a.role)),[['planner'],['coder'],['tester','reviewer']]);assert.match(f.calls[1].task,/Plan from source/);assert.deepEqual(f.calls[2].agents[0].inputChanges,proposal);
  await assert.rejects(readFile(join(f.cwd,'example.txt')),{code:'ENOENT'});assert.equal(f.checkpoints.length,0);assert.equal(f.saved.length,1);
});
test('failed planning stops the coding pipeline and records the failure honestly',async t=>{
  const f=await fixture(t,{runAgents:async options=>({task:options.task,status:'failed',results:[{name:'planner',role:'planner',mode:'review',status:'failed',model:'fixture',text:'',error:'Connection failed',verified:false}]})});
  await f.commands.handle({name:'/agents',args:['pipeline','Build','example']});assert.equal(f.calls.length,1);assert.equal(f.saved.length,1);assert.equal(f.saved[0].status,'failed');
});
test('applying a saved coding proposal preserves later human edits and records a checkpoint',async t=>{
  const {captureAgentWorkspace,diffAgentWorkspace}=await import('../src/agent-changes.mjs');const f=await fixture(t);
  await writeFile(join(f.cwd,'example.txt'),'base');const before=await captureAgentWorkspace({cwd:f.cwd,excludePaths:[join(f.cwd,'state')]});await writeFile(join(f.cwd,'example.txt'),'proposal');const after=await captureAgentWorkspace({cwd:f.cwd,excludePaths:[join(f.cwd,'state')]});const changes=diffAgentWorkspace(before,after);
  const result=await f.commands.results.save({task:'Change example',status:'completed',results:[{name:'coder',role:'coder',mode:'edit',model:'fixture',status:'completed',text:'Changes proposed',changes,verified:false}]});
  await writeFile(join(f.cwd,'example.txt'),'human change');await f.commands.handle({name:'/agents',args:['apply',result.id,'coder']});
  assert.equal(await readFile(join(f.cwd,'example.txt'),'utf8'),'human change');assert.deepEqual(f.checkpoints,['begin','complete']);assert.match(f.messages.join('\n'),/conflict|changed/i);assert.equal(f.settings.lastVerification.status,'Needs review');
});
test('stop and status are handled during work without model requests',async t=>{
  const f=await fixture(t);let stopped;
  await f.commands.handle({name:'/agents',args:['status']});await f.commands.handle({name:'/agents',args:['stop','planner']});assert.equal(f.calls.length,0);assert.match(f.messages.join('\n'),/active|running/i);
});
test('unknown agent steering is reported unavailable instead of claiming delivery',async t=>{
  const f=await fixture(t);await assert.rejects(f.commands.handle({name:'/agents',args:['steer','reviewer','Please focus']}),/active|available|running/i);assert.doesNotMatch(f.messages.join('\n'),/Guidance sent/);
});
test('specialists sharing a saved cloud AI reuse one in-memory key without persisting it',async t=>{
  const f=await fixture(t,{answers:['cloud-test-secret']});await f.profiles.save({name:'Cloud shared',model:'cloud-test',baseUrl:'https://model.example/v1',transport:'chat-completions'});
  for(const name of ['one','two'])await f.commands.presets.save({name,role:'reviewer',mode:'review',profileName:'Cloud shared',instructions:''});
  await f.commands.handle({name:'/agents',args:['team','one,two','Review']});// Two specialists, one model credential.
  await f.commands.handle({name:'/agents',args:['run','one','Again']});assert.equal(f.questions.filter(q=>q.hidden).length,1);
  assert.equal(f.calls[0].agents[1].connection.apiKey,'cloud-test-secret');assert.equal(f.calls[1].agents[0].connection.apiKey,'cloud-test-secret');
  assert.equal((await f.profiles.get('Cloud shared')).apiKey,undefined);
});
