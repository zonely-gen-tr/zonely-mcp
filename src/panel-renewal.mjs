import {matchesPost} from './panel-request.mjs';

export async function nativePost(panel,page,expected,body,submit,{quote=false,download=false}={}){
  const allowed=[...Object.keys(body),'csrf-token','csrf_token',download?'updateDownloads':'updateDuets'];
  const subject=download?'Download':quote?'Renewal quote':'Renewal payment';
  let sent;
  const guard=async route=>{
    const request=route.request();
    if(['GET','HEAD'].includes(request.method()))return route.fallback();
    if(!await matchesPost(request,expected,body,allowed)||sent)return route.abort();
    sent=request;
    return route.fallback();
  };
  let onResponse,timer;
  const pending=new Promise(resolve=>{
    onResponse=response=>{if(response.request()===sent)resolve(response);};
    timer=setTimeout(()=>resolve(null),18000);
  });
  await page.route('**/*',guard);
  page.on('response',onResponse);
  panel.expectedPost=expected;
  panel.expectedPostBody=body;
  panel.allowWrites=true;
  try{
    await submit();
    const response=await pending;
    if(!response)throw Error(quote?'The renewal quote did not return':
      subject+' outcome is unknown. Check the customer account before retrying');
    if(!response.ok()||Number(response.headers()['content-length']??0)>1024*1024)
      throw Error(subject+' endpoint rejected the request');
    const value=await response.json().catch(()=>null);
    if(value?.status!=='success')throw Error(subject+' was not acknowledged by the site');
    return value;
  }finally{
    panel.allowWrites=false;
    panel.expectedPost=null;
    panel.expectedPostBody=null;
    clearTimeout(timer);
    page.off('response',onResponse);
    await page.unroute('**/*',guard);
  }
}

function priceOf(value){
  const raw=value?.pricing?.total_price;
  const amount=typeof raw==='number'||typeof raw==='string'&&raw.trim()?Number(raw):NaN;
  const currency=String(value?.pricing?.cash_name??'').trim();
  if(!Number.isFinite(amount)||amount<0||amount>1e9||!currency||currency.length>20)
    throw Error('The site did not provide a valid renewal amount and currency');
  return {total:amount,currency};
}

export async function runRenewal(panel,{page,recipe,operation,recordId,drawerQuery,mode,expectedPrice}){
  if(mode==='apply'&&!expectedPrice)throw Error('Preview the renewal, then supply the approved expectedPrice');
  const expected=new URL(operation.path,panel.origin());
  for(const [key,value]of Object.entries(operation.routing))expected.searchParams.set(key,String(value));
  const identity={id:String(recordId)};
  if(Object.hasOwn(drawerQuery,'order'))identity.order=String(drawerQuery.order);
  const quote=await nativePost(panel,page,expected,{...identity,quote:'1'},
    ()=>panel.mountDrawer(recipe.drawerId,recordId,true,drawerQuery,recipe.form),{quote:true});
  const price=priceOf(quote);
  const balance=Number(quote.balance);
  const sufficient=quote.balance!==undefined&&quote.balance!==null&&Number.isFinite(balance)&&balance>=price.total;
  const summary={...price,canApply:sufficient&&!quote.active,...(quote.active?{alreadyActive:true}:{})};
  if(mode==='preview')return {ready:true,mode,workflowId:recipe.id,submitted:false,quote:summary};
  if(expectedPrice.total!==price.total||expectedPrice.currency!==price.currency)
    throw Error('The renewal price changed. Review the current quote before paying');
  if(!summary.canApply)throw Error('The account cannot pay this renewal with its current balance or license status');
  const submitter=page.locator(recipe.form+'[data-zonely-mcp-customer-form]').locator(recipe.submitter);
  await submitter.waitFor({state:'attached'});
  const paid=await nativePost(panel,page,expected,identity,()=>submitter.evaluate(button=>{
    if(button.disabled||button.classList.contains('d-none')||!button.form)
      throw Error('The storefront did not enable payment for this quote');
    button.form.requestSubmit(button);
  }));
  const charged=priceOf(paid);
  if(charged.total!==price.total||charged.currency!==price.currency)
    throw Error('The site acknowledged payment at a different price. Check the invoice before retrying');
  return {workflowId:recipe.id,operation:operation.id,submitted:true,acknowledged:true,verified:false,
    quote:summary,hint:'Check the customer invoice or license expiry to verify the saved renewal'};
}
