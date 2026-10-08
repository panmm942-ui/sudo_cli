import {stripVTControlCharacters} from 'node:util';

// Larger than the complete 50 MiB saved-chat format, including visible labels.
export const MAX_VIEWPORT_CHARACTERS = 64 * 1024 * 1024;
const graphemes = new Intl.Segmenter(undefined, {granularity:'grapheme'});
const positive = (value, fallback) => Number.isFinite(value) && value > 0 ? Math.max(1, Math.floor(value)) : fallback;
const clean = value => stripVTControlCharacters(String(value ?? '')).replace(/\r/g, '').replace(/[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/g, '');
function cells(value) {
  if (/\p{Emoji_Presentation}|\p{Regional_Indicator}|\uFE0F/u.test(value)
    || value.includes('\u200d') && /\p{Extended_Pictographic}/u.test(value)) return 2;
  let result = 0;
  for (const character of value) {
    const code = character.codePointAt(0);
    if (/\p{Mark}/u.test(character) || code === 0x200d || code === 0xfe0f) continue;
    result += code >= 0x1100 && (code <= 0x115f || code === 0x2329 || code === 0x232a || (code >= 0x2e80 && code <= 0xa4cf) || (code >= 0xac00 && code <= 0xd7a3) || (code >= 0xf900 && code <= 0xfaff) || (code >= 0xfe10 && code <= 0xfe6f) || (code >= 0xff01 && code <= 0xff60) || (code >= 0xffe0 && code <= 0xffe6) || code >= 0x20000) ? 2 : 1;
  }
  return result;
}
function* characters(value) {
  // The usual ASCII transcript avoids a Segmenter allocation for every letter.
  if (!/[^\x00-\x7f]/.test(value)) {
    for (let index=0; index<value.length; index++) yield {segment:value[index], index};
  } else yield* graphemes.segment(value);
}

/** Retained visible text, with a text-position anchor rather than row offsets. */
export function createChatViewport({columns=79, rows=8, maxCharacters=MAX_VIEWPORT_CHARACTERS}={}) {
  columns=positive(columns,79);rows=positive(rows,8);maxCharacters=positive(maxCharacters,MAX_VIEWPORT_CHARACTERS);
  let text='', base=0, ranges=[], starts=[0], dirty=0, anchor=null, unseen=0, trimmed=0;
  function indexRows() {
    if (dirty === null) return;
    const from=dirty;
    const keep=rowAt(from);
    starts.length=keep;starts.push(from);
    let column=0;
    const suffix=text.slice(from);
    if(!/[^\x00-\x7f]/.test(suffix)){
      for(let position=from;position<text.length;position++){
        const code=text.charCodeAt(position);
        if(code===10){starts.push(position+1);column=0;continue;}
        let size=code===9?Math.min(columns,8-column%8):1;
        if(column&&column+size>columns){starts.push(position);column=0;size=code===9?Math.min(columns,8):1;}
        column+=size;
      }
    }else for (const item of characters(suffix)) {
      const position=from+item.index, character=item.segment;
      if (character === '\n') { starts.push(position+1);column=0;continue; }
      let size=character === '\t' ? Math.min(columns,8-column%8) : cells(character);
      if (column && column+size>columns) { starts.push(position);column=0;size=character==='\t'?Math.min(columns,8):size; }
      column+=size;
    }
    dirty=null;
  }
  function rowAt(position) {
    let low=0, high=starts.length;
    while (low<high) {const middle=(low+high)>>>1;if(starts[middle]<=position)low=middle+1;else high=middle;}
    return Math.max(0,low-1);
  }
  function topIndex() {indexRows();return anchor===null?Math.max(0,starts.length-rows):rowAt(Math.max(0,anchor-base));}
  function segments(start,end) {
    let low=0,high=ranges.length,column=0;
    while(low<high){const middle=(low+high)>>>1;if(ranges[middle].end<=base+start)low=middle+1;else high=middle;}
    const result=[];
    for(let index=low;index<ranges.length&&ranges[index].start<base+end;index++){
      const range=ranges[index],from=Math.max(start,range.start-base),to=Math.min(end,range.end-base);
      let value=text.slice(from,to);
      if(value.includes('\t')){
        let expanded='';
        for(const item of characters(value)){const size=item.segment==='\t'?Math.min(columns,8-column%8):cells(item.segment);expanded+=item.segment==='\t'?' '.repeat(size):item.segment;column+=size;}
        value=expanded;
      }else for(const item of characters(value))column+=cells(item.segment);
      if(value)result.push({text:value,user:range.user});
    }
    return result;
  }
  function append(value,{user=false}={}) {
    value=clean(value);if(!value)return;
    const start=base+text.length;
    if(dirty===null)dirty=starts.at(-1);
    text+=value;
    if(ranges.at(-1)?.user===!!user)ranges.at(-1).end+=value.length;
    else ranges.push({start,end:start+value.length,user:!!user});
    if(anchor!==null)unseen+=value.length;
    if(text.length>maxCharacters){
      let excess=text.length-maxCharacters;
      // Removing a high surrogate also removes its low surrogate.
      if(text.charCodeAt(excess)>=0xdc00&&text.charCodeAt(excess)<=0xdfff)excess++;
      text=text.slice(excess);base+=excess;trimmed+=excess;
      ranges=ranges.filter(range=>range.end>base);if(ranges.length)ranges[0].start=Math.max(base,ranges[0].start);
      starts=[0];dirty=0;if(anchor!==null)anchor=Math.max(base,anchor);
    }
  }
  function clear(){text='';base=0;ranges=[];starts=[0];dirty=0;anchor=null;unseen=0;trimmed=0;}
  function bottom(){anchor=null;unseen=0;}
  function scroll(delta) {
    if(!Number.isFinite(delta)||!delta)return;
    const current=topIndex(),last=Math.max(0,starts.length-rows),next=Math.max(0,Math.min(last,current+Math.trunc(delta)));
    if(next===last)bottom();else anchor=base+starts[next];
  }
  return {
    append,clear,bottom,scroll,
    top(){indexRows();if(starts.length>rows)anchor=base;else bottom();},
    pageUp(){scroll(-rows);},pageDown(){scroll(rows);},
    isScrolled(){return anchor!==null;},
    replace(chunks=[]){clear();for(const chunk of chunks)append(chunk.text,{user:chunk.user});},
    resize(size={}){const next=positive(size.columns,columns);rows=positive(size.rows,rows);if(next!==columns){columns=next;starts=[0];dirty=0;}},
    view(){
      const top=topIndex(),lines=[];
      for(let row=top;row<Math.min(starts.length,top+rows);row++){
        const start=starts[row];let end=starts[row+1]??text.length;if(text[end-1]==='\n')end--;
        lines.push(segments(start,end));
      }
      return {lines,top,totalRows:starts.length,visibleRows:rows,isScrolled:anchor!==null,unseen,trimmed,characters:text.length};
    },
  };
}
