import {randomBytes} from 'node:crypto';
import {matchesPost} from './panel-request.mjs';

const endpoint = '/Files/Controllers/ControllersAll.php';
const usersPage = 'panel:site:page:main.users';
const listOperations = {
  announcements: {page: 'panel:site:page:main.news', main: 'broadcasts', container: 'broadcastsListController', fields: ['id','title','name','status','created_at','slug']},
  support: {page: 'panel:site:page:main.livesupports', main: 'Supports', container: 'SupportsListController', fields: ['id','title','statusID','alterHtml','categoryName','created_at']},
};

function controller(origin, main, container, query = {}) {
  const url = new URL(endpoint, origin);
  url.search = new URLSearchParams({main, container, ...query});
  return url;
}

async function searchMembers(page, origin, query) {
  const rows = await page.evaluate(async ({origin, query}) => {
    for (const route of ['/Files/Api/usersearch.php', '/Files/Src/MVC/Http/Endpoints/user-search.php']) {
      const url = new URL(route, origin);
      url.searchParams.set('q', query);
      const response = await fetch(url.href, {redirect:'manual', credentials:'same-origin', signal:AbortSignal.timeout(8000)});
      if (response.status === 404 || response.type === 'opaqueredirect') continue;
      if (!response.ok) throw Error('The panel rejected the member search');
      const body = await response.json().catch(()=>null);
      if (!Array.isArray(body?.users)) continue;
      return body.users.slice(0, 20).map(row => {
        const label=new DOMParser().parseFromString(String(row.name ?? '').slice(0,3000), 'text/html').body;
        return {id:Number(row.id),name:(label.querySelector('.role-name')??label.firstElementChild??label).textContent.trim().slice(0,100)};
      })
        .filter(row=>Number.isSafeInteger(row.id)&&row.id>0&&row.name);
    }
    throw Error('The site did not return a supported member search result');
  }, {origin, query});
  return [...new Map(rows.map(row => [row.id,row])).values()];
}

export async function panelRecords(panel, {resource, query = '', offset = 0, limit = 10}) {
  if (resource === 'members') {
    if (!query.trim()) throw Error('Provide a member name to search');
    const page = await panel.navigate(usersPage);
    const rows = await searchMembers(page, panel.origin(), query.trim());
    return {resource, items:rows.slice(offset,offset+limit), matches:rows.length};
  }
  const operation = listOperations[resource];
  if (!operation) throw Error('Choose a supported record list');
  const page = await panel.navigate(operation.page);
  const url = controller(panel.origin(), operation.main, operation.container, {start:String(offset), length:String(limit), search:query});
  return page.evaluate(async ({url, resource, fields, limit, offset}) => {
    const response = await fetch(url, {redirect:'error', credentials:'same-origin', signal:AbortSignal.timeout(10000)});
    if (!response.ok) throw Error('Panel list is unavailable in this account');
    const json = await response.json();
    const rows = Array.isArray(json) ? json : json.data;
    if (!Array.isArray(rows)) throw Error('Unexpected panel list response');
    const items = rows.slice(0,limit).map(row=>Object.fromEntries(fields.flatMap(field=>{
      const value=row?.[field];
      if(typeof value==='number'||typeof value==='boolean')return [[field,value]];
      return typeof value==='string'?[[field,new DOMParser().parseFromString(value.slice(0,1500),'text/html').body.textContent.trim().slice(0,250)]]:[];
    })));
    return {resource, offset, items, ...(Number.isSafeInteger(Number(json.recordsFiltered))?{total:Number(json.recordsFiltered)}:{})};
  }, {url:url.href, resource, fields:operation.fields, limit, offset});
}

async function balance(page, origin, memberId, username) {
  return page.evaluate(async ({origin, memberId, username}) => {
    const url = new URL('/Files/Src/MVC/Http/Endpoints/users-update.php', origin);
    url.search = new URLSearchParams({scope:'admin', id:String(memberId)});
    const response = await fetch(url, {redirect:'error', credentials:'same-origin', cache:'no-store', signal:AbortSignal.timeout(10000),
      headers:{'X-Requested-With':'XMLHttpRequest'}});
    if (!response.ok) throw Error('The member edit drawer is unavailable');
    let markup = await response.text();
    if (markup.length > 1024*1024) throw Error('Member edit drawer is too large');
    try { const json=JSON.parse(markup); markup=json.html??json.content??json.data?.html??''; } catch {}
    const form = new DOMParser().parseFromString(markup,'text/html').querySelector('#usersEditForm');
    const id=form?.querySelector('input[name="id"]')?.value.trim();
    const nick=form?.querySelector('input[name="nick"]')?.value.trim();
    const credit=form?.querySelector('input[name="credit"]')?.getAttribute('value')?.trim();
    if (nick && nick.toLowerCase()!==username.toLowerCase()) throw Error('The member name changed before the credit operation');
    if (id !== String(memberId) || typeof credit !== 'string' || !/^-?\d+(?:[.,]\d{1,2})?$/.test(credit))
      throw Error('The verified member balance is unavailable');
    const cents = Math.round(Number(credit.replace(',','.'))*100);
    if (!Number.isSafeInteger(cents)) throw Error('Member balance is outside the supported range');
    return cents;
  }, {origin, memberId, username});
}

export async function grantMemberCredit(panel, {username, amount, direction = 'grant', mode = 'preview', expectedUserId, expectedBalanceBefore}) {
  const cents = Math.round(amount*100);
  if (!Number.isFinite(amount) || cents<1 || amount>999999999.99 || Math.abs(amount*100-cents)>1e-4)
    throw Error('Provide a positive credit amount with at most two decimal digits');
  if(!['grant','debit'].includes(direction))throw Error('Choose grant or debit');
  const debit=direction==='debit';
  const page=await panel.navigate(usersPage);
  const origin=panel.origin();
  const form=page.locator('#creditForm');
  if(debit&&await form.locator('[data-zonely-credit-debit="1"]').count()!==1)
    throw Error('Credit deduction is unavailable for this site or account');
  const exact=(await searchMembers(page,origin,username.trim())).filter(row=>row.name.toLowerCase()===username.trim().toLowerCase());
  if(exact.length!==1)throw Error('Exactly one member must match the username. No credit was sent.');
  const member=exact[0];
  if(mode==='apply'&&member.id!==expectedUserId)throw Error('Use the member ID returned by preview to apply the grant');
  const before=await balance(page,origin,member.id,member.name);
  if(debit&&before<cents)throw Error('The member has insufficient credit');
  if(debit&&mode==='apply'&&expectedBalanceBefore!==before/100)
    throw Error('Use the current balance returned by preview to apply the deduction');
  const afterExpected=before+(debit?-cents:cents);
  const summary={member,amount,balanceBefore:before/100,expectedBalance:afterExpected/100,...(debit?{direction}:{})};
  if(mode==='preview')return {...summary,submitted:false};

  const price=((debit?-cents:cents)/100).toFixed(2);
  const beforeText=(before/100).toFixed(2);
  const key=randomBytes(16).toString('hex');
  const prepared=await form.evaluate((node,{id,name,price,key,debit,beforeText})=>{
    const select=node.querySelector('select[name="user"]');
    const input=node.querySelector('input[name="price"]');
    const type=node.querySelector('select[name="type"]');
    const api=node.querySelector('select[name="api"]');
    if(!select||!input||!type||!api||!node.querySelector('input[type="hidden"][name*="csrf"]'))
      throw Error('The native credit form is incomplete');
    if(![...select.options].some(option=>option.value===id))select.add(new Option(name,id));
    select.value=id;
    if(debit){
      if(!node.querySelector('[data-zonely-credit-debit="1"]'))throw Error('The credit deduction capability changed');
      const extra={direction:'debit',expected_balance:beforeText};
      for(const [name,value] of Object.entries(extra)){
        if(node.elements.namedItem(name))throw Error('The credit form already contains a conflicting control');
        const field=document.createElement('input');
        Object.assign(field,{type:'hidden',name,value});
        node.append(field);
      }
      input.removeAttribute('min');
    }
    input.value=price;
    if(!['1','2','3'].includes(type.value)||!node.checkValidity())throw Error('The native credit form has invalid controls');
    const signature=JSON.stringify([id,price,type.value,api.value]);
    node.__znCreditAttempt={signature,key};
    return {url:new URL(node.getAttribute('data-ajax-url')?.trim()||node.getAttribute('action')?.trim(), location.href).href, type:type.value, api:api.value};
  },{id:String(member.id),name:member.name,price,key,debit,beforeText});
  const allowed=[controller(origin,'Credits','CreditsGiveController').href,controller(origin,'Products','CreditGiveController').href];
  const expected=new URL(prepared.url);
  if(expected.origin!==origin||expected.pathname!==endpoint||expected.searchParams.size!==2||
    !allowed.some(value=>{const url=new URL(value);return [...url.searchParams].every(([k,v])=>expected.searchParams.get(k)===v);}))
    throw Error('Unexpected destination in the native credit form');

  const bodyMatch={user:String(member.id),price,type:prepared.type,api:prepared.api,request_key:key,
    ...(debit?{direction:'debit',expected_balance:beforeText}:{})};
  panel.expectedPost=expected;panel.expectedPostBody=bodyMatch;panel.allowWrites=true;
  const waiting=page.waitForResponse(response=>matchesPost(response.request(),expected,bodyMatch),{timeout:15000}).catch(()=>null);
  const unknownResult='Credit result is unknown. Read the balance and credit history before retrying.';
  let bodyTimeout;
  try {
    await form.evaluate(node=>node.requestSubmit());
    const response=await waiting;
    panel.allowWrites=false;
    if(!response)throw Error(unknownResult);
    if(!response.ok())throw Error('The site did not acknowledge the credit operation.');
     
    const result=await Promise.race([
      response.json().catch(()=>null),
      new Promise((_,reject)=>{bodyTimeout=setTimeout(()=>reject(Error(unknownResult)),10000);})
    ]);
    clearTimeout(bodyTimeout);
    if(result?.status!=='success')throw Error('The site did not acknowledge the credit operation.');
    const after=await balance(page,origin,member.id,member.name).catch(()=>null);
    return {...summary,submitted:true,acknowledged:true,verified:after===afterExpected,
      ...(after===null?{}:{balanceAfter:after/100}),
      ...(after===afterExpected?{}:{hint:'Read the member balance and history before retrying.'})};
  } finally {
    clearTimeout(bodyTimeout);
    panel.allowWrites=false;panel.expectedPost=null;panel.expectedPostBody=null;
  }
}
