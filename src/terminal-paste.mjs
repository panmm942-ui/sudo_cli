import {Transform} from 'node:stream';
import {StringDecoder} from 'node:string_decoder';
const START='\x1b[200~',END='\x1b[201~';
/** Buffer bracketed paste as one literal prompt; never interpret pasted slashes. */
export function createPasteInput({input,onPaste,onError=()=>{},maxBytes=1024*1024}){
  const decoder=new StringDecoder('utf8');let pending='',paste='',inside=false,overflow=false;
  const stream=new Transform({transform(chunk,_encoding,done){pending+=decoder.write(chunk);try{while(pending){const marker=inside?END:START,index=pending.indexOf(marker);if(index<0){let keep=0;for(let size=1;size<marker.length&&size<=pending.length;size++)if(pending.endsWith(marker.slice(0,size)))keep=size;const text=pending.slice(0,pending.length-keep);pending=pending.slice(pending.length-keep);if(inside){if(!overflow){paste+=text;if(Buffer.byteLength(paste)>maxBytes){paste='';overflow=true;}}}else this.push(text);break;}const text=pending.slice(0,index);pending=pending.slice(index+marker.length);if(inside){if(!overflow){paste+=text;if(Buffer.byteLength(paste)<=maxBytes){const replacement=onPaste(paste.replace(/\r\n?/g,'\n'));if(replacement)this.push(replacement);}else overflow=true;}if(overflow)onError(new Error('Paste exceeded 1 MiB and was discarded.'));paste='';overflow=false;inside=false;}else{this.push(text);inside=true;}}done();}catch(error){done(error);}},flush(done){if(!inside)this.push(pending+decoder.end());else onError(new Error('Incomplete terminal paste was discarded.'));done();}});
  stream.isTTY=input.isTTY;stream.setRawMode=value=>input.setRawMode?.(value);input.pipe(stream);stream.detach=()=>input.unpipe(stream);return stream;
}
