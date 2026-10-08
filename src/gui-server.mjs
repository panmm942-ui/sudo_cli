import {createServer} from 'node:http';
import {randomBytes,timingSafeEqual} from 'node:crypto';
import {readFile} from 'node:fs/promises';

const MAX_BODY=128*1024,MAX_RESPONSE=2*1024*1024;
const securityHeaders={
  'cache-control':'no-store','x-content-type-options':'nosniff','x-frame-options':'DENY','referrer-policy':'no-referrer',
  'cross-origin-opener-policy':'same-origin',
  'content-security-policy':"default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self' data:; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
  'permissions-policy':'camera=(), microphone=(), geolocation=()'
};
function action(input){
  if(!input||typeof input!=='object'||Array.isArray(input))throw new Error('action');
  const fields={submit:['type','text','literal'],answer:['type','text','promptId'],stop:['type'],return:['type'],changes:['type','path']}[input.type];
  if(!fields||Object.keys(input).some(key=>!fields.includes(key)))throw new Error('action');
  if(['submit','answer'].includes(input.type)&&(typeof input.text!=='string'||Buffer.byteLength(input.text)>65536||input.type==='submit'&&!input.text.trim()))throw new Error('action');
  if(input.type==='answer'&&(typeof input.promptId!=='string'||!input.promptId||input.promptId.length>128||/[\u0000-\u001f\u007f]/.test(input.promptId)))throw new Error('action');
  if(input.path!==undefined&&(typeof input.path!=='string'||!input.path||input.path.length>4096||/[\u0000-\u001f\u007f]/.test(input.path)))throw new Error('action');
  if(input.literal!==undefined&&typeof input.literal!=='boolean')throw new Error('action');
  return Object.fromEntries(fields.filter(key=>input[key]!==undefined).map(key=>[key,input[key]]));
}

/** A presentation channel only. The caller owns session state, permissions and all AI resources. */
export async function startGuiServer({getSnapshot,onAction}={}){
  if(typeof getSnapshot!=='function'||typeof onAction!=='function')throw new Error('GUI requires shared session callbacks.');
  const assets=new Map();
  for(const [path,name,type]of [['/','index.html','text/html; charset=utf-8'],['/app.js','app.js','text/javascript; charset=utf-8'],['/style.css','style.css','text/css; charset=utf-8']]){
    const body=await readFile(new URL('./gui/'+name,import.meta.url));if(body.length>512*1024)throw new Error('GUI asset exceeds its size bound.');assets.set(path,{body,type});
  }
  const token=randomBytes(32).toString('hex'),expected=Buffer.from('Bearer '+token);
  let origin,host,closed=false,returning=false,closing;
  const send=(res,status,value)=>{
    if(res.destroyed||res.writableEnded)return;
    let body;
    try{body=JSON.stringify(value);if(body===undefined)throw new Error('state');}catch{status=500;body='{"error":"GUI state is unavailable."}';}
    if(Buffer.byteLength(body)>MAX_RESPONSE){status=413;body='{"error":"GUI response exceeds its size bound."}';}
    res.writeHead(status,{...securityHeaders,'content-type':'application/json; charset=utf-8'});res.end(body);
  };
  const server=createServer({maxHeaderSize:8192},async(req,res)=>{
    try{
      if(closed)return send(res,410,{error:'GUI session is closed.'});
      if(req.headers.host!==host||req.headers.origin!==undefined&&req.headers.origin!==origin||['cross-site','same-site'].includes(req.headers['sec-fetch-site']))return send(res,403,{error:'GUI origin is not allowed.'});
      if(req.method==='GET'&&assets.has(req.url)){
        const asset=assets.get(req.url);res.writeHead(200,{...securityHeaders,'content-type':asset.type});res.end(asset.body);return;
      }
      if(!['/api/state','/api/action'].includes(req.url))return send(res,404,{error:'GUI endpoint not found.'});
      const provided=Buffer.from(typeof req.headers.authorization==='string'?req.headers.authorization:'');
      if(provided.length!==expected.length||!timingSafeEqual(provided,expected))return send(res,401,{error:'GUI authentication required.'});
      if(req.url==='/api/state'){
        if(req.method!=='GET')return send(res,405,{error:'Use GET for GUI state.'});
        try{return send(res,200,await getSnapshot());}catch{return send(res,503,{error:'GUI state is unavailable.'});}
      }
      if(req.method!=='POST')return send(res,405,{error:'Use POST for GUI actions.'});
      if(returning)return send(res,409,{error:'GUI return is in progress.'});
      if(req.headers.origin!==origin)return send(res,403,{error:'GUI origin is required.'});
      if(!/^application\/json(?:\s*;\s*charset=utf-8)?$/i.test(req.headers['content-type']||''))return send(res,415,{error:'Use JSON for GUI actions.'});
      const length=Number(req.headers['content-length']);
      if(Number.isFinite(length)&&length>MAX_BODY)return send(res,413,{error:'GUI request exceeds its size bound.'});
      let size=0;const chunks=[];
      for await(const chunk of req){size+=chunk.length;if(size>MAX_BODY){send(res,413,{error:'GUI request exceeds its size bound.'});return;}chunks.push(chunk);}
      let input;
      try{input=action(JSON.parse(Buffer.concat(chunks).toString('utf8')));}catch{return send(res,400,{error:'Invalid bounded GUI action.'});}
      if(closed)return send(res,410,{error:'GUI session is closed.'});
      if(returning)return send(res,409,{error:'GUI return is in progress.'});
      try{
        if(input.type==='return')returning=true;
        const result=await onAction(input);
        if(input.type==='return')res.once('finish',()=>{void close().catch(()=>{});});
        send(res,200,{result:result??null});
      }catch{if(input.type==='return')returning=false;send(res,409,{error:'The action could not be completed. Inspect the session events or current question.'});}
    }catch{send(res,400,{error:'GUI request could not be read.'});}
  });
  server.headersTimeout=5000;server.requestTimeout=10000;server.keepAliveTimeout=1000;
  await new Promise((resolve,reject)=>{server.once('error',reject);server.listen(0,'127.0.0.1',()=>{server.removeListener('error',reject);resolve();});});
  host='127.0.0.1:'+server.address().port;origin='http://'+host;
  function close(){
    if(!closing){closed=true;closing=new Promise((resolve,reject)=>{server.close(error=>error?reject(error):resolve());server.closeAllConnections();});}
    return closing;
  }
  return {url:origin+'/#token='+token,close};
}
