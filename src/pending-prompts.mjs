/** Old saved prompts have no submission metadata; assign distinct fresh numbers once. */
export function restorePendingPrompts({record,history,labels}) {
  return (record?.pendingInputs||[]).map((text,index)=>{
    const saved=record.pendingSubmissions?.[index];
    let meta;
    if(saved){const time=saved.timestamp?new Date(saved.timestamp).toLocaleTimeString('en-GB',{hour:'2-digit',minute:'2-digit',hourCycle:'h23'}):'--:--';meta={sequence:saved.sequence,timestamp:saved.timestamp,label:`${time} ${String(saved.sequence).padStart(2,'0')}@you >`};}
    else{meta=labels.submit();history.recordSubmission(meta);}
    return {text,recorded:false,literal:saved?saved.literal:true,promptMeta:meta};
  });
}
