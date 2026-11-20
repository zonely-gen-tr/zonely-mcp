export async function matchesPost(request,expected,bodyMatch,allowedFields){
  const url=new URL(request.url());
  if(request.method()!=='POST'||url.origin!==expected.origin||url.pathname!==expected.pathname||
    ![...expected.searchParams].every(([key,value])=>url.searchParams.getAll(key).length===1&&url.searchParams.get(key)===value))return false;
  if(!bodyMatch)return true;
  if([...url.searchParams.keys()].some(key=>!expected.searchParams.has(key)))return false;
  const bytes=request.postDataBuffer();
  if(Array.isArray(bodyMatch)&&bodyMatch.length===0)return !bytes||bytes.length===0;
  const type=request.headers()['content-type'];
  if(!bytes||typeof type!=='string'||bytes.length>2*1024*1024)return false;
  try{
    if(/^application\/json(?:\s*;|$)/i.test(type)){
      if(!allowedFields)return false;
      const body=JSON.parse(bytes.toString('utf8'));
      if(!body||typeof body!=='object'||Array.isArray(body))return false;
      if(Object.keys(body).length!==allowedFields.length||Object.keys(body).some(key=>!allowedFields.includes(key)))return false;
      return Object.entries(bodyMatch).every(([key,value])=>Object.hasOwn(body,key)&&JSON.stringify(body[key])===JSON.stringify(value));
    }
    const fields=await new Response(bytes,{headers:{'content-type':type}}).formData();
    if(Array.isArray(bodyMatch)){
      const actual=[...fields];
      return actual.length===bodyMatch.length&&actual.every(([name,value],index)=>{
        const [expectedName,expectedValue]=bodyMatch[index];
        return name===expectedName&&(typeof expectedValue==='string'
          ?typeof value==='string'&&value===expectedValue.replace(/\r\n|\r|\n/g,'\r\n')
          :expectedValue?.emptyFile===true&&((typeof value!=='string'&&value.size===0)||value===''));
      });
    }
    if(allowedFields&&[...fields].some(([name,value])=>!allowedFields.includes(name)||
      typeof value!=='string'||fields.getAll(name).length!==1))return false;
    return Object.entries(bodyMatch).every(([key,value])=>fields.getAll(key).length===1&&fields.get(key)===value);
  }catch{return false;}
}
