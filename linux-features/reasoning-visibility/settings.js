"use strict";

const fs = require("node:fs");
const path = require("node:path");
const { findMatchingBrace, escapeRegExp } = require("../../scripts/patches/lib/minified-js.js");
const { listWebviewScriptAssets } = require("../../scripts/patches/lib/assets.js");
const { patchBreaksJavaScriptSyntax } = require("../../scripts/patches/lib/javascript-syntax.js");
const { STORAGE_KEY } = require("./runtime.js");
const translations = require("./translations.json");

const ID = "[A-Za-z_$][\\w$]*";
const MEMBER = `${ID}(?:\\.${ID})*`;
const CALLEE = `(?:\\(0,${ID}\\.${ID}\\)|${ID})`;
const UI = "codexLinuxReasoningVisibilitySetting";
const MESSAGE_IDS = ["label", "description", "saveError"].map((suffix) => `settings.general.reasoningVisibility.${suffix}`);
const SETTINGS_NEEDLES = ["settings.general.macMenuBar.description", ".macMenuBarEnabled"];
const LOADER_NEEDLES = ['"../locales/', '.json":function(){return '];
const unique = (source, pattern) => {
  const matches = [...source.matchAll(pattern)];
  return matches.length === 1 ? matches[0] : null;
};

// rspack chunk: `export const __webpack_modules__={key(module,exports,require){…},…}`.
// Returns the module factory that contains `index`, so injected code shares
// that module's scope and captures only aliases declared by that factory.
function webpackFactory(source, index) {
  const head = "__webpack_modules__={";
  const start = source.indexOf(head);
  if (start < 0) return null;
  const entry = new RegExp(`(?:[\\w$]+|"(?:[^"\\\\]|\\\\.)*")\\((${ID}(?:,${ID}){0,2})?\\)\\{`, "y");
  let cursor = start + head.length;
  for (;;) {
    entry.lastIndex = cursor;
    const match = entry.exec(source);
    if (!match) return null;
    const open = entry.lastIndex - 1;
    const end = findMatchingBrace(source, open);
    if (end < 0) return null;
    if (index > open && index < end) return { open, end, params: (match[1] ?? "").split(",") };
    cursor = end + 1;
    if (source[cursor] !== ",") return null;
    cursor += 1;
  }
}

// Factory-scope alias bound to one required module, e.g. `m=a("zd8w")`.
function factoryImport(factory, requireName, alias) {
  const declarations = [...factory.matchAll(new RegExp(`(?<![\\w$.])${escapeRegExp(alias)}=${escapeRegExp(requireName)}\\("([^"]+)"\\)`, "g"))];
  return declarations.length === 1 ? declarations[0][1] : null;
}

// Reuse the native General row, switch, locale hook, platform hook and React
// namespace. All aliases are captured from the current menu-bar setting and its
// own module factory, never from chunk or module ids.
function settingsContract(source) {
  const owner = unique(source, new RegExp(`function (${ID})\\((${ID})\\)\\{.{0,300}?\\{platform:(${ID})\\}=(${CALLEE})\\(\\),(${ID})=(${CALLEE})\\((${MEMBER})\\.macMenuBarEnabled\\);if\\("macOS"!==\\3\\)return null;`, "g"));
  if (!owner || !";{}".includes(source[owner.index - 1])) return null;
  const factory = webpackFactory(source, owner.index);
  const requireName = factory?.params[2];
  if (!requireName) return null;
  const factoryText = source.slice(factory.open, factory.end + 1);
  const end = findMatchingBrace(source, source.indexOf("{", owner.index));
  if (end < 0 || end > factory.end) return null;
  const body = source.slice(owner.index, end + 1);
  const row = unique(body, new RegExp(`\\(0,(${ID})\\.jsx\\)\\((${MEMBER}),\\{label:${ID},description:${ID},control:${ID}\\}`, "g"));
  const toggle = unique(body, new RegExp(`\\(0,${ID}\\.jsx\\)\\((${MEMBER}),\\{checked:${ID},onChange:${ID},ariaLabel:${ID}\\}`, "g"));
  const intlUse = unique(body, new RegExp(`(${ID})\\.formatMessage\\(\\{id:"settings\\.general\\.macMenuBar\\.ariaLabel"`, "g"));
  const intl = intlUse && unique(body, new RegExp(`(?<![\\w$.])${escapeRegExp(intlUse[1])}=(${CALLEE})\\(\\)`, "g"));
  if (!row || !toggle || !intl || !factoryImport(factoryText, requireName, row[1])) return null;
  const reactModules = new Map();
  for (const [, alias] of factoryText.matchAll(new RegExp(`\\(0,(${ID})\\.useState\\)\\(`, "g"))) {
    const id = factoryImport(factoryText, requireName, alias);
    if (id != null) reactModules.set(id, alias);
  }
  if (reactModules.size !== 1) return null;
  const renders = [...factoryText.matchAll(new RegExp(`\\(0,${escapeRegExp(row[1])}\\.jsx\\)\\(${escapeRegExp(owner[1])},\\{appName:(?:${MEMBER}|"[^"\\\\]*")\\}\\)`, "g"))]
    .map((match) => factory.open + match.index);
  if (renders.length === 0) return null;
  return {
    row: row[2], toggle: toggle[1], react: [...reactModules.values()][0], platformHook: owner[4], jsx: row[1],
    intlHook: intl[1], ownerEnd: end + 1, renders,
  };
}

function settingComponent({ row, toggle, react, platformHook, jsx, intlHook }) {
  const key = JSON.stringify(STORAGE_KEY);
  const message = (index) => `intl.formatMessage({id:${JSON.stringify(MESSAGE_IDS[index])},defaultMessage:${JSON.stringify(translations.en[index])}})`;
  return `function ${UI}(){let React=${react},{platform}=${platformHook}(),[enabled,setEnabled]=React.useState(()=>{try{return localStorage.getItem(${key})==="1"}catch{return!1}}),[error,setError]=React.useState(null),intl=${intlHook}(),label=${message(0)},description=${message(1)};React.useEffect(()=>{let update=e=>{if(e.key===${key}||e.key===null){try{setEnabled(localStorage.getItem(${key})==="1")}catch{}}};window.addEventListener("storage",update);return()=>window.removeEventListener("storage",update)},[]);if(platform!=="linux")return null;let change=value=>{try{localStorage.setItem(${key},value===!0?"1":"0");setEnabled(value===!0);setError(null)}catch{setError(${message(2)})}};return(0,${jsx}.jsx)(${row},{label,description:error??description,control:(0,${jsx}.jsx)(${toggle},{checked:enabled,onChange:change,ariaLabel:label})})}`;
}

// Locale catalogs are lazily loaded JSON modules. The loader map names each
// locale with its chunk id and module key:
// `"../locales/pl-PL.json":function(){return r.e(507233).then(r.t.bind(r,"AbCd",19))}`.
function localeCatalogs(loaderSource) {
  const entries = [...loaderSource.matchAll(new RegExp(`"\\.\\./locales/([\\w-]+)\\.json":function\\(\\)\\{return (${ID})\\.e\\((\\d+)\\)\\.then\\(\\2\\.t\\.bind\\(\\2,"([^"]+)",\\d+\\)\\)\\}`, "g"))];
  return entries.map(([, locale, , chunkId, moduleKey]) => ({ locale, chunkId, moduleKey }));
}

const jsSingleQuoted = (text) => text.replace(/\\/g, "\\\\").replace(/'/g, "\\'");

function singleQuotedEnd(source, open) {
  for (let index = open + 1; index < source.length; index += 1) {
    if (source[index] === "\\") index += 1;
    else if (source[index] === "'") return index;
    else if (source[index] === "\n") return -1;
  }
  return -1;
}

function catalogPatches(assetsDir, assetNames, loaderSource) {
  const patches = [];
  const catalogs = localeCatalogs(loaderSource);
  if (catalogs.length === 0) throw Error("reasoning-visibility: no supported translation catalogs found");
  for (const { locale, chunkId, moduleKey } of catalogs) {
    const messages = translations[locale];
    if (locale === "en" || !Array.isArray(messages) || messages.length !== MESSAGE_IDS.length ||
        messages.some((text) => typeof text !== "string" || !text.trim())) {
      throw Error(`reasoning-visibility: missing translations for ${locale}`);
    }
    const names = assetNames.filter((name) => path.basename(name).startsWith(`${chunkId}.`));
    const source = names.length === 1 ? fs.readFileSync(path.join(assetsDir, names[0]), "utf8") : "";
    const module = unique(source, new RegExp(`[{,]${escapeRegExp(moduleKey)}\\((${ID})\\)\\{\\1\\.exports=JSON\\.parse\\('`, "g"));
    const open = module ? module.index + module[0].length - 1 : -1;
    const close = open < 0 ? -1 : singleQuotedEnd(source, open);
    const literal = close < 0 ? "" : source.slice(open + 1, close);
    if (close < 0 || source.slice(close, close + 3) !== "')}" || !literal.startsWith("{") || !literal.endsWith("}") ||
        !literal.includes('"settings.general.macMenuBar.label"')) {
      throw Error(`reasoning-visibility: ${locale} translation catalog missing or ambiguous`);
    }
    const entries = MESSAGE_IDS.map((id, index) => jsSingleQuoted(`${JSON.stringify(id)}:${JSON.stringify(messages[index])}`));
    if (MESSAGE_IDS.some((id) => source.includes(JSON.stringify(id)))) {
      if (entries.some((entry) => !literal.includes(entry)) ||
          MESSAGE_IDS.some((id) => source.split(JSON.stringify(id)).length !== 2)) {
        throw Error(`reasoning-visibility: incomplete or inconsistent ${locale} translations`);
      }
      continue;
    }
    const addition = entries.join(",");
    const decoded = JSON.parse(Function(`return '{${addition}}'`)());
    if (MESSAGE_IDS.some((id, index) => decoded[id] !== messages[index])) {
      throw Error(`reasoning-visibility: ${locale} translations do not round-trip`);
    }
    const separator = literal === "{}" ? "" : ",";
    patches.push({ target: path.join(assetsDir, names[0]), source: source.slice(0, close - 1) + separator + addition + source.slice(close - 1) });
  }
  return patches;
}

// Pure settings-chunk transform: inserts the Linux row before every native
// menu-bar row render and declares its component in the same module factory.
function patchSettingsSource(source) {
  const contract = settingsContract(source);
  if (!contract) throw Error("reasoning-visibility: native General setting contract missing or ambiguous");
  const component = settingComponent(contract);
  const render = `(0,${contract.jsx}.jsx)(${UI},{})`;
  if (source.includes(`function ${UI}(`)) {
    if (source.split(component).length !== 2 || source.split(render).length - 1 !== contract.renders.length ||
        contract.renders.some((index) => source.slice(index - render.length - 1, index) !== `${render},`)) {
      throw Error("reasoning-visibility: incomplete or inconsistent General setting patch");
    }
    return source;
  }
  if (source.includes(UI)) throw Error("reasoning-visibility: partial General setting patch");
  const edits = [{ index: contract.ownerEnd, text: component }, ...contract.renders.map((index) => ({ index, text: `${render},` }))]
    .sort((a, b) => b.index - a.index);
  let patched = source;
  for (const { index, text } of edits) patched = patched.slice(0, index) + text + patched.slice(index);
  if (patchBreaksJavaScriptSyntax(source, patched)) throw Error("reasoning-visibility: General setting patch breaks the settings chunk");
  return patched;
}

function applySettingsPatch(extractedDir) {
  const assetsDir = path.join(extractedDir, "webview/assets");
  const assetNames = listWebviewScriptAssets(extractedDir);
  const settings = [];
  const loaders = [];
  for (const name of assetNames) {
    const source = fs.readFileSync(path.join(assetsDir, name), "utf8");
    if (SETTINGS_NEEDLES.every((needle) => source.includes(needle))) settings.push({ name, source });
    if (LOADER_NEEDLES.every((needle) => source.includes(needle)) && localeCatalogs(source).length > 0) loaders.push(source);
  }
  if (settings.length !== 1) throw Error("reasoning-visibility: General settings asset missing or ambiguous");
  if (loaders.length !== 1) throw Error("reasoning-visibility: locale catalog loader missing or ambiguous");
  const [{ name, source }] = settings;
  const patched = patchSettingsSource(source);
  // Complete preflight before any settings/catalog writes, including locale drift.
  const catalogs = catalogPatches(assetsDir, assetNames, loaders[0]);
  if (patched !== source) fs.writeFileSync(path.join(assetsDir, name), patched);
  for (const catalog of catalogs) fs.writeFileSync(catalog.target, catalog.source);
  return { changed: patched !== source || catalogs.length > 0 };
}

module.exports = {
  MESSAGE_IDS, translations, settingsContract, settingComponent, catalogPatches, patchSettingsSource, applySettingsPatch, webpackFactory,
  settingsDescriptor: {
    id: "general-setting", phase: "extracted-app:post-webview", order: 20_980,
    ciPolicy: "optional", apply: applySettingsPatch,
  },
};
