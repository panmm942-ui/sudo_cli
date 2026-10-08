import {stripVTControlCharacters} from 'node:util';

const measured=value=>Number.isFinite(value)&&value>=0;
const percent=value=>measured(value)?Math.min(100,value).toFixed(1)+'%':undefined;
const clean=value=>stripVTControlCharacters(String(value??'')).replace(/[\u0000-\u001f\u007f-\u009f]/g,' ').replace(/\s+/g,' ').trim();
function unavailable(metric){return metric?.status==='warming-up'?'Measuring':'Unavailable';}
function memory(metric){
  const scale=metric?.totalBytes??metric?.usedBytes??0;
  const unit=scale>=1024**3?'GiB':scale>=1024**2||scale===0?'MiB':scale>=1024?'KiB':'B',divisor={GiB:1024**3,MiB:1024**2,KiB:1024,B:1}[unit];
  const amount=value=>measured(value)?(value/divisor).toFixed(unit==='GiB'?1:0):undefined;
  const used=amount(metric?.usedBytes),total=amount(metric?.totalBytes);
  if(used!==undefined&&total!==undefined)return `${used}/${total} ${unit}${percent(metric?.percent)?' ('+percent(metric.percent)+')':''}`;
  if(used!==undefined)return `${used} ${unit} used; total unavailable`;
  if(total!==undefined)return `${unavailable(metric)} / ${total} ${unit}`;
  return metric?.memoryKind==='shared'?'Shared RAM; usage unavailable':unavailable(metric);
}
const memoryMetric=(usedBytes,totalBytes,status)=>({usedBytes,totalBytes,status,percent:measured(usedBytes)&&measured(totalBytes)&&totalBytes>0&&usedBytes<=totalBytes?usedBytes/totalBytes*100:undefined});
const hasCapacity=value=>measured(value)&&value>0;

/** Full adapter identities and independent dedicated/shared counters for this PC. */
export function performanceDetails(value={}){
  const summary=performanceFields(value),groups=[{id:'system',fields:summary.slice(0,2)}];
  const inventory=Array.isArray(value.gpu?.adapters)?value.gpu.adapters.filter(item=>item&&typeof item==='object'):[];
  const physical=inventory.some(item=>item.identified===true);
  const adapters=inventory.filter(item=>!physical||item.identified===true||
    measured(item.percent)&&item.percent>0||measured(item.vramUsedBytes)&&item.vramUsedBytes>0||measured(item.sharedUsedBytes)&&item.sharedUsedBytes>0||hasCapacity(item.vramTotalBytes)||hasCapacity(item.sharedTotalBytes)
  ).map((item,order)=>({item,order})).sort((left,right)=>Number(right.item.identified===true)-Number(left.item.identified===true)||left.order-right.order).map(entry=>entry.item);
  if(!adapters.length){groups.push({id:'gpu',fields:summary.slice(2)});return groups;}
  let physicalIndex=0;
  for(const [index,adapter] of adapters.entries()){
    const shared=adapter.memoryKind==='shared',name=clean(adapter.name)||'Unidentified GPU';
    const fields=[{label:'Usage',value:percent(adapter.percent)||unavailable(adapter)},
      {label:adapter.memoryKind==='unknown'||!adapter.memoryKind?'VRAM (type unknown)':'Dedicated VRAM',value:shared?'Not reported':memory(memoryMetric(adapter.vramUsedBytes,adapter.vramTotalBytes,adapter.status))}];
    const sharedUsed=shared?(adapter.sharedUsedBytes??adapter.vramUsedBytes):adapter.sharedUsedBytes;
    const sharedTotal=shared?(adapter.sharedTotalBytes??adapter.vramTotalBytes):adapter.sharedTotalBytes;
    if(shared||measured(sharedUsed)||hasCapacity(sharedTotal))fields.push({label:'Shared RAM',value:memory({...memoryMetric(sharedUsed,sharedTotal,adapter.status),memoryKind:'shared'})});
    if(Number.isInteger(adapter.driverErrorCode)&&adapter.driverErrorCode>0)fields.push({label:'Status',value:`Driver error ${adapter.driverErrorCode}`,code:31});
    else if(adapter.deviceStatus==='unavailable')fields.push({label:'Status',value:'Device unavailable'});
    else if(adapter.deviceStatus==='unknown')fields.push({label:'Status',value:'Device status unknown'});
    const title=physical&&adapter.identified!==true?`Unidentified counters: ${name}`:`GPU ${physical?physicalIndex++:index}: ${name}`;
    groups.push({id:clean(adapter.id)||`gpu-${index}`,title,name,identified:adapter.identified===true,capacitySource:clean(adapter.capacitySource)||undefined,fields});
  }
  return groups;
}
/** These are this computer's counters, even when the model runs in the cloud. */
export function performanceFields(value={}){
  const adapters=value.gpu?.adapters||[];
  const busiest=adapters.filter(item=>measured(item.percent)).sort((a,b)=>b.percent-a.percent||Number(b.identified)-Number(a.identified))[0];
  // Prefer the measured busiest adapter's pair to guessed virtual-adapter totals.
  const vram=busiest&&measured(busiest.vramUsedBytes)&&measured(busiest.vramTotalBytes)&&busiest.vramTotalBytes>0&&busiest.vramUsedBytes<=busiest.vramTotalBytes
    ?{usedBytes:busiest.vramUsedBytes,totalBytes:busiest.vramTotalBytes,percent:100*busiest.vramUsedBytes/busiest.vramTotalBytes,memoryKind:busiest.memoryKind}:value.vram;
  return [
    {label:'CPU',value:percent(value.cpu?.percent)||unavailable(value.cpu)},
    {label:'RAM',value:memory(value.ram)},
    {label:'GPU',value:(percent(value.gpu?.percent)||unavailable(value.gpu))+(adapters.length>1?' (busiest)':'')},
    {label:'VRAM',value:memory(vram)+(vram?.memoryKind==='shared'&&measured(vram?.usedBytes)?' shared':'')},
  ];
}
