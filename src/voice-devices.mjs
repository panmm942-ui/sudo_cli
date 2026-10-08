import {spawn} from 'node:child_process';
/** Device discovery never records microphone audio. FFmpeg lists names on stderr. */
export async function listMicrophoneDevices({platform=process.platform,execute}={}){
  const spec=platform==='win32'?['ffmpeg',['-hide_banner','-list_devices','true','-f','dshow','-i','dummy']]:platform==='darwin'?['ffmpeg',['-hide_banner','-f','avfoundation','-list_devices','true','-i','']]:platform==='linux'?['pactl',['list','short','sources']]:undefined;
  if(!spec)throw new Error('Microphone discovery supports Windows, Linux and macOS.');
  const run=execute||((file,args)=>new Promise((resolve,reject)=>{let text='',overflow=false;const child=spawn(file,args,{shell:false,windowsHide:true,stdio:['ignore','pipe','pipe']});const timer=setTimeout(()=>{child.kill();reject(new Error('Device discovery timed out.'));},10000);const collect=chunk=>{text+=chunk;if(text.length>65536){overflow=true;child.kill();}};child.stdout.on('data',collect);child.stderr.on('data',collect);child.once('error',()=>{clearTimeout(timer);reject(new Error('Install FFmpeg (Windows/macOS) or pactl (Linux) to list audio devices.'));});child.once('close',()=>{clearTimeout(timer);if(overflow)reject(new Error('Device list exceeded its limit.'));else resolve(text);});}));
  const output=String(await run(...spec)).replace(/[\u001b\u0000-\u0008\u000b-\u001f\u007f]/g,'').slice(0,65536);
  return output+'\nChoose a microphone with /microphone device NAME (macOS: audio index). This command does not record audio.';
}
