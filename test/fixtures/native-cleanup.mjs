import {rm} from 'node:fs/promises';

const trackedFixtures=new WeakMap();
async function attemptCleanups(steps){
  const failures=[];
  for(const cleanup of steps)try{await cleanup();}catch(error){failures.push(error);}
  if(failures.length===1)throw failures[0];
  if(failures.length)throw new AggregateError(failures,'Native fixture cleanup failed.');
}
async function closeServer(server){server.closeAllConnections();await new Promise((resolve,reject)=>server.close(error=>error?reject(error):resolve()));}
export function trackNativeFixture(t,{server,cleanup}){
  let resources=trackedFixtures.get(t);
  if(!resources){
    resources={servers:new Set(),cleanups:[]};trackedFixtures.set(t,resources);
    t.after(async()=>{try{await attemptCleanups([...resources.servers].map(server=>()=>closeServer(server)).concat(resources.cleanups));}finally{trackedFixtures.delete(t);}});
  }
  if(server)resources.servers.add(server);
  if(cleanup)resources.cleanups.push(cleanup);
}

export async function cleanupNativeFixture({engine,bridge,server,home,workspace}){
  // The engine may reject while deleting its own temporary home. Always close the
  // loopback servers too, so a cleanup failure cannot keep the test runner alive.
  await attemptCleanups([
    ()=>engine?.close(),
    ()=>bridge?.close(),
    ()=>closeServer(server),
    ()=>home?.cleanup(),
    ()=>rm(workspace,{recursive:true,force:true,maxRetries:5,retryDelay:100}),
  ]);
}
