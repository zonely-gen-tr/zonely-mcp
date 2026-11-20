import {matchesPost} from './panel-request.mjs';

export function isCustomerLogin(url,origin){
  const location=new URL(url);
  return location.origin===origin&&/^\/login(?:\/[A-Za-z0-9_-]+\/[A-Za-z0-9_-]+)?\/?$/.test(location.pathname);
}

export async function routeAuthentication(panel,request,authorization){
  if(!authorization||authorization.outcome==='acknowledged'||Date.now()>authorization.expires||
    !isCustomerLogin(panel.page.url(),panel.origin())||authorization.pending)return false;
  if(request.frame()!==panel.page.mainFrame()||!await matchesPost(request,authorization.expected,{}))return false;
  if(panel.manualAuthentication!==authorization||authorization.pending)return false;
  authorization.pending=request;
  return true;
}

export async function watchAuthenticationResponse(panel,response){
  const authorization=panel.manualAuthentication;
  if(!authorization||response.request()!==authorization.pending)return;
  const result=await response.json().catch(()=>null);
  authorization.outcome=response.ok()&&result?.status==='success'?'acknowledged':'rejected';
  authorization.pending=null;
}

export async function runAuthentication(panel,{recipe,operation,mode}){
  const page=panel.interactive ? panel.page : await panel.session();
  const previous=panel.manualAuthentication;
  if(previous?.workflowId===recipe.id&&previous.outcome==='acknowledged'){
    return {workflowId:recipe.id,submitted:true,acknowledged:true,verified:false,
      status:'accepted-by-site',hint:'Confirm the signed-in account or recovery message in the customer browser'};
  }
  if(!isCustomerLogin(page.url(),panel.origin())){
    if(new URL(page.url()).origin===panel.origin()&&new URL(page.url()).pathname.startsWith('/profile'))
      return {workflowId:recipe.id,ready:false,submitted:false,status:'customer-profile-open'};
    return {workflowId:recipe.id,ready:false,submitted:false,status:'login-challenge-required',
      hint:'Open the customer browser and start the site login or open your recovery link there'};
  }
  const form=page.locator(recipe.form);
  if(!await form.isVisible())return {workflowId:recipe.id,ready:false,submitted:false,status:'selected-challenge-not-open'};
  if(mode==='preview')return {workflowId:recipe.id,ready:true,submitted:false,status:'awaiting-customer',
    ...(previous?.outcome==='rejected'?{lastAttempt:'rejected-by-site'}:{})};

  const expected=new URL(operation.path,panel.origin());
  for(const [name,value]of Object.entries(operation.routing))expected.searchParams.set(name,String(value));
  panel.manualAuthentication={workflowId:recipe.id,expected,expires:Date.now()+120000};
  await page.bringToFront();
  return {workflowId:recipe.id,ready:true,submitted:false,status:'awaiting-browser-confirmation',
    hint:'Enter your code or recovery email in the customer browser, then run this workflow again to check the result'};
}
