"use strict";

const fs = require("node:fs");
const path = require("node:path");
const { Script } = require("node:vm");
// Feature discovery, including isolated disabled copies, needs no ASAR helpers.
function createJavaScriptLexicalIndex(source) { return require("../../../scripts/patches/lib/minified-js.js").createJavaScriptLexicalIndex(source); }
function escapeRegExp(source) { return require("../../../scripts/patches/lib/minified-js.js").escapeRegExp(source); }
function findMatchingBrace(source, open) { return require("../../../scripts/patches/lib/minified-js.js").findMatchingBrace(source, open); }
function inspectMainRequestSites(source) { return require("../../../scripts/patches/lib/main-request-sites.js").inspectMainRequestSites(source); }
function findMainProcessChunks(directory) { return require("../../../scripts/patches/lib/assets.js").findMainProcessChunks(directory); }
function commitAssetEdits(...args) { return require("../../../scripts/patches/lib/asset-edits.js").commitAssetEdits(...args); }

const identifier = "[A-Za-z_$][\\w$]*";
const dockIconResourceHelper = "codexLinuxDockIconResourcePath";
const dockIconApplyHelper = "codexLinuxApplyDockIcon";

function matches(source, pattern) {
  if (typeof source !== "string") return [];
  pattern.lastIndex = 0;
  return [...source.matchAll(pattern)];
}

function oneMatch(source, pattern) {
  const found = matches(source, pattern);
  return found.length === 1 ? found[0] : null;
}

function sameAliases(...aliases) {
  return aliases.every((alias) => alias === aliases[0]);
}

// Current signed Rspack main source: the request host consumes the returned
// window-services instance. Its icon state and macOS appearance observer stay
// owned by that ordinary startup IIFE; Linux adds its own theme listener.
const id = identifier;
const linuxOnly = '"linux"===process\\.platform';
const notLinux = '"linux"!==process\\.platform';

function mainPatterns(state) {
  const patched = state === "patched";
  const previewGate = patched
    ? `"darwin"!==process\\.platform&&${notLinux}`
    : '"darwin"!==process\\.platform';
  const spaceDark = patched
    ? `${linuxOnly}\\?\\k<codexDark>:\\k<resource>\\(\\k<theme>\\.spaceDark\\)`
    : "\\k<resource>\\(\\k<theme>\\.spaceDark\\)";
  const spaceLight = patched
    ? `${linuxOnly}\\?\\k<codexLight>:\\k<resource>\\(\\k<theme>\\.spaceLight\\)`
    : "\\k<resource>\\(\\k<theme>\\.spaceLight\\)";
  const packaged = patched
    ? `(?<electron>${id})\\.app\\.isPackaged\\|\\|${linuxOnly}\\?\\k<helper>\\(\\k<arg>\\):null`
    : `(?<electron>${id})\\.app\\.isPackaged\\?\\(0,(?<path>${id})\\.join\\)\\(process\\.resourcesPath,\\k<arg>\\):null`;
  const appInfoTail =
    `return (?<normalize>${id})\\(null!=\\k<candidate>&&\\(0,(?<exists>${id})\\.existsSync\\)\\(\\k<candidate>\\)\\?\\k<candidate>:` +
    `\\(0,\\k<path>\\.join\\)\\(\\k<electron>\\.app\\.getAppPath\\(\\),"src","icons",\\k<arg>\\)\\)\\}`;
  const appInfoOwner =
    `function (?<owner>${id})\\((?<arg>${id})\\)\\{if\\(null==\\k<arg>\\)return null;let (?<candidate>${id})=${packaged};${appInfoTail}`;
  const windowResource = patched
    ? `\\((?<arg>${id})=>\\{if\\(!(?<electron>${id})\\.app\\.isPackaged&&${notLinux}\\)return null;let (?<candidate>${id})=${dockIconResourceHelper}\\(\\k<arg>\\);` +
      `return\\(0,(?<exists>${id})\\.existsSync\\)\\(\\k<candidate>\\)\\?\\k<candidate>:null\\}\\)`
    : `\\((?<arg>${id})=>\\{if\\(!(?<electron>${id})\\.app\\.isPackaged\\)return null;let (?<candidate>${id})=\\(0,(?<path>${id})\\.join\\)\\(process\\.resourcesPath,\\k<arg>\\);` +
      `return\\(0,(?<exists>${id})\\.existsSync\\)\\(\\k<candidate>\\)\\?\\k<candidate>:null\\}\\)`;
  const spaceSystem = patched
    ? `${linuxOnly}\\?\\k<dark>\\?\\k<theme>\\.dark:\\k<theme>\\.light:\\k<dark>\\?\\k<theme>\\.spaceDark:\\k<theme>\\.spaceLight`
    : "\\k<dark>\\?\\k<theme>\\.spaceDark:\\k<theme>\\.spaceLight";
  const applyDefaultGate = patched
    ? `if\\("app-default"===(?<arg>${id})&&${notLinux}&&(?<build>${id})!==(?:${id})\\.(?:${id})\\.Dev\\)\\{`
    : `if\\("app-default"===(?<arg>${id})&&(?<build>${id})!==(?:${id})\\.(?:${id})\\.Dev\\)\\{`;
  const crop =
    `let\\{width:(?<width>${id}),height:(?<height>${id})\\}=\\k<image>\\.getSize\\(\\),(?<inset>${id})=Math\\.round\\(\\k<width>/128\\);` +
    `\\k<image>=\\k<image>\\.crop\\(\\{x:\\k<inset>,y:\\k<inset>,width:\\k<width>-2\\*\\k<inset>,height:\\k<height>-2\\*\\k<inset>\\}\\)\\}`;
  const applyTail = patched
    ? `if\\((?<image>${id})\\.isEmpty\\(\\)\\)return;if\\(${notLinux}&&\\("codex-system"===(?<arg>${id})\\|\\|"space-system"===\\k<arg>\\)\\)\\{${crop}` +
      `if\\(${linuxOnly}\\)\\{let codexLinuxIconSelection="codex-system"===\\k<arg>\\|\\|"space-system"===\\k<arg>\\?` +
      `(?<electron>${id})\\.nativeTheme\\.shouldUseDarkColorsForSystemIntegratedUI\\?"codex-dark":"codex-light":"chatgpt";` +
      "globalThis\\.codexLinuxDockIconImage=\\k<image>;" +
      "for\\(let codexLinuxWindow of \\k<electron>\\.BrowserWindow\\.getAllWindows\\(\\)\\)codexLinuxWindow\\.isDestroyed\\(\\)\\|\\|codexLinuxWindow\\.setIcon\\(\\k<image>\\);" +
      `null!=(?<trayState>${id})\\?\\.tray&&!\\k<trayState>\\.tray\\.isDestroyed\\(\\)&&\\k<trayState>\\.tray\\.setImage\\(\\k<image>\\);` +
      `let codexLinuxSyncScript=${dockIconResourceHelper}\\("sync-desktop-icon\\.sh"\\);` +
      'if\\(require\\("node:fs"\\)\\.existsSync\\(codexLinuxSyncScript\\)\\)try\\{' +
      'let codexLinuxChild=require\\("node:child_process"\\)\\.spawn\\(codexLinuxSyncScript,\\[codexLinuxIconSelection\\],\\{detached:!0,stdio:\\["pipe","ignore","ignore"\\]\\}\\);' +
      'codexLinuxChild\\.on\\("error",\\(\\)=>\\{\\}\\),codexLinuxChild\\.stdin\\.on\\("error",\\(\\)=>\\{\\}\\),' +
      "codexLinuxChild\\.stdin\\.end\\(\\k<image>\\.toPNG\\(\\)\\),codexLinuxChild\\.unref\\(\\)\\}catch\\{\\}return\\}" +
      "\\k<electron>\\.app\\.dock\\?\\.setIcon\\(\\k<image>\\)\\}"
    : `if\\(!(?<image>${id})\\.isEmpty\\(\\)\\)\\{if\\("codex-system"===(?<arg>${id})\\|\\|"space-system"===\\k<arg>\\)\\{${crop}` +
      `(?<electron>${id})\\.app\\.dock\\?\\.setIcon\\(\\k<image>\\)\\}\\}`;
  const updateGate = patched ? `!(?<isMac>${id})&&${notLinux}` : `!(?<isMac>${id})`;

  return {
    preview: new RegExp(
      `dockIconPreviews:(?<include>${id})\\?function\\((?<arg>${id})\\)\\{if\\(${previewGate}\\)return null;let (?<theme>${id})=(?<themeHelper>${id})\\(\\k<arg>\\),` +
        `(?<defaultIcon>${id})=(?<resource>${id})\\(\`\\$\\{(?<iconName>${id})\\(\\k<arg>\\)\\}\\.png\`\\),` +
        `(?<codexDark>${id})=\\k<resource>\\(\\k<theme>\\.dark\\),(?<codexLight>${id})=\\k<resource>\\(\\k<theme>\\.light\\),` +
        `(?<spaceDark>${id})=${spaceDark},(?<spaceLight>${id})=${spaceLight};` +
        "return null==\\k<defaultIcon>\\|\\|null==\\k<codexDark>\\|\\|null==\\k<codexLight>\\|\\|null==\\k<spaceDark>\\|\\|null==\\k<spaceLight>\\?null:" +
        `\\{appDefault:\\k<defaultIcon>,codexDark:\\k<codexDark>,codexLight:\\k<codexLight>,spaceDark:\\k<spaceDark>,spaceLight:\\k<spaceLight>\\}\\}\\((?<preference>${id})\\):null`,
      "g",
    ),
    resourceName: new RegExp(
      `(?<resourceName>${id})=\\((?<preference>${id}),(?<dark>${id})\\)=>\\{switch\\(\\k<preference>\\)\\{case"app-default":return null;` +
        `case"codex-system":return \\k<dark>\\?(?<theme>${id})\\.dark:\\k<theme>\\.light;case"space-system":return ${spaceSystem}\\}\\}`,
      "g",
    ),
    appInfo: new RegExp(
      patched
        ? `function (?<helper>${dockIconResourceHelper})\\((?<helperArg>${id})\\)\\{return ${linuxOnly}\\?\\(0,(?<path>${id})\\.join\\)\\(process\\.resourcesPath,"dock-icon",\\k<helperArg>\\):` +
          `\\(0,\\k<path>\\.join\\)\\(process\\.resourcesPath,\\k<helperArg>\\)\\}${appInfoOwner}`
        : appInfoOwner,
      "g",
    ),
    windowResource: new RegExp(windowResource, "g"),
    applyDefaultGate: new RegExp(applyDefaultGate, "g"),
    applyTail: new RegExp(applyTail, "g"),
    updateHead: new RegExp(
      `(?<update>${id})=\\(\\)=>\\{if\\(${updateGate}\\)return;let (?<preference>${id})=(?<read>${id})\\(\\);(?<apply>${id})\\(\\k<preference>\\),` +
        `\\(function\\(\\{preference:${id},resourceName:${id}\\}\\)\\{`,
      "g",
    ),
    updateTail: new RegExp(
      `\\}\\)\\(\\{preference:(?<preference>${id}),resourceName:(?<resourceName>${id})\\(\\k<preference>,!1\\)\\}\\)` +
        `\\.then\\((?<changed>${id})=>\\{\\k<changed>&&(?<apply>${id})\\((?<read>${id})\\(\\)\\)\\}\\)\\}`,
      "g",
    ),
    windowRegistration: new RegExp(
      `onWindowRegistered:(?<window>${id})=>\\{(?<registrar>${id})\\?\\.registerWindow\\(\\k<window>\\),(?<callback>${id})\\?\\.\\(\\k<window>\\)` +
        `${patched ? `,${linuxOnly}&&setImmediate\\((?<update>${id})\\)` : ""}\\}`,
      "g",
    ),
    tray: new RegExp(
      `(?<tray>${id})=new (?<electron>${id})\\.Tray\\(` +
        (patched
          ? `${linuxOnly}&&globalThis\\.codexLinuxDockIconImage&&!globalThis\\.codexLinuxDockIconImage\\.isEmpty\\(\\)\\?globalThis\\.codexLinuxDockIconImage:`
          : "") +
        `(?<iconInfo>${id})\\.defaultIcon,"win32"===process\\.platform&&\\k<electron>\\.app\\.isPackaged\\?`,
      "g",
    ),
    trayState: new RegExp(
      `let (?<controller>${id})=new (?:${id})\\((?<tray>${id})(?:,|\\))[^;]*;return\\((?<trayState>${id})=\\k<controller>,` +
        "await \\k<controller>\\.waitForReady\\(\\)&&\\k<trayState>===\\k<controller>\\)\\?",
      "g",
    ),
  };
}

// The current signed package keeps the Dock apply callback behind a separate
// appearance-state guard and owns macOS appearance observation in an async
// native observer. Linux adds its nativeTheme listener beside that owner.
function currentMainContract(source, state) {
  const patched = state === "patched";
  const patterns = mainPatterns(state);
  const names = ["preview", "resourceName", "appInfo", "windowResource", "applyDefaultGate", "applyTail",
    "updateHead", "updateTail", "windowRegistration", "tray", "trayState"];
  const contract = Object.fromEntries(names.map((name) => [name, oneMatch(source, patterns[name])]));
  if (Object.values(contract).some((match) => match == null)) return null;
  const applyPrefix = oneMatch(source, new RegExp(patched
    ? `(?<apply>${id})=function ${dockIconApplyHelper}\\((?<arg>${id})\\)\\{if\\("app-default"!==\\k<arg>&&null==(?<themeState>${id})\\)return;if\\((?<devIcons>${id})&&${notLinux}\\)\\{`
    : `(?<apply>${id})=(?<arg>${id})=>\\{if\\("app-default"!==\\k<arg>&&null==(?<themeState>${id})\\)return;if\\((?<devIcons>${id})\\)\\{`, "g"));
  if (applyPrefix == null) return null;
  const themePrefixPattern = new RegExp(
    `if\\((?<isMac>${id})\\)\\{let (?<cleanup>${id}),(?<disposed>${id})=!1;(?<disposables>${id})\\.add\\(\\(\\)=>\\{\\k<disposed>=!0,\\k<cleanup>\\?\\.\\(\\)\\}\\);let (?<listener>${id})=`,
    "g",
  );
  const themePrefix = oneMatch(source, themePrefixPattern);
  const themeMarker = "codexLinuxDockIconThemeListener";
  const markerCount = source.split(themeMarker).length - 1;
  if (themePrefix == null || (patched ? markerCount !== 3 : markerCount !== 0)) return null;
  const themeOpen = themePrefix.index + themePrefix[0].indexOf("{");
  const themeEnd = findMatchingBrace(source, themeOpen);
  if (themeEnd < themeOpen) return null;
  const themeOwner = source.slice(themePrefix.index, themeEnd + 1);
  if (!themeOwner.includes("Failed to observe macOS Dock icon appearance")) return null;
  const groups = Object.fromEntries(Object.entries(contract).map(([name, match]) => [name, match.groups]));
  const aliasesAgree =
    groups.preview.resource === groups.appInfo.owner &&
    sameAliases(groups.appInfo.electron, groups.windowResource.electron, groups.applyTail.electron, groups.tray.electron) &&
    sameAliases(groups.appInfo.path, groups.windowResource.path ?? groups.appInfo.path) &&
    sameAliases(groups.appInfo.exists, groups.windowResource.exists) &&
    sameAliases(applyPrefix.groups.apply, groups.updateHead.apply, groups.updateTail.apply) &&
    sameAliases(groups.resourceName.resourceName, groups.updateTail.resourceName) &&
    sameAliases(applyPrefix.groups.arg, groups.applyDefaultGate.arg, groups.applyTail.arg) &&
    sameAliases(groups.updateHead.read, groups.updateTail.read) &&
    sameAliases(groups.updateHead.preference, groups.updateTail.preference) &&
    sameAliases(groups.updateHead.isMac, themePrefix.groups.isMac) &&
    sameAliases(groups.tray.tray, groups.trayState.tray) &&
    sameAliases(groups.applyTail.trayState ?? groups.trayState.trayState, groups.trayState.trayState);
  if (!aliasesAgree || !themeOwner.endsWith(`,${groups.updateHead.update}()}`)) return null;
  const nativeListener = new RegExp(
    `^(${id})=>\\{if\\(${escapeRegExp(themePrefix.groups.disposed)}\\|\\|${escapeRegExp(applyPrefix.groups.themeState)}===\\1\\)return;` +
      `${escapeRegExp(applyPrefix.groups.themeState)}=\\1;let (${id})=${escapeRegExp(groups.updateHead.read)}\\(\\);` +
      `"app-default"!==\\2&&${escapeRegExp(applyPrefix.groups.apply)}\\(\\2\\)\\};`, "u",
  );
  if (!nativeListener.test(source.slice(themePrefix.index + themePrefix[0].length))) return null;
  const result = { contract: { ...contract, applyPrefix, themePrefix }, groups: {
    ...groups, applyPrefix: applyPrefix.groups, themePrefix: themePrefix.groups,
  }, themeEnd: themeEnd + 1 };
  if (patched && source.slice(themePrefix.index - linuxThemeSource(result).length, themePrefix.index) !== linuxThemeSource(result)) return null;
  return result;
}

function linuxThemeSource({ groups }) {
  const state = groups.applyPrefix.themeState, electron = groups.applyTail.electron;
  const read = groups.updateHead.read, update = groups.updateHead.update, apply = groups.applyPrefix.apply;
  const listener = "codexLinuxDockIconThemeListener";
  return `if("linux"===process.platform){${state}=${electron}.nativeTheme.shouldUseDarkColorsForSystemIntegratedUI;${update}();` +
    `let ${listener}=()=>{${state}=${electron}.nativeTheme.shouldUseDarkColorsForSystemIntegratedUI;let e=${read}();"app-default"!==e&&${apply}(e)};` +
    `${electron}.nativeTheme.on("updated",${listener}),${groups.themePrefix.disposables}.add(()=>{${electron}.nativeTheme.off("updated",${listener})})}`;
}

function currentWindowServices(source, info, graph) {
  if (!graph?.ok || !info) return null;
  const { scope } = graph, { contract, groups } = info;
  const factory = source.slice(scope.factoryStart, scope.factoryEnd);
  const factoryCode = createJavaScriptLexicalIndex(factory);
  if (Object.values(contract).some(match => match.index < scope.factoryStart ||
      match.index + match[0].length > scope.factoryEnd || !factoryCode.isCode(match.index - scope.factoryStart))) return null;
  const startup = source.slice(scope.startupStart, scope.startupEnd);
  const startupCode = createJavaScriptLexicalIndex(startup);
  const declarations = [...startup.matchAll(new RegExp(
    `(?:let|const|var) (?<name>${id})=function\\(\\{(?<parameters>[^{}()]*)\\}\\)\\{`, "gu",
  ))].filter(head => {
    if (!startupCode.isRoot(head.index)) return false;
    const open = scope.startupStart + head.index + head[0].length - 1;
    const close = findMatchingBrace(source, open);
    return open < contract.applyPrefix.index && contract.applyPrefix.index < close &&
      open < contract.windowRegistration.index && contract.windowRegistration.index < close;
  });
  if (declarations.length !== 1) return null;
  const head = declarations[0], open = scope.startupStart + head.index + head[0].length - 1;
  const close = findMatchingBrace(source, open), body = source.slice(open + 1, close);
  if (["resourceName", "windowResource", "applyPrefix", "applyDefaultGate", "applyTail", "updateHead", "updateTail", "themePrefix", "windowRegistration"]
    .some(name => !(open < contract[name].index && contract[name].index + contract[name][0].length <= close))) return null;
  const bodyCode = createJavaScriptLexicalIndex(body);
  try { new Script(`async function nativeWindowServices(){${startup.slice(0, head.index)}const dockDeclaration=0;}`); }
  catch { return null; }
  if (!source.startsWith("({", close + 1)) return null;
  const argumentClose = findMatchingBrace(source, close + 2);
  if (argumentClose < close || source[argumentClose + 1] !== ")") return null;
  const parameter = key => {
    const found = [...head.groups.parameters.matchAll(new RegExp(`(?:^|,)${key}:(${id})(?=,|$)`, "gu"))];
    return found.length === 1 ? found[0][1] : null;
  };
  if (parameter("isMacOS") !== groups.updateHead.isMac || parameter("disposables") !== groups.themePrefix.disposables) return null;
  const returned = [...body.matchAll(/\breturn\{/gu)].filter(match => bodyCode.isRoot(match.index));
  if (returned.length !== 1) return null;
  const completions = serviceCompletions(body, bodyCode);
  if (completions.length !== 1 || completions[0].value !== "return" || completions[0].index !== returned[0].index) return null;
  const recordOpen = returned[0].index + "return".length, recordClose = bodyCode.matchingBrace(recordOpen);
  if (recordClose < recordOpen || !/^\s*;?\s*$/u.test(body.slice(recordClose + 1))) return null;
  const record = body.slice(recordOpen + 1, recordClose), recordCode = createJavaScriptLexicalIndex(record);
  const property = key => {
    const found = [...record.matchAll(new RegExp(`(?:^|,)${key}:(${id})(?=,|$)`, "gu"))]
      .filter(match => recordCode.isRoot(match.index));
    return found.length === 1 ? found[0][1] : null;
  };
  const manager = property("windowManager");
  if (manager == null || property("updateDockIcon") !== groups.updateHead.update) return null;
  const constructed = [...body.matchAll(new RegExp(`(?<![\\w$.])${escapeRegExp(manager)}=new (${id})\\([^{}]*?\\{`, "gu"))]
    .filter(match => bodyCode.isRoot(match.index));
  if (constructed.length !== 1) return null;
  if (parameter("onWindowRegistered") !== groups.windowRegistration.callback ||
      !new RegExp(`(?:let|const|var) ${escapeRegExp(groups.windowRegistration.registrar)}=null,$`, "u")
        .test(body.slice(0, constructed[0].index))) return null;
  const optionsOpen = open + 1 + constructed[0].index + constructed[0][0].length - 1;
  const optionsClose = findMatchingBrace(source, optionsOpen);
  if (!(optionsOpen < contract.windowRegistration.index && contract.windowRegistration.index < optionsClose)) return null;
  if (!new RegExp(`(?<![\\w$.])${escapeRegExp(groups.applyPrefix.themeState)}=null(?=[,;])`, "u").test(body) ||
      !new RegExp(`${escapeRegExp(groups.resourceName.theme)}=${escapeRegExp(groups.preview.themeHelper)}\\(${escapeRegExp(parameter("buildFlavor") ?? "__missing")}\\)`, "u").test(body)) return null;
  const reads = [...body.matchAll(new RegExp(
    `(?<![\\w$.])${escapeRegExp(groups.updateHead.read)}=\\(\\)=>\\{switch\\(${escapeRegExp(parameter("buildFlavor") ?? "__missing")}\\)\\{`, "gu",
  ))].filter(match => bodyCode.isRoot(match.index));
  if (reads.length !== 1) return null;
  const readOpen = reads[0].index + reads[0][0].indexOf("=>{") + 2;
  const readClose = bodyCode.matchingBrace(readOpen);
  if (readClose < readOpen || !new RegExp(
    `return ${escapeRegExp(parameter("settingsStore") ?? "__missing")}\\.get\\(${id}(?:\\.${id})*\\.DOCK_ICON_PREFERENCE\\)\\?\\?"app-default";`, "u",
  ).test(body.slice(readOpen + 1, readClose))) return null;
  const hostName = /^class ([A-Za-z_$][\w$]*)/u.exec(source.slice(scope.hostStart, scope.hostEnd))?.[1];
  if (!hostName) return null;
  const hosts = [...startup.matchAll(new RegExp(`(?<![\\w$.])new ${escapeRegExp(hostName)}\\(\\{`, "gu"))]
    .filter(match => startupCode.isCode(match.index));
  if (hosts.length !== 1) return null;
  const callerHeads = [...startup.matchAll(new RegExp(
    `(?:let|const|var) (?<name>${id})=function\\(\\{(?<parameters>[^{}()]*)\\}\\)\\{`, "gu",
  ))].filter(candidate => {
    const callerOpen = candidate.index + candidate[0].length - 1;
    const callerClose = startupCode.matchingBrace(callerOpen);
    return startupCode.isRoot(candidate.index) && callerOpen < hosts[0].index && hosts[0].index < callerClose;
  });
  if (callerHeads.length !== 1) return null;
  const caller = callerHeads[0], callerOpen = caller.index + caller[0].length - 1;
  const callerClose = startupCode.matchingBrace(callerOpen);
  const callerParameters = [...caller.groups.parameters.matchAll(new RegExp(`(?:^|,)windowServices:(${id})(?=,|$)`, "gu"))];
  if (callerParameters.length !== 1 || !startup.startsWith("({", callerClose + 1)) return null;
  const callerArgumentOpen = callerClose + 2, callerArgumentClose = startupCode.matchingBrace(callerArgumentOpen);
  if (startup[callerArgumentClose + 1] !== ")" || callerArgumentOpen <= argumentClose - scope.startupStart) return null;
  const hostOptionsOpen = hosts[0].index + hosts[0][0].length - 1;
  const hostOptionsClose = startupCode.matchingBrace(hostOptionsOpen);
  if (recordBinding(startup, hostOptionsOpen, hostOptionsClose, "windowManager") !== `${callerParameters[0][1]}.windowManager` ||
      recordBinding(startup, callerArgumentOpen, callerArgumentClose, "windowServices") !== head.groups.name) return null;
  return { factoryId: scope.factoryId, start: open + 1, end: close, binding: head.groups.name,
    windowManager: manager, nativeThemeStart: contract.themePrefix.index, nativeThemeEnd: info.themeEnd };
}

// A label is visible through ordinary blocks, but cannot be jumped to from a
// nested callable. Compile only: this classifies the service's own return/throw
// statements without evaluating any native service code or callback.
function serviceCompletions(body, lexical) {
  let sequence = 0, label;
  do { label = `codexLinuxDockOwnerProof${sequence++}`; } while (body.includes(label));
  return [...body.matchAll(/\b(?:return|throw)\b/gu)].filter(token => {
    if (!lexical.isCode(token.index)) return false;
    const probe = body.slice(0, token.index) + `break ${label};` + body.slice(token.index);
    try { new Script(`function nativeDockServiceProbe(){${label}:{${probe}\n}}`); return true; }
    catch { return false; }
  }).map(token => ({ index: token.index, value: token[0] }));
}

function recordBinding(source, open, close, key) {
  const text = source.slice(open + 1, close), lexical = createJavaScriptLexicalIndex(text);
  const found = [...text.matchAll(new RegExp(`(?:^|,)${key}:(${id}(?:\\.${id})*)(?=,|$)`, "gu"))]
    .filter(match => lexical.isRoot(match.index));
  if (found.length !== 1) return null;
  const property = found[0];
  for (const spread of text.matchAll(/\.\.\./gu)) {
    if (spread.index <= property.index || !lexical.isRoot(spread.index)) continue;
    if (!text.startsWith("...{}", spread.index)) return null;
  }
  return property[1];
}

function dockIconConfig(context) {
  const defaults = context?.feature?.manifest?.tweaks?.appearance?.dockIcon;
  const settings = context?.feature?.settings?.tweaks?.appearance?.dockIcon;
  return {
    ...(defaults != null && typeof defaults === "object" && !Array.isArray(defaults) ? defaults : {}),
    ...(settings != null && typeof settings === "object" && !Array.isArray(settings) ? settings : {}),
  };
}

function dockIconEnabled(context) {
  return dockIconConfig(context).enabled === true;
}

function replaceMatch(source, match, replacement) {
  return source.slice(0, match.index) + replacement + source.slice(match.index + match[0].length);
}

function applyCurrentDockIconMainPatch(source, current) {
  const { contract, groups } = current;
  const preview = groups.preview;
  const info = groups.appInfo;
  const win = groups.windowResource;
  const names = groups.resourceName;
  const tail = groups.applyTail;
  const trayState = groups.trayState.trayState;
  const linux = '"linux"===process.platform';
  const replacements = [
    [contract.preview, `dockIconPreviews:${preview.include}?function(${preview.arg}){if("darwin"!==process.platform&&"linux"!==process.platform)return null;let ${preview.theme}=${preview.themeHelper}(${preview.arg}),${preview.defaultIcon}=${preview.resource}(\`\${${preview.iconName}(${preview.arg})}.png\`),${preview.codexDark}=${preview.resource}(${preview.theme}.dark),${preview.codexLight}=${preview.resource}(${preview.theme}.light),${preview.spaceDark}=${linux}?${preview.codexDark}:${preview.resource}(${preview.theme}.spaceDark),${preview.spaceLight}=${linux}?${preview.codexLight}:${preview.resource}(${preview.theme}.spaceLight);return null==${preview.defaultIcon}||null==${preview.codexDark}||null==${preview.codexLight}||null==${preview.spaceDark}||null==${preview.spaceLight}?null:{appDefault:${preview.defaultIcon},codexDark:${preview.codexDark},codexLight:${preview.codexLight},spaceDark:${preview.spaceDark},spaceLight:${preview.spaceLight}}}(${preview.preference}):null`],
    [contract.appInfo, `function ${dockIconResourceHelper}(${info.arg}){return ${linux}?(0,${info.path}.join)(process.resourcesPath,"dock-icon",${info.arg}):(0,${info.path}.join)(process.resourcesPath,${info.arg})}function ${info.owner}(${info.arg}){if(null==${info.arg})return null;let ${info.candidate}=${info.electron}.app.isPackaged||${linux}?${dockIconResourceHelper}(${info.arg}):null;return ${info.normalize}(null!=${info.candidate}&&(0,${info.exists}.existsSync)(${info.candidate})?${info.candidate}:(0,${info.path}.join)(${info.electron}.app.getAppPath(),"src","icons",${info.arg}))}`],
    [contract.windowResource, `(${win.arg}=>{if(!${win.electron}.app.isPackaged&&"linux"!==process.platform)return null;let ${win.candidate}=${dockIconResourceHelper}(${win.arg});return(0,${win.exists}.existsSync)(${win.candidate})?${win.candidate}:null})`],
    [contract.resourceName, `${names.resourceName}=(${names.preference},${names.dark})=>{switch(${names.preference}){case"app-default":return null;case"codex-system":return ${names.dark}?${names.theme}.dark:${names.theme}.light;case"space-system":return ${linux}?${names.dark}?${names.theme}.dark:${names.theme}.light:${names.dark}?${names.theme}.spaceDark:${names.theme}.spaceLight}}`],
    [contract.applyPrefix, `${groups.applyPrefix.apply}=function ${dockIconApplyHelper}(${groups.applyPrefix.arg}){if("app-default"!==${groups.applyPrefix.arg}&&null==${groups.applyPrefix.themeState})return;if(${groups.applyPrefix.devIcons}&&"linux"!==process.platform){`],
    [contract.applyDefaultGate, contract.applyDefaultGate[0].replace("&&", '&&"linux"!==process.platform&&')],
    [contract.applyTail, `if(${tail.image}.isEmpty())return;if("linux"!==process.platform&&("codex-system"===${tail.arg}||"space-system"===${tail.arg})){let{width:${tail.width},height:${tail.height}}=${tail.image}.getSize(),${tail.inset}=Math.round(${tail.width}/128);${tail.image}=${tail.image}.crop({x:${tail.inset},y:${tail.inset},width:${tail.width}-2*${tail.inset},height:${tail.height}-2*${tail.inset}})}if(${linux}){let codexLinuxIconSelection="codex-system"===${tail.arg}||"space-system"===${tail.arg}?${tail.electron}.nativeTheme.shouldUseDarkColorsForSystemIntegratedUI?"codex-dark":"codex-light":"chatgpt";globalThis.codexLinuxDockIconImage=${tail.image};for(let codexLinuxWindow of ${tail.electron}.BrowserWindow.getAllWindows())codexLinuxWindow.isDestroyed()||codexLinuxWindow.setIcon(${tail.image});null!=${trayState}?.tray&&!${trayState}.tray.isDestroyed()&&${trayState}.tray.setImage(${tail.image});let codexLinuxSyncScript=${dockIconResourceHelper}("sync-desktop-icon.sh");if(require("node:fs").existsSync(codexLinuxSyncScript))try{let codexLinuxChild=require("node:child_process").spawn(codexLinuxSyncScript,[codexLinuxIconSelection],{detached:!0,stdio:["pipe","ignore","ignore"]});codexLinuxChild.on("error",()=>{}),codexLinuxChild.stdin.on("error",()=>{}),codexLinuxChild.stdin.end(${tail.image}.toPNG()),codexLinuxChild.unref()}catch{}return}${tail.electron}.app.dock?.setIcon(${tail.image})}`],
    [contract.updateHead, contract.updateHead[0].replace(`if(!${groups.updateHead.isMac})`, `if(!${groups.updateHead.isMac}&&"linux"!==process.platform)`)],
    [contract.themePrefix, `${linuxThemeSource(current)}${contract.themePrefix[0]}`],
    [contract.windowRegistration, contract.windowRegistration[0].replace(
      `?.(${groups.windowRegistration.window})}`,
      `?.(${groups.windowRegistration.window}),"linux"===process.platform&&setImmediate(${groups.updateHead.update})}`,
    )],
    [contract.tray, contract.tray[0].replace(
      `${groups.tray.iconInfo}.defaultIcon`,
      `"linux"===process.platform&&globalThis.codexLinuxDockIconImage&&!globalThis.codexLinuxDockIconImage.isEmpty()?globalThis.codexLinuxDockIconImage:${groups.tray.iconInfo}.defaultIcon`,
    )],
  ];
  let patchedSource = source;
  for (const [match, replacement] of replacements.sort(([left], [right]) => right.index - left.index)) {
    patchedSource = replaceMatch(patchedSource, match, replacement);
  }
  return currentMainContract(patchedSource, "patched") != null ? patchedSource : source;
}

function restoreCurrentDockIconSource(source, info) {
  const { contract: c, groups: g } = info, tail = g.applyTail, prefix = g.applyPrefix, app = g.appInfo, win = g.windowResource;
  const theme = linuxThemeSource(info);
  const appStart = c.appInfo[0].indexOf(`function ${app.owner}(`);
  if (appStart < 0) return null;
  const appInfo = c.appInfo[0].slice(appStart).replace(
    `${app.electron}.app.isPackaged||"linux"===process.platform?${dockIconResourceHelper}(${app.arg})`,
    `${app.electron}.app.isPackaged?(0,${app.path}.join)(process.resourcesPath,${app.arg})`,
  );
  const edits = [
    [c.preview, c.preview[0].replace('&&"linux"!==process.platform', "")
      .replace(`"linux"===process.platform?${g.preview.codexDark}:`, "")
      .replace(`"linux"===process.platform?${g.preview.codexLight}:`, "")],
    [c.appInfo, appInfo],
    [c.windowResource, `(${win.arg}=>{if(!${win.electron}.app.isPackaged)return null;let ${win.candidate}=(0,${win.path ?? app.path}.join)(process.resourcesPath,${win.arg});return(0,${win.exists}.existsSync)(${win.candidate})?${win.candidate}:null})`],
    [c.resourceName, c.resourceName[0].replace(`case"space-system":return "linux"===process.platform?${g.resourceName.dark}?${g.resourceName.theme}.dark:${g.resourceName.theme}.light:`, 'case"space-system":return ')],
    [c.applyPrefix, `${prefix.apply}=${prefix.arg}=>{if("app-default"!==${prefix.arg}&&null==${prefix.themeState})return;if(${prefix.devIcons}){`],
    [c.applyDefaultGate, c.applyDefaultGate[0].replace('&&"linux"!==process.platform&&', "&&")],
    [c.applyTail, `if(!${tail.image}.isEmpty()){if("codex-system"===${tail.arg}||"space-system"===${tail.arg}){let{width:${tail.width},height:${tail.height}}=${tail.image}.getSize(),${tail.inset}=Math.round(${tail.width}/128);${tail.image}=${tail.image}.crop({x:${tail.inset},y:${tail.inset},width:${tail.width}-2*${tail.inset},height:${tail.height}-2*${tail.inset}})}${tail.electron}.app.dock?.setIcon(${tail.image})}}`],
    [c.updateHead, c.updateHead[0].replace(`if(!${g.updateHead.isMac}&&"linux"!==process.platform)`, `if(!${g.updateHead.isMac})`)],
    [{ index: c.themePrefix.index - theme.length, 0: theme }, ""],
    [c.windowRegistration, c.windowRegistration[0].replace(`,"linux"===process.platform&&setImmediate(${g.updateHead.update})`, "")],
    [c.tray, c.tray[0].replace(`"linux"===process.platform&&globalThis.codexLinuxDockIconImage&&!globalThis.codexLinuxDockIconImage.isEmpty()?globalThis.codexLinuxDockIconImage:`, "")],
  ];
  let native = source;
  for (const [match, replacement] of edits.sort(([a], [b]) => b.index - a.index)) native = replaceMatch(native, match, replacement);
  return native;
}

function dockArtifacts(source) {
  const names = new Set([dockIconResourceHelper, dockIconApplyHelper, "codexLinuxDockIconThemeListener", "codexLinuxDockIconImage"]);
  const tokens = /(?:\\u(?:\{[0-9a-fA-F]+\}|[0-9a-fA-F]{4})|[A-Za-z_$])(?:\\u(?:\{[0-9a-fA-F]+\}|[0-9a-fA-F]{4})|[\w$])*/gu;
  const lexical = createJavaScriptLexicalIndex(source);
  const found = [];
  for (const token of source.matchAll(tokens)) {
    if (!lexical.isCode(token.index)) continue;
    const decoded = token[0].replace(/\\u(?:\{([0-9a-fA-F]+)\}|([0-9a-fA-F]{4}))/gu, (_, braced, fixed) => {
      const value = parseInt(braced ?? fixed, 16);
      return value <= 0x10ffff ? String.fromCodePoint(value) : "\0";
    });
    if (names.has(decoded)) found.push({ name: decoded, encoded: decoded !== token[0] });
  }
  return found;
}

function dockMainState(source) {
  const graph = inspectMainRequestSites(source);
  const invalid = reason => ({ kind: "invalid", graph, reason });
  if (!graph.ok) return invalid("native main request/startup ownership is unavailable");
  const artifacts = dockArtifacts(source);
  if (artifacts.some(token => token.encoded)) return invalid("encoded community icon binding");
  const current = currentMainContract(source, "current"), patched = currentMainContract(source, "patched");
  if (current && !patched && artifacts.length === 0) {
    const services = currentWindowServices(source, current, graph);
    return services ? { kind: "current", graph, info: current, services } : invalid("native window-services owner is missing or ambiguous");
  }
  if (!patched || current) return invalid("incomplete or mixed current icon contract");
  const services = currentWindowServices(source, patched, graph);
  const native = services && restoreCurrentDockIconSource(source, patched);
  if (!native || dockArtifacts(native).length !== 0) return invalid("orphan or misplaced community icon contribution");
  const raw = currentMainContract(native, "current"), rawGraph = inspectMainRequestSites(native);
  if (!raw || !currentWindowServices(native, raw, rawGraph) || applyCurrentDockIconMainPatch(native, raw) !== source) return invalid("community icon source does not recover its native owner");
  return { kind: "patched", graph, info: patched, services };
}

function applyDockIconMainPatch(source) {
  const state = dockMainState(source);
  if (state.kind === "invalid") {
    console.warn(`WARN: Could not find the complete current Dock icon main-process contract: ${state.reason}`);
    return source;
  }
  if (state.kind === "patched") return source;
  const output = applyCurrentDockIconMainPatch(source, state.info);
  new Script(output);
  if (output === source || dockMainState(output).kind !== "patched") throw Error("Incomplete current Dock icon source poststate");
  return output;
}

function patchDockIconMainAssets(extractedDir, options = {}) {
  const inventory = findMainProcessChunks(extractedDir);
  if (!inventory) throw Error("Missing current Dock icon main-process inventory");
  const chunks = inventory.chunks.map(assetName => {
    const source = fs.readFileSync(path.join(inventory.buildDir, assetName), "utf8");
    new Script(source);
    const state = dockMainState(source);
    if (state.graph.factoryIds.length === 0) {
      const lexical = createJavaScriptLexicalIndex(source);
      if ([...source.matchAll(/\bexports\.modules\b/gu)].some(match => lexical.isCode(match.index))) throw Error("Unsupported current Dock icon main module registry");
    }
    return { assetName, source, state };
  });
  const owners = chunks.filter(row => row.state.graph.ok);
  if (owners.length !== 1) throw Error("Missing or ambiguous current Dock icon native startup owner");
  const owner = owners[0], identity = owner.state.graph.scope.factoryId;
  const candidates = chunks.filter(row => row.state.graph.factoryIds?.includes(identity) || dockArtifacts(row.source).length > 0 ||
    row.state.graph.factoryIds?.length === 0 && ["DOCK_ICON_PREFERENCE", "dockIconPreviews:", "CODEX_ELECTRON_DEV_DOCK_ICONS_PATH"].every(needle => row.source.includes(needle)));
  if (candidates.length !== 1 || candidates[0] !== owner || owner.state.kind === "invalid") throw Error("Incomplete or ambiguous current Dock icon source cohort");
  const patchedSource = applyDockIconMainPatch(owner.source);
  const result = commitAssetEdits(inventory.buildDir, chunks.map(row => ({ assetName: row.assetName,
    source: row.source, patchedSource: row === owner ? patchedSource : row.source })), options);
  if (result.changed !== Number(owner.state.kind === "current")) throw Error("Current Dock icon source transaction did not commit its prepared change");
  return { matched: 1, ...result };
}

// The official 26.1029 webview is an rspack/SWC build. The Dock icon row
// visibility gate is one small webpack module that rspack duplicates into
// every async chunk that needs it, so each copy is patched independently:
//   function n({platform:e,dockIconPreviews:t,buildFlavor:a="prod"}){
//     return"macOS"!==e||a===s.x1u.Agent?null:t}
const settingsGateHead =
  `(?:function ${id}|${id}:function)\\(\\{platform:(?<platform>${id}),dockIconPreviews:(?<previews>${id}),` +
  `buildFlavor:(?<flavor>${id})="prod"\\}\\)\\{return"macOS"!==\\k<platform>`;
const settingsGateTail =
  `\\|\\|\\k<flavor>===${id}(?:\\.${id})*\\.Agent\\?null:\\k<previews>\\}`;
const currentSettingsGatePattern = new RegExp(`${settingsGateHead}${settingsGateTail}`, "g");
const patchedSettingsGatePattern = new RegExp(
  `${settingsGateHead}&&"linux"!==\\k<platform>${settingsGateTail}`,
  "g",
);
const SETTINGS_ASSET_NEEDLES = ["dockIconPreviews", "buildFlavor", '"macOS"!=='];

function dockIconSettingsContract(source) {
  const currentMatches = matches(source, currentSettingsGatePattern);
  const patchedMatches = matches(source, patchedSettingsGatePattern);
  if (currentMatches.length === 1 && patchedMatches.length === 0) return "current";
  if (currentMatches.length === 0 && patchedMatches.length === 1) return "patched";
  return "drifted";
}

function applyDockIconSettingsPatch(source) {
  const contract = dockIconSettingsContract(source);
  if (contract === "patched") return source;
  if (contract !== "current") {
    console.warn("WARN: Could not find the current Dock icon settings contract - skipping Dock icon settings patch");
    return source;
  }
  const match = oneMatch(source, currentSettingsGatePattern);
  const platform = match.groups.platform;
  const gate = `return"macOS"!==${platform}`;
  const offset = match[0].indexOf(gate) + gate.length;
  return replaceMatch(
    source,
    match,
    `${match[0].slice(0, offset)}&&"linux"!==${platform}${match[0].slice(offset)}`,
  );
}

const descriptors = [
  {
    id: "appearance-dock-icon-main-process",
    phase: "extracted-app:pre-webview",
    order: 20_940,
    ciPolicy: "optional",
    enabled: dockIconEnabled,
    apply: patchDockIconMainAssets,
    status: result => result.changed > 0 ? "applied" : "already-applied",
  },
  {
    id: "appearance-dock-icon-settings-row",
    phase: "webview-asset",
    order: 20_950,
    ciPolicy: "optional",
    // No assetMatch: every rspack chunk carrying a copy of the gate module is
    // patched, and a candidate without the gate is left unchanged with a warning.
    assetNeedles: SETTINGS_ASSET_NEEDLES,
    missingDescription: "official Linux Dock icon setting visibility bundle",
    skipDescription: "Dock icon settings row patch",
    enabled: dockIconEnabled,
    apply: applyDockIconSettingsPatch,
  },
];

module.exports = {
  SETTINGS_ASSET_NEEDLES,
  applyDockIconMainPatch,
  patchDockIconMainAssets,
  applyDockIconSettingsPatch,
  descriptors,
  dockIconConfig,
  dockIconSettingsContract,
  dockIconEnabled,
};
