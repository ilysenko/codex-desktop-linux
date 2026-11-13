"use strict";
const {Script}=require("node:vm");
const {createJavaScriptLexicalIndex,escapeRegExp}=require("../../scripts/patches/lib/minified-js.js");
const {requireStableCatalogBinding:stable}=require("./catalog-binding-authority.js");
const ID="[A-Za-z_$][\\w$]*";
const TOKEN_SOURCE=String.raw`(?:\\u(?:\{[0-9a-fA-F]+\}|[0-9a-fA-F]{4})|[$_\p{ID_Start}])(?:\\u(?:\{[0-9a-fA-F]+\}|[0-9a-fA-F]{4})|[$_\u200C\u200D\p{ID_Continue}])*`;
const decodeIdentifier=text=>text.replace(/\\u(?:\{([0-9a-fA-F]+)\}|([0-9a-fA-F]{4}))/gu,(_,a,b)=>String.fromCodePoint(parseInt(a??b,16)));
// This is a census of the two static loader methods actually used by this
// factory, not an indirect/dynamic object-mutation policy. The existing
// readonly proof classifies each exact receiver without inventing scope rules:
// a synthetic receiver assignment changes root authority but a real local
// shadow remains local. Native allowed uses are then closed by source shape.
function assertCriticalLoaderMethodUses(source,module,options={}){
 const allowInterop=options.allowInterop??false;
 const interopCount=options.interopCount??Number(allowInterop);
 if(typeof allowInterop!=="boolean"||!Number.isInteger(interopCount)||interopCount<0||interopCount>2||typeof source!=="string"||Buffer.byteLength(source)>256*1024||module?.params?.length!==3||new Set(module.params).size!==3||module.params.some(name=>!new RegExp(`^${ID}$`,"u").test(name)))throw Error("Invalid native critical-loader authority input");
 try{new Script(`"use strict";(function(${module.params.join(",")}){${source}})`)}catch{throw Error("Invalid native critical-loader factory syntax")}
 for(const name of module.params.slice(1))stable(source,name);
 const lexical=createJavaScriptLexicalIndex(source);
 const requireName=module.params[2],req=escapeRegExp(requireName),exp=escapeRegExp(module.params[1]);
 function trivia(at){while(at<source.length){if(/\s/u.test(source[at])){at++;continue}if(source.startsWith("/*",at)){at=source.indexOf("*/",at+2)+2;continue}if(source.startsWith("//",at)){const end=source.slice(at+2).search(/[\r\n\u2028\u2029]/u);at=end<0?source.length:at+2+end;continue}break}return at}
 function previous(at){while(at>=0&&!lexical.isCode(at))at--;return at}
 const tokens=new RegExp(TOKEN_SOURCE,"gu"),atToken=new RegExp(TOKEN_SOURCE,"uy");
 function property(after){let at=trivia(after);if(source.startsWith("?.",at))at=trivia(at+2);else if(source[at]===".")at=trivia(at+1);else if(source[at]!=="[")return null;
  if(source[at]!=="["){atToken.lastIndex=at;const hit=atToken.exec(source);return hit?decodeIdentifier(hit[0]):null}
  at=trivia(at+1);const quote=source[at];if(!['"',"'"].includes(quote))return null;let end=at+1;for(;end<source.length;end++){if(source[end]==="\\"){end++;continue}if(source[end]===quote)break}if(source[trivia(end+1)]!=="]")return null;
  return source.slice(at+1,end).replace(/\\(?:u\{([0-9a-fA-F]+)\}|u([0-9a-fA-F]{4})|x([0-9a-fA-F]{2})|(\r\n|[\r\n\u2028\u2029])|([\s\S]))/gu,(_,a,b,c,line,other)=>a||b||c?String.fromCodePoint(parseInt(a??b??c,16)):line?"":({n:"\n",r:"\r",t:"\t",b:"\b",f:"\f",v:"\v",0:"\0"}[other]??other));
 }
 const uses=[];
 for(const token of source.matchAll(tokens)){
  if(!lexical.isCode(token.index)||decodeIdentifier(token[0])!==requireName||[".","#"].includes(source[previous(token.index-1)]))continue;
  const method=property(token.index+token[0].length);if(!["n","d"].includes(method))continue;
  const projected=source.slice(0,token.index)+`(${token[0]}=${token[0]})`+source.slice(token.index+token[0].length);
  if(Buffer.byteLength(projected)>256*1024)throw Error("Local Default loader use proof exceeds its factory budget");
  try{new Script(`"use strict";(function(${module.params.join(",")}){${projected}})`)}catch{throw Error("Unsupported local Default loader reference context")}
  let shadow=false;try{stable(projected,requireName);shadow=true}catch{}
  if(!shadow)uses.push({method,index:token.index});
 }
 const publications=[...source.matchAll(new RegExp(`(?<![\\w$.])${req}\\.d\\(${exp},\\{`,"gu"))].filter(hit=>lexical.isRoot(hit.index));
 const interops=[...source.matchAll(new RegExp(`(?<![\\w$.])(?<alias>${ID})=${req}\\.n\\(${ID}\\)(?=[,;])`,"gu"))].filter(hit=>lexical.isRoot(hit.index)).map(hit=>hit.index+hit.groups.alias.length+1);
 const expected=[...publications.map(hit=>({method:"d",index:hit.index})),...interops.map(index=>({method:"n",index}))].sort((a,b)=>a.index-b.index);
 if(publications.length!==1||interops.length!==interopCount||JSON.stringify(uses)!==JSON.stringify(expected))throw Error("Unexpected original local Default critical loader method use");
 return Object.freeze(uses.map(use=>Object.freeze(use)));
}
module.exports={assertCriticalLoaderMethodUses};
