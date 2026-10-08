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

test('named GPU details retain unavailable installed capacity and driver errors beside measured integrated usage',async()=>{
  const {performanceDetails}=await import('../src/performance-view.mjs');assert.equal(typeof performanceDetails,'function');
  const groups=performanceDetails({cpu:{percent:12.5},ram:{usedBytes:8*1024**3,totalBytes:32*1024**3,percent:25},gpu:{adapters:[
    {id:'old',name:'Stale Windows counter',identified:false,percent:0,vramUsedBytes:0,vramTotalBytes:null},
    {id:'amd',name:'AMD Radeon 780M',identified:true,percent:17.8,vramUsedBytes:400*1024**2,vramTotalBytes:512*1024**2,sharedUsedBytes:300*1024**2,sharedTotalBytes:16*1024**3,memoryKind:'dedicated'},
    {id:'rtx',name:'NVIDIA GeForce RTX 5050 Laptop GPU',identified:true,status:'unavailable',percent:null,vramUsedBytes:null,vramTotalBytes:7.96*1024**3,memoryKind:'dedicated',driverErrorCode:43,deviceStatus:'driver-error',capacitySource:'windows-driver-registry-qword'},
  ]}});
  assert.deepEqual(groups[0].fields,[{label:'CPU',value:'12.5%'},{label:'RAM',value:'8.0/32.0 GiB (25.0%)'}]);
  assert.deepEqual(groups.slice(1).map(item=>item.title),['GPU 0: AMD Radeon 780M','GPU 1: NVIDIA GeForce RTX 5050 Laptop GPU']);
  const amd=Object.fromEntries(groups[1].fields.map(item=>[item.label,item.value]));
  assert.equal(amd.Usage,'17.8%');assert.equal(amd['Dedicated VRAM'],'400/512 MiB (78.1%)');assert.equal(amd['Shared RAM'],'0.3/16.0 GiB (1.8%)');
  const rtx=Object.fromEntries(groups[2].fields.map(item=>[item.label,item.value]));
  assert.equal(rtx.Usage,'Unavailable');assert.equal(rtx['Dedicated VRAM'],'Unavailable / 8.0 GiB');assert.equal(rtx.Status,'Driver error 43');
  assert.equal(groups[2].capacitySource,'windows-driver-registry-qword');
});

test('shared-memory GPUs do not present system RAM as dedicated VRAM and active unidentified counters stay visible',async()=>{
  const {performanceDetails}=await import('../src/performance-view.mjs');assert.equal(typeof performanceDetails,'function');
  const groups=performanceDetails({gpu:{adapters:[
    {id:'active',name:'Unidentified GPU counter',identified:false,percent:9,vramUsedBytes:12*1024**2,vramTotalBytes:null},
    {id:'shared-counter',name:'Unmatched shared counters',identified:false,percent:0,vramUsedBytes:0,vramTotalBytes:null,sharedUsedBytes:8192,sharedTotalBytes:null,memoryKind:'dedicated'},
    {id:'shared',name:'Unified-memory GPU',identified:true,percent:0,vramUsedBytes:2*1024**3,vramTotalBytes:16*1024**3,memoryKind:'shared'},
  ]}});
  assert.equal(groups[1].title,'GPU 0: Unified-memory GPU');
  const shared=Object.fromEntries(groups[1].fields.map(item=>[item.label,item.value]));
  assert.equal(shared.Usage,'0.0%');assert.equal(shared['Dedicated VRAM'],'Not reported');assert.equal(shared['Shared RAM'],'2.0/16.0 GiB (12.5%)');
  assert.equal(groups[2].title,'Unidentified counters: Unidentified GPU counter');
  assert.equal(groups[2].fields.find(item=>item.label==='Usage').value,'9.0%');
  assert.equal(groups[3].title,'Unidentified counters: Unmatched shared counters');
  assert.equal(groups[3].fields.find(item=>item.label==='Shared RAM').value,'8 KiB used; total unavailable');
});
