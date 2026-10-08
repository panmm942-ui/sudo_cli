import test from 'node:test';
import assert from 'node:assert/strict';
import {createAiActivity} from '../src/ai-activity.mjs';
import {createAntennaClock,renderAntenna} from '../src/antenna.mjs';

test('setup, update checks and local commands cannot start AI activity',()=>{
  const activity=createAiActivity();
  for(const kind of ['setup','update','typing','performance','local-command']) assert.throws(()=>activity.begin(kind,'operation'),/AI task/i);
  assert.equal(activity.snapshot().working,false);
});
test('antenna advances only during real model work and freezes during permission waits and idle',()=>{
  let now=0;const clock=createAntennaClock({now:()=>now});const activity=createAiActivity();
  const draw=()=>renderAntenna({elapsed:clock.elapsed(activity.snapshot().working),color:true,idle:!clock.hasWorked()}).join('\n');
  const idle=draw();now=3000;assert.equal(draw(),idle);
  activity.begin('model','prompt');draw();now+=250;const active=draw();assert.notEqual(active,idle);
  activity.pause('prompt');const waiting=draw();now+=4000;assert.equal(draw(),waiting);
  activity.resume('prompt');draw();now+=250;assert.notEqual(draw(),waiting);
  activity.end('prompt');const stopped=draw();now+=4000;assert.equal(draw(),stopped);
});
test('parallel agents keep work active until their last unpaused task ends',()=>{
  const events=[];const activity=createAiActivity({onChange:value=>events.push(value.working)});
  activity.begin('agent','one');activity.begin('agent','two');activity.pause('one');activity.end('two');
  assert.equal(activity.snapshot().working,false);assert.equal(activity.snapshot().paused,1);
  activity.resume('one');assert.equal(activity.snapshot().working,true);activity.end('one');
  assert.deepEqual(events,[true,false,true,false]);
});
test('unrelated completion and repeated callbacks do not stop a current AI task',()=>{
  const activity=createAiActivity();activity.begin('background','inbox');activity.begin('background','inbox');
  activity.end('missing');assert.equal(activity.snapshot().active,1);assert.equal(activity.snapshot().working,true);
  activity.clear();assert.equal(activity.snapshot().working,false);
});
