import {request} from 'playwright';

export const imageSlugPattern = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

export async function panelImageLink(panel, slug) {
  if (typeof slug !== 'string' || slug.length > 120 || !imageSlugPattern.test(slug))
    throw Error('Supply the exact image slug from Image Management');
  const page = await panel.navigate('panel:site:page:main.images');
  await page.waitForFunction(() => window.jQuery?.fn?.dataTable?.isDataTable('#imagesTable'));
  const selected = await page.evaluate(async slug => {
    const tableElement = window.jQuery('#imagesTable');
    const table = tableElement.DataTable();
    const input = document.getElementById('imagesSearch');
    if (!input) throw Error('Image Management search is unavailable');
    const draw = new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        tableElement.off('draw.dt.zonelyImageLink', afterDraw);
        reject(Error('Image Management search did not finish'));
      }, 12000);
      function afterDraw() {
        clearTimeout(timer);
        resolve();
      }
      tableElement.one('draw.dt.zonelyImageLink', afterDraw);
    });
    input.value = slug;
    table.search(slug).draw();
    await draw;
    const info = table.page.info();
    if (!Number.isInteger(info.recordsDisplay) || info.recordsDisplay > info.length)
      return {ambiguous:true};
    const matches = [];
    table.rows({page:'current'}).every(function () {
      const item = this.data();
      const filename = String(item?.file_name ?? '');
      const fileSlug = filename.replace(/\.[a-z0-9]+$/i, '');
      if ((item?.slug || fileSlug) !== slug) return;
      const link = this.node()?.querySelector('a:has(img.image-library-thumb)');
      matches.push({id:Number(item.id), name:String(item.name ?? filename).slice(0,255),
        url:item.image_url ?? null, href:link?.getAttribute('href') ?? null});
    });
    return {matches};
  }, slug).catch(() => { throw Error('Could not read the Image Management table'); });
  if (selected.ambiguous || selected.matches.length > 1) throw Error('Image Management returned an ambiguous match');
  if (selected.matches.length !== 1) throw Error('Image was not found in Image Management');
  const row = selected.matches[0];
  if (!Number.isSafeInteger(row.id) || row.id <= 0 || !row.url || !row.href)
    throw Error('Image Management did not provide a published link');
  const origin = panel.origin();
  const url = new URL(row.url, origin);
  if (url.origin !== origin || url.username || url.password || url.hash ||
      new URL(row.href, origin).href !== url.href)
    throw Error('Image Management returned an unexpected link');
  const visitor = await request.newContext();
  try {
    const response = await visitor.head(url.href, {timeout:10000, maxRedirects:0});
    if (!response.ok() || !/^image\//i.test(response.headers()['content-type'] ?? ''))
      throw Error('The published image could not be verified');
  } catch {
    throw Error('The published image could not be verified');
  } finally {
    await visitor.dispose();
  }
  return {id:row.id, name:row.name, slug, url:url.href, verified:true};
}
