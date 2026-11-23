import {request} from 'playwright';

export const imageSlugPattern = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

export async function panelImageLink(panel, slug) {
  if (typeof slug !== 'string' || slug.length > 120 || !imageSlugPattern.test(slug))
    throw Error('Supply the exact image slug from Image Management');
  const page = await panel.navigate('panel:site:page:main.images');
  const search = page.locator('#imagesSearch');
  await search.waitFor({state:'attached',timeout:8000});
  await search.evaluate((element,value)=>{
    element.value=value;
    element.dispatchEvent(new Event('input',{bubbles:true}));
    element.dispatchEvent(new Event('keyup',{bubbles:true}));
  },slug);
  const rendered = await page.waitForFunction(slug=>{
    const rows=document.querySelectorAll('#imagesTable tbody tr');
    const matches=[];
    for(const row of rows){
      const links=[...row.querySelectorAll('a[href]')].filter(link=>{
        const url=new URL(link.href,location.href);
        return url.origin===location.origin && url.pathname.startsWith('/Files/Assets/img/uploads/') &&
          url.pathname.split('/').at(-1)?.replace(/\.[a-z0-9]+$/i,'')===slug;
      });
      if(!links.length)continue;
      const urls=[...new Set(links.map(link=>link.href))];
      const thumbnail=links.find(link=>link.querySelector('img'));
      const id=Number(row.dataset.id??row.querySelector('input[type="checkbox"]')?.value);
      const name=thumbnail?.querySelector('img')?.alt || thumbnail?.title || slug;
      matches.push({id:Number.isSafeInteger(id)&&id>0?id:null,name:name.slice(0,255),urls});
    }
    return matches.length?matches:false;
  },slug,{timeout:12000}).catch(()=>{throw Error('Image was not found in the rendered Image Management table');});
  const matches=await rendered.jsonValue();
  if(matches.length!==1||matches[0].urls.length!==1)throw Error('Image Management returned an ambiguous match');
  const row=matches[0];
  const origin = panel.origin();
  const url = new URL(row.urls[0]);
  if (url.origin !== origin || url.username || url.password || url.hash)
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
  return {...(row.id===null?{}:{id:row.id}), name:row.name, slug, url:url.href, verified:true};
}
