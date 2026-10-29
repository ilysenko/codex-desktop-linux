"use strict";

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

// The official 26.1027.30824 main process is an rspack/SWC build: the whole
// Dock icon contract lives in one main-app module of an `early-bootstrap-*`
// chunk, strings are double-quoted, comparisons are written literal-first
// (`"darwin"!==process.platform`, `null==x`), and one-shot helpers (Dock
// previews, packaged resource lookup, macOS icon refresh, Windows tray GUID)
// are inlined as function expressions. Injected code uses only names that are
// declared in that module or created by this patch.
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
  // The apply callback is the one whose dev-icon branch sets the Dock icon and
  // is followed by the app-default reset of the same argument.
  const applyBody = '(?=[\\s\\S]{0,1024}\\.app\\.dock)(?=[\\s\\S]{0,1024}if\\("app-default"===\\k<arg>&&)';
  const applyPrefix = patched
    ? `(?<apply>${id})=function ${dockIconApplyHelper}\\((?<arg>${id})\\)\\{if\\((?<devIcons>${id})&&${notLinux}\\)\\{${applyBody}`
    : `(?<apply>${id})=(?<arg>${id})=>\\{if\\((?<devIcons>${id})\\)\\{${applyBody}`;
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
      `dockIconPreviews:function\\((?<arg>${id})\\)\\{if\\(${previewGate}\\)return null;let (?<theme>${id})=(?<themeHelper>${id})\\(\\k<arg>\\),` +
        `(?<defaultIcon>${id})=(?<resource>${id})\\(\`\\$\\{(?<iconName>${id})\\(\\k<arg>\\)\\}\\.png\`\\),` +
        `(?<codexDark>${id})=\\k<resource>\\(\\k<theme>\\.dark\\),(?<codexLight>${id})=\\k<resource>\\(\\k<theme>\\.light\\),` +
        `(?<spaceDark>${id})=${spaceDark},(?<spaceLight>${id})=${spaceLight};` +
        "return null==\\k<defaultIcon>\\|\\|null==\\k<codexDark>\\|\\|null==\\k<codexLight>\\|\\|null==\\k<spaceDark>\\|\\|null==\\k<spaceLight>\\?null:" +
        "\\{appDefault:\\k<defaultIcon>,codexDark:\\k<codexDark>,codexLight:\\k<codexLight>,spaceDark:\\k<spaceDark>,spaceLight:\\k<spaceLight>\\}\\}\\(\\k<arg>\\)",
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
    applyPrefix: new RegExp(applyPrefix, "g"),
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
    theme: new RegExp(
      `if\\((?<isMac>${id})${patched ? `\\|\\|${linuxOnly}` : ""}\\)\\{(?<update>${id})\\(\\);let (?<listener>${id})=\\(\\)=>\\{` +
        `let (?<preference>${id})=(?<read>${id})\\(\\);"app-default"!==\\k<preference>&&(?<apply>${id})\\(\\k<preference>\\)\\};` +
        `(?<electron>${id})\\.nativeTheme\\.on\\("updated",\\k<listener>\\),(?<disposables>${id})\\.add\\(\\(\\)=>\\{\\k<electron>\\.nativeTheme\\.off\\("updated",\\k<listener>\\)\\}\\)\\}`,
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

// The Dock apply callback and macOS refresh closure are each compiled as one
// contiguous expression; keep their parts in order and close together.
function inOrder(...entries) {
  return entries.every(([match, next, maxGap]) => {
    const gap = next.index - (match.index + match[0].length);
    return gap >= 0 && gap <= maxGap;
  });
}

function mainContract(source, state) {
  const patterns = mainPatterns(state);
  const contract = Object.fromEntries(
    Object.entries(patterns).map(([name, pattern]) => [name, oneMatch(source, pattern)]),
  );
  if (Object.values(contract).some((match) => match == null)) return null;
  const groups = Object.fromEntries(
    Object.entries(contract).map(([name, match]) => [name, match.groups]),
  );
  const aliasesAgree =
    groups.preview.resource === groups.appInfo.owner &&
    sameAliases(groups.appInfo.electron, groups.windowResource.electron, groups.applyTail.electron, groups.theme.electron, groups.tray.electron) &&
    sameAliases(groups.appInfo.path, groups.windowResource.path ?? groups.appInfo.path) &&
    sameAliases(groups.appInfo.exists, groups.windowResource.exists) &&
    sameAliases(groups.applyPrefix.apply, groups.updateHead.apply, groups.updateTail.apply, groups.theme.apply) &&
    sameAliases(groups.resourceName.resourceName, groups.updateTail.resourceName) &&
    sameAliases(groups.applyPrefix.arg, groups.applyDefaultGate.arg, groups.applyTail.arg) &&
    sameAliases(groups.updateHead.update, groups.theme.update, groups.windowRegistration.update ?? groups.updateHead.update) &&
    sameAliases(groups.updateHead.isMac, groups.theme.isMac) &&
    sameAliases(groups.updateHead.read, groups.updateTail.read, groups.theme.read) &&
    sameAliases(groups.updateHead.preference, groups.updateTail.preference) &&
    sameAliases(groups.tray.tray, groups.trayState.tray) &&
    sameAliases(groups.applyTail.trayState ?? groups.trayState.trayState, groups.trayState.trayState) &&
    inOrder(
      [contract.resourceName, contract.applyPrefix, 16],
      [contract.applyPrefix, contract.applyDefaultGate, 1024],
      [contract.applyDefaultGate, contract.applyTail, 1200],
      [contract.applyTail, contract.updateHead, 16],
      [contract.updateHead, contract.updateTail, 1200],
      [contract.updateTail, contract.theme, 16],
      [contract.theme, contract.windowRegistration, 4000],
    );
  return aliasesAgree ? { contract, groups } : null;
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

function applyDockIconMainPatch(source) {
  const current = mainContract(source, "current");
  const patched = mainContract(source, "patched");
  if (patched != null && current == null) return source;
  if (current == null || patched != null) {
    console.warn(
      "WARN: Could not find the complete current Dock icon main-process contract - skipping Dock icon main patch",
    );
    return source;
  }

  const { contract, groups } = current;
  const preview = groups.preview;
  const info = groups.appInfo;
  const win = groups.windowResource;
  const names = groups.resourceName;
  const tail = groups.applyTail;
  const trayState = groups.trayState.trayState;
  const linux = '"linux"===process.platform';
  const replacements = [
    [contract.preview, `dockIconPreviews:function(${preview.arg}){if("darwin"!==process.platform&&"linux"!==process.platform)return null;let ${preview.theme}=${preview.themeHelper}(${preview.arg}),${preview.defaultIcon}=${preview.resource}(\`\${${preview.iconName}(${preview.arg})}.png\`),${preview.codexDark}=${preview.resource}(${preview.theme}.dark),${preview.codexLight}=${preview.resource}(${preview.theme}.light),${preview.spaceDark}=${linux}?${preview.codexDark}:${preview.resource}(${preview.theme}.spaceDark),${preview.spaceLight}=${linux}?${preview.codexLight}:${preview.resource}(${preview.theme}.spaceLight);return null==${preview.defaultIcon}||null==${preview.codexDark}||null==${preview.codexLight}||null==${preview.spaceDark}||null==${preview.spaceLight}?null:{appDefault:${preview.defaultIcon},codexDark:${preview.codexDark},codexLight:${preview.codexLight},spaceDark:${preview.spaceDark},spaceLight:${preview.spaceLight}}}(${preview.arg})`],
    [contract.appInfo, `function ${dockIconResourceHelper}(${info.arg}){return ${linux}?(0,${info.path}.join)(process.resourcesPath,"dock-icon",${info.arg}):(0,${info.path}.join)(process.resourcesPath,${info.arg})}function ${info.owner}(${info.arg}){if(null==${info.arg})return null;let ${info.candidate}=${info.electron}.app.isPackaged||${linux}?${dockIconResourceHelper}(${info.arg}):null;return ${info.normalize}(null!=${info.candidate}&&(0,${info.exists}.existsSync)(${info.candidate})?${info.candidate}:(0,${info.path}.join)(${info.electron}.app.getAppPath(),"src","icons",${info.arg}))}`],
    [contract.windowResource, `(${win.arg}=>{if(!${win.electron}.app.isPackaged&&"linux"!==process.platform)return null;let ${win.candidate}=${dockIconResourceHelper}(${win.arg});return(0,${win.exists}.existsSync)(${win.candidate})?${win.candidate}:null})`],
    [contract.resourceName, `${names.resourceName}=(${names.preference},${names.dark})=>{switch(${names.preference}){case"app-default":return null;case"codex-system":return ${names.dark}?${names.theme}.dark:${names.theme}.light;case"space-system":return ${linux}?${names.dark}?${names.theme}.dark:${names.theme}.light:${names.dark}?${names.theme}.spaceDark:${names.theme}.spaceLight}}`],
    [contract.applyPrefix, `${groups.applyPrefix.apply}=function ${dockIconApplyHelper}(${groups.applyPrefix.arg}){if(${groups.applyPrefix.devIcons}&&"linux"!==process.platform){`],
    [contract.applyDefaultGate, contract.applyDefaultGate[0].replace("&&", '&&"linux"!==process.platform&&')],
    [contract.applyTail, `if(${tail.image}.isEmpty())return;if("linux"!==process.platform&&("codex-system"===${tail.arg}||"space-system"===${tail.arg})){let{width:${tail.width},height:${tail.height}}=${tail.image}.getSize(),${tail.inset}=Math.round(${tail.width}/128);${tail.image}=${tail.image}.crop({x:${tail.inset},y:${tail.inset},width:${tail.width}-2*${tail.inset},height:${tail.height}-2*${tail.inset}})}if(${linux}){let codexLinuxIconSelection="codex-system"===${tail.arg}||"space-system"===${tail.arg}?${tail.electron}.nativeTheme.shouldUseDarkColorsForSystemIntegratedUI?"codex-dark":"codex-light":"chatgpt";globalThis.codexLinuxDockIconImage=${tail.image};for(let codexLinuxWindow of ${tail.electron}.BrowserWindow.getAllWindows())codexLinuxWindow.isDestroyed()||codexLinuxWindow.setIcon(${tail.image});null!=${trayState}?.tray&&!${trayState}.tray.isDestroyed()&&${trayState}.tray.setImage(${tail.image});let codexLinuxSyncScript=${dockIconResourceHelper}("sync-desktop-icon.sh");if(require("node:fs").existsSync(codexLinuxSyncScript))try{let codexLinuxChild=require("node:child_process").spawn(codexLinuxSyncScript,[codexLinuxIconSelection],{detached:!0,stdio:["pipe","ignore","ignore"]});codexLinuxChild.on("error",()=>{}),codexLinuxChild.stdin.on("error",()=>{}),codexLinuxChild.stdin.end(${tail.image}.toPNG()),codexLinuxChild.unref()}catch{}return}${tail.electron}.app.dock?.setIcon(${tail.image})}`],
    [contract.updateHead, contract.updateHead[0].replace(`if(!${groups.updateHead.isMac})`, `if(!${groups.updateHead.isMac}&&"linux"!==process.platform)`)],
    [contract.theme, contract.theme[0].replace(`if(${groups.theme.isMac})`, `if(${groups.theme.isMac}||"linux"===process.platform)`)],
    [contract.windowRegistration, contract.windowRegistration[0].replace(
      `?.(${groups.windowRegistration.window})}`,
      `?.(${groups.windowRegistration.window}),"linux"===process.platform&&setImmediate(${groups.updateHead.update})}`,
    )],
    [contract.tray, contract.tray[0].replace(
      `${groups.tray.iconInfo}.defaultIcon`,
      `"linux"===process.platform&&globalThis.codexLinuxDockIconImage&&!globalThis.codexLinuxDockIconImage.isEmpty()?globalThis.codexLinuxDockIconImage:${groups.tray.iconInfo}.defaultIcon`,
    )],
  ];
  // Apply from the end so earlier match offsets stay valid.
  let patchedSource = source;
  for (const [match, replacement] of replacements.sort(([left], [right]) => right.index - left.index)) {
    patchedSource = replaceMatch(patchedSource, match, replacement);
  }
  return mainContract(patchedSource, "patched") != null ? patchedSource : source;
}

const currentSettingsGatePattern =
  /return ([A-Za-z_$][\w$]*)!==`macOS`\|\|([A-Za-z_$][\w$]*)===([A-Za-z_$][\w$]*)\.Agent\?null:([A-Za-z_$][\w$]*)/g;
const patchedSettingsGatePattern =
  /return ([A-Za-z_$][\w$]*)!==`macOS`&&\1!==`linux`\|\|([A-Za-z_$][\w$]*)===([A-Za-z_$][\w$]*)\.Agent\?null:([A-Za-z_$][\w$]*)/g;
const settingsRowAnchorPattern = /\bdockIconPreviews\b/g;

function dockIconSettingsContract(source) {
  const currentMatches = matches(source, currentSettingsGatePattern);
  const patchedMatches = matches(source, patchedSettingsGatePattern);
  const rowAnchors = matches(source, settingsRowAnchorPattern);
  if (rowAnchors.length === 1 && currentMatches.length === 1 && patchedMatches.length === 0) return "current";
  if (rowAnchors.length === 1 && currentMatches.length === 0 && patchedMatches.length === 1) return "patched";
  return "drifted";
}

function applyDockIconSettingsPatch(source) {
  const contract = dockIconSettingsContract(source);
  if (contract === "patched") return source;
  if (contract !== "current") {
    console.warn("WARN: Could not find the current Dock icon settings contract - skipping Dock icon settings patch");
    return source;
  }
  return source.replace(
    currentSettingsGatePattern,
    (_match, platformAlias, buildFlavorAlias, buildFlavorEnumAlias, previewsAlias) =>
      `return ${platformAlias}!==\`macOS\`&&${platformAlias}!==\`linux\`||${buildFlavorAlias}===${buildFlavorEnumAlias}.Agent?null:${previewsAlias}`,
  );
}

const descriptors = [
  {
    id: "appearance-dock-icon-main-process",
    phase: "main-bundle",
    order: 20_940,
    ciPolicy: "optional",
    enabled: dockIconEnabled,
    apply: applyDockIconMainPatch,
  },
  {
    id: "appearance-dock-icon-settings-row",
    phase: "webview-asset",
    order: 20_950,
    ciPolicy: "optional",
    pattern: /^dock-icon-setting-visibility-[A-Za-z0-9_-]+\.js$/,
    assetMatch: (source) => dockIconSettingsContract(source) !== "drifted",
    missingDescription: "official Linux Dock icon setting visibility bundle",
    skipDescription: "Dock icon settings row patch",
    enabled: dockIconEnabled,
    apply: applyDockIconSettingsPatch,
  },
];

module.exports = {
  applyDockIconMainPatch,
  applyDockIconSettingsPatch,
  descriptors,
  dockIconConfig,
  dockIconEnabled,
};
