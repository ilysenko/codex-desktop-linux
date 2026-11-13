"use strict";
// Scope ownership queries retain complete actual callable context. They never
// reinterpret an arbitrary block as a function or execute supplied source.
const {Script}=require("node:vm"),crypto=require("node:crypto");
const {createJavaScriptLexicalIndex}=require("../../scripts/patches/lib/minified-js.js");
const {assertUnambiguousModelComposerLexicalSource}=require("../../scripts/patches/lib/model-composer-lexical-guard.js");
const ID="[A-Za-z_$][\\w$]*",TOKENS=/(?:\\u(?:\{[0-9a-fA-F]+\}|[0-9a-fA-F]{4})|[$_\p{ID_Start}])(?:\\u(?:\{[0-9a-fA-F]+\}|[0-9a-fA-F]{4})|[$_\u200C\u200D\p{ID_Continue}])*/gu;
const hash=value=>crypto.createHash("sha256").update(value).digest("hex"),decode=text=>text.replace(/\\u(?:\{([0-9a-fA-F]+)\}|([0-9a-fA-F]{4}))/gu,(_,a,b)=>String.fromCodePoint(parseInt(a||b,16)));
const MAX_UNIT=256*1024,MAX_SLASH_FACTORY=1024*1024;
function prepare(source,params,options={}){
 const audited=BOUNDS,maxSourceBytes=options.maxSourceBytes??MAX_UNIT;
 if(![MAX_UNIT,MAX_SLASH_FACTORY].includes(maxSourceBytes)||Buffer.byteLength(source)>maxSourceBytes)throw Error("Factory cap");new Script(`"use strict";function originalFactory(${params.join(",")}){${source}\n}`);
 const lexical=createJavaScriptLexicalIndex(source),pairs=new Map(),reverse=new Map(),stack=[];
 for(let at=0;at<source.length;at++){if(!lexical.isCode(at))continue;const c=source[at];if("([{".includes(c))stack.push([c,at]);else if(")]}".includes(c)){const open=stack.pop();if(!open||"([{".indexOf(open[0])!==")]}".indexOf(c))throw Error("Delimiter mismatch");pairs.set(open[1],at);reverse.set(at,open[1]);}}
 assertUnambiguousModelComposerLexicalSource(source,lexical);
 const next=at=>{while(at<source.length&&!lexical.isCode(at))at++;return at;},previous=at=>{while(at>=0&&!lexical.isCode(at))at--;return at;};
 const trivia=at=>{while(at<source.length){if(/\s/u.test(source[at])){at++;continue;}if(source.startsWith("//",at)){const end=source.slice(at+2).search(/[\r\n\u2028\u2029]/u);at=end<0?source.length:at+2+end;continue;}if(source.startsWith("/*",at)){const end=source.indexOf("*/",at+2);if(end<0)return source.length;at=end+2;continue;}break;}return at;};
 const tokens=[...source.matchAll(TOKENS)].filter(row=>lexical.isCode(row.index)).map(row=>({start:row.index,end:row.index+row[0].length,raw:row[0],name:decode(row[0])})),byEnd=new Map(tokens.map(row=>[row.end,row]));
 const scopes=[],bodyMap=new Map();
 function add(row){const key=row.bodyStart+":"+row.bodyEnd;const old=bodyMap.get(key);if(old){if(row.genuine)Object.assign(old,row);return old;}scopes.push(row);bodyMap.set(key,row);return row;}
 for(const head of source.matchAll(new RegExp(`\\b(?:async\\s+)?function\\s*(?:\\*\\s*)?(?:(?<name>${ID})\\s*)?\\(`,"gu"))){
  const functionAt=head.index+head[0].indexOf("function"),prior=previous(functionAt-1);if(!lexical.isCode(functionAt)||[".","#"].includes(source[prior]))continue;
  const open=head.index+head[0].length-1,close=pairs.get(open),bodyOpen=trivia(close+1),end=pairs.get(bodyOpen);if(close==null||source[bodyOpen]!=="{"||end==null)continue;
  add({start:head.index,end:end+1,parametersStart:open+1,parametersEnd:close,bodyStart:bodyOpen+1,bodyEnd:end,expression:false,genuine:true,kind:"function",selfName:head.groups.name??null,selfNameAt:head.groups.name?source.indexOf(head.groups.name,functionAt+"function".length):null});
 }
 for(const [open,close]of pairs){if(source[open]!=="(")continue;const bodyOpen=trivia(close+1),end=pairs.get(bodyOpen);if(source[bodyOpen]!=="{"||end==null)continue;const prior=byEnd.get(previous(open-1)+1);if(prior&&["if","for","while","switch","with"].includes(prior.name))continue;
  add({start:prior?.start??open,end:end+1,parametersStart:open+1,parametersEnd:close,bodyStart:bodyOpen+1,bodyEnd:end,expression:false,genuine:false,kind:"actual-context-candidate",selfName:null});
 }
 const unknownArrows=[];
 for(const arrow of source.matchAll(/=>/gu)){
  if(!lexical.isCode(arrow.index))continue;const before=previous(arrow.index-1),body=trivia(arrow.index+2);let parameterStart,parameterEnd,start;
  if(source[before]===")"){const open=reverse.get(before);if(open==null)continue;parameterStart=open+1;parameterEnd=before;start=open;}else{const token=byEnd.get(before+1);if(!token)continue;parameterStart=token.start;parameterEnd=token.end;start=token.start;}
  const prior=byEnd.get(previous(start-1)+1);if(prior?.name==="async"&&!/[\r\n\u2028\u2029]/u.test(source.slice(prior.end,start)))start=prior.start;
  if(source[body]==="{"){const end=pairs.get(body);if(end!=null)add({start,end:end+1,parametersStart:parameterStart,parametersEnd:parameterEnd,bodyStart:body+1,bodyEnd:end,expression:false,genuine:true,kind:"arrow",selfName:null});}
  else{const local=source.slice(body,Math.min(source.length,body+8192)),end=audited.arrowExpressionEnd(local,0);if(end<0||end===local.length&&body+end<source.length){unknownArrows.push({start,body});continue;}add({start,end:body+end,parametersStart:parameterStart,parametersEnd:parameterEnd,bodyStart:body,bodyEnd:body+end,expression:true,genuine:true,kind:"arrow",selfName:null});}
 }
 const blocks=[...pairs].filter(([at])=>source[at]==="{").map(([open,end])=>({open,end}));
 const loops=[];
 for(const head of source.matchAll(/\bfor(?:\s+await)?\s*\(/gu)){
  if(!lexical.isCode(head.index)||[".","#"].includes(source[previous(head.index-1)]))continue;const open=head.index+head[0].length-1,close=pairs.get(open);if(close==null)continue;const declaration=audited.loopDeclaration(source.slice(open+1,close));if(!declaration)continue;const body=trivia(close+1);let end;
  if(source[body]==="{")end=(pairs.get(body)??-2)+1;else{const local=source.slice(body,Math.min(source.length,body+8192)),stop=audited.loopBodyEnd(local,0);if(stop<0||stop===local.length&&body+stop<source.length)continue;end=body+stop;}
  if(end>body)loops.push({start:head.index,end,bodyStart:body,bodyEnd:end,declaration});
 }
 let fresh="__scopeLocalBindingFresh";while(source.includes(fresh))fresh+="$";
 return {source,params,maxSourceBytes,lexical,tokens,scopes,blocks,loops,unknownArrows,fresh,pairs,parseCache:new Map(),unitCache:new Map(),queryCache:new Map(),audited};
}
function prove(prepared,name,initializers=[],options={}){
 const resolveOffsets=new Set(options.resolveOffsets??[]);
 const {source,params,lexical,scopes,blocks,loops,fresh}=prepared,stats={scriptProbes:0,cacheHits:0,unknownUnits:0,maxUnitBytes:0},evidence=[],units=new Map();
 const initial=new Set(initializers);for(const at of initializers)if(source.slice(at,at+name.length)!==name)throw Error("Unproven native initializer binder");
 const capturedParams=[...new Set([...params,name])];
 function parse(code){const key=hash(code);if(prepared.parseCache.has(key)){stats.cacheHits++;return prepared.parseCache.get(key);}stats.scriptProbes++;let valid=false;try{new Script(code);valid=true;}catch{}prepared.parseCache.set(key,valid);return valid;}
 function edit(text,changes){let result=text;for(const row of [...changes].sort((a,b)=>b.start-a.start))result=result.slice(0,row.start)+row.value+result.slice(row.end);return result;}
 function unitFor(range,statementOwner=false){
  const choices=scopes.filter(scope=>scope.genuine&&scope.start<=range[0]&&range[1]<=scope.end).sort((a,b)=>(a.end-a.start)-(b.end-b.start));
  for(const scope of choices){if(statementOwner&&scope.expression)continue;const raw=source.slice(scope.start,scope.end),prefix=`"use strict";function scopeOuter(${capturedParams.join(",")}){\n`,variants=scope.kind==="function"&&scope.selfName?[{prefix,suffix:"\n}"}]:[{prefix:prefix+"(",suffix:");\n}"}];
   for(const wrapper of variants){const bytes=Buffer.byteLength(wrapper.prefix+raw+wrapper.suffix);if(bytes>MAX_UNIT)continue;const key=hash(wrapper.prefix+raw+wrapper.suffix);let unit=prepared.unitCache.get(key);if(unit===false)continue;if(!unit){if(!parse(wrapper.prefix+raw+wrapper.suffix)){prepared.unitCache.set(key,false);continue;}unit={key,kind:"actual-callable",start:scope.start,end:scope.end,text:raw,prefix:wrapper.prefix,suffix:wrapper.suffix,owner:scope,map:offset=>offset-scope.start};prepared.unitCache.set(key,unit);}units.set(key,{key,kind:unit.kind,range:[unit.start,unit.end],bytes});stats.maxUnitBytes=Math.max(stats.maxUnitBytes,bytes);return unit;}
  }
  // Context only: stub unrelated genuine callable bodies, preserving headers,
  // parameter defaults and all root declarations. Every original token remains
  // independently covered by the full-factory census below.
  const cuts=scopes.filter(scope=>scope.genuine&&(scope.bodyEnd<=range[0]||range[1]<=scope.bodyStart)).sort((a,b)=>a.bodyStart-b.bodyStart||b.bodyEnd-a.bodyEnd),chosen=[];
  for(const cut of cuts)if(!chosen.some(outer=>outer.bodyStart<=cut.bodyStart&&cut.bodyEnd<=outer.bodyEnd))chosen.push(cut);
  let cursor=0,text="";const mappings=[];for(const cut of chosen){const part=source.slice(cursor,cut.bodyStart),at=text.length;text+=part;mappings.push({start:cursor,end:cut.bodyStart,projected:at});text+=cut.expression?"0":"";cursor=cut.bodyEnd;}const at=text.length;text+=source.slice(cursor);mappings.push({start:cursor,end:source.length,projected:at});
  const map=offset=>{if(offset===source.length)return text.length;const row=mappings.find(row=>row.start<=offset&&offset<row.end);if(!row)throw Error("Context probe entered a stubbed unrelated body");return row.projected+offset-row.start;};
  const prefix=`"use strict";function scopeFactory(${capturedParams.join(",")}){\n`,suffix="\n}";const masks=[];for(const point of initializers){try{const start=map(point);masks.push({start,end:start+name.length,value:fresh+"Initial"});}catch{}}
  const base=edit(text,masks),bytes=Buffer.byteLength(prefix+base+suffix);if(bytes>MAX_UNIT||!parse(prefix+base+suffix)){stats.unknownUnits++;return null;}
  const key=hash(prefix+text+suffix+JSON.stringify(masks)),unit={key,kind:"actual-factory-context-shell",start:0,end:source.length,text,prefix,suffix,owner:null,map,masks,mappings,cuts:chosen.map(row=>[row.bodyStart,row.bodyEnd])};units.set(key,{key,kind:unit.kind,range:[0,source.length],bytes,cuts:unit.cuts,mappings});stats.maxUnitBytes=Math.max(stats.maxUnitBytes,bytes);return unit;
 }
 function render(unit,changes){const edits=[...(unit.masks??[])];for(const row of changes)edits.push({start:unit.map(row.start),end:unit.map(row.end),value:row.value});const body=edit(unit.text,edits),code=unit.prefix+body+unit.suffix;if(Buffer.byteLength(code)>MAX_UNIT){stats.unknownUnits++;return null;}return code;}
 function compare(unit,kind,key,make){if(!unit)return false;const cacheKey=JSON.stringify([unit.key,kind,key,name]);if(prepared.queryCache.has(cacheKey))return prepared.queryCache.get(cacheKey);const baseline=render(unit,[]),freshCode=render(unit,make(fresh)),nameCode=render(unit,make(name));const result=!!baseline&&!!freshCode&&!!nameCode&&parse(baseline)&&parse(freshCode)&&!parse(nameCode);prepared.queryCache.set(cacheKey,result);if(result)evidence.push({kind,key,unit:unit.key,baseline:hash(baseline),fresh:hash(freshCode),conflict:hash(nameCode)});return result;}
 function parameterOwns(scope){const unit=unitFor([scope.start,scope.end]);return compare(unit,"parameter-binding",[scope.parametersStart,scope.parametersEnd],binding=>[{start:scope.bodyStart,end:scope.bodyEnd,value:scope.expression?`{\nlet ${binding};\n}`:`\nlet ${binding};\n`}]);}
 function varScope(scope){if(scope.genuine)return true;const unit=unitFor([scope.start,scope.end],true);if(!unit)return false;const outerEnd=unit.owner?.bodyEnd??source.length;if(scope.bodyEnd===outerEnd)return false;const key=JSON.stringify([unit.key,"var-scope",scope.bodyStart,scope.bodyEnd]);if(prepared.queryCache.has(key))return prepared.queryCache.get(key);
  const separate=render(unit,[{start:scope.bodyEnd,end:scope.bodyEnd,value:`\n;var ${fresh}Inner;\n`},{start:outerEnd,end:outerEnd,value:`\n;let ${fresh}Outer;\n`}]),same=render(unit,[{start:scope.bodyEnd,end:scope.bodyEnd,value:`\n;var ${fresh}Inner;\n`},{start:outerEnd,end:outerEnd,value:`\n;let ${fresh}Inner;\n`}]);const result=!!separate&&!!same&&parse(separate)&&parse(same);prepared.queryCache.set(key,result);return result;
 }
 function bodyOwns(scope){if(scope.expression||!varScope(scope))return false;return compare(unitFor([scope.start,scope.end]),"function-body-binding",[scope.bodyStart,scope.bodyEnd],binding=>[{start:scope.bodyEnd,end:scope.bodyEnd,value:`\n;let ${binding};\n`}]);}
 function blockOwns(block){return compare(unitFor([block.open,block.end+1]),"actual-block-lexical-binding",[block.open,block.end],binding=>[{start:block.end,end:block.end,value:`\n;var ${binding};\n`}]);}
 function loopOwns(loop){return compare(unitFor([loop.start,loop.end]),"actual-loop-lexical-binding",[loop.start,loop.end],binding=>[{start:loop.bodyStart,end:loop.bodyEnd,value:`{\nvar ${binding};\n}`}]);}
 function previous(at){while(at>=0&&!lexical.isCode(at))at--;return at;}function next(at){while(at<source.length&&!lexical.isCode(at))at++;return at;}
 const refs=prepared.tokens.filter(row=>row.name===name),owned=[],unowned=[],nonBinding=[];
 for(const ref of refs){
  if(initial.has(ref.start)){owned.push({...ref,reason:"proven-native-initializer"});continue;}
  const before=previous(ref.start-1),after=next(ref.end),spread=source.slice(Math.max(0,before-2),before+1)==="...";
  if(([".","#"].includes(source[before])&&!spread)||source[after]===":"){nonBinding.push({...ref,reason:"member-key-or-label"});continue;}
  let wordEnd=before+1,wordStart=before;while(wordStart>=0&&lexical.isCode(wordStart)&&/[\w$]/u.test(source[wordStart]))wordStart--;wordStart++;const priorWord=source.slice(wordStart,wordEnd);if(["break","continue"].includes(priorWord)&&!/[\r\n\u2028\u2029]/u.test(source.slice(wordEnd,ref.start))){nonBinding.push({...ref,reason:"label-reference"});continue;}
  const receiver=[".","["].includes(source[after])||source.slice(after,after+2)==="?.";
  if(receiver&&!resolveOffsets.has(ref.start)){unowned.push({...ref,replacement:"(0)",reason:"readonly-receiver"});continue;}
  const enclosing=scopes.filter(scope=>(scope.parametersStart<=ref.start&&ref.start<scope.parametersEnd)||(scope.bodyStart<=ref.start&&ref.start<scope.bodyEnd)).sort((a,b)=>(a.end-a.start)-(b.end-b.start));let witness=null;
  for(const scope of enclosing){if(parameterOwns(scope)){witness={reason:"actual-parameter-binding",range:[scope.parametersStart,scope.bodyEnd]};break;}if(scope.bodyStart<=ref.start&&ref.start<scope.bodyEnd&&bodyOwns(scope)){witness={reason:"actual-function-body-binding",range:[scope.bodyStart,scope.bodyEnd]};break;}}
  if(!witness)for(const block of blocks.filter(row=>row.open<ref.start&&ref.start<row.end).sort((a,b)=>(a.end-a.open)-(b.end-b.open))){
   let end=previous(block.open-1)+1,start=end-1;while(start>=0&&lexical.isCode(start)&&/[\w$]/u.test(source[start]))start--;start++;
   const staticScope=source.slice(start,end)==="static"?{start,end:block.end+1,bodyStart:block.open+1,bodyEnd:block.end,expression:false,genuine:false}:null;
   if(staticScope&&bodyOwns(staticScope)){witness={reason:"actual-static-block-var-binding",range:[block.open,block.end]};break;}
   if(blockOwns(block)){witness={reason:"actual-block-lexical-binding",range:[block.open,block.end]};break;}
  }
  if(!witness)for(const loop of loops.filter(row=>row.start<=ref.start&&ref.start<row.end).sort((a,b)=>(b.end-b.start)-(a.end-a.start))){if(loopOwns(loop)){witness={reason:"actual-loop-lexical-binding",range:[loop.start,loop.end]};break;}}
  if(witness)owned.push({...ref,...witness});else unowned.push({...ref,replacement:receiver?"(0)":"0",reason:receiver?"resolved-root-receiver":"unowned-expression-or-target"});
 }
 const edits=[];for(const point of initializers)edits.push({start:point,end:point+name.length,value:fresh+"Initial"});for(const row of unowned)edits.push({start:row.start,end:row.end,value:row.replacement});const projected=edit(source,edits),code=`"use strict";function readonlyFactory(${capturedParams.join(",")}){${projected}\n}`;if(Buffer.byteLength(code)>prepared.maxSourceBytes)throw Error("Final factory proof cap");const stable=parse(code);
 return {stable,sourceSha256:hash(source),target:name,owned,unowned,nonBinding,units:[...units.values()],evidence,stats,summary:{target:name,sourceBytes:Buffer.byteLength(source),refs:refs.length,owned:owned.length,unowned:unowned.length,nonBinding:nonBinding.length,units:units.size,stable,...stats}};
}

// Audited syntax bounds from rspack-export-publication.js. Inputs at the call
// sites below are bounded local slices; these helpers are never owner proof.
const lexicalViews=new Map();
function lexical(body){let value=lexicalViews.get(body);if(value)return value;value=createJavaScriptLexicalIndex(body);if(lexicalViews.size===12)lexicalViews.delete(lexicalViews.keys().next().value);lexicalViews.set(body,value);return value;}
function scopeParses(body, parameters, suffix = "") {
  try { new Script(`"use strict";async function publicationScopeProbe(${parameters}){\n${body}\n${suffix}\n}`); return true; }
  catch { return false; }
}
function code(body, index) { return lexical(body).isCode(index); }
function findMatchingBrace(body, open) { return lexical(body).matchingBrace(open); }
function delimiterEnd(body, open) {
  const pairs = { "(": ")", "[": "]", "{": "}" }, stack = [];
  if (!pairs[body[open]] || !code(body, open)) return -1;
  for (let index = open; index < body.length; index++) {
    if (!code(body, index)) continue;
    if (pairs[body[index]]) stack.push(pairs[body[index]]);
    else if (")]}".includes(body[index])) {
      if (stack.pop() !== body[index]) return -1;
      if (stack.length === 0) return index;
    }
  }
  return -1;
}
function nextCode(body, index) {
  while (index < body.length && !code(body, index)) index++;
  return index;
}
function loopDeclaration(header) {
  const declaration = /^\s*(?:let|const)\b\s*/u.exec(header);
  if (!declaration) return null;
  for (let index = declaration[0].length; index < header.length; index++) {
    if (!code(header, index)) continue;
    if ("([{".includes(header[index])) {
      index = delimiterEnd(header, index);
      if (index < 0) return null;
      continue;
    }
    const parameters = header.slice(declaration[0].length, index).trim();
    if (header[index] === ";") return parameters;
    if (/^(?:in|of)\b/u.test(header.slice(index)) && !/[\w$.]/u.test(header[index - 1]) &&
        parameters && scopeParses("", parameters)) return parameters;
  }
  return null;
}
function loopBodyEnd(body, start) {
  if (body[start] === "{") {
    const end = findMatchingBrace(body, start);
    return end > start ? end + 1 : -1;
  }
  const conditional = /^if\s*\(/u.exec(body.slice(start));
  if (conditional) {
    const close = delimiterEnd(body, start + conditional[0].length - 1);
    if (close < start) return -1;
    const end = loopBodyEnd(body, nextCode(body, close + 1));
    if (end < 0) return -1;
    const following = nextCode(body, end);
    return /^else\b/u.test(body.slice(following)) ? loopBodyEnd(body, nextCode(body, following + 4)) : end;
  }
  const iteration = /^for(?:\s+await)?\s*\(/u.exec(body.slice(start));
  if (iteration) {
    const close = delimiterEnd(body, start + iteration[0].length - 1);
    return close < start ? -1 : loopBodyEnd(body, nextCode(body, close + 1));
  }
  // Native single-statement loops use expressions or an if/return branch.
  // Balance the entire expression so a function/object value cannot end it.
  const jump = /^(?:return|throw)\b/u.exec(body.slice(start));
  const expressionStart = start + (jump?.[0].length ?? 0);
  const trivia = /^(?:\s|\/\*[\s\S]*?\*\/|\/\/[^\r\n\u2028\u2029]*)*/u.exec(body.slice(expressionStart))[0];
  if (jump?.[0] === "return" && /[\r\n\u2028\u2029]/u.test(trivia)) {
    return expressionStart;
  }
  let end = start;
  for (; end < body.length; end++) {
    if (!code(body, end)) continue;
    if ("([{".includes(body[end])) {
      end = delimiterEnd(body, end);
      if (end < 0) return -1;
    } else if (body[end] === ";" || body[end] === "}") break;
  }
  const expression = body.slice(expressionStart, end);
  if (!(jump?.[0] === "return" && expression.trim() === "") && !scopeParses(`return (${expression});`, "")) return -1;
  return end + Number(body[end] === ";");
}
function arrowExpressionEnd(body, start) {
  const stack = [], pairs = { ")": "(", "]": "[", "}": "{" };
  const tokens = /[()[\]{},;]/gu;
  tokens.lastIndex = start;
  let token;
  while ((token = tokens.exec(body)) != null) {
    const index = token.index, value = token[0];
    if (!code(body, index)) continue;
    if ("([{".includes(value)) { stack.push(value); continue; }
    if (stack.length && pairs[value] === stack.at(-1)) { stack.pop(); continue; }
    if (stack.length === 0 && scopeParses(`return (${body.slice(start, index)});`, "")) return index;
  }
  return scopeParses(`return (${body.slice(start)});`, "") ? body.length : -1;
}
const BOUNDS={arrowExpressionEnd,loopDeclaration,loopBodyEnd};

module.exports={prepare,prove,MAX_UNIT,MAX_SLASH_FACTORY};
