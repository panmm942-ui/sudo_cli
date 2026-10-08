import test from 'node:test';
import assert from 'node:assert/strict';
import {createEventLog} from '../src/event-log.mjs';

test('events remain separate, redact credentials and remove terminal controls',()=>{
  const log=createEventLog({secrets:()=>['super-secret-value'],now:()=>new Date('2026-10-08T00:24:00Z')});
  log.add('\x1b[31mNew chat started with super-secret-value',{kind:'info'});
  log.add('Permission requested',{kind:'approval'});
  const state=log.snapshot();assert.equal(state.entries.length,2);
  assert.equal(state.entries[0].text,'New chat started with [redacted]');
  assert.equal(state.entries[1].kind,'approval');assert.equal(state.entries[1].timestamp,'2026-10-08T00:24:00.000Z');
  state.entries[0].text='mutated';assert.notEqual(log.snapshot().entries[0].text,'mutated');
});

test('bounded event retention reports dropped history instead of leaking unbounded logs',()=>{
  const log=createEventLog({maxEntries:3,maxCharacters:80});
  for(let i=0;i<5;i++)log.add('Event '+i);
  assert.equal(log.snapshot().entries.length,3);assert.equal(log.snapshot().dropped,2);
  assert.equal(log.snapshot().entries[0].text,'Event 2');
  log.clear();assert.deepEqual(log.snapshot(),{entries:[],dropped:0});
});
