 
export async function formControls(form){
  return form.evaluate(root=>[...(root.tagName==='FORM'?root.elements:root.querySelectorAll('input,select,textarea'))]
    .filter(e=>['INPUT','SELECT','TEXTAREA'].includes(e.tagName))
    .map(e=>({name:e.name,type:e.type,tag:e.tagName,disabled:e.disabled})));
}

export async function formControl(form,name,value){
  const handle=await form.evaluateHandle((root,{name,value})=>{
    let controls=[...(root.tagName==='FORM'?root.elements:root.querySelectorAll('input,select,textarea'))]
      .filter(e=>e.name===name&&['INPUT','SELECT','TEXTAREA'].includes(e.tagName));
    const editable=controls.filter(e=>e.type!=='hidden');
    if(editable.length)controls=editable;
    if(controls.every(e=>e.type==='radio')&&typeof value!=='boolean')controls=controls.filter(e=>e.value===String(value));
    if(controls.length!==1)throw Error('Select one unambiguous form control: '+name);
    if(controls[0].disabled)throw Error('Form control is disabled: '+name);
    return controls[0];
  },{name,value});
  const element=handle.asElement();
  if(!element){await handle.dispose();throw Error('Missing form control: '+name);}
  return element;
}

export async function prepareAppealQuestions(form, fields){
  const {questions,...ordinary}=fields;
  let entries;
  try{entries=typeof questions==='string'?JSON.parse(questions):questions;}
  catch{throw Error('Use a JSON array of application questions');}
  if(!Array.isArray(entries)||entries.length<1||entries.length>20||
      Object.keys(ordinary).some(name=>name.startsWith('questions[')))throw Error('Supply between one and twenty application questions');
  const items=entries.map(entry=>typeof entry==='string'?{question:entry,type:'long'}:entry);
  if(items.some(entry=>typeof entry?.question!=='string'||!entry.question.trim()||entry.question.length>500||
      !['short','long','radio','checkbox'].includes(entry.type)||
      (entry.variables!==undefined&&(typeof entry.variables!=='string'||entry.variables.length>1000))||
      (['radio','checkbox'].includes(entry.type)&&!entry.variables?.trim())))throw Error('Each question needs text, a supported type and options for choice fields');
  const names=await form.evaluate((root,count)=>{
    const list=root.querySelector('#questionList');
    const add=root.querySelector('button[onclick="addQuestion()"]');
    if(!list||!add)throw Error('The application question editor is unavailable');
    while(list.children.length<count){
      const before=list.children.length;
      add.click();
      if(list.children.length!==before+1)throw Error('The question editor did not add a field');
    }
    if(list.children.length!==count)throw Error('The application already contains additional questions');
    return [...list.children].map((row,index)=>{
      const controls=[...row.querySelectorAll('input[name^="questions["],select[name^="questions["]')];
      return Object.fromEntries(controls.map(control=>{
        const field=control.name.split('[').at(-1).slice(0,-1);
         
        control.name='questions['+index+']['+field+']';
        return [field,control.name];
      }));
    });
  },items.length);
  for(const [index,entry] of items.entries()){
    const controls=names[index];
    if(!controls?.question||!controls.type)throw Error('The question editor did not expose its fields');
    ordinary[controls.question]=entry.question;
    ordinary[controls.type]=entry.type;
    if(entry.variables!==undefined){
      if(!controls.variables)throw Error('The question options control is unavailable');
      ordinary[controls.variables]=entry.variables;
    }
  }
  return ordinary;
}

export async function setFormValues(form,values){
  for(const [name,value]of Object.entries(values)){
    if(Array.isArray(value)){
      const assigned=await form.evaluate((root,{name,value})=>{
        const controls=[...root.elements].filter(control=>control.name===name&&control.type==='checkbox');
        if(!controls.length)return false;
        const selected=new Set(value.map(String));
        if([...selected].some(item=>!controls.some(control=>!control.disabled&&control.value===item))||
          controls.some(control=>control.disabled&&control.checked!==selected.has(control.value)))
          throw Error('Choose available checkbox options: '+name);
        for(const control of controls){
          if(control.checked===selected.has(control.value))continue;
          control.checked=selected.has(control.value);
          control.dispatchEvent(new Event('input',{bubbles:true}));
          control.dispatchEvent(new Event('change',{bubbles:true}));
        }
        return true;
      },{name,value});
      if(assigned)continue;
    }
    const control=await formControl(form,name,value);
    try{
      const type=await control.evaluate(e=>({type:e.type,tag:e.tagName}));
      if(type.type==='file')throw Error('Use the files argument for file inputs');
      if(type.type==='checkbox'||type.type==='radio'){
        if(type.type==='checkbox'&&typeof value!=='boolean')throw Error('Checkbox values must be boolean: '+name);
        const checked=type.type==='radio'&&typeof value!=='boolean'?true:value;
        await control.evaluate((e,wanted)=>{
          if(e.checked!==wanted)e.click();
          if(e.checked!==wanted)throw Error('The native control did not accept the requested state: '+e.name);
        },checked);
      }else if(type.tag==='SELECT')await control.selectOption(Array.isArray(value)?value.map(String):String(value),{force:true});
      else await control.evaluate((e,value)=>{
        e.value=String(value);
        const editor=globalThis.CKEDITOR?.instances?.[e.id];
        if(editor){editor.setData(String(value));editor.updateElement();}
        const tiny=globalThis.tinymce?.get(e.id);if(tiny){tiny.setContent(String(value));tiny.save();}
        const froala=globalThis.jQuery?.(e).data('froala.editor');
        if(froala?.html){froala.html.set(String(value));froala.events?.trigger('contentChanged');}
        e.dispatchEvent(new Event('input',{bubbles:true}));
        e.dispatchEvent(new Event('change',{bubbles:true}));
      },value);
    }finally{await control.dispose();}
  }
}
