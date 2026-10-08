import {Transform} from 'node:stream';
import {StringDecoder} from 'node:string_decoder';
import {stripVTControlCharacters} from 'node:util';
import {COMMANDS} from './commands.mjs';

const clean=value=>stripVTControlCharacters(String(value??'')).replace(/[\u0000-\u001f\u007f-\u009f]/g,' ');
const cells=character=>{
  const code=character.codePointAt(0);
  if(/\p{Mark}|\p{Default_Ignorable_Code_Point}/u.test(character))return 0;
  return code>=0x1100&&(code<=0x115f||code===0x2329||code===0x232a||(code>=0x2e80&&code<=0xa4cf)||(code>=0xac00&&code<=0xd7a3)||(code>=0xf900&&code<=0xfaff)||(code>=0xfe10&&code<=0xfe6f)||(code>=0xff01&&code<=0xff60)||(code>=0xffe0&&code<=0xffe6)||(code>=0x1f300&&code<=0x1faff)||code>=0x20000)?2:1;
};
const segmenter=new Intl.Segmenter(undefined,{granularity:'grapheme'});
const characters=value=>[...segmenter.segment(clean(value))].map(item=>item.segment);
const characterCells=character=>/\p{Emoji_Presentation}|\p{Regional_Indicator}|\u20e3/u.test(character)||character.includes('\ufe0f')&&/\p{Extended_Pictographic}/u.test(character)?2:[...character].reduce((total,part)=>total+cells(part),0);
const width=value=>characters(value).reduce((total,character)=>total+characterCells(character),0);
function clip(value,limit){
  if(limit<=0)return '';
  const plain=clean(value),parts=characters(plain);
  if(width(plain)<=limit)return plain;
  let result='',length=0;
  for(const character of parts){const size=characterCells(character);if(length+size>limit-1)break;result+=character;length+=size;}
  return result+'~';
}
function tail(value,limit){
  if(limit<=0)return '';
  const plain=clean(value);
  if(width(plain)<=limit)return plain;
  let result='',length=0;
  for(const character of characters(plain).reverse()){const size=characterCells(character);if(length+size>limit-1)break;result=character+result;length+=size;}
  return '~'+result;
}
const positive=(value,fallback,maximum)=>Number.isFinite(value)&&value>0?Math.max(1,Math.min(maximum,Math.floor(value))):fallback;

/**
 * A command picker placed after bracketed-paste filtering and before Readline.
 * Only an isolated, typed slash opens it. Selecting fills a command; it never
 * emits Enter. Hidden questions and changed prompts cannot receive menu text.
 * Render cursor coordinates are zero-based rows and terminal-cell columns.
 */
export function createSlashMenuInput({input,getContext=()=>({enabled:false}),getSize=()=>({columns:80,rows:12}),onRender=()=>{},onClose=()=>{},onError=()=>{},commands=COMMANDS}){
  if(!input?.pipe)throw new TypeError('Slash menu input must be a readable stream.');
  const inventory=commands.slice(0,512).filter(command=>command&&/^\/[a-z0-9-]+(?:\.[a-z0-9-]+)*$/i.test(command.name)).map(command=>Object.freeze({name:command.name,usage:clean(command.usage),description:clean(command.description)}));
  const decoder=new StringDecoder('utf8');
  let active=false,query='',index=0,keyBuffer='',escapeTimer,swallowNextLf=false,detached=false;
  const report=error=>{try{onError(error);}catch{}};
  const context=()=>{try{return getContext()||{};}catch(error){report(error);return {};}};
  const validContext=()=>{const current=context();return current.enabled===true&&current.line==='/'&&(current.cursor===undefined||current.cursor===1);};
  const size=()=>{try{const current=getSize()||{};return {columns:positive(current.columns,80,10000),rows:positive(current.rows,12,500)};}catch(error){report(error);return {columns:80,rows:12};}};
  const matches=()=>{
    const needle=query.trim().toLowerCase();
    if(!needle)return inventory;
    return inventory.map((command,order)=>{
      const name=command.name.slice(1).toLowerCase();
      const rank=name===needle?0:name.startsWith(needle)?1:name.includes(needle)?2:command.description.toLowerCase().includes(needle)?3:Infinity;
      return {command,rank,order};
    }).filter(item=>Number.isFinite(item.rank)).sort((left,right)=>left.rank-right.rank||left.order-right.order).map(item=>item.command);
  };
  const view=()=>{
    if(!active)return {active:false,query:'',selected:undefined,total:0,index:-1,page:0,pageCount:0,visibleStart:0,visibleEnd:0,cursor:undefined,lines:[]};
    const {columns,rows}=size(),limit=Math.max(0,columns-1),items=matches();
    index=items.length?Math.max(0,Math.min(index,items.length-1)):0;
    const status=rows>=4,separator=rows>=5,help=rows>=5,usage=rows>=7;
    const reserved=1+Number(status)+Number(separator)+Number(help)+Number(usage);
    const capacity=Math.max(1,Math.min(10,Math.floor((rows-reserved+1)/2)));
    const page=Math.floor(index/capacity),visibleStart=page*capacity,visibleEnd=Math.min(items.length,visibleStart+capacity),selected=items[index];
    const entries=items.slice(visibleStart,visibleEnd).map((command,offset)=>`${visibleStart+offset===index?'>':' '} ${command.name}  ${command.description}`);
    if(!entries.length)entries.push('No commands match. Backspace to change the filter.');
    const lines=[];
    if(status)lines.push(`Commands ${items.length?visibleStart+1:0}-${visibleEnd} of ${items.length}`);
    const prefix=limit>=12?'Search: /':limit>0?'/':'',search=prefix+tail(query,limit-width(prefix));
    const cursor={row:lines.length,column:width(search)};
    lines.push(search);
    if(separator)lines.push('');
    if(rows>1)entries.forEach((entry,offset)=>{if(offset)lines.push('');lines.push(entry);});
    const footer=[];
    if(usage)footer.push(selected?`Use: ${selected.name}${selected.usage?' '+selected.usage:''}`:'Type a command name or its description.');
    if(help)footer.push('Arrows / PgUp/PgDn | Enter select | Esc close');
    if(footer.length&&lines.length+footer.length<rows)lines.push('');
    lines.push(...footer);
    return {active:true,query,selected:selected?{...selected}:undefined,total:items.length,index:items.length?index:-1,page:items.length?page+1:0,pageCount:Math.ceil(items.length/capacity),visibleStart,visibleEnd,capacity,cursor,lines:lines.slice(0,rows).map(line=>clip(line,limit))};
  };
  const clearEscape=()=>{clearTimeout(escapeTimer);escapeTimer=undefined;};
  const render=()=>{const current=view();try{onRender(current);}catch(error){report(error);close({reason:'render',restore:true});}return active?current:view();};
  const close=({reason='dismiss',restore=false,selected}={})=>{
    if(!active)return undefined;
    const record={reason,query,selected,restore:!!restore&&validContext()};
    active=false;query='';index=0;keyBuffer='';clearEscape();
    try{onClose(record);}catch(error){report(error);}
    return record;
  };
  const forward=text=>{if(text)stream.push(text);};
  const closeAndForward=(record,text)=>{close(record);forward(text);};
  const scheduleEscape=()=>{
    if(escapeTimer)return;
    escapeTimer=setTimeout(()=>{
      escapeTimer=undefined;
      if(!active)return;
      if(!validContext()){close({reason:'context'});return;}
      const pending=keyBuffer;
      if(pending==='\x1b')close({reason:'escape',restore:true});
      else closeAndForward({reason:'escape-key',restore:true},pending);
    },30);
    escapeTimer.unref?.();
  };
  const move=amount=>{const total=matches().length;if(total)index=(index+amount+total)%total;render();};
  const processKeys=()=>{
    while(active&&keyBuffer){
      if(!validContext()){const remaining=keyBuffer;closeAndForward({reason:'context'},remaining);return;}
      const character=[...keyBuffer][0];
      if(character==='\x1b'){
        if(keyBuffer.length===1){scheduleEscape();return;}
        if(keyBuffer[1]==='['||keyBuffer[1]==='O'){
          const sequence=/^\x1b(?:\[[0-?]*[ -/]*[@-~]|O[@-~])/.exec(keyBuffer)?.[0];
          if(!sequence){scheduleEscape();return;}
          keyBuffer=keyBuffer.slice(sequence.length);clearEscape();
          const final=sequence.at(-1),current=view(),total=current.total;
          if(final==='A')move(-1);
          else if(final==='B')move(1);
          else if(final==='H'||/^\x1b\[(?:1|7)~$/.test(sequence)){index=0;render();}
          else if(final==='F'||/^\x1b\[(?:4|8)~$/.test(sequence)){index=Math.max(0,total-1);render();}
          else if(sequence==='\x1b[5~'){index=Math.max(0,index-current.capacity);render();}
          else if(sequence==='\x1b[6~'){index=Math.min(Math.max(0,total-1),index+current.capacity);render();}
          else {const remaining=keyBuffer;closeAndForward({reason:'edit',restore:true},sequence+remaining);return;}
          continue;
        }
        if(keyBuffer[1]<' '||keyBuffer[1]==='\x7f'){
          const remaining=keyBuffer.slice(1);closeAndForward({reason:'escape',restore:true},remaining);return;
        }
        const remaining=keyBuffer;closeAndForward({reason:'edit',restore:true},remaining);return;
      }
      keyBuffer=keyBuffer.slice(character.length);clearEscape();
      if(character===' '&&inventory.some(command=>command.name.slice(1).toLowerCase()===query.toLowerCase())){
        const remaining=keyBuffer;closeAndForward({reason:'arguments',restore:true},character+remaining);return;
      }
      if(character==='\r'||character==='\n'){
        const selected=view().selected;
        if(!selected){render();continue;}
        let remaining=keyBuffer;
        if(character==='\r'){
          if(remaining.startsWith('\n'))remaining=remaining.slice(1);
          else swallowNextLf=true;
        }
        closeAndForward({reason:'select',selected:selected.name+(selected.usage?' ':'')},remaining);return;
      }
      if(character==='\x03'){
        const remaining=keyBuffer;closeAndForward({reason:'interrupt'},character+remaining);return;
      }
      if(character==='\x7f'||character==='\b'){
        if(!query){const remaining=keyBuffer;closeAndForward({reason:'backspace'},character+remaining);return;}
        query=[...query].slice(0,-1).join('');index=0;render();continue;
      }
      if(character==='\t'){move(1);continue;}
      if(character==='\x15'){query='';index=0;render();continue;}
      if(character==='\x17'){query=query.replace(/\s*\S+\s*$/u,'');index=0;render();continue;}
      if(character==='\x0c'){render();continue;}
      if(character<' '||/[\u007f-\u009f]/u.test(character)){
        const remaining=keyBuffer;closeAndForward({reason:'edit',restore:true},character+remaining);return;
      }
      if([...query].length<256){query+=character;index=0;render();}
    }
  };
  const consume=text=>{
    if(swallowNextLf&&text){if(text.startsWith('\n'))text=text.slice(1);swallowNextLf=false;}
    if(!text)return;
    if(active){clearEscape();keyBuffer+=text;processKeys();return;}
    const current=context();
    if(!detached&&text==='/'&&current.enabled===true&&current.line===''&&(current.cursor===undefined||current.cursor===0)){
      forward('/');active=true;query='';index=0;render();
    }else forward(text);
  };
  const stream=new Transform({
    transform(chunk,_encoding,done){try{consume(decoder.write(chunk));done();}catch(error){report(error);done(error);}},
    flush(done){try{const tail=decoder.end();if(!active)forward(tail);close({reason:'end'});done();}catch(error){done(error);}},
    destroy(error,done){close({reason:'destroy'});done(error);},
  });
  stream.isTTY=input.isTTY;
  stream.setRawMode=value=>input.setRawMode?.(value);
  stream.snapshot=()=>view();
  stream.refresh=()=>{if(active&&!validContext())close({reason:'context'});return active?render():view();};
  stream.closeMenu=options=>close(options);
  stream.detach=()=>{if(detached)return;detached=true;input.unpipe(stream);close({reason:'detach'});};
  input.pipe(stream);
  return stream;
}
