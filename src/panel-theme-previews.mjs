import { randomUUID } from 'node:crypto';
import { chromium } from 'playwright';

const views = ['light', 'dark'];
const themePage = 'panel:site:page:main.selector-theme';
const uploadLimit = 8 * 1024 * 1024;

function endpoint(origin, controller) {
  return new URL(`/Files/Controllers/ControllersAll.php?main=Workspace&container=Workspace${controller}Controller`, origin);
}

const requestHeaders = { Accept: 'application/json', 'X-Requested-With': 'XMLHttpRequest' };

async function readWorkspace(page, url) {
  const response = await page.request.get(url.href, { headers:requestHeaders, maxRedirects:0, timeout:12000 });
  const payload = await response.json().catch(() => null);
  if (!response.ok() || payload?.status !== 'success') throw Error('The Themes panel did not return verified data.');
  return payload;
}

function activeOwnedTheme(payload, id) {
  const candidate = payload.themes?.find(theme => theme.id === id);
  if (!candidate?.active || !candidate.canManage || !candidate.domainScoped || candidate.isPublic || candidate.marketplace?.public) {
    throw Error('Select the active private theme owned by this site.');
  }
  if (views.some(mode => candidate.supports?.[mode] === false)) throw Error('The active theme must support both light and dark.');
  return candidate;
}

async function captureHome(browser, origin, theme, mode) {
  const context = await browser.newContext({ viewport:{width:1440,height:1100}, deviceScaleFactor:1, colorScheme:mode, serviceWorkers:'block' });
  try {
    await context.addCookies([{ name:'theme', value:mode, url:origin }]);
    const page = await context.newPage();
    await context.route('**/*', route => {
      const request = route.request();
      const url = new URL(request.url());
      const homepage = request.isNavigationRequest() && request.frame() === page.mainFrame();
      const readable = ['GET','HEAD'].includes(request.method()) && ['http:','https:'].includes(url.protocol);
      return readable && (!homepage || url.origin === origin) ? route.continue() : route.abort();
    });
    const response = await page.goto(origin + '/', { waitUntil:'domcontentloaded', timeout:20000 });
    if (!response?.ok() || new URL(page.url()).pathname !== '/') throw Error('The public homepage is unavailable.');
    await page.waitForFunction(({ theme, mode }) => {
      const html = document.documentElement;
      return (html.dataset.zonelyTheme === theme || html.dataset.themeName === theme) &&
        (html.dataset.theme === 'dark' || html.dataset.bsTheme === 'dark' ? 'dark' : 'light') === mode;
    }, { theme, mode }, { timeout:9000 }).catch(() => { throw Error(`The homepage did not render the selected theme in ${mode} mode.`); });
    await page.waitForLoadState('load', { timeout:8000 }).catch(() => {});
    const image = await page.screenshot({ type:'jpeg', quality:85, animations:'disabled', timeout:12000 });
    if (image.length === 0 || image.length > uploadLimit) throw Error(`The ${mode} screenshot exceeds the preview upload limit.`);
    return image;
  } finally { await context.close(); }
}

async function formValues(page, theme) {
  const card = page.locator(`article.theme-card[data-theme-id=${JSON.stringify(theme)}]`);
  await card.locator('button.theme-owner-edit').click({ timeout:10000 });
  return page.locator('#themeMarketplaceEditForm').evaluate((form, id) => {
    const fields = new FormData(form);
    if (fields.get('theme') !== id || fields.has('public')) throw Error('The private theme edit form did not match the requested theme.');
    const replaced = new Set(['preview_light','preview_dark','preview_light_remove','preview_dark_remove','market_action','csrf_token','csrf-token']);
    return [...fields].filter(([name, value]) => typeof value === 'string' && !replaced.has(name));
  }, theme);
}

async function verifyImages(page, origin, saved, images) {
  const checked = await Promise.all(views.map(async mode => {
    const value = saved[mode === 'light' ? 'previewLight' : 'previewDark'];
    if (typeof value !== 'string' || !value) return [mode, false];
    const url = new URL(value, origin);
    if (url.origin !== origin) return [mode, false];
    url.searchParams.set('_zonely_preview_check', randomUUID());
    const response = await page.request.get(url.href, { maxRedirects:0, timeout:12000 }).catch(() => null);
    return [mode, Boolean(response?.ok() && response.headers()['content-type']?.startsWith('image/') && (await response.body()).equals(images[mode]))];
  }));
  return Object.fromEntries(checked);
}

export function captureThemePreviews(panel, { theme, mode }) {
  return panel.exclusive(async () => {
    const page = await panel.navigate(themePage);
    const origin = panel.origin();
    const list = endpoint(origin, 'ThemesList');
    const selected = activeOwnedTheme(await readWorkspace(page, list), theme);
    const browser = await chromium.launch({ channel:panel.profile.panel?.channel });
    const images = {};
    try {
      for (const view of views) images[view] = await captureHome(browser, origin, theme, view);
    } finally { await browser.close(); }
    const captured = Object.fromEntries(views.map(view => [view, images[view].length]));
    if (mode === 'preview') return { theme, active:true, captured, submitted:false };

    activeOwnedTheme(await readWorkspace(page, list), selected.id);
    const fields = await formValues(page, selected.id);
    const bootstrap = endpoint(origin, 'Bootstrap');
    bootstrap.searchParams.set('scope', 'templates');
    const { csrf } = await readWorkspace(page, bootstrap);
    if (typeof csrf !== 'string' || !csrf || csrf.length > 1000) throw Error('The Themes panel could not verify the session.');
    const multipart = new FormData();
    for (const [key, value] of fields) multipart.append(key, value);
    multipart.set('market_action', 'update');
    multipart.set('csrf_token', csrf);
    multipart.set('csrf-token', csrf);
    for (const view of views) multipart.set(`preview_${view}`, new Blob([images[view]], { type:'image/jpeg' }), `preview-${view}.jpg`);
    const response = await page.request.post(list.href, { multipart, headers:{...requestHeaders,'X-CSRF-Token':csrf}, maxRedirects:0, timeout:25000 }).catch(() => null);
    const result = await response?.json().catch(() => null);
    const saved = activeOwnedTheme(await readWorkspace(page, list), theme);
    const updated = await verifyImages(page, origin, saved, images);
    const verified = views.every(view => updated[view]);
    return { theme, active:true, captured, submitted:Boolean(response), updated, verified,
      status:verified ? 'saved' : response && (!response.ok() || result?.status !== 'success') ? 'rejected' : 'unconfirmed' };
  });
}
