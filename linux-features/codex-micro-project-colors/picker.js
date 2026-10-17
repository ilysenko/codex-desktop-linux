'use strict';

// These components are embedded into the app bundle with its own React, signal,
// dialog-row and Button bindings. No OS color dialog or extra dependency is used.
function __cmProjectColorField({state,disabled}){
  __cmInitColors();
  const colors=__CM_READ__(__cmColors),hasMicro=__CM_READ__(__CM_DETECTED__)===true,jsx=__CM_JSX__(),[,render]=__CM_REACT__().useState(0);
  if(!hasMicro||state.key===null)return null;
  const color=state.touched?state.value:colors[state.key]??null;
  const change=value=>{if(disabled)return;state.value=value;state.touched=true;render(value=>value+1);};
  return jsx.jsx(__CM_ROW__,{className:"gap-2",children:jsx.jsxs("div",{className:"cm-project-color",children:[
    jsx.jsx("style",{children:__cmPickerStyles()}),
    jsx.jsxs("div",{className:"cm-color-heading",children:[
      jsx.jsx("span",{className:"font-medium text-default",children:"Micro working color"}),
      jsx.jsx(__CM_BUTTON__,{type:"button",size:"actionSm",color:color===null?"outline":"ghost",disabled,onClick:()=>change(color===null?"#a855f7":null),children:color===null?"Add override":"Remove override"})
    ]}),
    jsx.jsx("p",{className:"text-xs text-secondary",children:"Use a custom color while chats in this project are working."}),
    color===null?null:jsx.jsx(__cmColorPicker,{color,disabled,onChange:change})
  ]})});
}

function __cmParseHex(value){
  const match=/^#?([\da-f]{6}|[\da-f]{3})$/i.exec(value.trim());
  if(!match)return null;
  const hex=match[1].toLowerCase();
  return "#"+(hex.length===3?[...hex].map(c=>c+c).join(""):hex);
}
function __cmHexHsv(hex){
  const [r,g,b]=hex.slice(1).match(/../g).map(c=>parseInt(c,16)/255),max=Math.max(r,g,b),min=Math.min(r,g,b),delta=max-min;
  let h=0;
  if(delta){h=max===r?((g-b)/delta)%6:max===g?(b-r)/delta+2:(r-g)/delta+4;h=(h*60+360)%360;}
  return {h,s:max===0?0:delta/max,v:max};
}
function __cmHsvHex({h,s,v}){
  const c=v*s,x=c*(1-Math.abs(((h/60)%2)-1)),m=v-c;
  const rgb=h<60?[c,x,0]:h<120?[x,c,0]:h<180?[0,c,x]:h<240?[0,x,c]:h<300?[x,0,c]:[c,0,x];
  return "#"+rgb.map(n=>Math.round((n+m)*255).toString(16).padStart(2,"0")).join("");
}
function __cmColorPicker({color,disabled,onChange}){
  const React=__CM_REACT__(),jsx=__CM_JSX__();
  const [selection,setSelection]=React.useState(()=>({hex:color,...__cmHexHsv(color)})),[draft,setDraft]=React.useState(null);
  const hsv=selection.hex===color?selection:__cmHexHsv(color);
  const update=next=>{if(disabled)return;const hex=__cmHsvHex(next);setSelection({...next,hex});setDraft(null);onChange(hex);};
  const choose=hex=>{if(disabled)return;setSelection({hex,...__cmHexHsv(hex)});setDraft(null);onChange(hex);};
  const commitHex=()=>{if(disabled)return;const hex=__cmParseHex(draft??color);if(hex)choose(hex);else setDraft(null);};
  const point=event=>{
    if(disabled)return;
    const rect=event.currentTarget.getBoundingClientRect();
    if(rect.width<=0||rect.height<=0)return;
    update({...hsv,s:Math.max(0,Math.min(1,(event.clientX-rect.left)/rect.width)),v:1-Math.max(0,Math.min(1,(event.clientY-rect.top)/rect.height))});
  };
  const release=event=>{if(event.currentTarget.hasPointerCapture(event.pointerId))event.currentTarget.releasePointerCapture(event.pointerId);};
  const keys=event=>{
    if(disabled)return;
    const step=event.shiftKey ? .1 : .01;
    let {s,v}=hsv;
    if(event.key==="ArrowLeft")s-=step;else if(event.key==="ArrowRight")s+=step;
    else if(event.key==="ArrowUp")v+=step;else if(event.key==="ArrowDown")v-=step;else return;
    event.preventDefault();update({...hsv,s:Math.max(0,Math.min(1,s)),v:Math.max(0,Math.min(1,v))});
  };
  const palette=[["Red","#ef4444"],["Orange","#f97316"],["Yellow","#eab308"],["Green","#22c55e"],["Teal","#14b8a6"],["Cyan","#06b6d4"],["Blue","#3b82f6"],["Purple","#a855f7"],["Pink","#ec4899"],["White","#ffffff"]];
  const invalid=draft!==null&&__cmParseHex(draft)===null;
  return jsx.jsxs("div",{className:"cm-color-picker","data-disabled":disabled||undefined,children:[
    jsx.jsx("div",{className:"cm-color-spectrum",role:"slider",tabIndex:disabled?-1:0,"aria-disabled":disabled,"aria-label":"Saturation and brightness","aria-description":"Left and right change saturation. Up and down change brightness. Hold Shift for larger steps.","aria-valuemin":0,"aria-valuemax":100,"aria-valuenow":Math.round(hsv.s*100),"aria-valuetext":Math.round(hsv.s*100)+"% saturation, "+Math.round(hsv.v*100)+"% brightness",style:{backgroundColor:"hsl("+hsv.h+" 100% 50%)"},onKeyDown:keys,
      onPointerDown:event=>{if(disabled||event.button!==0)return;event.preventDefault();event.currentTarget.focus();event.currentTarget.setPointerCapture(event.pointerId);point(event);},
      onPointerMove:event=>{if(event.currentTarget.hasPointerCapture(event.pointerId))point(event);},onPointerUp:release,onPointerCancel:release,
      children:jsx.jsx("span",{className:"cm-color-cursor","aria-hidden":true,style:{left:hsv.s*100+"%",top:(1-hsv.v)*100+"%",backgroundColor:color}})
    }),
    jsx.jsx("input",{type:"range",className:"cm-color-hue",min:0,max:360,step:1,value:hsv.h,disabled,"aria-label":"Hue","aria-valuetext":Math.round(hsv.h)+" degrees",onChange:event=>update({...hsv,h:Number(event.currentTarget.value)})}),
    jsx.jsx("div",{className:"cm-color-swatches",role:"group","aria-label":"Suggested colors",children:palette.map(([name,hex])=>jsx.jsx("button",{type:"button",className:"cm-color-swatch",disabled,"aria-label":name+" "+hex.toUpperCase(),"aria-pressed":color===hex,title:name+" "+hex.toUpperCase(),style:{backgroundColor:hex},onClick:()=>choose(hex)},hex))}),
    jsx.jsxs("label",{className:"cm-color-hex-row",children:[
      jsx.jsx("span",{className:"text-xs text-secondary",children:"Hex"}),
      jsx.jsx("span",{className:"cm-color-preview","aria-hidden":true,style:{backgroundColor:color}}),
      jsx.jsx("input",{type:"text",className:"cm-color-hex",value:draft??color.toUpperCase(),disabled,spellCheck:false,autoComplete:"off",maxLength:7,"aria-label":"Micro working color hex","aria-invalid":invalid,onChange:event=>{
        if(disabled)return;const text=event.currentTarget.value;setDraft(text);
        if(/^#?[\da-f]{6}$/i.test(text)){const hex=__cmParseHex(text);setSelection({hex,...__cmHexHsv(hex)});onChange(hex);}
      },onBlur:commitHex,onKeyDown:event=>{if(event.key==="Enter"){event.preventDefault();commitHex();}}})
    ]}),
    invalid?jsx.jsx("p",{className:"text-xs text-secondary",role:"status",children:"Enter a 3- or 6-digit hex color."}):null
  ]});
}
function __cmPickerStyles(){return `
.cm-project-color{display:flex;flex-direction:column;gap:8px;min-width:0}
.cm-color-heading{display:flex;align-items:center;justify-content:space-between;gap:12px}
.cm-color-picker{display:flex;flex-direction:column;gap:12px;padding:12px;border:1px solid var(--color-border);border-radius:12px;background:var(--color-surface-tertiary);color:var(--color-text)}
.cm-color-picker[data-disabled]{opacity:.5}
.cm-color-spectrum{height:112px;position:relative;border-radius:8px;background-image:linear-gradient(to top,#000,transparent),linear-gradient(to right,#fff,transparent);touch-action:none;cursor:crosshair;box-shadow:inset 0 0 0 1px var(--color-border)}
.cm-color-cursor{position:absolute;width:12px;height:12px;border:2px solid #fff;border-radius:50%;box-shadow:0 0 0 1px #0006;transform:translate(-50%,-50%);pointer-events:none}
.cm-color-hue{appearance:none;display:block;width:100%;height:10px;margin:3px 0;border-radius:999px;background:linear-gradient(to right,#f00,#ff0,#0f0,#0ff,#00f,#f0f,#f00);cursor:pointer}
.cm-color-hue::-webkit-slider-thumb{appearance:none;width:16px;height:16px;border:2px solid #fff;border-radius:50%;background:transparent;box-shadow:0 0 0 1px #0006}
.cm-color-swatches{display:flex;gap:8px;flex-wrap:wrap}
.cm-color-swatch{width:24px;height:24px;flex-shrink:0;border:1px solid #0002;border-radius:50%;cursor:pointer;padding:0;box-shadow:inset 0 0 0 1px #fff2}
.cm-color-swatch[aria-pressed=true]{outline:2px solid var(--color-text);outline-offset:2px}
.cm-color-swatch:hover:not(:disabled){transform:scale(1.08)}
.cm-color-hex-row{display:flex;align-items:center;gap:8px}
.cm-color-preview{width:24px;height:24px;border:1px solid var(--color-border);border-radius:6px;margin-left:auto}
.cm-color-hex{width:108px;height:32px;padding:0 10px;border:1px solid var(--input-outline-border-color);border-radius:8px;background:var(--color-surface);color:var(--color-text);font:inherit;font-family:var(--font-mono,monospace);font-size:12px}
.cm-color-hex:hover:not(:disabled){border-color:var(--input-outline-border-color-hover)}
.cm-project-color :is(.cm-color-spectrum,.cm-color-hue,.cm-color-swatch,.cm-color-hex):focus-visible{outline:2px solid var(--color-ring);outline-offset:3px}
.cm-project-color :disabled,.cm-color-spectrum[aria-disabled=true]{cursor:default}
`;}

function source(bindings){
  const code=[__cmProjectColorField,__cmParseHex,__cmHexHsv,__cmHsvHex,__cmColorPicker,__cmPickerStyles].map(String).join('\n');
  return code.replace(/__CM_(\w+)__/g,(_,key)=>{
    if(!bindings[key])throw Error('Missing color-picker binding: '+key);
    return bindings[key];
  });
}
module.exports={source,parseHex:__cmParseHex,hexHsv:__cmHexHsv,hsvHex:__cmHsvHex};
