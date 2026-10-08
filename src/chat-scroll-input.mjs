import {Transform} from 'node:stream';
import {StringDecoder} from 'node:string_decoder';

/** Paste has already been consumed. The slash picker keeps priority over page keys. */
export function createChatScrollInput({input,getContext=()=>({}),onScroll=()=>{},onLive=()=>{},onError=()=>{},escapeMs=40}={}){
  if(!input?.pipe)throw new TypeError('Chat scrolling requires a readable terminal input.');
  const decoder=new StringDecoder('utf8');let pending='',timer,detached=false;
  const report=error=>{try{onError(error);}catch{}};
  const context=()=>{try{return getContext()||{};}catch(error){report(error);return {};}};
  const clearTimer=()=>{clearTimeout(timer);timer=undefined;};
  const forward=text=>{if(!text)return;if(context().paused)onLive();stream.push(text);};
  const action=sequence=>{
    const mouse=/^\x1b\[<(\d{1,4});(\d{1,5});(\d{1,5})([mM])$/.exec(sequence);
    if(mouse){const button=Number(mouse[1]),metadata={x:Number(mouse[2]),y:Number(mouse[3]),button:button&3,drag:!!(button&32),release:mouse[4]==='m'};if(context().enabled){if(mouse[4]==='M'&&(button&64)&&(button&3)<2)onScroll((button&1)?'wheel-down':'wheel-up',metadata);else if(!(button&64)&&(button&3)===0)onScroll('pointer',metadata);}return true;}
    if(!context().enabled)return false;
    const name=({'\x1b[5~':'page-up','\x1b[6~':'page-down','\x1b[1;2A':'line-up','\x1b[1;2B':'line-down','\x1b[1;5H':'top','\x1b[1;5F':'bottom','\x1b[7;5~':'top','\x1b[8;5~':'bottom','\x1b[H':'top','\x1b[F':'bottom','\x1bOH':'top','\x1bOF':'bottom','\x1b[1~':'top','\x1b[4~':'bottom','\x1b[7~':'top','\x1b[8~':'bottom'})[sequence];
    if(!name)return false;onScroll(name);return true;
  };
  function drain(){
    while(pending){
      if(pending[0]!=='\x1b'){const next=pending.indexOf('\x1b'),text=next<0?pending:pending.slice(0,next);pending=next<0?'':pending.slice(next);const parts=text.split('\t');for(let index=0;index<parts.length;index++){forward(parts[index]);if(index<parts.length-1){if(context().enabled)onScroll('focus-next');else forward('\t');}}continue;}
      const sequence=/^\x1b(?:\[[0-?]*[ -/]*[@-~]|O[@-~])/.exec(pending)?.[0];
      if(sequence){pending=pending.slice(sequence.length);if(!action(sequence))forward(sequence);continue;}
      if(pending.length>1024||pending.length>1&&!['[','O'].includes(pending[1])){forward(pending[0]);pending=pending.slice(1);continue;}
      timer=setTimeout(()=>{timer=undefined;const text=pending;pending='';forward(text);},escapeMs);timer.unref?.();return;
    }
  }
  const stream=new Transform({transform(chunk,_encoding,done){clearTimer();pending+=decoder.write(chunk);try{drain();done();}catch(error){report(error);done(error);}},flush(done){clearTimer();try{forward(pending+decoder.end());pending='';done();}catch(error){done(error);}},destroy(error,done){clearTimer();done(error);}});
  stream.isTTY=input.isTTY;stream.setRawMode=value=>input.setRawMode?.(value);
  stream.detach=()=>{if(detached)return;detached=true;clearTimer();input.unpipe(stream);};
  input.pipe(stream);return stream;
}
