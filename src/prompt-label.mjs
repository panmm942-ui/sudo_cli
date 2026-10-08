/** Previewing a composer does not consume a number. Only accepted submissions do. */
export function createPromptLabels({now=()=>new Date(),timeZone}={}) {
  let count=0;
  const formatter=new Intl.DateTimeFormat('en-GB',{timeZone,hour:'2-digit',minute:'2-digit',hourCycle:'h23',numberingSystem:'latn'});
  const next=()=>{const date=now(),sequence=count+1,time=formatter.format(date);return {sequence,time,timestamp:date.toISOString(),label:`${time} ${String(sequence).padStart(2,'0')}@you >`};};
  return {
    next,
    submit(){const result=next();if(count>=Number.MAX_SAFE_INTEGER-1)throw new Error('Prompt numbering limit reached. Start a new chat.');count++;return result;},
    restore(data={}){const users=(data.messages||[]).filter(message=>message.role==='user').length;const saved=data.promptCount??users;if(!Number.isSafeInteger(saved)||saved<0)throw new Error('Invalid saved prompt count.');count=saved;return next();},
    reset(){count=0;return next();},
  };
}
