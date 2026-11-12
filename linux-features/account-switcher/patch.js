"use strict";

const fs = require("node:fs");
const path = require("node:path");
const { findMatchingBrace, createJavaScriptLexicalIndex, escapeRegExp } = require("../../scripts/patches/lib/minified-js.js");
const { inspectMainRequestSites } = require("../../scripts/patches/lib/main-request-sites.js");
const { inspectMainLocalConfigSite } = require("../../scripts/patches/lib/main-local-config-sites.js");
const { findMainProcessChunks } = require("../../scripts/patches/lib/assets.js");
const { commitAssetEdits } = require("../../scripts/patches/lib/asset-edits.js");
const { rspackModuleFactories, findRspackRequireBinding, findUniqueRspackModuleCopies, patchRspackModuleCopies } = require("../../scripts/patches/lib/rspack-module-assets.js");
const { createAccountSwitcher } = require("./runtime.js");
const IDENT = "[A-Za-z_$][\\w$]*";
const MAIN_MARKER = "codexLinuxAccountSwitcherMain";
const UI_MARKER = "codexLinuxAccountSwitcherUi";

function unique(source, pattern) {
  const matches = [...source.matchAll(pattern)];
  return matches.length === 1 ? matches[0] : null;
}

const MAIN_CTX = "codexLinuxAccountSwitcherMainCtx";
const MAIN_STORE = "codexLinuxAccountSwitcher";

function mainFrame(text, offset = 0) { return { text, offset, lexical: createJavaScriptLexicalIndex(text) }; }
function mainSlice(owner, start, end) { return mainFrame(owner.text.slice(start, end), owner.offset + start); }
function mainMatches(owner, pattern, root = false) {
  return [...owner.text.matchAll(pattern)].filter(match => owner.lexical.isCode(match.index) && (!root || owner.lexical.isRoot(match.index)));
}
function mainNext(owner, at) { while (at < owner.text.length && !owner.lexical.isCode(at)) at++; return at; }
function mainCode(owner, start = 0, end = owner.text.length) {
  let text = "";
  for (let at = start; at < end; at++) if (owner.lexical.isCode(at)) text += owner.text[at];
  return text;
}
function mainOne(values, reason) { if (values.length !== 1) throw Error(reason); return values[0]; }
function mainDelimiter(owner, open) {
  const stack = [], pairs = { ")": "(", "]": "[", "}": "{" };
  for (let at = open; at < owner.text.length; at++) {
    if (!owner.lexical.isCode(at)) continue;
    const value = owner.text[at];
    if ("([{".includes(value)) stack.push(value);
    else if (pairs[value]) {
      if (stack.pop() !== pairs[value]) throw Error("unbalanced account switcher native expression");
      if (stack.length === 0) return at;
    }
  }
  throw Error("incomplete account switcher native expression");
}
function mainArguments(owner, start, end) {
  const values = []; let from = start;
  for (let at = start; at < end; at++) {
    if (!owner.lexical.isCode(at)) continue;
    if ("([{".includes(owner.text[at])) at = mainDelimiter(owner, at);
    else if (owner.text[at] === ",") { values.push(mainCode(owner, from, at)); from = at + 1; }
  }
  values.push(mainCode(owner, from, end)); return values;
}
function mainDecode(text) {
  return text.replace(/\\(?:u(?:\{([0-9a-fA-F]+)\}|([0-9a-fA-F]{4}))|x([0-9a-fA-F]{2}))/gu, (_, braced, fixed, byte) => {
    const point = parseInt(braced || fixed || byte, 16);
    return point <= 0x10ffff ? String.fromCodePoint(point) : "\0";
  });
}
function mainArtifacts(source, callbackStart = -1, callbackEnd = -1) {
  // Outside the native callback, this reserved feature namespace identifies
  // incomplete declarations, member accesses and computed property keys.
  const outside = callbackStart < 0 ? source : source.slice(0, callbackStart) + source.slice(callbackEnd);
  return mainDecode(outside).includes(MAIN_STORE);
}

async function reloadCurrentAppViews(mainCtx, electron) {
  const windowManager = mainCtx.windowManager;
  const accountWindows = windowManager.accountWindows;
  while (accountWindows.pending != null) await accountWindows.pending;
  const generation = accountWindows.generation;
  const views = Array.from(mainCtx.getAppViews().entries());
  for (const [id, view] of views) {
    if (accountWindows.pending != null || accountWindows.generation !== generation) return;
    const contents = electron.webContents.fromId(id);
    if (mainCtx.getAppViews().get(id) !== view || contents == null || contents.isDestroyed() ||
        !windowManager.hasRegisteredWebContents(contents) || accountWindows.isCovered(contents)) continue;
    contents.reload();
  }
}

function mainConfigSuffix(options) {
  return `,...(${options}.hostConfig.id===\`local\`?[\`cli_auth_credentials_store="file"\`,\`features.secret_auth_storage=false\`]:[])`;
}
function mainRoute(view, request) {
  return `/*${MAIN_MARKER}*/if(${request}.request.method===\`community/accountSwitcher\`||this.${MAIN_STORE}?.isBusy()){` +
    `let response;try{if(${request}.request.method!==\`community/accountSwitcher\`)throw Error(\`Account change in progress; retry shortly.\`);` +
    `const mainCtx=this.${MAIN_CTX},electron=require(\`electron\`);` +
    `if(!mainCtx||${view}.isDestroyed()||electron.webContents.fromId(${view}.id)!==${view}||!mainCtx.windowManager.hasRegisteredWebContents(${view})||mainCtx.windowManager.accountWindows.isCovered(${view}))throw Error(\`Account view is no longer current.\`);` +
    `let client=this.getAppServerConnection(${request}.hostId);if(client.hostConfig.kind!==\`local\`||client.hostConfig.id!==\`local\`)throw Error(\`Account switching is only available on this computer.\`);` +
    `this.${MAIN_STORE}??=(${createAccountSwitcher.toString()})({electron,home:await client.codexHome(),` +
    `clients:()=>this.appServerConnectionRegistry.getAllHostIds().map(id=>this.getAppServerConnection(id)),` +
    `reload:()=>(${reloadCurrentAppViews.toString()})(mainCtx,electron)});` +
    `await this.${MAIN_STORE}.open(client,electron.BrowserWindow.fromWebContents(${view}),${request}.request.params?.locale);response={id:${request}.request.id,result:{}}` +
    `}catch{response={id:${request}.request.id,error:{code:-32000,message:\`Account switching is unavailable.\`}}}` +
    `this.sendAppServerResponseToView(${view},${request}.hostId,${request}.request.method,response,${request}.request.trace,${request}.priority);break}`;
}

function mainBridge(source, graph) {
  const site = graph.viewFetch, owner = mainFrame(source.slice(site.methodBodyStart, site.methodBodyEnd), site.methodBodyStart);
  const request = escapeRegExp(site.requestVar), view = escapeRegExp(site.webContentsVar);
  const switches = mainMatches(owner, new RegExp(`\\bswitch\\(${request}\\.type\\)\\{`, "gu"), true).map(head => {
    const open = head.index + head[0].length - 1, end = owner.lexical.matchingBrace(open);
    return { open, end };
  }).filter(value => owner.offset + value.open < site.nativeStart && site.nativeStart < owner.offset + value.end);
  const selected = mainOne(switches, "missing or ambiguous native account switcher type switch");
  const cases = mainSlice(owner, selected.open + 1, selected.end);
  const branch = mainOne(mainMatches(cases, /\bcase"mcp-request":\{/gu, true), "missing or ambiguous native MCP request case");
  const open = branch.index + branch[0].length - 1, end = cases.lexical.matchingBrace(open), body = mainSlice(cases, open + 1, end);
  const log = mainOne(mainMatches(body, new RegExp(`${IDENT}\\(\\)\\.debug\\("app_server\\.bridge_received",\\{safe:\\{messageType:"mcp-request",requestId:String\\(${request}\\.request\\.id\\),method:${request}\\.request\\.method,originWebcontentsId:${view}\\.id,originHostId:${request}\\.hostId\\},sensitive:\\{\\}\\}\\);let (${IDENT})=${request}\\.request;`, "gu"), true), "native MCP request origin/identity changed");
  const native = mainSlice(body, log.index, body.text.length), localRequest = escapeRegExp(log[1]);
  const dispatch = new RegExp(`this\\.getAppServerConnection\\(${request}\\.hostId\\)\\.handleClientRequest\\(new ${IDENT}\\(${view},this\\.chunkedMessageSender\\),${localRequest},`, "gu");
  mainOne(mainMatches(native, dispatch), "native MCP request client/view forwarding changed");
  const replies = mainMatches(native, /this\.sendAppServerResponseToView\(/gu);
  if (replies.length !== 2) throw Error("native MCP response count changed");
  const responses = replies.map(head => {
    const open = head.index + head[0].length - 1, end = mainDelimiter(native, open);
    const args = mainArguments(native, open + 1, end);
    if (args.length !== 6 || args[0] !== site.webContentsVar || args[1] !== `${site.requestVar}.hostId` ||
        args[2] !== `${site.requestVar}.request.method` || args[4] !== `${site.requestVar}.request.trace` ||
        args[5] !== `${site.requestVar}.priority`) throw Error("native MCP response correlation changed");
    return args[3];
  });
  if (!responses.some(value => new RegExp(`^${IDENT}\\.response$`, "u").test(value)) ||
      !responses.some(value => value.startsWith(`{id:${site.requestVar}.request.id,error:{`))) throw Error("native MCP response identity changed");
  return { start: body.offset, prefix: body.text.slice(0, log.index), payload: mainRoute(site.webContentsVar, site.requestVar) };
}

function mainContext(source, graph) {
  const viewClass = /^class ([\w$]+)/u.exec(source.slice(graph.viewFetch.ownerStart))[1];
  const host = mainFrame(source.slice(graph.scope.hostStart, graph.scope.hostEnd), graph.scope.hostStart);
  const open = host.text.indexOf("{"), members = mainSlice(host, open + 1, host.text.length - 1);
  const head = mainOne(mainMatches(members, new RegExp(`\\bconstructor\\((${IDENT})\\)\\{`, "gu"), true), "missing or ambiguous account switcher host constructor");
  const bodyOpen = head.index + head[0].length - 1, bodyEnd = members.lexical.matchingBrace(bodyOpen), body = mainSlice(members, bodyOpen + 1, bodyEnd);
  const input = escapeRegExp(head[1]);
  for (const [field, value] of [["options", input], ["appState", `${input}\\.appGlobalState`], ["scopedState", `${input}\\.globalState`]]) {
    mainOne(mainMatches(body, new RegExp(`this\\.${field}=${value}(?=[,;])`, "gu"), true), "native account switcher constructor state roles changed");
  }
  if (!mainMatches(body, new RegExp(`${input}\\.appViewsByWebContentsId(?![\\w$])`, "gu"), true).length) throw Error("native account switcher app-view registry is disconnected");
  const constructed = mainOne(mainMatches(body, new RegExp(`this\\.messageHandler=new ${escapeRegExp(viewClass)}\\(`, "gu"), true), "native account switcher message handler construction changed");
  const callOpen = constructed.index + constructed[0].length - 1, callEnd = mainDelimiter(body, callOpen) + 1;
  const payload = `,this.messageHandler.${MAIN_CTX}={windowManager:this.options.windowManager,getAppViews:()=>this.options.appViewsByWebContentsId}`;
  const applied = body.text.startsWith(payload, callEnd);
  const following = mainNext(body, callEnd + (applied ? payload.length : 0));
  if (![",", ";"].includes(body.text[following])) throw Error("native account switcher handler continuation changed");
  return { start: body.offset + callEnd, payload, applied };
}

function accountMainState(source) {
  let graph = { ok: false, factoryIds: [] };
  const invalid = reason => ({ kind: "invalid", graph, reason });
  try {
    graph = inspectMainRequestSites(source);
    if (!graph.ok) return invalid("missing native account switcher request/host graph");
    const config = inspectMainLocalConfigSite(source);
    if (!config.ok || config.scope.factoryId !== graph.scope.factoryId) return invalid("missing native account switcher local config graph");
    const route = mainBridge(source, graph), context = mainContext(source, graph), suffix = mainConfigSuffix(config.optionsVar);
    const tail = source.slice(config.overrides.nativePrefixEnd, config.overrides.arrayEnd - 1);
    const routeApplied = route.prefix.startsWith(route.payload) && mainCode(mainFrame(route.prefix.slice(route.payload.length))) === "";
    const routeRaw = mainCode(mainFrame(route.prefix)) === "";
    if ((!routeApplied && !routeRaw) || tail !== "" && tail !== suffix) return invalid("unknown account switcher route/config contribution");
    const applied = routeApplied && context.applied && tail === suffix;
    if (!applied && !(routeRaw && !context.applied && tail === "")) return invalid("incomplete account switcher main state");
    const edits = [
      { start: route.start, payload: route.payload, length: applied ? route.payload.length : 0 },
      { start: context.start, payload: context.payload, length: applied ? context.payload.length : 0 },
      { start: config.overrides.nativePrefixEnd, payload: suffix, length: applied ? suffix.length : 0 },
    ];
    let native = source;
    for (const edit of [...edits].sort((a, b) => b.start - a.start)) native = native.slice(0, edit.start) + native.slice(edit.start + edit.length);
    const translated = at => at - edits.filter(edit => edit.start + edit.length <= at).reduce((total, edit) => total + edit.length, 0);
    if (mainArtifacts(native, translated(config.overrides.start), translated(config.overrides.end))) return invalid("orphan or replaced account switcher main context");
    return { kind: applied ? "applied" : "current", graph, edits };
  } catch (error) { return invalid(error instanceof Error ? error.message : String(error)); }
}
function patchedAccountMain(source, state) {
  if (state.kind === "applied") return source;
  let patched = source;
  for (const edit of [...state.edits].sort((a, b) => b.start - a.start)) patched = patched.slice(0, edit.start) + edit.payload + patched.slice(edit.start);
  if (accountMainState(patched).kind !== "applied") throw Error("Incomplete account switcher main poststate");
  return patched;
}
function applyMain(source) {
  const state = accountMainState(source);
  if (state.kind === "invalid") { console.warn(`WARN: Account switcher main-process contract drifted - ${state.reason}`); return source; }
  return patchedAccountMain(source, state);
}
function patchAccountMainAssets(extractedDir, context = {}) {
  const main = findMainProcessChunks(extractedDir);
  const chunks = main == null ? [] : main.chunks.map(assetName => {
    const source = fs.readFileSync(path.join(main.buildDir, assetName), "utf8");
    return { assetName, source, state: accountMainState(source) };
  });
  const owners = chunks.filter(row => row.state.graph.ok), factoryId = owners.length === 1 ? owners[0].state.graph.scope.factoryId : null;
  const candidates = chunks.filter(({ source, state }) => state.graph.ok || source.includes(MAIN_MARKER) || mainArtifacts(source) ||
    (factoryId != null && state.graph.factoryIds.includes(factoryId)) ||
    (state.graph.factoryIds.length === 0 && source.includes("app_server.bridge_received")));
  if (owners.length !== 1 || candidates.length !== 1 || candidates[0].state.kind === "invalid") {
    const reason = `Expected one complete account switcher native main owner; found ${candidates.length} candidate(s)`;
    console.warn(`WARN: ${reason}`); return { matched: 0, changed: 0, reason };
  }
  const [{ assetName, source, state }] = candidates, patchedSource = patchedAccountMain(source, state);
  const result = commitAssetEdits(main.buildDir, [{ assetName, source, patchedSource }], context);
  if (result.changed !== Number(state.kind === "current")) throw Error("Account switcher transaction did not commit prepared changes");
  return { ...result, matched: 1, assetName: `.vite/build/${assetName}` };
}

function moduleFactoryAt(source, index) {
  try {
    const factories = [...rspackModuleFactories(source, "account-switcher profile")];
    const factory = factories.find(module => module.start <= index && index < module.end);
    return factory ?? null;
  } catch { return null; }
}

function applyPristineUi(source, silent = false) {
  const dispatch = unique(source, new RegExp(`(${IDENT})\\.(${IDENT})\\.dispatchMessage\\("avatar-overlay-open",\\{\\}\\)`, "g"));
  const jsx = unique(source, new RegExp(
    `\\(0,(${IDENT})\\.jsx\\)\\((${IDENT}),\\{accountIcon:${IDENT},accountSwitcher:${IDENT},additionalItems:(${IDENT}),` +
      `[\\s\\S]{0,500}?onCloseMenu:(${IDENT}),`, "g"));
  const settings = unique(source, new RegExp(
    `(${IDENT})=\\(0,${IDENT}\\.jsx\\)\\(${IDENT}\\.${IDENT},\\{id:"codex\\.profileDropdown\\.settingsPage",[^{}]{0,200}\\}\\)` +
      `[\\s\\S]{0,350}?(${IDENT})=\\(0,(${IDENT})\\.jsx\\)\\((${IDENT})\\.(${IDENT}),` +
      `\\{leftIconAsset:${IDENT}(?:\\.${IDENT})?,keyboardShortcut:${IDENT},onClick:${IDENT},children:\\1\\}\\)`, "g"));
  const intl = unique(source, new RegExp(`(${IDENT})\\.formatMessage\\(\\{id:"codex\\.profileDropdown\\.copyUserIdForEmail"`, "g"));
  const regular = settings == null ? null : unique(source, new RegExp(
    `children:\\[(${IDENT}),(${IDENT}),null,${settings[2].replace(/\$/g, "\\$")}\\]`, "g"));
  if (!dispatch || !jsx || !regular || !settings || !intl) {
    if (!silent) console.warn("WARN: Account switcher profile-menu contract drifted - skipping patch");
    return source;
  }
  const [, jsxAlias, , additional, close] = jsx;
  const [, , , runtimeAlias, menuModule, menuExport] = settings;
  const [, busModule, busExport] = dispatch;
  const factory = moduleFactoryAt(source, settings.index);
  const sameModule = factory != null && [dispatch.index, jsx.index, regular.index, intl.index]
    .every((index) => index > factory.start && index < factory.end);
  if (!sameModule || runtimeAlias !== jsxAlias ||
      ![jsxAlias, menuModule, busModule].every((name) => findRspackRequireBinding(factory, name) != null)) {
    if (!silent) console.warn("WARN: Account switcher profile-menu module contract drifted - skipping patch");
    return source;
  }
  // Minifiers reuse import aliases inside nested scopes (the sidebar branch can
  // name the pet's onClick callback like the menu-item module). The row is a
  // module-scope function, so it always resolves the module's import bindings;
  // only the menu's close callback and intl object come from the call site.
  const helpers = `/*${UI_MARKER}*/function codexLinuxAccountSwitcherRow(close,intl){` +
    `return(0,${jsxAlias}.jsx)(${menuModule}.${menuExport},{onClick:()=>{close();` +
    `${busModule}.${busExport}.dispatchMessage("mcp-request",{hostId:"local",request:{id:"community-account-switcher-"+Date.now(),` +
    `method:"community/accountSwitcher",params:{locale:intl.locale}}})},` +
    `children:intl.locale?.startsWith("pl")?"Przełącz konto…":intl.locale?.startsWith("zh")?"切换账户…":"Switch account…"})}` +
    `function codexLinuxAccountSwitcherItems(items,close,intl){` +
    `return(0,${jsxAlias}.jsxs)(${jsxAlias}.Fragment,{children:[items,codexLinuxAccountSwitcherRow(close,intl)]})}`;
  const row = `codexLinuxAccountSwitcherRow(${close},${intl[1]})`;
  // Keep the existing React memo dependencies: the action references the same
  // onClose callback as the adjacent settings items and contains no account data.
  const edits = [
    { index: factory.start + (source.startsWith('"use strict";', factory.start) ? 13 : 0), old: "", replacement: helpers },
    { index: jsx.index, old: jsx[0], replacement: jsx[0].replace(`additionalItems:${additional},`,
      `additionalItems:codexLinuxAccountSwitcherItems(${additional},${close},${intl[1]}),`) },
    { index: regular.index, old: regular[0], replacement: `children:[${regular[1]},${regular[2]},null,${settings[2]},${row}]` },
  ].sort((a, b) => b.index - a.index);
  for (const edit of edits) source = source.slice(0, edit.index) + edit.replacement + source.slice(edit.index + edit.old.length);
  return source;
}

const UI_OWNED_NAMES = [UI_MARKER, "codexLinuxAccountSwitcherRow", "codexLinuxAccountSwitcherItems"];

function uiReferenceCount(source, name) {
  return [...source.matchAll(new RegExp(`(?<![\\w$])${name}(?![\\w$])`, "g"))].length;
}

function hasUiReferences(source) {
  return source.includes(UI_MARKER) || UI_OWNED_NAMES.slice(1).some(name => uiReferenceCount(source, name) > 0);
}

function pristineUiFromApplied(source) {
  const marker = `/*${UI_MARKER}*/`;
  const markerIndex = source.indexOf(marker);
  if (markerIndex < 0 || source.split(UI_MARKER).length !== 2 ||
      uiReferenceCount(source, "codexLinuxAccountSwitcherRow") !== 3 ||
      uiReferenceCount(source, "codexLinuxAccountSwitcherItems") !== 2) return null;
  const factory = moduleFactoryAt(source, markerIndex);
  if (factory == null || markerIndex !== factory.start + (source.startsWith('"use strict";', factory.start) ? 13 : 0)) return null;
  const rowStart = markerIndex + marker.length;
  if (!source.startsWith("function codexLinuxAccountSwitcherRow(close,intl){", rowStart)) return null;
  const rowEnd = findMatchingBrace(source, source.indexOf("{", rowStart));
  const itemsStart = rowEnd + 1;
  if (rowEnd < rowStart || !source.startsWith("function codexLinuxAccountSwitcherItems(items,close,intl){", itemsStart)) return null;
  const itemsEnd = findMatchingBrace(source, source.indexOf("{", itemsStart));
  if (itemsEnd < itemsStart) return null;
  const withoutHelpers = source.slice(0, markerIndex) + source.slice(itemsEnd + 1);
  const items = unique(withoutHelpers, new RegExp(
    `additionalItems:codexLinuxAccountSwitcherItems\\((?<items>${IDENT}),(?<close>${IDENT}),(?<intl>${IDENT})\\),` +
      `[\\s\\S]{0,500}?onCloseMenu:\\k<close>,`, "g"));
  const regular = unique(withoutHelpers, new RegExp(
    `children:\\[(?<first>${IDENT}),(?<second>${IDENT}),null,(?<settings>${IDENT}),` +
      `codexLinuxAccountSwitcherRow\\((?<close>${IDENT}),(?<intl>${IDENT})\\)\\]`, "g"));
  if (items == null || regular == null || items.groups.close !== regular.groups.close || items.groups.intl !== regular.groups.intl) return null;
  const edits = [
    { start: items.index, end: items.index + items[0].length,
      text: items[0].replace(`additionalItems:codexLinuxAccountSwitcherItems(${items.groups.items},${items.groups.close},${items.groups.intl}),`, `additionalItems:${items.groups.items},`) },
    { start: regular.index, end: regular.index + regular[0].length,
      text: `children:[${regular.groups.first},${regular.groups.second},null,${regular.groups.settings}]` },
  ].sort((a, b) => b.start - a.start);
  let pristine = withoutHelpers;
  for (const edit of edits) pristine = pristine.slice(0, edit.start) + edit.text + pristine.slice(edit.end);
  if (hasUiReferences(pristine)) return null;
  return applyPristineUi(pristine, true) === source ? pristine : null;
}

function applyUi(source) {
  if (hasUiReferences(source)) {
    if (pristineUiFromApplied(source) != null) return source;
    console.warn("WARN: Account switcher profile-menu patch is incomplete or incorrectly bound - skipping patch");
    return source;
  }
  return applyPristineUi(source);
}

function applyProfileAssets(extractedDir) {
  const assets = path.join(extractedDir, "webview", "assets");
  const needles = ['id:"codex.profileDropdown.settingsPage"', 'id:"codex.profileDropdown.copyUserIdForEmail"', "onCloseMenu:"];
  const copies = findUniqueRspackModuleCopies(assets, {
    sourceMatch: source => needles.every(needle => source.includes(needle)),
    matchModule: source => needles.every(needle => source.includes(needle)),
    description: "account switcher profile menu",
  });
  return patchRspackModuleCopies(assets, copies, (_moduleSource, copy) => {
    const patched = applyUi(copy.source);
    if (pristineUiFromApplied(patched) == null) throw new Error("Incomplete account switcher profile-menu contract");
    const owner = [...rspackModuleFactories(patched, copy.assetName)].find(module => module.moduleId === copy.moduleId);
    if (owner == null) throw new Error("Account switcher profile module disappeared");
    return owner.moduleSource;
  });
}

const descriptors = [
  { id: "account-switcher-main", phase: "extracted-app:pre-webview", order: 20_970, ciPolicy: "optional", apply: patchAccountMainAssets,
    status: result => result?.matched !== 1 ? { status: "skipped-optional", reason: result?.reason ?? "missing native main owner" } : result.changed > 0 ? "applied" : "already-applied" },
  {
    id: "account-switcher-profile-menu", phase: "extracted-app:post-webview", order: 20_970, ciPolicy: "optional",
    assetNeedles: ['id:"codex.profileDropdown.settingsPage"', 'id:"codex.profileDropdown.copyUserIdForEmail"', '"avatar-overlay-open"', "onCloseMenu:"],
    apply: applyProfileAssets,
  },
];

module.exports = { applyMain, applyUi, descriptors };
