import {minecraftProductRecipe,planMinecraftProduct,prepareMinecraftProduct,checkMinecraftProduct,findMinecraftProduct,minecraftProductRejection} from './panel-minecraft-product.mjs';
import fs from 'node:fs';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {chromium,errors} from 'playwright';
import {profile, redact, transferFile, secret} from './connection.mjs';
import {DocumentationReader, documentationGuide, documentationLanguage} from './documentation.mjs';
import {applyPageBuilderSettings} from './seo-settings.mjs';
import {formControls,formControl,prepareAppealQuestions,setFormValues} from './panel-fields.mjs';
import {runRenewal} from './panel-renewal.mjs';
import {matchesPost} from './panel-request.mjs';
import {imageSlugPattern,panelImageLink} from './panel-image.mjs';
import {pollRecipes,runPollAction} from './panel-poll.mjs';
import {routeRecipes,runRouteAction} from './panel-route.mjs';
import {seasonRecipes,runSeasonAction} from './panel-season.mjs';
import {smmRecipes,runSmmAction} from './panel-smm.mjs';
import {creatorRecipes,runCreatorAction} from './panel-creator.mjs';
import {apiKeyRecipes,runApiKeyAction} from './panel-apikeys.mjs';
import {aiRecipes,runAiAction} from './panel-ai.mjs';
import {wafRecipes,runWafAction} from './panel-waf.mjs';
import {runProductDownload} from './panel-download.mjs';
import {enablePanelAddon} from './panel-addon.mjs';
import {openAnnouncementEditor,verifyAnnouncementEdit} from './panel-announcement.mjs';
import {runSupportAction} from './panel-support.mjs';
import {runReportDecision} from './panel-report.mjs';
import {isCustomerLogin,routeAuthentication,runAuthentication,watchAuthenticationResponse} from './panel-authentication.mjs';
import {needsLogin,isLoginPost,checkPanelLogin} from './panel-login.mjs';
import {panelRecords,grantMemberCredit} from './panel-member.mjs';

const sensitive = /password|passwd|secret|token|api.?key|authorization|csrf/i;
const normalizeGuideText = value => value.toLocaleLowerCase('tr').normalize('NFD').replace(/\p{M}/gu,'').replaceAll('ı','i');
const searchWords = query => normalizeGuideText(query ?? '').split(/\s+/).filter(Boolean);
async function waitForPageAssets(page) {
  try { await page.waitForLoadState('load', {timeout: 3000}); }
  catch (error) {
    if (!(error instanceof errors.TimeoutError)) throw error;
  }
}
const recipes = {
  ...pollRecipes,
  ...routeRecipes,
  ...seasonRecipes,
  ...smmRecipes,
  ...creatorRecipes,
  ...apiKeyRecipes,
  ...aiRecipes,
  ...wafRecipes,
  'reports.decision': {
    title:'Raporlar → Gerekçeli karar',
    pageId:'panel:site:page:main.reports',
    drawerId:'panel:site:drawer:report_update',
    reportDecision:true,
    requiresRecord:true,
    documentation:['/guides/reports'],
    fields:[{name:'status',type:'select',required:true},{name:'reason',type:'textarea',required:true},
      {name:'expectedStatus',type:'text',required:true}],
    verification:'Reads the selected report status and reason from ReportsDetailController'
  },
  'support.ticket.close': {
    title:'Canlı Destek → Talebi kapat',
    pageId:'panel:site:page:main.livesupports',
    drawerId:'panel:site:drawer:support_update',
    form:'#supportsEditForm',operationId:'supports-supportsclosecontroller',
    supportAction:'close',requiresRecord:true,
    documentation:['/guides/live-support']
  },
  'addon.enable': {
    title:'Eklentiler → Eklenti kur',
    pageId:'panel:site:page:main.addons',
    form:'#addonsEditForm',
    operationId:'addons-addonsupdatecontroller',
    addonInstall:true,
    documentation:['/guides/addons','/guides/customer-reviews'],
    fields:[{name:'addon',type:'string'}]
  },
  'store.product.minecraft.create': minecraftProductRecipe,
  'role.cosmetic.create': {
    title:'Roller → Görünüm rolü ekle',
    pageId:'panel:site:page:main.permissions',
    open:['#drawer_perms_add_button'],
    form:'#permsForm',operationId:'perms-permsaddcontroller',cosmeticRole:true,
    documentation:['/guides/permissions'],fields:[{name:'name',type:'text',required:true},
      {name:'color',type:'text',description:'Prefix color as #RRGGBB'},
      {name:'style',type:'select',description:'solid, soft, outline or gradient'}]
  },
  'store.category.create': {
    title: 'Mağaza → Kategoriler → Kategori ekle',
    pageId: 'panel:site:page:main.shop',
    open: ['#categoriesButton', '[data-bs-target="#category_create"]'],
    form: '#categoryAddForm', operationId: 'products-categoriesaddcontroller',
    verify: {operationId: 'products-categorieslistcontroller', query: {start: 0, length: 500}, match: ['name']},
    documentation: ['/guides/products', '/developers/operations/create-a-category-2']
  }
};

export class Panel {
  constructor(config, store, catalog, index, audience='admin') {
    this.config = config; this.store = store; this.catalog = catalog; this.index = index;
    this.audience=audience;
    this.baseCatalog=catalog;
    this.profile = profile(config); this.sequence = Promise.resolve(); this.context = null; this.page = null;
    this.documentationLanguage = documentationLanguage(this.profile?.docsLanguage);
    this.documentationReader = new DocumentationReader();
    this.allowWrites = false; this.expectedPost = null;
    this.documentation = JSON.parse(fs.readFileSync(path.join(config.base, 'data/panel-guides.json'), 'utf8'));
    const workflowFile=path.join(config.base,'data/document-workflows.json');
    this.documentWorkflows=fs.existsSync(workflowFile)?JSON.parse(fs.readFileSync(workflowFile,'utf8')):null;
    this.catalog=[...catalog,...(this.documentWorkflows?.nativeOperations??[])];
    this.recipes={...recipes,...Object.fromEntries((this.documentWorkflows?.recipes??[]).filter(r=>r.kind==='read'||(r.operationId?this.catalog.some(o=>o.id===r.operationId):(r.operationCandidates??[]).some(id=>this.catalog.some(o=>o.id===id)))).map(r=>[r.id,r]))};
    const appeal = this.recipes['form:main.appeals:appealsForm'];
    if(appeal)this.recipes[appeal.id]={...appeal,fields:[{name:'questions',type:'json',required:true},...appeal.fields]};
    const announcement=this.recipes['form:main.news:broadcastsForm'];
    if(announcement)announcement.verify={operationId:'broadcasts-broadcastslistcontroller',query:{start:0,length:25},searchField:'title',match:['title']};
    const announcementEdit=this.recipes['form:main.news:broadcastsEditForm'];
    if(announcementEdit)Object.assign(announcementEdit,{announcementEdit:true,requiresRecord:true,recordBodyField:'id',requestBodyMatch:{}});
    const supportReply=this.recipes['form:support_update:supportsEditForm'];
    if(supportReply)supportReply.supportAction='reply';
    if(this.documentWorkflows){const originals=new Map(this.documentation.guides.map(g=>[g.url,g]));
      this.documentation.guides=this.documentWorkflows.guides.map(g=>({...originals.get(g.url),...g}));
    }
  }
  customer(){
    if(this.audience==='customer')return this;
    this.customerPanel??=new Panel(this.config,this.store,this.baseCatalog,this.index,'customer');
    this.customerPanel.documentationLanguage=this.documentationLanguage;
    return this.customerPanel;
  }
  exclusive(task) { const next = this.sequence.then(task); this.sequence = next.catch(() => {}); return next; }
  origin() {
    const configured = this.profile?.panel?.url ?? this.profile?.api?.url;
    if (!configured) throw Error('Configure connection.panel.url or the site API origin first');
    const url = new URL(configured);
    if (url.username || url.password || url.search || url.hash || url.pathname !== '/') throw Error('Panel URL must identify the site origin');
    if (url.protocol !== 'https:' && !(this.profile.environment === 'test' && url.protocol === 'http:' && ['127.0.0.1','localhost','[::1]'].includes(url.hostname))) throw Error('Remote panel requires HTTPS');
    return url.origin;
  }
  status() { return {running: !!this.page && !this.page.isClosed(), configured: !!(this.profile?.panel?.url ?? this.profile?.api?.url),
    execution: 'background panel session', recipeCount:Object.keys(this.recipes).length, recipes:Object.keys(recipes),documentationLanguage:this.documentationLanguage,documentationCoverage:this.documentWorkflows?.summary??null}; }
  matchingGuides(words, language, includePanels = false) {
    if (!words.length) return this.documentation.guides;
    return this.documentation.guides.filter(guide => {
      const localized = documentationGuide(guide, language);
      const searchable = normalizeGuideText([guide.url, guide.title, localized.title, localized.description,
        ...guide.headings, ...(includePanels ? guide.panels : [])].join(' '));
      return words.every(word => searchable.includes(word));
    });
  }
  workflows(options) {
    let entries=Object.entries(this.recipes).map(([id,value])=>({id,...value}));
    if(!options)return entries;
    const words=searchWords(options.query);
    const language=documentationLanguage(options.language ?? this.documentationLanguage);
    const guides=this.matchingGuides(words,language);
    const urls=new Set(guides.map(g=>g.url));
    if(words.length){
      const linkedWorkflows=new Set(guides.flatMap(guide=>guide.workflows??[]));
      const linked=recipe=>linkedWorkflows.has(recipe.id)||(recipe.documentation??[]).some(url=>urls.has(url));
      entries=entries.filter(r=>linked(r)||words.every(w=>normalizeGuideText([r.id,r.title,...(r.documentation??[])].join(' ')).includes(w)));
      entries.sort((left,right)=>Number(linked(right))-Number(linked(left)));
    }
    const offset=options.offset??0,limit=options.limit??8;
    return {total:entries.length,offset,items:entries.slice(offset,offset+limit).map(({id,title,pageId,drawerId,requiresRecord,recordContext,form,operationId,nativeProbe,documentation,verification,fields,audience,customerPath,alternateForms})=>({id,title,pageId,drawerId,requiresRecord,recordContext:recordContext&&Object.keys(recordContext),form,operationId,nativeProbe,documentation,verification,audience,customerPath,alternateForms,...(fields?{totalFields:fields.length,fields:fields.slice(0,5)}:{})}))};
  }
  guides({query='',offset=0,limit=8,language=this.documentationLanguage}={}) {
    language=documentationLanguage(language);
    const all=this.matchingGuides(searchWords(query),language,true);
    return {total:all.length,offset,language,items:all.slice(offset,offset+limit).map(g=>{
      const localized=documentationGuide(g,language);
      const indexed=this.documentWorkflows?.guides.find(guide=>guide.url===g.url);
      const builtIn=Object.keys(recipes).filter(id=>(recipes[id].addonInstall||recipes[id].reportDecision||recipes[id].pollAction||recipes[id].routeAction||recipes[id].seasonAction||recipes[id].smmAction||recipes[id].creatorAction||recipes[id].apiKeyAction||recipes[id].aiAction)&&recipes[id].documentation.includes(g.url));
      return {url:localized.url,guidePath:g.url,documentationUrl:localized.documentationUrl,title:localized.title,order:g.order,group:g.group,
        state:builtIn.some(id=>recipes[id].reportDecision||recipes[id].pollAction||recipes[id].routeAction||recipes[id].seasonAction||recipes[id].smmAction||recipes[id].creatorAction||recipes[id].apiKeyAction||recipes[id].aiAction)?'form-recipes-indexed':indexed?.state??g.state,
        workflows:[...new Set([...builtIn,...(indexed?.workflows??g.workflows??[])])].filter(id=>Object.hasOwn(this.recipes,id)).slice(0,8),
        tools:indexed?.tools??g.tools,panels:indexed?.panels??g.panels,
        screenshots:g.images.length,headings:language==='tr'?g.headings.slice(0,5):undefined};
    })};
  }
  readGuide({guidePath,language=this.documentationLanguage,textOffset=0}) {
    language=documentationLanguage(language);
    const guide=this.documentation.guides.find(item=>item.url===guidePath||documentationGuide(item,language).url===guidePath);
    if(!guide)throw Error('Select a known guidePath from zonely_panel_workflows');
    return this.documentationReader.open(guide,language,textOffset);
  }
  async session(interactive = false) {
    await this.browserShutdown;
    if (this.context && this.page && !this.page.isClosed()) {
      if (this.interactive === interactive) return this.page;
      if (this.loginTarget) throw Error('Complete the open sign-in before retrying.');
      await this.closeBrowser();
    }
    const origin = this.origin();
    const binding = createHash('sha256').update(this.profile.environment + origin).digest('hex').slice(0, 24);
    const directory = path.join(this.config.runtime, this.audience==='customer'?'customer-profiles':'panel-profiles', binding);
    fs.mkdirSync(directory, {recursive: true, mode: 0o700});
    try {
      this.context = await chromium.launchPersistentContext(directory, {
        channel: this.profile.panel?.channel, headless: !interactive, args: ['--mute-audio'],
        viewport: {width: 1440, height: 960}, acceptDownloads: false, serviceWorkers: 'block'
      });
    } catch (error) {
      throw Error('The panel session could not be started.', {cause:error});
    }
    this.interactive=interactive;
    const context=this.context;
    if(this.loginCookies){
      await context.addCookies(this.loginCookies);
      this.loginCookies=null;
    }
    context.on('close',()=>{
      if(this.context===context){this.context=null;this.page=null;this.loginTarget=null;}
    });
    this.context.setDefaultTimeout(15000);
    await this.context.route('**/*', route => {
      const req = route.request(), url = new URL(req.url());
      if (!['http:', 'https:'].includes(url.protocol)) return route.abort();
      if (!['GET','HEAD'].includes(req.method())) {
        if(this.addonWrite)return this.addonWrite(req)?route.continue():route.abort();
        if(this.manualAuthentication)
          return routeAuthentication(this,req,this.manualAuthentication).then(allowed=>allowed?route.continue():route.abort());
        if(this.loginTarget)return isLoginPost(req,origin)?route.continue():route.abort();
        if (!this.allowWrites) return route.abort();
        if(this.expectedPost)return matchesPost(req,this.expectedPost,this.expectedPostBody,this.expectedPostFields)
          .then(allowed=>{
            if(!allowed||!this.allowWrites)return route.abort();
            if(this.oneShotPost)this.allowWrites=false;
            return route.continue();
          });
      }
       
      if (url.origin !== origin && (req.isNavigationRequest() || !['GET','HEAD'].includes(req.method()))) return route.abort();
      return route.continue();
    });
    this.page = this.context.pages()[0] ?? await this.context.newPage();
    this.page.on('dialog', dialog => dialog.dismiss());
    this.page.on('response',response=>{void watchAuthenticationResponse(this,response).catch(()=>{});});
    this.page.on('response',response=>{
      if(this.loginTarget&&isLoginPost(response.request(),origin))void response.json().then(result=>{
        if(response.ok()&&result?.status==='success')return checkPanelLogin(this,context);
      }).catch(()=>{});
    });
    this.page.on('framenavigated',frame=>{
      if(!this.loginTarget||frame!==this.page?.mainFrame())return;
      const location=new URL(frame.url());
      if(location.origin===origin&&/^\/(?:admin|profile)(?:\/|$)/.test(location.pathname))
        void checkPanelLogin(this,context).catch(()=>{});
    });
    this.page.on('requestfailed',request=>{
      if(this.manualAuthentication?.pending===request){
        this.manualAuthentication.pending=null;
        this.manualAuthentication.outcome='rejected';
      }
    });
    return this.page;
  }
  route(pageId, recipePath, recordId) {
    const entry = this.index.records.find(row => row.id === pageId && row.kind === 'page' && row.edition === 'site');
    if (!entry) throw Error('Select an indexed site panel page');
    if(recipePath){
      if(!this.documentWorkflows?.recipes.some(r=>r.pageId===pageId&&r.pagePath===recipePath))throw Error('Select a registered workflow route');
      if(recipePath.includes('{id}')&&(!Number.isSafeInteger(recordId)||recordId<=0))throw Error('This route requires recordId');
      const resolved=recipePath.replace('{id}',String(recordId));
      if(!/^\/admin\/[a-z0-9/_-]+$/i.test(resolved))throw Error('Select a registered workflow route');
      return resolved;
    }
    const rule = entry.routes?.find(row => /^\^admin\/[a-z0-9/_-]+\(\/\?\)\$$/i.test(row.pattern));
    if(!rule&&this.documentWorkflows?.genericRoutePages.includes(pageId)&&/^main\.[a-zA-Z0-9_-]+$/.test(entry.key))return '/admin/'+entry.key.slice(5);
    if (!rule) throw Error('This indexed page requires a route-specific recipe');
    return '/' + rule.pattern.replace(/^\^/, '').replace(/\(\/\?\)\$$/, '');
  }
  async navigate(pageId, open = [], recipePath, recordId) {
    this.allowWrites = false; this.expectedPost = null; this.expectedPostBody=null;
    const page = await this.session();
    const target=this.route(pageId,recipePath,recordId);
    const response = await page.goto(this.origin() + target, {waitUntil: 'domcontentloaded'});
    if(needsLogin(page.url(),this.origin(),target,response?.status())){
      throw Error('Site sign-in is required. Ask the user before opening the sign-in window.');
    }
    if (!response?.ok() || new URL(page.url()).origin !== this.origin()) throw Error('Panel page could not be opened; sign in using zonely_panel_open');
    await waitForPageAssets(page);
    for (const selector of open) {
      const trigger=page.locator(selector).first();
      await trigger.waitFor({state:'attached'});
      const target=await trigger.getAttribute('data-bs-target');
       
      if(target)await page.waitForFunction(({selector,target})=>{
        const visible=e=>!!e&&e.getClientRects().length>0&&getComputedStyle(e).visibility!=='hidden';
        return visible(document.querySelector(target))||visible(document.querySelector(selector));
      },{selector,target});
      if(target&&await page.locator(target).isVisible())continue;
      await trigger.click();
    }
    return page;
  }
  open(audience=this.audience, interactive=false) {
    if(audience==='customer'&&this.audience!=='customer')return this.customer().open('customer',interactive);
    return this.exclusive(async () => {
      if(this.loginTarget)return {opened:true,status:'login-window-open',audience:this.audience};
      const page=await this.session();
      this.manualAuthentication=null;
      this.allowWrites=false;this.expectedPost=null;this.expectedPostBody=null;
      const target=this.audience==='customer'?'/profile':'/admin';
      const response=await page.goto(this.origin()+target,{waitUntil:'domcontentloaded'});
      if(needsLogin(page.url(),this.origin(),target,response?.status())){
        const interactiveAvailable=this.profile.panel?.headless!==true;
        if(interactive&&interactiveAvailable)return this.openLogin(target);
        return {opened:false,authenticated:false,status:'sign-in-required',audience:this.audience,interactiveAvailable};
      }
      if(!response?.ok())throw Error('The protected Zonely page could not be opened.');
      return {opened:false,authenticated:true,status:'already-signed-in',origin:this.origin(),audience:this.audience};
    });
  }
  async openLogin(target){
    const page=await this.session(true);
    this.loginTarget=target;
    const url=new URL('/login',this.origin());
    url.searchParams.set('next',target);
    await page.goto(url.href,{waitUntil:'domcontentloaded'}).catch(error=>{
      if(!page.isClosed())throw error;
    });
    if(!page.isClosed())await page.bringToFront();
    return {opened:!page.isClosed(),status:page.isClosed()?'signed-in':'login-window-open',origin:this.origin(),audience:this.audience};
  }
  records(input){return this.exclusive(()=>panelRecords(this,input));}
  grantCredit(input){return this.exclusive(()=>grantMemberCredit(this,input));}
  inspect({pageId, open = [], form, optionField, optionQuery='', offset=0, limit=8} = {}) { return this.exclusive(async () => {
    const page = pageId ? await this.navigate(pageId, open) : await this.session();
    const forms = await page.locator(form ?? 'form').evaluateAll((elements,args) => elements.slice(0, 5).map(f => ({
      id: f.getAttribute('id')??'', method: (f.getAttribute('method')??'get').toLowerCase(),
      fields: [...(f.tagName==='FORM'?f.elements:f.querySelectorAll('input,select,textarea'))].filter(e => ['INPUT','SELECT','TEXTAREA'].includes(e.tagName)&&!['hidden','password'].includes(e.type) && e.name && (!args.optionField||e.name===args.optionField)).slice(args.optionField?0:args.offset,args.optionField?1:args.offset+args.limit).map(e => ({
        name: e.name, type: e.type, required: e.required,
        ...(e.tagName === 'SELECT' ? {options: [...e.options].filter(o=>(o.text+' '+o.value).toLocaleLowerCase().includes(args.optionQuery.toLocaleLowerCase())).slice(args.optionField?args.offset:0,args.optionField?args.offset+args.limit:8).map(o => ({value: o.value.slice(0,160), text: o.text.slice(0, 100)})), optionCount: e.options.length} : {})
      }))
    })),{optionField,optionQuery,offset,limit});
    const indexed = pageId ? this.index.records.find(row => row.id === pageId) : null;
    const related = indexed ? [indexed, ...this.index.records.filter(row => indexed.links.includes(row.id))] : [];
    const panelPath=new URL(page.url()).pathname.replace(/^\/admin\//,'');
    const sourceGuide=this.documentation.guides.find(g=>g.panels.includes(panelPath));
    const guide=sourceGuide&&documentationGuide(sourceGuide,this.documentationLanguage);
    const result={origin: this.origin(), path: new URL(page.url()).pathname, forms: redact(forms),offset,
      ...(guide?{guide:{url:guide.url,guidePath:guide.guidePath,documentationUrl:guide.documentationUrl,language:guide.language,
        title:guide.title,excerpt:guide.language==='tr'?guide.excerpt:guide.description,screenshots:guide.images.slice(0,8)}}:{}),
      sourceOperations: [...new Set(related.flatMap(row => row.operations.map(op => op.id).filter(Boolean)))].slice(0, 30),
      linkedSurfaces: indexed?.links ?? [], environment: this.profile.environment};
    while(Buffer.byteLength(JSON.stringify(result))>14000){const biggest=result.forms.reduce((a,b)=>a.fields.length>b.fields.length?a:b);if(!biggest.fields.length)throw Error('Narrow the selected form');biggest.fields.pop();result.truncated=true;}
    return result;
  }); }
  imageLink(slug) { return this.exclusive(()=>panelImageLink(this,slug)); }
  execute(input) {
    if(this.audience==='admin'&&Object.hasOwn(this.recipes,input.workflowId)&&this.recipes[input.workflowId].audience==='customer')
      return this.customer().execute(input);
    return this.exclusive(async () => {
      try{return await this.run(input);}
      catch(error){throw Error(redact(error.message,(input.envFields??[]).map(f=>process.env[f.env])));}
      finally{this.allowWrites=false;this.expectedPost=null;this.expectedPostBody=null;}
    });
  }
  saveSettings(fields) { return applyPageBuilderSettings(this,fields); }
  async mountDrawer(drawerId,recordId,requiresRecord=false,query={},customerForm){
    const drawer=this.index.records.find(r=>r.id===drawerId&&r.edition==='site'&&r.kind==='drawer');
    const endpoint=drawer?.drawerEndpoint;
    if(!endpoint)throw Error('Select a registered site drawer');
    if(requiresRecord&&(!Number.isSafeInteger(recordId)||recordId<=0))throw Error('This documented edit/copy drawer requires recordId');
    const url=new URL(endpoint,this.origin());
    if(this.audience==='admin')url.searchParams.set('scope','admin');
    if(recordId!==undefined)url.searchParams.set('id',String(recordId));
    for(const [name,value] of Object.entries(query))url.searchParams.set(name,String(value));
    await this.page.evaluate(async ({url,audience,customerForm,recordId,query})=>{
      const response=await fetch(url,{headers:{'X-Requested-With':'XMLHttpRequest'},signal:AbortSignal.timeout(15000)});
      if(!response.ok||new URL(response.url).pathname!==new URL(url).pathname)throw Error(`Drawer is unavailable for this session or record (HTTP ${response.status})`);
      let html=await response.text();if(html.length>2*1024*1024)throw Error('Drawer markup exceeds budget');
      try{const value=JSON.parse(html);html=value.html??value.content??value.data?.html??html;}catch{}
      if(customerForm){
        const template=document.createElement('template');
        template.innerHTML=String(html);
        const form=template.content.querySelector(customerForm);
        const ids=form?.querySelectorAll('input[name="id"]');
        if(!ids||ids.length!==1||ids[0].value.trim()!==String(recordId))
          throw Error('The record is unavailable in this customer session');
        ids[0].value=String(recordId);
        if(Object.hasOwn(query,'order')){
          const orders=form.querySelectorAll('input[name="order"]');
          if(orders.length!==1||orders[0].value.trim()!==String(query.order))
            throw Error('The renewal drawer did not return the selected order');
          orders[0].value=String(query.order);
        }
        form.setAttribute('data-zonely-mcp-customer-form','');
        html=template.innerHTML;
      }
      if(typeof html!=='string'||!/<(?:form|div|section)\b/i.test(html))throw Error('Drawer did not return markup');
      if(!window.jQuery||(audience==='admin'&&!window.ZonelyAdminLifecycle))throw Error('Native drawer loader is not ready');
      let host=document.getElementById('zonely-mcp-drawer-host');if(!host){host=document.createElement('div');host.id='zonely-mcp-drawer-host';document.body.append(host);}
      let mounted;
      if(audience==='customer'&&typeof window.zonelyRehydrateSpaRuntime==='function'){
        const staging=document.createElement('template');
        staging.innerHTML=html;
        if(staging.content.querySelector('script[data-zonely-requires~="froala"]')&&typeof window.jQuery.fn.froalaEditor!=='function'){
          if(typeof window.zonelyEnsureFroalaAssets!=='function'||!await window.zonelyEnsureFroalaAssets())
            throw Error('The storefront editor could not be loaded');
        }
        host.append(staging.content);
        mounted=window.zonelyRehydrateSpaRuntime(host,true);
      }else{
        window.jQuery(host).html(html);
        mounted=host.__zonelyDrawerMountPromise;
      }
      let timer;try{await Promise.race([mounted??Promise.resolve(),new Promise((_,reject)=>{timer=setTimeout(()=>reject(Error('Native drawer initialization timed out')),15000);})]);}finally{clearTimeout(timer);}
    },{url:url.href,audience:this.audience,customerForm,recordId,query});
  }
  async run({workflowId, plan,recordId,recordContext={}, fields = {}, files = [], envFields = [], mode = 'preview',expectedPrice}) {
    const recipe = workflowId ? (Object.hasOwn(this.recipes,workflowId)?this.recipes[workflowId]:null) : plan;
    if (!recipe) throw Error('Select a documented workflow or supply a bounded panel form plan');
    if((recipe.audience??'admin')!==this.audience)throw Error('This workflow requires its own browser session');
    if(expectedPrice&&!recipe.renewal)throw Error('Expected price only applies to a renewal workflow');
    if(recipe.aiAction)return runAiAction(this,{recipe,workflowId,recordId,recordContext,fields,files,envFields,mode});
    if(recipe.wafAction)return runWafAction(this,{recipe,workflowId,recordId,recordContext,fields,files,envFields,mode});
    if(recipe.apiKeyAction)return runApiKeyAction(this,{recipe,workflowId,recordId,recordContext,fields,files,envFields,mode});
    if(recipe.creatorAction)return runCreatorAction(this,{recipe,workflowId,recordId,recordContext,fields,files,envFields,mode});
    if(recipe.smmAction)return runSmmAction(this,{recipe,workflowId,recordId,recordContext,fields,files,envFields,mode});
    if(recipe.seasonAction)return runSeasonAction(this,{recipe,workflowId,recordId,recordContext,fields,files,envFields,mode});
    if(recipe.routeAction)return runRouteAction(this,{recipe,workflowId,recordId,recordContext,fields,files,envFields,mode});
    if(recipe.pollAction)return runPollAction(this,{recipe,workflowId,recordId,recordContext,fields,files,envFields,mode});
    if(recipe.addonInstall)return enablePanelAddon(this,{recipe,fields,files,envFields,mode,recordId,recordContext});
    if(recipe.reportDecision)return runReportDecision(this,{recordId,fields,files,envFields,mode});
    if(recipe.kind==='read'){
      if(Object.keys(fields).length||files.length||envFields.length)throw Error('Read workflows do not accept form inputs');
      const page=await this.navigate(recipe.pageId);
      if(recipe.readSelector)await page.locator(recipe.readSelector).waitFor({state:'visible',timeout:10000});
      const visible=await page.evaluate(selector=>{const root=selector?document.querySelector(selector):document.querySelector('#zonely_content')??document.querySelector('main')??document.body;
        if(!root)throw Error('The documented page component was not found');
        const walker=document.createTreeWalker(root,NodeFilter.SHOW_TEXT);const lines=[];let size=0;
        while(walker.nextNode()&&size<4000){const node=walker.currentNode,e=node.parentElement,text=node.textContent.trim();
          if(!text||!e||!e.getClientRects().length||getComputedStyle(e).visibility==='hidden'||e.closest('input,textarea,select,script,style,code,pre,[data-secret],.modal,.drawer'))continue;
          if(/password|parola|api.?key|secret|csrf|token/i.test(text))continue;lines.push(text);size+=text.length;
        }
        return lines.join('\n').replace(/[a-f0-9]{32,}/gi,'[redacted]').slice(0,4000);},recipe.readSelector??null);
      return {workflowId,read:true,verified:true,path:new URL(page.url()).pathname,text:visible,documentation:recipe.documentation,submitted:false};
    }
    if(recipe.requiresRecord&&(!Number.isSafeInteger(recordId)||recordId<=0))throw Error('This documented workflow requires recordId');
    if(recipe.announcementEdit){
      const editable=['title','content','tags','category_id','commentscheck','date_timeout'];
      const requested=[...Object.keys(fields),...envFields.map(item=>item.field)];
      if(requested.some(name=>!editable.includes(name))||files.some(file=>file.field!=='image'))
        throw Error('Use recordId and editable announcement fields or an image');
      if(mode==='apply'&&!requested.length&&!files.length)throw Error('Supply the announcement fields to update');
    }
    const drawerQuery={};
    for(const [field,param] of Object.entries(recipe.recordContext??{})){
      if(recordContext[field]===undefined)throw Error('This documented workflow requires recordContext.'+field);
      drawerQuery[param]=recordContext[field];
    }
    if(Object.keys(recordContext).some(field=>!Object.hasOwn(recipe.recordContext??{},field)))throw Error('Record context is not used by this workflow');
    if (!['preview','apply'].includes(mode)) throw Error('Choose preview or apply');
    const operation = this.catalog.find(o => o.id === recipe.operationId);
    const candidates=(recipe.operationCandidates??[]).map(id=>this.catalog.find(o=>o.id===id)).filter(o=>o&&(o.methods??[o.method]).includes('POST'));
    if ((!operation||!(operation.methods??[operation.method]).includes('POST'))&&!candidates.length)throw Error('Select a catalogued panel POST operation');
    if(recipe.authentication){
      if(recordId!==undefined||Object.keys(fields).length||files.length||envFields.length)
        throw Error('Enter verification data only in the customer browser');
      this.allowWrites=false;
      if(mode==='preview'&&this.manualAuthentication?.workflowId!==recipe.id)this.manualAuthentication=null;
      return runAuthentication(this,{recipe,operation,mode});
    }
    this.manualAuthentication=null;
    let gameProduct;
    if(recipe.minecraftProduct){
      if(envFields.length)throw Error('This workflow does not accept secrets');
      ({fields,files,product:gameProduct}=planMinecraftProduct(fields,files));
      const saved=await findMinecraftProduct(await this.session(),this.origin(),gameProduct);
      if(saved?.length>1 || (saved?.length===1 && !saved[0].identical))
        throw Error('A game product already uses a requested name in this category with different details.');
      if(saved?.length===1)return {submitted:false,verified:true,existing:true,mode,record:saved[0].record};
    }
    let page;
    if(this.audience==='customer'){
      this.allowWrites=false;this.expectedPost=null;this.expectedPostBody=null;
      page=await this.session();
      const destination=new URL(recipe.customerPath,this.origin());
      const response=await page.goto(destination.href,{waitUntil:'domcontentloaded'});
      const actual=new URL(page.url());
      if(!response?.ok()||actual.origin!==destination.origin||actual.pathname.replace(/\/$/,'')!==destination.pathname)
        throw Error('Open zonely_panel_open with audience=customer and sign in to the record owner account');
      await waitForPageAssets(page);
    }else page=await this.navigate(recipe.pageId,recipe.open,recipe.pagePath,recordId);
    if(mode==='apply'&&(recipe.requiredFields??[]).some(name=>!Object.hasOwn(fields,name)||
      !['string','number'].includes(typeof fields[name])||!String(fields[name]).trim()))
      throw Error('Supply the required workflow fields: '+recipe.requiredFields.join(', '));
    if(recipe.renewal){
      if(Object.keys(fields).length||files.length||envFields.length)throw Error('The renewal form uses the selected license and order only');
      return runRenewal(this,{page,recipe,operation,recordId,drawerQuery,mode,expectedPrice});
    }
    if(recipe.download){
      if(Object.keys(fields).length||files.length||envFields.length)throw Error('The download uses productId and recordId only');
      if(!Number.isSafeInteger(drawerQuery.productId)||drawerQuery.productId<=0)throw Error('Supply a valid productId');
      return runProductDownload(this,{page,recipe,operation,recordId,productId:drawerQuery.productId,mode});
    }
    const originalAnnouncement=recipe.announcementEdit?await openAnnouncementEditor(page,this.origin(),recipe.form,recordId):null;
    if(recipe.recordTrigger){
      const {selector,attribute,field}=recipe.recordTrigger;
      const identity=field?fields[field]:recordId;
      if(identity!==undefined){
        const selected=page.locator(selector+'['+attribute+'='+JSON.stringify(String(identity))+']').first();
        try{await selected.waitFor({state:'attached',timeout:5000});}
        catch{throw Error('The selected record is not available in this panel session');}
        await selected.dispatchEvent('click');
        if(field&&await page.locator(recipe.form).locator('[name='+JSON.stringify(field)+']').inputValue()!==String(identity))
          throw Error('The native panel did not open the selected record');
      }
    }
    if(recipe.drawerTrigger){
      await this.mountDrawer(recipe.drawerTrigger.parentId);
       
      await page.locator(recipe.drawerTrigger.selector.replace('{id}',String(recordId))).dispatchEvent('click');
    }else if(recipe.drawerId)await this.mountDrawer(recipe.drawerId,recordId,recipe.requiresRecord,drawerQuery,
      this.audience==='customer'?recipe.form:undefined);
    const form = this.audience==='customer'?page.locator(recipe.form+'[data-zonely-mcp-customer-form]'):page.locator(recipe.form);
    if(recipe.supportAction)return runSupportAction(this,{page,form,recipe,workflowId,operation,recordId,fields,files,envFields,mode});
    if(this.audience==='customer'){
      await form.waitFor({state:'attached',timeout:4000}).catch(()=>{throw Error('The record is unavailable in this customer session');});
      const identity=form.locator('input[name="id"]');
      if(await identity.count()!==1||(await identity.inputValue()).trim()!==String(recordId))
        throw Error('The customer drawer did not return the requested record');
      await identity.evaluate((input,id)=>{input.value=id;},String(recordId));
      if(mode==='apply'&&!Object.keys(fields).length&&!files.length&&!envFields.length)
        throw Error('Supply the customer form fields to update');
    }else await form.waitFor({state:'attached'});
    if(recipe.fieldAliases)await form.evaluate((element,aliases)=>{
      for(const control of element.elements)if(!control.name&&Object.hasOwn(aliases,control.id))control.name=aliases[control.id];
    },recipe.fieldAliases);
    if(operation?.id==='appeals-appealsaddcontroller'&&recipe.form==='#appealsForm'&&Object.hasOwn(fields,'questions')){
      fields=await prepareAppealQuestions(form,fields);
    }
    if(gameProduct)await prepareMinecraftProduct(page,gameProduct.offers.length);
    let cosmeticRoleName, cosmeticAppearanceRequested=false;
    if(recipe.cosmeticRole){
      cosmeticRoleName=typeof fields.name==='string'?fields.name.trim():'';
      const {color,style}=fields;
      cosmeticAppearanceRequested=color!==undefined||style!==undefined;
      const styles={solid:'#pfxSolid',soft:'#pfxSoft',outline:'#pfxOutline',gradient:'#pfxGradient'};
      if(!cosmeticRoleName||cosmeticRoleName.length>60||/[<>\r\n]/.test(cosmeticRoleName)||
        Object.keys(fields).some(key=>!['name','color','style'].includes(key))||
        (color!==undefined&&(typeof color!=='string'||!/^#[0-9a-f]{6}$/i.test(color)))||
        (style!==undefined&&(typeof style!=='string'||!Object.hasOwn(styles,style)))||files.length||envFields.length)
        throw Error('Supply a display name, optional hex color and optional prefix style for a cosmetic role');
      if(await page.getByText(cosmeticRoleName,{exact:true}).filter({visible:true}).count()){
        if(cosmeticAppearanceRequested&&mode==='apply')throw Error('This role already exists; use the role editor to change its appearance');
        return {submitted:false,mode,existing:true,verified:!cosmeticAppearanceRequested};
      }
      fields={};
      const label=form.locator('#pfxPreview[contenteditable="true"]');
      await label.fill(cosmeticRoleName,{timeout:8000});
      await label.press('Tab');
      if((await label.textContent())?.trim()!==cosmeticRoleName)
        throw Error('The role name was not retained by the panel');
      if(color){
        const picker=form.locator('#pfxColor');
        await picker.evaluate((input,value)=>{
          input.value=value;
          input.dispatchEvent(new Event('input',{bubbles:true}));
          input.dispatchEvent(new Event('change',{bubbles:true}));
        },color);
        if((await picker.inputValue()).toLowerCase()!==color.toLowerCase())
          throw Error('The role color was not retained by the panel');
      }
      if(style){
        const radio=form.locator(styles[style]);
        await radio.evaluate(input=>input.click());
        if(!await radio.isChecked())throw Error('The role style was not retained by the panel');
      }
      if(cosmeticAppearanceRequested){
        const serialized=JSON.parse(await form.locator('#prefix_opts').inputValue());
        if(serialized.text!==cosmeticRoleName||(color&&serialized.color?.toLowerCase()!==color.toLowerCase())||
          (style&&serialized.style!==style))throw Error('The panel did not prepare the requested role appearance');
      }
    }
    const controls = await formControls(form);
    const names = [...Object.keys(fields), ...files.map(f => f.field), ...envFields.map(f => f.field)];
    if((recipe.drawerId||recipe.requiresRecord)&&names.includes('id'))throw Error('The workflow record identity comes from recordId');
    if (new Set(names).size !== names.length || names.some(name => /csrf/i.test(name) || !controls.some(c => c.name === name)) ||
        [...Object.keys(fields), ...files.map(f => f.field)].some(name => sensitive.test(name))) throw Error('Use existing business form controls; secret values use envFields, and CSRF is managed by the panel');
    const values = {...fields, ...Object.fromEntries(envFields.map(f => [f.field, secret(f.env)]))};
    if(recipe.recordBodyField&&values.command!==undefined){
      const command=String(values.command).trim();
      if(!command||command.length>1000||/[\r\n\0]/.test(command))throw Error('Supply one console command up to 1000 characters');
      values.command=command.startsWith('/')?command:'/say '+command;
    }
    await setFormValues(form,values);
    for (const file of files){
      const control=await formControl(form,file.field);
      try{await control.setInputFiles(transferFile(this.config,this.store,file));}
      finally{await control.dispose();}
    }
    if(gameProduct)await checkMinecraftProduct(form,gameProduct);
    if (mode === 'preview') return {ready: true, mode, workflowId, operation: operation?.id,nativeProbeRequired:!operation, fields: names, submitted: false};
    if(recipe.form==='#pageBuilderForm'&&operation?.id==='settings-generalsettingsupdatecontroller'){
      await this.saveSettings(values);
      this.store.audit('panel.execute',operation.id,{workflowId,fields:names,verified:false});
      return {submitted:true,acknowledged:true,operation:operation.id,environment:this.profile.environment,
        verified:false,hint:'All native PageBuilder save steps acknowledged; reload and compare requested fields'};
    }
    if(!operation){
      if(!await form.evaluate(f=>f.checkValidity()))throw Error('Panel form validation failed; fill required controls before applying');
      const matches=(op,url)=>{const expected=new URL(op.path,this.origin());return url.origin===expected.origin&&url.pathname===expected.pathname&&Object.entries(op.routing).every(([k,v])=>url.searchParams.get(k)===String(v));};
       
      this.allowWrites=false;this.expectedPost=null;
      let accept,reject,timer;
      const pending=new Promise((resolve,fail)=>{accept=resolve;reject=fail;});
      const probe=async route=>{const req=route.request();if(req.method()==='POST'&&candidates.some(op=>matches(op,new URL(req.url())))){await route.abort();accept(req);}else await route.fallback();};
      let request;
      await page.route('**/*',probe);
      try{
        timer=setTimeout(()=>reject(Error('Native form target was not resolved; no write was allowed')),15000);
         
        const result=pending.catch(error=>({error}));
        await form.evaluate(f=>f.requestSubmit());const value=await result;if(value.error)throw value.error;request=value;
      }finally{clearTimeout(timer);await page.unroute('**/*',probe);}
      const actual=new URL(request.url()),chosen=candidates.filter(op=>matches(op,actual));
      if(chosen.length!==1)throw Error('Native form target is ambiguous; no write was allowed');
      const query=Object.fromEntries([...actual.searchParams].filter(([key])=>!Object.hasOwn(chosen[0].routing,key)));
      if(Object.keys(query).some(key=>sensitive.test(key)))throw Error('Native form target contains a secret query; use a dedicated recipe');
      return this.run({plan:{...recipe,operationId:chosen[0].id,requestQuery:query},recordId,recordContext,fields,files,envFields,mode});
    }
     
    const expected = new URL(operation.path, this.origin());
    for (const [k, v] of Object.entries(operation.routing)) expected.searchParams.set(k, v);
    for(const [k,v]of Object.entries(recipe.requestQuery??{})){if(Object.hasOwn(operation.routing,k))throw Error('Recipe cannot override operation routing');expected.searchParams.set(k,String(v));}
    if (!await form.evaluate(f => f.checkValidity())) throw Error('Panel form validation failed; fill required controls before applying');
    const bodyMatch=recipe.requestBodyMatch&&{
      ...recipe.requestBodyMatch,
      ...(recipe.recordBodyField?{[recipe.recordBodyField]:String(recordId)}:{}),
      ...Object.fromEntries((recipe.requiredFields??[]).map(name=>{
        const value=String(values[name]);
        return [name,name==='message'?value.trim():value];
      })),
    };
    this.expectedPost = expected; this.expectedPostBody=bodyMatch; this.allowWrites = true;
    const pending = page.waitForResponse(response=>matchesPost(response.request(),expected,bodyMatch),{timeout:30000});
    let response;
    try{
      try { await form.evaluate(f => f.requestSubmit()); } catch { await pending.catch(() => {}); throw Error('Panel could not submit the form; inspect the current page before retrying'); }
      try { response = await pending; } catch { throw Error('Panel write outcome is unknown; read existing records before retrying'); }
    }finally{
      this.allowWrites=false;this.expectedPost=null;this.expectedPostBody=null;
    }
    if (Number(response.headers()['content-length'] ?? 0) > 1024 * 1024) throw Error('Panel result exceeds budget; inspect the saved site state');
    let result; try { result = await response.json(); } catch { throw Error('Panel returned no structured acknowledgement; inspect saved site state'); }
    if (!response.ok() || ['error','failed','fail'].includes(result?.status) || result?.success === false || result?.ok === false) throw Error(recipe.minecraftProduct ? minecraftProductRejection(result) : 'Panel rejected the operation; inspect form requirements and site logs');
    if (!(result?.status === 'success' || result?.success === true || result?.ok === true)) throw Error('Panel did not acknowledge the operation');
    let verification = originalAnnouncement ? await verifyAnnouncementEdit(page,this.origin(),originalAnnouncement,values,files)
      : recipe.verify ? await this.verify(page, recipe.verify, fields) : {verified: false, hint: 'No readback recipe supplied'};
    if(gameProduct){
      const matching=await findMinecraftProduct(page,this.origin(),gameProduct);
      verification=matching?.length===1&&matching[0].identical
        ? {verified:true,record:matching[0].record}
        : {verified:false,hint:'The panel accepted the game product. Verify the saved item before retrying.'};
    }
    if(cosmeticRoleName){
      await this.navigate(recipe.pageId);
      try{
        await page.getByText(cosmeticRoleName,{exact:true}).filter({visible:true}).first().waitFor({state:'visible',timeout:10000});
        verification={verified:!cosmeticAppearanceRequested,record:{name:cosmeticRoleName},
          ...(cosmeticAppearanceRequested?{hint:'The saved role name was verified; verify its appearance in the role editor.'}:{})};
      }catch{
        verification={verified:false,hint:'The panel accepted the role. Check the role list before retrying.'};
      }
    }
    if(workflowId==='form:main.news:broadcastsForm'&&verification.record?.id)
      verification=await verifyAnnouncementEdit(page,this.origin(),{id:verification.record.id},values,files,{create:true});
    if (operation.id==='images-imagesaddcontroller' && recipe.form==='#imagesCreateForm' &&
        typeof values.slug==='string' && imageSlugPattern.test(values.slug)) {
      try {
        const image=await panelImageLink(this,values.slug);
        verification={verified:true,image};
      } catch(error) {
        verification={verified:false,hint:error.message};
      }
    }
    this.store.audit('panel.execute', operation.id, {workflowId, fields: names, verified: verification.verified});
    return {submitted: true, acknowledged: true, operation: operation.id, environment: this.profile.environment, ...verification};
  }
  async verify(page, check, fields) {
    const operation = this.catalog.find(o => o.id === check.operationId);
    if (!operation || !(operation.methods ?? [operation.method]).includes('GET')) throw Error('Readback requires a catalogued GET operation');
    if (!check.match?.length || check.match.some(key => !Object.hasOwn(fields, key))) throw Error('Write acknowledged, but readback is unavailable. Inspect existing records before retrying');
    const url = new URL(operation.path, this.origin());
    const query={...check.query};
    if(check.searchField)query.search=String(fields[check.searchField]).slice(0,250);
    for (const [k, v] of Object.entries({...operation.routing, ...query})) {
      if (Object.hasOwn(operation.routing, k) && String(v) !== String(operation.routing[k])) throw Error('Readback routing cannot be changed');
      url.searchParams.set(k, String(v));
    }
    const raw = await page.evaluate(async url => {
      const r = await fetch(url, {credentials: 'same-origin', headers: {'X-Requested-With': 'XMLHttpRequest'}, signal: AbortSignal.timeout(15000)});
      const text = await r.text(); if (!r.ok || text.length > 1024 * 1024) return null;
      try { return JSON.parse(text); } catch { return null; }
    }, url.href);
    const rows = Array.isArray(raw) ? raw : Array.isArray(raw?.data) ? raw.data : null;
    if (!rows) throw Error('Write acknowledged, but readback is unavailable. Inspect existing records before retrying');
    const found = rows.filter(row => check.match.every(key => String(row[key]) === String(fields[key])));
    if (found.length !== 1) throw Error('Write acknowledged, but readback did not identify one record. Inspect existing records before retrying');
    return {verified: true, record: redact(Object.fromEntries(['id', ...check.match].filter(k => Object.hasOwn(found[0], k)).map(k => [k, found[0][k]])))};
  }
  async closeBrowser(){
    const context=this.context;
    if(!context)return this.browserShutdown;
    this.context=null;this.page=null;this.interactive=false;this.loginTarget=null;
    const closing=context.close();
    this.browserShutdown=closing;
    try{await closing;}finally{if(this.browserShutdown===closing)this.browserShutdown=null;}
  }
  async close() { await this.sequence; await this.customerPanel?.close(); await this.closeBrowser(); }
}
