"use strict";
const fs = require("node:fs"), path = require("node:path"), { Script } = require("node:vm");
const scope = require("./remote-copy-scope.js"), contract = require("./auto-connect-contracts.js");
const { inspectAppServicesFacade } = require("./renderer-remote-connections-owners.js");
const { createJavaScriptLexicalIndex, escapeRegExp: q } = require("../../scripts/patches/lib/minified-js.js");
const { inspectMainRequestSites, hasStableEagerMainBinding: stable } = require("../../scripts/patches/lib/main-request-sites.js");
const { mainProcessFactories } = require("../../scripts/patches/lib/main-process-factories.js");
const { findUniqueRspackModuleCopies } = require("../../scripts/patches/lib/rspack-module-assets.js");
const { findMainProcessChunks, patchWebviewAssets } = require("../../scripts/patches/lib/assets.js");
const ID = "[A-Za-z_$][\\w$]*", MAX_SELECTED_BYTES = 16 * 1024 * 1024;
const FIXED = new Set("this super class extends constructor get set async await function return let var const if else throw new true false null undefined void typeof for try catch finally delete in instanceof Error AbortController WeakMap Map Promise Symbol Object Array Number Math String Date JSON structuredClone window document navigator".split(" "));
function fail(reason) { throw Error("Remote auto-connect contract: " + reason); }
function one(rows, reason) { if (rows.length !== 1) fail(reason);return rows[0]; }
function parses(text) { try { new Script(text);return true; } catch { return false; } }
// Finite native syntax templates. Repeated local tokens bind the same role;
// property names and all opaque bytes remain literal. This is not an AST/CFG.
function expression(text, seeds = {}, whole = false) {
  const lex = createJavaScriptLexicalIndex(text), fixed = new Set(FIXED), names = new Map(), roles = [], used = new Set();
  const classBodies = [...text.matchAll(/\bclass(?:\s+[A-Za-z_$][\w$]*)?(?:\s+extends\s+[A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)*)?\s*\{/gu)]
    .filter(row => lex.isCode(row.index)).map(row => {
      const start = row.index + row[0].length, closing = lex.matchingBrace(start - 1);
      const end = closing < 0 ? text.length : closing;
      return { start, end, lexical: createJavaScriptLexicalIndex(text.slice(start, end)) };
    });
  let out = whole ? "^" : "", cursor = 0;
  for (const token of text.matchAll(/[A-Za-z_$][\w$]*/gu)) {
    const name = token[0], at = token.index;
    const before=text.slice(0,at),after=text.slice(at+name.length);
    // A statement assignment inside a function is an alpha-renamable binding.
    // Literal field names belong to the root member list of a class template.
    const field = /[;{]\s*$/u.test(before) && /^[;=]/u.test(after) &&
      classBodies.some(body => body.start <= at && at < body.end && body.lexical.isRoot(at - body.start));
    const method=/^(?:\s*)\(/u.test(after)&&(/[;{}]\s*(?:(?:async|get|set)\s+)*$/u.test(before)||/,\s*(?:async|get|set)\s+$/u.test(before));
    const member=text[at-1]==="."&&text.slice(at-3,at)!=="...";
    const key=/[,{]\s*$/u.test(before)&&/^\s*:/u.test(after);
    if (!lex.isCode(at) || fixed.has(name) || field || method || member || key) continue;
    used.add(name);out += q(text.slice(cursor, at));
    if (seeds[name] != null) out += q(seeds[name]);
    else if (names.has(name)) out += `\\k<r${names.get(name)}>`;
    else { names.set(name, roles.length);roles.push(name);out += `(?<r${roles.length - 1}>${ID})`; }
    cursor = at + name.length;
  }
  return { regex: new RegExp(out + q(text.slice(cursor)) + (whole ? "$" : ""), "gu"), roles, seeds, used };
}
function bindings(pattern, row) {
  const result={ ...pattern.seeds, ...Object.fromEntries(pattern.roles.map((name, i) => [name, row.groups["r" + i]])) };
  const values=[...pattern.used].map(name=>result[name]);
  if(new Set(values).size!==values.length)fail("aliased native binding roles");return result;
}
function exact(text, template, seeds = {}) {
  const pattern = expression(template, seeds, true), row = pattern.regex.exec(text);
  if (!row) fail("divergent bounded native policy");return bindings(pattern, row);
}
function slots(copy, template, seeds = {}, owner = null) {
  const pattern = expression(template, seeds), body = owner?.source ?? copy.moduleSource, offset = owner?.start ?? 0, lex = scope.context(copy).lexical;
  return [...body.matchAll(pattern.regex)].filter(row => lex.isCode(offset + row.index)).map(row => ({ at: offset + row.index, text: row[0], roles: bindings(pattern, row) }));
}
function rootStatement(body, at, parameters = "") {
  const lex = createJavaScriptLexicalIndex(body);
  if (!lex.isCode(at) || !lex.isRoot(at) || !parses(`async function nativeAutoConnectRoot(${parameters}){${body.slice(0, at)}\nconst __autoConnectSite=0;}`)) fail("non-root native statement");
}
function rootClass(factory, name) {
  const lex = createJavaScriptLexicalIndex(factory.body), rows = [...factory.body.matchAll(new RegExp(`\\bclass ${q(name)}(?=[ {])`, "gu"))].filter(row => lex.isCode(row.index));
  const row = one(rows, "unique native class " + name);rootStatement(factory.body, row.index, factory.parameters);
  const open = factory.body.indexOf("{", row.index), end = lex.matchingBrace(open);
  if (end < open || Buffer.byteLength(factory.body.slice(row.index,end+1)) > 256 * 1024) fail("bounded native class");
  if (factory.parameters.includes(name) || !stable(factory.body, name)) fail("eager class replacement");
  return { name, start: row.index, open, end: end + 1, source: factory.body.slice(row.index, end + 1), body: factory.body.slice(open + 1, end) };
}
function trivia(text, at) {
  for (;;) {
    if (/\s/u.test(text[at]??"")) { at++;continue; }
    if (text.startsWith("/*",at)) { const end=text.indexOf("*/",at+2);if(end<0)fail("incomplete member comment");at=end+2;continue; }
    if (text.startsWith("//",at)) { at+=2;while(at<text.length&&!/[\r\n\u2028\u2029]/u.test(text[at]))at++;continue; }
    return at;
  }
}
function delimiter(text, lex, open) {
  const stack=[],pairs={")":"(","]":"[","}":"{"};
  if(!"([{".includes(text[open]))fail("member opening delimiter");
  for(let at=open;at<text.length;at++) {
    if(!lex.isCode(at))continue;const ch=text[at];
    if("([{".includes(ch))stack.push(ch);
    else if(pairs[ch]) { if(stack.pop()!==pairs[ch])fail("mismatched member delimiter");if(!stack.length)return at; }
  }
  fail("incomplete member delimiter");
}
function literalKey(text) {
  const quote=text[0];if(!['"',"'","`"].includes(quote)||text.at(-1)!==quote)fail("nonliteral member key");
  let value="";
  for(let at=1;at<text.length-1;at++) {
    let ch=text[at];if(quote==="`"&&ch==="$"&&text[at+1]==="{")fail("dynamic template member key");
    if(ch===quote)fail("nonliteral computed member expression");
    if(ch!=="\\") { value+=ch;continue; }
    ch=text[++at];if(ch==="\r"||ch==="\n") { if(ch==="\r"&&text[at+1]==="\n")at++;continue; }
    const escapes={n:"\n",r:"\r",t:"\t",b:"\b",f:"\f",v:"\v","0":"\0"};
    if(Object.hasOwn(escapes,ch)){value+=escapes[ch];continue;}
    if(ch==="x"||ch==="u") {
      let digits;if(ch==="u"&&text[at+1]==="{") { const end=text.indexOf("}",at+2);if(end<0)fail("member unicode escape");digits=text.slice(at+2,end);at=end; }
      else { const count=ch==="x"?2:4;digits=text.slice(at+1,at+count+1);at+=count; }
      if(!/^[\da-fA-F]+$/u.test(digits)||parseInt(digits,16)>0x10ffff)fail("member key escape");value+=String.fromCodePoint(parseInt(digits,16));continue;
    }
    value+=ch;
  }
  return value;
}
const MEMBER_ID=String.raw`(?:[A-Za-z_$]|\\u(?:\{[\da-fA-F]+\}|[\da-fA-F]{4}))(?:[\w$]|\\u(?:\{[\da-fA-F]+\}|[\da-fA-F]{4}))*`;
function propertyKey(text, lex, at) {
  at=trivia(text,at);const start=at,ch=text[at];
  if(ch==="[") {
    const end=delimiter(text,lex,at),inside=text.slice(at+1,end).trim();let name,symbol=false;
    if(['"',"'","`"].includes(inside[0]))name=literalKey(inside);
    else if(/^\d+(?:\.\d+)?$/u.test(inside))name=String(Number(inside));
    else if(/^Symbol\.(?:dispose|asyncDispose|toStringTag|iterator|asyncIterator)$/u.test(inside)) { name=inside;symbol=true; }
    else fail("unknown computed member authority");
    return {start,end:end+1,name,form:"computed",symbol};
  }
  if(ch==='"'||ch==="'") {
    let end=at+1;for(;end<text.length;end++){if(text[end]==="\\")end++;else if(text[end]===ch)break;}
    if(end===text.length)fail("incomplete quoted member key");return {start,end:end+1,name:literalKey(text.slice(at,end+1)),form:"quoted"};
  }
  let privateName=false;if(ch==="#"){privateName=true;at++;}
  const word=new RegExp(`^${MEMBER_ID}`,"u").exec(text.slice(at));
  if(word) {
    const name=word[0].replace(/\\u(?:\{([\da-fA-F]+)\}|([\da-fA-F]{4}))/gu,(_,a,b)=>String.fromCodePoint(parseInt(a??b,16)));
    return {start,end:at+word[0].length,name:(privateName?"#":"")+name,form:privateName?"private":"bare"};
  }
  const number=/^(?:0[xX][\da-fA-F]+|\d+(?:\.\d+)?(?:[eE][+-]?\d+)?)/u.exec(text.slice(at));
  if(number)return {start,end:at+number[0].length,name:String(Number(number[0])),form:"number"};
  fail("unsupported member key");
}
function memberHead(text,lex,start) {
  let key=propertyKey(text,lex,start),at=trivia(text,key.end),kind="method",isStatic=false,isAsync=false,generator=false;
  if(key.form==="bare"&&key.name==="static"&&!["(","=",";",undefined].includes(text[at])) {
    if(text[at]==="{")fail("unsupported static class block");isStatic=true;key=propertyKey(text,lex,at);at=trivia(text,key.end);
  }
  if(key.form==="bare"&&["async","get","set"].includes(key.name)&&!["(","=",";",undefined].includes(text[at])&&
      !(key.name==="async"&&/[\r\n\u2028\u2029]/u.test(text.slice(key.end,at)))) {
    if(key.name==="async")isAsync=true;else kind=key.name;
    if(text[at]==="*"){generator=true;at=trivia(text,at+1);}
    key=propertyKey(text,lex,at);at=trivia(text,key.end);
  }
  return {start,key,at,kind,isStatic,isAsync,generator};
}
const memberInventories=new WeakMap();
function classMembers(owner) {
  if(memberInventories.has(owner))return memberInventories.get(owner);
  const text=owner.body,lex=createJavaScriptLexicalIndex(text),rows=[];
  // Class-field expressions are checked as expressions only. Replace private
  // sigils in this syntax-only projection so later declarations do not affect
  // compilation; no class, initializer or upstream expression is evaluated.
  const publicText=text.replace(/#/gu,(ch,at)=>lex.isCode(at)?"_":ch);
  for(let cursor=0;cursor<text.length;) {
    cursor=trivia(text,cursor);if(cursor===text.length)break;if(text[cursor]===";"){cursor++;continue;}
    let head;if(text[cursor]==="*"){head=memberHead(text,lex,trivia(text,cursor+1));head.start=cursor;head.generator=true;}
    else head=memberHead(text,lex,cursor);
    const {key}=head;let at=head.at,end,open=null,parameters=null;
    if(text[at]==="(") {
      const close=delimiter(text,lex,at);parameters=text.slice(at+1,close);open=trivia(text,close+1);
      if(text[open]!=="{")fail("native class member body");end=lex.matchingBrace(open)+1;if(end<=open)fail("class member body bounds");
    } else {
      if(head.kind!=="method"||head.isAsync||head.generator)fail("wrong class field kind");head.kind="field";
      if(text[at]==="=") {
        const expressionStart=at+1;end=expressionStart;
        for(;end<text.length;end++) {
          if(!lex.isCode(end))continue;
          if("([{".includes(text[end])){end=delimiter(text,lex,end);continue;}
          if(text[end]===";")break;
        }
        const initializer=publicText.slice(expressionStart,end);
        if(!parses(`class NativeFieldProbe extends Object{check(){return (${initializer});}}`))fail("unsupported class field initializer boundary");
      } else {
        end=at;
        if(at<text.length&&text[at]!==";"&&!/[\r\n\u2028\u2029]/u.test(text.slice(key.end,at)))fail("class field boundary");
      }
      if(text[end]===";")end++;
    }
    rows.push({...head,end,open,parameters,source:text.slice(head.start,end),body:open==null?null:text.slice(open+1,end-1)});cursor=end;
  }
  memberInventories.set(owner,rows);return rows;
}
function method(owner, name, async = null) {
  const row=one(classMembers(owner).filter(row=>row.key.name===name),"unique native class member "+name);
  if(row.kind!=="method"||row.key.form!=="bare"||row.isStatic||row.generator||async===true&&!row.isAsync)fail("wrong native member kind "+name);
  return {source:row.source,body:row.body,parameters:row.parameters,at:owner.open+1+row.start};
}
function field(owner,name) {
  const row=one(classMembers(owner).filter(row=>row.key.name===name),"unique native instance field "+name);
  if(row.kind!=="field"||row.key.form!=="bare"||row.isStatic||row.source!==name+";")fail("wrong native instance field "+name);
}
function thisFieldWrites(owner,name,member=null) {
  const text=owner.body,lex=createJavaScriptLexicalIndex(text),rows=[],operator=/^(?:\+\+|--|(?:\?\?|\|\||&&|\*\*|<<|>>>|>>|[+*/%&|^\-])?=(?!=|>))/u;
  function previousCode(at) {
    while (at >= 0 && !lex.isCode(at)) at--;
    return at;
  }
  function deletePrefix(start) {
    let before = previousCode(start - 1);
    const parentheses = [];
    while (text[before] === "(") {
      parentheses.push(before);
      before = previousCode(before - 1);
    }
    const keywordEnd = before + 1;
    while (before >= 0 && lex.isCode(before) && /[\w$]/u.test(text[before])) before--;
    if (text.slice(before + 1, keywordEnd) !== "delete" || text[previousCode(before)] === ".") return null;
    return parentheses;
  }
  function closesParenthesis(open, at) {
    return text[at] === ")" && delimiter(text, lex, open) === at;
  }
  function deletesTarget(parentheses, receiverParentheses, end) {
    if (parentheses === null) return false;
    let after = trivia(text, end);
    for (const open of parentheses.slice(receiverParentheses)) {
      if (!closesParenthesis(open, after)) return false;
      after = trivia(text, after + 1);
    }
    return !/^(?:\.|\[|\(|\?\.|`)/u.test(text.slice(after));
  }
  function selected(at) {
    at=trivia(text,at);let key,end;
    if(text.startsWith("?.",at))at=trivia(text,at+2);
    else if(text[at]===".")at=trivia(text,at+1);
    else if(text[at]!=="[")return null;
    if(text[at]!=="["){key=propertyKey(text,lex,at);end=key.end;}
    else if(text[at]==="[") {
      end=delimiter(text,lex,at)+1;
      try{key=propertyKey(text,lex,at);}catch{key={name:null};}
    }
    return {key,end};
  }
  for(const token of text.matchAll(/(?<![\w$.])this(?![\w$])/gu)) {
    if (!lex.isCode(token.index)) continue;
    const parentheses = deletePrefix(token.index);
    let receiverEnd = trivia(text, token.index + 4);
    let receiverParentheses = 0;
    while (parentheses !== null && receiverParentheses < parentheses.length &&
        closesParenthesis(parentheses[receiverParentheses], receiverEnd)) {
      receiverEnd = trivia(text, receiverEnd + 1);
      receiverParentheses++;
    }
    const first = selected(receiverEnd);
    if (!first) continue;
    let target=first,unknown=first.key.name==null;
    if(member!=null) {
      if(!unknown&&first.key.name!==name)continue;
      target=selected(first.end);if(!target)continue;unknown||=target.key.name==null;
      if(!unknown&&target.key.name!==member)continue;
    } else if(!unknown&&first.key.name!==name)continue;
    const after=trivia(text,target.end),before=text.slice(0,token.index).replace(/\s+$/u,"");
    if(!operator.test(text.slice(after))&&!before.endsWith("++")&&!before.endsWith("--")&&!deletesTarget(parentheses,receiverParentheses,target.end))continue;
    if(unknown)fail("unknown computed owned-field write");rows.push(token.index);
  }
  return rows;
}
function ambientSymbol(factory,owners) {
  if(!owners.some(owner=>classMembers(owner).some(row=>row.key.symbol)))return;
  if(!parses(`function NativeSymbolScope(${factory.parameters}){${factory.body}\nlet Symbol;}`)||!stable(factory.body,"Symbol"))fail("captured Symbol member authority");
}
function objectParts(text,offset=0) {
  const lex=createJavaScriptLexicalIndex(text),rows=[];let cursor=0;
  for(let at=0;at<=text.length;at++) {
    if(at<text.length&&!lex.isCode(at))continue;
    if(at===text.length||text[at]===",") {
      let left=cursor,right=at;while(/\s/u.test(text[left]??""))left++;while(right>left&&/\s/u.test(text[right-1]))right--;
      if(left<right)rows.push({start:offset+left,end:offset+right,text:text.slice(left,right)});cursor=at+1;continue;
    }
    if("([{".includes(text[at]))at=delimiter(text,lex,at);
  }
  return rows;
}
function objectKey(text) {
  const lex=createJavaScriptLexicalIndex(text);let start=trivia(text,0);if(text[start]==="*")start=trivia(text,start+1);
  let key=propertyKey(text,lex,start),at=trivia(text,key.end);
  if(key.form==="bare"&&["get","set","async"].includes(key.name)&&![":","(",undefined].includes(text[at])) {
    if(text[at]==="*")at=trivia(text,at+1);key=propertyKey(text,lex,at);
  }
  if(key.symbol)fail("unsupported symbol object key");return key.name;
}
function maybeExact(text,template,seeds={}) {
  const pattern=expression(template,seeds,true),row=pattern.regex.exec(text);return row?bindings(pattern,row):null;
}
function requireEagerConstructorInitialization(ctor, at, description) {
  const prefix = ctor.body.slice(0, at).replace(/,$/u, ";");
  if (!parses(`function nativeAutoConnectConstructor(${ctor.parameters}){${prefix}\nconst __beforeConstruction=0;}`)) {
    fail("conditional " + description + " construction");
  }
  const lexicalIndex = createJavaScriptLexicalIndex(ctor.body);
  for (const exit of ctor.body.slice(0, at).matchAll(/(?<![\w$.])(?:return|throw)\b/gu)) {
    if (!lexicalIndex.isCode(exit.index) || !lexicalIndex.isRoot(exit.index)) continue;
    const beforeExit = ctor.body.slice(0, exit.index);
    if (parses(`function nativeAutoConnectConstructorExit(${ctor.parameters}){${beforeExit}\nconst __exitProbe=0;}`)) {
      fail(description + " construction after exit");
    }
  }
}
function returnedServiceAuthority(factory,host,ctor,owner,parameter,objectOpen,objectClose,pubAt,pubText) {
  const entries=objectParts(owner.body.slice(objectOpen+1,objectClose),objectOpen+1),target=one(entries.filter(row=>row.start===pubAt-4&&row.text==="...{"+pubText),"direct returned remoteConnections spread"),targetIndex=entries.indexOf(target);
  let projection=null,decls=null,visualization=null;const systemUses=new Map();
  function systemServices(name,at) {
    if(!projection) {
      let prefix="__AutoConnectMainLocal";while(owner.body.includes(prefix))prefix+="$";
      projection={params:[prefix+"M",prefix+"E",prefix+"R"],moduleSource:owner.body,start:0};decls=rootLets(projection);
    }
    const row=one(decls.filter(row=>row.text.startsWith(name+"=")),"native fixed-key service spread declaration");
    exact(row.text,contract.mainSystemServicesInitializer,{I:name});
    const withoutInitializer=owner.body.slice(0,row.start)+name+owner.body.slice(row.end);
    if(!stable(withoutInitializer,name))fail("rewritten fixed-key service spread");
    const known=systemUses.get(name)??{row,uses:[]};known.uses.push({start:at,end:at+name.length});systemUses.set(name,known);
  }
  function visualizationServices(expr) {
    if(!maybeExact(expr,contract.mainVisualizationSpread,{e:parameter}))return false;
    if(visualization)return true;
    field(host,"visualizations");const lex=createJavaScriptLexicalIndex(ctor.body),pattern=expression(contract.mainVisualizationConstruction),row=one([...ctor.body.matchAll(pattern.regex)].filter(row=>lex.isCode(row.index)&&lex.isRoot(row.index)),"live fixed-key visualization service construction"),roles=bindings(pattern,row);
    requireEagerConstructorInitialization(ctor, row.index, "visualization");
    const provider=rootClass(factory,roles.epe);exact(provider.source,contract.mainVisualizationOwner,{epe:provider.name});
    if(!parses(`({${ctor.source.slice(0,-1)};let ${provider.name};}})`)||!stable(ctor.body,provider.name))fail("captured visualization service producer");
    if(thisFieldWrites(host,"visualizations").length!==1||thisFieldWrites(host,"visualizations","createServices").length)fail("rewritten visualization service producer");
    visualization=provider;return true;
  }
  function safeSpread(expr,at,depth=0) {
    if(depth>16)fail("returned spread depth");
    if(expr.startsWith("{")) {
      const lex=createJavaScriptLexicalIndex(expr),close=lex.matchingBrace(0);if(close!==expr.length-1)fail("unknown returned literal spread");
      for(const row of objectParts(expr.slice(1,-1),at+1)) {
        if(row.text.startsWith("..."))safeSpread(row.text.slice(3),row.start+3,depth+1);
        else if(objectKey(row.text)==="remoteConnections")fail("returned spread overrides remoteConnections");
      }
      return;
    }
    if(contract.mainReturnedConditionalSpreads.some(template=>maybeExact(expr,template)))return;
    if(visualizationServices(expr))return;
    if(new RegExp(`^${ID}$`,"u").test(expr)){systemServices(expr,at);return;}
    fail("unknown later returned service spread");
  }
  for(const[index,row]of entries.entries()) {
    if(row===target)continue;
    if(row.text.startsWith("...")) { if(index>targetIndex)safeSpread(row.text.slice(3),row.start+3); }
    else if(objectKey(row.text)==="remoteConnections")fail("duplicate returned remoteConnections property");
  }
  const ownerLex=createJavaScriptLexicalIndex(owner.body);
  for(const[name,known]of systemUses) for(const token of owner.body.matchAll(new RegExp(`(?<![\\w$.])${q(name)}(?![\\w$])`,"gu"))) {
    if(!ownerLex.isCode(token.index))continue;
    if(known.row.start<=token.index&&token.index<known.row.end||known.uses.some(use=>use.start===token.index&&use.end===token.index+name.length))continue;
    fail("unowned fixed-key service object use");
  }
  return visualization;
}
function collidingRootFunction(body, names) {
  const lex=createJavaScriptLexicalIndex(body), trivia=at=>{
    for (;;) {
      if (/\s/u.test(body[at]??"")) {at++;continue;}
      if(body.startsWith("/*",at)){const end=body.indexOf("*/",at+2);if(end<0)fail("root function-head comment");at=end+2;continue;}
      if(body.startsWith("//",at)){at+=2;while(at<body.length&&!/[\r\n\u2028\u2029]/u.test(body[at]))at++;continue;}
      return at;
    }
  };
  for(const token of body.matchAll(/\bfunction\b/gu)){
    if(!lex.isCode(token.index)||!lex.isRoot(token.index))continue;
    let at=trivia(token.index+8);if(body[at]==="*")at=trivia(at+1);
    const name=new RegExp(`^${ID}`,"u").exec(body.slice(at))?.[0];
    if(name&&names.includes(name)&&body[trivia(at+name.length)]==="(")return true;
  }
  return false;
}
const mainImportFrames = new WeakMap();
function mainImportFrame(factory) {
  const body = factory.body;
  const parameters = factory.parameters.join(",");
  const cached = mainImportFrames.get(factory);
  if (cached?.body === body && cached.parameters === parameters) return cached;
  const lexical = createJavaScriptLexicalIndex(body);
  const supportedHeads = new Set();
  for (const head of body.matchAll(/(?:^|[;}])\s*(?<kind>var|let|const)\s+/gu)) {
    supportedHeads.add(head.index + head[0].lastIndexOf(head.groups.kind));
  }
  const heads = [];
  for (const word of body.matchAll(/\b(var|let|const)\b/gu)) {
    if (!lexical.isCode(word.index) || !lexical.isRoot(word.index)) continue;
    const end = trivia(body, word.index + word[0].length);
    if (!new RegExp(`^${ID}|^[{\\[]`, "u").test(body.slice(end))) continue;
    heads.push({start: word.index, end, kind: word[0], supported: supportedHeads.has(word.index)});
  }
  const separators = [];
  let parentheses = 0;
  let brackets = 0;
  for (let at = 0; at < body.length; at++) {
    if (!lexical.isRoot(at)) continue;
    const character = body[at];
    if (character === "(") parentheses++;
    else if (character === ")") parentheses--;
    else if (character === "[") brackets++;
    else if (character === "]") brackets--;
    else if (parentheses === 0 && brackets === 0 && [",", ";"].includes(character)) {
      separators.push({at, character});
    }
  }
  const starts = [...new Set([
    ...heads.map(head => head.end),
    ...separators.filter(separator => separator.character === ",").map(separator => separator.at + 1),
  ])].sort((left, right) => left - right);
  const rows = new Map();
  let headIndex = -1;
  let separatorIndex = 0;
  let lastSemicolon = -1;
  for (let start of starts) {
    while (headIndex + 1 < heads.length && heads[headIndex + 1].start < start) headIndex++;
    while (separatorIndex < separators.length && separators[separatorIndex].at < start) {
      if (separators[separatorIndex].character === ";") lastSemicolon = separators[separatorIndex].at;
      separatorIndex++;
    }
    const head = heads[headIndex];
    if (!head?.supported || lastSemicolon >= head.start) continue;
    while (/\s/u.test(body[start] ?? "")) start++;
    const name = new RegExp(`^${ID}`, "u").exec(body.slice(start))?.[0];
    if (!name) continue;
    const end = separators[separatorIndex]?.at ?? body.length;
    const row = {name, start, end, head, terminated: separatorIndex < separators.length};
    const known = rows.get(name) ?? [];
    known.push(row);
    rows.set(name, known);
  }
  let probe = "__autoConnectMainImportProbe";
  while (body.includes(probe) || factory.parameters.includes(probe)) probe += "$";
  const frame = {body, parameters, lexical, rows, probe};
  mainImportFrames.set(factory, frame);
  return frame;
}
function mainImportDeclaration(frame, row) {
  if (row.declaration !== undefined) return row.declaration;
  const prefix = frame.body.slice(row.head.end, row.start);
  const declaration = `${row.head.kind} ${prefix}${frame.probe}=void 0;`;
  const compile = suffix => parses(`function mainImportDeclarationProbe(${frame.parameters}){${declaration}${suffix}}`);
  row.declaration = compile("") && !compile(`let ${frame.probe};`);
  return row.declaration;
}
function readMainNumericImport(factory, name) {
  const frame = mainImportFrame(factory);
  const declarations = local => (frame.rows.get(local) ?? []).filter(row => mainImportDeclaration(frame, row));
  const loader = factory.parameters[2];
  if (declarations(loader).length) return null;
  const rows = declarations(name);
  if (rows.length !== 1 || !rows[0].terminated) return null;
  const row = rows[0];
  const text = frame.body.slice(row.start, row.end);
  const pattern = new RegExp(
    `^${q(name)}\\s*=\\s*${q(loader)}\\s*\\(\\s*(?:(?<quoted>"(?:\\\\.|[^"\\\\])*")|(?<numeric>\\d+))\\s*\\)\\s*$`, "u");
  const match = pattern.exec(text);
  if (!match) return null;
  const prelude = frame.body.slice(0, row.head.start);
  if (!parses(`function mainImportPrelude(${frame.parameters}){${prelude}\nconst ${frame.probe}=0;}`)) return null;
  for (const exit of prelude.matchAll(/(?<![\w$.])(?:return|throw)\b/gu)) {
    if (!frame.lexical.isCode(exit.index) || !frame.lexical.isRoot(exit.index)) continue;
    const beforeExit = prelude.slice(0, exit.index);
    if (parses(`function mainImportPreludeExit(${frame.parameters}){${beforeExit}\nconst ${frame.probe}=0;}`)) return null;
  }
  return {
    localName: name, requireName: loader,
    moduleId: match.groups.quoted == null ? match.groups.numeric : JSON.parse(match.groups.quoted),
    start: factory.start + row.start, end: factory.start + row.end,
  };
}
function mainImport(factory, name, id) {
  // Main factories are large. Qualify only the selected root declaration while
  // retaining the existing eager-write and collision authority below.
  const found = readMainNumericImport(factory, name);
  if (!found || found.moduleId !== id || factory.parameters.includes(name)) fail("wrong native main import");
  let body = factory.body, at = found.start - factory.start;
  body = body.slice(0, at) + "__autoConnectCertifiedImport" + body.slice(at + name.length);
  if (!stable(body, name)) fail("eager main import replacement");
  // A root function declaration, including a generator, also replaces var.
  if (collidingRootFunction(factory.body,[name,factory.parameters[2]])) fail("redeclared main import");
}
function publicationName(text) { return /^remoteConnections:new ([A-Za-z_$][\w$]*)/u.exec(text)?.[1]; }
function inspectAutoConnectMain(source) {
  const graph = inspectMainRequestSites(source);if (!graph.ok) fail("live main graph: " + graph.reason);
  const factory = one(mainProcessFactories(source).filter(f => f.start === graph.scope.factoryStart && f.end === graph.scope.factoryEnd), "live factory");
  const hostSource = source.slice(graph.scope.hostStart, graph.scope.hostEnd), hostHead = /^class ([A-Za-z_$][\w$]*)/u.exec(hostSource);if (!hostHead) fail("live host class");
  const host = rootClass(factory, hostHead[1]), ctor = method(host, "constructor"), lex = createJavaScriptLexicalIndex(ctor.body);
  field(host,"appState");field(host,"remoteConnectionsHandler");
  const construction = one([...ctor.body.matchAll(/this\.remoteConnectionsHandler=new ([A-Za-z_$][\w$]*)\(this\.appState,/gu)].filter(row => lex.isCode(row.index) && lex.isRoot(row.index)), "live handler construction");
  const handler = rootClass(factory, construction[1]);method(handler,"constructor");field(handler,"appState");
  const handlerPattern = expression(contract.mainHandlerHeaderAndConstructor, { edV: handler.name });
  const handlerPrefix = handlerPattern.regex.exec(handler.source);
  if (!handlerPrefix || handlerPrefix.index !== 0) fail("native handler constructor/state binding");
  mainImport(factory, bindings(handlerPattern, handlerPrefix).edC, "23507");
  const setter = exact(method(handler, "setRemoteConnectionAutoConnect", true).source, contract.mainPersistentSetter);
  const getters = method(handler, "getAutoConnectForRemoteConnection").source + method(handler, "getRemoteConnectionAutoConnectByHostId").source;
  const getRoles = exact(getters, contract.mainChoiceAndMapGetters, { ei: setter.ei });
  exact(method(handler, "clearRemoteConnectionAutoConnect").source, contract.mainClearChoice, { ei: getRoles.ei });
  mainImport(factory, setter.ei, "24240");
  // A native constructor expression and its same-host service return must be
  // actual live host methods, never nested examples or dead conditional blocks.
  const makePattern = expression(contract.mainLiveHandlerConstruction, { edV: handler.name });
  const make = one([...ctor.body.matchAll(makePattern.regex)].filter(row => lex.isCode(row.index) && lex.isRoot(row.index)), "complete live construction");
  requireEagerConstructorInitialization(ctor, make.index, "handler");
  const hostLex = createJavaScriptLexicalIndex(host.body), services = [];
  for (const row of host.body.matchAll(/remoteConnections:new ([A-Za-z_$][\w$]*)\(/gu)) {
    if (!hostLex.isCode(row.index)) continue;
    const pattern = expression(contract.mainLiveServicePublication, { edM: row[1] });pattern.regex.lastIndex = row.index;
    const pub = pattern.regex.exec(host.body);if (!pub || pub.index !== row.index) fail("divergent service publication");
    const before = host.body.slice(0, row.index), head = [...before.matchAll(/(?<![\w$.])([A-Za-z_$][\w$]*)\(([^{};]*)\)\{/gu)].filter(r => hostLex.isRoot(r.index)).at(-1);
    if (!head) fail("service publication method");const owner = method(host, head[1]);
    if(head[1]!=="createAppHost"||!new RegExp(`^${ID}$`,"u").test(head[2]))fail("live createAppHost entry");
    const ownerLex=createJavaScriptLexicalIndex(owner.body),returns=[...owner.body.matchAll(new RegExp(`(?<![\\w$.])return new (${ID})\\(\\{`,"gu"))].filter(row=>ownerLex.isRoot(row.index)),returned=one(returns,"native root AppHost return"),p=returned.index,pubAt=owner.body.indexOf(pub[0]),spread=pubAt-1;
    const objectOpen=p+returned[0].length-1,returnClose=ownerLex.matchingBrace(objectOpen),inner=createJavaScriptLexicalIndex(owner.body.slice(objectOpen+1,returnClose));
    if(pubAt<objectOpen||owner.body.slice(pubAt-4,pubAt)!=="...{"||ownerLex.matchingBrace(spread)!==pubAt+pub[0].length-1||!inner.isRoot(spread-objectOpen-1)||owner.body.slice(returnClose)!=="})")fail("native direct returned AppHost service spread");
    const pubRoles=bindings(pattern,pub);if(pubRoles.e!==head[2])fail("same native view service publication");
    if([...owner.body.matchAll(/(?<![\w$.])remoteConnections:/gu)].filter(row=>ownerLex.isCode(row.index)).length!==1)fail("duplicate remoteConnections service member");
    rootStatement(owner.body, p, head[2]);
    for(const exit of owner.body.slice(0,p).matchAll(/(?<![\w$.])(?:return|throw)\b/gu)) {
      if(ownerLex.isRoot(exit.index)&&parses(`async function nativeAppHostExit(${head[2]}){${owner.body.slice(0,exit.index)}\nconst __exitProbe=0;}`))fail("AppHost publication after root exit");
    }
    for (const name of [handler.name, publicationName(pub[0]),returned[1]]) {
      if (!parses(`({${owner.source.slice(0,-1)};let ${name};}})`) || !stable(owner.body, name)) fail("captured live service provider");
    }
    if(thisFieldWrites(host,"remoteConnectionsHandler").length!==1)fail("rewritten live handler field");
    const visualization=returnedServiceAuthority(factory,host,ctor,owner,head[2],objectOpen,returnClose,pubAt,pub[0]);
    services.push({ row, pub, roles: pubRoles, appHostClass:returned[1], visualization });
  }
  const publication = one(services, "unique live remoteConnections publication"), service = rootClass(factory, publication.row[1]);
  const serviceRoles = exact(service.source, contract.mainServiceClass, { edM: service.name });mainImport(factory, serviceRoles.en, "33491");
  const appHost=rootClass(factory,publication.appHostClass);exact(appHost.source,contract.mainAppHostClass,{Er:appHost.name,en:serviceRoles.en});
  const constructorClose = ctor.at + ctor.source.length - 1 - host.start;
  if (host.source[constructorClose] !== "}" || !parses(host.source)) fail("invalid constructor provider context");
  for (const name of [handler.name, service.name, setter.ei, serviceRoles.en]) {
    const withLocal = host.source.slice(0, constructorClose) + `;let ${name};` + host.source.slice(constructorClose);
    const constructorLocal = !parses(withLocal);
    // Only the handler class is consumed by this constructor. Other providers
    // have their own use-site proofs and may share a constructor-local name.
    if (name === handler.name && constructorLocal) fail("captured live handler constructor " + name);
    if (!constructorLocal && !stable(ctor.body, name)) fail("eager constructor provider replacement " + name);
  }
  if(thisFieldWrites(host,"appState").length!==1||thisFieldWrites(handler,"appState").length!==1)fail("rewritten native appState field");
  ambientSymbol(factory,[host,handler]);
  return { handler: handler.name, service: service.name, stateNamespace: setter.ei, graph };
}
// Real root let declarators, not if(false)var examples, establish entry locals.
function rootLets(projected) {
  const body = projected.moduleSource, lex = scope.context(projected).lexical, rows = [];
  const valid = text => parses(`"use strict";for(let ${text};;){}`);
  for (const head of body.matchAll(/\blet\b/gu)) {
    if (!lex.isCode(head.index) || !lex.isRoot(head.index)) continue;
    let previous = head.index - 1;while (previous >= 0 && !lex.isCode(previous)) previous--;
    if (previous >= 0 && !";}".includes(body[previous])) continue;
    let start = head.index + 3;while (/\s/u.test(body[start] ?? "")) start++;let end = start;
    while (end < body.length && !(body[end] === ";" && lex.isCode(end) && lex.isRoot(end))) end++;
    if (end === body.length || !valid(body.slice(start, end))) continue;
    let cursor = start;const list = { start: head.index, end };
    for (let at = start;at <= end;at++) {
      if (at !== end && !(body[at] === "," && lex.isCode(at) && lex.isRoot(at) && valid(body.slice(start, at)))) continue;
      let left = cursor, right = at;while (/\s/u.test(body[left] ?? "")) left++;while (right > left && /\s/u.test(body[right - 1])) right--;
      rows.push({ start: left, end: right, text: body.slice(left, right), list });cursor = at + 1;
    }
  }
  return rows;
}
function rootSequence(body, at, finalReturn = false) {
  const lex = createJavaScriptLexicalIndex(body);if (!lex.isRoot(at)) fail("nested rendered cache");
  const prefix = body.slice(0,at), stripped = prefix.replace(/,$/u,";");
  if (!parses(`function nativeAutoConnectSequence(){${stripped}\nconst __sequenceSite=0;}`)) fail("conditional rendered expression");
  // A comma sequence is eager only in a direct expression/return statement.
  // Reject a single-statement control wrapper even without braces.
  let start=0;for(let i=0;i<at;i++)if(body[i]===";"&&lex.isRoot(i))start=i+1;
  const controlOffset=start;
  for (const head of body.slice(controlOffset,at).matchAll(/(?<![\w$.])(?:if|for|while|switch)\([^{};]*\)\{/gu)) {
    const begin=controlOffset+head.index;if(!lex.isRoot(begin))continue;
    const open=begin+head[0].length-1,close=lex.matchingBrace(open);
    if(close>open && close<at)start=close+1;
  }
  const current = body.slice(start,at);
  for (const row of current.matchAll(/(?<![\w$.])(?:if|for|while|switch|throw|return)\b/gu)) {
    if (!lex.isRoot(start+row.index)) continue;
    if (!(finalReturn && row[0]==="return" && current.slice(0,row.index).trim()==="")) fail("controlled rendered statement");
  }
  for (const row of prefix.matchAll(/(?<![\w$.])(?:return|throw)\b/gu)) {
    if (!lex.isRoot(row.index)) continue;
    if (!(finalReturn && row.index >= start && row[0]==="return")) fail("rendered cache after root exit");
  }
}
function inspectAutoConnectSettings(copy) {
  if (!copy || Buffer.byteLength(copy.moduleSource ?? "") > 256 * 1024) fail("bounded settings factory");
  scope.stableFactoryParameters(copy);const entry = scope.publishedRootFunction(copy, "RemoteConnectionsSettings");
  const projected = { params: ["__AutoModule", "__AutoExports", "__AutoRequire"], moduleSource: copy.moduleSource.slice(entry.open + 1, entry.end - 1), start: 0 }, offset = entry.open + 1;
  if (projected.params.some(name => copy.moduleSource.includes(name))) fail("projection authority collision");
  const decls = rootLets(projected), memo = one(slots(copy, "tw=(0,s.c)(351)", {}, entry), "native memo initializer");
  const roles = { tw: memo.roles.tw }, callerRows = slots(copy, contract.rendererCaller), callerSlot = one(callerRows, "native renderer async caller"), caller = scope.stableRootFunction(copy, callerSlot.roles.nh);
  if (caller.source !== callerSlot.text) fail("caller declaration authority");
  const facadeId = scope.requireImport(copy, callerSlot.roles.T, caller.start+caller.source.indexOf(callerSlot.roles.T+".appServices"), "GaA7").moduleId;
  const cache = one(slots(copy, contract.rendererMutationCacheAndHook, { ...roles, nh: caller.name }, entry), "live mutation cache and hook");
  Object.assign(roles, cache.roles);const action = one(slots(copy, contract.rendererMutationActionAndGuardedCallback, roles, entry), "mutation/action/guard chain");Object.assign(roles, action.roles);
  for (const site of [cache, action]) {
    const at = site.at - offset;rootStatement(projected.moduleSource, at);
    if (scope.enclosingFunction(copy, site.at).start !== entry.start) fail("nested mutation bridge");
  }
  if (!(memo.at < cache.at && cache.at + cache.text.length <= action.at)) fail("native callback declaration order");
  // Imports referenced by the native policy must retain their identities, even
  // where the component legitimately shadows other same-spelled imports.
  const ids = { s: "QosV", l: "xSOA", v: "zbf8", i: "iRMi", W: "WFY2", R: "SGsN", w: "cfCu", y: "tl5a", S: "rljs", m: "DBCl", o: "ABep" };
  // Logger/toast IDs come from the native selected settings module; unlike
  // policy helpers their public import IDs are recorded in the fixture below.
  for (const [name, id] of Object.entries(ids)) {
    const actual = roles[name] ?? name;
    scope.requireImport(copy, actual, name === "s" ? memo.at : name === "l" ? cache.at : action.at, id);
  }
  function declared(name) { return one(decls.filter(row => row.text === name || row.text.startsWith(name + "=")), "actual root let " + name); }
  const memoDecl = declared(roles.tw);
  if (memoDecl.text !== memo.text || memoDecl.start !== memo.at - offset) fail("memo root initializer");
  const cacheVar = declared(roles.eO), actionVar = declared(roles.eJ);
  if (cacheVar.text !== roles.eO || actionVar.text !== roles.eJ || cacheVar.list !== memoDecl.list || actionVar.list !== memoDecl.list) fail("memo callback declaration list");
  // Remove only certified initializers/assignments before checking the existing
  // literal eager-write authority; memo element writes are intentionally legal.
  let guarded = projected.moduleSource;
  const certified = [{ start: memoDecl.start, end: memoDecl.end, text: roles.tw },
    { start: cache.at - offset, end: cache.at - offset + cache.text.length, text: `let ${roles.om};` },
    { start: action.at - offset, end: action.at - offset + action.text.length, text: `let ${roles.ok},${roles.oD};` }];
  for (const site of certified.sort((a,b)=>b.start-a.start)) guarded = guarded.slice(0,site.start) + site.text + guarded.slice(site.end);
  for (const name of [roles.tw, roles.eO, roles.om, roles.eJ, roles.ok, roles.oD]) if (!stable(guarded, name)) fail("eager local replacement " + name);
  for (const name of [roles.om, roles.ok, roles.oD]) declared(name);
  const pending="op=oi.isPending||or.isPending||oa.isPending||ol.isPending||oc.isPending||od.isPending||ou.isPending||om.isPending||og.isPending||oh.isPending";
  for (const template of ["tM=(0,u.gh)(z.u)","tI=(0,u.Ul)(k.YV)","tN=(0,f.A)()","of=oc.isPending",pending]) {
    const row=one(slots(copy,template,roles,entry),"native control/store/pending initializer"),mapped=row.roles;
    const name=/^([A-Za-z_$][\w$]*)=/u.exec(template)[1],actual=mapped[name],decl=declared(actual);
    if(decl.text!==row.text||decl.start!==row.at-offset)fail("actual root control/store/pending declaration");
    const removed=projected.moduleSource.slice(0,decl.start)+actual+projected.moduleSource.slice(decl.end);
    if(!stable(removed,actual))fail("rewritten control/store/pending binding");
    for(const [original,id] of [["u","zTeN"],["z","OWtl"],["k","yGJW"],["f","Wf1j"]]) {
      if(new RegExp(`(?<![\\w$.])${q(original)}\\.`,"u").test(template))scope.requireImport(copy,mapped[original],row.at,id);
    }
  }
  for (const site of [cache,action]) for(const name of [roles.tw,roles.eO,roles.om,roles.eJ,roles.ok,roles.oD]) {
    for(const row of site.text.matchAll(new RegExp(`(?<![\\w$.])${q(name)}(?![\\w$])`,"gu"))) {
      if(scope.context(copy).lexical.isCode(site.at+row.index))scope.unshadowed(projected,name,site.at+row.index-offset);
    }
  }
  const noop = scope.stableRootFunction(copy, roles.na);if (!/^function [A-Za-z_$][\w$]*\(\)\{\}$/u.test(noop.source)) fail("native rejection sink");
  const rendered = one(slots(copy, contract.rendererRenderedLists, roles, entry), "actual native rendered lists"), renderRoles = { ...roles, ...rendered.roles };
  const fragment = one(slots(copy, contract.rendererFinalFragment, renderRoles, entry), "returned native fragment");
  rootSequence(projected.moduleSource, rendered.at - offset);
  rootSequence(projected.moduleSource, fragment.at - offset, true);
  if(!/^\s*;?\s*$/u.test(copy.moduleSource.slice(fragment.at+fragment.text.length,entry.end-1)))fail("nonterminal native returned fragment");
  if (!(action.at + action.text.length < rendered.at && rendered.at + rendered.text.length < fragment.at)) fail("render/cache/return order");
  const listName = renderRoles.tA, list = scope.stableRootFunction(copy, listName), listRoles = exact(list.source, contract.rendererConnectionList, { tA: listName });
  const remote = scope.stableRootFunction(copy, listRoles.ti), ssh = scope.stableRootFunction(copy, listRoles.tw);
  const remoteRoles = exact(remote.source, contract.rendererRemoteControlRow, { ti: remote.name }), sshRoles = exact(ssh.source, contract.rendererSshRow, { tw: ssh.name });
  // Critical root function edges must resolve at their actual JSX sites.
  for (const [owner, name] of [[entry,list.name],[list,remote.name],[list,ssh.name]]) {
    const uses = [...owner.source.matchAll(new RegExp(`\\.jsx\\)\\(${q(name)}(?=,)`, "gu"))];
    if (uses.length !== (owner === entry ? 2 : 1)) fail("native JSX consumer count");
    for (const row of uses) scope.unshadowed(copy, name, owner.start + row.index);
  }
  // Bind each free native UI provider to its recorded import identity. Native
  // function locals remain compiler-owned and never become imported providers.
  for (const [fn, mapping] of [[list,listRoles],[remote,remoteRoles],[ssh,sshRoles]]) {
    for (const [original,id] of Object.entries(contract.rendererImportIds)) {
      const actual = mapping[original];if (!actual) continue;
      const uses = [...fn.source.matchAll(new RegExp(`(?<![\\w$.])${q(actual)}\\.`, "gu"))];
      for (const row of uses) {
        const at = fn.start + row.index;
        try { scope.unshadowed(copy, actual, at); } catch { continue; }
        scope.requireImport(copy, actual, at, id);
      }
    }
  }
  const locals = [renderRoles.tu,renderRoles.tm,renderRoles.tg,fragment.roles.ty];
  let withoutSlots = projected.moduleSource;
  for (const row of [rendered,fragment].sort((a,b)=>b.at-a.at)) withoutSlots=withoutSlots.slice(0,row.at-offset)+"void 0"+withoutSlots.slice(row.at-offset+row.text.length);
  for (const name of locals) { declared(name);if (!stable(withoutSlots,name)) fail("rewritten rendered cache " + name); }
  return { facadeId, entry: entry.name, caller: caller.name, list: list.name };
}
function inspectAutoConnectBootstrap(copy) {
  if (!copy || Buffer.byteLength(copy.moduleSource ?? "") > 16 * 1024) fail("bounded service bootstrap");
  scope.stableFactoryParameters(copy);
  const roles=exact(copy.moduleSource,contract.rendererBootstrapModule,{e:copy.params[0],t:copy.params[1],n:copy.params[2]});
  const entry=scope.publishedRootFunction(copy,"Y");if(entry.name!==roles.ee)fail("bootstrap published initializer");
  scope.requireImport(copy,roles.J,entry.start,"GaA7");
  scope.requireImport(copy,roles.Q,entry.start,"ay3C");
  scope.requireImport(copy,roles.s,entry.start,"xS4d");
  return { facadeId:"GaA7", entry:entry.name };
}
function prepareAutoConnect(cohort) {
  if (!cohort?.main?.length || !cohort?.settings?.length || !cohort?.facade?.length || !cohort?.bootstrap?.length) fail("missing main/settings/facade/bootstrap cohort");
  const assets = new Map();
  for (const copy of [...cohort.main, ...cohort.settings, ...cohort.facade, ...cohort.bootstrap]) {
    if (typeof copy.source !== "string" || typeof copy.assetName !== "string" || copy.moduleSource != null && copy.source.slice(copy.start, copy.end) !== copy.moduleSource) fail("stale physical snapshot");
    if (assets.has(copy.assetName) && assets.get(copy.assetName).source !== copy.source) fail("inconsistent physical copies");
    assets.set(copy.assetName, { assetName: copy.assetName, source: copy.source, patchedSource: copy.source });
  }
  if ([...assets.values()].reduce((bytes,row)=>bytes+Buffer.byteLength(row.source),0) > MAX_SELECTED_BYTES) fail("selected source byte cap");
  if (cohort.facade.length !== 2) fail("both current physical late facades are required");
  const main = cohort.main.map(copy => inspectAutoConnectMain(copy.source));
  if (main.length !== 1) fail("unique live main source");
  const settings = cohort.settings.map(inspectAutoConnectSettings), first = settings[0];
  if (settings.some(row => JSON.stringify(row) !== JSON.stringify(first))) fail("mixed renderer identities");
  for (const copy of cohort.facade) { if (copy.moduleId !== first.facadeId) fail("wrong late facade");inspectAppServicesFacade(copy); }
  for (const copy of cohort.bootstrap) inspectAutoConnectBootstrap(copy);
  return { edits: [...assets.values()], alreadyApplied: true, targetCopies: settings.length, dependencyAssets: [...assets.keys()].sort() };
}
function locateAutoConnect(extractedDir) {
  const found = findMainProcessChunks(extractedDir);if (!found) fail("missing main chunks");
  const sources=found.chunks.map(name=>({assetName:".vite/build/"+name,source:fs.readFileSync(path.join(found.buildDir,name),"utf8")}));
  const seeds=sources.filter(row=>row.source.includes("setRemoteConnectionAutoConnect(")||row.source.includes("setAutoConnect("));
  const seed=one(seeds,"unique live main source"),identity=inspectAutoConnectMain(seed.source).graph.scope.factoryId;
  const possible=source=>[...source.matchAll(/[,{]\s*("[^"\\]*"|0[xX][\da-fA-F]+|\d+(?:\.\d+)?(?:[eE][+-]?\d+)?)\s*\(/gu)].some(row=>String(row[1][0]==='"'?JSON.parse(row[1]):Number(row[1]))===identity);
  const main=sources.filter(row=>row===seed||possible(row.source)&&mainProcessFactories(row.source).some(factory=>factory.identity===identity));
  const assets = path.join(extractedDir, "webview/assets"), settings = findUniqueRspackModuleCopies(assets, { description: "auto-connect settings", sourceMatch: text=>text.includes("RemoteConnectionsSettings:"), matchModule: text=>text.includes("RemoteConnectionsSettings:") });
  const facade = findUniqueRspackModuleCopies(assets, { description: "auto-connect late facade", sourceMatch: text=>text.includes("GaA7"), matchModule: (_text,copy)=>copy.moduleId === "GaA7" });
  const bootstrap = findUniqueRspackModuleCopies(assets,{description:"native service bootstrap",sourceMatch:text=>text.includes("setAppServices)(await"),matchModule:(_text,copy)=>copy.moduleId==="wRZ2"});
  return prepareAutoConnect({ main, bootstrap: bootstrap.map(copy=>({...copy,assetName:"webview/assets/"+copy.assetName})), settings: settings.map(copy=>({...copy,assetName:"webview/assets/"+copy.assetName})), facade: facade.map(copy=>({...copy,assetName:"webview/assets/"+copy.assetName})) });
}
function applyAutoConnect(extractedDir, options = {}) {
  const plan = locateAutoConnect(extractedDir);
  return { ...patchWebviewAssets(extractedDir, plan.edits, options), matched: true, targetCopies: plan.targetCopies };
}
module.exports = { inspectAutoConnectMain, inspectAutoConnectSettings, inspectAutoConnectBootstrap, prepareAutoConnect, locateAutoConnect, applyAutoConnect };
