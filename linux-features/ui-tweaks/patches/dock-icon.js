"use strict";

const fs = require("node:fs");
const path = require("node:path");
const { Script } = require("node:vm");
const nativeController = require("./dock-icon-contract.json");
// Feature discovery also loads disabled copies without the ASAR framework.
function createJavaScriptLexicalIndex(source) { return require("../../../scripts/patches/lib/minified-js.js").createJavaScriptLexicalIndex(source); }
function escapeRegExp(source) { return require("../../../scripts/patches/lib/minified-js.js").escapeRegExp(source); }
function findMatchingBrace(source, open) { return require("../../../scripts/patches/lib/minified-js.js").findMatchingBrace(source, open); }
function inspectMainRequestSites(source) { return require("../../../scripts/patches/lib/main-request-sites.js").inspectMainRequestSites(source); }
function mainProcessFactories(source) { return require("../../../scripts/patches/lib/main-process-factories.js").mainProcessFactories(source); }
function findMainProcessChunks(directory) { return require("../../../scripts/patches/lib/assets.js").findMainProcessChunks(directory); }
function commitAssetEdits(...args) { return require("../../../scripts/patches/lib/asset-edits.js").commitAssetEdits(...args); }
function bindingAuthority() { return require("../../../scripts/patches/lib/javascript-binding-authority.js"); }

const id = "[A-Za-z_$][\\w$]*";
const linuxOnly = '"linux"===process.platform';
const notLinux = '"linux"!==process.platform';
const dockIconResourceHelper = "codexLinuxDockIconResourcePath";
const dockIconApplyHelper = "codexLinuxApplyDockIcon";
const COMMUNITY_NAMES = new Set([dockIconResourceHelper, dockIconApplyHelper, "codexLinuxDockIconThemeListener", "codexLinuxDockIconImage",
  "codexLinuxIconSelection", "codexLinuxWindow", "codexLinuxSyncScript", "codexLinuxChild"]);
const FIXED = new Set(("async await function return if else for of let const var new this true false null undefined void typeof instanceof try catch throw switch case break " +
  "process globalThis require Reflect Math Promise Error Number String Object Array Set Map setImmediate").split(" "));
for (const name of COMMUNITY_NAMES) FIXED.add(name);

function matches(source, pattern) {
  pattern.lastIndex = 0;
  return typeof source === "string" ? [...source.matchAll(pattern)] : [];
}
function oneMatch(source, pattern) {
  const found = matches(source, pattern);
  return found.length === 1 ? found[0] : null;
}
function sameAliases(...aliases) { return aliases.every(alias => alias === aliases[0]); }
function parses(source) { try { new Script(source); return true; } catch { return false; } }
function replaceOnce(source, before, after) {
  if (source.split(before).length !== 2) throw Error("Changed native Dock controller seam");
  return source.replace(before, after);
}
function controllerTokens(source) {
  const lexical = createJavaScriptLexicalIndex(source);
  return [...source.matchAll(/[A-Za-z_$][\w$]*/gu)].filter(token => lexical.isCode(token.index) && !FIXED.has(token[0]) &&
    (source[token.index - 1] !== "." || source.slice(token.index - 3, token.index) === "...") && !/^\s*:/u.test(source.slice(token.index + token[0].length)));
}
function normalizeController(source, parameters) {
  const names = new Map(parameters.map((name, index) => [name, "$" + index]));
  let text = "", cursor = 0;
  for (const token of controllerTokens(source)) {
    if (!names.has(token[0])) names.set(token[0], "$" + names.size);
    text += source.slice(cursor, token.index) + names.get(token[0]);
    cursor = token.index + token[0].length;
  }
  return { text: text + source.slice(cursor), names };
}
function controllerAliases(source, expected, parameters) {
  const actual = normalizeController(source, parameters), template = normalizeController(expected, nativeController.parameters);
  if (actual.text !== template.text) return null;
  const inverse = new Map([...actual.names].map(([name, canonical]) => [canonical, name]));
  return new Map([...template.names].map(([name, canonical]) => [name, inverse.get(canonical)]));
}
function renderController(source, aliases) {
  let text = "", cursor = 0;
  for (const token of controllerTokens(source)) {
    text += source.slice(cursor, token.index) + (aliases.get(token[0]) ?? token[0]);
    cursor = token.index + token[0].length;
  }
  return text + source.slice(cursor);
}

function linuxControllerBody() {
  let body = nativeController.body;
  body = replaceOnce(body, '"space-system":{light:c.spaceLight,dark:c.spaceDark',
    `"space-system":{light:${linuxOnly}?c.light:c.spaceLight,dark:${linuxOnly}?c.dark:c.spaceDark`);
  body = replaceOnce(body, 'p=[...eZ.app.isPackaged?[process.resourcesPath]:[],',
    `p=[...${linuxOnly}?[(0,eJ.join)(process.resourcesPath,"dock-icon")]:eZ.app.isPackaged?[process.resourcesPath]:[],`);
  body = replaceOnce(body, "m=null,g=!1", `m=${linuxOnly}?{dark:eZ.nativeTheme.shouldUseDarkColorsForSystemIntegratedUI,style:"regular"}:null,g=!1`);
  body = replaceOnce(body, "y=t=>{", `y=function ${dockIconApplyHelper}(t){`);
  body = replaceOnce(body, 'n=e!==tk.x.Agent&&null!=m&&"regular"!==m.style',
    `n=${notLinux}&&e!==tk.x.Agent&&null!=m&&"regular"!==m.style`);
  body = replaceOnce(body, 'if("app-default"===t&&e!==tk.x.Dev&&!h){',
    `if("app-default"===t&&${notLinux}&&e!==tk.x.Dev&&!h){`);
  body = replaceOnce(body, "if(h){", `if(h&&${notLinux}){`);
  const nativeTail = 'if(!a.isEmpty()){if("app-default"!==t){let{width:e,height:t}=a.getSize(),r=Math.round(e/128);a=a.crop({x:r,y:r,width:e-2*r,height:t-2*r})}eZ.app.dock?.setIcon(a)}';
  const linuxTail = `if(a.isEmpty())return;if(${notLinux}&&"app-default"!==t){let{width:e,height:t}=a.getSize(),r=Math.round(e/128);a=a.crop({x:r,y:r,width:e-2*r,height:t-2*r})}` +
    `if(${linuxOnly}){let codexLinuxIconSelection="codex-system"===t||"space-system"===t?eZ.nativeTheme.shouldUseDarkColorsForSystemIntegratedUI?"codex-dark":"codex-light":"chatgpt";` +
    'globalThis.codexLinuxDockIconImage=a;for(let codexLinuxWindow of eZ.BrowserWindow.getAllWindows())codexLinuxWindow.isDestroyed()||codexLinuxWindow.setIcon(a);' +
    'null!=__dockTrayState?.tray&&!__dockTrayState.tray.isDestroyed()&&__dockTrayState.tray.setImage(a);' +
    `let codexLinuxSyncScript=${dockIconResourceHelper}("sync-desktop-icon.sh");if(require("node:fs").existsSync(codexLinuxSyncScript))try{` +
    'let codexLinuxChild=require("node:child_process").spawn(codexLinuxSyncScript,[codexLinuxIconSelection],{detached:!0,stdio:["pipe","ignore","ignore"]});' +
    'codexLinuxChild.on("error",()=>{}),codexLinuxChild.stdin.on("error",()=>{}),codexLinuxChild.stdin.end(a.toPNG()),codexLinuxChild.unref()}catch{}return}eZ.app.dock?.setIcon(a)';
  body = replaceOnce(body, nativeTail, linuxTail);
  body = replaceOnce(body, "v=()=>{let e=f();y(e);", `v=()=>{let e=f();y(e);if(${linuxOnly})return;`);
  const lead = "return s.add(()=>{g=!0,l?.()}),", tail = ",v(),v";
  const start = body.lastIndexOf(lead), end = body.length - tail.length;
  if (start < 0 || !body.endsWith(tail)) throw Error("Changed native Dock observer ownership");
  const observer = body.slice(start + lead.length, end);
  const linuxObserver = '(()=>{let codexLinuxDockIconThemeListener=()=>{if(g)return;m={dark:eZ.nativeTheme.shouldUseDarkColorsForSystemIntegratedUI,style:"regular"};let e=f();"app-default"!==e&&y(e)};' +
    'eZ.nativeTheme.on("updated",codexLinuxDockIconThemeListener);return()=>eZ.nativeTheme.off("updated",codexLinuxDockIconThemeListener)})()';
  return body.slice(0, start) + lead + `(${linuxOnly}?l=${linuxObserver}:${observer})` + tail;
}

function mainPatterns(state) {
  const patched = state === "patched", linux = '"linux"===process\\.platform';
  const previewGate = patched ? '"darwin"!==process\\.platform&&"linux"!==process\\.platform' : '"darwin"!==process\\.platform';
  const packaged = patched ? `(?<electron>${id})\\.app\\.isPackaged\\|\\|${linux}\\?${dockIconResourceHelper}\\(\\k<arg>\\):null` :
    `(?<electron>${id})\\.app\\.isPackaged\\?\\(0,(?<path>${id})\\.join\\)\\(process\\.resourcesPath,\\k<arg>\\):null`;
  const appInfo = `function (?<owner>${id})\\((?<arg>${id})\\)\\{if\\(null==\\k<arg>\\)return null;let (?<candidate>${id})=${packaged};` +
    `return (?<normalize>${id})\\(null!=\\k<candidate>&&\\(0,(?<exists>${id})\\.existsSync\\)\\(\\k<candidate>\\)\\?\\k<candidate>:\\(0,\\k<path>\\.join\\)\\(\\k<electron>\\.app\\.getAppPath\\(\\),"src","icons",\\k<arg>\\)\\)\\}`;
  return {
    preview: new RegExp(`dockIconPreviews:(?<include>${id})\\?function\\((?<arg>${id})\\)\\{if\\(${previewGate}\\)return null;let (?<theme>${id})=(?<themeHelper>${id})\\(\\k<arg>\\),` +
      `(?<defaultIcon>${id})=(?<resource>${id})\\(\`\\$\\{(?<iconName>${id})\\(\\k<arg>\\)\\}\\.png\`\\),(?<codexDark>${id})=\\k<resource>\\(\\k<theme>\\.dark\\),(?<codexLight>${id})=\\k<resource>\\(\\k<theme>\\.light\\),` +
      `(?<spaceDark>${id})=${patched ? linux + "\\?\\k<codexDark>:" : ""}\\k<resource>\\(\\k<theme>\\.spaceDark\\),(?<spaceLight>${id})=${patched ? linux + "\\?\\k<codexLight>:" : ""}\\k<resource>\\(\\k<theme>\\.spaceLight\\);` +
      'return null==\\k<defaultIcon>\\|\\|null==\\k<codexDark>\\|\\|null==\\k<codexLight>\\|\\|null==\\k<spaceDark>\\|\\|null==\\k<spaceLight>\\?null:' +
      `\\{appDefault:\\k<defaultIcon>,codexDark:\\k<codexDark>,codexLight:\\k<codexLight>,spaceDark:\\k<spaceDark>,spaceLight:\\k<spaceLight>\\}\\}\\((?<preference>${id})\\):null`, "g"),
    appInfo: new RegExp(patched ? `function ${dockIconResourceHelper}\\((?<helperArg>${id})\\)\\{return ${linux}\\?\\(0,(?<path>${id})\\.join\\)\\(process\\.resourcesPath,"dock-icon",\\k<helperArg>\\):\\(0,\\k<path>\\.join\\)\\(process\\.resourcesPath,\\k<helperArg>\\)\\}${appInfo}` : appInfo, "g"),
    windowRegistration: new RegExp(`onWindowRegistered:(?<window>${id})=>\\{(?<registrar>${id})\\?\\.registerWindow\\(\\k<window>\\),(?<callback>${id})\\?\\.\\(\\k<window>\\)` +
      (patched ? `,${linux}&&setImmediate\\((?<update>${id})\\)` : "") + "\\}", "g"),
    tray: new RegExp(`(?<tray>${id})=new (?<electron>${id})\\.Tray\\(` +
      (patched ? `${linux}&&globalThis\\.codexLinuxDockIconImage&&!globalThis\\.codexLinuxDockIconImage\\.isEmpty\\(\\)\\?globalThis\\.codexLinuxDockIconImage:` : "") +
      `(?<iconInfo>${id})\\.defaultIcon,"win32"===process\\.platform&&\\k<electron>\\.app\\.isPackaged\\?`, "g"),
    trayState: new RegExp(`let (?<controller>${id})=new (?:${id})\\((?<tray>${id})(?:,|\\))[^;]*;return\\((?<trayState>${id})=\\k<controller>,await \\k<controller>\\.waitForReady\\(\\)&&\\k<trayState>===\\k<controller>\\)\\?`, "g"),
  };
}
function currentController(source, state) {
  const patched = state === "patched";
  const header = oneMatch(source, new RegExp(`(?<![\\w$.])(?<update>${id})=(?<isMac>${id})` + (patched ? '\\|\\|"linux"===process\\.platform' : "") +
    `\\?function\\(\\{buildFlavor:(?<flavor>${id}),repoRoot:(?<repo>${id}),isDevMode:(?<dev>${id}),settingsStore:(?<settings>${id}),disposables:(?<disposables>${id}),errorReporter:(?<report>${id})\\}\\)\\{`, "gu"));
  if (!header) return null;
  const open = header.index + header[0].length - 1, close = findMatchingBrace(source, open);
  if (close < open || !source.startsWith("({", close + 1)) return null;
  const argumentOpen = close + 2, argumentClose = findMatchingBrace(source, argumentOpen), suffix = "):()=>{}";
  if (argumentClose < argumentOpen || !source.startsWith(suffix, argumentClose + 1)) return null;
  const end = argumentClose + 1 + suffix.length, body = source.slice(open + 1, close);
  const parameters = ["flavor", "repo", "dev", "settings", "disposables", "report"].map(key => header.groups[key]);
  if (new Set(parameters).size !== parameters.length || parameters.some(name => FIXED.has(name))) return null;
  const aliases = controllerAliases(body, patched ? linuxControllerBody() : nativeController.body, parameters);
  if (!aliases || renderController(patched ? linuxControllerBody() : nativeController.body, aliases) !== body) return null;
  const argumentsByKey = Object.fromEntries(["buildFlavor", "repoRoot", "isDevMode", "settingsStore", "disposables", "errorReporter"]
    .map(key => [key, recordBinding(source, argumentOpen, argumentClose, key)]));
  if (Object.values(argumentsByKey).some(value => !value || !new RegExp(`^${id}$`, "u").test(value))) return null;
  return { index: header.index, end, header, open, close, body, parameters, aliases, argumentsByKey,
    nativeExpression: header[0].replace('||"linux"===process.platform', "") + renderController(nativeController.body, aliases) + source.slice(close, end) };
}
function currentMainContract(source, state) {
  const patterns = mainPatterns(state), contract = Object.fromEntries(Object.entries(patterns).map(([name, pattern]) => [name, oneMatch(source, pattern)]));
  if (Object.values(contract).some(value => !value)) return null;
  const controller = currentController(source, state);
  if (!controller) return null;
  const groups = Object.fromEntries(Object.entries(contract).map(([name, match]) => [name, match.groups]));
  const aliases = controller.aliases;
  if (groups.preview.resource !== groups.appInfo.owner || !sameAliases(aliases.get("eZ"), groups.appInfo.electron, groups.tray.electron) ||
      aliases.get("eJ") !== groups.appInfo.path || aliases.get("re") !== groups.appInfo.exists || aliases.get("EH") !== groups.preview.themeHelper ||
      aliases.get("EU") !== groups.preview.iconName || groups.tray.tray !== groups.trayState.tray ||
      state === "patched" && (groups.windowRegistration.update !== controller.header.groups.update || aliases.get("__dockTrayState") !== groups.trayState.trayState)) return null;
  return { contract, groups, controller };
}

function declaredBinding(body, parameters, name) {
  if (!parses(`async function nativeDockBindings(${parameters}){${body}\n}`)) return false;
  return !parses(`async function nativeDockBindings(${parameters}){${body}\n;let ${name};}`);
}
function nativeDeclarator(body, lexical, at, name) {
  const heads = [...body.matchAll(/\b(?:let|const|var)\s+/gu)].filter(head => head.index <= at && lexical.isRoot(head.index));
  const head = heads.at(-1);
  if (!head || !parses(`async function nativeDockEntry(){${body.slice(0, head.index)}\nconst dockEntry=0;}`)) return false;
  return parses(`async function nativeDockDeclaration(){for(${body.slice(head.index, at)}${name}=0;;){break;}}`);
}
const authorityCache = new Map();
function authority(body, parameters) {
  const key = parameters.join(",") + "\0" + body;
  if (authorityCache.has(key)) return authorityCache.get(key);
  const prepared = bindingAuthority().prepareBindingAuthority(body, parameters);
  if (authorityCache.size === 8) authorityCache.delete(authorityCache.keys().next().value);
  authorityCache.set(key, prepared);
  return prepared;
}
function readonlyBindings(body, parameters, names, initializers = new Map()) {
  const prepared = authority(body, parameters);
  return names.every(name => bindingAuthority().proveBindingAuthority(prepared, name, initializers.get(name) ?? []).stable);
}
function currentWindowServices(source, info, graph) {
  if (!graph?.ok || !info) return null;
  const { scope } = graph, { contract, groups, controller } = info;
  const factory = mainProcessFactories(source).find(value => value.start === scope.factoryStart && value.end === scope.factoryEnd);
  if (!factory) return null;
  const factoryCode = createJavaScriptLexicalIndex(factory.body);
  if (Object.values(contract).some(match => match.index < factory.start || match.index + match[0].length > factory.end || !factoryCode.isCode(match.index - factory.start))) return null;
  const startup = source.slice(scope.startupStart, scope.startupEnd), startupCode = createJavaScriptLexicalIndex(startup);
  const startupHeader = new RegExp(`\\((?<parameter>${id})?\\)\\{$`, "u").exec(source.slice(0, scope.startupStart));
  if (!startupHeader) return null;
  const ambient = ["require", "process", "globalThis", "Math", "Reflect", "Promise", "setImmediate"];
  for (const name of ambient) {
    if (factory.parameters.includes(name) || startupHeader.groups.parameter === name ||
        declaredBinding(factory.body, factory.parameters.join(","), name) || declaredBinding(startup, startupHeader.groups.parameter ?? "", name)) return null;
  }
  const declarations = [...startup.matchAll(new RegExp(`(?<![\\w$.])(?<name>${id})=function\\(\\{(?<parameters>[^{}()]*)\\}\\)\\{`, "gu"))].filter(head => {
    if (!startupCode.isRoot(head.index)) return false;
    const open = scope.startupStart + head.index + head[0].length - 1, close = findMatchingBrace(source, open);
    return open < controller.index && controller.end < close && open < contract.windowRegistration.index && contract.windowRegistration.index < close;
  });
  if (declarations.length !== 1) return null;
  const head = declarations[0], open = scope.startupStart + head.index + head[0].length - 1, close = findMatchingBrace(source, open), body = source.slice(open + 1, close), bodyCode = createJavaScriptLexicalIndex(body);
  if (!nativeDeclarator(startup, startupCode, head.index, head.groups.name) || !declaredBinding(startup, "", head.groups.name) || !source.startsWith("({", close + 1)) return null;
  const windowInitializer = startup.slice(0, head.index) + "__dockWindowInitializer" + startup.slice(head.index + head.groups.name.length);
  if (!bindingAuthority().hasStableEagerMainBinding(windowInitializer, head.groups.name)) return null;
  const argumentClose = findMatchingBrace(source, close + 2);
  if (argumentClose < close || source[argumentClose + 1] !== ")") return null;
  const pairs = [...head.groups.parameters.matchAll(new RegExp(`(?:^|,)(${id}):(${id})(?=,|=|$)`, "gu"))];
  const parameter = key => pairs.filter(pair => pair[1] === key).map(pair => pair[2]);
  const value = key => parameter(key).length === 1 ? parameter(key)[0] : null;
  const parameters = pairs.map(pair => pair[2]);
  if (new Set(parameters).size !== parameters.length || parameters.some(name => FIXED.has(name)) || value("isMacOS") !== controller.header.groups.isMac) return null;
  for (const key of ["buildFlavor", "repoRoot", "isDevMode", "settingsStore", "disposables", "errorReporter"]) if (controller.argumentsByKey[key] !== value(key)) return null;
  const update = controller.header.groups.update, controllerAt = controller.index - open - 1;
  if (parameters.includes(update) || !nativeDeclarator(body, bodyCode, controllerAt, update) || !declaredBinding(body, "{" + head.groups.parameters + "}", update)) return null;
  const external = [...new Set(["eZ", "eJ", "re", "EH", "EU", "tk", "e0", "eAs"].map(name => controller.aliases.get(name)))];
  if (external.some(name => !name || parameters.includes(name))) return null;
  const protectedNames = [...external, head.groups.name, "process", "require", "globalThis", "Math", "Reflect", "Promise", "setImmediate", update];
  if (!readonlyBindings(body, parameters, protectedNames, new Map([[update, [controllerAt]]]))) return null;
  const returned = [...body.matchAll(/\breturn\{/gu)].filter(match => bodyCode.isRoot(match.index)), completions = serviceCompletions(body, bodyCode);
  if (returned.length !== 1 || completions.length !== 1 || completions[0].value !== "return" || completions[0].index !== returned[0].index) return null;
  const recordOpen = returned[0].index + "return".length, recordClose = bodyCode.matchingBrace(recordOpen);
  if (recordClose < recordOpen || !/^\s*;?\s*$/u.test(body.slice(recordClose + 1))) return null;
  const manager = recordBinding(body, recordOpen, recordClose, "windowManager");
  if (!manager || recordBinding(body, recordOpen, recordClose, "updateDockIcon") !== update) return null;
  const construction = [...body.matchAll(new RegExp(`(?<![\\w$.])${escapeRegExp(manager)}=new (${id})\\([^{}]*?\\{`, "gu"))].filter(match => bodyCode.isRoot(match.index));
  if (construction.length !== 1 || !nativeDeclarator(body, bodyCode, construction[0].index, manager)) return null;
  const optionsOpen = construction[0].index + construction[0][0].length - 1, optionsClose = bodyCode.matchingBrace(optionsOpen);
  if (!(open + 1 + optionsOpen < contract.windowRegistration.index && contract.windowRegistration.index < open + 1 + optionsClose) || value("onWindowRegistered") !== groups.windowRegistration.callback) return null;
  const prefix = body.slice(0, construction[0].index), registrar = groups.windowRegistration.registrar;
  const initializer = new RegExp(`(?<![\\w$.])${escapeRegExp(registrar)}=null,$`, "u").exec(prefix);
  if (!initializer || !nativeDeclarator(body, bodyCode, initializer.index, registrar)) return null;
  const hostName = /^class ([A-Za-z_$][\w$]*)/u.exec(source.slice(scope.hostStart, scope.hostEnd))?.[1];
  if (!hostName) return null;
  const hosts = [...startup.matchAll(new RegExp(`(?<![\\w$.])new ${escapeRegExp(hostName)}\\(\\{`, "gu"))].filter(match => startupCode.isCode(match.index));
  if (hosts.length !== 1) return null;
  const callers = [...startup.matchAll(new RegExp(`(?<![\\w$.])(?<name>${id})=function\\(\\{(?<parameters>[^{}()]*)\\}\\)\\{`, "gu"))].filter(candidate => {
    if (!startupCode.isRoot(candidate.index)) return false;
    const at = candidate.index + candidate[0].length - 1, end = startupCode.matchingBrace(at);
    return at < hosts[0].index && hosts[0].index < end;
  });
  if (callers.length !== 1) return null;
  const caller = callers[0], callerOpen = caller.index + caller[0].length - 1, callerClose = startupCode.matchingBrace(callerOpen);
  const callerPairs = [...caller.groups.parameters.matchAll(new RegExp(`(?:^|,)(${id}):(${id})(?=,|=|$)`, "gu"))];
  const windowParameters = callerPairs.filter(pair => pair[1] === "windowServices");
  if (windowParameters.length !== 1 || !nativeDeclarator(startup, startupCode, caller.index, caller.groups.name) || !startup.startsWith("({", callerClose + 1)) return null;
  const callerArgumentOpen = callerClose + 2, callerArgumentClose = startupCode.matchingBrace(callerArgumentOpen), windowParameter = windowParameters[0][2];
  if (recordBinding(startup, callerArgumentOpen, callerArgumentClose, "windowServices") !== head.groups.name) return null;
  const hostOptionsOpen = hosts[0].index + hosts[0][0].length - 1, hostOptionsClose = startupCode.matchingBrace(hostOptionsOpen);
  if (recordBinding(startup, hostOptionsOpen, hostOptionsClose, "windowManager") !== windowParameter + ".windowManager" ||
      recordBinding(startup, hostOptionsOpen, hostOptionsClose, "updateDockIcon") !== windowParameter + ".updateDockIcon") return null;
  if (!readonlyBindings(startup.slice(callerOpen + 1, callerClose), callerPairs.map(pair => pair[2]), [windowParameter])) return null;
  return { factoryId: scope.factoryId, start: open + 1, end: close, binding: head.groups.name, windowManager: manager };
}
function serviceCompletions(body, lexical) {
  let sequence = 0, label;
  do { label = `codexLinuxDockOwnerProof${sequence++}`; } while (body.includes(label));
  return [...body.matchAll(/\b(?:return|throw)\b/gu)].filter(token => {
    if (!lexical.isCode(token.index)) return false;
    const probe = body.slice(0, token.index) + `break ${label};` + body.slice(token.index);
    return parses(`async function nativeDockServiceProbe(){${label}:{${probe}\n}}`);
  }).map(token => ({ index: token.index, value: token[0] }));
}
function recordBinding(source, open, close, key) {
  const text = source.slice(open + 1, close), lexical = createJavaScriptLexicalIndex(text), ends = [];
  for (const comma of text.matchAll(/,/gu)) if (lexical.isRoot(comma.index) && parses(`({${text.slice(0, comma.index)}})`)) ends.push(comma.index);
  let start = 0, found = null;
  for (const end of [...ends, text.length]) {
    const member = text.slice(start, end).trim();start = end + 1;
    if (member.startsWith("...")) { if (found != null && member !== "...{}") return null; continue; }
    const data = new RegExp(`^(${id})\\s*:\\s*([\\s\\S]+)$`, "u").exec(member);
    const method = new RegExp(`^(?:(?:get|set)\\s+)?(${id})\\s*\\(`, "u").exec(member);
    if (!data && !method) return null;
    const name = data?.[1] ?? method[1];
    if (name !== key) continue;
    if (!data || found != null || !new RegExp(`^${id}(?:\\.${id})*$`, "u").test(data[2])) return null;
    found = data[2];
  }
  return found;
}

function applyCurrentDockIconMainPatch(source, current) {
  const { contract, groups, controller } = current, p = groups.preview, app = groups.appInfo;
  const aliases = new Map(controller.aliases);aliases.set("__dockTrayState", groups.trayState.trayState);
  const controllerHeader = controller.header[0].replace(`${controller.header.groups.update}=${controller.header.groups.isMac}?`, `${controller.header.groups.update}=${controller.header.groups.isMac}||${linuxOnly}?`);
  const controllerSource = controllerHeader + renderController(linuxControllerBody(), aliases) + source.slice(controller.close, controller.end);
  const edits = [
    [contract.preview, contract.preview[0].replace('"darwin"!==process.platform', '"darwin"!==process.platform&&"linux"!==process.platform')
      .replace(`${p.spaceDark}=${p.resource}(${p.theme}.spaceDark)`, `${p.spaceDark}=${linuxOnly}?${p.codexDark}:${p.resource}(${p.theme}.spaceDark)`)
      .replace(`${p.spaceLight}=${p.resource}(${p.theme}.spaceLight)`, `${p.spaceLight}=${linuxOnly}?${p.codexLight}:${p.resource}(${p.theme}.spaceLight)`)],
    [contract.appInfo, `function ${dockIconResourceHelper}(${app.arg}){return ${linuxOnly}?(0,${app.path}.join)(process.resourcesPath,"dock-icon",${app.arg}):(0,${app.path}.join)(process.resourcesPath,${app.arg})}` +
      contract.appInfo[0].replace(`${app.electron}.app.isPackaged?(0,${app.path}.join)(process.resourcesPath,${app.arg})`, `${app.electron}.app.isPackaged||${linuxOnly}?${dockIconResourceHelper}(${app.arg})`)],
    [{ index: controller.index, 0: source.slice(controller.index, controller.end) }, controllerSource],
    [contract.windowRegistration, contract.windowRegistration[0].replace(`?.(${groups.windowRegistration.window})}`, `?.(${groups.windowRegistration.window}),${linuxOnly}&&setImmediate(${controller.header.groups.update})}`)],
    [contract.tray, contract.tray[0].replace(`${groups.tray.iconInfo}.defaultIcon`, `${linuxOnly}&&globalThis.codexLinuxDockIconImage&&!globalThis.codexLinuxDockIconImage.isEmpty()?globalThis.codexLinuxDockIconImage:${groups.tray.iconInfo}.defaultIcon`)],
  ];
  let result = source;
  for (const [match, replacement] of edits.sort(([a], [b]) => b.index - a.index)) result = replaceMatch(result, match, replacement);
  return result;
}
function restoreCurrentDockIconSource(source, info) {
  const { contract: c, groups: g, controller } = info, app = g.appInfo, start = c.appInfo[0].indexOf(`function ${app.owner}(`);
  if (start < 0) return null;
  const edits = [
    [c.preview, c.preview[0].replace('&&"linux"!==process.platform', "").replace(`${linuxOnly}?${g.preview.codexDark}:`, "").replace(`${linuxOnly}?${g.preview.codexLight}:`, "")],
    [c.appInfo, c.appInfo[0].slice(start).replace(`${app.electron}.app.isPackaged||${linuxOnly}?${dockIconResourceHelper}(${app.arg})`, `${app.electron}.app.isPackaged?(0,${app.path}.join)(process.resourcesPath,${app.arg})`)],
    [{ index: controller.index, 0: source.slice(controller.index, controller.end) }, controller.nativeExpression],
    [c.windowRegistration, c.windowRegistration[0].replace(`,${linuxOnly}&&setImmediate(${controller.header.groups.update})`, "")],
    [c.tray, c.tray[0].replace(`${linuxOnly}&&globalThis.codexLinuxDockIconImage&&!globalThis.codexLinuxDockIconImage.isEmpty()?globalThis.codexLinuxDockIconImage:`, "")],
  ];
  let result = source;
  for (const [match, replacement] of edits.sort(([a], [b]) => b.index - a.index)) result = replaceMatch(result, match, replacement);
  return result;
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
