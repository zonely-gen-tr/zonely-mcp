const operation = 'addons-addonsupdatecontroller';

async function addonState(page, addon) {
  return page.evaluate(async key => {
    const selector = '#addonsEditForm .zn-addon-row[data-addon-key="'+key+'"]';
    let item = document.querySelector(selector);
    if (!item) {
       
       
      const response = await fetch(location.href,{credentials:'same-origin',signal:AbortSignal.timeout(10000)});
      if (!response.ok || new URL(response.url).origin !== location.origin) return null;
      const markup = await response.text();
      item = new DOMParser().parseFromString(markup,'text/html').querySelector(selector);
    }
    if (!item) return null;
    return {installed:item.dataset.installed==='1', type:item.dataset.addonType,
      category:item.dataset.category, title:item.dataset.title};
  }, addon);
}

export async function enablePanelAddon(panel, {recipe, fields, files, envFields, mode, recordId, recordContext}) {
  const addon = fields.addon;
  if (typeof addon !== 'string' || !/^[a-z][a-zA-Z0-9_]{0,63}$/.test(addon) || Object.keys(fields).length !== 1 ||
      files.length || envFields.length || recordId !== undefined || Object.keys(recordContext).length) {
    throw Error('Supply one built-in addon key in fields.addon');
  }
  if (!['preview', 'apply'].includes(mode)) throw Error('Choose preview or apply');
  const page = await panel.navigate(recipe.pageId);
  const current = await addonState(page, addon);
  if (current?.type !== 'toggle' || ['spintowin','choosetowin'].includes(addon)) {
    throw Error('Select a built-in addon that uses the standard installation dialog');
  }
  if (mode === 'preview' || current.installed) {
    return {ready:true, mode, addon, installed:current.installed, submitted:false, verified:current.installed};
  }
  if (current.category === 'marketing') {
    await page.locator('#znAddonsTabs [data-bs-target="#znAddonsMarketingPane"]').click();
  } else {
    await page.locator('#znAddonsSearchInput').fill(current.title || addon);
  }
  const install = page.locator('.js-addon-install[data-addon-key="'+addon+'"]:visible');
  await install.click();
  const dialog = page.locator('#znAddonViewModal[data-addon-key="'+addon+'"]');
  const button = dialog.locator('#znAddonViewInstallBtn');
  await button.waitFor({state:'visible'});

  const endpoint = panel.catalog.find(item => item.id === operation);
  if (!endpoint) throw Error('The addon update route is unavailable');
  const target = new URL(endpoint.path, panel.origin());
  for (const [key, value] of Object.entries(endpoint.routing)) target.searchParams.set(key, String(value));
  let submitted;
  panel.addonWrite = request => {
    if (submitted || request.method() !== 'POST' || new URL(request.url()).href !== target.href ||
        !/^application\/json(?:;|$)/i.test(request.headers()['content-type']??'')) return false;
    const body = request.postDataBuffer();
    if (!body || body.length > 64 * 1024) return false;
    try {
      if (JSON.parse(body)[addon] !== 1) return false;
    } catch { return false; }
    submitted = request;
    return true;
  };
  const pending = page.waitForResponse(response => response.request() === submitted, {timeout:15000}).catch(() => null);
  try {
    await button.click();
    const response = await pending;
    if (!response) throw Error('Addon installation outcome is unknown; read its status before retrying');
    const result = await response.json();
    if (!response.ok() || result?.error || result?.status === 'error' ||
        !(result?.status === 'success' || result?.success === true || result?.ok === true)) {
      throw Error('The panel rejected addon installation');
    }
  } finally {
    panel.addonWrite = null;
  }
  const reloaded = await panel.navigate(recipe.pageId);
  if (!(await addonState(reloaded, addon))?.installed) throw Error('The panel did not show the addon installed after reload');
  panel.store.audit('panel.execute', operation, {addon, verified:true});
  return {addon, installed:true, submitted:true, verified:true, operation};
}
