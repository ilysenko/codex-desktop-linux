"use strict";

const fs = require("node:fs");
const path = require("node:path");
const { findMatchingBrace, escapeRegExp } = require("../../scripts/patches/lib/minified-js.js");
const { buildFeatureTree, renderCommunityFeaturesInGuiSettings } = require("./runtime.js");
const { buildCatalog, CATALOG_ASSET } = require("./catalog.js");
const { loadLocaleResources, createTranslator } = require("./i18n.js");
const { patchStatusFromChange } = require("../../scripts/lib/patch-report.js");
const { findWebviewAssetsContaining } = require("../../scripts/patches/lib/assets.js");

const UI = "codexLinuxCommunityFeaturesInGuiSettings";
const ID = "[A-Za-z_$][\\w$]*";
// An upstream binding or member expression, such as `P.ic` or `D.X`.
const REF = `${ID}(?:\\.${ID})*`;
// A hook reference, either an imported call `(0,b.A)` or a plain binding.
const HOOK = `(?:\\(0,${ID}\\.${ID}\\)|${ID})`;
const GENERAL_SETTINGS_NEEDLES = ["settings.general.macMenuBar.description", ".macMenuBarEnabled"];
const unique = (source, pattern) => {
  const matches = [...source.matchAll(pattern)];
  return matches.length === 1 ? matches[0] : null;
};
const rootOf = (reference) => reference.match(/^\(0,([A-Za-z_$][\w$]*)\./)?.[1] ?? reference.split(".")[0];

// The official webview is an rspack build: every module is a factory inside
// `__webpack_modules__={id(module,exports,require){...},...}` and minified names
// are only unique inside one factory.
function rspackModules(source) {
  const start = source.indexOf("__webpack_modules__={");
  if (start < 0) return [];
  const header = new RegExp(`^,?("[^"]+"|${ID}|\\d+)\\(((?:${ID}(?:,${ID}){0,2})?)\\)\\{`, "u");
  const modules = [];
  let index = start + "__webpack_modules__={".length;
  while (index < source.length) {
    const match = header.exec(source.slice(index, index + 200));
    if (match == null) break;
    const open = index + match[0].length - 1;
    const close = findMatchingBrace(source, open);
    if (close < 0) break;
    modules.push({ id: match[1], params: match[2].split(","), start: open, end: close + 1 });
    index = close + 1;
  }
  return modules;
}

// Module-level imports such as `var n=a("ABep"),r=a("QosV"),p=a.n(h)`.
function moduleRequireBindings(body, requireParam) {
  const bindings = new Set();
  const require = escapeRegExp(requireParam);
  for (const match of body.matchAll(new RegExp(`[{};,]\\s*(?:var |let |const )?(${ID})=${require}(?:\\("[^"]+"\\)|\\.n\\(${ID}\\))(?=[,;])`, "gu"))) {
    bindings.add(match[1]);
  }
  return bindings;
}

function functionAt(source, start) {
  const open = source.indexOf("{", start);
  const end = open < 0 ? -1 : findMatchingBrace(source, open);
  return end < 0 ? null : { start, end: end + 1, text: source.slice(start, end + 1) };
}

// The innermost function enclosing `index`. Functions that end before
// `index` are skipped, so helpers other Linux features inline into the same
// native component (for example ui-tweaks' marked IIFEs) do not hide it.
function containingFunction(source, index) {
  for (let start = source.lastIndexOf("function ", index); start >= 0; start = start === 0 ? -1 : source.lastIndexOf("function ", start - 1)) {
    const owner = functionAt(source, start);
    if (owner != null && owner.end > index) return owner;
  }
  return null;
}

function settingsContract(source) {
  const anchor = unique(source, /\.macMenuBarEnabled\);if\("macOS"!==/g);
  const module = anchor && rspackModules(source).find(({ start, end }) => start < anchor.index && anchor.index < end);
  if (!module || module.params.length !== 3) return null;
  const body = source.slice(module.start, module.end);
  const bindings = moduleRequireBindings(body, module.params[2]);
  const owner = unique(body, new RegExp(`function (${ID})\\((${ID})\\)\\{.{0,400}?\\{platform:(${ID})\\}=(${HOOK})\\(\\),(${ID})=(${HOOK})\\((${REF})\\.macMenuBarEnabled\\);if\\("macOS"!==\\3\\)return null;`, "g"));
  if (!owner) return null;
  const ownerFunction = functionAt(body, owner.index);
  if (!ownerFunction) return null;
  const ownerBody = ownerFunction.text;
  const row = unique(ownerBody, new RegExp(`\\(0,(${ID})\\.jsx\\)\\((${REF}),\\{label:${ID},description:${ID},control:${ID}\\}\\)`, "g"));
  const reactNames = new Set([...body.matchAll(new RegExp(`\\(0,(${ID})\\.useState\\)\\(`, "g"))].map((match) => match[1]));
  const react = reactNames.size === 1 ? [...reactNames][0] : null;
  const intlUse = unique(ownerBody, new RegExp(`(${ID})\\.formatMessage\\(\\{id:"settings\\.general\\.macMenuBar\\.ariaLabel"`, "g"));
  const intl = intlUse && unique(ownerBody, new RegExp(`(?<![\\w$.])${escapeRegExp(intlUse[1])}=(${HOOK})\\(\\)`, "g"));
  if (!row || !react || !intl) return null;
  const jsx = escapeRegExp(row[1]);
  // The existing licenses action provides the native secondary toolbar button.
  const licenses = unique(body, /"settings\.openSourceLicenses\.view"/g);
  const licensesOwner = licenses && containingFunction(body, licenses.index);
  const button = licensesOwner && unique(licensesOwner.text, new RegExp(
    `\\(0,${jsx}\\.jsx\\)\\((${REF}),\\{color:"secondary",size:"toolbar",onClick:${ID},children:${ID}\\}\\)`,
    "g",
  ));
  if (!button) return null;
  // Bind the native section primitives to the General groups containing the
  // menu preference, but insert at the page level, above all existing groups.
  const menuRenders = [...body.matchAll(new RegExp(`\\(0,${jsx}\\.jsx\\)\\(${escapeRegExp(owner[1])},\\{appName:[^{}()]+\\}\\)`, "g"))];
  const generals = [];
  for (const render of menuRenders) {
    const general = containingFunction(body, render.index);
    const name = general?.text.match(new RegExp(`^function (${ID})\\(\\)\\{`))?.[1];
    if (!name || generals.some((entry) => entry.name === name)) return null;
    generals.push({ ...general, name });
  }
  if (generals.length === 0) return null;
  const sections = new Set(), stacks = new Set();
  for (const general of generals) {
    for (const match of general.text.matchAll(new RegExp(`\\(0,${jsx}\\.jsx\\)\\((${REF})\\.Header,\\{title:\\(0,${jsx}\\.jsx\\)\\(${REF},\\{id:"settings\\.general\\.groupTitle"`, "g"))) sections.add(match[1]);
  }
  if (sections.size !== 1) return null;
  const [section] = sections;
  for (const general of generals) {
    for (const match of general.text.matchAll(new RegExp(`\\(0,${jsx}\\.jsx\\)\\(${escapeRegExp(section)}\\.Content,\\{children:\\(0,${jsx}\\.jsxs?\\)\\((${REF}),\\{children:`, "g"))) stacks.add(match[1]);
  }
  if (stacks.size !== 1) return null;
  const [stack] = stacks;
  const pageMarker = unique(body, /slug:"general-settings"/g);
  const page = pageMarker && containingFunction(body, pageMarker.index);
  if (!page || generals.some(({ name }) => !page.text.includes(`(0,${row[1]}.jsx)(${name},{})`))) return null;
  const render = unique(page.text, new RegExp(`\\(0,${jsx}\\.jsxs\\)\\(${REF},\\{title:${ID},children:\\[`, "g"));
  if (!render) return null;
  const references = { row: row[2], button: button[1], section, stack, react, platformHook: owner[4], intlHook: intl[1], jsx: row[1] };
  if (Object.values(references).some((reference) => !bindings.has(rootOf(reference)))) return null;
  return {
    ...references,
    renderInsertAt: module.start + page.start + render.index + render[0].length,
    componentInsertAt: module.end - 1,
  };
}

function settingComponent(contract, catalog) {
  const { row, button, section, stack, react, platformHook, intlHook } = contract;
  const resources = loadLocaleResources();
  return `function ${UI}(){return(${renderCommunityFeaturesInGuiSettings.toString()})({React:${react},Row:${row},Button:${button},Section:${section},Stack:${stack},locale:${intlHook}().locale,platform:${platformHook}().platform,catalog:${JSON.stringify(catalog)},buildTree:(${buildFeatureTree.toString()}),resources:${JSON.stringify(resources)},translate:(${createTranslator.toString()})})}`;
}

function applySettingsPatch(extractedDir, context = {}) {
  const assetsDir = path.join(extractedDir, "webview/assets");
  const candidates = findWebviewAssetsContaining(extractedDir, GENERAL_SETTINGS_NEEDLES);
  if (candidates.length !== 1) throw Error("community-features-in-gui-settings: General settings asset missing or ambiguous");
  const [name] = candidates;
  const source = fs.readFileSync(path.join(assetsDir, name), "utf8");
  const contract = settingsContract(source);
  if (!contract) throw Error("community-features-in-gui-settings: native General settings contract missing or ambiguous");
  const catalogWarnings = [];
  const catalog = buildCatalog(context, (warning) => {
    catalogWarnings.push(warning);
    console.warn(warning);
  });
  const snapshot = `${JSON.stringify(catalog, null, 2)}\n`;
  const snapshotPath = path.join(extractedDir, CATALOG_ASSET);
  const component = `;${settingComponent(contract, catalog)}`;
  const render = `(0,${contract.jsx}.jsx)(${UI},{})`;
  if (source.includes(UI)) {
    if (source.split(component).length !== 2 || source.split(render).length !== 2 ||
        !source.startsWith(`${render},`, contract.renderInsertAt) ||
        !source.startsWith(component, contract.componentInsertAt - component.length) ||
        !fs.existsSync(snapshotPath) || fs.readFileSync(snapshotPath, "utf8") !== snapshot) {
      throw Error("community-features-in-gui-settings: incomplete or inconsistent settings patch");
    }
    return { changed: false, catalogWarnings };
  }
  if (fs.existsSync(snapshotPath)) throw Error("community-features-in-gui-settings: unexpected catalog asset");
  // The component is declared inside the settings module factory, after all
  // existing code, so it resolves the same module-level imports it captured.
  const patched = source.slice(0, contract.renderInsertAt) + `${render},` +
    source.slice(contract.renderInsertAt, contract.componentInsertAt) + component +
    source.slice(contract.componentInsertAt);
  // Resolve and validate every contract before writing either generated asset.
  fs.writeFileSync(snapshotPath, snapshot);
  fs.writeFileSync(path.join(assetsDir, name), patched);
  return { changed: true, catalogWarnings };
}

function settingsPatchStatus(result, warnings) {
  const catalogWarnings = new Set(result.catalogWarnings);
  return patchStatusFromChange(Boolean(result.changed), warnings.filter((warning) => !catalogWarnings.has(warning)));
}

module.exports = {
  UI, GENERAL_SETTINGS_NEEDLES, settingsContract, settingComponent, applySettingsPatch,
  descriptors: [{
    id: "general-list", phase: "extracted-app:post-webview", order: 20_990,
    ciPolicy: "optional", apply: applySettingsPatch, status: settingsPatchStatus,
  }],
};
