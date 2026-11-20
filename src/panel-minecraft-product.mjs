export const minecraftProductRecipe = {
  title: 'Mağaza → Oyun içi ürün ekle',
  pageId: 'panel:site:page:main.shop',
  open: ['#drawer_products_add_button'],
  form: '#productsForm',
  operationId: 'products-productsaddcontroller',
  minecraftProduct: true,
  documentation: ['/guides/products', '/guides/products/delivery-commands-and-gui'],
  fields: [
    {name:'categoryID',type:'select',required:true},
    {name:'name',type:'text'},
    {name:'price',type:'number'},
    {name:'details',type:'textarea'},
    {name:'stock',type:'number'},
    {name:'image',type:'file'},
    {name:'tiers',type:'json',description:'Alternative to name and price. An array of tier objects with name, price, details and optional stock.'},
    {name:'comparison',type:'json',description:'Comparison rows with name, optional description, and values in tier order.'},
  ],
};

function readList(value) {
  if (value===undefined) return [];
  const list=JSON.parse(value);
  if (!Array.isArray(list)) throw Error('Expected a JSON array.');
  return list;
}

export function planMinecraftProduct(fields, files) {
  const {categoryID,name,price,details,stock,tiers:tiersInput,comparison:comparisonInput}=fields;
  const allowed=['categoryID','name','price','details','stock','tiers','comparison'];
  const tiers=tiersInput===undefined?[{name,price,details,stock}]:readList(tiersInput);
  const comparison=readList(comparisonInput);
  const uniqueNames=new Set(tiers.map(tier=>tier?.name?.trim?.()));
  if (Object.keys(fields).some(field=>!allowed.includes(field)) ||
      !Number.isSafeInteger(Number(categoryID)) || Number(categoryID)<1 ||
      !tiers.length || tiers.length>10 || uniqueNames.size!==tiers.length ||
      tiers.some(tier=>!tier || typeof tier.name!=='string' || !tier.name.trim() ||
        !['number','string'].includes(typeof tier.price) || String(tier.price).trim()==='' ||
        !Number.isFinite(Number(tier.price)) || Number(tier.price)<0 ||
        (tier.stock!==undefined && (!Number.isSafeInteger(Number(tier.stock)) || Number(tier.stock)<1))) ||
      (tiersInput!==undefined && [name,price,details,stock].some(value=>value!==undefined)) ||
      (comparison.length>0 && tiers.length<2) ||
      new Set(comparison.map(row=>row?.name?.trim?.())).size!==comparison.length ||
      comparison.some(row=>!row || typeof row.name!=='string' || !row.name.trim() ||
        ['__proto__','constructor','prototype'].includes(row.name.trim()) ||
        (row.description!==undefined && typeof row.description!=='string') ||
        !Array.isArray(row.values) || row.values.length!==tiers.length ||
        row.values.some(value=>!['string','number','boolean'].includes(typeof value))) ||
      new Set(files.map(file=>file.field)).size!==files.length ||
      files.some(file=>file.field!=='image' && !tiers.some((_,i)=>file.field===`image${i+1}`)) ||
      (files.some(file=>file.field==='image') && files.some(file=>file.field==='image1'))) {
    throw Error('Supply a category and either one named product with a price or named tiers with prices and matching comparison values.');
  }
  const values={categoryID:String(categoryID),maintype:'1'};
  const offers=tiers.map((tier,i)=>{
    const prefix=`products[${i}]`;
    values[`${prefix}[name]`]=tier.name.trim();
    values[`${prefix}[price]`]=Number(tier.price);
    if (tier.details!==undefined) values[`${prefix}[details]`]=String(tier.details);
    if (tier.stock!==undefined) {
      values[`${prefix}[stock_type]`]='limited';
      values[`${prefix}[stock]`]=Number(tier.stock);
    }
    return {name:tier.name.trim(),price:Number(tier.price)};
  });
  const table=comparison.map(row=>({
    name:row.name.trim(),description:(row.description??'').trim(),values:row.values.map(String),
  }));
  return {
    fields:values,
    files:files.map(file=>({...file,field:`products[${file.field==='image'?0:Number(file.field.slice(5))-1}][image]`})),
    product:{categoryID:String(categoryID),offers,table},
  };
}

export async function prepareMinecraftProduct(page, count) {
  await page.waitForFunction(()=>typeof window.zonelyActivateMainShopProductType==='function' &&
    typeof window.zonelyBootMinecraftAddBuilder==='function',{},{timeout:8000});
  await page.evaluate(()=>{
    window.zonelyActivateMainShopProductType('minecraft');
    window.zonelyBootMinecraftAddBuilder();
  });
  const form=page.locator('#productsForm');
  for(let i=0;i<count;i++){
    const row=form.locator(`[name="products[${i}][name]"]`);
    if(!(await row.count())) await form.locator('#addProduct').click();
    await row.waitFor({state:'attached',timeout:5000});
  }
  if (await form.locator('#sortableProducts [name$="[name]"]').count()!==count)
    throw Error('The product form did not create the requested tier rows.');
}

export async function checkMinecraftProduct(form, product) {
  const failure=await form.evaluate((element,expected)=>{
    if(expected.table.length){
      const table=JSON.stringify(expected.table.map(row=>({
        ...row,values:Object.fromEntries(row.values.entries()),
      })));
      element.addEventListener('formdata',event=>{
        event.formData.set('comparisonFeatures',table);
      });
    }
    window.ZonelyProductFormLifecycle?.sync(element);
    for (const control of element.elements) {
      if (control.type==='file' && control.files?.length===0) control.disabled=true;
    }
    const data=new FormData(element);
    const savedTable=JSON.parse(data.get('comparisonFeatures')||'[]');
    if(data.get('productType')!=='minecraft' || data.get('maintype')!=='1' ||
      data.get('categoryID')!==expected.categoryID) return 'The panel selected a different product type or category.';
    if(!expected.offers.every(({name,price},i)=>{
      const actual=data.get(`products[${i}][price]`);
      return data.get(`products[${i}][name]`)===name && typeof actual==='string' && actual!=='' && Number(actual)===price;
    }))return 'The panel did not serialize all tier names and prices.';
    if(savedTable.length!==expected.table.length || !expected.table.every((row,i)=>
        savedTable[i].name===row.name && savedTable[i].description===row.description &&
        row.values.every((value,j)=>savedTable[i].values[j]===value)))
      return 'The panel did not serialize all comparison cells.';
    return null;
  },product);
  if (failure) throw Error(failure);
}

export async function findMinecraftProduct(page, origin, desired) {
  const url=new URL('/Files/Controllers/ControllersAll.php',origin);
  url.search=new URLSearchParams({
    main:'Products',container:'ProductsListController',search:'Oyun İçi Ürün',start:'0',length:'80',
  });
  try {
    const response=await page.request.get(url.href,{
      maxRedirects:0,timeout:8000,
      headers:{'X-Requested-With':'XMLHttpRequest',Referer:origin+'/admin/shop','Cache-Control':'no-cache'},
    });
    let text;
    try {
      if (!response.ok() || Number(response.headers()['content-length']??0)>2*1024*1024) return null;
      text=await response.text();
    } finally { await response.dispose(); }
    if (text.length>2*1024*1024) return null;
    const {data}=JSON.parse(text);
    if (!Array.isArray(data)) return null;
    const matches=[];
    for (const row of data) {
      if (row.productType!=='minecraft' || Number(row.gametype)!==1 ||
          Number(row.categoryID)!==Number(desired.categoryID)) continue;
      let items;
      try { items=Array.isArray(row.plugin_data)?row.plugin_data:JSON.parse(row.plugin_data); }
      catch { continue; }
      if (!Array.isArray(items)) continue;
      const id=Number(row.productid??row.id);
      if(!Number.isSafeInteger(id)||id<=0||!items.some(item=>desired.offers.some(offer=>offer.name===item?.name))) continue;
      const offers=items.map(item=>({name:item.name,price:Number(item.price),image:Boolean(item.image)}));
      let table;
      try { table=Array.isArray(row.plugin_features)?row.plugin_features:JSON.parse(row.plugin_features??'[]'); }
      catch { table=[]; }
      const identical=offers.length===desired.offers.length && desired.offers.every((offer,i)=>
        offer.name===offers[i].name && offer.price===offers[i].price) &&
        Array.isArray(table) && table.length===desired.table.length && desired.table.every((feature,i)=>
          feature.name===table[i]?.name && feature.description===(table[i]?.description??'') &&
          feature.values.every((value,j)=>value===String(table[i]?.values?.[j]??'')));
      matches.push({identical, record:{id,categoryID:Number(row.categoryID),type:'minecraft',
        ...(offers.length===1?offers[0]:{tiers:offers,comparisonRows:table?.length??0})}});
    }
    return matches;
  } catch { return null; }
}

export function minecraftProductRejection(result) {
  const message=String(result?.message??result?.error??'').trim();
  if (message && message.length<=180 && /^[\p{L}\p{N}\s.,:;!?%+'’()_-]+$/u.test(message) &&
      !/password|passwd|secret|token|api.?key|authorization|csrf/i.test(message)) {
    return message;
  }
  return 'The panel rejected the game product. Check the category and required form fields.';
}
