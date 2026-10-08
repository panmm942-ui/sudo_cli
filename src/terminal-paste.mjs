import {Transform} from 'node:stream';
import {StringDecoder} from 'node:string_decoder';
const START='\x1b[200~',END='\x1b[201~';
/** Buffer bracketed paste as one literal prompt; never interpret pasted slashes. */
export function createPasteInput({input,onPaste,onError=()=>{},maxBytes=1024*1024}){
  const decoder=new StringDecoder('utf8');let pending='',paste='',inside=false,overflow=false,escapeTimer,forwardedPrefix=0;
  const clearEscape=()=>{clearTimeout(escapeTimer);escapeTimer=undefined;};
  // A lone Escape is also the first byte of a paste marker. Deliver the key
  // promptly, but keep that prefix for recognition if its marker arrives late.
  const forward=text=>{const skip=Math.min(text.length,forwardedPrefix);forwardedPrefix-=skip;if(text.length>skip)stream.push(text.slice(skip));};
  const append=text=>{if(!overflow){paste+=text;if(Buffer.byteLength(paste)>maxBytes){paste='';overflow=true;}}};
  const armEscape=()=>{
    if(inside||pending!=='\x1b'||forwardedPrefix)return;
    escapeTimer=setTimeout(()=>{
      escapeTimer=undefined;
      if(!inside&&pending==='\x1b'&&!forwardedPrefix&&!stream.destroyed){forwardedPrefix=1;stream.push('\x1b');}
    },30);escapeTimer.unref?.();
  };
  const drain=()=>{
    while(pending){
      const marker=inside?END:START,index=pending.indexOf(marker);
      if(index<0){
        let keep=0;for(let size=1;size<marker.length&&size<=pending.length;size++)if(pending.endsWith(marker.slice(0,size)))keep=size;
        const text=pending.slice(0,pending.length-keep);pending=pending.slice(pending.length-keep);
        if(inside)append(text);else forward(text);break;
      }
      const text=pending.slice(0,index);pending=pending.slice(index+marker.length);
      if(inside){
        append(text);
        if(!overflow){const replacement=onPaste(paste.replace(/\r\n?/g,'\n'));if(replacement)stream.push(replacement);}
        if(overflow)onError(new Error('Paste exceeded 1 MiB and was discarded.'));
        paste='';overflow=false;inside=false;
      }else{forward(text);forwardedPrefix=0;inside=true;}
    }
    armEscape();
  };
  const stream=new Transform({
    transform(chunk,_encoding,done){clearEscape();pending+=decoder.write(chunk);try{drain();done();}catch(error){done(error);}},
    flush(done){clearEscape();if(!inside)forward(pending+decoder.end());else onError(new Error('Incomplete terminal paste was discarded.'));done();},
    destroy(error,done){clearEscape();done(error);},
  });
  stream.isTTY=input.isTTY;stream.setRawMode=value=>input.setRawMode?.(value);input.pipe(stream);stream.detach=()=>{clearEscape();input.unpipe(stream);};return stream;
}
