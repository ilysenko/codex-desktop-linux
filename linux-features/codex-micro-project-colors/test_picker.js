'use strict';
const assert=require('node:assert/strict');
const test=require('node:test');
const vm=require('node:vm');
const picker=require('./picker.js');

function harness(initial='#a855f7'){
  let color=initial,writes=0,cursor=0,disabled=false;
  const states=[];
  const React={useState(initial){const at=cursor++;if(!(at in states))states[at]=typeof initial==='function'?initial():initial;return [states[at],next=>states[at]=typeof next==='function'?next(states[at]):next];}};
  const jsx={jsx:(type,props)=>({type,props}),jsxs:(type,props)=>({type,props})};
  const source=picker.source({REACT:'testReact',JSX:'testJsx',READ:'read',DETECTED:'detected',ROW:'Row',BUTTON:'Button'});
  const render=vm.runInNewContext(source+';__cmColorPicker',{testReact:()=>React,testJsx:()=>jsx});
  const walk=(node,predicate)=>{
    if(!node||typeof node!=='object')return null;
    if(predicate(node))return node;
    for(const child of [node.props?.children].flat(Infinity)){const found=walk(child,predicate);if(found)return found;}
    return null;
  };
  const tree=()=>{cursor=0;return render({color,disabled,onChange:next=>{color=next;writes++;}});};
  return {tree,walk,get color(){return color;},get writes(){return writes;},set disabled(value){disabled=value;},
    control(label){return walk(tree(),n=>n.props?.['aria-label']===label);},
  };
}

test('picker accepts exact hex colors and round-trips the RGB cube without changing saved colors',()=>{
  assert.equal(picker.parseHex(' #ABC '),'#aabbcc');
  assert.equal(picker.parseHex('123456'),'#123456');
  for(const value of ['','bad hex','#12','#12345678','rgb(1,2,3)'])assert.equal(picker.parseHex(value),null);
  for(const r of [0,1,127,128,254,255])for(const g of [0,1,127,128,254,255])for(const b of [0,1,127,128,254,255]){
    const hex='#'+[r,g,b].map(n=>n.toString(16).padStart(2,'0')).join('');
    assert.equal(picker.hsvHex(picker.hexHsv(hex)),hex);
  }
});

test('spectrum dragging, keyboard, hue and swatches select colors and preserve hue at black',()=>{
  const h=harness('#ff0000');let capture=false,focused=false;
  const target={focus(){focused=true;},setPointerCapture(){capture=true;},hasPointerCapture(){return capture;},releasePointerCapture(){capture=false;},getBoundingClientRect(){return {left:0,top:0,width:100,height:100};}};
  const event={button:0,pointerId:1,clientX:100,clientY:100,currentTarget:target,preventDefault(){}};
  h.control('Saturation and brightness').props.onPointerDown(event);
  assert.equal(h.color,'#000000');assert.ok(focused&&capture);
  h.control('Hue').props.onChange({currentTarget:{value:'120'}});
  assert.equal(h.color,'#000000');
  h.control('Saturation and brightness').props.onPointerMove({...event,clientY:0});
  assert.equal(h.color,'#00ff00');
  h.control('Saturation and brightness').props.onPointerUp(event);assert.equal(capture,false);
  let prevented=false;
  h.control('Saturation and brightness').props.onKeyDown({key:'ArrowDown',shiftKey:true,preventDefault(){prevented=true;}});
  assert.equal(h.color,'#00e600');assert.ok(prevented);
  h.control('Purple #A855F7').props.onClick();assert.equal(h.color,'#a855f7');
  assert.equal(h.control('Purple #A855F7').props['aria-pressed'],true);
  const count=h.writes;h.control('Saturation and brightness').props.onPointerMove(event);assert.equal(h.writes,count);
});

test('hex editing supports paste and shorthand, rejects invalid drafts, and disabled controls do not write',()=>{
  const h=harness();
  const input=()=>h.control('Micro working color hex');
  input().props.onChange({currentTarget:{value:'#123456'}});assert.equal(h.color,'#123456');
  input().props.onChange({currentTarget:{value:'#abc'}});assert.equal(h.color,'#123456');
  let prevented=false;input().props.onKeyDown({key:'Enter',preventDefault(){prevented=true;}});
  assert.equal(h.color,'#aabbcc');assert.ok(prevented);
  input().props.onChange({currentTarget:{value:'invalid'}});assert.equal(input().props['aria-invalid'],true);
  input().props.onBlur();assert.equal(h.color,'#aabbcc');assert.equal(input().props.value,'#AABBCC');
  const writes=h.writes;h.disabled=true;
  input().props.onChange({currentTarget:{value:'#000000'}});
  h.control('Hue').props.onChange({currentTarget:{value:'200'}});
  h.control('Purple #A855F7').props.onClick();
  h.control('Saturation and brightness').props.onKeyDown({key:'ArrowDown',preventDefault(){}});
  assert.equal(h.control('Saturation and brightness').props.tabIndex,-1);
  assert.equal(h.writes,writes);
  assert.equal(h.walk(h.tree(),n=>n.props?.type==='color'),null);
});
