"use strict";

const identifier = "[A-Za-z_$][\\w$]*";
const dockIconResourceHelper = "codexLinuxDockIconResourcePath";
const dockIconPatchMarker = "codexLinuxDockIcon";

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

// The current official main process is an rspack/SWC build. Dock ownership is
// in the unified window manager; the preview, packaged-resource lookup, macOS
// appearance observer, and tray owner remain in the same main-process chunk.
// Discover each owner semantically and require their minified aliases to agree.
const id = identifier;
const linuxOnly = '"linux"===process\\.platform';
function currentMainPatterns() {
  const packaged =
    `(?<electron>${id})\\.app\\.isPackaged\\?\\(0,(?<path>${id})\\.join\\)\\(process\\.resourcesPath,\\k<arg>\\):null`;
  const appInfoTail =
    `return (?<normalize>${id})\\(null!=\\k<candidate>&&\\(0,(?<exists>${id})\\.existsSync\\)\\(\\k<candidate>\\)\\?\\k<candidate>:` +
    `\\(0,\\k<path>\\.join\\)\\(\\k<electron>\\.app\\.getAppPath\\(\\),"src","icons",\\k<arg>\\)\\)\\}`;
  const appInfoOwner =
    `function (?<owner>${id})\\((?<arg>${id})\\)\\{if\\(null==\\k<arg>\\)return null;let (?<candidate>${id})=${packaged};${appInfoTail}`;

  return {
    preview: new RegExp(
      `dockIconPreviews:(?<include>${id})\\?function\\((?<arg>${id})\\)\\{if\\("darwin"!==process\\.platform\\)return null;let (?<theme>${id})=(?<themeHelper>${id})\\(\\k<arg>\\),` +
        `(?<defaultIcon>${id})=(?<resource>${id})\\(\`\\$\\{(?<iconName>${id})\\(\\k<arg>\\)\\}\\.png\`\\),` +
        `(?<codexDark>${id})=\\k<resource>\\(\\k<theme>\\.dark\\),(?<codexLight>${id})=\\k<resource>\\(\\k<theme>\\.light\\),` +
        `(?<spaceDark>${id})=\\k<resource>\\(\\k<theme>\\.spaceDark\\),(?<spaceLight>${id})=\\k<resource>\\(\\k<theme>\\.spaceLight\\);` +
        "return null==\\k<defaultIcon>\\|\\|null==\\k<codexDark>\\|\\|null==\\k<codexLight>\\|\\|null==\\k<spaceDark>\\|\\|null==\\k<spaceLight>\\?null:" +
        `\\{appDefault:\\k<defaultIcon>,codexDark:\\k<codexDark>,codexLight:\\k<codexLight>,spaceDark:\\k<spaceDark>,spaceLight:\\k<spaceLight>\\}\\}\\((?<preference>${id})\\):null`,
      "g",
    ),
    appInfo: new RegExp(appInfoOwner, "g"),
    tray: new RegExp(
      `(?<tray>${id})=new (?<electron>${id})\\.Tray\\((?<iconInfo>${id})\\.defaultIcon,` +
        `"win32"===process\\.platform&&\\k<electron>\\.app\\.isPackaged\\?`,
      "g",
    ),
    trayState: new RegExp(
      `let (?<controller>${id})=new (?:${id})\\((?<tray>${id})(?:,|\\))[^;]*;return\\((?<trayState>${id})=\\k<controller>,` +
        "await \\k<controller>\\.waitForReady\\(\\)&&\\k<trayState>===\\k<controller>\\)\\?",
      "g",
    ),
  };
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

function currentMainContract(source) {
  const base = currentMainPatterns();
  const contract = {
    preview: oneMatch(source, base.preview),
    appInfo: oneMatch(source, base.appInfo),
    tray: oneMatch(source, base.tray),
    trayState: oneMatch(source, base.trayState),
    owner: oneMatch(source, new RegExp(
      `let (?<update>${id})=(?<isMac>${id})\\?function\\(\\{buildFlavor:(?<build>${id}),repoRoot:(?<repo>${id}),` +
        `isDevMode:(?<dev>${id}),settingsStore:(?<settings>${id}),disposables:(?<disposables>${id}),` +
        `errorReporter:(?<error>${id})\\}\\)\\{`, "g")),
    roots: oneMatch(source, new RegExp(
      `(?<roots>${id})=\\[\\.\\.\\.(?<electron>${id})\\.app\\.isPackaged\\?\\[process\\.resourcesPath\\]:\\[\\],` +
        `\\(0,(?<path>${id})\\.join\\)\\((?<repo>${id}),"electron","src","icons"\\)\\]`, "g")),
    guard: oneMatch(source, new RegExp(
      `(?<apply>${id})=(?<arg>${id})=>\\{if\\((?<disposed>${id})\\|\\|null==(?<appearance>${id})&&` +
        `"app-default"!==\\k<arg>\\)return;`, "g")),
    defaultGate: oneMatch(source, new RegExp(
      `if\\("app-default"===(?<arg>${id})&&(?<build>${id})!==${id}\\.${id}\\.Dev&&!(?<devIcons>${id})\\)\\{`, "g")),
    applyTail: oneMatch(source, new RegExp(
      `if\\(!(?<image>${id})\\.isEmpty\\(\\)\\)\\{if\\("app-default"!==(?<arg>${id})\\)\\{` +
        `let\\{width:(?<width>${id}),height:(?<height>${id})\\}=\\k<image>\\.getSize\\(\\),` +
        `(?<inset>${id})=Math\\.round\\(\\k<width>/128\\);\\k<image>=\\k<image>\\.crop\\(` +
        `\\{x:\\k<inset>,y:\\k<inset>,width:\\k<width>-2\\*\\k<inset>,height:\\k<height>-2\\*\\k<inset>\\}\\)\\}` +
        `(?<electron>${id})\\.app\\.dock\\?\\.setIcon\\(\\k<image>\\)\\}`, "g")),
    observer: oneMatch(source, new RegExp(
      `\\(async function\\((?<callback>${id})\\)\\{if\\(26>Number\\.parseInt\\(process\\.getSystemVersion\\(\\),10\\)\\)` +
        `return (?<fallback>${id})\\(\\k<callback>\\);`, "g")),
  };
  if (Object.values(contract).some((match) => match == null) || source.includes(dockIconPatchMarker)) return null;
  const groups = Object.fromEntries(Object.entries(contract).map(([name, match]) => [name, match.groups]));
  const aliasesAgree =
    groups.preview.resource === groups.appInfo.owner &&
    sameAliases(groups.appInfo.electron, groups.roots.electron, groups.applyTail.electron, groups.tray.electron) &&
    sameAliases(groups.appInfo.path, groups.roots.path) &&
    sameAliases(groups.owner.repo, groups.roots.repo) &&
    sameAliases(groups.guard.arg, groups.defaultGate.arg, groups.applyTail.arg) &&
    contract.observer.index > contract.owner.index && contract.observer.index < contract.owner.index + 10_000;
  return aliasesAgree ? { contract, groups } : null;
}

function patchedMainContract(source) {
  const required = [
    `var ${dockIconPatchMarker}=1`,
    `function ${dockIconResourceHelper}(`,
    '"linux"===process.platform?codexLinuxDockIconResourcePath(',
    '"linux"===process.platform)return',
    "globalThis.codexLinuxDockIconImage=",
    'codexLinuxDockIconResourcePath("sync-desktop-icon.sh")',
    '"linux"===process.platform&&globalThis.codexLinuxDockIconImage',
  ];
  return required.every((needle) => source.split(needle).length === 2) &&
    source.split('if("darwin"!==process.platform&&"linux"!==process.platform)return null').length === 2;
}

function applyCurrentDockIconMainPatch(source, current) {
  const { contract, groups } = current;
  const preview = groups.preview;
  const info = groups.appInfo;
  const roots = groups.roots;
  const guard = groups.guard;
  const tail = groups.applyTail;
  const trayState = groups.trayState.trayState;
  const linux = '"linux"===process.platform';
  const replacements = [
    [contract.preview, `dockIconPreviews:${preview.include}?function(${preview.arg}){if("darwin"!==process.platform&&"linux"!==process.platform)return null;let ${preview.theme}=${preview.themeHelper}(${preview.arg}),${preview.defaultIcon}=${preview.resource}(\`\${${preview.iconName}(${preview.arg})}.png\`),${preview.codexDark}=${preview.resource}(${preview.theme}.dark),${preview.codexLight}=${preview.resource}(${preview.theme}.light),${preview.spaceDark}=${linux}?${preview.codexDark}:${preview.resource}(${preview.theme}.spaceDark),${preview.spaceLight}=${linux}?${preview.codexLight}:${preview.resource}(${preview.theme}.spaceLight);return null==${preview.defaultIcon}||null==${preview.codexDark}||null==${preview.codexLight}||null==${preview.spaceDark}||null==${preview.spaceLight}?null:{appDefault:${preview.defaultIcon},codexDark:${preview.codexDark},codexLight:${preview.codexLight},spaceDark:${preview.spaceDark},spaceLight:${preview.spaceLight}}}(${preview.preference}):null`],
    [contract.appInfo, `var ${dockIconPatchMarker}=1;function ${dockIconResourceHelper}(${info.arg}){return ${linux}?(0,${info.path}.join)(process.resourcesPath,"dock-icon",${info.arg}):(0,${info.path}.join)(process.resourcesPath,${info.arg})}function ${info.owner}(${info.arg}){if(null==${info.arg})return null;let ${info.candidate}=${info.electron}.app.isPackaged||${linux}?${dockIconResourceHelper}(${info.arg}):null;return ${info.normalize}(null!=${info.candidate}&&(0,${info.exists}.existsSync)(${info.candidate})?${info.candidate}:(0,${info.path}.join)(${info.electron}.app.getAppPath(),"src","icons",${info.arg}))}`],
    [contract.owner, contract.owner[0].replace(`${groups.owner.isMac}?function`, `${groups.owner.isMac}||${linux}?function`)],
    [contract.roots, `${roots.roots}=[...${roots.electron}.app.isPackaged?[${linux}?(0,${roots.path}.join)(process.resourcesPath,"dock-icon"):process.resourcesPath]:[],(0,${roots.path}.join)(${roots.repo},"electron","src","icons")]`],
    [contract.guard, `${guard.apply}=${guard.arg}=>{if(${guard.disposed}||null==${guard.appearance}&&"app-default"!==${guard.arg}&&"linux"!==process.platform)return;`],
    [contract.defaultGate, contract.defaultGate[0].replace("&&", '&&"linux"!==process.platform&&')],
    [contract.applyTail, `if(${tail.image}.isEmpty())return;if("linux"!==process.platform&&"app-default"!==${tail.arg}){let{width:${tail.width},height:${tail.height}}=${tail.image}.getSize(),${tail.inset}=Math.round(${tail.width}/128);${tail.image}=${tail.image}.crop({x:${tail.inset},y:${tail.inset},width:${tail.width}-2*${tail.inset},height:${tail.height}-2*${tail.inset}})}if(${linux}){let codexLinuxIconSelection="app-default"===${tail.arg}?"chatgpt":${tail.electron}.nativeTheme.shouldUseDarkColorsForSystemIntegratedUI?"codex-dark":"codex-light";globalThis.codexLinuxDockIconImage=${tail.image};for(let codexLinuxWindow of ${tail.electron}.BrowserWindow.getAllWindows())codexLinuxWindow.isDestroyed()||codexLinuxWindow.setIcon(${tail.image});null!=${trayState}?.tray&&!${trayState}.tray.isDestroyed()&&${trayState}.tray.setImage(${tail.image});let codexLinuxSyncScript=${dockIconResourceHelper}("sync-desktop-icon.sh");if(require("node:fs").existsSync(codexLinuxSyncScript))try{let codexLinuxChild=require("node:child_process").spawn(codexLinuxSyncScript,[codexLinuxIconSelection],{detached:!0,stdio:["pipe","ignore","ignore"]});codexLinuxChild.on("error",()=>{}),codexLinuxChild.stdin.on("error",()=>{}),codexLinuxChild.stdin.end(${tail.image}.toPNG()),codexLinuxChild.unref()}catch{}return}${tail.electron}.app.dock?.setIcon(${tail.image})`],
    [contract.observer, contract.observer[0].replace("{if(", `{if(${linux})return ${groups.observer.fallback}(${groups.observer.callback});if(`)],
    [contract.tray, contract.tray[0].replace(
      `${groups.tray.iconInfo}.defaultIcon`,
      `${linux}&&globalThis.codexLinuxDockIconImage&&!globalThis.codexLinuxDockIconImage.isEmpty()?globalThis.codexLinuxDockIconImage:${groups.tray.iconInfo}.defaultIcon`,
    )],
  ];
  let patched = source;
  for (const [match, replacement] of replacements.sort(([left], [right]) => right.index - left.index)) {
    patched = replaceMatch(patched, match, replacement);
  }
  return patchedMainContract(patched) ? patched : source;
}

function applyDockIconMainPatch(source) {
  if (patchedMainContract(source)) return source;
  const current = currentMainContract(source);
  if (current != null) return applyCurrentDockIconMainPatch(source, current);
  console.warn(
    "WARN: Could not find the complete current Dock icon main-process contract - skipping Dock icon main patch",
  );
  return source;
}

// The current official webview is an rspack/SWC build. The Dock icon row
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
  applyDockIconSettingsPatch,
  descriptors,
  dockIconConfig,
  dockIconSettingsContract,
  dockIconEnabled,
};
