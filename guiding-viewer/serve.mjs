import http from 'node:http';
import {readFile} from 'node:fs/promises';
import {fileURLToPath} from 'node:url';
import path from 'node:path';
import {execFile} from 'node:child_process';

const root=fileURLToPath(new URL('.',import.meta.url));
const mime={'.html':'text/html; charset=utf-8','.js':'text/javascript; charset=utf-8','.css':'text/css; charset=utf-8','.json':'application/json','.gz':'application/gzip'};
const args=process.argv.slice(2);
const option=name=>{const i=args.indexOf(name);return i<0?null:args[i+1];};
let port=Number(option('--port')||(args[0]&&!args[0].startsWith('--')?args[0]:8765));
if(!Number.isInteger(port)||port<1||port>65535) throw Error('Port must be an integer from 1 to 65535.');
const snapshot=option('--snapshot')?path.resolve(option('--snapshot')):null;
const server=http.createServer(async(req,res)=>{
  try {
    const name=decodeURIComponent(new URL(req.url,'http://localhost').pathname);
    if(name==='/viewer-config.json') {
      res.writeHead(200,{'Content-Type':'application/json','Cache-Control':'no-store'});
      res.end(JSON.stringify(snapshot?{name:path.basename(snapshot),url:'/snapshot.json'}:{}));return;
    }
    if(name==='/snapshot.json'&&snapshot) {
      const data=await readFile(snapshot);
      res.writeHead(200,{'Content-Type':'application/json','Cache-Control':'no-store'});res.end(data);return;
    }
    const target=path.resolve(root,'.'+(name==='/'?'/index.html':name));
    if(!target.startsWith(root)||!['GET','HEAD'].includes(req.method)) {res.writeHead(403);res.end();return;}
    const data=await readFile(target);
    res.writeHead(200,{'Content-Type':mime[path.extname(target)]||'application/octet-stream','Cache-Control':'no-store'});
    res.end(req.method==='HEAD'?undefined:data);
  }catch {res.writeHead(404);res.end('Not found');}
});
let attempts=0;
server.on('error',error=>{
  if(error.code==='EADDRINUSE'&&attempts++<20&&port<65535) {port++;server.listen(port,'127.0.0.1');}
  else {console.error(error.message);process.exitCode=1;}
});
server.on('listening',()=>{
  const url=`http://127.0.0.1:${port}/`;
  console.log(`Guiding viewer: ${url}`);
  if(snapshot) console.log(`Snapshot: ${snapshot}`);
  console.log('Press Ctrl+C to stop.');
  if(args.includes('--open')) {
    if(process.platform==='win32') execFile('cmd.exe',['/d','/s','/c',`start "" "${url}"`],{windowsHide:true});
    else execFile(process.platform==='darwin'?'open':'xdg-open',[url]);
  }
});
server.listen(port,'127.0.0.1');
