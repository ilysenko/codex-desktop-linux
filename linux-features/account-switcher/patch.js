"use strict";

const { createAccountSwitcher } = require("./runtime.js");
const IDENT = "[A-Za-z_$][\\w$]*";
const MAIN_MARKER = "codexLinuxAccountSwitcherMain";
const UI_MARKER = "codexLinuxAccountSwitcherUi";

function unique(source, pattern) {
  const matches = [...source.matchAll(pattern)];
  return matches.length === 1 ? matches[0] : null;
}

function menuItemImport(source, localName) {
  const bindings = [];
  for (const declaration of source.matchAll(/\bimport\s*\{([^{}]+)\}\s*from\s*(["'])[^"']+\2/g)) {
    for (const specifier of declaration[1].split(",")) {
      const binding = specifier.trim().match(new RegExp(`^(${IDENT})(?:\\s+as\\s+(${IDENT}))?$`));
      if (binding && (binding[2] ?? binding[1]) === localName) {
        bindings.push({ index: declaration.index + declaration[0].indexOf("{") + 1, exported: binding[1] });
      }
    }
  }
  return bindings.length === 1 ? bindings[0] : null;
}

function applyMain(source) {
  if (source.includes(MAIN_MARKER)) return source;
  const bridge = unique(source, new RegExp(
    `(case\\\`mcp-request\\\`:\\{)${IDENT}\\(\\)\\.debug\\(\\\`app_server\\.bridge_received\\\`,\\{safe:\\{messageType:\\\`mcp-request\\\`,requestId:String\\((${IDENT})\\.request\\.id\\),method:\\2\\.request\\.method,originWebcontentsId:(${IDENT})\\.id,originHostId:\\2\\.hostId`, "g"));
  const config = unique(source, new RegExp(
    `\\[\\.\\.\\.${IDENT}\\.${IDENT}\\((${IDENT})\\.globalState,\\1\\.hostConfig\\),\\.\\.\\.await \\1\\.secretAuthStorageConfigOverrides,\\.\\.\\.await ${IDENT}\\(\\1\\)\\]`, "g"));
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
    `clients:()=>this.appServerConnectionRegistry.getAllHostIds().map(id=>this.getAppServerConnection(id)),` +
    `reload:()=>{for(let window of require(\`electron\`).BrowserWindow.getAllWindows())if(!window.isDestroyed())window.webContents.reload()}});` +
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

function applyUi(source) {
  if (source.includes(UI_MARKER)) return source;
  const dispatch = unique(source, new RegExp(`(${IDENT})\\.dispatchMessage\\(\\\`avatar-overlay-open\\\`,\\{\\}\\)`, "g"));
  const jsx = unique(source, new RegExp(
    `\\(0,(${IDENT})\\.jsx\\)\\((${IDENT}),\\{accountIcon:${IDENT},accountSwitcher:${IDENT},additionalItems:(${IDENT}),` +
      `[\\s\\S]{0,500}?onCloseMenu:(${IDENT}),`, "g"));
  const settings = unique(source, new RegExp(
    `let (${IDENT});[\\s\\S]{0,350}?codex\\.profileDropdown\\.settingsPage[\\s\\S]{0,350}?` +
      `let (${IDENT});[\\s\\S]{0,350}?\\2=\\(0,${IDENT}\\.jsx\\)\\((${IDENT}),` +
      `\\{leftIconAsset:${IDENT},keyboardShortcut:${IDENT},onClick:${IDENT},children:\\1\\}\\)`, "g"));
  const intl = unique(source, new RegExp(`(${IDENT})\\.formatMessage\\(\\{id:\\\`codex\\.profileDropdown\\.copyUserIdForEmail\\\``, "g"));
  const regular = settings == null ? null : unique(source, new RegExp(
    `children:\\[(${IDENT}),(${IDENT}),${settings[2]}\\]`, "g"));
  if (!dispatch || !jsx || !regular || !settings || !intl) {
    console.warn("WARN: Account switcher profile-menu contract drifted - skipping patch");
    return source;
  }
  const [, jsxAlias, , additional, close] = jsx;
  const menuItem = settings[3];
  const binding = menuItemImport(source, menuItem);
  if (!binding) {
    console.warn("WARN: Account switcher menu-item import contract drifted - skipping patch");
    return source;
  }
  // Minifiers reuse import aliases inside nested scopes. In the sidebar branch
  // the settings component's alias can instead name the pet's onClick callback.
  // A fresh ESM binding keeps the component's identity in both layouts without
  // eagerly reading an import or depending on the current minified symbol names.
  let component = "codexLinuxAccountSwitcherMenuItem";
  for (let suffix = 1; source.includes(component); suffix++) component = `codexLinuxAccountSwitcherMenuItem${suffix}`;
  source = source.slice(0, binding.index) + `${binding.exported} as ${component},` + source.slice(binding.index);
  const row = `(0,${jsxAlias}.jsx)(${component},{onClick:()=>{${close}();${dispatch[1]}.dispatchMessage(\`mcp-request\`,{hostId:\`local\`,request:{id:\`community-account-switcher-\`+Date.now(),method:\`community/accountSwitcher\`,params:{locale:${intl[1]}.locale}}})},children:${intl[1]}.locale?.startsWith(\`pl\`)?\`Przełącz konto…\`:${intl[1]}.locale?.startsWith(\`zh\`)?\`切换账户…\`:\`Switch account…\`})`;
  // Keep the existing React memo dependencies: the action references the same
  // onClose callback as the adjacent settings items and contains no account data.
  source = source.replace(jsx[0], jsx[0].replace(`additionalItems:${additional},`,
    `additionalItems:(0,${jsxAlias}.jsxs)(${jsxAlias}.Fragment,{children:[${additional},${row}]}),/*${UI_MARKER}*/`));
  source = source.replace(regular[0], regular[0].replace(
    `children:[${regular[1]},${regular[2]},${settings[2]}]`,
    `children:[${regular[1]},${regular[2]},${settings[2]},${row}]`));
  return source;
}

const descriptors = [
  { id: "account-switcher-main", phase: "main-bundle", order: 20_970, ciPolicy: "optional", apply: applyMain },
  { id: "account-switcher-profile-menu", phase: "webview-asset", order: 20_970, ciPolicy: "optional", pattern: /^profile-dropdown-items-[^.]+\.js$/, missingDescription: "profile dropdown bundle", apply: applyUi },
];

module.exports = { applyMain, applyUi, descriptors };
