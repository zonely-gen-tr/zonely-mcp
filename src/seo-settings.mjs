import {transferFile} from './connection.mjs';
import fs from 'node:fs';
import {createHash} from 'node:crypto';
import {setFormValues} from './panel-fields.mjs';

export async function applySeo(service,input){
  const {panel}=service;
  const page=panel.page;
  if(!new URL(page.url()).pathname.startsWith('/admin/page-builder'))
    await panel.navigate('panel:site:page:main.themes');
  const opener=page.locator('[data-bs-target="#accSeoBody"]');
  if(await opener.getAttribute('aria-expanded')!=='true')await opener.click();
  const edit=page.locator('#accSeoBody').getByText('Düzenle',{exact:true}).first();
  if(await edit.count())await edit.click();
  await page.locator('#seo_title').waitFor({state:'attached'});
  if(await page.locator('#seo_route').inputValue()!=='__global__')throw Error('Select the global SEO panel before saving');
  let faviconMatches=!input.favicon;
  if(input.favicon){
    const current=await page.locator('#seo_favicon_url').inputValue();
    const url=current&&new URL(current,panel.origin());
    faviconMatches=!!url&&url.origin===panel.origin();
    if(faviconMatches){
      const response=await panel.context.request.get(url.href,{timeout:10000});
      const remote=response.ok()?await response.body():Buffer.alloc(0);
      const local=fs.readFileSync(transferFile(service.config,service.store,input.favicon));
      const digest=bytes=>createHash('sha256').update(bytes).digest('hex');
      faviconMatches=digest(remote)===digest(local);
    }
  }
  const existing=await page.locator('#seo_title').inputValue()===input.title
    &&(input.suffix===undefined||await page.locator('#seo_title_suffix').inputValue()===input.suffix)
    &&(input.description===undefined||await page.locator('#seo_description').inputValue()===input.description)&&faviconMatches;
  if(existing)return verifyPublicSeo(panel,input);

  for(const [selector,value]of [['#seo_title',input.title],['#seo_title_suffix',input.suffix],['#seo_description',input.description]]){
    if(value===undefined)continue;
    await page.locator(selector).evaluate((element,value)=>{
      element.value=value;
      element.dispatchEvent(new Event('input',{bubbles:true}));
      element.dispatchEvent(new Event('change',{bubbles:true}));
    },value);
  }
  await page.locator('#seo_global_mode').evaluate(element=>{
    element.checked=true;element.dispatchEvent(new Event('change',{bubbles:true}));
  });
  if(input.favicon&&!faviconMatches){
    await page.locator('#seo_favicon_file').setInputFiles(transferFile(service.config,service.store,input.favicon));
    await page.evaluate(async()=>{
      if(window.ZonelyAdminImages)await window.ZonelyAdminImages.settle(document.getElementById('seo-form'));
      const input=document.getElementById('seo_favicon_file');
      if(!input?.files?.[0]?.size||input.disabled)throw Error('Native image pipeline did not retain the selected favicon');
    });
    await page.locator('#seo_favicon_source').evaluate(e=>{e.value='custom';e.dispatchEvent(new Event('change',{bubbles:true}));});
  }
  await withBuilderWrites(panel,['seo'],()=>page.evaluate(async()=>{
    if(typeof window.saveThemeSeoSettings!=='function')throw Error('Native SEO editor is not ready');
    const result=await window.saveThemeSeoSettings({silentButton:true});
    if(result?.status!=='success')throw Error('Native SEO save failed');
  }));
  await page.locator('#themeSeoModal [data-bs-dismiss="modal"]').first().click();
  return verifyPublicSeo(panel,input);
}

export async function verifyPublicSeo(panel,input){
  const page=panel.page;
  const publicResponse=await panel.context.request.get(panel.origin()+'/',{timeout:10000});
  if(!publicResponse.ok())throw Error('SEO saved but public readback is unavailable');
  const html=await publicResponse.text();
  const headEnd=html.slice(0,2*1024*1024).search(/<\/head\s*>/i);
  if(headEnd<0)throw Error('Public SEO head is missing or exceeds the readback budget');
  const headHtml=html.slice(0,headEnd);
  const head=await page.evaluate(html=>{
    const document=new DOMParser().parseFromString(html,'text/html');
    return {title:document.title,description:document.querySelector('meta[name="description"]')?.content,
      favicon:document.querySelector('link[rel~="icon"]')?.getAttribute('href')};
  },headHtml);
  if(input.title&&!head.title.includes(input.title))throw Error('SEO saved but the public title differs: '+head.title);
  if(input.suffix&&!head.title.endsWith(' • '+input.suffix))throw Error('SEO title suffix did not read back');
  if(input.description!==undefined&&head.description!==input.description)throw Error('SEO description did not read back');
  if(input.favicon){
    if(!head.favicon)throw Error('SEO saved but no public favicon was found');
    const url=new URL(head.favicon,panel.origin());
    if(url.origin!==panel.origin())throw Error('Public favicon belongs to another origin');
    const response=await panel.context.request.get(url.href,{timeout:10000});
    if(!response.ok()||!/^image\//i.test(response.headers()['content-type']??''))throw Error('Public favicon did not load as an image');
  }
  return {verified:true,...head};
}

export async function applyPageBuilderSettings(panel,fields){
  await panel.page.waitForFunction(()=>document.querySelector('[name="siteName"]')?.dataset.zeDirtyBound==='1',
    undefined,{timeout:8000});
  if(Object.keys(fields).some(name=>name.startsWith('--'))){
     
    for(const group of ['palette','important'])for(const dark of [false,true]){
      await panel.page.locator('[data-open-drawer="'+group+'"]').first().dispatchEvent('click');
      const toggle=panel.page.locator('#themeDrawerContent .drawer-switch-row input[type="checkbox"]');
      if(await toggle.count())await toggle.evaluate((e,dark)=>{
        if(e.checked===dark)return;e.checked=dark;e.dispatchEvent(new Event('change',{bubbles:true}));
      },dark);
      await panel.page.waitForFunction(id=>[...document.querySelectorAll('#'+id+' [name]')]
        .every(e=>e.form===document.getElementById('pageBuilderForm')),
        (group==='palette'?'palette':'important')+(dark?'Dark':'Light')+'Container');
    }
    const close=panel.page.locator('#btnCloseDrawer');if(await close.count())await close.dispatchEvent('click');
  }
  await panel.page.locator('#pageBuilderForm').evaluate((form,names)=>{
    for(const name of names){
      const controls=[...form.elements].filter(e=>e.name===name);
      if(controls.length&&controls.every(e=>e.dataset.themeHidden==='1'))
        throw Error('This color is derived or protected by the native panel: '+name);
    }
  },Object.keys(fields));
   
  for(const [name,theme]of [['--bs-primary','light'],['--bs-dark-primary','dark']]){
    if(!Object.hasOwn(fields,name))continue;
    const picker=panel.page.locator('.theme-main-input[data-theme="'+theme+'"]');
    if(await picker.count())await picker.evaluate((e,value)=>{
      e.value=value;e.dispatchEvent(new Event('input',{bubbles:true}));e.dispatchEvent(new Event('change',{bubbles:true}));
    },fields[name]);
  }
  await setFormValues(panel.page.locator('#pageBuilderForm'),fields);
   
   
  for(const [name,theme]of [['--bs-primary','light'],['--bs-dark-primary','dark']]){
    if(!Object.hasOwn(fields,name))continue;
    const picker=panel.page.locator('.theme-main-input[data-theme="'+theme+'"]');
    if(await picker.count())await picker.evaluate((e,value)=>{e.value=value;},fields[name]);
  }
  await saveBuilder(panel);
}

async function withBuilderWrites(panel,actions,callback){
  const operation=panel.catalog.find(item=>item.id==='settings-generalsettingsupdatecontroller');
  if(!operation)throw Error('Missing native PageBuilder save target');
  const matches=(request,operation)=>{
    const url=new URL(request.url());
    return request.method()==='POST'&&url.origin===panel.origin()&&url.pathname===operation.path
      &&Object.entries(operation.routing).every(([key,value])=>url.searchParams.get(key)===String(value))
      &&actions.includes(url.searchParams.get('action'));
  };
  const blocked=[];
  if(panel.addonWrite)throw Error('Another native panel write is already active');
  const guard=request=>{
    if(matches(request,operation))return true;
    const url=new URL(request.url());
    blocked.push({path:url.pathname,main:url.searchParams.get('main'),container:url.searchParams.get('container')});
    return false;
  };
  panel.addonWrite=guard;
  try{
    return await callback();
  }catch(error){
    throw Error(error.message+(blocked.length?'; blocked unexpected routes: '+JSON.stringify(blocked):''));
  }finally{
    panel.addonWrite=null;
  }
}

export async function saveBuilder(panel){
  return withBuilderWrites(panel,['update_settings','update_theme_settings','seo'],()=>panel.page.locator('#pageBuilderForm').evaluate(form=>new Promise((resolve,reject)=>{
    if(form.dataset.boundUnified!=='1')return reject(Error('Native PageBuilder submit is not ready'));
    if(!form.checkValidity())return reject(Error('Native PageBuilder validation failed'));
    const cleanup=()=>{clearTimeout(timer);document.removeEventListener('theme-savebar:form-finished',finished,true);};
    const finished=event=>{
      if(event.detail?.formId!==form.getAttribute('id'))return;
      cleanup();
      event.detail.ok?resolve({acknowledged:true}):reject(Error('Native PageBuilder rejected part of the save; read saved values before retrying'));
    };
    const timer=setTimeout(()=>{cleanup();reject(Error('Native PageBuilder save outcome is unknown; read saved values before retrying'));},30000);
    document.addEventListener('theme-savebar:form-finished',finished,true);
    try{form.requestSubmit();}catch(error){cleanup();reject(error);}
  })));
}
