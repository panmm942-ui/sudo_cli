export function clearReadingInstructions(enabled){return enabled?'Use clear-reading mode: put the answer first. Use short sentences and short lines. Give one action per bullet with blank lines between actions. Avoid dense paragraphs and unexplained jargon. Keep the first answer concise; offer details separately. Preserve accurate code, commands and essential cautions.':'';}
export function voiceTranscript(text,{wakePhrase='',paused=false}={}){
  if(paused)return null;const value=String(text).trim();if(!value)return null;
  const wake=String(wakePhrase).trim();if(!wake)return value;
  if(!value.toLocaleLowerCase().startsWith(wake.toLocaleLowerCase()))return null;
  const next=value.slice(wake.length);if(next&&!/^[\s,:.!?-]/.test(next))return null;return next.replace(/^[\s,:.!?-]+/,'').trim()||null;
}
export function searchMessages(messages,query,{limit=20}={}){const needle=String(query).toLocaleLowerCase();if(!needle)return [];return messages.map((message,index)=>({...message,index})).filter(message=>String(message.content).toLocaleLowerCase().includes(needle)).slice(0,Math.min(100,Math.max(1,limit)));}
export async function readMultiline(ask,{maxBytes=1024*1024}={}){const lines=[];let bytes=0;while(true){const line=await ask('  | ');if(line==='/end')break;bytes+=Buffer.byteLength(line)+1;if(bytes>maxBytes)throw new Error('Prompt exceeds its 1 MiB input limit.');lines.push(line);}return lines.join('\n');}
