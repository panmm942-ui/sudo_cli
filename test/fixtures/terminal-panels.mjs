// Module-level terminal acceptance fixture: no CLI engine, provider or clipboard.
// Standalone Node test discovery is harmless; the PTY manual supplies this flag.
import {Writable} from 'node:stream';
import {createInterface} from 'node:readline/promises';
import {writeFileSync} from 'node:fs';
import {createDashboard} from '../../src/dashboard.mjs';
import {createTerminalTheme} from '../../src/terminal-theme.mjs';
import {createPasteInput} from '../../src/terminal-paste.mjs';
import {createChatScrollInput} from '../../src/chat-scroll-input.mjs';

async function run(path){
  let rl,active=true,sequence=1,literal=false,closing=false;const submissions=[];
  const dashboard=createDashboard({snapshot:()=>({cwd:'/synthetic-demo',working:false,performance:{cpu:{percent:12},ram:{usedBytes:1024,totalBytes:4096},gpu:{adapters:[]}}}),env:{TERM:'xterm'},theme:createTerminalTheme({color:true,env:{TERM:'xterm'}})});
  const label=()=>`12:34 ${String(sequence).padStart(2,'0')}@you > `;
  const save=()=>writeFileSync(path,JSON.stringify({input:{text:rl?.line||'',cursor:rl?.cursor||0},sequence,submissions,layout:dashboard.layout(),chat:dashboard.scrollState(),events:dashboard.eventsState(),caret:dashboard.inputCursor(),closing}));
  const paint=()=>{if(!active||closing)return;dashboard.setInput({prompt:label(),text:rl?.line||'',cursor:rl?.cursor||0});save();};
  const output=new Writable({write(_chunk,_encoding,done){paint();done();}});output.isTTY=true;Object.defineProperty(output,'columns',{get:()=>dashboard.inputArea().columns});
  const paste=createPasteInput({input:process.stdin,onPaste:text=>{literal=true;rl?.write(text.replace(/\n/g,' '));paint();return '';},readClipboard:async()=> 'https://example.com/ctrl-v?value=λ'});
  const scroll=createChatScrollInput({input:paste,getContext:()=>({enabled:true}),onScroll:(name,metadata)=>{
    if(name==='focus-next')dashboard.focusPanel('next');
    else {const panel=metadata?dashboard.panelAt(metadata):(dashboard.eventsState().focused?'events':'chat');if(panel){if(metadata)dashboard.focusPanel(panel);if(name==='pointer'){if(!metadata.release)dashboard.scrollPanel(panel,'pointer',metadata);}else dashboard.scrollPanel(panel,({'wheel-up':-3,'wheel-down':3,'line-up':-1,'line-down':1})[name]??name);}}
    save();
  }});
  rl=createInterface({input:scroll,output,terminal:true});dashboard.start();dashboard.write(Array.from({length:80},(_,index)=>`CHAT_${index}`).join('\n')+'\n');dashboard.event(Array.from({length:70},(_,index)=>`EVENT_${index}`).join('\n'));
  process.stdout.on('resize',paint);process.stdout.write('\x1b[?2004h\x1b[?1000h\x1b[?1002h\x1b[?1006h');
  try{
    while(active){paint();const text=await rl.question(label());if(text==='/quit'&&!literal){active=false;break;}submissions.push(text);dashboard.write(label()+text+'\n',{user:true});sequence++;literal=false;}
  }finally{
    closing=true;save();rl.close();scroll.detach();paste.detach();process.stdout.removeListener('resize',paint);process.stdin.setRawMode?.(false);process.stdin.pause();process.stdout.write('\x1b[?2004l\x1b[?1000l\x1b[?1002l\x1b[?1006l');dashboard.stop();
  }
}
if(process.argv.includes('--terminal-fixture'))await run(process.argv.at(-1));
