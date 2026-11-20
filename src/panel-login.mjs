import {isCustomerLogin} from './panel-authentication.mjs';

export function needsLogin(url, origin, target, status) {
  const received = new URL(url);
  if (received.origin !== origin) return false;
  if (isCustomerLogin(url, origin) || status === 401) return true;
  return /^\/404\/?$/.test(received.pathname) && received.searchParams.get('next') === target;
}

export function isLoginPost(request, origin) {
  const url = new URL(request.url());
  return request.method() === 'POST' && url.origin === origin &&
    url.pathname === '/Files/Controllers/ControllersAll.php' &&
    url.searchParams.getAll('main').length === 1 && url.searchParams.getAll('container').length === 1 &&
    ((url.searchParams.get('main') === 'Login' && url.searchParams.get('container') === 'LoginAddController') ||
      (url.searchParams.get('main') === '2FA' && ['2FAController','2FARecoverController','2FAEmailController'].includes(url.searchParams.get('container'))));
}

export async function checkPanelLogin(panel, context) {
  if (panel.context !== context || !panel.interactive || !panel.loginTarget) return;
  const origin = panel.origin();
   
  const protectedPath = panel.audience === 'admin' ? '/admin' : '/profile';
  const target = new URL(panel.loginTarget, origin);
  if(target.origin!==origin || (target.pathname!==protectedPath&&!target.pathname.startsWith(protectedPath+'/')))return;
  const response = await context.request.get(target.href, {timeout: 6000, maxRedirects: 0});
  let authenticated=response.ok();
  const destination=response.headers().location;
  if(response.status()>=300&&response.status()<400&&destination){
    const next=new URL(destination, origin);
    if(next.origin===origin&&(next.pathname===protectedPath||next.pathname.startsWith(protectedPath+'/')))
      authenticated=(await context.request.get(next.href,{timeout:6000,maxRedirects:0})).ok();
  }
  if (authenticated && panel.context === context && panel.loginTarget) {
    const cookies = await context.cookies(origin);
    if (panel.context !== context || !panel.loginTarget) return;
    panel.loginCookies = cookies;
    panel.loginTarget = null;
    await panel.closeBrowser();
  }
}
