import {stripVTControlCharacters} from 'node:util';
import {createPrivateRecord} from './private-state.mjs';

export const DEFAULT_TERMINAL_COLORS=Object.freeze({bgcolor:'#0b0f14',txtcolor:'#00ff00'});
const BODY_TEXT_COLOR='#dce3eb';
const NAMED_COLORS=Object.freeze({
  black:'#000000',white:'#ffffff',red:'#ff0000',green:'#008000',lime:'#00ff00',blue:'#0000ff',
  cyan:'#00ffff',aqua:'#00ffff',magenta:'#ff00ff',fuchsia:'#ff00ff',yellow:'#ffff00',orange:'#ffa500',
  purple:'#800080',pink:'#ffc0cb',gray:'#808080',grey:'#808080',silver:'#c0c0c0',
  darkgray:'#a9a9a9',darkgrey:'#a9a9a9',lightgray:'#d3d3d3',lightgrey:'#d3d3d3',
  navy:'#000080',teal:'#008080',olive:'#808000',maroon:'#800000',brown:'#a52a2a',nearblack:'#0b0f14',
});
const ANSI_COLORS=['#000000','#800000','#008000','#808000','#000080','#800080','#008080','#c0c0c0','#808080','#ff0000','#00ff00','#ffff00','#0000ff','#ff00ff','#00ffff','#ffffff'];
const rgb=hex=>[1,3,5].map(start=>parseInt(hex.slice(start,start+2),16));
const hex=values=>'#'+values.map(value=>Number(value).toString(16).padStart(2,'0')).join('');
const foreground=value=>'\x1b[38;2;'+rgb(value).join(';')+'m';
const background=value=>'\x1b[48;2;'+rgb(value).join(';')+'m';
const luminance=value=>rgb(value).map(channel=>{const c=channel/255;return c<=0.04045?c/12.92:((c+0.055)/1.055)**2.4;}).reduce((sum,c,index)=>sum+c*[0.2126,0.7152,0.0722][index],0);
export function contrastRatio(first,second){const a=luminance(first),b=luminance(second);return (Math.max(a,b)+0.05)/(Math.min(a,b)+0.05);}
function readable(requested,bg){
  if(contrastRatio(requested,bg)>=4.5)return requested;
  return contrastRatio('#000000',bg)>=contrastRatio('#ffffff',bg)?'#000000':'#ffffff';
}
function validateTarget(target){if(!Object.hasOwn(DEFAULT_TERMINAL_COLORS,target))throw new Error('Unknown terminal color setting. Choose bgcolor or txtcolor.');return target;}
export function parseTerminalColor(value,target='bgcolor'){
  validateTarget(target);
  if(typeof value!=='string'||/[\u0000-\u0020\u007f-\u009f]/u.test(value))throw new Error('Invalid color. Use a named color, #RRGGBB, or default.');
  const normalized=value.toLowerCase();
  if(['default','normal','reset'].includes(normalized))return DEFAULT_TERMINAL_COLORS[target];
  const result=NAMED_COLORS[normalized]||normalized;
  if(!/^#[a-f0-9]{6}$/.test(result))throw new Error('Invalid color. Use a named color, #RRGGBB, or default.');
  return result;
}
function paletteColor(index){
  if(index<16)return ANSI_COLORS[index];
  if(index<232){const value=index-16,channel=n=>n===0?0:55+40*n;return hex([channel(Math.floor(value/36)),channel(Math.floor(value/6)%6),channel(value%6)]);}
  return hex(Array(3).fill(8+10*(index-232)));
}

/** Saved colors only apply below the fixed dashboard. Requested user colors remain recoverable. */
export function createTerminalTheme({directory,color=true,env=process.env,onChange=()=>{}}={}){
  const enabled=!!color&&!env.NO_COLOR&&env.TERM!=='dumb';
  let state={...DEFAULT_TERMINAL_COLORS},record,queue=Promise.resolve();
  const getRecord=async()=>record||(directory?(record=await createPrivateRecord({directory,filename:'terminal-theme.json',maxBytes:2048})):undefined);
  const get=()=>{
    const effectiveTxtcolor=readable(state.txtcolor,state.bgcolor),bodyForeground=readable(BODY_TEXT_COLOR,state.bgcolor);
    return {...state,effectiveTxtcolor,bodyForeground,adjusted:effectiveTxtcolor!==state.txtcolor,contrast:contrastRatio(effectiveTxtcolor,state.bgcolor)};
  };
  const bodyStyle=()=>enabled?background(state.bgcolor)+foreground(get().bodyForeground):'';
  const userStyle=()=>enabled?background(state.bgcolor)+foreground(get().effectiveTxtcolor):'';
  const serial=fn=>{const action=queue.then(fn);queue=action.catch(()=>{});return action;};
  async function commit(next){await (await getRecord())?.write({version:1,...next});state=next;await onChange(get());return get();}
  function styleBodyText(text,{user=false}={}){
    const value=String(text??'');
    if(!enabled)return value.replace(/\x1b\[[\d;]*m/g,'');
    const baseline=user?userStyle:bodyStyle;
    const baselineForeground=()=>user?get().effectiveTxtcolor:get().bodyForeground;
    const styled=value.replace(/\x1b\[([\d;]*)m/g,(_sequence,parameters)=>{
      const parts=(parameters||'0').split(';').map(Number);let result='';
      for(let index=0;index<parts.length;index++){
        const code=parts[index];
        if(code===0){result+='\x1b[0m'+baseline();continue;}
        if(code===39){result+=foreground(baselineForeground());continue;}
        if(code===49){result+=background(state.bgcolor);continue;}
        if((code>=40&&code<=47)||(code>=100&&code<=107)){result+=background(state.bgcolor);continue;}
        if((code>=30&&code<=37)||(code>=90&&code<=97)){result+=foreground(user?baselineForeground():readable(ANSI_COLORS[code>=90?code-90+8:code-30],state.bgcolor));continue;}
        if(code===38||code===48){
          let requested;
          if(parts[index+1]===2&&parts.slice(index+2,index+5).length===3&&parts.slice(index+2,index+5).every(n=>Number.isInteger(n)&&n>=0&&n<=255)){requested=hex(parts.slice(index+2,index+5));index+=4;}
          else if(parts[index+1]===5&&Number.isInteger(parts[index+2])&&parts[index+2]>=0&&parts[index+2]<=255){requested=paletteColor(parts[index+2]);index+=2;}
          if(requested)result+=code===48?background(state.bgcolor):foreground(user?baselineForeground():readable(requested,state.bgcolor));
          continue;
        }
        // Reverse, faint and conceal can defeat the foreground/background contrast guarantee.
        if(code===2||code===7||code===8)continue;
        result+='\x1b['+code+'m';
      }
      return result;
    });
    return baseline()+styled+baseline();
  }
  return {
    get,
    get enabled(){return enabled;},
    get backgroundStyle(){return enabled?background(state.bgcolor):'';},
    get bodyStyle(){return bodyStyle();},
    get userStyle(){return userStyle();},
    load:()=>serial(async()=>{const saved=await (await getRecord())?.read();if(saved){if(saved.version!==1)throw new Error('Unsupported saved terminal color settings.');state={bgcolor:parseTerminalColor(saved.bgcolor,'bgcolor'),txtcolor:parseTerminalColor(saved.txtcolor,'txtcolor')};}return get();}),
    set:(target,value)=>serial(async()=>{validateTarget(target);return commit({...state,[target]:parseTerminalColor(value,target)});}),
    reset:(target='all')=>serial(async()=>{if(['all','theme','colors'].includes(target))return commit({...DEFAULT_TERMINAL_COLORS});validateTarget(target);return commit({...state,[target]:DEFAULT_TERMINAL_COLORS[target]});}),
    styleBackground:(text='')=>enabled?background(state.bgcolor)+String(text)+bodyStyle():stripVTControlCharacters(String(text)),
    styleUserText:(text='')=>enabled?userStyle()+stripVTControlCharacters(String(text))+bodyStyle():stripVTControlCharacters(String(text)),
    styleUserInput:(text='')=>styleBodyText(text,{user:true}),
    styleBodyText,
  };
}
