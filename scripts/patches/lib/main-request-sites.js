"use strict";

const { Script } = require("node:vm");
const { escapeRegExp, findMatchingBrace } = require("./minified-js.js");

const ID = "[A-Za-z_$][\\w$]*";
const MEMBER = `${ID}(?:\\.${ID})*`;
const CLASS = new RegExp(`\\bclass (${ID})(?: extends ${MEMBER})?\\{`, "gu");
const HELPER = "codexLinux[A-Za-z0-9_$]+";

function one(values) { return values.length === 1 ? values[0] : null; }
function rootAt(body, index) {
  const prefix = body.slice(0, index);
  return findMatchingBrace("{" + prefix + "}", 0) === prefix.length + 1;
}
function statementAt(body, index) {
  if (!rootAt(body, index)) return false;
  try { new Script(`${body.slice(0, index)}const __codexMainRequestStatement=0;`); return true; }
  catch { return false; }
}
function assignmentAt(body, index) {
  if (!rootAt(body, index)) return false;
  let prefix = body.slice(0, index);
  if (matches(prefix, /\breturn\b/gu).length) return false;
  // Native constructors use both statements and comma sequences. Completing
  // a root comma preserves those, but an unfinished arrow/call/conditional
  // cannot become a lexical declaration at the constructor's own scope.
  if (prefix.endsWith(",")) prefix = prefix.slice(0, -1) + ";";
  try { new Script(`async function __codexMainRequestConstructor(){${prefix}const __codexMainRequestAssignment=0;}`); return true; }
  catch { return false; }
}
function matches(body, pattern, root = true) {
  return [...body.matchAll(pattern)].filter(match => {
    const prefix = body.slice(0, match.index);
    // Complete the current lexical prefix without closing a quote/comment.
    const code = findMatchingBrace("{" + prefix + "}".repeat(prefix.length + 2), 0) >= prefix.length + 1;
    return code && (!root || rootAt(body, match.index));
  });
}
function stableBinding(body, name) {
  const identifier = escapeRegExp(name);
  return matches(body, new RegExp(`(?<![\\w$.])(?:${identifier}\\s*(?:\\+\\+|--|(?:\\?\\?|\\|\\||&&|[+*/%&|^\\-])?=(?!=|>))|(?:\\+\\+|--)${identifier}\\b)`, "gu")).length === 0;
}

// Current main chunks use CommonJS method-style Rspack factories. Unlike the
// renderer carrier, numeric property keys can be minified as 9e4. Keep this
// adapter private; callers do not need a second module/factory interface.
function factories(source) {
  const headers = [...source.matchAll(/(?<![\w$.])exports\.ids=\[[\d,eE+\-]*\],exports\.modules=\{/gu)]
    .filter(match => statementAt(source, match.index));
  const header = one(headers);
  if (!header) throw Error("missing or ambiguous CommonJS factory carrier");
  let cursor = header.index + header[0].length;
  const result = [], seen = new Set();
  const key = `(?:"(?:\\\\.|[^"\\\\])*"|${ID}|0[xX][\\da-fA-F]+|\\d+(?:\\.\\d+)?(?:[eE][+-]?\\d+)?)`;
  const member = new RegExp(`(${key})\\((${ID}(?:,${ID}){0,2})?\\)\\{`, "uy");
  while (cursor < source.length) {
    while (/\s/u.test(source[cursor] ?? "") && cursor < source.length) cursor++;
    if (source[cursor] === "}") return result;
    member.lastIndex = cursor;
    const found = member.exec(source);
    if (!found) throw Error("unsupported CommonJS factory member");
    let identity = found[1];
    if (identity.startsWith('"')) identity = JSON.parse(identity);
    else if (/^\d/u.test(identity)) {
      const number = Number(identity);
      if (!Number.isSafeInteger(number) || number < 0) throw Error("unsafe or noninteger factory identity");
      identity = String(number);
    }
    if (seen.has(identity)) throw Error("duplicate CommonJS factory identity");
    seen.add(identity);
    const start = member.lastIndex, end = findMatchingBrace(source, start - 1);
    if (end < start) throw Error("incomplete CommonJS factory");
    result.push({ identity, start, end, body: source.slice(start, end), parameters: found[2]?.split(",") ?? [] });
    cursor = end + 1;
    while (/\s/u.test(source[cursor] ?? "") && cursor < source.length) cursor++;
    if (source[cursor] === "}") return result;
    if (source[cursor] !== ",") throw Error("invalid CommonJS factory separator");
    cursor++;
  }
  throw Error("incomplete CommonJS factory carrier");
}

// Locate the owning declaration from balanced class ranges, then prove it is
// a direct factory declaration. Do not choose the nearest textual "class".
function owningClass(factory, index) {
  CLASS.lastIndex = 0;
  for (const head of factory.body.matchAll(CLASS)) {
    if (head.index >= index) break;
    const open = head.index + head[0].length - 1;
    const end = findMatchingBrace(factory.body, open);
    if (end < open) return null;
    if (open < index && index < end && statementAt(factory.body, head.index) && stableBinding(factory.body, head[1])) {
      return { name: head[1], start: head.index, open, end, body: factory.body.slice(open + 1, end) };
    }
  }
  return null;
}
function method(owner, name, async = true) {
  const heads = matches(owner.body, new RegExp(`(?<![\\w$.])${async ? "async " : ""}${escapeRegExp(name)}\\((${ID}),(${ID})\\)\\{`, "gu"))
    .filter(match => !/\bstatic\s*$/u.test(owner.body.slice(0, match.index)));
  const head = one(heads);
  if (!head) return null;
  const open = head.index + head[0].length - 1, end = findMatchingBrace(owner.body, open);
  if (end < open) return null;
  return { start: owner.open + 1 + head.index, bodyStart: owner.open + 1 + open + 1,
    bodyEnd: owner.open + 1 + end, body: owner.body.slice(open + 1, end), view: head[1], request: head[2] };
}
function constructor(owner) {
  const head = one(matches(owner.body, /\bconstructor\(/gu));
  if (!head) return null;
  // The required leading parameters are simple. Later parameters contain
  // default arrows, so do not split the complete signature on commas.
  const leading = new RegExp(`^(${ID}(?:,${ID})*)(?=[,)=])`, "u").exec(owner.body.slice(head.index + head[0].length));
  if (!leading) return null;
  const starts = [...owner.body.slice(head.index).matchAll(/\)\{/gu)];
  for (const candidate of starts) {
    const open = head.index + candidate.index + 1;
    const signature = owner.body.slice(head.index, open);
    try { new Script(`class __CodexMainRequestConstructor{${signature}{}}`); }
    catch { continue; }
    const end = findMatchingBrace(owner.body, open);
    if (end < open) return null;
    return { body: owner.body.slice(open + 1, end), bodyStart: owner.open + 1 + open + 1, parameters: leading[1].split(",") };
  }
  return null;
}
function assigned(body, property) {
  const found = one(matches(body, new RegExp(`(?<![\\w$.])this\\.${escapeRegExp(property)}=(${MEMBER})(?=[,;]|$)`, "gu"))
    .filter(match => assignmentAt(body, match.index)));
  return found?.[1] ?? null;
}
function startup(factory) {
  const [, target, loader] = factory.parameters;
  if (!target || !loader) return null;
  const publication = one(matches(factory.body, new RegExp(`(?<![\\w$.])${escapeRegExp(loader)}\\.d\\(${escapeRegExp(target)},\\{runMainAppStartup:\\(\\)=>(${ID})\\}\\)`, "gu"))
    .filter(match => statementAt(factory.body, match.index)));
  if (!publication) return null;
  const head = one(matches(factory.body, new RegExp(`(?:async )?function ${escapeRegExp(publication[1])}\\((${ID})?\\)\\{`, "gu")));
  if (!head || !statementAt(factory.body, head.index) || !stableBinding(factory.body, publication[1])) return null;
  const open = head.index + head[0].length - 1, end = findMatchingBrace(factory.body, open);
  return end < open ? null : { body: factory.body.slice(open + 1, end), bodyStart: open + 1, bodyEnd: end, parameters: head[1] ?? "" };
}
function ownBinding(scope, name) {
  try { new Script(`async function __codexMainRequestBinding(${scope.parameters}){${scope.body}\n;let ${name};}`); return false; }
  catch { return true; }
}
// The current wiring uses literal, identifier-key data properties. Reject
// root spreads/computed keys/accessors/quoted or duplicate definitions rather
// than interpreting override expressions. Compilation only finds a complete
// property value's end; it does not evaluate or interpret that expression.
// The startup argument currently contains ...{}, an empty literal spread that
// cannot override a binding. This is the only supported spread shape.
function dataProperties(object) {
  const result = new Map(), key = new RegExp(`(${ID}):`, "uy");
  let cursor = 0;
  while (cursor < object.length) {
    while (/\s/u.test(object[cursor] ?? "") && cursor < object.length) cursor++;
    if (cursor === object.length) return result;
    if (object.startsWith("...{}", cursor)) {
      cursor += 5;
      if (cursor === object.length) return result;
      if (object[cursor] !== ",") return null;
      cursor++;
      continue;
    }
    key.lastIndex = cursor;
    const head = key.exec(object);
    if (!head || result.has(head[1])) return null;
    const start = key.lastIndex;
    let end = start;
    for (; end <= object.length; end++) {
      if (end !== object.length && object[end] !== ",") continue;
      const value = object.slice(start, end);
      if (!rootAt(value, value.length)) continue;
      try { new Script(`async function __codexMainRequestProperty(){return (${value});}`); }
      catch { continue; }
      result.set(head[1], value.trim());
      break;
    }
    if (end > object.length) return null;
    cursor = end === object.length ? end : end + 1;
  }
  return result;
}
function property(object, name) {
  const value = dataProperties(object)?.get(name);
  return value && new RegExp(`^${MEMBER}$`, "u").test(value) ? value : null;
}
function startupCreatesHost(entry, hostName) {
  if (ownBinding(entry, hostName)) return false;
  const iifes = matches(entry.body, new RegExp(`(?<![\\w$.])(?:let|const|var) ${ID}=function\\(\\{([^{}()]*)\\}\\)\\{`, "gu"))
    .filter(match => assignmentAt(entry.body, match.index));
  const creates = [];
  for (const head of iifes) {
    const sender = property(head[1], "chunkedMessageSender"), state = property(head[1], "globalState");
    if (!sender || !state || !new RegExp(`^${ID}$`, "u").test(sender) || !new RegExp(`^${ID}$`, "u").test(state)) continue;
    const open = head.index + head[0].length - 1, end = findMatchingBrace(entry.body, open);
    if (end < open || !entry.body.startsWith("({", end + 1)) continue;
    const argsOpen = end + 2, argsEnd = findMatchingBrace(entry.body, argsOpen);
    if (entry.body[argsEnd + 1] !== ")") continue;
    const args = entry.body.slice(argsOpen + 1, argsEnd);
    if (!property(args, "chunkedMessageSender") || !property(args, "globalState")) continue;
    const body = entry.body.slice(open + 1, end), scope = { body, parameters: "{" + head[1] + "}" };
    if (ownBinding(scope, hostName)) continue;
    const calls = matches(body, new RegExp(`(?<![\\w$.])${ID}=new ${escapeRegExp(hostName)}\\(\\{`, "gu"));
    for (const call of calls) {
      const prefix = body.slice(0, call.index);
      const direct = assignmentAt(body, call.index) || prefix.endsWith("(") && assignmentAt(prefix.slice(0, -1), prefix.length - 1);
      if (!direct) continue;
      const objectOpen = call.index + call[0].length - 1, objectEnd = findMatchingBrace(body, objectOpen);
      const object = body.slice(objectOpen + 1, objectEnd);
      if (body[objectEnd + 1] === ")" && property(object, "chunkedMessageSender") === sender && property(object, "globalState") === state) creates.push(call);
    }
  }
  return creates.length === 1;
}

function prefixComplete(prefix, site, ids) {
  let cursor = 0;
  const req = escapeRegExp(site.requestVar), view = escapeRegExp(site.webContentsVar), sender = escapeRegExp(site.senderExpr);
  const marker = "\\/\\*codex-linux-(?<id>[a-z0-9-]+)-route\\*\\/";
  const reply = `(?<reply>${ID})=>${sender}\\(${view},\\k<reply>\\)`;
  const literal = `"vscode:\\/\\/codex\\/[^"\\\\]+"===${req}\\?\\.url`;
  const patterns = site.globalStateExpr ? [
    new RegExp(`^${marker}if\\(await ${HELPER}\\.call\\(this,${req},${reply}\\)\\)break;`, "u"),
    new RegExp(`^${marker}if\\(${literal}\\)\\{${HELPER}\\(${req},this\\.globalState,${reply}\\);break\\}`, "u"),
  ] : [
    new RegExp(`^${marker}if\\((?:${literal}|${HELPER}\\(${req}\\?\\.url\\))\\)return void await ${HELPER}\\(${req},${reply}\\);`, "u"),
  ];
  while (cursor < prefix.length) {
    cursor += /^\s*/u.exec(prefix.slice(cursor))[0].length;
    if (cursor === prefix.length) return true;
    const found = one(patterns.map(pattern => pattern.exec(prefix.slice(cursor))).filter(Boolean));
    if (!found || found.groups.reply === site.webContentsVar || ids.has(found.groups.id)) return false;
    ids.add(found.groups.id);
    cursor += found[0].length;
  }
  return true;
}

function ownerBounds(factory, owner, entry) {
  return {
    ownerStart: factory.start + owner.start, ownerEnd: factory.start + owner.end + 1,
    methodBodyStart: factory.start + entry.bodyStart, methodBodyEnd: factory.start + entry.bodyEnd,
  };
}

function wrapper(factory, entryIndex) {
  const owner = owningClass(factory, entryIndex);
  if (!owner) return null;
  const entry = method(owner, "handleRequest"), response = method(owner, "handleDictationStreamConnectInfoRequest");
  const ctor = constructor(owner);
  if (!entry || entry.start !== entryIndex || !response || !ctor || ctor.parameters.length !== 1 || assigned(ctor.body, "options") !== ctor.parameters[0]) return null;
  const native = `if("/codex/dictation-stream-connect-info"===${entry.request}.url)return void await this.handleDictationStreamConnectInfoRequest(${entry.view},${entry.request});throw Error("HTTP requests must use the HTTP fetch service.")`;
  const nativeStart = entry.body.endsWith(native) ? entry.body.length - native.length : entry.body.endsWith(native + ";") ? entry.body.length - native.length - 1 : -1;
  if (nativeStart < 0) return null;
  const senderExpr = "this.options.chunkedMessageSender.sendInlineMessageForView";
  if (!response.body.startsWith("try{")) return null;
  const tryEnd = findMatchingBrace(response.body, 3), caught = /^catch\(([A-Za-z_$][\w$]*)\)\{/u.exec(response.body.slice(tryEnd + 1));
  if (!caught) return null;
  const catchOpen = tryEnd + caught[0].length, catchEnd = findMatchingBrace(response.body, catchOpen);
  if (catchEnd !== response.body.length - 1) return null;
  const sections = [response.body.slice(4, tryEnd), response.body.slice(catchOpen + 1, catchEnd)];
  for (const [index, section] of sections.entries()) {
    const call = one(matches(section, new RegExp(`${escapeRegExp(senderExpr)}\\(${escapeRegExp(response.view)},\\{type:"fetch-response",`, "gu")));
    if (!call || !assignmentAt(section, call.index)) return null;
    const open = call.index + call[0].length - 1, end = findMatchingBrace(section, open);
    const object = section.slice(open + 1, end);
    if (!one(matches(object, new RegExp(`requestId:${escapeRegExp(response.request)}\\.requestId(?=[,}])`, "gu")))) return null;
    const kind = one(matches(object, /responseType:"(success|error)"/gu));
    if (!kind || kind[1] !== (index === 0 ? "success" : "error")) return null;
  }
  return { owner, entry, site: { ...ownerBounds(factory, owner, entry), insertAt: factory.start + entry.bodyStart, nativeStart: factory.start + entry.bodyStart + nativeStart,
    prefixStart: factory.start + entry.bodyStart, prefixEnd: factory.start + entry.bodyStart + nativeStart,
    webContentsVar: entry.view, requestVar: entry.request, senderExpr } };
}
function view(factory, forwardIndex) {
  const owner = owningClass(factory, forwardIndex), entry = owner && method(owner, "handleMessage"), ctor = owner && constructor(owner);
  if (!entry || !ctor) return null;
  const switches = matches(entry.body, new RegExp(`switch\\(${escapeRegExp(entry.request)}\\.type\\)\\{`, "gu"));
  const dispatch = one(switches);
  if (!dispatch) return null;
  const open = dispatch.index + dispatch[0].length - 1, end = findMatchingBrace(entry.body, open);
  if (entry.body.slice(end + 1).trim() !== "") return null;
  const prelude = entry.body.slice(0, dispatch.index);
  const avatar = new RegExp(`^if\\(${escapeRegExp(entry.request)}\\.type\\.startsWith\\("avatar-overlay-"\\)\\)return void await ${ID}\\(this\\.getOverlayManagerForOrigin\\?\\.\\(${escapeRegExp(entry.view)}\\)\\?\\?this\\.avatarOverlayManager,${escapeRegExp(entry.view)},${escapeRegExp(entry.request)},(${ID})=>\\{this\\.windowManager\\.sendMessageToWebContents\\(${escapeRegExp(entry.view)},\\1\\)\\}\\);$`, "u");
  if (prelude !== "" && !avatar.test(prelude)) return null;
  const switchBody = entry.body.slice(open + 1, end);
  const fetchCase = one(matches(switchBody, /case"fetch":/gu));
  const native = `await this.fetchWrapper.handleRequest(${entry.view},${entry.request});break;case"cancel-fetch":this.fetchWrapper.cancelRequest(${entry.view},${entry.request});break;`;
  const forwards = matches(switchBody, new RegExp(escapeRegExp(native), "gu"));
  const forward = one(forwards);
  if (!fetchCase || !forward || forward.index < fetchCase.index) return null;
  if (entry.bodyStart + open + 1 + forward.index !== forwardIndex) return null;
  const offset = factory.start + entry.bodyStart + open + 1;
  const insertAt = offset + fetchCase.index + fetchCase[0].length, nativeStart = offset + forward.index;
  const params = Object.fromEntries(["chunkedMessageSender", "fetchWrapper", "globalState"].map(field => [field, assigned(ctor.body, field)]));
  const indices = Object.fromEntries(Object.entries(params).map(([field, parameter]) => [field, ctor.parameters.indexOf(parameter)]));
  if (Object.values(indices).some(index => index < 0) || new Set(Object.values(indices)).size !== 3) return null;
  return { owner, entry, indices, site: { ...ownerBounds(factory, owner, entry), insertAt, nativeStart, prefixStart: insertAt, prefixEnd: nativeStart,
    webContentsVar: entry.view, requestVar: entry.request, senderExpr: "this.chunkedMessageSender.sendInlineMessageForView", globalStateExpr: "this.globalState" } };
}
function connected(factory, wrapped, viewed) {
  const creates = matches(factory.body, new RegExp(`(?<![\\w$.])this\\.fetchWrapper=new ${escapeRegExp(wrapped.owner.name)}\\(\\{`, "gu"), false);
  const result = [];
  for (const create of creates) {
    const host = owningClass(factory, create.index), ctor = host && constructor(host);
    if (!host || !ctor || ctor.parameters.length !== 1) continue;
    const local = create.index - ctor.bodyStart;
    if (local < 0 || local >= ctor.body.length || !assignmentAt(ctor.body, local)) continue;
    const input = ctor.parameters[0];
    const objectOpen = local + create[0].length - 1, objectEnd = findMatchingBrace(ctor.body, objectOpen);
    const object = ctor.body.slice(objectOpen + 1, objectEnd);
    const sender = property(object, "chunkedMessageSender");
    if (sender !== `${input}.chunkedMessageSender` || assigned(ctor.body, "scopedState") !== `${input}.globalState`) continue;
    const count = Math.max(...Object.values(viewed.indices)) + 1;
    const call = one(matches(ctor.body, new RegExp(`(?<![\\w$.])this\\.messageHandler=new ${escapeRegExp(viewed.owner.name)}\\((?<args>${MEMBER}(?:,${MEMBER}){${count - 1}})(?=[,)])`, "gu"))
      .filter(match => assignmentAt(ctor.body, match.index)));
    if (!call) continue;
    const args = call.groups.args.split(",");
    if (args[viewed.indices.chunkedMessageSender] !== sender || args[viewed.indices.fetchWrapper] !== "this.fetchWrapper" || args[viewed.indices.globalState] !== "this.scopedState") continue;
    const dispatch = method(host, "handleMessage");
    if (!dispatch || !dispatch.body.startsWith(`await this.messageHandler.handleMessage(${dispatch.view},${dispatch.request})`) || assigned(ctor.body, "options") !== input) continue;
    result.push(host);
  }
  return one(result);
}

/** Locate the two current native request insertion sites without editing or
 * executing source. Existing route payload/helper semantics remain owned by
 * each feature; this module validates their complete request/reply statement
 * shape and the native continuation, sender and profile-state wiring. Scope
 * metadata uses half-open source offsets: factory/startup/method body ranges
 * exclude braces, while host/owner declaration ranges include their braces. */
function inspectMainRequestSites(source) {
  if (typeof source !== "string") return { ok: false, reason: "expected main-process source text" };
  try {
    new Script(source);
    const graphs = [];
    const carriers = factories(source).map(factory => ({ factory, entry: startup(factory) })).filter(owner => owner.entry);
    if (carriers.length !== 1) return { ok: false, reason: "missing or ambiguous main startup authority" };
    for (const { factory, entry } of carriers) {
      if (!factory.body.includes("HTTP requests must use the HTTP fetch service.") || !factory.body.includes("this.fetchWrapper.handleRequest(")) continue;
      const entries = [...factory.body.matchAll(/async handleRequest\(/gu)];
      const wrappers = entries.map(entry => wrapper(factory, entry.index)).filter(Boolean);
      const forwards = [...factory.body.matchAll(/await this\.fetchWrapper\.handleRequest\(/gu)];
      const views = forwards.map(entry => view(factory, entry.index)).filter(Boolean);
      for (const wrapped of wrappers) for (const viewed of views) {
        const host = connected(factory, wrapped, viewed);
        if (!host || !startupCreatesHost(entry, host.name)) continue;
        const ids = new Set();
        if (!prefixComplete(source.slice(viewed.site.prefixStart, viewed.site.prefixEnd), viewed.site, ids) ||
            !prefixComplete(source.slice(wrapped.site.prefixStart, wrapped.site.prefixEnd), wrapped.site, ids)) continue;
        graphs.push({ ok: true, scope: {
          factoryStart: factory.start, factoryEnd: factory.end,
          startupStart: factory.start + entry.bodyStart, startupEnd: factory.start + entry.bodyEnd,
          hostStart: factory.start + host.start, hostEnd: factory.start + host.end + 1,
        }, viewFetch: viewed.site, wrapperRequest: wrapped.site });
      }
    }
    if (graphs.length !== 1) return { ok: false, reason: graphs.length ? "ambiguous native main request graph" : "missing or incomplete native main request graph" };
    return graphs[0];
  } catch (error) { return { ok: false, reason: error instanceof Error ? error.message : String(error) }; }
}

module.exports = { inspectMainRequestSites };
