import fs from 'node:fs';
import path from 'node:path';
import {uid,now,hash} from './store.mjs';
import {profile,secret,redact,transferFile,saveSftpAccess} from './connection.mjs';

const reserved=new Set(['main','container','__proto__','constructor','prototype']);
function fieldName(key){
  const phpName=/^[a-zA-Z0-9_.-]+(?:\[[a-zA-Z0-9_.-]*\])*$/;
  if(!phpName.test(key)||key.split(/[\[\]]/).some(part=>reserved.has(part))){
    throw Error('Invalid or reserved parameter: '+key);
  }
}
function fields(input,prefix='',result=[]){
  for(const [key,value]of Object.entries(input)){
    fieldName(key);
    const name=prefix?`${prefix}[${key}]`:key;
    if(value!==null&&typeof value==='object')fields(value,name,result);
    else if(value!==undefined)result.push([name,value===null?'':typeof value==='boolean'?(value?'1':'0'):String(value)]);
  }
  return result;
}
export class Admin {
  constructor(config,store,catalog){
    this.config=config;this.store=store;this.catalog=catalog;this.profile=profile(config);
    this.directory=path.join(config.runtime,'admin-results');fs.mkdirSync(this.directory,{recursive:true});
    this.store.db.exec('CREATE TABLE IF NOT EXISTS admin_results(id TEXT PRIMARY KEY,operation TEXT NOT NULL,status INTEGER NOT NULL,ok INTEGER NOT NULL,bytes INTEGER NOT NULL,file TEXT NOT NULL,created_at TEXT NOT NULL)');
    this.sequence=Promise.resolve();this.lastRequest=0;
  }
  status(){const p=this.profile;return {configured:!!p?.api,environment:p?.environment??'local-test',origin:p?.api?new URL(p.api.url).origin:null,credentialReady:!!p?.api?.apiKeyEnv&&!!process.env[p.api.apiKeyEnv],catalogOperations:this.catalog.length,execution:'configured operation IDs only'};}
  async run(args){
    return this.runExclusive(()=>this.execute(args));
  }
  runExclusive(task){
    const next=this.sequence.then(task);
    this.sequence=next.catch(()=>{});
    return next;
  }
  async execute({id,query={},body={},files=[],format='auto',method:requestedMethod},privateResult){
    const p=this.profile;if(!p?.api)throw Error('Configure a site API connection first');
    const operation=this.catalog.find(o=>o.id===id);if(!operation)throw Error('Unknown catalog operation');
    const method=requestedMethod??operation.method;if(!(operation.methods??[operation.method]).includes(method))throw Error('HTTP method is not supported by this operation');
    const schema=operation.operationsByMethod?.[method]??operation.operation;
    const credential=secret(p.api.apiKeyEnv);
    const url=new URL(operation.path??'/Files/Controllers/ControllersAll.php',p.api.url);
    if(url.origin!==new URL(p.api.url).origin)throw Error('Operation points outside configured site');
    const routing=operation.routing??{main:operation.main,container:operation.container};
    for(const [k,v]of Object.entries(routing))url.searchParams.set(k,v);
    for(const [k,v]of fields(query)){if(Object.hasOwn(routing,k))throw Error('Operation routing cannot be overridden');url.searchParams.append(k,v);}
    if(method==='GET'&&(Object.keys(body).length||files.length))throw Error('GET operation accepts query fields only');
    const headers={'X-API-Key':credential,'Accept':'application/json'};
    let payload;
    if(method!=='GET'){
      if(files.length){
        const form=new FormData();for(const [k,v]of fields(body))form.append(k,v);
        for(const file of files){
          fieldName(file.field);
          const full=transferFile(this.config,this.store,file);
          form.append(file.field,new Blob([fs.readFileSync(full)]),path.basename(full));
        }
        payload=form;
      }else{
        const media=Object.keys(schema?.requestBody?.content??{});
        const chosen=format==='auto'?(media.includes('application/json')?'json':'form'):format;
        fields(body);  
        if(chosen==='json'){headers['Content-Type']='application/json';payload=JSON.stringify(body);}
        else{headers['Content-Type']='application/x-www-form-urlencoded';payload=new URLSearchParams(fields(body));}
      }
    }
    const delay=Math.max(0,550-(Date.now()-this.lastRequest));if(delay)await new Promise(r=>setTimeout(r,delay));
    this.lastRequest=Date.now();
    const response=await fetch(url,{method,headers,body:payload,redirect:'manual',signal:AbortSignal.timeout(45000)});
    if(response.status>=300&&response.status<400)throw Error('API redirected; request was not forwarded with credentials');
    const reader=response.body?.getReader();const chunks=[];let bytes=0;
    if(reader)while(true){const {done,value}=await reader.read();if(done)break;bytes+=value.length;if(bytes>8*1024*1024){await reader.cancel();throw Error('API response exceeds 8 MiB result budget');}chunks.push(value);}
    const buffer=Buffer.concat(chunks),mime=(response.headers.get('Content-Type')??'').split(';')[0].toLowerCase();
    let value;
    if(mime&&!/^(?:text\/|application\/(?:json|xml|javascript))/.test(mime)){
      const disposition=response.headers.get('Content-Disposition')??'';
      const extension=disposition.match(/\.([a-z0-9]{2,5})(?:["';\s]|$)/i)?.[1]?.toLowerCase();
      const suffix=['zip','png','jpg','jpeg','webp','pdf','csv','po','mo'].includes(extension)?'.'+extension:mime==='application/zip'?'.zip':'.bin';
      const file=uid()+suffix;fs.writeFileSync(path.join(this.config.imports,file),buffer);
      value={download:{importFile:file,bytes:buffer.length,mime,sha256:hash(buffer)}};
    }else{try{value=JSON.parse(buffer.toString('utf8').replace(/^\uFEFF/,''));}catch{value={text:buffer.toString('utf8'),applicationAcknowledged:false};}}
    if(privateResult)await privateResult(value,response.status);
    value=redact(value,[credential,value?.access?.password,value?.data?.connection?.password,...(p.sftp?.passwordEnv?[process.env[p.sftp.passwordEnv]]:[])]);
    const businessError=['error','failed','fail'].includes(value?.status)||value?.success===false||value?.ok===false;
    const ok=response.ok&&!businessError;
    const resultId=uid(),file=path.join(this.directory,resultId+'.json');
    fs.writeFileSync(file,JSON.stringify(value));
    this.store.db.prepare('INSERT INTO admin_results VALUES (?,?,?,?,?,?,?)').run(resultId,id,response.status,ok?1:0,Buffer.byteLength(JSON.stringify(value)),file,now());
    this.store.audit('admin.execute',resultId,{operation:id,method,status:response.status,ok,queryFields:Object.keys(query),bodyFields:Object.keys(body),fileFields:files.map(f=>f.field)});
    return {resultId,operation:id,environment:p.environment,status:response.status,ok,retryAfter:response.headers.get('Retry-After'),...this.result({id:resultId,limit:5})};
  }
  async prepareSftp({theme='',fullSync=false}={}){
    if(!this.profile?.sftp?.useProvisionedAccess)throw Error('Enable useProvisionedAccess for API-created SFTP credentials');
    const operation=this.catalog.find(o=>o.main==='Templates'&&o.container==='TemplatesSftpAccessController');
    if(!operation)throw Error('Site SFTP provisioning operation is missing from the catalog');
    let access,sync;
    const body={domain:new URL(this.profile.api.url).hostname,sync_mode:fullSync?'full':'quick',...(theme?{theme}:{})};
    const result=await this.execute({id:operation.id,body},value=>{if(value?.status!=='success'||!value.access?.username||!value.access?.password)throw Error('Site did not issue SFTP access');access=value.access;sync=value.sync??{};});
    const expected=this.profile.sftp;
    if(expected.host&&expected.host!==access.host)throw Error('Provisioned SFTP host differs from configured host');
    if(expected.port&&expected.port!==Number(access.port))throw Error('Provisioned SFTP port differs from configured port');
    saveSftpAccess(this.config,this.profile,access);
    this.store.audit('sftp.prepare',result.resultId,{theme,fullSync});
    const moduleSources=(sync.moduleSources?.exported??[]).map(item=>({path:item.path,files:item.written?.length??0,conflicts:(item.conflicts??[]).slice(0,20),totalConflicts:item.conflicts?.length??0}));
    return {ready:true,host:access.host,port:access.port,username:access.username,theme:access.theme,environment:this.profile.environment,resultId:result.resultId,sync:{moduleSources,requestedFull:fullSync,imported:sync.imported??0,exported:sync.exported??0,errors:redact(sync.errors??[],[access.password,secret(this.profile.api.apiKeyEnv)]),ok:!(sync.errors?.length)},hint:'Credentials encrypted for the configured profile. An upload is applied by the site only after successful mirror import.'};
  }
  result({id,offset=0,limit=10,pointer=''}){
    const record=this.store.db.prepare('SELECT * FROM admin_results WHERE id=?').get(id);if(!record)throw Error('Admin result not found');
    let value=JSON.parse(fs.readFileSync(record.file,'utf8'));
    if(pointer){
      if(!pointer.startsWith('/'))throw Error('Use a JSON pointer such as /data');
      for(const part of pointer.slice(1).split('/').map(p=>p.replace(/~1/g,'/').replace(/~0/g,'~'))){if(reserved.has(part)||value===null||typeof value!=='object'||!Object.hasOwn(value,part))throw Error('Result pointer not found');value=value[part];}
    }
    let data,total,kind;
    if(Array.isArray(value)){kind='array';total=value.length;data=value.slice(offset,offset+limit);}
    else if(value&&typeof value==='object'){
      kind='object';const entries=Object.entries(value);total=entries.length;
      data=Object.fromEntries(entries.slice(offset,offset+limit).map(([k,v])=>[k,Array.isArray(v)?{type:'array',length:v.length,first:v.slice(0,Math.min(3,limit)),pointer:pointer+'/'+k}:v]));
    }else{kind=typeof value;total=1;data=value;}
    const serialized=JSON.stringify(data);
    if(Buffer.byteLength(serialized)>12000)data={truncated:true,preview:serialized.slice(0,6000),hint:'Use pointer and pagination to inspect a smaller part'};
    return {id,ok:!!record.ok,httpStatus:record.status,pointer,kind,total,offset,data};
  }
}
