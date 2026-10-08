import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from './fixtures/temp-root.mjs';
import {createChatStore} from '../src/chat-store.mjs';
import {createChatHistory} from '../src/chat-history.mjs';
import {createPromptLabels} from '../src/prompt-label.mjs';
import {restorePendingPrompts} from '../src/pending-prompts.mjs';

test('pending prompt metadata survives disk save with intervening commands',async t=>{
 const dir=await mkdtemp(join(tmpdir(),'pending-numbering-'));t.after(()=>rm(dir,{recursive:true,force:true}));
 const history=createChatHistory(),labels=createPromptLabels();
 const first=labels.submit();history.recordSubmission(first);history.addUser('first',first);
 const pending=labels.submit();history.recordSubmission(pending);
 history.recordSubmission(labels.submit()); // /notify, accepted after the queued input
 const store=await createChatStore({stateDir:dir,cwd:dir});
 const saved=await store.create({history:history.snapshot(),pendingInputs:['queued'],pendingSubmissions:[{sequence:pending.sequence,timestamp:pending.timestamp,literal:false}]});
 const record=await store.get(saved.id);history.restore(record.history);labels.restore(history.snapshot());
 const queue=restorePendingPrompts({record,history,labels});
 assert.equal(queue[0].promptMeta.sequence,2);assert.equal(queue[0].literal,false);
 assert.equal(queue[0].promptMeta.timestamp,pending.timestamp);assert.equal(labels.next().sequence,4);
 await assert.rejects(store.save({id:saved.id,history:history.snapshot(),pendingInputs:['queued'],pendingSubmissions:[{sequence:100,literal:true}]}),/pending|queued|submission/i);
});

test('legacy queued inputs receive distinct fresh numbers without losing the visible conversation',()=>{
 const history=createChatHistory(),labels=createPromptLabels();history.addUser('old one');history.addUser('old two');labels.restore(history.snapshot());
 const queue=restorePendingPrompts({record:{pendingInputs:['pending one','pending two']},history,labels});
 assert.deepEqual(queue.map(item=>item.promptMeta.sequence),[3,4]);
 assert.equal(labels.next().sequence,5);assert.equal(history.snapshot().promptCount,4);
 assert.deepEqual(history.snapshot().messages.map(message=>message.content),['old one','old two']);
 assert.ok(queue.every(item=>item.literal));
});
