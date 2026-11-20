import {createHash} from 'node:crypto';
import {matchesPost} from './panel-request.mjs';

const pageId='panel:site:page:main.smm';
const endpoint='/Files/Controllers/ControllersAll.php';
const controller=(origin,container)=>{
  const url=new URL(endpoint,origin);
  url.searchParams.set('main','SMM');url.searchParams.set('container',container);
  return url;
};
export const smmRecipes=Object.fromEntries(['get','sync'].map(action=>['smm.provider.'+action,{
  title:'SMM provider / '+action,pageId,smmAction:action,requiresRecord:true,
  documentation:['/guides/service-providers','/guides/smm-panel'],
  fields:action==='sync'?[{name:'expectedState',type:'text',required:true}]:[],
  verification:'Native provider sync and independent provider list readback'
}]));

async function readProvider(page,origin,id){
  const list=controller(origin,'ProviderListController');
  const result=await page.evaluate(async ({url,id})=>{
    const size=10;
    for(let start=0;start<10000;start+=size){
      const target=new URL(url);target.searchParams.set('start',String(start));
      target.searchParams.set('length',String(size));target.searchParams.set('search','');
      const response=await fetch(target,{credentials:'same-origin',redirect:'error',cache:'no-store',signal:AbortSignal.timeout(12000)});
      const data=await response.json();
      if(!response.ok||data.error||!Array.isArray(data.data)||!Number.isSafeInteger(Number(data.recordsFiltered)))throw Error('Provider list read failed');
      const row=data.data.find(row=>Number(row.id)===id);
      if(row)return {pageIndex:start/size,record:{id:Number(row.id),name:row.name,serviceCount:Number(row.service_count),lastSyncAt:row.last_sync_at,updatedAt:row.updated_at??null}};
      if(start+size>=Number(data.recordsFiltered))return null;
    }
    throw Error('Provider list exceeds the supported search limit');
  },{url:list.href,id});
  if(!result)throw Error('Provider was not found');
  const {record,pageIndex}=result;
  return {pageIndex,record:{...record,expectedState:createHash('sha256').update(JSON.stringify(record)).digest('hex')}};
}

export async function runSmmAction(panel,{recipe,workflowId,recordId,recordContext,fields,files,envFields,mode}){
  const action=recipe.smmAction;
  if(!['preview','apply'].includes(mode)||files.length||envFields.length||Object.keys(recordContext).length||!Number.isSafeInteger(recordId)||recordId<=0)
    throw Error('Select an SMM provider and use preview or apply mode');
  if(Object.keys(fields).some(key=>action!=='sync'||key!=='expectedState'))throw Error('Unsupported provider field');
  const page=await panel.navigate(pageId),origin=panel.origin();
  const initial=await readProvider(page,origin,recordId),before=initial.record;
  if(action==='get')return {workflowId,record:before,read:true,verified:true,submitted:false};
  if(mode==='preview')return {workflowId,record:before,ready:true,submitted:false};
  if(fields.expectedState!==before.expectedState)throw Error('Provider changed or expectedState is missing. Preview the current record.');
  await page.waitForFunction(()=>window.jQuery?.fn?.dataTable?.isDataTable('#providersTable'),{},{timeout:15000});
  await page.evaluate(index=>{
    const table=window.jQuery('#providersTable').DataTable();
    table.page(index).draw('page');
  },initial.pageIndex);
  const button=page.locator('#providersTable .provider-sync[data-id="'+recordId+'"]');
  await button.waitFor({state:'visible',timeout:15000});
  const current=await readProvider(page,origin,recordId);
  if(current.record.expectedState!==before.expectedState)throw Error('Provider changed before synchronization. Preview the current record.');
  const expected=controller(origin,'ProviderSyncServicesController'),body={provider_id:String(recordId)},allowed=['provider_id'];
  panel.expectedPost=expected;panel.expectedPostBody=body;panel.expectedPostFields=allowed;
  panel.oneShotPost=true;panel.allowWrites=true;
  const pending=page.waitForResponse(response=>matchesPost(response.request(),expected,body,allowed),{timeout:45000}).catch(()=>null);
  let count;
  try{
    await button.click();
    const response=await pending;
    if(!response)throw Error('Provider sync outcome is unknown. Read the provider before retrying.');
    const data=await response.json().catch(()=>null);
    if(!response.ok()||data?.status!=='success'||!Number.isSafeInteger(Number(data.count))||Number(data.count)<0)throw Error('The panel rejected provider synchronization');
    count=Number(data.count);
  }finally{
    panel.allowWrites=false;panel.expectedPost=null;panel.expectedPostBody=null;panel.expectedPostFields=null;panel.oneShotPost=false;
  }
  const after=(await readProvider(page,origin,recordId)).record;
  const verified=after.serviceCount===count&&typeof after.lastSyncAt==='string'&&after.lastSyncAt!==''&&after.lastSyncAt!=='-';
  panel.store.audit('panel.execute',workflowId,{recordId,verified});
  return {workflowId,record:after,recordId,count,submitted:true,acknowledged:true,verified};
}
