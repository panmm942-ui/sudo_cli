import {spawn as nativeSpawn} from 'node:child_process';
import {win32} from 'node:path';
import {isolatedEnvironment} from './permission-scope.mjs';

/** Open the user's browser without invoking a command shell or changing its sandbox. */
export async function openGui(value,{platform=process.platform,geteuid=process.geteuid?.bind(process),spawn=nativeSpawn,env=process.env}={}){
  let url;try{url=new URL(value);}catch{throw new Error('GUI requires its local browser address.');}
  if(url.protocol!=='http:'||url.hostname!=='127.0.0.1'||!url.port||url.username||url.password||url.pathname!=='/'||url.search||!/^#token=[a-f0-9]{64}$/.test(url.hash))throw new Error('GUI requires its local browser address.');
  const fallback={opened:false,url:url.href,reason:'Open this local address in your normal browser.'};
  if(['linux','darwin'].includes(platform)&&geteuid?.()===0)return fallback;
  const systemRoot=Object.entries(env).find(([name])=>name.toUpperCase()==='SYSTEMROOT')?.[1]||'C:\\Windows';
  if(platform==='win32'&&!/^[a-z]:\\[^\r\n]*$/i.test(systemRoot))return fallback;
  const launchers={win32:[win32.join(systemRoot,'System32','rundll32.exe'),[win32.join(systemRoot,'System32','url.dll')+',FileProtocolHandler',url.href]],darwin:['/usr/bin/open',[url.href]],linux:['/usr/bin/xdg-open',[url.href]]};
  const selected=launchers[platform];if(!selected)return fallback;
  const browserEnvironment=isolatedEnvironment(env);
  if(platform==='linux')for(const name of ['DISPLAY','WAYLAND_DISPLAY','DBUS_SESSION_BUS_ADDRESS','XAUTHORITY'])if(typeof env[name]==='string')browserEnvironment[name]=env[name];
  return new Promise(resolve=>{
    let settled=false,timer,child;
    const finish=opened=>{if(settled)return;settled=true;clearTimeout(timer);resolve(opened?{opened:true,url:url.href}:fallback);};
    try{child=spawn(selected[0],selected[1],{shell:false,windowsHide:true,stdio:'ignore',env:browserEnvironment});child.once('error',()=>finish(false));child.once('exit',code=>finish(code===0));if(!settled)timer=setTimeout(()=>{try{child.kill?.();}catch{}finish(false);},3000);}
    catch{finish(false);}
  });
}
