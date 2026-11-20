import {errors} from 'playwright';
import {setFormValues} from './panel-fields.mjs';

const endpoint='/Files/Controllers/ControllersAll.php';

function announcementUrl(origin,id){
  const url=new URL(endpoint,origin);
  url.search=new URLSearchParams({main:'broadcasts',container:'broadcastsEditController',id:String(id)});
  return url;
}

function recordFrom(result,id){
  const row=result?.broadcasts;
  if(result?.status!=='success'||Number(row?.id)!==id)throw Error('The announcement is unavailable for this panel session');
  return row;
}

export async function openAnnouncementEditor(page,origin,form,id){
  await page.waitForFunction(()=>typeof window.zonelyOpenBroadcastEditor==='function');
  const expected=announcementUrl(origin,id);
  const pending=page.waitForResponse(response=>{
    const actual=new URL(response.url());
    return response.request().method()==='GET'&&actual.origin===expected.origin&&actual.pathname===expected.pathname&&
      [...expected.searchParams].every(([key,value])=>actual.searchParams.get(key)===value);
  },{timeout:12000}).catch(()=>null);
  await page.evaluate(recordId=>window.zonelyOpenBroadcastEditor(recordId),id);
  const response=await pending;
  if(!response?.ok())throw Error('The announcement edit panel could not load the selected record');
  const row=recordFrom(await response.json(),id);
   
  const hydrated=await page.waitForFunction(({form,id,title,category,comments,savedContent,savedTags})=>{
    const fields=document.querySelector(form)?.elements;
    if(!fields)return false;
    const content=fields.namedItem('content');
    const html=value=>new DOMParser().parseFromString(String(value??''),'text/html').body.innerHTML.trim();
    const tags=fields?.namedItem('tags')?.value??'';
    let encodedTags;
    try{encodedTags=JSON.parse(tags);}catch{}
    const selected=(Array.isArray(encodedTags)?encodedTags.map(tag=>tag?.value??tag):tags.split(','))
      .map(tag=>String(tag).trim()).filter(Boolean).sort().join(',');
    return fields?.namedItem('id')?.value===String(id)&&fields?.namedItem('title')?.value===title&&
      (fields?.namedItem('category_id')?.value||'0')===category&&selected===savedTags&&
      fields.namedItem('commentscheck')?.value===comments&&html(content?.value)===html(savedContent);
  },{form,id,title:String(row.title),category:String(row.category||'0'),comments:String(row.commentscheck??''),savedContent:row.content,
    savedTags:String(row.tags??'').split(',').map(tag=>tag.trim()).filter(Boolean).sort().join(',')},{timeout:2500})
    .catch(error=>{if(!(error instanceof errors.TimeoutError))throw error;return null;});
  if(hydrated)await hydrated.dispose();
  else{
    const editForm=page.locator(form);
    const category=await editForm.locator('select[name="category_id"]').evaluate((control,value)=>{
      const allowed=[...control.options].map(option=>option.value);
      if(value)return allowed.includes(value)?value:null;
      return allowed.find(option=>option===''||option==='0')??null;
    },row.category?String(row.category):'');
    if(category===null)throw Error('The saved announcement category is unavailable in the edit form');
    await setFormValues(editForm,{id:String(row.id),title:String(row.title??''),content:String(row.content??''),
      tags:String(row.tags??''),category_id:category,commentscheck:String(row.commentscheck??''),
      date_timeout:String(row.date_timeout??'')});
  }
  return row;
}

export async function verifyAnnouncementEdit(page,origin,before,fields,files,{create=false}={}){
  const url=announcementUrl(origin,before.id);
  const expected={...before,...fields,category:fields.category_id??before.category};
  const body=await page.evaluate(async ({url,expected,before,changedImage,create,requested})=>{
    const response=await fetch(url,{credentials:'same-origin',cache:'no-store',headers:{'X-Requested-With':'XMLHttpRequest'},signal:AbortSignal.timeout(12000)});
    if(!response.ok)return null;
    const result=await response.json();
    const row=result?.broadcasts;
    if(result?.status!=='success'||Number(row?.id)!==Number(before.id))return null;
    const html=value=>{
      const root=new DOMParser().parseFromString(String(value??''),'text/html').body;
      for(const element of root.querySelectorAll('*')){
         
        if(element.tagName==='IMG'&&element.hasAttribute('data-src')&&element.classList.contains('lozad')){
          if(!element.hasAttribute('src'))element.setAttribute('src',element.getAttribute('data-src'));
          if(element.getAttribute('src')===element.getAttribute('data-src')){
            element.removeAttribute('data-src');
            element.classList.remove('lozad');
            if(!element.className)element.removeAttribute('class');
          }
        }
         
        if(element.tagName==='IMG'&&element.classList.length===2&&element.classList.contains('fr-fic')&&element.classList.contains('fr-dii'))
          element.removeAttribute('class');
        const attributes=[...element.attributes].sort((a,b)=>a.name.localeCompare(b.name));
        for(const {name,value} of attributes){element.removeAttribute(name);element.setAttribute(name,value);}
      }
      return root.innerHTML.trim();
    };
    const tags=value=>{
      let list;
      try{list=JSON.parse(value);}catch{}
      return (Array.isArray(list)?list.map(tag=>tag?.value??tag):String(value??'').split(','))
        .map(tag=>String(tag).trim()).filter(Boolean).sort().join(',');
    };
    const date=value=>String(value??'').trim().replace('T',' ');
    const flags={
      title:String(row.title??'')===String(expected.title??''),
      content:html(row.content)===html(expected.content),
      category_id:String(row.category||'0')===String(expected.category||'0'),
      commentscheck:String(row.commentscheck??'')===String(expected.commentscheck??''),
      tags:tags(row.tags)===tags(expected.tags),
      date_timeout:date(row.date_timeout)===date(expected.date_timeout)||
        (/^\d{4}-\d{2}-\d{2}$/.test(date(expected.date_timeout))&&date(row.date_timeout)===date(expected.date_timeout)+' 00:00:00'),
      image:changedImage?Boolean(row.image_id&&row.image_id!==before.image_id):
        row.image_id===before.image_id&&row.image_type===before.image_type
    };
    if(create){
      for(const field of Object.keys(flags)){
        if(field==='image'?!changedImage:!requested.includes(field))delete flags[field];
      }
    }
    return {id:Number(row.id),title:String(row.title),flags};
  },{url:url.href,expected,before,changedImage:files.some(file=>file.field==='image'),create,requested:Object.keys(fields)});
  if(!body)throw Error('Announcement update acknowledged, but the selected record could not be read back');
  const unverifiedFields=Object.entries(body.flags).filter(([,matches])=>!matches).map(([field])=>field);
  return {verified:!unverifiedFields.length,record:{id:body.id,title:body.title},
    ...(unverifiedFields.length?{unverifiedFields,hint:'Inspect the saved announcement before retrying.'}:{})};
}
