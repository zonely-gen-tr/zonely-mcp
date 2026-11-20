const pageId='panel:site:page:main.enjector';
const models=['veronica:1','betty:1'];

export const aiRecipes=Object.fromEntries(['get','model','history'].map(action=>['ai.'+action,{
  title:'Zonely AI / '+action,pageId,aiAction:action,documentation:['/guides/zonely-ai'],
  fields:action==='get'?[]:[{name:'expectedState',type:'text',required:true},
    action==='model'?{name:'model',type:'select',required:true,options:models}:{name:'collapsed',type:'boolean',required:true}],
  verification:'Native model/history controls and browser-local preference readback. No AI prompt or server mutation.'
}]));

async function state(page){
  await page.waitForFunction(()=>document.querySelector('#aiHistoryToggle')?.dataset.aiHistoryBound==='1'&&
    document.querySelector('#aiModelSwitch .is-active')?.getAttribute('aria-pressed')==='true');
  return page.evaluate(()=>{
    const model=document.querySelector('#aiModelSelect').value;
    const selected=[...document.querySelectorAll('#aiModelSwitch [aria-pressed="true"]')];
    const collapsed=document.querySelector('.ai-layout').classList.contains('is-history-collapsed');
    if(!['veronica:1','betty:1'].includes(model)||selected.length!==1||selected[0].dataset.model!==model||
      document.querySelector('#aiHistoryToggle').getAttribute('aria-expanded')!==String(!collapsed))throw Error('AI controls disagree');
    const savedModel=localStorage.getItem('zonely_ai_model_pref_v1');
    const savedHistory=localStorage.getItem('zonely_ai_history_collapsed_v1');
    return {model,collapsed,savedModel,savedHistory,expectedState:JSON.stringify([model,collapsed,savedModel,savedHistory])};
  });
}

export async function runAiAction(panel,{recipe,workflowId,recordId,recordContext,fields,files,envFields,mode}){
  const action=recipe.aiAction;
  const allowed=action==='get'?[]:action==='model'?['model','expectedState']:['collapsed','expectedState'];
  if(!['preview','apply'].includes(mode)||recordId!==undefined||files.length||envFields.length||Object.keys(recordContext).length||
    Object.keys(fields).some(key=>!allowed.includes(key)))throw Error('Unsupported AI preferences input');
  let page=await panel.session();
  if(page.url()!==panel.origin()+panel.route(pageId))page=await panel.navigate(pageId);
  const before=await state(page);
  if(action==='get'||mode==='preview')return {workflowId,preferences:before,verified:true,submitted:false};
  if(fields.expectedState!==before.expectedState)throw Error('AI preferences changed. Preview again.');
  if(action==='model'&&!models.includes(fields.model))throw Error('Select Veronica or Betty');
  if(action==='history'&&typeof fields.collapsed!=='boolean')throw Error('Provide collapsed as a boolean');
  if(action==='model'&&before.model!==fields.model){
    await page.locator(`#aiModelSwitch [data-model="${fields.model}"]`).click();
  }else if(action==='history'&&before.collapsed!==fields.collapsed){
    await page.locator('#aiHistoryToggle').click();
  }else return {workflowId,preferences:before,verified:true,submitted:false,changed:false};
  const after=await state(page);
  if(action==='model'&&(after.model!==fields.model||after.savedModel!==fields.model||after.collapsed!==before.collapsed||after.savedHistory!==before.savedHistory))throw Error('AI model preference readback failed');
  if(action==='history'&&(after.collapsed!==fields.collapsed||after.savedHistory!==(fields.collapsed?'1':'0')||after.model!==before.model||after.savedModel!==before.savedModel))throw Error('AI history preference readback failed');
  return {workflowId,preferences:after,verified:true,submitted:false,changed:true};
}
