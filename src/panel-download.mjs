import fs from 'node:fs/promises';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import {Readable,Transform} from 'node:stream';
import {pipeline} from 'node:stream/promises';
import {nativePost} from './panel-renewal.mjs';

const maxDownloadBytes=100*1024*1024;

async function saveUpdateFile(panel,url,file){
  const cookies=await panel.context.cookies(url);
  const cookie=cookies.map(item=>item.name+'='+item.value).join('; ');
  const response=await fetch(url,{
    headers:cookie?{cookie}:{},redirect:'error',signal:AbortSignal.timeout(20000),
  });
  if(!response.ok||!response.body||/^text\/html\b|^application\/json\b/i.test(response.headers.get('content-type')??''))
    throw Error('The site did not return the requested update file');
  if(Number(response.headers.get('content-length')??0)>maxDownloadBytes)
    throw Error('The downloaded update is larger than 100 MiB');
  const output=await fs.open(file,'wx');
  let size=0;
  const limiter=new Transform({transform(chunk,_encoding,done){
    size+=chunk.length;
    if(size>maxDownloadBytes)done(Error('The downloaded update is larger than 100 MiB'));
    else done(null,chunk);
  }});
  try{
    await pipeline(Readable.fromWeb(response.body),limiter,output.createWriteStream());
    if(!size)throw Error('The downloaded update is empty');
    return size;
  }catch(error){
    await output.close().catch(()=>{});
    await fs.unlink(file).catch(()=>{});
    throw error;
  }
}

export async function runProductDownload(panel,{page,recipe,operation,recordId,productId,mode}){
  const trigger=page.locator('.updates[data-id="'+productId+'"]').first();
  try{await trigger.waitFor({state:'visible',timeout:6000});}
  catch{throw Error('This product update list is unavailable in the customer account');}
  await trigger.click();
  const update=page.locator('#songuncellemeler .edit-updates[data-id="'+recordId+'"]').first();
  try{await update.waitFor({state:'attached',timeout:9000});}
  catch{throw Error('The requested update is absent from the selected product list');}
  const form=page.locator('#updates-content-container').locator(recipe.form);
  await update.dispatchEvent('click');
  await form.waitFor({state:'attached',timeout:9000});
  const modal=page.locator('#updates_edit');
  const identity=modal.locator('input[name="id"]');
  if(await identity.count()!==1||(await identity.inputValue()).trim()!==String(recordId))
    throw Error('The site opened a different product update');
  if(mode==='preview')return {ready:true,mode,workflowId:recipe.id,submitted:false,productId,recordId};
  await identity.evaluate((input,id)=>{input.value=id;},String(recordId));
   
  const formId=await form.getAttribute('id');
  await modal.locator('input[type="hidden"]').evaluateAll((controls,id)=>{
    for(const input of controls)if(!input.form)input.setAttribute('form',id);
  },formId);
  const expected=new URL(operation.path,panel.origin());
  for(const [name,value]of Object.entries(operation.routing))expected.searchParams.set(name,String(value));
  const key='zonelyDownload'+randomUUID();
  await page.evaluate(key=>{
    window[key]={};
    window[key].handle=event=>{
      const anchor=event.target.closest?.('a[download][href]');
      if(!anchor||window[key].url)return;
       
       
      event.preventDefault();
      window[key].url=anchor.href;
      window[key].name=anchor.download;
    };
    document.addEventListener('click',window[key].handle,true);
  },key);
  try{
    await nativePost(panel,page,expected,{id:String(recordId)},()=>form.evaluate(node=>node.requestSubmit()),{download:true});
    const link=await page.waitForFunction(key=>{
      const captured=window[key];
      return captured?.url?{url:captured.url,name:captured.name}:null;
    },key,{timeout:8000}).then(handle=>handle.jsonValue()).catch(()=>null);
    if(!link)throw Error('The request was accepted but the storefront did not open a download link');
    const url=new URL(link.url);
    if(url.origin!==panel.origin()||url.username||url.password)
      throw Error('Open the customer browser to download from the external provider');
    const extension=path.extname(link.name||url.pathname).match(/^\.[a-z0-9]{1,8}$/i)?.[0]??'';
    const directory=path.join(panel.config.runtime,'downloads');
    await fs.mkdir(directory,{recursive:true});
    const file=path.join(directory,randomUUID()+extension);
    const size=await saveUpdateFile(panel,url.href,file);
    return {submitted:true,acknowledged:true,verified:true,workflowId:recipe.id,productId,recordId,file,size};
  }finally{
    await page.evaluate(key=>{
      if(window[key]?.handle)document.removeEventListener('click',window[key].handle,true);
      delete window[key];
    },key).catch(()=>{});
  }
}
