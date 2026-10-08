const measured=value=>Number.isFinite(value)&&value>=0;
const percent=value=>measured(value)?Math.min(100,value).toFixed(1)+'%':undefined;
function unavailable(metric){return metric?.status==='warming-up'?'Measuring':'Unavailable';}
function memory(metric){
  const unit=(metric?.totalBytes??metric?.usedBytes??0)>=1024**3?'GiB':'MiB',divisor=unit==='GiB'?1024**3:1024**2;
  const amount=value=>measured(value)?(value/divisor).toFixed(unit==='GiB'?1:0):undefined;
  const used=amount(metric?.usedBytes),total=amount(metric?.totalBytes);
  if(used!==undefined&&total!==undefined)return `${used}/${total} ${unit}${percent(metric?.percent)?' ('+percent(metric.percent)+')':''}`;
  if(used!==undefined)return `${used} ${unit} used; total unavailable`;
  return metric?.memoryKind==='shared'?'Shared RAM; usage unavailable':unavailable(metric);
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
