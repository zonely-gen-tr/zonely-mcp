import {createHash} from 'node:crypto';
import {matchesPost} from './panel-request.mjs';

const pageId='panel:site:page:main.creatorcenter';
const endpoint='/Files/Controllers/ControllersAll.php';
const controller=(origin,action)=>{
  const url=new URL(endpoint,origin);
  url.searchParams.set('main','CreatorCenter');
  url.searchParams.set('container','CreatorCenterController');
  url.searchParams.set('action',action);
  return url;
};
const hash=value=>createHash('sha256').update(JSON.stringify(value)).digest('hex');
export const creatorRecipes=Object.fromEntries(['settings.get','submission.get','submission.approve','submission.reject'].map(action=>['creator.'+action,{
  title:'Creator Center / '+action,pageId,creatorAction:action,
  requiresRecord:action.startsWith('submission.'),documentation:['/guides/creator-center'],
  fields:action.endsWith('.approve')?[{name:'expectedState',type:'text',required:true}]:
    action.endsWith('.reject')?[{name:'expectedState',type:'text',required:true},{name:'reason',type:'text',required:true}]:[],
  verification:'Independent admin bootstrap readback; pending submission review using native controls'
}]));

async function bootstrap(page,origin){
  const result=await page.evaluate(async url=>{
    const response=await fetch(url,{credentials:'same-origin',redirect:'error',cache:'no-store',
      headers:{'X-Requested-With':'XMLHttpRequest'},signal:AbortSignal.timeout(15000)});
    const data=await response.json();
    if(!response.ok||data.status!=='success'||!data.settings||!Array.isArray(data.submissions)||!Array.isArray(data.creators))throw Error('Creator Center read failed');
    return data;
  },controller(origin,'admin_bootstrap').href);
  return result;
}
function submission(data,id){
  const item=data.submissions.find(row=>Number(row.id)===id);
  if(!item)throw Error('Submission was not found in the admin catalog');
  const record={id:Number(item.id),userId:Number(item.user_id),title:item.title,platform:item.platform,
    url:item.url,status:item.status,points:Number(item.points_awarded),reason:item.rejection_reason,
    reviewedAt:item.reviewed_at,updatedAt:item.updated_at};
  const creator=data.creators.find(row=>Number(row.user?.id)===record.userId);
  const totals={points:Number(creator?.points??0),approvedCount:Number(creator?.approved_count??0)};
  return {...record,totals,expectedState:hash({record,settings:data.settings,totals})};
}

export async function runCreatorAction(panel,{recipe,workflowId,recordId,recordContext,fields,files,envFields,mode}){
  const action=recipe.creatorAction,settingsOnly=action==='settings.get',decision=action.split('.')[1];
  if(!['preview','apply'].includes(mode)||files.length||envFields.length||Object.keys(recordContext).length||
    (settingsOnly?recordId!==undefined:!Number.isSafeInteger(recordId)||recordId<=0))throw Error('Select the appropriate Creator Center record');
  const allowed=decision==='reject'?['expectedState','reason']:decision==='approve'?['expectedState']:[];
  if(Object.keys(fields).some(key=>!allowed.includes(key)))throw Error('Unsupported Creator Center field');
  const page=await panel.navigate(pageId),origin=panel.origin();
  const initial=await bootstrap(page,origin);
  if(settingsOnly)return {workflowId,settings:initial.settings,counts:initial.counts,read:true,verified:true,submitted:false};
  const before=submission(initial,recordId);
  if(decision==='get')return {workflowId,record:before,read:true,verified:true,submitted:false};
  const ready=before.status==='pending'&&(decision==='reject'||initial.settings.rewards?.length===0);
  if(mode==='preview')return {workflowId,record:before,ready,submitted:false};
  if(fields.expectedState!==before.expectedState)throw Error('Submission changed or expectedState is missing. Preview the current record.');
  if(!ready)throw Error('Review requires a pending submission; approval currently requires an empty reward catalog');
  const reason=decision==='reject'?fields.reason:'';
  if(typeof reason!=='string'||(decision==='reject'&&(!reason||reason.length>500||reason!==reason.trim()||
    /[<>&]/.test(reason)||/\s{2,}|[\r\n\t]/.test(reason))))throw Error('Provide a plain single-line rejection reason of 1 to 500 characters');
  const selector='[data-'+decision+'="'+recordId+'"]';
  await page.waitForFunction(()=>window.jQuery?.fn?.dataTable?.isDataTable('[data-cc-submissions-table]'),{},{timeout:15000});
  await page.evaluate(selector=>{
    const table=window.jQuery('[data-cc-submissions-table]').DataTable();
    const rows=table.rows({order:'applied',search:'applied'}).nodes().toArray();
    const index=rows.findIndex(row=>row.querySelector(selector));
    if(index<0)throw Error('Native review button not found');
    table.page(Math.floor(index/table.page.len())).draw('page');
  },selector);
  const button=page.locator('[data-cc-submissions-table] '+selector);
  await button.waitFor({state:'visible',timeout:15000});
  const current=submission(await bootstrap(page,origin),recordId);
  if(current.expectedState!==before.expectedState)throw Error('Submission changed before review. Preview the current record.');
  const csrf=await page.locator('[data-cc-csrf] input').evaluateAll(inputs=>inputs.map(input=>[input.name,input.value]));
  if(!csrf.length||csrf.some(([name,value])=>!name||!value))throw Error('Creator Center CSRF unavailable');
  const body=[...csrf,['submission_id',String(recordId)],['decision',decision],['reason',reason]];
  const expected=controller(origin,'review');
  panel.expectedPost=expected;panel.expectedPostBody=body;panel.expectedPostFields=body.map(([name])=>name);
  panel.oneShotPost=true;panel.allowWrites=true;
  const pending=page.waitForResponse(response=>matchesPost(response.request(),expected,body,body.map(([name])=>name)),{timeout:30000}).catch(()=>null);
  try{
    if(decision==='reject'){
      const swal=await page.evaluate(()=>typeof window.Swal?.fire==='function');
      if(swal){
        await button.click();
        await page.locator('.swal2-popup textarea').fill(reason);
        await page.locator('.swal2-confirm').click();
      }else{
        page.once('dialog',dialog=>dialog.accept(reason));
        await button.click();
      }
    }else await button.click();
    const response=await pending;
    if(!response)throw Error('Review outcome unknown. Read the submission before retrying.');
    const data=await response.json().catch(()=>null);
    if(!response.ok()||data?.status!=='success')throw Error('The panel rejected the review');
  }finally{
    panel.allowWrites=false;panel.expectedPost=null;panel.expectedPostBody=null;panel.expectedPostFields=null;panel.oneShotPost=false;
  }
  const after=submission(await bootstrap(page,origin),recordId);
  const points=decision==='approve'?Number(initial.settings.points_per_approved):0;
  const verified=after.status===(decision==='approve'?'approved':'rejected')&&after.reason===reason&&after.points===points&&
    after.totals.points===before.totals.points+points&&after.totals.approvedCount===before.totals.approvedCount+(decision==='approve'?1:0);
  panel.store.audit('panel.execute',workflowId,{recordId,verified});
  return {workflowId,record:after,recordId,submitted:true,acknowledged:true,verified};
}