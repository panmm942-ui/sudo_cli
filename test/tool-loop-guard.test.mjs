import test from 'node:test';
import assert from 'node:assert/strict';
import {createToolLoopGuard} from '../src/tool-loop-guard.mjs';

const user={type:'message',role:'user',content:'Fix the disposable project.'};
function pair(id,{name='read_file',namespace,args={path:'file.mjs'},result='file content',custom=false}={}){return[{type:custom?'custom_tool_call':'function_call',call_id:id,name,...(namespace?{namespace}:{}),...(custom?{input:typeof args==='string'?args:JSON.stringify(args)}:{arguments:typeof args==='string'?args:JSON.stringify(args)})},{type:custom?'custom_tool_call_output':'function_call_output',call_id:id,output:result}];}
function fixture(options){const guard=createToolLoopGuard(options),input=[user];guard.inspect(input);let number=0;return{guard,input,next(value){input.push(...pair(`call-${number++}`,value));return guard.inspect(input);}};}
const repeated=error=>error.code==='TOOL_LOOP_REPEATED'&&/repeated|repeat/i.test(error.message);

test('four newly completed identical actions stop before another model request',()=>{
  const f=fixture();for(let i=0;i<3;i++)f.next();assert.throws(()=>f.next(),repeated);
});

test('two-tool and three-tool consecutive cycles stop at the configured repeat limit',()=>{
  for(const cycle of [[{name:'read_file'},{name:'run_tests'}],[{name:'read_file'},{name:'run_tests'},{name:'list_files'}]]){const f=fixture();for(let i=0;i<cycle.length*4-1;i++)f.next(cycle[i%cycle.length]);assert.throws(()=>f.next(cycle.at(-1)),repeated);}
});

test('old replayed history is seeded, and calls before the current user message do not count',()=>{
  const guard=createToolLoopGuard(),old=Array.from({length:8},(_,i)=>pair(`old-${i}`)).flat(),input=[{role:'user',content:'Old task'},...old,user];
  guard.inspect(input);guard.inspect(input);for(let i=0;i<3;i++){input.push(...pair(`new-${i}`));guard.inspect(input);}input.push(...pair('new-3'));assert.throws(()=>guard.inspect(input),repeated);
  const other=createToolLoopGuard();other.inspect([user]);assert.doesNotThrow(()=>other.inspect([...old,user]));
});

test('completed calls already present in the initial payload are not counted as new work',()=>{
  const guard=createToolLoopGuard(),input=[user,...Array.from({length:8},(_,i)=>pair(`initial-${i}`)).flat()];guard.inspect(input);guard.inspect(input);
  for(let i=0;i<3;i++){input.push(...pair(`new-${i}`));guard.inspect(input);}input.push(...pair('new-3'));assert.throws(()=>guard.inspect(input),repeated);
});

test('pending calls wait for their matching output, which is counted only once',()=>{
  const f=fixture();for(let i=0;i<3;i++){const [call,output]=pair(`pending-${i}`);f.input.push(call);f.guard.inspect(f.input);f.guard.inspect(f.input);f.input.push(output);f.guard.inspect(f.input);f.guard.inspect(f.input);}
  const [call,output]=pair('pending-3');f.input.push(call);assert.doesNotThrow(()=>f.guard.inspect(f.input));f.input.push({...output,call_id:'unmatched'});assert.doesNotThrow(()=>f.guard.inspect(f.input));f.input.push(output);assert.throws(()=>f.guard.inspect(f.input),repeated);
});

test('changing meaningful arguments or results avoids a false repeat decision',()=>{
  for(const change of [i=>({args:{path:`file-${i}.mjs`}}),i=>({result:`new file content ${i}`}),i=>({name:`tool_${i}`})]){const f=fixture();for(let i=0;i<20;i++)assert.doesNotThrow(()=>f.next(change(i)));}
});

test('canonical argument hashing ignores JSON whitespace and nested object key order while retaining array order',()=>{
  const f=fixture();for(let i=0;i<3;i++)f.next({args:i%2?' { "config": { "z": 1, "a": 2 }, "files": ["a", "b"] }':'{"files":["a","b"],"config":{"a":2,"z":1}}'});
  assert.throws(()=>f.next({args:'{"config":{"a":2,"z":1},"files":["a","b"]}'}),repeated);
  const distinct=fixture();for(let i=0;i<3;i++)distinct.next({args:{files:['a','b']}});assert.doesNotThrow(()=>distinct.next({args:{files:['b','a']}}));
});

test('intervening meaningful progress breaks a short repeated suffix',()=>{
  const f=fixture();f.next();f.next();f.next({result:'changed'});for(let i=0;i<3;i++)f.next();assert.throws(()=>f.next(),repeated);
});

test('native exec timing, chunk and token wrappers and output-yield limits do not disguise a repeat',()=>{
  const f=fixture();for(let i=0;i<3;i++)f.next({name:'exec_command',namespace:'functions',args:{cmd:'node --test',yield_time_ms:100+i,max_output_tokens:1000+i},result:`Chunk ID: volatile-${i}\r\nWall time: ${i}.1 seconds\r\nProcess exited with code 1\r\nOriginal token count: ${i+3}\r\nFinal output:\r\nsame failing test\r\n`});
  assert.throws(()=>f.next({name:'exec_command',namespace:'functions',args:{max_output_tokens:2000,cmd:'node --test',yield_time_ms:200},result:'Chunk ID: new\nWall time: 0.99 seconds\nProcess exited with code 1\nOriginal token count: 88\nFinal output:\nsame failing test\n'}),repeated);
});

test('exit code and real output content remain significant despite wrapper normalization',()=>{
  for(const change of [i=>`Process exited with code ${i}`,i=>`actual output ${i}`]){const f=fixture();for(let i=0;i<4;i++)assert.doesNotThrow(()=>f.next({name:'exec_command',result:`Chunk ID: ${i}\nWall time: 1 seconds\n${change(i)}\nFinal output:\n${i}`}));}
  const f=fixture();for(let i=0;i<4;i++)assert.doesNotThrow(()=>f.next({name:'exec_command',result:`Chunk ID: ${i}\nWall time: 1 seconds\nProcess exited with code 0\nFinal output:\nWall time: actual program output ${i}`}));
});

test('structured native wrapper fields normalize but preserved exit and output fields still identify progress',()=>{
  const f=fixture();for(let i=0;i<3;i++)f.next({name:'write_stdin',args:{session_id:42,chars:'',yield_time_ms:100+i,max_output_tokens:500+i},result:{chunk_id:String(i),wall_time_seconds:i,original_token_count:i+20,exit_code:1,output:'same failure'}});
  assert.throws(()=>f.next({name:'write_stdin',args:{chars:'',session_id:42,yield_time_ms:200,max_output_tokens:200},result:{chunk_id:'last',wall_time_seconds:99,original_token_count:99,exit_code:1,output:'same failure'}}),repeated);
});

test('yield arguments and timing-looking text stay significant for non-execution tools',()=>{
  const f=fixture();for(let i=0;i<4;i++)assert.doesNotThrow(()=>f.next({name:'read_file',args:{path:'file',yield_time_ms:i},result:`Wall time: ${i}\nreal content`}));
});

test('custom tool input and namespace identity are supported without flattening distinct tools',()=>{
  const f=fixture();for(let i=0;i<3;i++)f.next({name:'apply_patch',namespace:'functions',args:'*** Begin Patch\n*** End Patch',custom:true,result:'No files changed.'});assert.throws(()=>f.next({name:'apply_patch',namespace:'functions',args:'*** Begin Patch\n*** End Patch',custom:true,result:'No files changed.'}),repeated);
  const distinct=fixture();for(const namespace of ['first','second','third','fourth'])assert.doesNotThrow(()=>distinct.next({namespace}));
});

test('malformed function JSON remains comparable as literal text rather than hiding an error loop',()=>{
  const f=fixture();for(let i=0;i<3;i++)f.next({args:'{invalid',result:'Invalid tool arguments'});assert.throws(()=>f.next({args:'{invalid',result:'Invalid tool arguments'}),repeated);
});

test('literal invalid JSON does not collide with a valid object bearing the same literal field',()=>{
  const f=fixture();for(let i=0;i<3;i++)f.next({args:'{invalid',result:'Invalid tool arguments'});assert.doesNotThrow(()=>f.next({args:{literal:'{invalid'},result:'Invalid tool arguments'}));
});

test('nested tool output and arguments have a depth limit with a controlled error',()=>{
  let nested={value:'payload'};for(let i=0;i<140;i++)nested={inner:nested};
  for(const value of [{result:nested},{args:nested}]){const f=fixture();assert.throws(()=>f.next(value),error=>error.code==='TOOL_LOOP_HISTORY_LIMIT');}
});

test('turn reset seeds the next payload and permits the user to explicitly retry repeated work',()=>{
  const f=fixture();for(let i=0;i<3;i++)f.next();f.guard.reset();f.guard.inspect(f.input);for(let i=0;i<3;i++)f.next();assert.throws(()=>f.next(),repeated);
});

test('disabled guard bypasses all inspection and has no tool-loop intervention',()=>{
  const f=fixture({enabled:false});for(let i=0;i<40;i++)assert.doesNotThrow(()=>f.next());assert.doesNotThrow(()=>f.guard.inspect('native plain text'));assert.doesNotThrow(()=>f.guard.inspect(Array(10001).fill(user)));
});

test('bounds reject oversized input, IDs, retained IDs and invalid configuration with safe messages',()=>{
  for(const options of [{enabled:'yes'},{repeatLimit:1},{repeatLimit:11},{maxHistory:0},{maxHistory:10001}])assert.throws(()=>createToolLoopGuard(options),/invalid|limit|history/i);
  const guard=createToolLoopGuard({maxHistory:3});assert.throws(()=>guard.inspect(Array(4).fill(user)),error=>error.code==='TOOL_LOOP_HISTORY_LIMIT');
  const f=fixture();assert.throws(()=>f.guard.inspect([user,...pair('secret-id-'.repeat(40))]),error=>error.code==='TOOL_LOOP_INVALID'&&!error.message.includes('secret-id'));
  const small=createToolLoopGuard({maxHistory:2});small.inspect([user]);small.inspect([pair('a')[0]]);small.inspect([pair('b')[0]]);assert.throws(()=>small.inspect([pair('c')[0]]),error=>error.code==='TOOL_LOOP_HISTORY_LIMIT');
  assert.throws(()=>f.guard.inspect([user,...pair('large',{result:'x'.repeat(16*1024*1024)})]),error=>error.code==='TOOL_LOOP_HISTORY_LIMIT');
});

test('plain Responses input text and missing input are valid no-tool inputs',()=>{
  const guard=createToolLoopGuard();assert.doesNotThrow(()=>guard.inspect('A normal user prompt'));assert.doesNotThrow(()=>guard.inspect(undefined));assert.doesNotThrow(()=>guard.inspect([]));
});

test('guard objects expose no retained arguments, outputs or identifiers',()=>{
  const f=fixture();f.next({args:{path:'private-file-path'},result:'private-output-value'});assert.equal(JSON.stringify(f.guard),'{}');assert.doesNotMatch(Object.values(f.guard).map(String).join('\n'),/private-file-path|private-output-value|call-0/);
});
