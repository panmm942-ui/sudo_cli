import { stripVTControlCharacters } from 'node:util';
import { basename } from 'node:path';
import { VERSION } from './version.mjs';
import { ANTENNA_ROWS, renderAntenna, createAntennaClock, BACKGROUND_STYLE, FPS } from './antenna.mjs';
import {createChatViewport} from './chat-viewport.mjs';
import {performanceDetails} from './performance-view.mjs';

const LOGO = [
  ' ____  _   _ ____   ___      ____ _     ___ ',
  '/ ___|| | | |  _ \\ / _ \\    / ___| |   |_ _|',
  '\\___ \\| | | | | | | | | |  | |   | |    | | ',
  ' ___) | |_| | |_| | |_| |  | |___| |___ | | ',
  '|____/ \\___/|____/ \\___/    \\____|_____|___|',
];
export const ART = LOGO.join('\r\n');
const LOGO_COLOR = '38;2;239;41;41';
const CREDITS = 'Credits: instagram.com/mimilidhcc/ | github.com/panmm942-ui';
const SHORT_CREDITS = 'Credits: @mimilidhcc | GitHub: panmm942-ui';

export function workedTime(milliseconds = 0) {
  const seconds = Math.max(0, Math.floor(Number(milliseconds || 0) / 1000));
  return [Math.floor(seconds / 3600), Math.floor(seconds / 60) % 60, seconds % 60].map(value => String(value).padStart(2, '0')).join(':');
}
const clean = value => stripVTControlCharacters(String(value ?? '')).replace(/[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/g, '').replace(/[\r\n\t]/g, ' ');
const cellWidth = character => {
  const code = character.codePointAt(0);
  if (/\p{Mark}/u.test(character)) return 0;
  return (code >= 0x1100 && (code <= 0x115f || code === 0x2329 || code === 0x232a || (code >= 0x2e80 && code <= 0xa4cf) || (code >= 0xac00 && code <= 0xd7a3) || (code >= 0xf900 && code <= 0xfaff) || (code >= 0xfe10 && code <= 0xfe6f) || (code >= 0xff01 && code <= 0xff60) || (code >= 0xffe0 && code <= 0xffe6) || (code >= 0x1f300 && code <= 0x1faff) || code >= 0x20000)) ? 2 : 1;
};
const terminalGraphemes=new Intl.Segmenter(undefined,{granularity:'grapheme'});
const graphemeCells=value=>/\p{Emoji_Presentation}|\p{Regional_Indicator}|\u20e3/u.test(value)||value.includes('\ufe0f')&&/\p{Extended_Pictographic}/u.test(value)?2:[...value].reduce((sum,part)=>sum+(part==='\u200d'||/\p{Mark}|\p{Default_Ignorable_Code_Point}/u.test(part)?0:cellWidth(part)),0);
const width = value => [...terminalGraphemes.segment(clean(value))].reduce((count,{segment})=>count+graphemeCells(segment),0);
function fit(value, columns) {
  const plain = clean(value);
  if (width(plain) <= columns) return plain;
  let result = '', count = 0;
  for (const {segment} of terminalGraphemes.segment(plain)) { const cells = graphemeCells(segment); if (count + cells > Math.max(0, columns - 1)) break; result += segment; count += cells; }
  return columns > 0 ? result + '~' : '';
}
function wrap(value,columns){
  if(columns<=0)return [];
  const lines=[];let line='';
  for(const word of clean(value).split(/\s+/).filter(Boolean)){
    const next=line?line+' '+word:word;
    if(line&&width(next)>columns){lines.push(line);line=fit(word,columns);}
    else line=fit(next,columns);
  }
  if(line)lines.push(line);
  return lines;
}

function performanceLines(groups,columns,paint){
  const lines=[];
  for(const [index,group] of groups.entries()){
    if(index)lines.push('');
    if(group.title)lines.push(...wrap(group.title,columns).map(line=>paint(37,line)));
    for(const item of group.fields){
      const label=item.label+': ',value=clean(item.value),code=item.code??37;
      if(width(label+value)<=columns)lines.push(paint(90,label)+paint(code,value));
      else {lines.push(...wrap(item.label+':',columns).map(line=>paint(90,line)));lines.push(...wrap(value,Math.max(1,columns-2)).map(line=>'  '+paint(code,line)));}
    }
  }
  return lines;
}

export function describeSystem({ platform = process.platform, arch = process.arch } = {}) {
  return `${({ win32: 'Windows', linux: 'Linux', darwin: 'macOS' })[platform] || platform} (${arch})`;
}

const clockFormatters = new Map();
function clock(date, timeZone) {
  let formatter=clockFormatters.get(timeZone);
  if(!formatter){formatter=new Intl.DateTimeFormat('en-GB', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23', timeZoneName: 'short', numberingSystem: 'latn' });clockFormatters.set(timeZone,formatter);}
  const parts = Object.fromEntries(formatter.formatToParts(date).map(part => [part.type, part.value]));
  return `${parts.year}-${parts.month}-${parts.day} ${parts.hour}:${parts.minute}:${parts.second} ${parts.timeZoneName}`;
}

function contextText(context, columns) {
  if (context?.used == null) return context?.limit ? `Unknown / ${context.limit.toLocaleString('en-US')} tokens` : 'Unknown';
  const percentage = context.percent == null ? '?%' : `~${context.percent}%`;
  const numeric = value => value == null ? 'unknown' : value.toLocaleString('en-US');
  const full = `${percentage} ${numeric(context.used)}/${numeric(context.limit)} tokens`;
  if (full.length <= columns) return full;
  const compact = value => value == null ? '?' : new Intl.NumberFormat('en-US', { notation: 'compact', maximumFractionDigits: 1 }).format(value);
  return `${percentage} ${compact(context.used)}/${compact(context.limit)} tokens`;
}

export function trafficRate(bytes) {
  if (!Number.isFinite(bytes) || bytes < 0) return 'Measuring';
  const units = ['B/s', 'KiB/s', 'MiB/s', 'GiB/s']; let unit = 0;
  while (bytes >= 1024 && unit < units.length - 1) { bytes /= 1024; unit++; }
  return `${unit ? bytes.toFixed(1) : Math.round(bytes)} ${units[unit]}`;
}

export function renderDashboard({ state, columns = 100, rows = 24, color = false, now = new Date(), timeZone, platform = process.platform, arch = process.arch, activity = 'Idle', antennaElapsed = 0, antennaIdle = !state.working }) {
  columns = Math.max(1, Math.floor(columns || 80) - 1); rows = Math.max(1, Math.floor(rows || 24));
  const paint = (code, text) => color ? `\x1b[${code}m${text}\x1b[0m${BACKGROUND_STYLE}` : text;
  const logoWidth = Math.max(...LOGO.map(line => line.length));
  const sidebar=columns>=109&&rows>=16;
  const panelWidth=sidebar?Math.min(40,Math.max(28,Math.floor(columns*.27))):0;
  const mainWidth=columns-(sidebar?panelWidth+1:0);
  const big = mainWidth >= logoWidth + 61 && rows >= LOGO.length + ANTENNA_ROWS.length + 9;
  const artWidth = Math.max(...ANTENNA_ROWS.map(line => line.length));
  const leftWidth = big ? logoWidth : artWidth;
  const beside = mainWidth >= leftWidth + 36;
  const details=state.performance?performanceDetails(state.performance):[];
  // Keep identified physical cards readable when virtual counter groups exist.
  const performance=details.some(group=>group.identified===true)?details.filter(group=>group.identified!==false):details;
  const available = beside ? mainWidth - leftWidth - 3 : mainWidth;
  const field = (label, value, code = 37) => paint(90, `${label}: `) + paint(code, fit(value, Math.max(0, available - label.length - 2)));
  const quality = state.health?.percent;
  const qualityColor = quality == null ? 90 : quality > 70 ? 32 : quality > 50 ? '38;5;208' : 31;
  const qualityLabel = quality == null ? 'Not measured' : `${quality}% ${quality > 70 ? 'Good' : quality > 50 ? 'Fair' : 'Bad'}`;
  const latency = state.health?.latencyMs;
  const measured=state.health?.firstTokenLatencyMs??latency;
  const qualityText = (state.healthPercent?qualityLabel+' | ':'')+(measured==null?'Not measured':`First token ${(measured/1000).toFixed(2)}s`)+(state.health?.errorRate==null?'':` | Errors ${Math.round(state.health.errorRate*100)}%`)+(state.health?.pending?' waiting':'');
  const fields = [
    field('Time', clock(now, timeZone)),
    field('Software System', describeSystem({ platform, arch })),
    field('Status', state.working ? 'Working' : 'Not Working', state.working ? 32 : 31),
    field('WiFi Connection', state.network?.wifi || 'Unknown', state.network?.wifi === 'Yes' ? 32 : state.network?.wifi === 'No' ? 31 : 90),
    ...(state.network?.wifi === 'Yes' ? [field('Live Traffic', `Download: ${trafficRate(state.network.downloadBps)} | Upload: ${trafficRate(state.network.uploadBps)}`)] : []),
    field('Connected AI', state.connectedAI || (state.configuredModel?`${state.configuredModel} (unconfirmed)`:'No AI selected')),
    field('AI Connection', qualityText, qualityColor),
    ...(state.health?.generationTokensPerSecond==null?[]:[field('Generation',state.health.generationTokensPerSecond.toFixed(1)+' tokens/s (reported)')]),
    field('Context', contextText(state.context, available - 9)),
    field('Permissions', state.permissions === 'allow-everything' ? 'Allow Everything' : 'Ask', state.permissions === 'allow-everything' ? '38;5;208' : 37),
    ...(state.scope?[field('Scope',state.scope)]:[]),
    field('Web Access', state.webAccess ? 'On' : 'Off', state.webAccess ? 32 : 90),
    field('Effort', state.effort || 'Provider default'),
    field('Worked', `${workedTime(state.worked?.sessionMs)} | In Total: ${workedTime(state.worked?.totalMs)}`),
    ...(state.chatTitle?[field('Chat',state.chatTitle)]:[]),
    ...(state.voice?[field('Voice',state.voice.status|| (state.voice.running?'Listening':'Off'),state.voice.running?32:90)]:[]),
    ...(state.agent?[field('24/7 Agent',state.agent.state||state.agent.phase||state.agent.status||'Idle')]:[]),
    ...(state.verification?[field('Last Check',state.verification,state.verification==='Verified'?32:state.verification==='Failed'?31:'38;5;208')]:[]),
    field('Activity', activity),
    field('Project', basename(String(state.cwd || '').replace(/\\/g, '/')) || '/'),
  ];
  let lines;
  if (beside) {
    const antenna = renderAntenna({ elapsed: antennaElapsed, idle: antennaIdle, color });
    const left = big ? [...LOGO.map(line => paint(LOGO_COLOR, line)), '', ...antenna] : [paint(LOGO_COLOR, 'SUDO CLI'), ...antenna];
    lines = Array.from({ length: Math.max(left.length, fields.length) }, (_, index) => {
      const value = left[index] || '';
      const status=fields[index]||'';
      return value + ' '.repeat(Math.max(0, leftWidth-width(value))) + '   ' + status;
    });
    lines.push('');
  } else lines = [paint(LOGO_COLOR, 'SUDO CLI'), ...fields];
  lines.unshift(paint(90,fit(mainWidth>=CREDITS.length?CREDITS:SHORT_CREDITS,mainWidth)),'');
  const performanceContent=[paint(37,'Performance (This PC)'),'',...performanceLines(performance,sidebar?panelWidth:columns,paint)];
  const limit=Math.max(1,rows-8);
  lines=lines.slice(0,limit);
  if(sidebar){
    const headerRows=Math.min(limit,Math.max(lines.length,performanceContent.length));
    lines=Array.from({length:headerRows},(_,index)=>{
      const main=lines[index]||'';
      const item=index===headerRows-1&&performanceContent.length>headerRows?paint(90,'More: enlarge terminal'):performanceContent[index]||'';
      return main+' '.repeat(Math.max(0,mainWidth-width(main)))+paint(90,'│')+item;
    });
  }
  if (color) lines[0] = BACKGROUND_STYLE + lines[0];
  const footer=fit(`v${VERSION} | / commands | Tab: Chat/Events | PgUp/PgDn Home/End | Context: reported`,columns);
  if (rows<12||columns<=logoWidth) return {lines:[(color?BACKGROUND_STYLE:'')+paint(LOGO_COLOR,fit('SUDO CLI | Enlarge terminal',columns))],height:1,sticky:false,sidebar:false,mainWidth:columns,performance:performanceContent,footer};
  return {lines,height:lines.length,sticky:true,sidebar,mainWidth,panelWidth,performance:performanceContent,footer};
}

/** Bounded terminal panes; all cursor painting belongs to this renderer. */
export function createDashboard({output=process.stdout,snapshot,now=()=>new Date(),monotonic=()=>performance.now(),timeZone,platform,arch,activity=()=> 'Idle',color=output.isTTY&&!process.env.NO_COLOR,env=process.env,tickMs=1000/FPS,onResize=()=>{},theme,maxBodyCharacters,maxEventCharacters=128*1024}){
  let started=false,alternate=false,suspended=false,timer,last='',current,rectangles,focus='chat',input,menu,cursor;
  const body=createChatViewport({maxCharacters:maxBodyCharacters}),events=createChatViewport({maxCharacters:Number.isFinite(maxEventCharacters)?Math.max(1,Math.min(1024*1024,Math.floor(maxEventCharacters))):128*1024});
  const antennaClock=createAntennaClock({now:monotonic});
  const enabled=()=>color&&!!output.isTTY&&!env.NO_COLOR&&env.TERM!=='dumb';
  const bodyTheme=()=>enabled()?(typeof theme==='function'?theme():theme):undefined;
  const bodyStyle=()=>bodyTheme()?.bodyStyle||(enabled()?BACKGROUND_STYLE:'');
  const style=(text,user=false)=>{const selected=bodyTheme();return selected?(user?selected.styleUserText(text):selected.styleBodyText(text)):String(text);};
  const headerStyle=()=>enabled()?BACKGROUND_STYLE:'';
  const view=()=>{
    const state=snapshot(),elapsed=antennaClock.elapsed(!!state.working),rendered=renderDashboard({state,columns:output.columns||80,rows:output.rows||24,color:enabled(),now:now(),timeZone,platform,arch,activity:activity(),antennaElapsed:elapsed,antennaIdle:!antennaClock.hasWorked()});
    if(!rendered.sidebar&&rendered.sticky&&focus==='events'){
      const lines=[rendered.lines[0],'',...rendered.performance],limit=Math.max(1,(output.rows||24)-8);
      const visible=lines.slice(0,limit);if(lines.length>limit)visible[visible.length-1]=enabled()?'\x1b[90mMore: enlarge terminal'+BACKGROUND_STYLE:'More: enlarge terminal';
      return {...rendered,lines:visible,height:visible.length};
    }
    return rendered;
  };
  const segmenter=terminalGraphemes,cells=graphemeCells;
  function crop(value,limit){
    let result='',used=0;
    for(const token of String(value).split(/(\x1b\[[\d;]*m)/)){
      if(/^\x1b\[[\d;]*m$/.test(token)){result+=token;continue;}
      for(const {segment} of segmenter.segment(stripVTControlCharacters(token).replace(/[\u0000-\u001f\u007f-\u009f]/g,''))){const size=cells(segment);if(used+size>limit)return {text:result,width:used};result+=segment;used+=size;}
    }
    return {text:result,width:used};
  }
  const at=(row,column)=>`\x1b[${row};${column}H`;
  function row(rect,index,value='',user=false,header=false){
    const columns=Math.max(0,rect.right-rect.left+1),part=crop(header?value:style(value,user),columns);
    return at(rect.top+index,rect.left)+(header?headerStyle():bodyStyle())+part.text+(header?headerStyle():bodyStyle())+' '.repeat(Math.max(0,columns-part.width));
  }
  function arrange(){
    current=view();const columns=Math.max(1,(output.columns||80)-1),rows=Math.max(1,output.rows||24);
    const right=current.sidebar,main=right?current.mainWidth:columns;
    const footerTop=rows,composerRows=Math.min(3,Math.max(1,rows-current.height-3)),composerTop=Math.min(Math.max(1,rows-1),Math.max(current.height+2,footerTop-composerRows));
    const bodyTop=Math.min(composerTop-1,current.height+1),contentTop=Math.min(composerTop-1,bodyTop+1),contentBottom=Math.max(contentTop,composerTop-1);
    rectangles={compact:!right,header:{top:1,bottom:Math.min(rows,current.height),left:1,right:columns},chat:{top:Math.max(1,contentTop),bottom:Math.max(1,contentBottom),left:1,right:main},events:{top:Math.max(1,contentTop),bottom:right?rows:Math.max(1,contentBottom),left:right?main+2:1,right:columns},input:{top:composerTop,bottom:Math.max(composerTop,footerTop-1),left:1,right:main,rows:Math.max(1,footerTop-composerTop),columns:main},footer:{top:footerTop,bottom:rows,left:1,right:main},titles:{top:Math.max(1,bodyTop),bottom:Math.max(1,bodyTop),left:1,right:main},divider:right?{top:1,bottom:rows,left:main+1,right:main+1}:undefined};
    body.resize({columns:Math.max(1,rectangles.chat.right-rectangles.chat.left),rows:Math.max(1,rectangles.chat.bottom-rectangles.chat.top+1)});
    events.resize({columns:Math.max(1,rectangles.events.right-rectangles.events.left),rows:Math.max(1,rectangles.events.bottom-rectangles.events.top+1)});
  }
  function scrollState(name){
    const rect=rectangles[name],{lines,...value}=(name==='events'?events:body).view(),height=Math.max(1,rect.bottom-rect.top+1);
    const thumbRows=Math.max(1,Math.min(height,Math.round(height*Math.min(height,value.totalRows)/Math.max(1,value.totalRows))));
    const maxOffset=Math.max(0,value.totalRows-value.visibleRows),thumbTop=rect.top+(maxOffset?Math.round(value.top/maxOffset*(height-thumbRows)):0);
    return {...value,focused:focus===name,scrollbar:{column:rect.right,top:rect.top,bottom:rect.bottom,thumbTop,thumbRows,maxOffset}};
  }
  function drawPanel(name,{indicatorOnly=false}={}){
    const rect=rectangles[name],viewport=name==='events'?events:body,state=scrollState(name),value=viewport.view();
    const titleRect={top:Math.max(1,rect.top-1),bottom:Math.max(1,rect.top-1),left:rect.left,right:rect.right};
    let result=row(titleRect,0,`${focus===name?'›':' '} ${name==='events'?'Events / Notifications':'Chat'}${state.unseen?' · New output':''}${state.trimmed?' · Older display text trimmed':''}`);
    if(!indicatorOnly){
      const content={...rect,right:rect.right-1};
      for(let index=0;index<state.visibleRows;index++){
        const line=value.lines[index]||[],painted=line.map(part=>style(part.text,part.user)).join('');
        result+=row(content,index,painted);
      }
    }
    for(let index=rect.top;index<=rect.bottom;index++)result+=at(index,rect.right)+style(index>=state.scrollbar.thumbTop&&index<state.scrollbar.thumbTop+state.scrollbar.thumbRows?'█':'│');
    return result;
  }
  function composer(){
    if(!input){let result='';for(let index=0;index<rectangles.input.rows;index++)result+=row(rectangles.input,index);return result;}
    const area=rectangles.input,columns=Math.max(1,area.columns),prompt=clean(input.prompt),text=input.hidden?'':String(input.text).replace(/\r/g,'').replace(/[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/g,'');
    const prefix=prompt+(input.hidden?'':text.slice(0,input.cursor)),whole=prompt+text;
    let lines=[''],line=0,column=0,caretLine=0,caretColumn=0,position=0;
    for(const {segment} of segmenter.segment(whole)){
      if(position===prefix.length){caretLine=line;caretColumn=column;}
      const size=segment==='\t'?Math.min(columns,8-column%8):cells(segment);
      if(segment==='\n'){lines.push('');line++;column=0;}
      else {if(column&&column+size>=columns){lines.push('');line++;column=0;}lines[line]+=segment==='\t'?' '.repeat(size):segment;column+=size;}
      position+=segment.length;
    }
    if(position<=prefix.length){caretLine=line;caretColumn=column;}
    const first=Math.max(0,caretLine-area.rows+1);let result='';
    for(let index=0;index<area.rows;index++)result+=row(area,index,lines[first+index]||'',true);
    cursor={row:area.top+caretLine-first,column:area.left+Math.min(columns-1,caretColumn)};cursor.sequence=at(cursor.row,cursor.column)+bodyStyle();
    return result;
  }
  function menuPaint(){
    if(!menu)return '';
    const area=menuArea();let result='';
    for(let index=0;index<area.rows;index++)result+=row({top:area.top,left:area.left,right:area.left+area.columns-1},index,menu.lines?.[index]||'',index===(menu.cursor?.row??0));
    cursor={row:Math.min(area.bottom,area.top+(menu.cursor?.row??0)),column:Math.min(area.left+area.columns-1,area.left+(menu.cursor?.column??0))};cursor.sequence=at(cursor.row,cursor.column)+bodyStyle();return result;
  }
  const menuArea=()=>{const rect=rectangles.chat;return {top:rect.top,bottom:rectangles.input.bottom,left:rect.left,columns:Math.max(1,rect.right-rect.left),rows:Math.max(1,rectangles.input.bottom-rect.top+1)};};
  function restore(){return cursor?.sequence||bodyStyle();}
  function emit(value){if(!started||suspended)return;if(!alternate){output.write(value);return;}output.write('\x1b7'+value+'\x1b8'+restore());}
  function lower(){
    let result='';if(rectangles.compact)result+=drawPanel(focus);else result+=drawPanel('chat')+drawPanel('events');
    result+=row(rectangles.footer,0,current.footer);result+=composer()+menuPaint();
    if(rectangles.divider)for(let line=1;line<=rectangles.divider.bottom;line++)result+=at(line,rectangles.divider.left)+style('│');
    return result;
  }
  function redraw(){
    if(!started||suspended)return;arrange();last=current.lines.join('\n');
    if(alternate){let value='\x1b[r'+headerStyle()+'\x1b[2J';current.lines.forEach((line,index)=>{value+=row(rectangles.header,index,line,false,true);});emit(value+lower());}
    else output.write(current.lines.join('\n')+'\n');onResize();
  }
  function refresh(){
    if(!started||suspended)return;const next=view(),text=next.lines.join('\n');
    if(text===last)return;if(next.height!==current.height||next.sidebar!==current.sidebar)return redraw();
    if(!alternate){const withoutClock=value=>value.split('\n').filter(line=>!/(?:Time|Worked):/.test(stripVTControlCharacters(line))).join('\n');if(withoutClock(text)!==withoutClock(last))output.write(text+'\n');last=text;current=next;return;}
    last=text;current=next;let value='';current.lines.forEach((line,index)=>{value+=row(rectangles.header,index,line,false,true);});emit(value);
  }
  function navigate(name,delta,metadata){
    if(!started||!alternate||!['chat','events'].includes(name))return false;
    const viewport=name==='events'?events:body;
    if(delta==='top')viewport.top();else if(delta==='bottom')viewport.bottom();else if(delta==='page-up')viewport.pageUp();else if(delta==='page-down')viewport.pageDown();else if(delta==='pointer'){
      const state=scrollState(name);if(metadata?.x!==state.scrollbar.column)return false;
      const ratio=Math.max(0,Math.min(1,(metadata.y-state.scrollbar.top)/Math.max(1,state.scrollbar.bottom-state.scrollbar.top)));viewport.scroll(Math.round(state.scrollbar.maxOffset*ratio)-state.top);
    }else viewport.scroll(delta);
    if(started&&alternate&&!suspended&&(!rectangles.compact||focus===name))emit(drawPanel(name));return true;
  }
  const api={
    start(){if(started)return;started=true;alternate=!!output.isTTY&&env.TERM!=='dumb';arrange();if(alternate)output.write('\x1b[?1049h\x1b[?25l\x1b[2J\x1b[H');redraw();if(alternate)output.write('\x1b[?25h');output.on?.('resize',redraw);if(alternate&&tickMs>0){const tick=()=>{if(!started)return;const before=performance.now();refresh();timer=setTimeout(tick,Math.max(0,tickMs-(performance.now()-before)));timer.unref?.();};timer=setTimeout(tick,tickMs);timer.unref?.();}},
    refresh,redraw,layout:()=>structuredClone(rectangles),inputArea:()=>({...rectangles.input}),menuArea,inputCursor:()=>cursor?{...cursor}:undefined,
    setInput(value){const hadMenu=!!menu;input=value?{prompt:String(value.prompt||''),text:String(value.text||''),cursor:Math.max(0,Math.min(String(value.text||'').length,Number.isFinite(value.cursor)?Math.floor(value.cursor):String(value.text||'').length)),hidden:!!value.hidden}:undefined;menu=undefined;if(!input)cursor=undefined;if(started&&alternate&&!suspended)emit((hadMenu?drawPanel(rectangles.compact?focus:'chat'):'')+composer());},
    renderMenu(value){menu=value?.active===false?undefined:value;if(started&&alternate&&!suspended)emit(menu?menuPaint():lower());},
    isScrolled:()=>body.isScrolled(),scrollState:()=>scrollState('chat'),eventsState:()=>scrollState('events'),
    get managed(){return started&&alternate&&!suspended;},
    focusPanel(name){const next=name==='next'?(focus==='chat'?'events':'chat'):name;if(!['chat','events'].includes(next))return false;focus=next;menu=undefined;if(started&&alternate&&!suspended){if(rectangles.compact)redraw();else emit(lower());}return true;},
    panelAt({x,y}={}){if(!Number.isFinite(x)||!Number.isFinite(y))return undefined;if(rectangles.compact)return y>=rectangles.chat.top-1&&y<=rectangles.chat.bottom?focus:undefined;for(const name of ['chat','events']){const rect=rectangles[name];if(x>=rect.left&&x<=rect.right&&y>=rect.top-1&&y<=rect.bottom)return name;}return undefined;},
    scrollPanel:navigate,scroll:delta=>navigate('chat',delta),pageUp:()=>navigate('chat','page-up'),pageDown:()=>navigate('chat','page-down'),scrollToTop:()=>navigate('chat','top'),scrollToBottom:()=>navigate('chat','bottom'),
    replaceBody(chunks=[]){body.replace(chunks);if(started&&alternate&&!suspended)emit(rectangles.compact&&focus!=='chat'?'':drawPanel('chat'));},
    clearBody(){body.clear();if(started&&alternate&&!suspended)emit(rectangles.compact&&focus!=='chat'?'':drawPanel('chat'));},
    remember(text,{user=false}={}){body.append(String(text),{user:!!user});},
    write(text,{user=false}={}){const value=String(text);body.append(value,{user:!!user});if(suspended)return;if(started&&alternate){if(!rectangles.compact||focus==='chat')emit(drawPanel('chat',{indicatorOnly:body.isScrolled()}));}else output.write(style(value,!!user));},
    event(text){const raw=String(text),value=raw.endsWith('\n')?raw:raw+'\n';events.append(value);if(suspended)return;if(started&&alternate){if(!rectangles.compact||focus==='events')emit(drawPanel('events',{indicatorOnly:events.isScrolled()}));}else output.write(style(value));},
    suspend(){if(suspended)return;suspended=true;if(alternate)output.write('\x1b[r\x1b[0m\x1b[?25h\x1b[?1049l');},
    resume(){if(!started||!suspended)return;suspended=false;if(alternate)output.write('\x1b[?1049h\x1b[?25l');redraw();if(alternate)output.write('\x1b[?25h');},
    stop(){if(!started)return;started=false;clearTimeout(timer);output.removeListener?.('resize',redraw);if(alternate&&!suspended)output.write('\x1b[r\x1b[0m\x1b[?25h\x1b[?1049l');alternate=false;input=undefined;menu=undefined;},
  };arrange();return api;
}
