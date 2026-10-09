"use strict";

const fs = require("node:fs");
const path = require("node:path");
const { findCodexRequestWebviewAsset } = require("../../scripts/patches/lib/assets.js");
const { escapeRegExp, findMatchingBrace } = require("../../scripts/patches/lib/minified-js.js");

const SETTINGS_KEY = "codex-linux-start-minimized-to-tray";
const BOOT_ONLY_SETTINGS_KEY = "codex-linux-start-minimized-to-tray-only-on-boot";
const MAIN_MARKER = "codexLinuxStartMinimizedTrayReady";
const UI_MARKER = "codexLinuxStartMinimizedSetting";
const BOOT_ONLY_UI_MARKER = "codexLinuxStartMinimizedBootOnlySetting";
const LABEL_IDS = ["settings.general.startMinimizedToTray.label", "settings.general.startMinimizedToTrayOnlyOnBoot.label"];
const LABEL_TRANSLATIONS = require("./labels.json");
const DESCRIPTION_IDS = ["settings.general.startMinimizedToTray.description", "settings.general.startMinimizedToTrayOnlyOnBoot.description"];
const DESCRIPTION_TRANSLATIONS = require("./descriptions.json");
const ID = "[A-Za-z_$][\\w$]*";

// systemd's XDG generator uses app-<escaped desktop ID>@autostart.service.
// GNOME session launches expose DESKTOP_AUTOSTART_ID. Other launchers can
// explicitly mark only their login command with --codex-autostart.
function codexLinuxStartMinimizedAutostart(runtime = process, readCgroup = () => require("node:fs").readFileSync("/proc/self/cgroup", "utf8")) {
  if (runtime.platform !== "linux") return false;
  if (runtime.argv.slice(1).includes("--codex-autostart") || runtime.env.DESKTOP_AUTOSTART_ID?.trim()) return true;
  try {
    return readCgroup().split("\n").some(line => /^\d+:[^:]*:.*\/app-[^/]+@autostart\.service(?:\/|$)/.test(line));
  } catch {
    return false;
  }
}

function codexLinuxStartMinimizedPreference(globalState, runtime = process, readCgroup) {
  const enabled = globalState.getStored("codex-linux-start-minimized-to-tray") === true;
  const onlyOnBoot = globalState.getStored("codex-linux-start-minimized-to-tray-only-on-boot") === true;
  const autostart = onlyOnBoot && codexLinuxStartMinimizedAutostart(runtime, readCgroup);
  return {
    enabled, onlyOnBoot, autostart,
    requested: runtime.platform === "linux" && (onlyOnBoot ? autostart : enabled) &&
      runtime.argv.slice(1).every(arg => arg.startsWith("-")),
  };
}

// Use upstream's ready tray, with a bounded fallback to a visible window.
async function codexLinuxStartMinimizedTrayReady(setup, isReady, timeoutMs = 3000) {
  let timer;
  try {
    await Promise.race([
      setup,
      new Promise((resolve) => { timer = setTimeout(resolve, timeoutMs); }),
    ]);
    return isReady() === true;
  } catch {
    return false;
  } finally {
    clearTimeout(timer);
  }
}

function unique(source, pattern) {
  const matches = [...source.matchAll(pattern)];
  return matches.length === 1 ? matches[0] : null;
}

function hasExactlyOne(source, value) {
  return source.split(value).length === 2;
}

function hasCompleteMainPatch(source, state) {
  if (!state) return false;
  const afterState = source.slice(state.index);
  const background = unique(afterState, new RegExp(
    `let (${ID})=process\\.env\\.CODEX_ELECTRON_START_IN_BACKGROUND===\`1\`,(${ID})=`,
    "g",
  ));
  const trayReady = unique(afterState, new RegExp(`canHideLastWindowToTray:(${ID}),isRemoteHostedPIPEnabled:`, "g"));
  const traySetup = unique(source, new RegExp(
    `let codexLinuxStartMinimizedTraySetup=\\((${ID})\\|\\|process\\.platform===\`linux\`\\)\\?(${ID})\\(\\):null;`,
    "g",
  ));
  const startup = unique(source, new RegExp(
    `if\\(codexLinuxStartMinimized\\)\\{let ready=await ${MAIN_MARKER}\\(codexLinuxStartMinimizedTraySetup,(${ID})\\);` +
      "console\\.info\\(\\`\\[start-minimized-to-tray\\] tray readiness\\`,\\{ready\\}\\);" +
      `codexLinuxStartMinimized=codexLinuxStartMinimized&&ready;(${ID})\\.isBackgroundLaunch=` +
      "\\2\\.isBackgroundLaunch\\|\\|codexLinuxStartMinimized/\\*codexLinuxStartMinimizedNativeBackground\\*/\\}" +
      `let (${ID})=await (${ID})\\.ensureWindow\\(\\{background:\\2\\.isBackgroundLaunch\\}\\);` +
      "\\3\\?\\.once\\(\\`show\\`,\\(\\)=>\\{(" + ID + ")\\.handleInitialWindowVisible\\(\\)\\}\\)," +
      "\\3!=null&&!\\2\\.isBackgroundLaunch&&\\((" + ID + ")\\(\\3,!(" + ID + ")\\),\\5\\.handleInitialWindowVisible\\(\\)\\)",
    "g",
  ));
  if (!background || !trayReady || !traySetup || !startup) return false;
  const [, readyVar, startupVar, windowVar, servicesVar, attributionVar, showVar, backgroundVar] = startup;
  if (readyVar !== trayReady[1] || showVar !== background[2] || backgroundVar !== background[1]) return false;

  const relationships = [
    `let codexLinuxStartMinimizedPreferences=codexLinuxStartMinimizedPreference(${state[1]}.globalState);`,
    "let codexLinuxStartMinimized=codexLinuxStartMinimizedPreferences.requested;",
    "console.info(`[start-minimized-to-tray] startup preference`,codexLinuxStartMinimizedPreferences);",
    traySetup[0],
    `if(codexLinuxStartMinimized){let ready=await ${MAIN_MARKER}(codexLinuxStartMinimizedTraySetup,${readyVar});`,
    "console.info(`[start-minimized-to-tray] tray readiness`,{ready});",
    `codexLinuxStartMinimized=codexLinuxStartMinimized&&ready;${startupVar}.isBackgroundLaunch=` +
      `${startupVar}.isBackgroundLaunch||codexLinuxStartMinimized/*codexLinuxStartMinimizedNativeBackground*/`,
    `let ${windowVar}=await ${servicesVar}.ensureWindow({background:${startupVar}.isBackgroundLaunch});`,
    `${windowVar}?.once(\`show\`,()=>{${attributionVar}.handleInitialWindowVisible()}),`,
    `${windowVar}!=null&&!${startupVar}.isBackgroundLaunch&&(${showVar}(${windowVar},!${backgroundVar}),` +
      `${attributionVar}.handleInitialWindowVisible())`,
  ];
  return relationships.every((relationship) => hasExactlyOne(source, relationship)) &&
    hasExactlyOne(source, codexLinuxStartMinimizedTrayReady.toString()) &&
    hasExactlyOne(source, codexLinuxStartMinimizedAutostart.toString()) &&
    hasExactlyOne(source, codexLinuxStartMinimizedPreference.toString());
}

function applyMainPatch(source) {
  const state = unique(source, new RegExp(`let (${ID})=await ${ID}\\.${ID}\\(\\{moduleDir:__dirname\\}\\),`, "g"));
  if (hasCompleteMainPatch(source, state)) {
    return source;
  }
  if (source.includes(MAIN_MARKER) || source.includes("codexLinuxStartMinimized")) {
    console.warn("WARN: Start minimized to tray patched startup contract missing or ambiguous");
    return source;
  }
  if (!state) {
    console.warn("WARN: Start minimized to tray startup contract missing or ambiguous");
    return source;
  }
  const afterState = source.slice(state.index);
  const background = unique(afterState, new RegExp(
    `let (${ID})=process\\.env\\.CODEX_ELECTRON_START_IN_BACKGROUND===\`1\`,(${ID})=`,
    "g",
  ));
  const trayReady = unique(afterState, new RegExp(`canHideLastWindowToTray:(${ID}),isRemoteHostedPIPEnabled:`, "g"));
  const traySetup = unique(source, new RegExp(`\\((${ID})\\|\\|process\\.platform===\`linux\`\\)&&(${ID})\\(\\);`, "g"));
  const startupWindow = unique(source, new RegExp(
    `let (${ID})=await (${ID})\\.ensureWindow\\(\\{background:(${ID})\\.isBackgroundLaunch\\}\\);` +
      `\\1\\?\\.once\\(\`show\`,\\(\\)=>\\{(${ID})\\.handleInitialWindowVisible\\(\\)\\}\\),` +
      `\\1!=null&&!\\3\\.isBackgroundLaunch&&\\((${ID})\\(\\1,!(${ID})\\),\\4\\.handleInitialWindowVisible\\(\\)\\)`,
    "g",
  ));
  if (!background || !trayReady || !traySetup || !startupWindow) {
    console.warn("WARN: Start minimized to tray startup contract missing or ambiguous");
    return source;
  }

  const [startupNeedle, windowVar, servicesVar, startupVar, attributionVar, showVar, backgroundVar] = startupWindow;
  let patched = source.replace(
    background[0],
    `let codexLinuxStartMinimizedPreferences=codexLinuxStartMinimizedPreference(${state[1]}.globalState);` +
      "let codexLinuxStartMinimized=codexLinuxStartMinimizedPreferences.requested;" +
      `console.info(\`[start-minimized-to-tray] startup preference\`,codexLinuxStartMinimizedPreferences);${background[0]}`,
  );
  patched = patched.replace(
    traySetup[0],
    `let codexLinuxStartMinimizedTraySetup=(${traySetup[1]}||process.platform===\`linux\`)?${traySetup[2]}():null;`,
  );
  patched = patched.replace(
    startupNeedle,
    `if(codexLinuxStartMinimized){let ready=await ${MAIN_MARKER}(codexLinuxStartMinimizedTraySetup,${trayReady[1]});` +
      "console.info(`[start-minimized-to-tray] tray readiness`,{ready});" +
      `codexLinuxStartMinimized=codexLinuxStartMinimized&&ready;${startupVar}.isBackgroundLaunch=` +
      `${startupVar}.isBackgroundLaunch||codexLinuxStartMinimized/*codexLinuxStartMinimizedNativeBackground*/}` +
      `let ${windowVar}=await ${servicesVar}.ensureWindow({background:${startupVar}.isBackgroundLaunch});` +
      `${windowVar}?.once(\`show\`,()=>{${attributionVar}.handleInitialWindowVisible()}),` +
      `${windowVar}!=null&&!${startupVar}.isBackgroundLaunch&&(${showVar}(${windowVar},!${backgroundVar}),` +
      `${attributionVar}.handleInitialWindowVisible())`,
  );
  return `${codexLinuxStartMinimizedAutostart.toString()}\n${codexLinuxStartMinimizedPreference.toString()}\n${codexLinuxStartMinimizedTrayReady.toString()}\n${patched}`;
}
function settingsContract(source) {
  const owner = unique(source, new RegExp(`function (${ID})\\((${ID})\\)\\{.{0,300}?\\{platform:(${ID})\\}=(${ID})\\(\\),(${ID})=(${ID})\\((${ID})\\.macMenuBarEnabled\\);if\\(\\3!==\`macOS\`\\)return null;`, "g"));
  if (!owner) return null;
  const end = findMatchingBrace(source, source.indexOf("{", owner.index));
  const body = source.slice(owner.index, end + 1);
  const row = unique(body, new RegExp(`\\(0,(${ID})\\.jsx\\)\\((${ID}),\\{label:${ID},description:${ID},control:${ID}\\}`, "g"));
  const toggle = unique(body, new RegExp(`\\(0,${ID}\\.jsx\\)\\((${ID}),\\{checked:${ID},onChange:${ID},ariaLabel:${ID}\\}`, "g"));
  const reactUse = source.match(new RegExp(`\\(0,(${ID})\\.useState\\)\\(`));
  const react = reactUse && source.match(new RegExp(`${escapeRegExp(reactUse[1])}=(${ID})\\(\\)`));
  const render = unique(source, new RegExp(`\\(0,(${ID})\\.jsx\\)\\(${escapeRegExp(owner[1])},\\{appName:${ID}\\}\\)`, "g"));
  const intlUse = unique(body, new RegExp(`(${ID})\\.formatMessage\\(\\{id:\`settings\\.general\\.macMenuBar\\.ariaLabel\``, "g"));
  const intl = intlUse && unique(body, new RegExp(`\\b${escapeRegExp(intlUse[1])}=(${ID})\\(\\)`, "g"));
  if (!row || !toggle || !react || !render || !intl || row[1] !== render[1]) return null;
  return { owner, row: row[2], toggle: toggle[1], reactFactory: react[1], platformHook: owner[4], jsx: row[1], intlHook: intl[1], render };
}

function settingComponent({ row, toggle, reactFactory, platformHook, jsx, intlHook }, bootOnly = false) {
  const key = bootOnly ? BOOT_ONLY_SETTINGS_KEY : SETTINGS_KEY;
  const marker = bootOnly ? BOOT_ONLY_UI_MARKER : UI_MARKER;
  const label = bootOnly ? "Start minimized to tray only on boot" : "Start minimized to tray";
  const description = bootOnly
    ? "Hide the main window only when started automatically at login. Manual launches open normally. Takes priority over Start minimized to tray; does not enable autostart."
    : "Start with the main window hidden in the system tray. Applies after quitting and restarting the app, unless the boot-only option is enabled.";
  return `function ${marker}(){let React=${reactFactory}(),{platform}= ${platformHook}(),[enabled,setEnabled]=React.useState(!1),[pending,setPending]=React.useState(!0),[error,setError]=React.useState(null),intl=${intlHook}(),label=intl.formatMessage({id:${JSON.stringify(LABEL_IDS[Number(bootOnly)])},defaultMessage:${JSON.stringify(label)}}),description=intl.formatMessage({id:${JSON.stringify(DESCRIPTION_IDS[Number(bootOnly)])},defaultMessage:${JSON.stringify(description)}});React.useEffect(()=>{let alive=!0;return codexLinuxStartMinimizedPost(\`get-global-state\`,{params:{key:${JSON.stringify(key)}}}).then(e=>{if(alive)setEnabled(e?.value===!0)}).catch(e=>{if(alive)setError(String(e))}).finally(()=>{if(alive)setPending(!1)}),()=>{alive=!1}},[]);if(platform!==\`linux\`)return null;let change=async value=>{setPending(!0);setError(null);try{let result=await codexLinuxStartMinimizedPost(\`set-global-state\`,{params:{key:${JSON.stringify(key)},value:value===!0}});if(result?.success!==!0)throw Error(\`Could not save startup preference\`);setEnabled(value===!0)}catch(e){setError(String(e))}finally{setPending(!1)}};return(0,${jsx}.jsx)(${row},{label,description:error??description,control:(0,${jsx}.jsx)(${toggle},{checked:enabled,disabled:pending,onChange:change,ariaLabel:label})})}`;
}

function labelCatalogPatches(assetsDir) {
  const patches = [];
  for (const name of fs.readdirSync(assetsDir)) {
    const locale = name.match(/^([a-z]{2}(?:-(?:[A-Za-z]{2,4}|\d{3}))?)-[\w-]+\.js$/)?.[1];
    if (!locale) continue;
    const target = path.join(assetsDir, name);
    const source = fs.readFileSync(target, "utf8");
    if (!source.includes('"settings.general.macMenuBar.label"')) continue;
    const labels = LABEL_TRANSLATIONS[locale];
    if (!labels) throw Error(`Start minimized to tray label translations missing for ${locale}`);
    const descriptions = DESCRIPTION_TRANSLATIONS[locale];
    if (!descriptions) throw Error(`Start minimized to tray description translations missing for ${locale}`);
    const exports = unique(source, /export\{([^}]+)\}/g);
    const alias = exports && unique(exports[1], new RegExp(`(?:^|,)(${ID}) as default(?=,|$)`, "g"))?.[1];
    const dictionary = alias && unique(source, new RegExp(`\\b${escapeRegExp(alias)}=\\{`, "g"));
    const open = dictionary && dictionary.index + dictionary[0].length - 1;
    const end = open != null ? findMatchingBrace(source, open) : -1;
    if (!dictionary || !source.slice(open, end + 1).includes('"settings.general.macMenuBar.label"')) {
      throw Error(`Start minimized to tray ${locale} label catalog contract missing or ambiguous`);
    }
    const ids = [...LABEL_IDS, ...DESCRIPTION_IDS];
    const messages = [...labels, ...descriptions];
    const entries = ids.map((id, index) => `${JSON.stringify(id)}:${JSON.stringify(messages[index])},`).join("");
    if (ids.some(id => source.includes(JSON.stringify(id)))) {
      if (source.slice(open + 1, open + 1 + entries.length) !== entries ||
          ids.some(id => source.split(JSON.stringify(id)).length !== 2)) {
        throw Error(`Start minimized to tray ${locale} patched label catalog contract missing or ambiguous`);
      }
      continue;
    }
    patches.push({ target, source: source.slice(0, open + 1) + entries + source.slice(open + 1) });
  }
  return patches;
}

function applySettingsPatch(extractedDir) {
  const assetsDir = path.join(extractedDir, "webview/assets");
  const candidates = fs.readdirSync(assetsDir).filter((name) => name.endsWith(".js"))
    .map((name) => ({ name, source: fs.readFileSync(path.join(assetsDir, name), "utf8") }))
    .filter(({ source }) => source.includes("settings.general.macMenuBar.description") && source.includes(".macMenuBarEnabled"));
  if (candidates.length !== 1) throw Error("Start minimized to tray General settings asset missing or ambiguous");
  const [{ name, source }] = candidates;
  const contract = settingsContract(source);
  if (!contract) throw Error("Start minimized to tray General settings contract missing or ambiguous");
  const request = findCodexRequestWebviewAsset(assetsDir);
  const requestImport = `import{${request.exportName} as codexLinuxStartMinimizedPost}from\"./${request.assetName}\";\n`;
  const render = `${contract.render[0]},(0,${contract.jsx}.jsx)(${UI_MARKER},{}),(0,${contract.jsx}.jsx)(${BOOT_ONLY_UI_MARKER},{})`;
  const component = `${settingComponent(contract)}\n${settingComponent(contract, true)}`;
  // Validate every affected catalog before writing settings or translations.
  const catalogs = labelCatalogPatches(assetsDir);
  let patched = source;
  if (source.includes(`function ${UI_MARKER}(`)) {
    if (source.split(component).length !== 2 || source.split(requestImport).length !== 2 ||
        source.split(render).length !== 2) {
      throw Error("Start minimized to tray patched General settings contract missing or ambiguous");
    }
  } else {
    patched = requestImport + source.replace(contract.render[0], render) + `\n${component}\n`;
  }
  if (patched !== source) fs.writeFileSync(path.join(assetsDir, name), patched);
  for (const catalog of catalogs) fs.writeFileSync(catalog.target, catalog.source);
  return { changed: patched !== source || catalogs.length > 0 };
}

module.exports = {
  SETTINGS_KEY, BOOT_ONLY_SETTINGS_KEY, applyMainPatch, applySettingsPatch, settingsContract, settingComponent,
  codexLinuxStartMinimizedTrayReady, codexLinuxStartMinimizedAutostart, codexLinuxStartMinimizedPreference,
  LABEL_IDS, LABEL_TRANSLATIONS, DESCRIPTION_IDS, DESCRIPTION_TRANSLATIONS,
  descriptors: [
    { id: "startup", phase: "main-bundle", order: 20970, apply: applyMainPatch },
    { id: "general-setting", phase: "extracted-app:post-webview", order: 20970, apply: applySettingsPatch },
  ],
};
