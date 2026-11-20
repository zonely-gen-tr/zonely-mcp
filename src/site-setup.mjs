import fs from 'node:fs';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import * as z from 'zod/v4';
import {setupStore,storeSetupInput} from './store-setup.mjs';
import {remoteMediaResolver} from './remote-media.mjs';
import {applySeo} from './seo-settings.mjs';

const text=z.string().trim().min(1).max(150);
const image=z.object({file:z.string().min(1).max(400)}).strict();
export const siteSetupInput={
  mode:z.enum(['preview','apply']).default('preview'),
  name:text,
  tagline:text.optional(),
  description:z.string().trim().min(1).max(155).optional(),
  appearance:z.enum(['light','dark']).default('light'),
  palette:z.enum(['emerald','blue','amber']).default('emerald'),
  games:z.array(z.object({name:text,content:z.string().min(1).max(8000),image:image.optional()}).strict()).max(8).default([]),
  widgets:z.enum(['preserve','enable-defaults']).default('preserve'),
  navigation:z.array(z.enum(['home','store','games','announcements','support'])).max(5).default([]),
  serverAddress:z.string().trim().min(1).max(250).optional(),
  seo:z.object({title:text,suffix:text.optional(),description:z.string().min(1).max(500).optional(),favicon:image.optional()}).strict().optional(),
  store:z.object({categories:storeSetupInput.categories,products:storeSetupInput.products}).strict().optional(),
  panelSteps:z.array(z.object({
    workflowId:z.string().min(1).max(100),recordId:z.number().int().positive().optional(),
    fields:z.record(z.string(),z.union([z.string().max(30000),z.number(),z.boolean(),z.array(z.string()).max(100)])).default({}),
  }).strict()).max(10).default([]),
  templateChanges:z.array(z.object({
    scope:z.enum(['themes','languages','modules']).default('themes'),path:z.string().min(1).max(500),
    expectedHash:z.string().regex(/^[a-f0-9]{64}$/),
    replacements:z.array(z.object({find:z.string().min(1).max(20000),replace:z.string().max(30000),
      count:z.number().int().min(1).max(100).default(1)}).strict()).min(1).max(20),
  }).strict()).max(6).default([]),
};

const menuChoices={
  home:{title:'Ana Sayfa',link:'/'},store:{title:'Mağaza',link:'/shop'},
  games:{title:'Oyunlar',link:'/games'},announcements:{title:'Duyurular',link:'/broadcasts'},
  support:{title:'Destek',link:'/support'},
};
const builtInWidgets=new Set(['announcements','last_registers','last_orders','last_credit_loaders',
  'top_credit_loaders','faq','header_search','last_reviews','team','stats','activity','user_search']);
const palettes={
  emerald:{primary:'#159b72',active:'#0d8260',light:'#e4f6ee'},
  blue:{primary:'#2563eb',active:'#1d4ed8',light:'#e9efff'},
  amber:{primary:'#b9770e',active:'#915a05',light:'#fff3db'},
};
const sameName=(left,right)=>String(left).normalize('NFC').toLocaleLowerCase('tr')===String(right).normalize('NFC').toLocaleLowerCase('tr');

export function setupSite(service,input){
  return service.panel.exclusive(()=>applySite(service,input));
}

async function applySite(service,input){
  if(!service.admin.status().credentialReady)throw Error('Connect the site API before preparing its business records');
  const origin=service.panel.origin();
  if(service.admin.status().origin!==origin)throw Error('Panel and API must identify the same site');
  if(new Set(input.games.map(game=>game.name.toLocaleLowerCase('tr'))).size!==input.games.length)
    throw Error('Choose each game once');
  if(new Set(input.navigation).size!==input.navigation.length)throw Error('Choose each menu once');
  const templates=input.templateChanges??[];
  if(new Set(templates.map(change=>change.scope+'/'+change.path)).size!==templates.length)
    throw Error('Combine changes to each template in one patch');

  const started=Date.now();
  const report={id:randomUUID(),origin,mode:input.mode,done:false,steps:[],templateBackups:[]};
  const guidePaths=new Set(['/guides/page-builder/content','/guides/page-builder/colors',
    '/guides/page-builder/seo-social-media','/guides/page-builder/navbar-and-footer',
    ...(input.games.length?['/guides/games']:[]),...(input.widgets!=='preserve'?['/guides/widgets']:[]),
    ...(input.store?['/guides/products']:[])]);
  const guides=service.panel.documentation?.guides??[];
  for(const action of input.panelSteps??[]){
    const recipe=service.panel.recipes[action.workflowId];
    if(!recipe)throw Error('Choose a registered panel workflow');
    for(const url of recipe.documentation??[])guidePaths.add(url);
  }
  if(input.mode==='preview'){
    report.documentationIndex={};
    for(const guide of guides){
      const group=guide.group??'Diğer';
      (report.documentationIndex[group]??=[]).push(guide.title);
    }
  }
  report.documentation=guides.filter(guide=>guidePaths.has(guide.url)).map(({url,title})=>({url,title}));
  report.availableSections=guides.filter(guide=>/games|announcements|appeals|support-center|page-builder|widgets|rules|products/.test(guide.url))
    .map(({url,title})=>({url,title}));
  report.needsInput=input.serverAddress?[]:['gameServerAddress'];
  const directory=path.join(service.config.runtime,'site-setup');
  fs.mkdirSync(directory,{recursive:true});
  function checkpoint(){
    report.elapsedMs=Date.now()-started;
    const file=path.join(directory,report.id+'.json');
    const temporary=file+'.tmp';
    fs.writeFileSync(temporary,JSON.stringify(report,null,2));
    fs.renameSync(temporary,file);
  }
  const api=async(id,body,files)=>{
    const response=await service.admin.run({id,...(body?{body}:{query:{start:0,length:100}}),...(files?{files}:{})});
    if(!response.ok)throw Error('Panel operation failed: '+id+'; inspect result '+response.resultId+' before retrying');
    return JSON.parse(fs.readFileSync(path.join(service.admin.directory,response.resultId+'.json'),'utf8'));
  };
  const rows=async id=>{
    const value=await api(id);
    const list=Array.isArray(value)?value:value.data;
    if(!Array.isArray(list))throw Error('Expected a record list for '+id);
    if(Number(value.recordsTotal??list.length)>100)throw Error('Use a narrower setup plan for sites with more than 100 records');
    return list;
  };
  let step='preflight';
  checkpoint();
  try{
    await Promise.all(report.documentation.map(async guide=>{
      const document=await service.panel.readGuide({guidePath:guide.url});
      guide.source=document.source;
      guide.url=document.url;
    }));
    for(const change of input.templateChanges??[]){
      const current=await service.sftp.read({scope:change.scope,path:change.path,lineCount:1});
      if(current.sha256!==change.expectedHash)throw Error('Template changed before setup: '+change.path);
    }
    const [games,widgets,menus]=await Promise.all([
      rows('games-gameslistcontroller'),rows('widgets-widgetslistcontroller'),rows('menus-menuslistcontroller'),
    ]);
    for(const game of input.games){
      if(games.filter(row=>sameName(row.name,game.name)).length>1)throw Error('Multiple games have this name: '+game.name);
    }
    for(const choice of input.navigation){
      if(menus.filter(row=>sameName(row.title,menuChoices[choice].title)).length>1)
        throw Error('Multiple menus have this title: '+menuChoices[choice].title);
    }

    step='appearance';
    const page=await service.panel.navigate('panel:site:page:main.themes');
    const settings=await page.locator('#pageBuilderForm').evaluate(form=>Object.fromEntries([...new FormData(form)]
      .filter(([name,value])=>typeof value==='string'&&!/csrf|token|password|secret/i.test(name))));
    const palette=palettes[input.palette];
    const wanted={
      siteName:input.name,defaultTheme:input.appearance==='light'?'1':'2',
       
       
      '--bs-primary':palette.primary,'--bs-dark-primary':palette.primary,
      '--bs-body-bg':'#f3f8f5','--bs-body-color':'#19372b',
      ...(input.tagline?{slogan:input.tagline}:{}),...(input.description?{desc:input.description}:{}),
      ...(input.serverAddress?{serverAdress:input.serverAddress}:{}),
    };
    if(!Object.hasOwn(settings,'siteName')||!Object.hasOwn(settings,'defaultTheme'))throw Error('The site settings form is unavailable');
    const changes=Object.fromEntries(Object.entries(wanted)
      .filter(([key,value])=>Object.hasOwn(settings,key)&&settings[key]!==value));
    if(Object.keys(changes).length&&input.mode==='apply'){
      await service.panel.saveSettings(changes);
      await page.reload({waitUntil:'domcontentloaded'});
      if(page.waitForLoadState)await page.waitForLoadState('load');
      const actual=await page.locator('#pageBuilderForm').evaluate(form=>Object.fromEntries([...new FormData(form)]
        .filter(([name,value])=>typeof value==='string')));
      const mismatch=Object.entries(changes).filter(([key,value])=>actual[key]?.trim().toLowerCase()!==value.trim().toLowerCase());
      if(mismatch.length)throw Error('Settings readback differs: '+JSON.stringify(mismatch.map(([key,value])=>({key,expected:value,actual:actual[key]}))));
    }
    report.steps.push({kind:'settings',result:Object.keys(changes).length?(input.mode==='apply'?'updated':'pending'):'existing',
      fields:Object.keys(changes)});
    checkpoint();
    if(input.seo){
      step='SEO and favicon';
      const result=input.mode==='apply'?await applySeo(service,{...input.seo,suffix:input.seo.suffix??input.name}):{pending:true};
      report.steps.push({kind:'seo',...result});
      checkpoint();
    }

    for(const game of input.games){
      step='game '+game.name;
      const existing=games.find(row=>sameName(row.name,game.name));
      const changed=!existing||String(existing.content??'')!==game.content;
      if(changed&&input.mode==='apply'){
        await api(existing?'games-gamesupdatecontroller':'games-gamesaddcontroller',
          {...(existing?{id:existing.id}:{}),name:game.name,content:game.content},
          game.image?[{field:'image',...game.image}]:undefined);
      }
      report.steps.push({kind:'game',name:game.name,result:changed?(input.mode==='apply'?'saved':'pending'):'existing'});
      checkpoint();
    }

    if(input.widgets==='enable-defaults'){
      for(const widget of widgets.filter(row=>builtInWidgets.has(row.widget_type)&&Number(row.is_passive)!==0)){
        step='widget '+widget.title;
        if(input.mode==='apply')await api('widgets-widgetsupdatecontroller',{
          id:widget.id,title:widget.title,widget_type:widget.widget_type,area:widget.area,
        });
        report.steps.push({kind:'widget',id:widget.id,result:input.mode==='apply'?'enabled':'pending'});
        checkpoint();
      }
    }

    for(const key of input.navigation){
      const choice=menuChoices[key];
      step='menu '+choice.title;
      const existing=menus.find(row=>sameName(row.title,choice.title));
      const changed=!existing||existing.link!==choice.link;
      if(changed&&input.mode==='apply'){
        if(existing){
          await api('menus-menusupdatecontroller',{id:existing.id,...choice,target:'_self',menu_type2:'link',
            icon2:existing.icon??'',description:existing.description??'',parent_id:existing.parent_id??''});
        }else{
          await publishMenu(service,page,choice);
        }
      }
      report.steps.push({kind:'menu',...choice,result:changed?(input.mode==='apply'?'saved':'pending'):'existing'});
      checkpoint();
    }

    if(input.store){
      step='store';
      const store=await setupStore(service.admin,{...input.store,mode:input.mode},{resolveImage:remoteMediaResolver(service)});
      report.store=store;
      if(!store.done)throw Error('Store setup needs attention: '+store.failedStep);
      checkpoint();
    }
    for(const action of input.panelSteps??[]){
      step=action.workflowId;
      const result=await service.panel.run({...action,mode:input.mode});
      report.steps.push({kind:'panel',workflowId:action.workflowId,...result});
      checkpoint();
    }
    for(const change of input.templateChanges??[]){
      step='template '+change.path;
      if(input.mode==='apply'){
        const saved=await service.sftp.patch(change);
        report.templateBackups.push({backupId:saved.backupId,expectedHash:saved.sha256,path:change.path});
      }
      report.steps.push({kind:'template',path:change.path,result:input.mode==='apply'?'saved':'pending'});
      checkpoint();
    }
    if(report.templateBackups.length){
      step='template import';
      const imported=await service.admin.prepareSftp({fullSync:true});
      report.templateImport=imported.sync;
      for(const backup of report.templateBackups){
        const change=templates.find(change=>change.path===backup.path);
        const current=await service.sftp.read({scope:change.scope,path:change.path,lineCount:1});
        backup.expectedHash=current.sha256;
      }
      if(!imported.sync.ok)throw Error('Template import failed; restoring saved revisions');
      const response=await service.panel.context.request.get(origin+'/',{maxRedirects:0,timeout:10000});
      if(response.status()!==200)throw Error('Homepage health check failed after template changes');
    }
    if(input.mode==='apply'){
      step='readback';
      const [savedGames,savedWidgets,savedMenus]=await Promise.all([
        rows('games-gameslistcontroller'),rows('widgets-widgetslistcontroller'),rows('menus-menuslistcontroller'),
      ]);
      if(input.games.some(game=>savedGames.filter(row=>sameName(row.name,game.name)).length!==1))
        throw Error('Game readback failed');
      if(input.navigation.some(key=>!savedMenus.some(row=>sameName(row.title,menuChoices[key].title)&&row.link===menuChoices[key].link)))
        throw Error('Navigation readback failed');
      if(input.widgets==='enable-defaults'&&savedWidgets.some(row=>builtInWidgets.has(row.widget_type)&&Number(row.is_passive)!==0))
        throw Error('Widget readback failed');
      report.verificationPending=report.steps.filter(step=>step.kind==='panel'&&step.submitted&&!step.verified)
        .map(step=>step.workflowId);
      report.verified=report.verificationPending.length===0;
    }
    report.done=true;
    service.store.audit('site.setup',report.id,{mode:input.mode,steps:report.steps.length,verified:report.verified??false});
  }catch(error){
    report.failedStep=step;
    report.error=error.message;
    for(const backup of [...report.templateBackups].reverse()){
      try{
        await service.sftp.rollback({backupId:backup.backupId,expectedHash:backup.expectedHash});
        backup.restored=true;
      }catch(rollbackError){
        backup.restored=false;
        backup.restoreError=rollbackError.message;
      }
    }
    if(report.templateBackups.length&&report.templateBackups.every(backup=>backup.restored)){
      try{
        const imported=await service.admin.prepareSftp({fullSync:true});
        report.rollbackImportVerified=imported.sync.ok;
      }catch(importError){
        report.rollbackImportVerified=false;
        report.rollbackImportError=importError.message;
      }
    }
  }finally{
    service.panel.allowWrites=false;
    service.panel.expectedPost=null;
    checkpoint();
  }
  if(input.mode==='preview')return report;
  const {id,done,verified,verificationPending,elapsedMs,steps,needsInput,failedStep,error,templateBackups,rollbackImportVerified}=report;
  return {id,done,verified,elapsedMs,steps,needsInput,failedStep,error,
    ...(verificationPending?.length?{verificationPending}:{}),
    ...(templateBackups.length?{templateBackups,rollbackImportVerified}:{}),...(report.store?{store:report.store}:{})};
}

async function publishMenu(service,page,choice){
  const operation=service.panel.catalog.find(item=>item.id==='settings-generalsettingsupdatecontroller');
  if(!operation)throw Error('Native menu submit target is unavailable');
  const expected=new URL(operation.path,service.panel.origin());
  for(const [key,value]of Object.entries(operation.routing))expected.searchParams.set(key,value);
  const form=page.locator('#menusForm');
  await form.evaluate((element,choice)=>{
    for(const [name,value]of Object.entries({...choice,menu_type:'link',target:'_self',parent_id:''})){
      const field=element.elements.namedItem(name);
      if(!field)throw Error('Missing menu field '+name);
      field.value=value;
      field.dispatchEvent(new Event('change',{bubbles:true}));
    }
    if(!element.checkValidity())throw Error('Native menu form validation failed');
  },choice);
  service.panel.allowWrites=true;
  service.panel.expectedPost=expected;
  try{
    const pending=page.waitForResponse(response=>{
      const url=new URL(response.url());
      return response.request().method()==='POST'&&url.origin===expected.origin&&url.pathname===expected.pathname
        &&[...expected.searchParams].every(([key,value])=>url.searchParams.get(key)===value);
    },{timeout:15000});
    await form.evaluate(element=>element.requestSubmit());
    const response=await pending;
    if(!response.ok()||(await response.json()).status!=='success')throw Error('Menu submit was rejected');
  }finally{
    service.panel.allowWrites=false;
    service.panel.expectedPost=null;
  }
}
