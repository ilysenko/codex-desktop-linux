'use strict';
const assert=require('node:assert/strict');
const vm=require('node:vm');

// Exercise the injected hooks and the actual compiled upstream dialog handlers.
function createHarness(source) {
  const helpers=source.slice(source.indexOf('\nvar __cmColors,__cmRuntime;')).replace(/export \{[^}]+\};/g,'');
  assert.ok(helpers.startsWith('\nvar __cmColors'));
  const hook=helpers.slice(helpers.indexOf('function __cmUseProjectColor('));
  const aliases={
    scope:hook.match(/const scope=([\w$]+)\(([\w$]+)\)/).slice(1),
    react:hook.match(/ref=([\w$]+)\(\).useRef/)[1],
    read:hook.match(/const colors=([\w$]+)\(__cmColors\)/)[1],
    detected:hook.match(/hasMicro=[\w$]+\(([\w$]+)\)===true/)[1],
    jsx:hook.match(/jsx=([\w$]+)\(\)/)[1],
    atom:helpers.match(/__cmColors=([\w$]+)\(/)[1],
    initialize:helpers.match(/function __cmInitColors\(\)\{\s+([\w$]+)\(\)/)[1],
    row:helpers.match(/return jsx.jsx\(([\w$]+),/)[1],
  };
  const componentAt=anchor=>{
    const at=source.indexOf(anchor),start=source.lastIndexOf('function ',at),end=source.indexOf('function ',at+anchor.length);
    return source.slice(start,end);
  };
  const parent=componentAt('projectSetup.editLocalProject.title');
  const localName=parent.match(/\.jsx\)\(([\w$]+),\{deleteProject:/)[1];
  const components=[componentAt(`function ${localName}(`),componentAt('projectSetup.editRemoteProject.title')];
  let stored={},detected=true,ref={current:null},writes=0,saveResult=true,closeCount=0;
  const scope={set:(_,next)=>{writes++;stored=next(stored);},get:()=>({danger:()=>{}})};
  const React={useRef:()=>ref,useState:initial=>[typeof initial==='function'?initial():initial,()=>{}]};
  const jsx={jsx:(type,props)=>({type,props}),jsxs:(type,props)=>({type,props})};
  const context={Symbol,Object,Array,JSON,Map,Set,Error,Promise,Number,RegExp};
  // Unrelated upstream UI leaf components and utilities stay inert.
  for(const word of components.join('').match(/[A-Za-z_$][\w$]*/g))
    if(!(word in context))context[word]=()=>{};
  Object.assign(context,{
    [aliases.scope[0]]:()=>scope,[aliases.scope[1]]:{},[aliases.react]:()=>React,
    [aliases.read]:signal=>signal===context[aliases.detected]?detected:stored,
    [aliases.detected]:{},[aliases.jsx]:()=>jsx,[aliases.atom]:(key,initial)=>({key,initial}),
    [aliases.initialize]:()=>{},[aliases.row]:'row',
  });
  const cache=new Map();
  for(const component of components){
    const compiler=component.match(/\(0,([\w$]+)\.c\)\((\d+)\)/)[1];
    context[compiler]={c:size=>{if(!cache.has(compiler))cache.set(compiler,Array(size).fill(Symbol.for('react.memo_cache_sentinel')));return cache.get(compiler);}};
    const react=component.match(/\(0,([\w$]+)\.useState\)/)[1];
    context[react]=React;
    const js=component.match(/\(0,([\w$]+)\.jsx\)/)[1];
    context[js]=jsx;
  }
  const intl=components[1].match(/=[\w$]+\([\w$]+\),[\w$]+=([\w$]+)\(\),/)[1];
  context[intl]=()=>({formatMessage:message=>message.defaultMessage});
  const remoteSave=components[1].match(/await ([\w$]+)\([\w$]+,[\w$]+,[\w$]+\),__cmDraft.save/)[1];
  context[remoteSave]=async()=>{if(saveResult instanceof Error)throw saveResult;return saveResult;};
  const localNormalizer=components[0].match(/=([\w$]+)\([\w$]+\),[\w$]+\[0\]=/);
  if(localNormalizer)context[localNormalizer[1]]=value=>value;
  const api=vm.runInNewContext(helpers+components.join('')+`;({use:__cmUseProjectColor,field:__cmProjectColorField,picker:__cmColorPicker,local:${localName},remote:${components[1].match(/^function ([\w$]+)/)[1]}})`,context);
  function walk(node,predicate){
    if(!node||typeof node!=='object')return null;
    if(predicate(node))return node;
    for(const child of [node.props?.children].flat(Infinity)){const found=walk(child,predicate);if(found)return found;}
    return null;
  }
  const props={projectId:'project-a',initialName:'Project A',initialSources:[],onClose:()=>closeCount++,onSave:async()=>{if(saveResult instanceof Error)throw saveResult;return saveResult;},project:{projectId:'project-a',projectKind:'remote',hostId:'server',label:'Project A',path:'/src'}};
  return {api,props,walk,get stored(){return stored;},set stored(value){stored=value;},get writes(){return writes;},get closeCount(){return closeCount;},
    set detected(value){detected=value;},set saveResult(value){saveResult=value;},newDialog(){ref={current:null};cache.clear();},
    colorInput(field){const picker=walk(field,n=>n.type===api.picker);return picker&&walk(api.picker(picker.props),n=>n.props?.["aria-label"]==="Micro working color hex");},
    render(kind){const tree=api[kind](props);return {tree,form:walk(tree,n=>n.props?.as==='form'),field:walk(tree,n=>n.type===api.field)};},
  };
}

async function testEditors(t,source,runtime){
  await t.test('device visibility, existing colors, draft edits, cancel, and removal',()=>{
    const h=createHarness(source),project={projectId:'project-a'},key=runtime.projectKey(project);
    h.stored={[key]:'#123456'};
    const state=h.api.use(project);
    h.detected=false;assert.equal(h.api.field({state,disabled:false}),null);
    h.detected=true;
    let field=h.api.field({state,disabled:false});
    assert.equal(h.colorInput(field).props.value,'#123456');
    h.colorInput(field).props.onChange({currentTarget:{value:'#abcdef'}});
    assert.equal(h.writes,0);
    h.newDialog(); // Cancel discards the previous dialog's unsaved draft.
    const reopened=h.api.use(project);
    field=h.api.field({state:reopened,disabled:false});
    assert.equal(h.colorInput(field).props.value,'#123456');
    h.walk(field,n=>n.props?.children==='Remove override').props.onClick();
    field=h.api.field({state:reopened,disabled:false});
    assert.equal(h.colorInput(field),null);
    assert.ok(h.walk(field,n=>n.props?.children==='Add override'));
    reopened.save();assert.equal(Object.keys(h.stored).length,0);
    h.newDialog();assert.equal(h.api.field({state:h.api.use({}),disabled:false}),null);
  });
  await t.test('add and remove buttons gate the picker, stay draft-only, and respect saving',()=>{
    const h=createHarness(source),state=h.api.use({projectId:'project-a'});
    let field=h.api.field({state,disabled:false});
    assert.equal(h.colorInput(field),null);
    let add=h.walk(field,n=>n.props?.children==='Add override');
    assert.equal(add.props.type,'button');add.props.onClick();
    field=h.api.field({state,disabled:false});
    assert.equal(h.colorInput(field).props.value,'#A855F7');assert.equal(h.writes,0);
    field=h.api.field({state,disabled:true});
    const remove=h.walk(field,n=>n.props?.children==='Remove override');
    assert.equal(remove.props.disabled,true);remove.props.onClick();
    assert.equal(state.value,'#a855f7');
    field=h.api.field({state,disabled:false});
    h.walk(field,n=>n.props?.children==='Remove override').props.onClick();
    assert.equal(h.colorInput(h.api.field({state,disabled:false})),null);
    assert.equal(h.writes,0);state.save();assert.equal(Object.keys(h.stored).length,0);
  });
  for(const kind of ['local','remote'])await t.test(`${kind}: native Save commits after success; failure and cancellation keep preferences`,async()=>{
    const h=createHarness(source),project=kind==='local'?{projectId:'project-a'}:h.props.project,key=runtime.projectKey(project);
    h.stored={[key]:'#123456','["local","local","other"]':'#654321'};
    let view=h.render(kind);
    assert.ok(view.form&&view.field);
    let field=h.api.field(view.field.props);
    h.colorInput(field).props.onChange({currentTarget:{value:'#000000'}});
    assert.equal(h.writes,0);
    // Native memoized handlers must read the current draft even on a cache hit.
    view=h.render(kind);
    h.saveResult=new Error('project save failed');
    view.form.props.onSubmit({preventDefault(){}});
    await new Promise(setImmediate);
    assert.equal(h.writes,0);assert.equal(h.closeCount,0);
    if(kind==='local'){
      h.saveResult=false;
      view.form.props.onSubmit({preventDefault(){}});
    await new Promise(setImmediate);
      assert.equal(h.writes,0);assert.equal(h.closeCount,0);
    }
    h.saveResult=true;
    view.form.props.onSubmit({preventDefault(){}});
    await new Promise(setImmediate);
    assert.equal(h.stored[key],'#000000');assert.equal(h.stored['["local","local","other"]'],'#654321');
    assert.equal(h.writes,1);assert.equal(h.closeCount,1);
    h.newDialog();h.detected=false;
    view=h.render(kind);assert.equal(h.api.field(view.field.props),null);
    view.form.props.onSubmit({preventDefault(){}});
    await new Promise(setImmediate);
    assert.equal(h.writes,1);
  });
}
module.exports={testEditors};
