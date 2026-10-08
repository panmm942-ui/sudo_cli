import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from './fixtures/temp-root.mjs';
import {createUpgradeCommands} from '../src/upgrades.mjs';

test('context review includes AI memory retained by clearing the visible chat',async t=>{
  const cwd=await mkdtemp(join(tmpdir(),'sudocli-context-memory-'));
  t.after(()=>rm(cwd,{recursive:true,force:true}));
  const notes=[],settings={},answers=['Remembered bicycle summary.','/end','0'];
  const replay={version:1,messages:[{role:'user',content:'The bicycle was blue.'}]};
  const commands=await createUpgradeCommands({cwd,stateDir:cwd,settings,
    history:{snapshot:()=>({version:1,messages:[]})},getContextSnapshot:()=>replay,
    note:text=>notes.push(text),ask:async()=>answers.shift()??'',
    getConnection:()=>({model:'fixture',baseUrl:'http://localhost/v1',transport:'chat-completions',contextWindow:16000}),
    reconnect:async()=>{}});
  await commands.handle({name:'/context',args:['status']});
  assert.match(notes.at(-1),/Archived messages: 1/);
  await commands.handle({name:'/context',args:['review']});
  assert.ok(notes.some(note=>note.includes('0: user')&&note.includes('bicycle')));
  assert.deepEqual(settings.contextReview.relevantIndices,[0]);
  assert.equal(settings.contextReview.sourceMessageCount,1);
});
