import fs from 'node:fs';
import path from 'node:path';
import {transferFile} from './connection.mjs';
import {checkModuleAdminRoute,verifyModuleAdminPage} from './module-admin-page.mjs';

const zipLimit=30*1024*1024;

export function installModule(service,{file,theme,moduleId,mode,adminPage}){
  const {panel}=service;
  const filename=transferFile(service.config,service.store,{file});
  if(path.extname(filename).toLowerCase()!=='.zip'||fs.statSync(filename).size>zipLimit)
    throw Error('Choose a module ZIP of up to 30 MiB');
  const archive=fs.readFileSync(filename);
  if(archive.length<22||archive.readUInt32LE(0)!==0x04034b50)
    throw Error('The file does not contain a module ZIP archive');

  return panel.exclusive(async()=>{
    const adminRoute=adminPage ? await checkModuleAdminRoute(panel,moduleId) : null;
    if(adminRoute?.stage==='admin_route_missing')
      return {stage:adminRoute.stage,moduleId,theme,submitted:false,admin:adminRoute};
    const page=await panel.navigate('panel:site:page:main.templates');
    const origin=panel.origin();
    const endpoint=id=>{
      const operation=service.catalog.find(item=>item.id===id);
      const url=new URL(operation?.endpoint??'',origin);
      if(!operation||url.origin!==origin)throw Error('The registered module endpoint is unavailable');
      return url.href;
    };
    const workspaceEndpoint=container=>new URL(`/Files/Controllers/ControllersAll.php?main=Workspace&container=${container}`,origin).href;
    const workspaceList=workspaceEndpoint('WorkspaceModulesListController');
    const legacyList=endpoint('templates-templatesmoduleslistcontroller');
    const readList=async url=>{
      const response=await panel.context.request.get(url,{maxRedirects:0,timeout:10000});
      const data=await response.json().catch(()=>null);
      return {httpStatus:response.status(),modules:response.ok()&&Array.isArray(data?.modules)?data.modules:null};
    };
    const workspace=await readList(workspaceList);
    const useWorkspace=Array.isArray(workspace.modules);
    if(!useWorkspace&&![404,405].includes(workspace.httpStatus))
      return {stage:'workspace_unavailable',moduleId,theme,httpStatus:workspace.httpStatus,installed:null};
    const engine=useWorkspace?'workspace':'templates';
    const listUrl=useWorkspace?workspaceList:legacyList;
    const initial=useWorkspace?workspace:await readList(legacyList);
    if(!initial.modules)throw Error('The site did not return its installed module list');
    const find=modules=>modules.find(item=>item.id===moduleId||item.module_id===moduleId);
    const before=find(initial.modules);
    const adminResult=async()=>adminRoute ? {
      admin:await verifyModuleAdminPage(panel,adminRoute,adminPage).catch(()=>({
        ...adminRoute,stage:'admin_verification_unavailable',verified:false}))
    } : {};
    if(mode==='preview')return {stage:'preview',engine,moduleId,theme,existing:!!before,bytes:archive.length,serverValidation:'pending',
      ...(adminRoute?{admin:adminRoute}:{})};
    if(before)return {stage:'already_installed',engine,moduleId,theme,installed:true,applied:before.applied===true,
      ...await adminResult()};
    if(useWorkspace){
      const catalog=await readList(legacyList);
      if(catalog.modules&&find(catalog.modules))return {stage:'module_id_conflict',engine,moduleId,theme,installed:false};
    }

    const token=await page.evaluate(()=>document.querySelector('meta[name="csrf-token"]')?.content||
      document.querySelector('input[name="csrf-token"]')?.value||'');
    const zip={name:path.basename(filename),mimeType:'application/zip',buffer:archive};
    const response=await panel.context.request.post(useWorkspace?workspaceEndpoint('WorkspaceModuleUploadController'):endpoint('templates-templatesmodulesuploadcontroller'),{
      maxRedirects:0,timeout:35000,
      headers:{'X-Requested-With':'XMLHttpRequest',...(token?{'X-CSRF-Token':token}:{})},
      multipart:{...(useWorkspace?{module_zip:zip,apply:'1'}:{archive:zip,domain:new URL(origin).hostname,visibility:'hidden'}),
        theme,...(token?{'csrf-token':token}:{})}
    }).catch(()=>null);
    const outcome=await response?.json().catch(()=>null);
    let installed;
    try{const result=await readList(listUrl);if(!result.modules)throw Error('Module readback unavailable');installed=find(result.modules);}
    catch{return {stage:'readback_unavailable',engine,moduleId,theme,installed:null,applied:null,
      ...(response?{httpStatus:response.status()}:{}),message:'Check installed modules before retrying the upload'};}
    const message=typeof outcome?.message==='string'?outcome.message.slice(0,240):undefined;
    const applyStatus=outcome?.apply?.status;
    let stage=installed?'installed':outcome?.status==='success'?'readback_missing':response?'upload_rejected':'outcome_unknown';
    if(installed&&['error','partial'].includes(applyStatus))stage='apply_incomplete';
    if(!installed&&/bad_extension|pattern_match_php_tag/i.test(message??''))stage='upload_admission_rejected';
    if(!installed&&/cloud module upload|bulut modülü yüklenemedi/i.test(message??''))stage='cloud_upload_failed';
    const applyErrors=Array.isArray(outcome?.apply?.errors)?outcome.apply.errors.slice(0,5)
      .map(error=>typeof error==='string'?error:error?.message).filter(error=>typeof error==='string').map(error=>error.slice(0,240)):[];
    return {stage,engine,moduleId,theme,installed:!!installed,applied:installed?.applied===true&&stage!=='apply_incomplete',
      ...(typeof applyStatus==='string'?{applyStatus}:{}),
      ...(installed?.applied===true&&stage!=='apply_incomplete'?await adminResult():{}),
      ...(applyErrors.length?{applyErrors}:{}),
      ...(response?{httpStatus:response.status()}:{}),...(message?{message}:{})};
  });
}
