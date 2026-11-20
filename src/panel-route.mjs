import {createHash} from 'node:crypto';
import {matchesPost} from './panel-request.mjs';

const pageId='panel:site:page:main.routefilters';
const endpoint='/Files/Src/MVC/Http/Endpoints/navigation.php';
const editable=['name','lastUrl','newUrl'];
const publicRecord=f=>({id:Number(f.id),origin:f.origin??'custom',kind:f.kind??'alias',
  name:f.name??'',lastUrl:f.lastUrl,newUrl:f.newUrl,
  expectedState:createHash('sha256').update(JSON.stringify(f)).digest('hex')});

export const routeRecipes=Object.fromEntries(['create','alias','edit','delete','get'].map(action=>['route.'+action,{
  title:'Route filters / '+action,pageId,routeAction:action,requiresRecord:['edit','delete','get'].includes(action),
  documentation:['/guides/route-filters'],
  fields:[...(['create','alias','edit'].includes(action)?editable.map(name=>({name,type:'text'})):[]),
    ...(['edit','delete'].includes(action)?[{name:'expectedState',type:'text',required:true}]:[])],
  verification:'Native route filter response and independent navigation catalog readback'
}]));

async function readCatalog(page,origin){
  return page.evaluate(async ({origin,endpoint})=>{
    const url=new URL(endpoint,origin);url.searchParams.set('action','catalog');
    const response=await fetch(url,{credentials:'same-origin',redirect:'error',signal:AbortSignal.timeout(12000)});
    const text=await response.text();
    if(!response.ok||text.length>4*1024*1024)throw Error('Navigation catalog read failed');
    const result=JSON.parse(text);
    if(result.status!=='success'||!Array.isArray(result.filters)||!Array.isArray(result.routes)||!result.csrf)
      throw Error('Navigation catalog returned unexpected data');
    return {filters:result.filters,routes:result.routes,csrf:result.csrf};
  },{origin,endpoint});
}

async function write(panel,page,origin,action,body,trigger){
  const expected=new URL(endpoint,origin);expected.searchParams.set('action',action);
  const allowed=Object.keys(body);
  panel.expectedPost=expected;panel.expectedPostBody=body;panel.expectedPostFields=allowed;
  panel.oneShotPost=true;panel.allowWrites=true;
  const pending=page.waitForResponse(r=>matchesPost(r.request(),expected,body,allowed),{timeout:20000}).catch(()=>null);
  try{
    await trigger();
    const response=await pending;
    if(!response)throw Error('Route write outcome is unknown. Read the catalog before retrying.');
    const result=await response.json().catch(()=>null);
    if(!response.ok()||result?.status!=='success')throw Error(result?.message??'The panel rejected the route operation');
    return result;
  }finally{
    panel.allowWrites=false;panel.expectedPost=null;panel.expectedPostBody=null;panel.expectedPostFields=null;panel.oneShotPost=false;
  }
}

async function locate(root,route,action,id){
  await root.locator('[data-route-scope]').selectOption(route.scope);
  await root.locator('[data-route-search]').fill(route.canonical);
  const button=root.locator(action==='delete'?'[data-route-delete]':'[data-route-edit]').filter({});
  const exact=action==='delete'?root.locator('[data-route-delete="'+id+'"]'):
    button.and(root.locator('[data-route-edit='+JSON.stringify(route.key)+']'));
  await exact.waitFor({state:'attached',timeout:10000});
  await exact.dispatchEvent('click');
}

export async function runRouteAction(panel,{recipe,workflowId,recordId,recordContext,fields,files,envFields,mode}){
  const action=recipe.routeAction;
  if(!['preview','apply'].includes(mode)||files.length||envFields.length||Object.keys(recordContext).length)
    throw Error('Use route fields and preview or apply mode');
  const existing=['edit','delete','get'].includes(action);
  if(existing?(!Number.isSafeInteger(recordId)||recordId<=0):recordId!==undefined)throw Error('Select a valid route record');
  const allowed=action==='get'?[]:action==='delete'?['expectedState']:action==='edit'?[...editable,'expectedState']:editable;
  if(Object.keys(fields).some(name=>!allowed.includes(name)))throw Error('Unsupported route field');
  const page=await panel.navigate(pageId);
  const root=page.locator('[data-route-admin]');
  await page.locator('[data-route-admin][data-ready="1"]').waitFor({state:'attached',timeout:15000});
  const origin=panel.origin(),initial=await readCatalog(page,origin);
  const selected=initial.filters.find(f=>Number(f.id)===recordId);
  if(existing&&!selected)throw Error('Route filter was not found');
  const before=selected?publicRecord(selected):undefined;
  if(action==='get')return {workflowId,read:true,verified:true,submitted:false,record:before};
  if(mode==='apply'&&selected&&fields.expectedState!==before.expectedState)throw Error('Route changed or expectedState is missing. Preview the current record.');
  const route=initial.routes.find(r=>r.canonical===(selected?.lastUrl??fields.lastUrl));
  if(action==='delete'){
    if(before.origin!=='custom'||!route)throw Error('Only an existing custom route can be deleted');
    if(mode==='preview')return {workflowId,ready:true,submitted:false,record:before};
    const result=await write(panel,page,origin,'filter-delete',{id:recordId,csrf:initial.csrf},async()=>{
      await locate(root,route,'delete',recordId);
      await page.locator('.swal2-confirm').click();
    });
    const after=await readCatalog(page,origin),verified=!after.filters.some(f=>Number(f.id)===recordId);
    panel.store.audit('panel.execute',workflowId,{recordId,verified});
    return {workflowId,submitted:true,acknowledged:result.status==='success',verified,recordId};
  }
  const kind=before?.kind??(action==='alias'?'alias':'redirect');
  const defaults=before??{name:'',lastUrl:'',newUrl:''};
  const desired=Object.fromEntries(editable.map(name=>[name,fields[name]??defaults[name]]));
  if(mode==='preview'&&!selected&&!Object.keys(fields).length)
    return {workflowId,ready:true,submitted:false,fields:editable,defaults,
      ...(action==='alias'?{routes:initial.routes.filter(r=>r.kind!=='redirect').map(r=>({canonical:r.canonical,name:r.name,scope:r.scope}))}:{})};
  if(editable.some(name=>typeof desired[name]!=='string'||desired[name]!==desired[name].trim())||
    !desired.lastUrl.startsWith('/')||!desired.newUrl||desired.name.length>180)
    throw Error('Provide valid trimmed route name and paths');
  if(kind==='alias'){
    if(!route||route.kind==='redirect'||desired.lastUrl!==route.canonical||!desired.newUrl.startsWith('/'))
      throw Error('Select a catalog page and a site-local alias preserving its parameters');
    if(!selected&&initial.filters.some(f=>f.lastUrl===desired.lastUrl))throw Error('This route already has a filter. Edit the existing record.');
  }else{
    let target;try{target=new URL(desired.newUrl);}catch{}
    if(!target||target.protocol!=='https:'||target.username||target.password||target.origin===origin)
      throw Error('Redirect destination must be an external HTTPS URL');
  }
  if(mode==='preview')return {workflowId,ready:true,submitted:false,record:before,proposed:{kind,...desired}};
  if(action==='create'){
    await root.locator('[data-route-scope]').selectOption('theme');
    await root.locator('[data-route-add]').click();
  }else{
    if(!route)throw Error('Native route was not found in the catalog');
    await locate(root,route,'edit');
  }
  const form=root.locator('[data-route-form]');
  await form.waitFor({state:'visible',timeout:10000});
  const id=selected?String(recordId):'0';
  if(await form.locator('[name=id]').inputValue()!==id||await form.locator('[name=kind]').inputValue()!==kind)
    throw Error('Native route dialog returned a different record or kind');
  if(kind==='redirect')await form.locator('[name=redirectPath]').fill(desired.lastUrl);
  for(const name of ['name','newUrl'])await form.locator('[name='+name+']').fill(desired[name]);
  const actual=await form.evaluate(node=>({...Object.fromEntries(new FormData(node)),
    lastUrl:node.elements.kind.value==='redirect'?node.elements.redirectPath.value:node.elements.lastUrl.value}));
  if(actual.id!==id||actual.kind!==kind||editable.some(name=>actual[name]!==desired[name])||
    actual.origin!==(before?.origin??(action==='alias'?'default':'custom')))
    throw Error('Native route form did not accept requested values');
  const fresh=await readCatalog(page,origin);
  if(selected&&!fresh.filters.some(f=>Number(f.id)===recordId&&publicRecord(f).expectedState===before.expectedState))
    throw Error('Route changed while preparing the dialog. Preview the current record.');
  const result=await write(panel,page,origin,'filter-save',{...actual,csrf:fresh.csrf},()=>form.locator('[type=submit]').click());
  const savedId=Number(result.filter?.id),after=await readCatalog(page,origin),saved=after.filters.find(f=>Number(f.id)===savedId);
  const verified=Number.isSafeInteger(savedId)&&savedId>0&&!!saved&&
    (selected?savedId===recordId:!initial.filters.some(f=>Number(f.id)===savedId))&&
    (saved.kind??'alias')===kind&&editable.every(name=>publicRecord(saved)[name]===desired[name]);
  panel.store.audit('panel.execute',workflowId,{recordId:savedId,verified});
  return {workflowId,submitted:true,acknowledged:true,verified,record:saved?publicRecord(saved):undefined};
}

