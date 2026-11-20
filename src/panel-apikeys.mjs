import {matchesPost} from './panel-request.mjs';

const pageId='panel:site:page:main.apikeys';
const controller=(origin,container)=>new URL('/Files/Controllers/ControllersAll.php?main=ApiKeys&container='+container,origin);
export const apiKeyRecipes=Object.fromEntries(['get','status','reset'].map(action=>['apikeys.'+action,{
  title:'API keys / '+action,pageId,apiKeyAction:action,documentation:['/guides/api-key'],
  fields:action==='get'?[]:[{name:'expectedState',type:'text',required:true},
    ...(action==='status'?[{name:'enabled',type:'boolean',required:true}]:[])],
  verification:'Independent API settings readback with a browser-computed state digest; key never returned'
}]));

async function readState(page,origin){
  return page.evaluate(async url=>{
    const response=await fetch(url,{credentials:'same-origin',redirect:'error',cache:'no-store',
      headers:{'X-Requested-With':'XMLHttpRequest'},signal:AbortSignal.timeout(15000)});
    if(!response.ok)throw Error('API settings read failed');
    const data=await response.json();
    if(typeof data.api_key!=='string'||![0,1,'0','1'].includes(data.api_status))throw Error('Invalid API settings response');
    const enabled=Number(data.api_status)===1;
    const digest=async value=>Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(value))),byte=>byte.toString(16).padStart(2,'0')).join('');
    const expectedState=await digest(JSON.stringify([data.api_key,enabled]));
    const keyDigest=await digest(data.api_key);
    return {enabled,hasKey:data.api_key.length>0,expectedState,keyDigest};
  },controller(origin,'ApiKeyGetController').href);
}

const publicState=({enabled,hasKey,expectedState})=>({enabled,hasKey,expectedState});

export async function runApiKeyAction(panel,{recipe,workflowId,recordId,recordContext,fields,files,envFields,mode}){
  const action=recipe.apiKeyAction;
  const allowed=action==='get'?[]:action==='status'?['expectedState','enabled']:['expectedState'];
  if(!['preview','apply'].includes(mode)||recordId!==undefined||files.length||envFields.length||Object.keys(recordContext).length||
    Object.keys(fields).some(key=>!allowed.includes(key)))throw Error('Unsupported API settings input');
  const page=await panel.navigate(pageId),origin=panel.origin();
  const before=await readState(page,origin);
  if(action==='get'||mode==='preview')return {workflowId,settings:publicState(before),read:true,verified:true,submitted:false};
  if(fields.expectedState!==before.expectedState)throw Error('API settings changed or expectedState is missing. Preview again.');
  if(action==='status'&&typeof fields.enabled!=='boolean')throw Error('Provide enabled as a boolean');
  if(action==='status'&&fields.enabled===before.enabled)return {workflowId,settings:publicState(before),submitted:false,verified:true};
  const toggle=page.locator('#api_status_toggle'),reset=page.locator('#api_key_reset_btn');
  await page.waitForFunction(async ({digest,enabled})=>{
    const key=document.querySelector('#api_key_display'),toggle=document.querySelector('#api_status_toggle');
    if(!key||!toggle||toggle.checked!==enabled)return false;
    const actual=Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(key.value))),byte=>byte.toString(16).padStart(2,'0')).join('');
    return actual===digest;
  },{digest:before.keyDigest,enabled:before.enabled},{timeout:15000});
  if(action==='reset'){
    await reset.click();
    await page.locator('.swal2-confirm').waitFor({state:'visible'});
  }
  if((await readState(page,origin)).expectedState!==before.expectedState)throw Error('API settings changed before submission. Preview again.');
  const expected=controller(origin,action==='reset'?'ApiKeysResetController':'ApiStatusToggleController');
  const body=action==='reset'?[]:[['status',fields.enabled?'1':'0']];
  panel.expectedPost=expected;panel.expectedPostBody=body;panel.expectedPostFields=body.map(([name])=>name);
  panel.oneShotPost=true;panel.allowWrites=true;
  const pending=page.waitForResponse(response=>matchesPost(response.request(),expected,body,body.map(([name])=>name)),{timeout:30000}).catch(()=>null);
  try{
    if(action==='reset')await page.locator('.swal2-confirm').click();
    else await toggle.setChecked(fields.enabled);
    const response=await pending;
    if(!response)throw Error('API settings outcome unknown. Read the settings before retrying.');
    if(!response.ok())throw Error('The panel rejected the API settings change');
  }finally{
    panel.allowWrites=false;panel.expectedPost=null;panel.expectedPostBody=null;panel.expectedPostFields=null;panel.oneShotPost=false;
  }
  const after=await readState(page,origin);
  const verified=action==='reset'?after.hasKey&&after.keyDigest!==before.keyDigest&&after.enabled===before.enabled:
    after.enabled===fields.enabled&&after.keyDigest===before.keyDigest;
  panel.store.audit('panel.execute',workflowId,{verified});
  return {workflowId,settings:publicState(after),submitted:true,verified};
}
