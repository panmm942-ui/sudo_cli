import test from 'node:test';
import assert from 'node:assert/strict';
import {performanceFields} from '../src/performance-view.mjs';
test('performance shows measured local usage and does not invent missing GPU readings',()=>{
  const fields=Object.fromEntries(performanceFields({cpu:{percent:25.25},ram:{usedBytes:8*1024**3,totalBytes:32*1024**3,percent:25},gpu:{status:'unavailable'},vram:{status:'unavailable'}}).map(item=>[item.label,item.value]));
  assert.equal(fields.CPU,'25.3%');assert.equal(fields.RAM,'8.0/32.0 GiB (25.0%)');assert.equal(fields.GPU,'Unavailable');assert.equal(fields.VRAM,'Unavailable');
});
test('partial VRAM and shared memory remain useful without false capacity or zero GPU load',()=>{
  const fields=performanceFields({cpu:{status:'warming-up'},gpu:{percent:0,adapters:[{},{}]},vram:{status:'partial',usedBytes:2*1024**3,totalBytes:null,memoryKind:'shared'}});
  assert.equal(fields[0].value,'Measuring');assert.equal(fields[2].value,'0.0% (busiest)');assert.equal(fields[3].value,'2.0 GiB used; total unavailable shared');
  assert.equal(performanceFields({vram:{memoryKind:'shared'}})[3].value,'Shared RAM; usage unavailable');
});
test('VRAM follows the busiest measured adapter instead of guessing capacities for unmatched counters',()=>{
  const fields=performanceFields({gpu:{percent:25,adapters:[{percent:25,identified:true,vramUsedBytes:400*1024**2,vramTotalBytes:512*1024**2,memoryKind:'dedicated'},{percent:0,vramUsedBytes:0,vramTotalBytes:null}]},vram:{status:'partial',usedBytes:400*1024**2,totalBytes:null}});
  assert.equal(fields[3].value,'400/512 MiB (78.1%)');
});
