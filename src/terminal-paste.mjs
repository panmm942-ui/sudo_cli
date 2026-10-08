import {Transform} from 'node:stream';
import {StringDecoder} from 'node:string_decoder';
const START='\x1b[200~',END='\x1b[201~';
/** Deliver a literal paste event; its active editor decides when to submit. */
export function createPasteInput({input,onPaste,onError=()=>{},maxBytes=1024*1024,readClipboard}){
  const decoder=new StringDecoder('utf8');let pending='',paste='',inside=false,overflow=false,escapeTimer,forwardedPrefix=0,clipboard,clipboardDelivery,detached=false;
  const clearEscape=()=>{clearTimeout(escapeTimer);escapeTimer=undefined;};
  // A lone Escape is also the first byte of a paste marker. Deliver the key
  // promptly, but keep that prefix for recognition if its marker arrives late.
  const clipboardPaste=()=>{
    if(clipboard||detached||stream.destroyed)return;
    const controller=new AbortController();clipboard=controller;
    let value;try{value=readClipboard({signal:controller.signal,maxBytes});}catch(error){value=Promise.reject(error);}
    clipboardDelivery=Promise.resolve(value).then(text=>{
      if(detached||stream.destroyed||controller.signal.aborted)return;
      if(typeof text!=='string'||Buffer.byteLength(text)>maxBytes)throw new Error('Clipboard text exceeded the paste limit.');
      const replacement=onPaste(text.replace(/\r\n?/g,'\n'),{source:'clipboard'});if(typeof replacement==='string'&&replacement)stream.push(replacement);
    }).catch(error=>{if((detached||controller.signal.aborted)&&error?.code!=='SESSION_CLEANUP_FAILED')return;const failure=new Error(error?.code==='SESSION_CLEANUP_FAILED'?'Clipboard process cleanup could not be verified.':'Clipboard could not be read. Use the terminal paste menu.');if(error?.code==='SESSION_CLEANUP_FAILED')failure.code=error.code;try{onError(failure);}catch{}}).finally(()=>{if(clipboard===controller)clipboard=undefined;});
  };
  const forward=text=>{const skip=Math.min(text.length,forwardedPrefix);forwardedPrefix-=skip;const value=text.slice(skip);if(!readClipboard){if(value)stream.push(value);return;}const parts=value.split('\x16');for(let index=0;index<parts.length;index++){if(parts[index])stream.push(parts[index]);if(index<parts.length-1)clipboardPaste();}};
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
    destroy(error,done){clearEscape();clipboard?.abort();done(error);},
  });
  stream.isTTY=input.isTTY;stream.setRawMode=value=>input.setRawMode?.(value);input.pipe(stream);stream.detach=()=>{if(!detached){detached=true;clearEscape();clipboard?.abort();input.unpipe(stream);}return clipboardDelivery;};return stream;
}
