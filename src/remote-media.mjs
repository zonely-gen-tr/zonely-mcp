import fs from 'node:fs';import path from 'node:path';import {createHash,randomUUID} from 'node:crypto';
import sharp from 'sharp';
const hosts=new Set(['upload.wikimedia.org','thumb.wikimedia.org','images.unsplash.com','images.pexels.com','raw.githubusercontent.com']);
export function imageUrl(value){
 const u=new URL(value);
 if(u.protocol!=='https:'||u.username||u.password||(u.port&&u.port!=='443')||!hosts.has(u.hostname))throw Error('Use a direct HTTPS image URL on an approved public image CDN, or import a local file');
 return u;
}
export function remoteMediaResolver(service){
 const active=new Map();
 return async reference=>{
  if(!reference.url)return reference;
  imageUrl(reference.url);
  const key=createHash('sha256').update(JSON.stringify(reference)).digest('hex');
  if(active.has(key))return active.get(key);
  const work=(async()=>{
   const folder=path.join(service.config.runtime,'remote-media');fs.mkdirSync(folder,{recursive:true});
   const record=path.join(folder,key+'.json');
   if(fs.existsSync(record)){const old=JSON.parse(fs.readFileSync(record));try{const media=service.store.media(old.mediaId);if(fs.existsSync(path.join(service.config.media,media.file)))return {mediaId:media.id};}catch{}}
   let response,url=imageUrl(reference.url);
   for(let redirects=0;redirects<=3;redirects++){
    response=await fetch(url,{redirect:'manual',signal:AbortSignal.timeout(20000),headers:{'User-Agent':'Zonely-MCP/0.3.4 content image importer',Accept:'image/png,image/jpeg,image/webp'}});
    if(response.status>=300&&response.status<400){const location=response.headers.get('location');await response.body?.cancel();if(!location||redirects===3)throw Error('Image redirect limit');url=imageUrl(new URL(location,url).href);continue;}
    break;
   }
   if(!response.ok)throw Error('Image download returned HTTP '+response.status);
   const mime=(response.headers.get('content-type')??'').split(';')[0];
   const extension={'image/png':'png','image/jpeg':'jpg','image/webp':'webp'}[mime];
   if(!extension){await response.body?.cancel();throw Error('Remote URL must return PNG, JPEG or WebP');}
   if(Number(response.headers.get('content-length')??0)>12582912){await response.body?.cancel();throw Error('Remote image exceeds 12 MiB');}
   const reader=response.body.getReader(),chunks=[];let bytes=0;
   try{for(;;){const {done,value}=await reader.read();if(done)break;bytes+=value.length;if(bytes>12582912)throw Error('Remote image exceeds 12 MiB');chunks.push(value);}}catch(e){await reader.cancel();throw e;}
   const file='remote-'+randomUUID()+'.'+extension,full=path.join(service.config.imports,file);
   try{
    let buffer=Buffer.concat(chunks);
    if(reference.pixelArt){const image=sharp(buffer,{limitInputPixels:24000000,animated:false});const metadata=await image.metadata();if(!['png','jpeg','webp'].includes(metadata.format))throw Error('Invalid raster image format');buffer=await image.resize(512,512,{fit:'contain',kernel:'nearest',background:{r:0,g:0,b:0,alpha:0}}).toFormat(extension==='jpg'?'jpeg':extension).toBuffer();}
    fs.writeFileSync(full,buffer);const media=await service.importMedia({file,locale:reference.locale??'tr_TR'});
    fs.writeFileSync(record,JSON.stringify({url:reference.url,source:reference.source,author:reference.author,license:reference.license,licenseUrl:reference.licenseUrl,mediaId:media.id,bytes:media.metadata.bytes}));
    return {mediaId:media.id};
   }finally{fs.rmSync(full,{force:true});}
  })();active.set(key,work);return work;
 };
}
const escape=s=>String(s).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
export function mediaCredit(image){
 if(!image.url)return '';
 const link=value=>{const u=new URL(value);if(u.protocol!=='https:'||u.username||u.password)throw Error('Attribution links require HTTPS');return escape(u.href);};
 return '<p><small>Görsel: <a href="'+link(image.source)+'">'+escape(image.author)+'</a> · '+(image.licenseUrl?'<a href="'+link(image.licenseUrl)+'">'+escape(image.license)+'</a>':escape(image.license))+' · WebP için yeniden boyutlandırıldı.</small></p>';
}
