import test from 'node:test';
import assert from 'node:assert/strict';
import {EventEmitter} from 'node:events';
import {stripVTControlCharacters} from 'node:util';
import {createDashboard,renderDashboard} from '../src/dashboard.mjs';

const state={cwd:'/demo',working:false,permissions:'ask',performance:{cpu:{percent:12},ram:{usedBytes:1024,totalBytes:4096},gpu:{adapters:[]}}};
function fixture(t,{columns=150,rows=44,...options}={}){
  const output=Object.assign(new EventEmitter(),{isTTY:true,columns,rows,text:'',write(text){this.text+=text;}});
  const dashboard=createDashboard({output,snapshot:()=>state,env:{TERM:'xterm'},color:false,tickMs:0,...options});
  dashboard.start();t.after(()=>dashboard.stop());return {output,dashboard};
}
test('operational events have independent retention and scrollbar positions',t=>{
  const {output,dashboard}=fixture(t);
  assert.equal(typeof dashboard.event,'function','Events must not enter the chat transcript');
  dashboard.write('CHAT_ONLY\n'.repeat(80));dashboard.event('EVENT_ONLY\n'.repeat(50));
  dashboard.scrollPanel('chat','top');dashboard.scrollPanel('events','page-up');
  const chat=dashboard.scrollState(),events=dashboard.eventsState();
  assert.equal(chat.top,0);assert.ok(events.top>0);assert.ok(events.isScrolled);
  assert.notEqual(chat.scrollbar.thumbTop,events.scrollbar.thumbTop);
  output.text='';dashboard.scrollPanel('chat','bottom');
  assert.equal(dashboard.eventsState().top,events.top);
  assert.match(output.text,/CHAT_ONLY/);assert.doesNotMatch(output.text,/EVENT_ONLY/);
});
test('divider, credits and footer occupy separate stable layout bounds',t=>{
  const {dashboard}=fixture(t),layout=dashboard.layout();
  assert.equal(layout.divider.top,1);assert.equal(layout.divider.bottom,44);
  assert.ok(layout.events.left>layout.divider.left);assert.ok(layout.chat.right<layout.divider.left);
  assert.ok(layout.input.top>layout.chat.bottom);assert.ok(layout.footer.top>layout.input.bottom);
  const rendered=renderDashboard({state,columns:150,rows:44});
  assert.match(stripVTControlCharacters(rendered.lines[0]),/Credits:/);
  assert.doesNotMatch(rendered.lines.join('\n'),/\/ for commands/);
});
test('composer caret survives header refresh and panel scrolling without visibility cycling',t=>{
  let date=new Date('2026-10-08T12:00:00Z');const {output,dashboard}=fixture(t,{now:()=>date});
  assert.equal(typeof dashboard.setInput,'function');
  dashboard.setInput({prompt:'12:00 01@you > ',text:'https://example.com/path',cursor:8});
  output.text='';date=new Date('2026-10-08T12:00:01Z');dashboard.refresh();
  assert.doesNotMatch(output.text,/\x1b\[\?25[hl]/,'A header tick must not restart cursor visibility');
  dashboard.event('event\n'.repeat(60));output.text='';dashboard.scrollPanel('events','top');
  assert.doesNotMatch(output.text,/\x1b\[\?25[hl]/);assert.ok(output.text.endsWith(dashboard.inputCursor().sequence));
});
test('hidden composer values never appear in rendered output or retained viewport',t=>{
  const {output,dashboard}=fixture(t);assert.equal(typeof dashboard.setInput,'function');
  output.text='';dashboard.setInput({prompt:'API key: ',text:'PRIVATE_HIDDEN_VALUE',cursor:20,hidden:true});
  dashboard.redraw();assert.doesNotMatch(output.text,/PRIVATE_HIDDEN_VALUE/);assert.equal(dashboard.scrollState().characters,0);
});
test('picker redraw is clipped to chat and restores the search caret',t=>{
  const {output,dashboard}=fixture(t);assert.equal(typeof dashboard.renderMenu,'function');
  dashboard.event('EVENT_STAYS');output.text='';
  dashboard.renderMenu({lines:['Search: /color','  /textcolor'],cursor:{row:0,column:14}});
  assert.doesNotMatch(output.text,/\x1b\[J|EVENT_STAYS/,'Picker may not clear or repaint the right sidebar');
  assert.equal(dashboard.inputCursor().column,dashboard.menuArea().left+14);
});
test('suspend preserves both anchors and resume restores composer after a resize',t=>{
  const {output,dashboard}=fixture(t);assert.equal(typeof dashboard.suspend,'function');
  dashboard.write('history\n'.repeat(80));dashboard.event('events\n'.repeat(60));dashboard.scrollPanel('chat','top');dashboard.scrollPanel('events','top');
  dashboard.setInput({prompt:'12:00 01@you > ',text:'draft λ',cursor:7});dashboard.suspend();output.text='';
  dashboard.event('WHILE_GUI');dashboard.refresh();assert.equal(output.text,'');
  output.columns=110;output.emit('resize');assert.equal(output.text,'');dashboard.resume();
  assert.equal(dashboard.scrollState().top,0);assert.equal(dashboard.eventsState().top,0);assert.match(output.text,/draft λ/);
});
test('compact panel switching keeps chat and events distinct and leaves an editable composer',t=>{
  const {output,dashboard}=fixture(t,{columns:70,rows:24});assert.equal(typeof dashboard.focusPanel,'function');
  dashboard.write('COMPACT_CHAT');dashboard.event('COMPACT_EVENT');output.text='';dashboard.focusPanel('events');
  assert.match(output.text,/COMPACT_EVENT/);assert.doesNotMatch(output.text,/COMPACT_CHAT/);
  assert.match(output.text,/Performance \(This PC\)/);assert.match(output.text,/CPU: 12/);
  assert.ok(dashboard.inputArea().rows>=1);assert.equal(dashboard.layout().compact,true);
});
test('compact performance overflow is explicit and leaves bounded Events/composer rows',t=>{
  const many={...state,performance:{...state.performance,gpu:{adapters:Array.from({length:4},(_,index)=>({name:'Adapter '+index,id:String(index),identified:true,percent:null,vramTotalBytes:8*1024**3}))}}};
  const {output,dashboard}=fixture(t,{columns:70,rows:24,snapshot:()=>many});output.text='';dashboard.focusPanel('events');
  assert.match(output.text,/More: enlarge terminal/);assert.ok(dashboard.eventsState().visibleRows>=3);assert.equal(dashboard.inputArea().rows,3);
});
test('event retention is bounded independently of complete chat retention',t=>{
  const {dashboard}=fixture(t,{maxEventCharacters:64});assert.equal(typeof dashboard.event,'function');
  dashboard.write('full-chat\n'.repeat(100));dashboard.event('event\n'.repeat(100));
  assert.equal(dashboard.scrollState().trimmed,0);assert.ok(dashboard.eventsState().trimmed>0);assert.ok(dashboard.eventsState().characters<=64);
});
test('wide header divider stays in one terminal cell column for joined emoji and Unicode status text',()=>{
  const rendered=renderDashboard({state:{...state,chatTitle:'Chat 👩‍💻 🇬🇷',connectedAI:'モデル 🚀',cwd:'/demo-👩‍💻'},columns:150,rows:44});
  const segments=new Intl.Segmenter(undefined,{granularity:'grapheme'});
  const cellCount=value=>[...segments.segment(value)].reduce((total,{segment})=>total+(/\p{Emoji_Presentation}|\p{Regional_Indicator}/u.test(segment)?2:[...segment].reduce((count,char)=>count+(/\p{Mark}|\p{Default_Ignorable_Code_Point}/u.test(char)?0:char.codePointAt(0)>=0x2e80&&char.codePointAt(0)<=0xa4cf?2:1),0)),0);
  for(const value of rendered.lines){const prefix=stripVTControlCharacters(value).split('│')[0];assert.equal(cellCount(prefix),rendered.mainWidth,'Status text moved the divider');}
});
test('all tiny terminal coordinates remain positive and inside the actual screen',t=>{
  for(const rows of [1,2,4,8])for(const columns of [1,12,35]){
    const {dashboard,output}=fixture(t,{rows,columns});dashboard.setInput({prompt:'12:00 01@you > ',text:'λ',cursor:1});dashboard.redraw();
    for(const match of output.text.matchAll(/\x1b\[(\d+);(\d+)H/g)){assert.ok(Number(match[1])>=1&&Number(match[1])<=rows);assert.ok(Number(match[2])>=1&&Number(match[2])<=columns);}
  }
});
for(const mode of ['wide','compact-chat','compact-events']){
  test(`closing picker restores every obscured pane row and the composer: ${mode}`,t=>{
    const compact=mode.startsWith('compact'),output=Object.assign(new EventEmitter(),{isTTY:true,columns:compact?70:150,rows:compact?24:44,text:'',write(text){this.text+=text;}});
    const dashboard=createDashboard({output,snapshot:()=>({cwd:'/demo',working:false}),env:{TERM:'xterm'},color:false,tickMs:0});
    dashboard.start();t.after(()=>dashboard.stop());
    dashboard.write('ORIGINAL_CHAT\n');dashboard.event('ORIGINAL_EVENT\n');
    if(mode==='compact-events')dashboard.focusPanel('events');
    dashboard.renderMenu({lines:['Commands','Search: /local','STALE_MENU'],cursor:{row:1,column:14}});
    output.text='';dashboard.setInput({prompt:'12:00 01@you > ',text:'/local',cursor:6});
    const pane=dashboard.layout()[mode==='compact-events'?'events':'chat'];
    assert.match(output.text,mode==='compact-events'?/ORIGINAL_EVENT/:/ORIGINAL_CHAT/);
    if(!compact)assert.doesNotMatch(output.text,/ORIGINAL_EVENT/,'Closing a picker must not repaint the independent Events pane');
    for(let row=pane.top;row<=pane.bottom;row++)assert.ok(output.text.includes(`\x1b[${row};${pane.left}H`),`Obscured row ${row} was not restored`);
    assert.doesNotMatch(output.text,/STALE_MENU|\x1b\[2J|\x1b\[\?25[hl]/);
    assert.match(output.text,/12:00 01@you > \/local/);
    assert.ok(output.text.endsWith(dashboard.inputCursor().sequence),'Editing caret must be restored last');
    output.text='';dashboard.setInput({prompt:'12:00 01@you > ',text:'/local ',cursor:7});
    assert.doesNotMatch(output.text,/ORIGINAL_CHAT|ORIGINAL_EVENT/,'Ordinary typing must repaint only the composer');
  });
}

