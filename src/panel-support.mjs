import {setFormValues} from './panel-fields.mjs';
import {matchesPost} from './panel-request.mjs';

const endpoint='/Files/Controllers/ControllersAll.php';

async function readTicket(page,origin,id,lastMessageId=0,message=''){
  return page.evaluate(async ({origin,id,lastMessageId,message,endpoint})=>{
    const read=async (container,parameters)=>{
      const url=new URL(endpoint,origin);
      url.search=new URLSearchParams({main:'Supports',container,...parameters});
      const response=await fetch(url,{credentials:'same-origin',redirect:'error',
        headers:{'X-Requested-With':'XMLHttpRequest'},signal:AbortSignal.timeout(12000)});
      const body=await response.text();
      if(!response.ok||body.length>2*1024*1024)throw Error('Support readback failed');
      return JSON.parse(body);
    };
    const parse=html=>new DOMParser().parseFromString(String(html??''),'text/html').body;
    const text=html=>parse(html).textContent.replace(/\s+/gu,' ').trim();
    const thread=await read('SupportsNemessagesFetch',{id,lastMessageId});
    if(thread.status!=='success'||Number(parse(thread.firstMessageHtml).querySelector('[data-message-id]')?.dataset.messageId)!==id)
      throw Error('The support thread did not return the selected ticket');
    const title=text(thread.supporttitle);
    const list=await read('SupportsListController',{start:0,length:100,search:title});
    const ticket=list.data?.find(row=>Number(row.id)===id);
    if(!ticket||![1,2,3,4].includes(Number(ticket.statusID)))throw Error('The support list could not verify the selected ticket');
    const messages=[...parse(thread.messagesHtml).querySelectorAll('[data-message-id]')].map(row=>({
      id:Number(row.dataset.messageId),text:row.querySelector('[data-zonely-element="message-text"]')?.textContent.replace(/\s+/gu,' ').trim()
    })).filter(row=>Number.isSafeInteger(row.id)&&row.id>lastMessageId);
    return {record:{id,title,statusId:Number(ticket.statusID)},
      lastMessageId:messages.reduce((max,row)=>Math.max(max,row.id),lastMessageId),
      matches:message?messages.filter(row=>row.text===text(message)).map(row=>row.id):[]};
  },{origin,id,lastMessageId,message,endpoint});
}

export async function runSupportAction(panel,{page,form,recipe,workflowId,operation,recordId,fields,files,envFields,mode}){
  const reply=recipe.supportAction==='reply';
  if(files.length||envFields.length||Object.keys(fields).some(name=>!reply||name!=='message'))
    throw Error('Choose the support ticket by recordId and supply only a reply message');
  const identity=form.locator('input[name="id"]');
  if(await identity.count()!==1||(await identity.inputValue()).trim()!==String(recordId))
    throw Error('The support drawer did not return the selected ticket');
  const origin=panel.origin();
  const before=await readTicket(page,origin,recordId);
  if(before.record.statusId===4){
    if(reply)throw Error('The selected support ticket is closed');
    return {ready:true,alreadyClosed:true,submitted:false,verified:true,record:before.record};
  }
  if(reply&&fields.message!==undefined){
    if(typeof fields.message!=='string'||!fields.message.trim()||Buffer.byteLength(fields.message)>12000)
      throw Error('Provide a support reply of 1 to 12000 bytes');
    await setFormValues(form,{message:fields.message});
  }
  if(mode==='preview')return {ready:true,mode,workflowId,operation:operation.id,nativeProbeRequired:false,
    fields:Object.keys(fields),submitted:false,record:before.record};
  if(reply&&fields.message===undefined)throw Error('Supply the support reply message');
  await identity.evaluate((input,id)=>{input.value=id;},String(recordId));
  const bodyMatch={id:String(recordId)};
  let composed;
  if(reply){
    composed=await form.evaluate(node=>String(new FormData(node).get('message')??''));
    const accepted=await page.evaluate(({composed,requested})=>{
      const text=value=>new DOMParser().parseFromString(value,'text/html').body.textContent.replace(/\s+/gu,' ').trim();
      const actual=text(composed);
      return Boolean(actual)&&actual===text(requested);
    },{composed,requested:fields.message});
    if(!accepted)
      throw Error('The support reply editor did not accept the message');
    bodyMatch.message=composed;
  }
  const closeButton=reply?null:form.locator('span[id="closeButton_'+recordId+'"] button').first();
  if(closeButton)await closeButton.waitFor({state:'attached',timeout:7500});
  const expected=new URL(operation.path,origin);
  expected.search=new URLSearchParams(operation.routing);
  panel.expectedPost=expected;
  panel.expectedPostBody=bodyMatch;
  panel.allowWrites=true;
  const pending=page.waitForResponse(r=>matchesPost(r.request(),expected,bodyMatch),{timeout:20000}).catch(()=>null);
  try{
    if(reply)await form.evaluate(node=>node.requestSubmit());
    else await closeButton.dispatchEvent('click');
    const response=await pending;
    if(!response)throw Error('Support write outcome is unknown. Read the ticket before retrying.');
    const result=await response.json().catch(()=>null);
    if(!response.ok()||result?.status!=='success')throw Error('The panel rejected the support operation');
  }finally{
    panel.allowWrites=false;
    panel.expectedPost=null;
    panel.expectedPostBody=null;
  }
  const after=await readTicket(page,origin,recordId,before.lastMessageId,composed).catch(()=>null);
  const verified=reply?after?.matches.length===1:after?.record.statusId===4;
  panel.store.audit('panel.execute',operation.id,{recordId,verified});
  return {submitted:true,acknowledged:true,verified,operation:operation.id,environment:panel.profile.environment,
    record:after?.record??before.record,
    ...(reply&&verified?{messageId:after.matches[0]}:{}),
    ...(verified?{}:{hint:'The panel acknowledged the operation. Read the ticket before retrying.'})};
}
