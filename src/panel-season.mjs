import {createHash} from 'node:crypto';
import {matchesPost} from './panel-request.mjs';

const pageId='panel:site:page:main.seasons';
const drawerId='panel:site:drawer:seasons_update';
const endpoint='/Files/Src/MVC/Http/Endpoints/community.php';
const editable=['summary','passTitle','rewardsTitle','goals'];
const record=s=>({id:Number(s.id),title:s.title,connection:s.connection_type,
  summary:s.feature?.summary??'',enabled:!!s.feature?.pass?.enabled,
  passTitle:s.feature?.pass?.title,rewardsTitle:s.feature?.pass?.rewards_title,
  goals:s.feature?.pass?.tiers?.map(t=>Number(t.goal))??[],
  expectedState:createHash('sha256').update(JSON.stringify(s)).digest('hex')});

export const seasonRecipes=Object.fromEntries(['get','edit'].map(action=>['season.pass.'+action,{
  title:'Season pass / '+action,pageId,drawerId,requiresRecord:true,seasonAction:action,
  documentation:['/guides/seasons','/guides/season-tickets'],
  fields:action==='get'?[]:[{name:'expectedState',type:'text',required:true},
    {name:'summary',type:'textarea'},{name:'passTitle',type:'text'},{name:'rewardsTitle',type:'text'},
    {name:'goals',type:'array'}],
  verification:'Native season editor and independent season catalog readback'
}]));

async function catalog(page,origin){
  return page.evaluate(async ({origin,endpoint})=>{
    const url=new URL(endpoint,origin);url.searchParams.set('action','season-admin');
    const response=await fetch(url,{credentials:'same-origin',redirect:'error',signal:AbortSignal.timeout(12000)});
    const data=await response.json();
    if(!response.ok||data.status!=='success'||!Array.isArray(data.seasons)||!data.csrf)throw Error('Season catalog read failed');
    return {seasons:data.seasons,csrf:data.csrf};
  },{origin,endpoint});
}

async function nativeRequest(panel,page,origin,action,body,trigger){
  const expected=new URL(endpoint,origin);expected.searchParams.set('action',action);
  const allowed=Array.isArray(body)?undefined:Object.keys(body);
  panel.expectedPost=expected;panel.expectedPostBody=body;panel.expectedPostFields=allowed;
  panel.oneShotPost=true;panel.allowWrites=true;
  const pending=page.waitForResponse(r=>matchesPost(r.request(),expected,body,allowed),{timeout:20000}).catch(()=>null);
  try{
    await trigger();
    const response=await pending;
    if(!response)throw Error('Season '+action+' outcome is unknown. Read the catalog before retrying.');
    const data=await response.json().catch(()=>null);
    if(!response.ok()||data?.status!=='success')throw Error('The panel rejected season '+action);
    return data;
  }finally{
    panel.allowWrites=false;panel.expectedPost=null;panel.expectedPostBody=null;panel.expectedPostFields=null;panel.oneShotPost=false;
  }
}

 
async function snapshot(form,csrf){
  return form.evaluate((form,csrf)=>{
    const root=form.querySelector('[data-community-season-editor]'),q=s=>root.querySelector(s);
    const pass={enabled:q('[data-season-pass-enabled]').checked,title:q('[data-season-pass-title]').value.trim()||'Sezon Bileti',
      rewards_title:q('[data-season-rewards-title]').value.trim()||'Seviye Ödülleri',progress_column:q('[data-season-progress-column]').value,
      premium_price:Number(q('[data-season-premium-price]').value),tiers:[]};
    for(const tier of root.querySelectorAll('.community-tier')){
      const t={goal:Number(tier.querySelector('[data-tier-goal]').value)};
      for(const r of tier.querySelectorAll('[data-reward-lane]')){
        const kind=r.querySelector('[data-reward-kind]').value,lane=r.dataset.rewardLane;
        if(!kind||lane==='premium'&&pass.premium_price<=0){t[lane]=null;continue;}
        const icon=r.querySelector('[data-reward-icon]').value;
        if(!['CREDIT','COMMAND'].includes(kind)){t[lane]={source:kind,icon};continue;}
        const value={type:kind,name:r.querySelector('[data-reward-name]').value,icon,image:r.dataset.legacyImage||''};
        if(kind==='CREDIT')value.credit_amount=Number(r.querySelector('[data-reward-credit]').value);
        else value.servers=[...r.querySelectorAll('[data-reward-command-server]')].map((server,i)=>({order:i,
          id:Number(server.querySelector('[data-command-server]').value),commands:[...server.querySelectorAll('.season-pass-command')].map((row,j)=>({order:j,
            cmd:row.querySelector('[data-reward-command]').value,desc:row.querySelector('[data-reward-description]').value}))}));
        t[lane]=value;
      }
      pass.tiers.push(t);
    }
    const config={summary:q('[data-season-summary]').value,image:q('[data-season-image]').value,time_column:q('[data-season-time-column]').value,pass};
    const fd=new FormData(form);fd.set('csrf',csrf);fd.set('id',root.dataset.seasonId);
    fd.set('community_config',JSON.stringify(config));
    const servers=[...form.querySelectorAll('.server-item')].map((s,i)=>({order:i,id:s.querySelector('select[name*="[id]"]')?.value,
      commands:[...s.querySelectorAll('input[name$="[cmd]"]')].map((c,j)=>({order:j,cmd:c.value,desc:s.querySelectorAll('input[name$="[desc]"]')[j]?.value||''}))}));
    fd.set('servers_json',JSON.stringify(servers));fd.set('reward',form.querySelector('[name=has_reward],#rewardToggle,#rewardToggle2,#rewardToggleEdit')?.value||'0');
    return {valid:form.checkValidity(),config,entries:[...fd].map(([key,value])=>{
      if(typeof value==='string')return [key,value];
      if(value.size!==0)throw Error('Season file uploads require a separate workflow');
      return [key,{emptyFile:true}];
    })};
  },csrf);
}

export async function runSeasonAction(panel,{recipe,workflowId,recordId,recordContext,fields,files,envFields,mode}){
  const action=recipe.seasonAction;
  if(!['preview','apply'].includes(mode)||files.length||envFields.length||Object.keys(recordContext).length||!Number.isSafeInteger(recordId)||recordId<=0)
    throw Error('Select a season record and use preview or apply mode');
  if(Object.keys(fields).some(name=>!(action==='get'?[]:[...editable,'expectedState']).includes(name)))throw Error('Unsupported season pass field');
  const page=await panel.navigate(pageId),origin=panel.origin();
  const initial=await catalog(page,origin),selected=initial.seasons.find(s=>Number(s.id)===recordId);
  if(!selected)throw Error('Season record was not found');
  const before=record(selected);
  if(action==='get')return {workflowId,record:before,read:true,verified:true,submitted:false};
  if(!before.enabled||before.connection!=='local')throw Error('This edit workflow requires an enabled pass with a local data source');
  if(mode==='apply'&&fields.expectedState!==before.expectedState)throw Error('Season changed or expectedState is missing. Preview the current record.');
  const desired=Object.fromEntries(editable.map(key=>[key,fields[key]??before[key]]));
  if(Array.isArray(fields.goals))desired.goals=fields.goals.map(value=>typeof value==='string'&&/^[1-9][0-9]*$/.test(value)?Number(value):NaN);
  if(typeof desired.summary!=='string'||desired.summary.length>220||desired.summary!==desired.summary.trim()||
    ['passTitle','rewardsTitle'].some(k=>typeof desired[k]!=='string'||!desired[k]||desired[k].length>100||desired[k]!==desired[k].trim())||
    !Array.isArray(desired.goals)||desired.goals.length!==before.goals.length||desired.goals.some((n,i)=>!Number.isSafeInteger(n)||n<1||n>1000000000||(i>0&&n<=desired.goals[i-1])))
    throw Error('Provide valid pass text and strictly increasing goals for the existing tiers');
  if(mode==='preview')return {workflowId,ready:true,submitted:false,record:before,proposed:desired};
  await nativeRequest(panel,page,origin,'season-schema',{id:String(recordId),table:selected.table_name,csrf:initial.csrf},
    ()=>panel.mountDrawer(drawerId,recordId,true));
  const form=page.locator('#seasonsEditForm');
  await page.waitForFunction(()=>{const f=document.querySelector('#seasonsEditForm');return f?.querySelector('[name="username_column"]')?.tagName==='SELECT'&&!f.querySelector('[name="username_column"]').disabled;},{},{timeout:15000});
  const prior=await snapshot(form,initial.csrf);
  if(!prior.valid||prior.config.pass.tiers.length!==before.goals.length||prior.config.pass.title!==before.passTitle||
    JSON.stringify(prior.config.pass.tiers.map(t=>t.goal))!==JSON.stringify(before.goals))throw Error('Native season editor differs from the selected catalog record');
  await form.evaluate((f,desired)=>{
    const set=(selector,value)=>{const element=f.querySelector(selector);element.value=String(value);element.dispatchEvent(new Event('input',{bubbles:true}));};
    set('[data-season-summary]',desired.summary);set('[data-season-pass-title]',desired.passTitle);set('[data-season-rewards-title]',desired.rewardsTitle);
    f.querySelectorAll('[data-tier-goal]').forEach((element,i)=>{element.value=String(desired.goals[i]);element.dispatchEvent(new Event('input',{bubbles:true}));});
  },desired);
  const planned=await snapshot(form,initial.csrf);
  if(!planned.valid)throw Error('Native season form is invalid');
  const stableEntries=entries=>entries.filter(([key])=>key!=='community_config');
  if(JSON.stringify(stableEntries(prior.entries))!==JSON.stringify(stableEntries(planned.entries)))throw Error('Unrelated season fields changed');
  const result=await nativeRequest(panel,page,origin,'season-save',planned.entries,()=>form.evaluate(f=>f.requestSubmit()));
  const final=await catalog(page,origin),saved=final.seasons.find(s=>Number(s.id)===recordId);
  if(!saved)throw Error('Saved season could not be found');
  const after=record(saved),verified=Number(result.id)===recordId&&editable.every(k=>JSON.stringify(after[k])===JSON.stringify(desired[k]));
  panel.store.audit('panel.execute',workflowId,{recordId,verified});
  return {workflowId,record:after,recordId,submitted:true,acknowledged:true,verified};
}
