import test from 'node:test';
import assert from 'node:assert/strict';
import {createPromptLabels} from '../src/prompt-label.mjs';
import {createChatHistory} from '../src/chat-history.mjs';

test('one accepted submission advances numbered prompt; preview and canceled questions do not',()=>{
  const labels=createPromptLabels({now:()=>new Date('2026-10-08T00:24:00Z'),timeZone:'Europe/Athens'});
  assert.equal(labels.next().label,'03:24 01@you >');
  assert.equal(labels.next().label,'03:24 01@you >');
  const first=labels.submit();assert.equal(first.sequence,1);
  assert.equal(labels.next().label,'03:24 02@you >');
  labels.restore({promptCount:109,messages:[]});
  assert.equal(labels.next().label,'03:24 110@you >');
  labels.reset();assert.equal(labels.next().sequence,1);
});

test('saved command submissions and message labels survive chat restore',()=>{
  const history=createChatHistory();
  history.recordSubmission({sequence:1}); // /status
  history.recordSubmission({sequence:2});
  history.addUser('fix this',{sequence:2,timestamp:'2026-10-08T00:24:00.000Z'});
  const data=history.snapshot();assert.equal(data.promptCount,2);
  const restored=createChatHistory();restored.restore(data);
  assert.equal(restored.snapshot().messages[0].sequence,2);
  assert.equal(restored.snapshot().messages[0].timestamp,'2026-10-08T00:24:00.000Z');
  const labels=createPromptLabels();labels.restore(restored.snapshot());assert.equal(labels.next().sequence,3);
  restored.clear();labels.restore(restored.snapshot());assert.equal(labels.next().sequence,1);
});

test('legacy chats derive next prompt from visible user messages and reject corrupt numbering',()=>{
  const labels=createPromptLabels();labels.restore({messages:[{role:'user'},{role:'assistant'},{role:'user'}]});
  assert.equal(labels.next().sequence,3);
  const history=createChatHistory();history.addUser('preserve');const before=history.snapshot();
  assert.throws(()=>history.restore({version:1,promptCount:-1,messages:[]}),/submission|prompt/i);
  assert.deepEqual(history.snapshot(),before);
});

test('clearing export history preserves this chat submission count and accepts the next prompt',()=>{
  const history=createChatHistory(),labels=createPromptLabels();
  for(let i=0;i<3;i++)history.recordSubmission(labels.submit());
  history.addUser('old text',{sequence:2});
  history.clear({preservePromptCount:true});
  assert.equal(history.snapshot().messages.length,0);
  assert.equal(history.snapshot().promptCount,3);
  assert.equal(history.recordSubmission(labels.submit()),4);
});
