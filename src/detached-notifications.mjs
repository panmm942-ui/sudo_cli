import {join} from 'node:path';
import {createNotifications} from './notifications.mjs';
import {backgroundNotificationEvent,createBackgroundResultReporter} from './assistant-features.mjs';

const silentOutput=Object.freeze({isTTY:false});
const unavailableMessage='Notification sound unavailable. Check audio settings and /notify status.';

function bounded(operation,timeoutMs){
  return new Promise((resolve,reject)=>{
    const timer=setTimeout(()=>reject(new Error('Notification operation timed out.')),timeoutMs);
    Promise.resolve().then(operation).then(resolve,reject).finally(()=>clearTimeout(timer));
  });
}

/** Read saved preferences for each outcome; a detached worker has no BEL fallback. */
export async function playDetachedNotification({stateDir,event,id,notificationsFactory=createNotifications,log=()=>{},timeoutMs=4000}){
  let controller,outcome,unavailable=false;
  try{
    controller=notificationsFactory({directory:join(stateDir,'preferences'),interactive:true,output:silentOutput,timeoutMs,maxQueue:1});
    outcome=await bounded(()=>controller.notify(event,{id}),timeoutMs+250);
    unavailable=['unavailable','cancelled','busy'].includes(outcome?.status);
  }catch{
    unavailable=true;outcome={status:'unavailable',event};
  }finally{
    if(controller)try{await bounded(()=>controller.close(),1000);}catch{unavailable=true;}
  }
  if(unavailable)try{await bounded(()=>log('notification',unavailableMessage),1000);}catch{}
  return outcome;
}

export function createDetachedTaskReporter({work,stateDir,notificationsFactory=createNotifications,log=()=>{}}){
  const pending=new Set();let closed=false;
  const notify=outcome=>{
    if(closed||outcome.notificationSuppressed)return;
    const playback=playDetachedNotification({stateDir,event:backgroundNotificationEvent(outcome),id:outcome.notificationId,notificationsFactory,log});
    pending.add(playback);playback.finally(()=>pending.delete(playback));return playback;
  };
  return {...createBackgroundResultReporter({work,onResult:notify,onAttention:notify}),async close(){closed=true;await Promise.allSettled([...pending]);}};
}
