import {createHash} from 'node:crypto';
import {matchesPost} from './panel-request.mjs';

const pageId='panel:site:page:main.polls';
const endpoint='/Files/Src/MVC/Http/Endpoints/community.php';
const editable=['question','options','start','end','active','multiple','show_results'];
const flags=['active','multiple','show_results'];
const dateInput=value=>String(value??'').replace(' ','T').slice(0,16);
const equal=(a,b)=>JSON.stringify(a)===JSON.stringify(b);
const values=p=>({question:p.question,options:p.options,start:dateInput(p.start),end:dateInput(p.end),
  active:p.active,multiple:p.multiple,show_results:p.show_results});
const publicRecord=p=>({id:p.id,...values(p),updatedAt:p.updated_at,votes:p.votes,counts:p.counts,open:p.open,
  expectedState:createHash('sha256').update(JSON.stringify([p.id,p.updated_at,values(p),p.votes,p.counts])).digest('hex')});

export const pollRecipes=Object.fromEntries(['create','edit','copy','delete','results'].map(action=>['poll.'+action,{
  title:'Polls / '+action,pageId,pollAction:action,requiresRecord:action!=='create',documentation:['/guides/surveys'],
  fields:[...(action==='create'||action==='edit'||action==='copy'?[{name:'question',type:'text'},
    {name:'options',type:'string[]'},{name:'start',type:'datetime-local'},{name:'end',type:'datetime-local'},
    ...flags.map(name=>({name,type:'boolean'}))]:[]),
    ...(['edit','copy','delete'].includes(action)?[{name:'expectedState',type:'text',required:true}]:[])],
  verification:'Native poll administration response and independent poll-admin readback'
}]));

async function readPolls(page,origin){
  return page.evaluate(async ({origin,endpoint})=>{
    const url=new URL(endpoint,origin);url.searchParams.set('action','poll-admin');
    const response=await fetch(url,{credentials:'same-origin',redirect:'error',signal:AbortSignal.timeout(12000)});
    const text=await response.text();
    if(!response.ok||text.length>2*1024*1024)throw Error('Poll administration read failed');
    const result=JSON.parse(text);
    if(result.status!=='success'||!Array.isArray(result.polls)||typeof result.csrf!=='string'||!result.csrf)
      throw Error('Poll administration did not return the expected data');
    return {polls:result.polls,csrf:result.csrf};
  },{origin,endpoint});
}

function normalize(input){
  const result={...input};
  if(typeof result.question!=='string'||!result.question.trim()||[...result.question.trim()].length>250)
    throw Error('Provide a question of 1 to 250 characters');
  result.question=result.question.trim();
  if(!Array.isArray(result.options)||result.options.length<2||result.options.length>20||
    result.options.some(v=>typeof v!=='string'||!v.trim()||[...v.trim()].length>150))
    throw Error('Provide 2 to 20 options of 1 to 150 characters');
  result.options=result.options.map(v=>v.trim());
  if(new Set(result.options.map(v=>v.toLowerCase())).size!==result.options.length)throw Error('Poll options must be distinct');
  for(const name of flags)if(typeof result[name]!=='boolean')throw Error(name+' must be boolean');
  for(const name of ['start','end'])if(typeof result[name]!=='string'||(result[name]&&!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(result[name])))
    throw Error(name+' must be empty or YYYY-MM-DDTHH:mm');
  if(result.start&&result.end&&result.start>=result.end)throw Error('End must follow start');
  return result;
}

async function openRecord(root,record,action){
  const button=root.locator(`[data-poll-${action}="${record.id}"]`);
  await root.locator('[data-poll-search]').fill(record.question);
  await button.waitFor({state:'attached',timeout:10000});
  await button.dispatchEvent('click');
}

async function fillOptions(form,options,voted){
  const inputs=form.locator('[data-poll-option]');
  if(voted){
    const current=await inputs.evaluateAll(nodes=>nodes.map(node=>node.value));
    if(!equal([...current].sort(),[...options].sort()))throw Error('A voted poll permits reordering only');
    for(let target=0;target<options.length;target++){
      let index=current.indexOf(options[target]);
      while(index>target){
        await form.locator('[data-poll-drag]').nth(index).press('ArrowUp');
        [current[index-1],current[index]]=[current[index],current[index-1]];index--;
      }
    }
  }else{
    while(await inputs.count()<options.length)await form.locator('[data-poll-option-add]').click();
    while(await inputs.count()>options.length)await form.locator('[data-poll-option-remove]').last().click();
    for(let index=0;index<options.length;index++)await inputs.nth(index).fill(options[index]);
  }
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
    if(!response)throw Error('Poll write outcome is unknown. Read the record before retrying.');
    const result=await response.json().catch(()=>null);
    if(!response.ok()||result?.status!=='success')throw Error('The panel rejected the poll operation');
    return result;
  }finally{
    panel.allowWrites=false;panel.expectedPost=null;panel.expectedPostBody=null;panel.expectedPostFields=null;panel.oneShotPost=false;
  }
}

export async function runPollAction(panel,{recipe,workflowId,recordId,recordContext,fields,files,envFields,mode}){
  const action=recipe.pollAction;
  if(!['preview','apply'].includes(mode)||files.length||envFields.length||Object.keys(recordContext).length)
    throw Error('Use poll fields and preview or apply mode');
  if(action==='create'?recordId!==undefined:!Number.isSafeInteger(recordId)||recordId<=0)throw Error('Select a valid poll record for this action');
  const allowed=action==='results'?[]:action==='delete'?['expectedState']:action==='create'?editable:[...editable,'expectedState'];
  if(Object.keys(fields).some(name=>!allowed.includes(name)))throw Error('Unsupported poll field');
  const page=await panel.navigate(pageId);
  const root=page.locator('[data-polls-admin]');
  await root.locator('[data-poll-table]').waitFor({state:'visible',timeout:10000});
  await page.locator('[data-polls-admin][data-ready="1"]').waitFor({state:'attached',timeout:10000});
  const origin=panel.origin();
  const initial=await readPolls(page,origin);
  const selected=initial.polls.find(p=>p.id===recordId);
  if(action!=='create'&&!selected)throw Error('Poll record was not found');
  const before=selected?publicRecord(selected):undefined;
  if(action==='results')return {workflowId,read:true,verified:true,submitted:false,record:before};
  if(mode==='apply'&&selected&&fields.expectedState!==before.expectedState)throw Error('Poll changed or expectedState is missing. Preview the current record.');
  if(action==='delete'){
    if(mode==='preview')return {workflowId,ready:true,submitted:false,record:before};
    const result=await write(panel,page,origin,'poll-delete',{ids:[recordId],csrf:initial.csrf},async()=>{
      await openRecord(root,selected,'delete');
      await page.locator('.swal2-confirm').click();
    });
    const after=await readPolls(page,origin);
    const verified=!after.polls.some(p=>p.id===recordId);
    panel.store.audit('panel.execute',workflowId,{recordId,verified});
    return {submitted:true,acknowledged:result.status==='success',verified,recordId};
  }
  const defaults=selected?values(selected):{question:'',options:['',''],start:'',end:'',active:true,multiple:false,show_results:true};
  if(action==='copy')defaults.question+=' (kopya)';
  const proposed={...defaults,...Object.fromEntries(Object.entries(fields).filter(([name])=>editable.includes(name)))};
  if(mode==='preview'&&!Object.keys(fields).some(name=>editable.includes(name))&&action==='create')
    return {workflowId,ready:true,submitted:false,fields:editable,defaults};
  const desired=normalize(proposed);
  if(action==='edit'&&selected.votes&&desired.multiple!==selected.multiple)throw Error('A voted poll cannot change its multiple-choice mode');
  if(action==='edit'&&selected.votes&&!equal([...selected.options].sort(),[...desired.options].sort()))throw Error('A voted poll permits reordering only');
  if(mode==='preview')return {workflowId,ready:true,submitted:false,record:before,proposed:desired};
  if(action==='create')await root.locator('[data-poll-add]').click();
  else await openRecord(root,selected,action);
  const form=page.locator('[data-poll-form]');
  const id=action==='edit'?String(recordId):'0';
  if(await form.locator('[name=id]').inputValue()!==id)throw Error('The native drawer returned a different poll');
  for(const name of ['question','start','end'])await form.locator(`[name=${name}]`).fill(desired[name]);
  for(const name of flags){const control=form.locator(`[name=${name}]`);if(await control.isChecked()!==desired[name])await control.setChecked(desired[name]);}
  await fillOptions(form,desired.options,action==='edit'&&selected.votes>0);
  const actual=await form.evaluate(node=>({id:node.elements.id.value,question:node.elements.question.value,
    start:node.elements.start.value,end:node.elements.end.value,options:[...node.querySelectorAll('[data-poll-option]')].map(e=>e.value),
    active:node.elements.active.checked,multiple:node.elements.multiple.checked,show_results:node.elements.show_results.checked}));
  if(actual.id!==id||!editable.every(name=>equal(actual[name],desired[name])))throw Error('The native poll form did not accept the requested values');
  const fresh=await readPolls(page,origin);
  if(selected&&(!fresh.polls.some(p=>p.id===recordId&&publicRecord(p).expectedState===before.expectedState)))
    throw Error('Poll changed while preparing the drawer. Preview the current record.');
  const result=await write(panel,page,origin,'poll-save',{...actual,csrf:fresh.csrf},()=>form.locator('[type=submit]').click());
  const savedId=result.poll?.id;
  const after=await readPolls(page,origin);
  const saved=after.polls.find(p=>p.id===savedId);
  const verified=Number.isSafeInteger(savedId)&&savedId>0&&Boolean(saved)&&
    (action==='edit'?savedId===recordId:!initial.polls.some(p=>p.id===savedId))&&editable.every(name=>equal(values(saved)[name],desired[name]));
  panel.store.audit('panel.execute',workflowId,{recordId:savedId,verified});
  return {submitted:true,acknowledged:true,verified,record:saved?publicRecord(saved):undefined};
}
