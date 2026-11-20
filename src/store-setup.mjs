import * as z from 'zod/v4';
import {transferFile} from './connection.mjs';
import {mediaCredit} from './remote-media.mjs';

const name=z.string().trim().min(1).max(150);
const text=z.string().trim().min(1).max(8000);
const image=z.union([
  z.object({file:z.string().min(1).max(400)}).strict(),
  z.object({mediaId:z.string().min(1).max(100),locale:z.string().regex(/^[a-z]{2,3}_[A-Z]{2,4}$/).optional()}).strict(),
  z.object({url:z.string().url().max(2000),source:z.string().url().max(2000),author:z.string().min(1).max(200),license:z.string().min(1).max(100),licenseUrl:z.string().url().max(1000).optional(),pixelArt:z.boolean().default(false),locale:z.string().regex(/^[a-z]{2,3}_[A-Z]{2,4}$/).optional()}).strict()
]);
export const storeSetupInput={
  mode:z.enum(['preview','apply']).default('preview'),
  background:z.boolean().default(false),
  categories:z.array(z.object({name,parent:name.optional(),description:text,image}).strict()).min(1).max(20),
  products:z.array(z.object({name,category:name,description:text,
    price:z.number().int().min(0).max(10000000),image}).strict()).max(40).default([])
};
const key=value=>String(value??'').trim().normalize('NFC').toLocaleLowerCase('tr');
function validatePlan(categories,products){
  const ordered=[];
  const seen=new Set();
  for(const category of categories){
    const categoryKey=key(category.name);
    if(seen.has(categoryKey))throw Error('Duplicate category in plan: '+category.name);
    if(category.parent&&!seen.has(key(category.parent)))throw Error('List the parent category before '+category.name);
    seen.add(categoryKey);
    ordered.push(category);
  }
  const productKeys=new Set();
  for(const product of products){
    const categoryKey=key(product.category);
    if(!seen.has(categoryKey))throw Error('Unknown product category: '+product.category);
    const productKey=JSON.stringify([categoryKey,key(product.name)]);
    if(productKeys.has(productKey))throw Error('Duplicate product in category: '+product.name);
    productKeys.add(productKey);
  }
  return ordered;
}
const findUnique=(rows,predicate,label)=>{
  const matches=rows.filter(predicate);
  if(matches.length>1)throw Error('Multiple records match '+label);
  return matches[0];
};
const categoryMatch=(rows,category,parentId)=>findUnique(rows,
  row=>key(row.name)===key(category.name)&&Number(row.parentID??0)===parentId,category.name);
const productMatch=(rows,product,categoryId)=>findUnique(rows,
  row=>key(row.productName??row.name)===key(product.name)&&Number(row.categoryID)===categoryId,product.name);
function rowId(row,label){
  const id=Number(row?.id);
  if(!Number.isSafeInteger(id)||id<=0)throw Error('Cannot verify the Zonely record ID for '+label);
  return id;
}

export async function setupStore(admin,{mode,categories,products},{resolveImage=async image=>image}={}){
  const ordered=validatePlan(categories,products);
  return admin.runExclusive(async()=>{
    const summary={mode,origin:admin.status().origin,done:false,steps:[]};
    async function call(id,body,query,files=[]){
      let payload;
      const response=await admin.execute({id,body,query,files},value=>{payload=value;});
      if(!response.ok)throw Error(String(response.data?.message??'Zonely returned HTTP '+response.status));
      return payload;
    }
    async function readRows(id,search=''){
      const rows=[];
      const length=100;
      for(let start=0;start<10000;start+=length){
        const payload=await call(id,{}, {start,length,...(search?{search}:{})});
        if(!Array.isArray(payload?.data))throw Error('Zonely did not return a list for '+id);
        rows.push(...payload.data);
        if(payload.data.length<length||rows.length>=Number(payload.recordsFiltered??Infinity))return rows;
      }
      throw Error('Could not verify the complete Zonely list for '+id);
    }
    const categoryList='products-categorieslistcontroller';
    const productList='products-productslistcontroller';
    let step='Inspect the store';
    try{
      let categoryRows=await readRows(categoryList);
      const categoriesByName=new Map();
      for(const category of ordered){
        const parent=category.parent?categoriesByName.get(key(category.parent)):null;
        const parentId=category.parent?parent.id:0;
        const existing=(!category.parent||parentId!==null)?categoryMatch(categoryRows,category,parentId):undefined;
        categoriesByName.set(key(category.name),{id:existing?rowId(existing,category.name):null,category});
      }
      const existingProducts=new Map();
      for(const product of products){
        const {id:categoryId}=categoriesByName.get(key(product.category));
        if(categoryId!==null){
          const existing=productMatch(await readRows(productList,product.name),product,categoryId);
          if(existing)existingProducts.set(product,rowId(existing,product.name));
        }
      }
      const prepared=new Map();
      for(const item of [...categoriesByName.values()]){
        if(item.id===null){prepared.set(item.category,await resolveImage(item.category.image));mediaCredit(item.category.image);transferFile(admin.config,admin.store,prepared.get(item.category));}
      }
      for(const product of products)if(!existingProducts.has(product)){prepared.set(product,await resolveImage(product.image));mediaCredit(product.image);transferFile(admin.config,admin.store,prepared.get(product));}
      for(const category of ordered){
        step='Category '+category.name;
        const entry=categoriesByName.get(key(category.name));
        let result=entry.id===null?'pending':'existing';
        if(entry.id===null&&mode==='apply'){
          const parentId=category.parent?categoriesByName.get(key(category.parent)).id:0;
          await call('products-categoriesaddcontroller',
            {name:category.name,categoryID:parentId,content:category.description+mediaCredit(category.image)},{},[{field:'image',...prepared.get(category)}]);
          categoryRows=await readRows(categoryList);
          entry.id=rowId(categoryMatch(categoryRows,category,parentId),category.name);
          result='created';
        }
        summary.steps.push({kind:'category',name:category.name,id:entry.id,result});
      }
      for(const product of products){
        step='Product '+product.name;
        const categoryId=categoriesByName.get(key(product.category)).id;
        let id=existingProducts.get(product)??null;
        let result=id===null?'pending':'existing';
        if(id===null&&mode==='apply'){
          await call('products-productsaddcontroller',{
            name:product.name,categoryIDs:categoryId,details:product.description+mediaCredit(product.image),contents:product.description+mediaCredit(product.image),price:product.price
          },{},[{field:'image',...prepared.get(product)}]);
          const inserted=productMatch(await readRows(productList,product.name),product,categoryId);
          id=rowId(inserted,product.name);
          result='created';
        }
        summary.steps.push({kind:'product',name:product.name,category:product.category,id,result});
      }
      summary.done=true;
    }catch(error){
      summary.failedStep=step;
      summary.error=error.message;
    }
    return summary;
  });
}
