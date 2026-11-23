import * as z from 'zod/v4';
import {applySeo} from './seo-settings.mjs';
import {imageSlugPattern, panelImageLink} from './panel-image.mjs';
import {transferFile} from './connection.mjs';

const name = z.string().trim().min(1).max(150);
const workflows = [
  'form:main.themes:pageBuilderForm', 'form:main.images:imagesCreateForm',
  'form:broadcast_categories:categoryAddForm', 'form:main.news:broadcastsForm',
  'form:product_categories:categoryAddForm', 'store.product.minecraft.create',
  'form:main.games:gamesForm', 'form:main.special.pages:specialpagesForm',
  'form:consultation_sections:categoryAddForm', 'form:suggestion_categories:categoryAddForm',
  'form:support_categories:categoryAddForm', 'form:supportcenter_categories:categoryAddForm',
  'form:main.faqs:supportcentersForm', 'role.cosmetic.create',
];
const file = z.object({field:name,file:z.string().min(1).max(400).optional(),
  mediaId:name.optional(),locale:z.string().regex(/^[a-z]{2,3}_[A-Z]{2,4}$/).optional()}).strict()
  .refine(item=>Boolean(item.file)!==Boolean(item.mediaId),'Choose a file or managed media ID');
const formStep = z.object({kind:z.literal('form'),key:name,workflowId:z.enum(workflows),
  fields:z.record(name,z.union([z.string().max(30000),z.number(),z.boolean(),z.array(z.string()).max(100)])).default({}),
  files:z.array(file).max(5).default([]), category:name.optional()}).strict();
const seoStep = z.object({kind:z.literal('seo'),key:name,title:name,suffix:name.optional(),
  description:z.string().max(500).optional(),favicon:z.object({file:z.string().min(1).max(400)}).strict().optional()}).strict();
const imageStep = z.object({kind:z.literal('image'),key:name,slug:z.string().max(120).regex(imageSlugPattern)}).strict();
const themeStep = z.object({kind:z.literal('theme'),key:name,theme:z.string().regex(/^[a-zA-Z0-9_-]{1,80}$/),
  path:z.string().min(1).max(500).regex(/\.tpl$/),expectedHash:z.string().regex(/^[a-f0-9]{64}$/),
  replacements:z.array(z.object({find:z.string().min(1).max(30000),replace:z.string().max(60000),
    count:z.number().int().min(1).max(100).default(1)}).strict()).min(1).max(20),
  homepageMarker:z.string().min(1).max(200)}).strict();
export const panelSetupBatchInput = {
  mode:z.enum(['preview','apply']).default('preview'),
  steps:z.array(z.discriminatedUnion('kind',[formStep,seoStep,imageStep,themeStep])).min(1).max(80),
};

const categoryFields = {
  'form:main.news:broadcastsForm':'category_id',
  'store.product.minecraft.create':'categoryID',
  'form:consultation_sections:categoryAddForm':'categoryID',
};

async function categoryId(panel,workflowId,field,category){
  const recipe=panel.recipes[workflowId];
  const page=await panel.navigate(recipe.pageId,recipe.open,recipe.pagePath);
  if(recipe.drawerId && !(await page.locator(recipe.form).count()))await panel.mountDrawer(recipe.drawerId);
  const select=page.locator(recipe.form).locator(`select[name="${field}"]`);
  await select.waitFor({state:'attached',timeout:5000});
  const matches=await select.evaluate((element,label)=>Array.from(element.options)
    .filter(option=>option.text.trim()===label).map(option=>option.value),category);
  if(matches.length!==1 || !/^[1-9]\d*$/.test(matches[0]))
    throw Error('Expected one existing category named '+category);
  return matches[0];
}

async function applyTheme(service,step){
  const {panel,sftp}=service;
  await sftp.prepareFromPanel(panel,{theme:step.theme});
  const saved=await sftp.patch({scope:'themes',path:step.path,expectedHash:step.expectedHash,replacements:step.replacements});
  try{
    await sftp.prepareFromPanel(panel,{theme:step.theme});
    const response=await panel.exclusive(async()=>{
      await panel.session();
      const origin=panel.origin();
      let target=new URL('/',origin);
      for(let attempt=0;attempt<4;attempt++){
        const response=await panel.context.request.get(target.href,{maxRedirects:0,timeout:10000});
        const location=response.headers().location;
        if(![301,302,303,307,308].includes(response.status())||!location)return response;
        const redirect=new URL(location,target);
        if(redirect.origin!==origin||redirect.username||redirect.password)return response;
        target=redirect;
      }
      throw Error('Too many homepage redirects');
    });
    if(!response.ok())return {acknowledged:true,backupId:saved.backupId,readback:'homepage_unavailable'};
    const finalPath=new URL(response.url()).pathname;
    if(finalPath!=='/'&&finalPath.replace(/\/$/,'')!==`/${panel.documentationLanguage}`)
      return {acknowledged:true,backupId:saved.backupId,readback:'homepage_redirected'};
    const html=await response.text();
    const verified=html.length<=8*1024*1024&&html.includes(step.homepageMarker);
    return {acknowledged:true,verified,backupId:saved.backupId,...(!verified?{readback:'homepage_marker_missing'}:{})};
  }catch{
    return {acknowledged:true,backupId:saved.backupId,readback:'sync_or_readback_incomplete'};
  }
}

function runBrowserStep(service,step,mode){
  const {panel}=service;
  return panel.exclusive(async()=>{
    try{
      if(step.kind==='image')return await panelImageLink(panel,step.slug);
      if(step.kind==='seo'){
        if(mode==='preview')return;
        await panel.navigate('panel:site:page:main.themes');
        return await applySeo(service,step);
      }
      if(mode==='preview'&&step.category)return;
      const fields={...step.fields};
      if(step.category){
        const field=categoryFields[step.workflowId];
        fields[field]=await categoryId(panel,step.workflowId,field,step.category);
      }
      return await panel.run({workflowId:step.workflowId,fields,files:step.files,mode});
    }finally{
      panel.allowWrites=false;
      panel.expectedPost=null;
      panel.expectedPostBody=null;
    }
  });
}

export function runPanelSetupBatch(service,{steps,mode}){
  if(new Set(steps.map(step=>step.key)).size!==steps.length)throw Error('Use unique step keys');
  for(const step of steps){
    const assets=step.kind==='form'?step.files:step.kind==='seo'&&step.favicon?[step.favicon]:[];
    for(const asset of assets)transferFile(service.config,service.store,asset);
    if(step.kind!=='form')continue;
    const recipe=service.panel.recipes[step.workflowId];
    if(!recipe||(recipe.audience??'admin')!=='admin')throw Error('Unavailable workflow: '+step.workflowId);
    const field=categoryFields[step.workflowId];
    if(step.category&&(!field||Object.hasOwn(step.fields,field)))throw Error('Use one category reference for '+step.key);
    if(step.workflowId==='form:main.news:broadcastsForm'&&!step.files.some(file=>file.field==='image'))
      throw Error('A cover image is required for '+step.key);
  }
  const work=async id=>{
    const results=[];
    for(const step of steps){
      try{
        const saved=step.kind==='theme'
          ? (mode==='apply'?await applyTheme(service,step):undefined)
          : await runBrowserStep(service,step,mode);
        const state=saved?.verified?'verified':mode==='preview'?(saved?'ready':'pending'):saved?.acknowledged?'acknowledged':'unverified';
        const result={key:step.key,state};
        if(saved?.record?.id??saved?.id)result.id=saved.record?.id??saved.id;
        const url=saved?.image?.url??saved?.url??saved?.favicon;
        if(url)result.url=url;
        if(saved?.backupId)result.backupId=saved.backupId;
        if(saved?.readback)result.readback=saved.readback;
        results.push(result);
        if(id)service.progress(id,results.length);
      }catch(error){
        const failure={step:step.key,error:String(error.message).split('\n')[0].slice(0,250)};
        const report={done:false,results,failure};
        if(id)throw Object.assign(Error(failure.error),{result:report});
        return report;
      }
    }
    return {done:true,results};
  };
  return mode==='apply'?service.enqueue('panel.setup.batch',{steps,mode},steps.length,work):work();
}
