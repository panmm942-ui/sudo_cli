import {stripVTControlCharacters} from 'node:util';
import {createRedactor} from './redactor.mjs';

/** Operational events have bounded independent retention; never persist credentials. */
export function createEventLog({secrets=()=>[],now=()=>new Date(),maxEntries=500,maxCharacters=1024*1024}={}) {
  if(!Number.isSafeInteger(maxEntries)||maxEntries<1||maxEntries>10000||!Number.isSafeInteger(maxCharacters)||maxCharacters<1||maxCharacters>16*1024*1024)throw new Error('Event retention limits must be positive bounded integers.');
  let entries=[],characters=0,dropped=0,sequence=0;
  const clean=text=>{const redactor=createRedactor({secrets});const value=redactor.write(String(text??''))+redactor.flush();return stripVTControlCharacters(value).replace(/[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/g,'');};
  return {
    add(text,{kind='info'}={}) {
      const safe=clean(text).slice(0,Math.min(maxCharacters,64000));
      const entry={id:String(++sequence),timestamp:now().toISOString(),kind:['info','approval','error','done','interrupted','connected','disconnected'].includes(kind)?kind:'info',text:safe};
      entries.push(entry);characters+=safe.length;
      while(entries.length>maxEntries||characters>maxCharacters){characters-=entries.shift().text.length;dropped++;}
      return {...entry};
    },
    snapshot:()=>({entries:entries.map(entry=>({...entry})),dropped}),
    clear(){entries=[];characters=0;dropped=0;},
  };
}
