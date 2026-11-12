"use strict";

// Auxiliary geometry helpers from signed Linux 26.1106.51428.
module.exports = [
  "function ua(e){return e?.currentHostID===ui?{width:Math.max(0,e.stackDisplayWidth),height:Math.max(0,e.stackDisplayHeight)}:void 0}",
  "function ul(e,{bounds:t,workArea:r},n,i){let s=es.Zkw,a=Math.min(i.width,r.width-2*s),o=t.x+t.width/2;e.endsWith(\"left\")?o=r.x+s+a/2:e.endsWith(\"right\")&&(o=r.x+r.width-s-a/2);let l=e.startsWith(\"top\")?r.y+s+i.height/2:r.y+r.height-s-i.height/2;return{...n,x:o-n.width/2,y:l-n.height/2}}",
  "function uc(e,t,r){return e.workArea.x+(\"left\"===t?es.wb1/2:e.workArea.width-es.wb1/2)-r/2}",
  "function dO(e,t){return e.x>=t.x&&e.x<t.x+t.width&&e.y>=t.y&&e.y<t.y+t.height}"
].join("");
