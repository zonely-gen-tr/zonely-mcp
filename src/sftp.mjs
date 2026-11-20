import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import Client from 'ssh2-sftp-client';
import {preparePanelSftp} from './panel-sftp.mjs';
import {hash,uid,now} from './store.mjs';
import {profile,secret,transferFile,loadSftpAccess,sftpProfileId} from './connection.mjs';

const textExtensions=new Set(['.tpl','.css','.js','.json','.po','.pot','.txt','.md','.svg','.xml','.yml','.yaml']);
const binaryExtensions=new Set(['.png','.jpg','.jpeg','.webp','.gif','.avif','.ico','.woff','.woff2','.ttf','.otf','.mo']);
const MAX_TEXT=2*1024*1024;
const MAX_TRANSFER=30*1024*1024;
const SFTP_WRITE_CHUNK=16*1024;
function relative(value=''){
  if(typeof value!=='string'||value.includes('\\')||/[\x00-\x1f\x7f]/.test(value)||value.startsWith('/')||value.split('/').some(p=>p==='..'||p==='.'||p.startsWith('.'))||value.includes(':'))throw Error('Invalid relative SFTP path');
  return value.replace(/\/+$/,'');
}
function fingerprint(value){
  if(/^[a-f0-9]{64}$/i.test(value??''))return value.toLowerCase();
  if(/^SHA256:[A-Za-z0-9+/]+={0,2}$/.test(value??''))return Buffer.from(value.slice(7),'base64').toString('hex');
  throw Error('Configure the SFTP SHA256 host key fingerprint');
}
function markers(text){return [...text.matchAll(/<!--\s*ZONELY:(?:HIDDEN|SCRIPT):[\s\S]*?-->|<z-ref\b[^>]*\/?\s*>|<zonely:ref\b[^>]*\/?\s*>|__ZN_SEGMENT_\d+__|\[%\s*server:[\s\S]*?%\]/gi)].map(m=>m[0]);}
export function validateText(file,content,before='',scope='themes'){
  if(!textExtensions.has(path.posix.extname(file).toLowerCase()))throw Error('This file is not an editable presentation/language file');
  if(Buffer.byteLength(content)>MAX_TEXT)throw Error('Text file exceeds 2 MiB');
  const moduleApiSource=scope==='modules'&&/^[a-z0-9][a-z0-9_-]*\/source\/(?:[a-zA-Z0-9_.-]+\/)?(?:api|module_api|apis)\/[a-zA-Z0-9_/-]+\.php\.txt$/i.test(file);
  if(moduleApiSource){
    if(Buffer.byteLength(content)>256*1024)throw Error('Module API source exceeds 256 KiB');
    return;
  }
  if(/<\?(?:php|=)?|<\s*(?:zonely:php|z-php)\b/i.test(content))throw Error('Use public Zonely template syntax; executable PHP is not permitted');
  const old=markers(before),fresh=markers(content);
  if(old.length!==fresh.length||old.some((v,i)=>v!==fresh[i]))throw Error('Protected Zonely backend references must remain unchanged');
  if(file.endsWith('.json'))JSON.parse(content);
}
async function overwriteTemplate(client,file,before,content){
  const sftp=client.sftp;
  const call=(method,...args)=>new Promise((resolve,reject)=>{
    sftp[method](...args,(error,value)=>error?reject(error):resolve(value));
  });
  const handle=await call('open',file,'r+');
  const read=async()=>{
    const stat=await call('fstat',handle);
    if(!stat.isFile()||!Number.isSafeInteger(stat.size)||stat.size<0||stat.size>MAX_TRANSFER)throw Error('Invalid template file size or type');
    const snapshot=Buffer.alloc(stat.size);
    for(let offset=0;offset<snapshot.length;){
      const readBytes=await call('read',handle,snapshot,offset,snapshot.length-offset,offset);
      if(!readBytes)throw Error('SFTP template changed during read');
      offset+=readBytes;
    }
    return snapshot;
  };
  const resize=size=>call('fsetstat',handle,{size});
  const write=(data,offset,length)=>call('write',handle,data,offset,length,offset);
  let written=0,attempted=0;
  try{
    if(!before.equals(await read()))throw Error('SFTP revision conflict; read file again');
    if(before.equals(content))return;
     
    if(content.length<before.length)await resize(before.length);
    try{
      while(written<content.length){
        attempted=Math.min(written+SFTP_WRITE_CHUNK,content.length);
        await write(content,written,attempted-written);
        written=attempted;
      }
      if(content.length<before.length)await resize(content.length);
      if(!content.equals(await read()))throw Error('SFTP template readback differs from the requested content');
    }catch(error){
      let recovery='remote state unverified; inspect the file before retrying';
      try{
        const current=await read();
        const matchesPrefix=length=>current.equals(Buffer.concat([content.subarray(0,length),before.subarray(length)]));
         
        if(!current.equals(before)&&(current.equals(content)||matchesPrefix(written)||matchesPrefix(attempted))){
          if(before.length)await write(before,0,before.length);
          if(current.length>before.length)await resize(before.length);
        }
        if(before.equals(await read()))recovery='original content verified';
      }catch{}
      throw Error(`${error.message}; ${recovery}`,{cause:error});
    }
  }finally{await call('close',handle);}
}
export class Sftp {
  constructor(config,store){
    this.config=config;this.store=store;this.profile=profile(config);this.sequence=Promise.resolve();
    this.backups=path.join(config.runtime,'sftp-backups');fs.mkdirSync(this.backups,{recursive:true});
    this.store.db.exec('CREATE TABLE IF NOT EXISTS sftp_backups(id TEXT PRIMARY KEY,scope TEXT NOT NULL,path TEXT NOT NULL,sha TEXT NOT NULL,file TEXT NOT NULL,existed INTEGER NOT NULL,created_at TEXT NOT NULL)');
    this.store.db.exec('CREATE TABLE IF NOT EXISTS sftp_backup_profiles(backup_id TEXT PRIMARY KEY REFERENCES sftp_backups(id), profile_id TEXT NOT NULL)');
  }
  prepareFromPanel(panel,{theme=''}={}){
    return this.serialized(async()=>{
      const access=await preparePanelSftp(panel,this.config.runtime,theme);
      this.profile={...this.profile,sftp:access.profile};
      this.panelPassword=access.password;
      return {ready:true,source:'templates',theme:access.theme,sync:{ok:true,imported:access.imported,exported:access.exported}};
    });
  }
  status(){
    const p=this.profile?.sftp;
    let access;
    if (p?.useProvisionedAccess) {
      try { access=loadSftpAccess(this.config,this.profile); } catch {}
    }
    return {configured:!!p,environment:this.profile?.environment??'local-test',host:p?.host??access?.host??null,port:p?.port??access?.port??22,roots:Object.keys(p?.roots??{}),hostKeyPinned:!!p?.hostFingerprint,credentialReady:!!p&&(!!process.env[p.passwordEnv]||!!process.env[p.privateKeyEnv]||!!p.privateKeyFile||!!access||!!this.panelPassword)};
  }
  async connected(work){
    const p=this.profile?.sftp;if(!p)throw Error('Configure the site SFTP connection first');
    const access=p.useProvisionedAccess?loadSftpAccess(this.config,this.profile):{};
    const expected=fingerprint(p.hostFingerprint);
    const client=new Client('zonely-mcp');
    const options={host:p.host??access.host,port:p.port??access.port??22,username:p.username??access.username,
      hostHash:'sha256',hostVerifier:value=>value===expected,readyTimeout:15000,retries:0};
    if(p.privateKeyEnv)options.privateKey=secret(p.privateKeyEnv);
    else if(p.privateKeyFile)options.privateKey=fs.readFileSync(p.privateKeyFile);
    else options.password=p.passwordEnv?secret(p.passwordEnv):(this.panelPassword??access.password);
    if(p.passphraseEnv)options.passphrase=secret(p.passphraseEnv);
    if(!options.host||!options.username||(!options.privateKey&&!options.password))throw Error('SFTP credentials are incomplete');
    try{await client.connect(options);return await work(client,p);}
    finally{await client.end().catch(()=>{});}
  }
  async target(client,p,scope,file,{create=false}={}){
    const configured=p.roots?.[scope];if(!configured||!configured.startsWith('/'))throw Error('SFTP scope is not configured');
    const root=await client.realPath(configured),rel=relative(file),full=path.posix.join(root,rel);
    const inside=actual=>actual===root||actual.startsWith(root.replace(/\/$/,'')+'/');
     
    let current=root;
    for(const component of rel.split('/').filter(Boolean)){
      current=path.posix.join(current,component);
      const exists=await client.exists(current);
      if(!exists){if(create)break;throw Error('SFTP path does not exist');}
      if(!inside(await client.realPath(current)))throw Error('SFTP path escapes configured root through a link');
    }
    if(!inside(full))throw Error('SFTP path escapes configured root');
    return {root,rel,full};
  }
  async probe(){return this.connected(async(c,p)=>{const roots={};for(const scope of Object.keys(p.roots??{})){const t=await this.target(c,p,scope,'');roots[scope]=await c.exists(t.full)==='d';}return {...this.status(),connected:true,roots};});}
  async list({scope='themes',path:file='',offset=0,limit=20}){return this.connected(async(c,p)=>{const t=await this.target(c,p,scope,file);const rows=(await c.list(t.full)).filter(r=>!r.name.startsWith('.')).sort((a,b)=>a.name.localeCompare(b.name));return {scope,path:t.rel,total:rows.length,offset,entries:rows.slice(offset,offset+limit).map(r=>({name:r.name,type:r.type,size:r.size,modified:r.modifyTime}))};});}
  async search({scope='themes',path:file='',query,maxFiles=60,limit=12}){return this.connected(async(c,p)=>{
    const queue=[file],matches=[];let scanned=0,bytes=0,directories=0;
    while(queue.length&&scanned<maxFiles&&matches.length<limit&&bytes<16*1024*1024&&directories<100){
      const current=queue.shift(),t=await this.target(c,p,scope,current),kind=await c.exists(t.full);
      if(kind==='d'){directories++;const entries=(await c.list(t.full)).filter(r=>!r.name.startsWith('.')&&r.type!=='l').sort((a,b)=>a.name.localeCompare(b.name));for(const r of entries)if(r.type==='d'||textExtensions.has(path.posix.extname(r.name).toLowerCase()))queue.push(path.posix.join(current,r.name));continue;}
      if(!textExtensions.has(path.posix.extname(current).toLowerCase()))continue;
      const stat=await c.stat(t.full);if(stat.size>MAX_TEXT||bytes+stat.size>16*1024*1024)continue;
      const buffer=await this.bytes(c,t);scanned++;bytes+=buffer.length;
      const lines=buffer.toString('utf8').split('\n');for(const [i,line]of lines.entries()){if(line.toLocaleLowerCase().includes(query.toLocaleLowerCase()))matches.push({path:t.rel,line:i+1,snippet:line.trim().slice(0,260),sha256:hash(buffer)});if(matches.length>=limit)break;}
    }
    return {scope,path:file,scannedFiles:scanned,scannedBytes:bytes,pendingPaths:queue.length,matches,bounded:true};
  });}
  async bytes(c,t,max=MAX_TEXT){const stat=await c.stat(t.full);if(stat.isDirectory||stat.size>max)throw Error('File is a directory or exceeds transfer size limit');const buffer=await c.get(t.full);if(buffer.length>max)throw Error('File grew beyond transfer size limit');return buffer;}
  async read({scope='themes',path:file,startLine=1,lineCount=120}){return this.connected(async(c,p)=>{const t=await this.target(c,p,scope,file);if(!textExtensions.has(path.posix.extname(t.rel).toLowerCase()))throw Error('Read supports text files only; use download for binary assets');const buffer=await this.bytes(c,t);const lines=buffer.toString('utf8').split('\n');const selected=lines.slice(startLine-1,startLine-1+lineCount).join('\n');return {scope,path:t.rel,sha256:hash(buffer),bytes:buffer.length,totalLines:lines.length,startLine,content:selected.slice(0,20000),truncated:selected.length>20000};});}
  serialized(work){const next=this.sequence.then(work);this.sequence=next.catch(()=>{});return next;}
  backup(scope,file,buffer,existed){
    const id=uid(),disk=path.join(this.backups,id+'.bin');
    fs.writeFileSync(disk,buffer,{mode:0o600});
    this.store.transaction(()=>{
      this.store.db.prepare('INSERT INTO sftp_backups VALUES (?,?,?,?,?,?,?)').run(id,scope,file,hash(buffer),disk,existed?1:0,now());
      this.store.db.prepare('INSERT INTO sftp_backup_profiles VALUES (?,?)').run(id,sftpProfileId(this.profile));
    });
    return id;
  }
  async finishWrite(c,t,scope,before,buffer,backupId){
    const saved=await this.bytes(c,t,MAX_TRANSFER).catch(error=>{
      throw Error('Remote readback failed; backup is available: '+backupId,{cause:error});
    });
    if(!saved.equals(buffer))throw Error('Remote readback differs; backup is available: '+backupId);
    const sha256=hash(saved);
    this.store.audit('sftp.write',backupId,{scope,path:t.rel,before:hash(before),after:sha256});
    return {scope,path:t.rel,sha256,bytes:saved.length,backupId,environment:this.profile.environment,applicationStatus:'uploaded-to-sftp; application import/render must be verified separately'};
  }
  async replace(c,p,scope,file,buffer,expectedHash,{create=false,validate=true}={}){
    relative(file);if(!file)throw Error('A file path is required');
    const t=await this.target(c,p,scope,file,{create}),exists=await c.exists(t.full);
    if(create&&exists)throw Error('File already exists');
    if(!create&&!exists)throw Error('File does not exist; create must be explicit');
    const before=exists?await this.bytes(c,t,MAX_TRANSFER):Buffer.alloc(0);
    if(exists&&hash(before)!==expectedHash)throw Error('SFTP revision conflict; read file again');
    if(validate)validateText(t.rel,buffer.toString('utf8'),before.toString('utf8'),scope);
    if(buffer.length>MAX_TRANSFER)throw Error('File exceeds 30 MiB');
    const parent=path.posix.dirname(t.full);if(await c.exists(parent)!=='d')throw Error('Create the parent directory first');
    const backupId=this.backup(scope,t.rel,before,!!exists);
    if(exists&&scope==='themes'&&path.posix.extname(t.rel).toLowerCase()==='.tpl'){
      if(exists!=='-')throw Error('The existing template must be a regular file');
      try{await overwriteTemplate(c,t.full,before,buffer);}
      catch(error){throw Error(`${error.message}; local backup: ${backupId}`,{cause:error});}
      return this.finishWrite(c,t,scope,before,buffer,backupId);
    }
    const temporary=path.posix.join(parent,`.zonely-mcp-${uid()}.tmp`);
    let committed=false;
    try{
      await c.put(buffer,temporary,{writeStreamOptions:{flags:'wx'}});
      if(hash(await c.get(temporary))!==hash(buffer))throw Error('Uploaded content hash mismatch');
       
      if(exists&&hash(await this.bytes(c,t,MAX_TRANSFER))!==expectedHash)throw Error('Remote file changed during upload');
      if(!exists&&await c.exists(t.full))throw Error('Remote file appeared during upload');
      const stat=exists?await c.stat(t.full):null;
      if(stat?.mode)await c.chmod(temporary,stat.mode&0o777);
       
      if(exists)await c.posixRename(temporary,t.full);else await c.rename(temporary,t.full);
      committed=true;
      return await this.finishWrite(c,t,scope,before,buffer,backupId);
    }finally{if(!committed&&await c.exists(temporary))await c.delete(temporary).catch(()=>{});}
  }
  write({scope='themes',path:file,content,expectedHash,create=false}){return this.serialized(()=>this.connected((c,p)=>this.replace(c,p,scope,file,Buffer.from(content),expectedHash,{create})));}
  patch({scope='themes',path:file,expectedHash,replacements}){return this.serialized(()=>this.connected(async(c,p)=>{
    const t=await this.target(c,p,scope,file);const before=await this.bytes(c,t);if(hash(before)!==expectedHash)throw Error('SFTP revision conflict; read file again');let content=before.toString('utf8');
    for(const {find,replace,count=1}of replacements){if(!find)throw Error('Patch find text cannot be empty');const found=content.split(find).length-1;if(found!==count)throw Error(`Patch match count differs: expected ${count}, found ${found}`);content=content.split(find).join(replace);}
    return this.replace(c,p,scope,file,Buffer.from(content),expectedHash);
  }));}
  mkdir({scope='themes',path:file}){return this.serialized(()=>this.connected(async(c,p)=>{const t=await this.target(c,p,scope,file,{create:true});if(!t.rel)throw Error('Directory path required');await c.mkdir(t.full,true);await this.target(c,p,scope,file);this.store.audit('sftp.mkdir',uid(),{scope,path:t.rel});return {scope,path:t.rel,created:true};}));}
  remove({scope='themes',path:file,expectedHash}){return this.serialized(()=>this.connected(async(c,p)=>{const t=await this.target(c,p,scope,file);const before=await this.bytes(c,t,MAX_TRANSFER);if(hash(before)!==expectedHash)throw Error('SFTP revision conflict');const backupId=this.backup(scope,t.rel,before,true);await c.delete(t.full);this.store.audit('sftp.delete',backupId,{scope,path:t.rel});return {deleted:true,scope,path:t.rel,backupId};}));}
  rollback({backupId,expectedHash}){return this.serialized(()=>this.connected(async(c,p)=>{const row=this.store.db.prepare('SELECT b.* FROM sftp_backups b JOIN sftp_backup_profiles p ON p.backup_id=b.id WHERE b.id=? AND p.profile_id=?').get(backupId,sftpProfileId(this.profile));if(!row)throw Error('Backup not found for the configured site profile');const t=await this.target(c,p,row.scope,row.path,{create:true});
    if(!row.existed){const before=await this.bytes(c,t,MAX_TRANSFER);if(hash(before)!==expectedHash)throw Error('SFTP revision conflict');await c.delete(t.full);return {scope:row.scope,path:row.path,removedCreatedFile:true};}
    const content=fs.readFileSync(row.file);if(hash(content)!==row.sha)throw Error('Local backup checksum mismatch');
    return this.replace(c,p,row.scope,row.path,content,expectedHash,{create:!(await c.exists(t.full)),validate:false});
  }));}
  upload({scope='themes',path:file,importFile,mediaId,locale,expectedHash,create=false}){return this.serialized(()=>this.connected(async(c,p)=>{const full=transferFile(this.config,this.store,{importFile,mediaId,locale}),buffer=fs.readFileSync(full);const extension=path.posix.extname(file).toLowerCase();const moduleArchive=scope==='modules'&&extension==='.zip';if(!textExtensions.has(extension)&&!binaryExtensions.has(extension)&&!moduleArchive)throw Error('Unsupported presentation/language asset type');return this.replace(c,p,scope,file,buffer,expectedHash,{create,validate:textExtensions.has(extension)});}));}
  download({scope='themes',path:file}){return this.connected(async(c,p)=>{const t=await this.target(c,p,scope,file);const data=await this.bytes(c,t,MAX_TRANSFER),name=uid()+path.posix.extname(t.rel);fs.writeFileSync(path.join(this.config.imports,name),data);return {scope,path:t.rel,importFile:name,bytes:data.length,sha256:hash(data)};});}
}
