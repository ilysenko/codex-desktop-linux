"use strict";

const { findMatchingBrace } = require("../../scripts/patches/lib/minified-js.js");
const { createAccountSwitcher } = require("./runtime.js");
const IDENT = "[A-Za-z_$][\\w$]*";
const MAIN_MARKER = "codexLinuxAccountSwitcherMain";
const UI_MARKER = "codexLinuxAccountSwitcherUi";

function unique(source, pattern) {
  const matches = [...source.matchAll(pattern)];
  return matches.length === 1 ? matches[0] : null;
}

function applyMain(source) {
  if (source.includes(MAIN_MARKER)) return source;
  const bridge = unique(source, new RegExp(
    `(case"mcp-request":\\{)${IDENT}\\(\\)\\.debug\\("app_server\\.bridge_received",\\{safe:\\{messageType:"mcp-request",requestId:String\\((${IDENT})\\.request\\.id\\),method:\\2\\.request\\.method,originWebcontentsId:(${IDENT})\\.id,originHostId:\\2\\.hostId`, "g"));
  const config = unique(source, new RegExp(
    `\\[\\.\\.\\.\\(0,${IDENT}\\.${IDENT}\\)\\((${IDENT})\\.globalState,\\1\\.hostConfig\\),` +
      `\\.\\.\\.await \\1\\.secretAuthStorageConfigOverrides,\\.\\.\\.await ` +
      `(?:${IDENT}\\(\\1\\)|async function\\(\\1\\)\\{(?=[\\s\\S]{0,1200}?plugins\\.codex-app-tools@openai-bundled\\.mcp_servers\\.codex_app\\.enabled=)[\\s\\S]{1,1200}?\\}\\(\\1\\))\\]`, "g"));
  if (!bridge || !config || !source.includes("sendAppServerResponseToView") || !source.includes("getAllHostIds")) {
    console.warn("WARN: Account switcher main-process contract drifted - skipping patch");
    return source;
  }
  const [, prefix, request, view] = bridge;
  const injected = `${prefix}/*${MAIN_MARKER}*/` +
    `if(${request}.request.method===\`community/accountSwitcher\`||this.codexLinuxAccountSwitcher?.isBusy()){` +
    `let response;try{if(${request}.request.method!==\`community/accountSwitcher\`)throw Error(\`Account change in progress; retry shortly.\`);` +
    `let client=this.getAppServerConnection(${request}.hostId);if(client.hostConfig.kind!==\`local\`)throw Error(\`Account switching is only available on this computer.\`);` +
    `this.codexLinuxAccountSwitcher??=(${createAccountSwitcher.toString()})({` +
    `electron:require(\`electron\`),home:await client.codexHome(),` +
    `clients:()=>this.appServerConnectionRegistry.getAllHostIds().map(id=>this.getAppServerConnection(id))});` +
    `await this.codexLinuxAccountSwitcher.open(client,require(\`electron\`).BrowserWindow.fromWebContents(${view}),${request}.request.params?.locale);response={id:${request}.request.id,result:{}}` +
    `}catch{response={id:${request}.request.id,error:{code:-32000,message:\`Account switching is unavailable.\`}}}` +
    `this.sendAppServerResponseToView(${view},${request}.hostId,${request}.request.method,response,${request}.request.trace,${request}.priority);break}`;
  // Work backwards to keep indices stable. Both changes are one fail-closed contract.
  const edits = [
    { index: bridge.index, old: prefix, replacement: injected },
    { index: config.index, old: config[0], replacement: config[0].slice(0, -1) + `,...(${config[1]}.hostConfig.id===\`local\`?[\`cli_auth_credentials_store="file"\`,\`features.secret_auth_storage=false\`]:[])]` },
  ].sort((a, b) => b.index - a.index);
  for (const edit of edits) source = source.slice(0, edit.index) + edit.replacement + source.slice(edit.index + edit.old.length);
  return source;
}

// rspack chunks hold many module factories keyed by hashed ids:
// `__webpack_modules__={abCd(e,t,n){...},...}`. Returns the factory that
// contains `index`, with its require parameter and body bounds.
function moduleFactoryAt(source, index) {
  const objectStart = source.indexOf("__webpack_modules__={");
  if (objectStart === -1) return null;
  const header = new RegExp(`([A-Za-z0-9_$]+|"[^"]*")\\((${IDENT}(?:,${IDENT}){0,2})?\\)\\{`, "y");
  let cursor = objectStart + "__webpack_modules__={".length;
  while (cursor < source.length) {
    header.lastIndex = cursor;
    const match = header.exec(source);
    if (!match) return null;
    const open = cursor + match[0].length - 1;
    const end = findMatchingBrace(source, open);
    if (end === -1) return null;
    if (index > open && index < end) {
      const params = (match[2] ?? "").split(",");
      return { bodyStart: open + 1, end, require: params[2] ?? null };
    }
    cursor = end + 1;
    if (source[cursor] !== ",") return null;
    cursor += 1;
  }
  return null;
}

// A module-scope import binding: `var a=n("ABep"),...` at the factory top.
function moduleImport(source, factory, name) {
  if (factory.require == null) return false;
  const body = source.slice(factory.bodyStart, factory.end);
  const pattern = new RegExp(`(?:\\bvar |,)${name.replace(/\$/g, "\\$")}=${factory.require.replace(/\$/g, "\\$")}\\("[^"]+"\\)`, "g");
  return [...body.matchAll(pattern)].length === 1;
}

function applyUi(source) {
  if (source.includes(UI_MARKER)) return source;
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
    console.warn("WARN: Account switcher profile-menu contract drifted - skipping patch");
    return source;
  }
  const [, jsxAlias, , additional, close] = jsx;
  const [, , , runtimeAlias, menuModule, menuExport] = settings;
  const [, busModule, busExport] = dispatch;
  const factory = moduleFactoryAt(source, settings.index);
  const sameModule = factory != null && [dispatch.index, jsx.index, regular.index, intl.index]
    .every((index) => index > factory.bodyStart && index < factory.end);
  if (!sameModule || runtimeAlias !== jsxAlias ||
      ![jsxAlias, menuModule, busModule].every((name) => moduleImport(source, factory, name))) {
    console.warn("WARN: Account switcher profile-menu module contract drifted - skipping patch");
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
    { index: factory.bodyStart + (source.startsWith('"use strict";', factory.bodyStart) ? 13 : 0), old: "", replacement: helpers },
    { index: jsx.index, old: jsx[0], replacement: jsx[0].replace(`additionalItems:${additional},`,
      `additionalItems:codexLinuxAccountSwitcherItems(${additional},${close},${intl[1]}),`) },
    { index: regular.index, old: regular[0], replacement: `children:[${regular[1]},${regular[2]},null,${settings[2]},${row}]` },
  ].sort((a, b) => b.index - a.index);
  for (const edit of edits) source = source.slice(0, edit.index) + edit.replacement + source.slice(edit.index + edit.old.length);
  return source;
}

const descriptors = [
  { id: "account-switcher-main", phase: "main-bundle", order: 20_970, ciPolicy: "optional", apply: applyMain },
  {
    id: "account-switcher-profile-menu", phase: "webview-asset", order: 20_970, ciPolicy: "optional",
    assetNeedles: ['id:"codex.profileDropdown.settingsPage"', 'id:"codex.profileDropdown.copyUserIdForEmail"', '"avatar-overlay-open"', "onCloseMenu:"],
    missingDescription: "profile dropdown bundle", apply: applyUi,
  },
];

module.exports = { applyMain, applyUi, descriptors };
