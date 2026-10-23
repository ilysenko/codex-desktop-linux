"use strict";

const fs = require("node:fs");
const path = require("node:path");
const { findMatchingBrace, escapeRegExp } = require("../../scripts/patches/lib/minified-js.js");
const { buildFeatureTree, renderCommunityFeaturesInGuiSettings } = require("./runtime.js");
const { buildCatalog, CATALOG_ASSET } = require("./catalog.js");
const { loadLocaleResources, createTranslator } = require("./i18n.js");

const UI = "codexLinuxCommunityFeaturesInGuiSettings";
const ID = "[A-Za-z_$][\\w$]*";
const unique = (source, pattern) => {
  const matches = [...source.matchAll(pattern)];
  return matches.length === 1 ? matches[0] : null;
};

function settingsContract(source) {
  const owner = unique(source, new RegExp(`function (${ID})\\((${ID})\\)\\{.{0,300}?\\{platform:(${ID})\\}=(${ID})\\(\\),(${ID})=(${ID})\\((${ID})\\.macMenuBarEnabled\\);if\\(\\3!==\`macOS\`\\)return null;`, "g"));
  if (!owner) return null;
  const end = findMatchingBrace(source, source.indexOf("{", owner.index));
  if (end < 0) return null;
  const body = source.slice(owner.index, end + 1);
  const row = unique(body, new RegExp(`\\(0,(${ID})\\.jsx\\)\\((${ID}),\\{label:${ID},description:${ID},control:${ID}\\}`, "g"));
  const reactUse = source.match(new RegExp(`\\(0,(${ID})\\.useState\\)\\(`));
  const react = reactUse && unique(source, new RegExp(`\\b${escapeRegExp(reactUse[1])}=(${ID})\\(\\)`, "g"));
  const render = unique(source, new RegExp(`\\(0,(${ID})\\.jsx\\)\\(${escapeRegExp(owner[1])},\\{appName:${ID}\\}\\)`, "g"));
  // Insert a sibling in the existing children array. A refactor to a cached
  // scalar expression must fail closed instead of discarding the new element.
  const arrayStart = render == null ? -1 : source.lastIndexOf("children:[", render.index);
  const siblings = arrayStart < 0 ? null : source.slice(arrayStart + "children:[".length, render.index);
  const arrayContract = siblings != null && new RegExp(`^(?:\\(0,${ID}\\.jsx\\)\\(${ID},\\{\\}\\),)*$`).test(siblings);
  const intlUse = unique(body, new RegExp(`(${ID})\\.formatMessage\\(\\{id:\`settings\\.general\\.macMenuBar\\.ariaLabel\``, "g"));
  const intl = intlUse && unique(body, new RegExp(`\\b${escapeRegExp(intlUse[1])}=(${ID})\\(\\)`, "g"));
  // The existing licenses action provides the native secondary toolbar button.
  const licenses = source.indexOf("settings.openSourceLicenses.view");
  const licensesOwner = licenses < 0 ? -1 : source.lastIndexOf("function ", licenses);
  const licensesEnd = licensesOwner < 0 ? -1 : findMatchingBrace(source, source.indexOf("{", licensesOwner));
  const button = licensesEnd < licenses ? null : unique(source.slice(licenses, licensesEnd), new RegExp(
    `\\(0,(${ID})\\.jsx\\)\\((${ID}),\\{color:\`secondary\`,size:\`toolbar\`,onClick:${ID},children:${ID}\\}`,
    "g",
  ));
  if (!row || !react || !render || !arrayContract || !intl || !button || row[1] !== render[1] || button[1] !== row[1]) return null;
  if (source.split("settings.openSourceLicenses.view").length !== 2) return null;
  return { row: row[2], button: button[2], reactFactory: react[1], platformHook: owner[4], intlHook: intl[1], jsx: row[1], render };
}

function settingComponent(contract, catalog) {
  const { row, button, reactFactory, platformHook, intlHook } = contract;
  const resources = loadLocaleResources();
  return `function ${UI}(){return(${renderCommunityFeaturesInGuiSettings.toString()})({React:${reactFactory}(),Row:${row},Button:${button},locale:${intlHook}().locale,platform:${platformHook}().platform,catalog:${JSON.stringify(catalog)},buildTree:(${buildFeatureTree.toString()}),resources:${JSON.stringify(resources)},translate:(${createTranslator.toString()})})}`;
}

function applySettingsPatch(extractedDir, context = {}) {
  const assetsDir = path.join(extractedDir, "webview/assets");
  const candidates = fs.readdirSync(assetsDir).filter((name) => name.endsWith(".js"))
    .map((name) => ({ name, source: fs.readFileSync(path.join(assetsDir, name), "utf8") }))
    .filter(({ source }) => source.includes("settings.general.macMenuBar.description") && source.includes(".macMenuBarEnabled"));
  if (candidates.length !== 1) throw Error("community-features-in-gui-settings: General settings asset missing or ambiguous");
  const [{ name, source }] = candidates;
  const contract = settingsContract(source);
  if (!contract) throw Error("community-features-in-gui-settings: native General settings contract missing or ambiguous");
  const catalog = buildCatalog(context);
  const snapshot = `${JSON.stringify(catalog, null, 2)}\n`;
  const snapshotPath = path.join(extractedDir, CATALOG_ASSET);
  const component = settingComponent(contract, catalog);
  const render = `(0,${contract.jsx}.jsx)(${UI},{})`;
  if (source.includes(UI)) {
    if (source.split(component).length !== 2 || source.split(render).length !== 2 ||
        !fs.existsSync(snapshotPath) || fs.readFileSync(snapshotPath, "utf8") !== snapshot) {
      throw Error("community-features-in-gui-settings: incomplete or inconsistent settings patch");
    }
    return { changed: false };
  }
  if (fs.existsSync(snapshotPath)) throw Error("community-features-in-gui-settings: unexpected catalog asset");
  const patched = source.replace(contract.render[0], `${render},${contract.render[0]}`) + `\n${component}\n`;
  // Resolve and validate every contract before writing either generated asset.
  fs.writeFileSync(snapshotPath, snapshot);
  fs.writeFileSync(path.join(assetsDir, name), patched);
  return { changed: true };
}

module.exports = {
  UI, settingsContract, settingComponent, applySettingsPatch,
  descriptors: [{
    id: "general-list", phase: "extracted-app:post-webview", order: 20_990,
    ciPolicy: "optional", apply: applySettingsPatch,
  }],
};
