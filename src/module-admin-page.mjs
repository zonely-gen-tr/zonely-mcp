import {readCatalog} from './panel-route.mjs';

const routeFiltersPage = 'panel:site:page:main.routefilters';
const adminPath = /^\/admin\/[a-z0-9_-]+(?:\/[a-z0-9_-]+)*\/?$/i;

export async function checkModuleAdminRoute(panel, moduleId) {
  const page = await panel.navigate(routeFiltersPage);
  await page.locator('[data-route-admin][data-ready="1"]').waitFor({state:'attached',timeout:15000});
  const {routes} = await readCatalog(page, panel.origin());
  const paths = ['/admin/addons/'+moduleId, '/admin/'+moduleId];
  for (const canonical of paths) {
    const route = routes.find(item => item.scope === 'admin' && item.kind !== 'redirect' &&
      item.canonical === canonical && item.parameters?.length === 0);
    if (route && adminPath.test(route.path)) return {stage:'route_registered',canonical,path:route.path};
  }
  return {stage:'admin_route_missing',expectedRoutes:paths,
    message:'Register a dedicated admin route before installing or placing the module sidebar item.'};
}

export async function verifyModuleAdminPage(panel, route, {contentId,sidebarLabel,tableId}) {
  const page = await panel.session();
  const origin = panel.origin();
  const response = await page.goto(origin+route.path,{waitUntil:'domcontentloaded',timeout:15000});
  if (!response?.ok() || new URL(page.url()).origin !== origin || new URL(page.url()).pathname !== route.path)
    return {...route,stage:'admin_page_unavailable',verified:false};
  const marker = page.locator('#'+contentId);
  await marker.waitFor({state:'visible',timeout:5000}).catch(()=>{});
  if (tableId) await page.waitForFunction(id => {
    const table = document.getElementById(id);
    return !!table && !!window.jQuery?.fn?.DataTable?.isDataTable?.(table);
  },tableId,{timeout:5000}).catch(()=>{});
  const result = await page.evaluate(({contentId,sidebarLabel,tableId,paths})=>{
    const content = document.getElementById(contentId);
    const contentVisible = !!content?.getClientRects().length &&
      getComputedStyle(content).visibility !== 'hidden';
    const link = [...document.querySelectorAll('#zonely_aside a[href], #zonely_aside_wordspace a[href]')].find(a=>
      a.origin === location.origin && paths.includes(a.pathname) &&
      a.textContent.trim().replace(/\s+/g,' ') === sidebarLabel);
    const table = tableId && document.getElementById(tableId);
    const dataTableReady = tableId ? !!table && !!window.jQuery?.fn?.DataTable?.isDataTable?.(table) : null;
    return {contentVisible,sidebarLinked:!!link,dataTableReady};
  },{contentId,sidebarLabel,tableId,paths:[route.path,route.canonical]});
  const verified = result.contentVisible && result.sidebarLinked && result.dataTableReady !== false;
  return {...route,...result,stage:verified?'admin_page_verified':'admin_integration_incomplete',verified};
}

export function checkModuleAdminPage(panel,{moduleId,adminPage}) {
  return panel.exclusive(async()=>{
    const route = await checkModuleAdminRoute(panel,moduleId);
    if (!adminPage || route.stage !== 'route_registered') return {...route,verified:false};
    return verifyModuleAdminPage(panel,route,adminPage);
  });
}
