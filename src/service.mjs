import fs from 'node:fs';
import path from 'node:path';
import sharp from 'sharp';
import {createRequire} from 'node:module';
import {Store,uid,hash,now} from './store.mjs';
import {Worker} from './worker.mjs';
import {Admin} from './admin.mjs';
import {Sftp} from './sftp.mjs';
import {Panel} from './panel.mjs';
const require=createRequire(import.meta.url);
const {renderOne}=require('../vendor/render-batch.cjs');
const escaped=s=>String(s).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const panelWords={urun:'product',urunler:'product',kategori:'categor',kategorileri:'categor',kategoriler:'categor',magaza:'shop',magazasi:'shop'};
const normalizedPanelText=value=>value.toLocaleLowerCase('tr').normalize('NFD').replace(/\p{M}/gu,'').replaceAll('ı','i');
export class Service {
  constructor(config){
    this.config=config;
    for(const dir of [config.runtime,config.imports,config.media])fs.mkdirSync(dir,{recursive:true});
    this.store=new Store(config.runtime,JSON.parse(fs.readFileSync(path.join(config.base,'data/locales.json'),'utf8')));
    this.worker=new Worker(config);
    this.catalog=JSON.parse(fs.readFileSync(path.join(config.base,'data/catalog.json'),'utf8'));
    this.panelIndex=JSON.parse(fs.readFileSync(path.join(config.base,'data/panel-index.json'),'utf8'));
    const formIndexFile=path.join(config.base,'data/panel-forms.json');
    this.formIndex=fs.existsSync(formIndexFile)?JSON.parse(fs.readFileSync(formIndexFile,'utf8')):null;
    this.admin=new Admin(config,this.store,this.catalog);
    this.panel=new Panel(config,this.store,this.catalog,this.panelIndex);
    this.sftp=new Sftp(config,this.store);
    this.queue=Promise.resolve();
  }
  status(){
    const profile=this.admin.profile;
    return {environment:profile?.environment??'unconfigured',site:profile?.panel?.url??profile?.api?.url??null,
      api:this.admin.status(),sftp:this.sftp.status(),panel:this.panel.status(),catalogOperations:this.catalog.length,
      translationEngine:'Argos (optional, local)'};
  }
  operations({query='',limit=8,offset=0,scope='api'}){
    if(scope==='panel'){
      const words=normalizedPanelText(query).split(/[\s/]+/).filter(Boolean);
      const rows=this.panelIndex.records.filter(entry=>{
        const text=normalizedPanelText([entry.id,entry.key,...(entry.routes??[]).map(route=>route.pattern),
          ...entry.operations.map(operation=>operation.main+'/'+operation.container)].join(' '));
        return words.every(word=>text.includes(word)||(Object.hasOwn(panelWords,word)&&text.includes(panelWords[word])));
      });
      return {total:rows.length,offset,items:rows.slice(offset,offset+limit).map(({id,key,kind,edition,routes,links})=>({
        id,key,kind,edition,route:routes?.[0]?.pattern,linkedSurfaces:links.length
      })),evidence:'source',executable:false};
    }
    const needle=query.toLocaleLowerCase('tr');
    if(scope==='admin'){
      const routes=JSON.parse(fs.readFileSync(path.join(this.config.base,'data/admin-routes.json'),'utf8'));
      const rows=routes.filter(r=>r.toLocaleLowerCase('tr').includes(needle));
      return {total:rows.length,offset,items:rows.slice(offset,offset+limit),executable:false};
    }
    const rows=this.catalog.filter(o=>`${o.title} ${o.main} ${o.container}`.toLocaleLowerCase('tr').includes(needle));
    return {total:rows.length,offset,items:rows.slice(offset,offset+limit).map(({id,title,method,main,container})=>({id,title,method,main,container,executable:!!this.admin.profile?.api}))};
  }
  operation(id,{offset=0,limit=8}={}){
    if(id.startsWith('panel:')){
      const entry=this.panelIndex.records.find(row=>row.id===id);
      if(!entry)throw Error('Unknown panel entry');
      const {kind,key,edition}=entry;
      const groups=['routes','fields','buttons','operations','links','relatedDrawers'];
      const evidence=Object.fromEntries(groups.filter(group=>entry[group]?.length).map(group=>[
        group,{total:entry[group].length,items:entry[group].slice(offset,offset+limit).map(item=>{
          if(typeof item!=='object'||item===null)return item;
          const {source,sources,reference,references,...details}=item;
          return details;
        })}
      ]));
      const source=this.formIndex?.records.find(row=>row.id===id);
      const formEvidence=source?{
        totalForms:source.sourceForms.length,
        forms:source.sourceForms.slice(offset,offset+Math.min(limit,3)).map(form=>({id:form.id,selector:form.selector,method:form.method,
          totalFields:form.fields.length,fields:form.fields.slice(0,5).map(({name,type,tag,selector,required,multiple})=>({name,type,tag,selector,required,multiple}))})),
        totalUngroupedFields:source.ungroupedFields.length,
        specialCases:source.issues,guideReferences:source.guides,
        verification:'Indexed form and documentation mapping. Verify submission through the connected site.'
      }:undefined;
      return {id,kind,key,edition,offset,evidence,...(formEvidence?{formEvidence}:{}),executable:false};
    }
    const op=this.catalog.find(o=>o.id===id);
    if(!op)throw Error('Unknown operation');
    const {path: requestPath, endpoint, ...schema}=op;
    const publicRoute=/^\/Files\/Src\//.test(requestPath??endpoint??'')?{}:{path:requestPath,endpoint};
    return {...schema,...publicRoute,executable:!!this.admin.profile?.api};
  }
  site(locale='tr_TR',{full=false,offset=0,limit=20}={}){
    this.store.locale(locale);
    const rows=this.store.db.prepare('SELECT id,kind,key,source_locale,title,body,revision,status,media_id FROM content ORDER BY rowid').all();
    const localized=rows.map(r=>this.localized(r,locale));
    const content=full?localized:localized.slice(offset,offset+limit).map(({body,...row})=>row);
    return {...this.store.site(),locale,totalContent:rows.length,offset,content,fallbackVisible:true};
  }
  localized(row,locale){
    const t=this.store.db.prepare('SELECT * FROM translations WHERE content_id=? AND locale=? AND source_revision=?').get(row.id,locale,row.revision);
    return {...row,title:t?.title??row.title,body:t?.body??row.body,locale: t?locale:row.source_locale,fallback:locale!==row.source_locale&&!t,review:t?.review??'source'};
  }
  design({revision,changes}){return this.store.transaction(()=>{
    const before=this.store.site();if(revision!==before.revision)throw Error('Revision conflict; read zonely_site again');
    const {revision:old,...config}=before;
    if(changes.sectionOrder){const keys=this.store.db.prepare("SELECT key FROM content WHERE kind='section'").all().map(r=>r.key);if(new Set(changes.sectionOrder).size!==changes.sectionOrder.length||changes.sectionOrder.some(k=>!keys.includes(k)))throw Error('Invalid section order');}
    this.store.db.prepare('INSERT INTO snapshots VALUES (?,?,?)').run(old,JSON.stringify(config),now());
    const after={...config,...changes};
    this.store.db.prepare('UPDATE site SET config=?,revision=revision+1 WHERE id=1').run(JSON.stringify(after));
    this.store.audit('design.update','site',{beforeRevision:old,changes});
    return {...after,revision:old+1,environment:'local-test'};
  });}
  rollback({revision,targetRevision}){const snap=this.store.db.prepare('SELECT config FROM snapshots WHERE revision=?').get(targetRevision);if(!snap)throw Error('Snapshot not found');return this.design({revision,changes:JSON.parse(snap.config)});}
  saveContent({id,kind,key,locale,title,body,revision,status,mediaId}){
    this.store.locale(locale);
    if(mediaId)this.store.media(mediaId);
    return this.store.transaction(()=>{
      let row=id?this.store.content(id):this.store.db.prepare('SELECT * FROM content WHERE key=?').get(key);
      if(!row){
        if(revision!==undefined)throw Error('New content has no revision');
        id=uid();this.store.db.prepare('INSERT INTO content (id,kind,key,source_locale,title,body,origin,status,media_id) VALUES (?,?,?,?,?,?,\'mcp\',?,?)').run(id,kind,key,locale,title,body,status??'draft',mediaId??null);
      }else{
        if(revision!==row.revision)throw Error('Content revision conflict; read content again');
        if(row.kind!==kind||row.key!==key)throw Error('Content kind/key cannot change');
        id=row.id;
        if(locale===row.source_locale){
          this.store.db.prepare('UPDATE content SET title=?,body=?,revision=revision+1,status=?,media_id=? WHERE id=?').run(title,body,status??row.status,mediaId===undefined?row.media_id:mediaId,id);
        }else{
          if(mediaId!==undefined||(status!==undefined&&status!==row.status))throw Error('Translation edit cannot change source status or media');
          this.store.db.prepare("INSERT INTO translations VALUES (?,?,?,?,?,'human','reviewed') ON CONFLICT(content_id,locale) DO UPDATE SET source_revision=excluded.source_revision,title=excluded.title,body=excluded.body,method='human',review='reviewed'").run(id,locale,row.revision,title,body);
        }
      }
      this.store.audit('content.save',id,{locale});
      return this.readContent(id,locale);
    });
  }
  readContent(id,locale){const row=this.store.content(id);if(locale)this.store.locale(locale);return {...this.localized(row,locale??row.source_locale),translations:this.store.db.prepare('SELECT locale,source_revision,method,review FROM translations WHERE content_id=?').all(row.id)};}
  addLocale({code,name}){this.store.db.prepare('INSERT INTO locales VALUES (?,?)').run(code,name);this.store.audit('locale.add',code);return {code,name,enabled:true,modelAvailability:'Check zonely_engines before automatic translation'};}
  async engines(){return this.worker.request({action:'status'});}
  enqueue(kind,payload,total,work){
    const serialized=JSON.stringify(payload);
    const previous=this.store.db.prepare("SELECT id FROM jobs WHERE kind=? AND payload=? AND state IN ('queued','running')").get(kind,serialized);
    if(previous)return this.store.job(previous.id);
    const id=uid();this.store.db.prepare("INSERT INTO jobs (id,kind,state,total,payload,created_at,updated_at,owner_pid) VALUES (?,?,'queued',?,?,?,?,?)").run(id,kind,total,serialized,now(),now(),process.pid);
    this.queue=this.queue.then(async()=>{
      this.store.db.prepare("UPDATE jobs SET state='running',updated_at=? WHERE id=?").run(now(),id);
      try{
        const result=await (this.observeJob ? this.observeJob(kind,()=>work(id)) : work(id));
        this.store.db.prepare("UPDATE jobs SET state='completed',progress=total,result=?,updated_at=? WHERE id=?").run(JSON.stringify(result),now(),id);
        this.store.audit(kind,id,{state:'completed'});
      }catch(error){
        this.store.db.prepare("UPDATE jobs SET state='failed',error=?,result=?,updated_at=? WHERE id=?").run(error.message,error.result?JSON.stringify(error.result):null,now(),id);
        this.store.audit(kind,id,{state:'failed',error:error.message});
      }
    });
    return this.store.job(id);
  }
  progress(id,n){this.store.db.prepare('UPDATE jobs SET progress=?,updated_at=? WHERE id=?').run(n,now(),id);}
  job(id,detail=false){
    const job=this.store.job(id);if(detail||!job.result)return job;
    const r=job.result;
    if(r.variants)job.result={mediaId:r.mediaId,variants:r.variants.length,locales:r.variants.map(v=>v.locale),truncatedRegions:r.variants.reduce((n,v)=>n+(v.truncatedRegions??0),0),review:'machine-overlay-needs-visual-review'};
    else if(r.locales)job.result={id:r.id,revision:r.revision,locales:r.locales.map(({locale,state})=>({locale,state}))};
    return job;
  }
  async translate(texts,source,target){
     
    const pattern=/(\r?\n|https?:\/\/[^\s]+|\{\{[^{}]+\}\}|\$?\{[^{}]+\}|%\d*\$?[sdif]|`[^`]*`|<[^>]*>)/g;
    const parts=texts.map(t=>t.split(pattern));
    const segments=[];const indices=[];
    parts.forEach((p,i)=>p.forEach((s,j)=>{if(j%2===0&&s.trim()){indices.push([i,j,s.match(/^\s*/)[0],s.match(/\s*$/)[0]]);segments.push(s.trim());}}));
    const cacheKey=hash({engine:'argos-ct2-v1',texts,source,target});
    const cached=this.store.db.prepare('SELECT value FROM memory WHERE cache_key=?').get(cacheKey);
    if(cached)return {...JSON.parse(cached.value),cached:true};
    const response=segments.length?await this.worker.request({action:'translate',texts:segments,source,target}):{texts:[],route:[],engine:'Argos/CTranslate2',review:'machine-needs-review'};
    indices.forEach(([i,j,left,right],k)=>{parts[i][j]=left+response.texts[k]+right;});
    const result={...response,texts:parts.map(p=>p.join('')),cached:false};
    this.store.db.prepare('INSERT OR REPLACE INTO memory VALUES (?,?)').run(cacheKey,JSON.stringify(result));
    return result;
  }
  localize({id,locales,overwrite=false}){
    const row=this.store.content(id);for(const locale of locales)this.store.locale(locale);
    return this.enqueue('content.localize',{id:row.id,revision:row.revision,locales,overwrite},locales.length,async job=>{
      const result=[];
      for(const [index,locale]of locales.entries()){
        if(locale===row.source_locale){result.push({locale,state:'source'});this.progress(job,index+1);continue;}
        const existing=this.store.db.prepare('SELECT * FROM translations WHERE content_id=? AND locale=?').get(row.id,locale);
        if(existing&&!overwrite&&(existing.method==='human'||existing.source_revision===row.revision)){result.push({locale,state:existing.method==='human'?'human-protected':'cached'});this.progress(job,index+1);continue;}
        const output=await this.translate([row.title,row.body],row.source_locale,locale);
        this.store.transaction(()=>{
          if(this.store.content(row.id).revision!==row.revision)throw Error('Source changed during translation; retry with new revision');
           
          const current=this.store.db.prepare('SELECT method FROM translations WHERE content_id=? AND locale=?').get(row.id,locale);
          if(current?.method==='human'&&!overwrite){result.push({locale,state:'human-protected'});return;}
          this.store.db.prepare("INSERT INTO translations VALUES (?,?,?,?,?,'argos','machine-needs-review') ON CONFLICT(content_id,locale) DO UPDATE SET source_revision=excluded.source_revision,title=excluded.title,body=excluded.body,method='argos',review='machine-needs-review'").run(row.id,locale,row.revision,...output.texts);
          result.push({locale,state:'translated',route:output.route,cached:output.cached});
        });
        this.progress(job,index+1);
      }
      return {id:row.id,revision:row.revision,locales:result,environment:'local-test'};
    });
  }
  async importMedia({file,locale}){
    this.store.locale(locale);
    const root=fs.realpathSync(this.config.imports);
    const source=fs.realpathSync(path.resolve(root,file));
    const relative=path.relative(root,source);
    if(!relative||relative.startsWith('..')||path.isAbsolute(relative)||!fs.statSync(source).isFile())throw Error('File must be inside configured import directory');
    const bytes=fs.statSync(source).size;if(bytes>12582912||bytes<1)throw Error('Image must be between 1 byte and 12 MiB');
    if(!/\.(png|jpe?g|webp)$/i.test(source))throw Error('Only PNG, JPEG and WebP images are accepted');
    const input=fs.readFileSync(source);const sha=hash(input);
    const existing=this.store.db.prepare('SELECT id,source_locale FROM media WHERE sha=?').get(sha);
    if(existing){if(existing.source_locale!==locale)throw Error('Same image already imported with another source locale');return this.store.media(existing.id);}
    const output=await this.encode(input);
    const id=uid(),folder=path.join(this.config.media,id);fs.mkdirSync(folder,{recursive:true});
    fs.writeFileSync(path.join(folder,'source.webp'),output.buffer);
    const metadata={...output.metadata,originalBytes:bytes,originalSha256:sha,review:'source'};
    this.store.db.prepare('INSERT INTO media VALUES (?,?,?,?,?)').run(id,sha,locale,`${id}/source.webp`,JSON.stringify(metadata));
    this.store.audit('media.import',id,{bytes,outputBytes:output.buffer.length});
    return this.store.media(id);
  }
  async encode(input){
    const image=sharp(input,{limitInputPixels:24000000,animated:false});
    const original=await image.metadata();if(!['png','jpeg','webp'].includes(original.format))throw Error('Invalid raster image format');
    for(const quality of [86,74,60,45]){
      const buffer=await image.clone().rotate().resize({width:2048,height:2048,fit:'inside',withoutEnlargement:true}).webp({quality,effort:4}).toBuffer();
      if(buffer.length<=2097152){const meta=await sharp(buffer).metadata();return {buffer,metadata:{bytes:buffer.length,width:meta.width,height:meta.height,format:'webp',quality,sha256:hash(buffer)}};}
    }
    throw Error('Cannot fit image within 2 MiB output budget');
  }
  ocr({mediaId}){
    const media=this.store.media(mediaId);const output=path.join(this.config.media,mediaId,'ocr.json');
    return this.enqueue('media.ocr',{mediaId,sha:media.metadata.sha256},1,async()=>{
      if(!fs.existsSync(output)){
        const result=await this.worker.request({action:'ocr',path:path.join(this.config.media,media.file),locale:media.source_locale});
        fs.writeFileSync(output,JSON.stringify({...result,sourceFile:path.join(this.config.media,media.file),sha256:media.metadata.sha256},null,2));
      }
      const result=JSON.parse(fs.readFileSync(output,'utf8'));
      return {mediaId,regions:result.regions.length,engine:result.engine,review:result.review};
    });
  }
  regions({mediaId,offset=0,limit=10}){this.store.media(mediaId);const payload=JSON.parse(fs.readFileSync(path.join(this.config.media,mediaId,'ocr.json'),'utf8'));return {mediaId,total:payload.regions.length,regions:payload.regions.slice(offset,offset+limit),engine:payload.engine};}
  localizeMedia({mediaId,locales}){
    const media=this.store.media(mediaId);for(const locale of locales)this.store.locale(locale);
    const ocrFile=path.join(this.config.media,mediaId,'ocr.json');if(!fs.existsSync(ocrFile))throw Error('Run zonely_media_ocr first and wait for completion');
    const payload=JSON.parse(fs.readFileSync(ocrFile,'utf8'));
    if(!payload.regions.length)throw Error('No readable OCR regions; cannot claim localized image');
    return this.enqueue('media.localize',{mediaId,locales,sha:media.metadata.sha256},locales.length,async job=>{
      const result=[];
      for(const [i,locale]of locales.entries()){
        if(locale===media.source_locale){result.push({locale,state:'source'});this.progress(job,i+1);continue;}
        const existing=this.store.db.prepare('SELECT file,metadata FROM media_variants WHERE media_id=? AND locale=?').get(mediaId,locale);
        if(existing){result.push({locale,...JSON.parse(existing.metadata),cached:true});this.progress(job,i+1);continue;}
        const translation=await this.translate(payload.regions.map(r=>r.originalText),media.source_locale,locale);
        const folder=path.join(this.config.media,mediaId),jsonFile=path.join(folder,locale+'.json'),png=path.join(folder,locale+'.png');
        const cfg={...payload,sourceFile:path.join(this.config.media,media.file),translated:true,locale,regions:payload.regions.map((r,n)=>({...r,text:translation.texts[n]}))};
        fs.writeFileSync(jsonFile,JSON.stringify(cfg,null,2));
        const render=await renderOne(jsonFile,png);
        const encoded=await this.encode(fs.readFileSync(png));fs.unlinkSync(png);
        const relative=`${mediaId}/${locale}.webp`;fs.writeFileSync(path.join(this.config.media,relative),encoded.buffer);
        const metadata={...encoded.metadata,changedRegions:render.changed,truncatedRegions:render.truncated??0,review:'machine-overlay-needs-visual-review',engine:'Argos/CTranslate2 + existing Sharp/Pango renderer'};
        this.store.db.prepare('INSERT OR REPLACE INTO media_variants VALUES (?,?,?,?)').run(mediaId,locale,relative,JSON.stringify(metadata));
        result.push({locale,...metadata});this.progress(job,i+1);
      }
      return {mediaId,variants:result};
    });
  }
  preview(locale='tr_TR'){
    const site=this.site(locale,{full:true});const dir=/^(ar|fa|he|ur)(_|$)/.test(locale)?'rtl':'ltr';
    const image=content=>{
      if(!content.media_id)return '';
      const media=this.store.media(content.media_id);
      const variant=this.store.db.prepare('SELECT file FROM media_variants WHERE media_id=? AND locale=?').get(media.id,locale);
      return `<img src="/media/${escaped(variant?.file??media.file)}" alt="${escaped(content.title)}" loading="lazy">`;
    };
    const all=site.content.filter(r=>r.status==='visible');
    const sections=all.filter(r=>r.kind==='section').sort((a,b)=>{const ai=site.sectionOrder.indexOf(a.key),bi=site.sectionOrder.indexOf(b.key);return (ai<0?999:ai)-(bi<0?999:bi);});
    const announcements=all.filter(r=>r.kind==='announcement');
    const card=r=>`<article data-key="${escaped(r.key)}">${image(r)}<div><small>${escaped(r.key)}${r.fallback?' · kaynak dil / source fallback':''}</small><h2>${escaped(r.title)}</h2><p>${escaped(r.body)}</p>${r.review==='machine-needs-review'?'<small>Makine çevirisi · inceleme bekliyor</small>':''}</div></article>`;
    return `<!doctype html><html lang="${escaped(locale.replace('_','-'))}" dir="${dir}"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${escaped(site.name)} · Test</title><style>*{box-sizing:border-box}body{margin:0;background:${site.background};color:#f4f6ef;font:16px/1.65 system-ui,sans-serif}header,main,footer{width:min(1120px,calc(100% - 40px));margin:auto}.test{padding:8px 20px;background:#f3d990;color:#302819;text-align:center;font-size:13px}header{display:flex;align-items:center;justify-content:space-between;gap:16px;flex-wrap:wrap;padding:32px 0}a{color:inherit}select{max-width:100%;background:#fff;color:#19231b;padding:10px;border-radius:10px}h1{font-size:clamp(28px,5vw,48px);line-height:1.15;overflow-wrap:anywhere}h2{font-size:clamp(22px,3vw,32px);line-height:1.3;overflow-wrap:anywhere}article{border:1px solid #ffffff20;border-radius:${site.radius}px;overflow:hidden;background:#ffffff08;margin:24px 0}article>div{padding:clamp(20px,4vw,42px)}article img{display:block;width:100%;max-height:430px;object-fit:cover}article:first-of-type{border-top:5px solid ${site.primary}}p{white-space:pre-wrap;overflow-wrap:anywhere}small{color:#c4d1c6}footer{padding:36px 0;color:#c4d1c6}.news{display:grid;grid-template-columns:repeat(auto-fit,minmax(min(100%,320px),1fr));gap:20px}.news article{margin:0}.label{color:${site.primary};font-weight:700}body[data-theme=Velux] article{background:#ffffff0e}body[data-theme=Brivn] h2{letter-spacing:-.025em}body[data-theme=Ovrix] article{border-width:2px}</style><body data-theme="${escaped(site.theme)}"><div class="test">YEREL TEST · Local sandbox · Canlı siteye bağlı değil</div><header><strong>${escaped(site.name)}</strong><form><select name="locale" aria-label="Dil / Language" onchange="this.form.submit()">${this.store.db.prepare('SELECT * FROM locales').all().map(l=>`<option value="${escaped(l.code)}"${l.code===locale?' selected':''}>${escaped(l.name)}</option>`).join('')}</select></form></header><main><span class="label">${escaped(site.theme)} · MCP test preview</span><h1>${escaped(site.name)}</h1>${sections.map(card).join('')}<div class="news">${announcements.map(card).join('')}</div></main><footer>SQLite · revision ${site.revision} · ${escaped(locale)} · 507 API catalog discovery</footer></body></html>`;
  }
  async close(){await Promise.allSettled([this.queue,this.admin.sequence,this.sftp.sequence,this.panel.close()]);this.worker.close();this.store.close();}
}
