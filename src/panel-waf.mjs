import {createHash} from 'node:crypto';
import {matchesPost} from './panel-request.mjs';

const pageId='panel:site:page:main.waf';
const loadingFields={title:{selector:'#wafLoadingTitle',max:120},message:{selector:'#wafLoadingMessage',max:400},subtitle:{selector:'#wafLoadingSubtitle',max:180}};
const protectionFields={l7_ddos:{selector:'#wafProtL7'},bot_filter:{selector:'#wafProtBot'},rate_limit:{selector:'#wafProtRate'},js_challenge:{selector:'#wafProtJs'}};
const sections={loading:['enabled','title','message','subtitle','logo_url','bg_color','text_color','accent_color','show_spinner','html_enabled','html'],protections:['l7_ddos','bot_filter','rate_limit','js_challenge'],routing:['proxy_port'],notifications:['discord_webhook','discord_interval']};
const gameFields=['subdomain','origin','protocol','conn_limit','ip_masking','motd_line1','motd_line2','motd_icon','offline_message'];
const gameDerived=['origin_host','origin_port'];

export const wafRecipes={
  'waf.settings.get':{title:'WAF / current settings',pageId,wafAction:'get',documentation:['/guides/firewall-waf'],fields:[],verification:'Native domain settings and independent readback, with sensitive settings omitted'},
  'waf.loading.update':{title:'WAF / loading screen text',pageId,wafAction:'loading',documentation:['/guides/firewall-waf'],fields:[...Object.keys(loadingFields).map(name=>({name,type:'text',required:false})),{name:'expectedState',type:'text',required:true}],verification:'Native full settings save with exact payload, preserved unrelated settings and independent readback'},
  'waf.protections.update':{title:'WAF / web protections',pageId,wafAction:'protections',documentation:['/guides/firewall-waf'],fields:[...Object.keys(protectionFields).map(name=>({name,type:'boolean',required:false})),{name:'expectedState',type:'text',required:true}],verification:'Native protection switches and full settings save with preserved unrelated settings and independent readback'}
};

function canonical(value){
  if(Array.isArray(value))return value.map(canonical);
  if(value&&typeof value==='object')return Object.fromEntries(Object.keys(value).sort().map(key=>[key,canonical(value[key])]));
  return value;
}
const digest=settings=>createHash('sha256').update(JSON.stringify(canonical(settings))).digest('hex');
const same=(a,b)=>digest(a)===digest(b);

function endpoints(origin){
  const host=new URL(origin),domain=host.hostname.replace(/^www\./i,'').toLowerCase();
  if(!/^[a-z0-9.-]{1,253}$/.test(domain))throw Error('WAF requires the configured site hostname');
  const site=host.host.toLowerCase().replace(/[^a-z0-9._-]+/g,'-').replace(/^[-.]+|[-.]+$/g,'').slice(0,120)||'default';
  const controller=name=>new URL('/Files/Controllers/ControllersAll.php?main=Waf&container=WafDomainSettings'+name+'Controller&site='+encodeURIComponent(site),origin);
  const get=controller('Get');get.searchParams.set('domain',domain);
  return {domain,get,save:controller('Save')};
}

function requireSettings(payload,domain){
  if(payload?.status!=='success'||payload.domain!==domain||!payload.settings||typeof payload.settings!=='object'||Array.isArray(payload.settings))throw Error('WAF settings could not be read for the configured site');
  return payload.settings;
}

async function readSettings(page,{get,domain}){
  const payload=await page.evaluate(async url=>{
    const response=await fetch(url,{credentials:'same-origin',cache:'no-store',redirect:'error',signal:AbortSignal.timeout(15000)});
    if(!response.ok)throw Error('WAF settings request failed');
    return response.json();
  },get.href);
  return requireSettings(payload,domain);
}

function publicState(domain,settings){
  const loading=settings.loading,protections=settings.protections;
  if(!loading||!protections||Object.keys(loadingFields).some(key=>typeof loading[key]!=='string'))throw Error('Unexpected WAF settings structure');
  return {domain,loading:{title:loading.title,message:loading.message,subtitle:loading.subtitle,enabled:loading.enabled,showSpinner:loading.show_spinner,customHtml:loading.html_enabled},protections:Object.fromEntries(sections.protections.map(key=>[key,protections[key]===true])),expectedState:digest(settings)};
}

function pickExact(value,keys,derived=[]){
  if(!value||typeof value!=='object'||Array.isArray(value)||!same(Object.keys(value).sort(),[...keys,...derived].sort()))throw Error('WAF contains settings outside the verified native save format');
  return Object.fromEntries(keys.map(key=>[key,value[key]]));
}

 
async function nativePayload(page,settings){
  pickExact(settings,[...Object.keys(sections),'game']);
  const payload=Object.fromEntries(Object.entries(sections).map(([key,keys])=>[key,pickExact(settings[key],keys)]));
   
   
  if(!await page.locator('#wafProxyPort').count()&&payload.routing.proxy_port!=='')throw Error('Native WAF form cannot preserve the configured proxy port');
  if(!await page.locator('#wafDiscordInterval').count()){
    if(payload.notifications.discord_interval!=='120')throw Error('Native WAF form cannot preserve the configured notification interval');
    payload.notifications.discord_interval='';
  }
  const game=settings.game;
  pickExact(game,['enabled','entries',...gameFields],gameDerived);
  if(!Array.isArray(game.entries)||game.entries.length===0)throw Error('WAF game settings are outside the verified native save format');
  const entries=game.entries.map(entry=>{
    const value=pickExact(entry,gameFields,gameDerived);
    if(/^data:image\//i.test(value.motd_icon))throw Error('WAF image compaction requires a separate verified operation');
    if(entry.origin!==[entry.origin_host,entry.origin_port].filter(Boolean).join(':'))throw Error('WAF game origin cannot be preserved by the native form');
    return value;
  });
  const first=game.entries[0];
  if([...gameFields,...gameDerived].some(key=>game[key]!==first[key]))throw Error('WAF primary game settings cannot be preserved by the native form');
  if(/^data:image\//i.test(payload.loading.logo_url))throw Error('WAF image compaction requires a separate verified operation');
  payload.game={enabled:game.enabled,entries,...entries[0]};
  return payload;
}

async function nativeRead(panel,urls){
  const page=await panel.session();
  const pending=page.waitForResponse(r=>r.request().method()==='GET'&&r.url()===urls.get.href,{timeout:20000}).catch(()=>null);
  await panel.navigate(pageId);
  const response=await pending;
  if(!response?.ok())throw Error('Native WAF did not load the configured site settings');
  const native=requireSettings(await response.json(),urls.domain);
  const fresh=await readSettings(page,urls);
  if(!same(native,fresh))throw Error('WAF settings changed during load. Preview again.');
  for(const [key,{selector}] of Object.entries(loadingFields))await page.waitForFunction(({selector,value})=>document.querySelector(selector)?.value===value,{selector,value:fresh.loading[key]});
  for(const [key,{selector}] of Object.entries(protectionFields))await page.waitForFunction(({selector,value})=>document.querySelector(selector)?.checked===value,{selector,value:fresh.protections[key]});
  return {page,settings:fresh};
}

export async function runWafAction(panel,{recipe,workflowId,recordId,recordContext,fields,files,envFields,mode}){
  const action=recipe.wafAction,updateFields=action==='protections'?protectionFields:loadingFields;
  const allowed=action==='get'?[]:['expectedState',...Object.keys(updateFields)];
  if(!['preview','apply'].includes(mode)||recordId!==undefined||files.length||envFields.length||Object.keys(recordContext).length||Object.keys(fields).some(key=>!allowed.includes(key)))throw Error('Unsupported WAF input');
  const urls=endpoints(panel.origin());
  const {page,settings:before}=await nativeRead(panel,urls);
  const state=publicState(urls.domain,before);
  if(action==='get'||mode==='preview')return {workflowId,...state,read:true,verified:true,submitted:false};
  if(fields.expectedState!==state.expectedState)throw Error('WAF settings changed or expectedState missing. Preview again.');
  if(urls.domain==='sandbox.zonely.gen.tr')throw Error('WAF settings are read-only on this site');
  const updates=Object.entries(updateFields).filter(([key])=>Object.hasOwn(fields,key));
  if(!updates.length)throw Error('Specify at least one WAF setting');
  const desired=structuredClone(before);
  for(const [key,{selector,max}] of updates){
    const value=fields[key];
    if(action==='protections'){
      if(typeof value!=='boolean')throw Error('Invalid WAF protection value: '+key);
      desired.protections[key]=value;
      await page.locator(selector).setChecked(value);
    }else{
      if(typeof value!=='string'||value!==value.trim()||/[\x00-\x1f\x7f]/.test(value)||Buffer.byteLength(value,'utf8')>max)throw Error('Invalid WAF loading text: '+key);
      desired.loading[key]=value;
      await page.locator(selector).fill(value);
    }
  }
  if(same(before,desired))return {workflowId,...state,verified:true,submitted:false};
  const payload=await nativePayload(page,desired),settingsJson=JSON.stringify(payload);
  if(Buffer.byteLength(settingsJson,'utf8')>200000)throw Error('WAF settings exceed the verified controller limit');
  if(!same(before,await readSettings(page,urls)))throw Error('WAF settings changed before save. Preview again.');
  const body={domain:urls.domain,settings_json:settingsJson},allowedFields=['domain','settings_json','csrf-token'];
  panel.expectedPost=urls.save;panel.expectedPostBody=body;panel.expectedPostFields=allowedFields;panel.oneShotPost=true;panel.allowWrites=true;
  const pending=page.waitForResponse(r=>matchesPost(r.request(),urls.save,body,allowedFields),{timeout:30000}).catch(()=>null);
  try{
    const save=page.locator('[data-waf-save-settings]:visible');
    await (action==='protections'?save.first():save.last()).click();
    const response=await pending;
    if(!response)throw Error('WAF save outcome unknown or native payload differs. Read current settings before retrying.');
    const result=await response.json();
    if(!response.ok()||result.status!=='success'||result.domain!==urls.domain)throw Error('WAF save rejected or outcome unknown. Read current settings before retrying.');
  }finally{panel.allowWrites=false;panel.expectedPost=null;panel.expectedPostBody=null;panel.expectedPostFields=null;panel.oneShotPost=false;}
  const {settings:after}=await nativeRead(panel,urls);
  const verified=same(desired,after);
  panel.store.audit('panel.execute',workflowId,{verified});
  return {workflowId,...publicState(urls.domain,after),submitted:true,verified};
}
