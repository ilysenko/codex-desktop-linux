"use strict";

const fs = require("node:fs");
const path = require("node:path");
const { findWebviewAssetsContaining } = require("../../scripts/patches/lib/assets.js");
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
// Since 26.1029 the desktop main process no longer serves `vscode://codex/<method>`
// webview fetches from a handler map. The view-message handler forwards every
// "fetch" message to the authenticated fetch wrapper, which only keeps the
// dictation route. This feature answers its own single URL in that view-message
// handler, before the wrapper, using the handler's profile global state and its
// inline view-message sender (the channel the webview fetch client listens to).
const ROUTE_URL = "vscode://codex/codex-linux-start-minimized-to-tray";
const ROUTE_MARKER = "/*codex-linux-start-minimized-to-tray-route*/";
const FETCH_FORWARD = new RegExp(`await this\\.fetchWrapper\\.handleRequest\\((${ID}),(${ID})\\);break;case"cancel-fetch":`, "g");
const FETCH_CASE = 'case"fetch":';
const VIEW_HANDLER_FIELDS = ["fetchWrapper;", "globalState;", "chunkedMessageSender;"];

// Answers one webview fetch for the two owned preference keys.
function codexLinuxStartMinimizedRoute(request, globalState, respond) {
  const requestId = request?.requestId;
  try {
    let body;
    try {
      body = typeof request?.body === "string" && request.body.length > 0 ? JSON.parse(request.body) : request?.body ?? {};
    } catch {
      throw Error("Invalid start minimized to tray request");
    }
    const key = body?.key;
    if (key !== "codex-linux-start-minimized-to-tray" && key !== "codex-linux-start-minimized-to-tray-only-on-boot") {
      throw Error("Unsupported start minimized to tray preference");
    }
    let result;
    if (body.action === "get") {
      result = { value: globalState.get(key) };
    } else if (body.action === "set") {
      globalState.set(key, body.value === true);
      result = { success: true };
    } else {
      throw Error("Unsupported start minimized to tray action");
    }
    respond({ type: "fetch-response", responseType: "success", requestId, status: 200,
      headers: { "content-type": "application/json" }, bodyJsonString: JSON.stringify(result) });
  } catch (error) {
    respond({ type: "fetch-response", responseType: "error", requestId, status: 500,
      error: error instanceof Error ? error.message : String(error) });
  }
}

function routeSource(webContents, request) {
  return `${ROUTE_MARKER}if(${JSON.stringify(ROUTE_URL)}===${request}?.url){codexLinuxStartMinimizedRoute(${request},this.globalState,codexLinuxStartMinimizedResponse=>this.chunkedMessageSender.sendInlineMessageForView(${webContents},codexLinuxStartMinimizedResponse));break}`;
}

// The "fetch" case belongs to exactly one view-message handler class: the one
// declaring the fetch wrapper, profile global state and inline view-message
// sender. Look it up by its declaration rather than the nearest "class "
// keyword, because other Linux features inject helpers (some with their own
// classes) into the handler's methods.
const CLASS_OPEN = new RegExp(`class ${ID}(?: extends ${ID}(?:\\.${ID})*)?\\{`, "g");
function viewHandlerOwnsIndex(source, caseIndex, endIndex) {
  const owners = [...source.slice(0, caseIndex).matchAll(CLASS_OPEN)]
    .map((match) => match.index + match[0].length - 1)
    .filter((open) => {
      const fields = source.slice(open, open + 1000).split(/[(=]/, 1)[0];
      return VIEW_HANDLER_FIELDS.every((field) => fields.includes(field));
    });
  return owners.length === 1 && findMatchingBrace(source, owners[0]) >= endIndex;
}

// Other Linux features may route their own URLs in the same "fetch" case
// before this one; they are tolerated only as complete codex-linux routes.
function fetchRoutePlan(source) {
  const forwards = [...source.matchAll(FETCH_FORWARD)];
  if (forwards.length !== 1) return null;
  const forward = forwards[0];
  const [, webContents, request] = forward;
  const caseIndex = source.lastIndexOf(FETCH_CASE, forward.index);
  const between = source.slice(caseIndex + FETCH_CASE.length, forward.index);
  if (caseIndex === -1 || (between.length > 0 && !between.startsWith("/*codex-linux-"))) return null;
  if (caseIndex === -1 || !viewHandlerOwnsIndex(source, caseIndex, forward.index)) return null;
  const route = routeSource(webContents, request);
  const routeCount = source.split(ROUTE_MARKER).length - 1;
  if (routeCount === 1) {
    return source.slice(forward.index - route.length, forward.index) === route ? (patched) => patched : null;
  }
  if (routeCount !== 0) return null;
  return (patched) => {
    const index = patched.indexOf(forward[0]);
    return patched.slice(0, index) + route + patched.slice(index);
  };
}

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
      !runtime.argv.includes("--codex-community-new-window") &&
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

// Seven upstream references: both startup window creations, both reveal
// decisions, the renderer mode gate, and both startup-progress windows.
const EXPECTED_LAUNCH_PARTS = 8;

function unique(source, pattern) {
  const matches = [...source.matchAll(pattern)];
  return matches.length === 1 ? matches[0] : null;
}

function backgroundContract(source, first) {
  if (!first) return null;
  const pattern = new RegExp(
    `let (${ID})="1"===process\\.env\\.CODEX_ELECTRON_START_IN_BACKGROUND,(${ID})=`,
    "g",
  );
  const matches = [...source.matchAll(pattern)].filter(
    (match) => match[1] === first[5] && match[2] === first[4],
  );
  return matches.length === 1 ? matches[0] : null;
}

function firstWindowContract(source, background) {
  const bg = escapeRegExp(background);
  return unique(source, new RegExp(`let (${ID})=${ID}\\.deepLinks\\.isWakeOnlyLaunch\\(\\)&&!${ID}\\?null:await (${ID})\\.ensureWindow\\(\\{background:${bg}\\}\\),${ID}=null==\\1\\?null:\\2\\.windowManager\\.getPersistenceWindowId\\(\\1\\);\\1\\?\\.once\\("show",\\(\\)=>\\{(${ID})\\.handleInitialWindowVisible\\(\\)\\}\\),null==\\1\\|\\|${bg}\\|\\|(${ID})\\(\\1,!(${ID})\\)`, "g"));
}

// The startup window-services call passes upstream's tray readiness predicate;
// the window-services factory destructures the same property name, so require
// the passed value to be the tray readiness function declaration.
function trayReadyContract(source, fromIndex) {
  const matches = [...source.slice(fromIndex).matchAll(new RegExp(`canHideLastWindowToTray:(${ID}),isRemoteHostedPIPEnabled:`, "g"))]
    .filter((match) => unique(source, new RegExp(`function ${escapeRegExp(match[1])}\\(\\)\\{return ${ID}&&${ID}\\?\\.isReady\\(\\)===!0\\}`, "g")));
  return matches.length === 1 ? matches[0] : null;
}

function windowModeContract(source) {
  return unique(source, new RegExp(`setPrimaryWindowMode\\((${ID}),(${ID})\\)\\{let (${ID})=(${ID})\\.BrowserWindow\\.fromWebContents\\(\\1\\);if\\(!\\3\\|\\|\\3\\.isDestroyed\\(\\)\\)return;let (${ID})=this\\.windowManager\\.getPrimaryWindow\\(\\);if\\(!\\5\\|\\|\\5\\.isDestroyed\\(\\)\\|\\|\\5\\.id!==\\3\\.id\\)return;`, "g"));
}

function hiddenWindowModeBody(webContents, mode, window) {
  return `if(this.windowManager.codexLinuxStartMinimized===!0&&!${window}.isVisible()){let pending=this.codexLinuxStartMinimizedWindowMode;if(pending?.window===${window}){pending.mode=${mode};return}this.codexLinuxStartMinimizedWindowMode={window:${window},webContents:${webContents},mode:${mode}};${window}.once(\`show\`,()=>{let pending=this.codexLinuxStartMinimizedWindowMode;if(pending?.window!==${window})return;this.codexLinuxStartMinimizedWindowMode=null;this.setPrimaryWindowMode(pending.webContents,pending.mode)});${window}.once(\`closed\`,()=>{if(this.codexLinuxStartMinimizedWindowMode?.window===${window})this.codexLinuxStartMinimizedWindowMode=null});return}`;
}

function preferenceDeclaration(state) {
  return `codexLinuxStartMinimizedPreferences=codexLinuxStartMinimizedPreference(${state}.globalState),codexLinuxStartMinimized=codexLinuxStartMinimizedPreferences.requested,codexLinuxStartMinimizedRequested=codexLinuxStartMinimized,`;
}

function trayReadinessStatement(services, isReady) {
  return `if(codexLinuxStartMinimized){let ready=await ${MAIN_MARKER}(codexLinuxStartMinimizedTraySetup,${isReady});console.info(\`[start-minimized-to-tray] tray readiness\`,{ready});codexLinuxStartMinimized=codexLinuxStartMinimized&&ready}${services}.windowManager.codexLinuxStartMinimized=codexLinuxStartMinimized;`;
}

function hasCompleteMainPatch(source, state, startup) {
  const exactlyOnce = value => source.split(value).length === 2;
  const launchBackground = `(${startup[1]}.isBackgroundLaunch||codexLinuxStartMinimized)`;
  const first = firstWindowContract(source, launchBackground);
  const windowMode = windowModeContract(source);
  const trayReady = trayReadyContract(source, state.index);
  const traySetup = unique(source, new RegExp(`let codexLinuxStartMinimizedTraySetup=\\((${ID})\\|\\|"linux"===process\\.platform\\)\\?(${ID})\\(\\):null;`, "g"));
  if (!first || !windowMode || !trayReady || !traySetup) return false;
  const clearHidden = `codexLinuxStartMinimized=!1;${first[2]}.windowManager.codexLinuxStartMinimized=!1;`;
  const activations = unique(source, new RegExp(`(${ID})=async\\((${ID}),(${ID})\\)=>\\{${escapeRegExp(clearHidden)}try\\{${escapeRegExp(first[2])}\\.hotkeyWindowLifecycleManager\\.hide\\(\\)`, "g"));
  const trayActivation = unique(source, new RegExp(`(${ID})=async\\((${ID}),(${ID})\\)=>\\{${escapeRegExp(clearHidden)}let ${ID}=await \\(async\\(${ID},${ID}\\)=>\\{if\\(!(${ID})&&\\(!codexLinuxStartMinimizedRequested\\|\\|${escapeRegExp(first[2])}\\.getPrimaryWindow\\(\\)==null\\)\\)return null;${escapeRegExp(first[2])}\\.hotkeyWindowLifecycleManager\\.hide\\(\\)`, "g"));
  if (!activations || !trayActivation || !unique(source, new RegExp(`if\\(${ID}\\.deepLinks\\.queueProcessArgs\\(${ID}\\)\\)\\{\\(${ID}\\|\\|codexLinuxStartMinimizedRequested\\)&&${escapeRegExp(activations[1])}\\(\\);return\\}`, "g"))) return false;
  return [
    codexLinuxStartMinimizedRoute.toString(),
    codexLinuxStartMinimizedTrayReady.toString(),
    codexLinuxStartMinimizedAutostart.toString(),
    codexLinuxStartMinimizedPreference.toString(),
    state[0] + preferenceDeclaration(state[1]),
    trayReadinessStatement(first[2], trayReady[1]) + first[0],
    windowMode[0] + hiddenWindowModeBody(...windowMode.slice(1, 4)),
    `${startup[1]}.onInteractiveLaunch=()=>{${clearHidden}null==${first[1]}||${first[1]}.isDestroyed()||${first[4]}(${first[1]}),`,
  ].every(exactlyOnce) && source.split(clearHidden).length === 4 &&
    source.split(launchBackground).length === EXPECTED_LAUNCH_PARTS;
}

function applyMainPatch(source) {
  const installFetchRoute = fetchRoutePlan(source);
  if (!installFetchRoute) {
    console.warn("WARN: Start minimized to tray fetch route owner missing or ambiguous");
    return source;
  }
  const state = unique(source, new RegExp(`let (${ID})=await \\(0,${ID}\\.${ID}\\)\\(\\{moduleDir:__dirname\\}\\),`, "g"));
  const startup = unique(source, new RegExp(`shouldShowPrimaryWindow:\\(\\)=>!\\(?(${ID})\\.isBackgroundLaunch`, "g"));
  const owner = startup?.[1] ?? "__missing";
  const launchBackground = source.includes(`function ${MAIN_MARKER}(`)
    ? `(${owner}.isBackgroundLaunch||codexLinuxStartMinimized)`
    : `${owner}.isBackgroundLaunch`;
  const first = firstWindowContract(source, launchBackground);
  const background = backgroundContract(source, first);
  if (source.includes(`function ${MAIN_MARKER}(`)) {
    if (!background || !state || !startup || !hasCompleteMainPatch(source, state, startup) ||
        source.split(ROUTE_MARKER).length !== 2) {
      console.warn("WARN: Start minimized to tray patched startup contract missing or ambiguous");
      return source;
    }
    return source;
  }
  if (source.includes("codexLinuxStartMinimized")) {
    console.warn("WARN: Start minimized to tray patched startup contract missing or ambiguous");
    return source;
  }
  const launchPattern = escapeRegExp(launchBackground);
  const trayReady = trayReadyContract(source, state?.index ?? 0);
  const traySetup = unique(source, new RegExp(`;\\((${ID})\\|\\|"linux"===process\\.platform\\)&&(${ID})\\(\\);`, "g"));
  const last = unique(source, new RegExp(`(${ID})===(${ID})\\|\\|${launchPattern}\\|\\|(${ID})\\(\\1,!(${ID})\\)`, "g"));
  // The current upstream bundle already defers restored maximization until
  // show. Require that contract instead of carrying the retired custom patch.
  const maximize = unique(source, new RegExp(`${ID}\\.once\\("ready-to-show",\\(\\)=>\\{(${ID})\\.isDestroyed\\(\\)\\|\\|\\(\\1\\.isVisible\\(\\)\\?(${ID})\\(\\):\\1\\.once\\("show",\\2\\)\\)\\}\\)`, "g"));
  const windowMode = windowModeContract(source);
  if (!background || !state || !startup || !trayReady || !traySetup || !first || !last || !maximize || !windowMode ||
      first[4] !== background[2] || first[5] !== background[1] ||
      last[2] !== first[1] || last[3] !== first[4] || last[4] !== first[5] ||
      source.split(launchBackground).length !== EXPECTED_LAUNCH_PARTS ||
      source.split(`background:${launchBackground}`).length !== 3 ||
      source.split(`shouldShow:()=>!${launchBackground}`).length !== 3) {
    console.warn("WARN: Start minimized to tray startup contract missing or ambiguous");
    return source;
  }
  const windowModeEnd = findMatchingBrace(source, source.indexOf("{", windowMode.index));
  const windowModeBody = source.slice(windowMode.index, windowModeEnd + 1);
  const deferredMode = `if(!this.shouldShowPrimaryWindow()&&!${windowMode[3]}.isVisible())return void ${windowMode[3]}.once("show",()=>this.setPrimaryWindowMode(${windowMode[1]},${windowMode[2]}));`;
  if (!unique(windowModeBody, new RegExp(`let ${ID}="onboarding"!==${escapeRegExp(windowMode[2])}\\.mode\\?null:`, "g")) ||
      windowModeBody.split(deferredMode).length !== 2 ||
      !windowModeBody.includes(`this.showPrimaryWindow(${windowMode[3]})`) ||
      !windowModeBody.includes("this.windowManager.syncPrimaryMinimumSize()")) {
    console.warn("WARN: Start minimized to tray window mode contract missing or ambiguous");
    return source;
  }
  const activations = unique(source, new RegExp(`(${ID})=async\\((${ID}),(${ID})\\)=>\\{try\\{${first[2]}\\.hotkeyWindowLifecycleManager\\.hide\\(\\)`, "g"));
  const trayActivation = unique(source, new RegExp(`(${ID})=async\\((${ID}),(${ID})\\)=>\\{let ${ID}=await \\(async\\(${ID},${ID}\\)=>\\{if\\(!(${ID})\\)return null;${first[2]}\\.hotkeyWindowLifecycleManager\\.hide\\(\\)`, "g"));
  const queuedActivation = unique(source, new RegExp(`if\\(${ID}\\.deepLinks\\.queueProcessArgs\\(${ID}\\)\\)\\{(${ID})&&${activations?.[1] ?? "__missing"}\\(\\);return\\}`, "g"));
  const interactive = unique(source, new RegExp(`${escapeRegExp(owner)}\\.onInteractiveLaunch=\\(\\)=>\\{null==${first[1]}\\|\\|${first[1]}\\.isDestroyed\\(\\)\\|\\|${first[4]}\\(${first[1]}\\),`, "g"));
  if (!activations || !trayActivation || !queuedActivation || !interactive) {
    console.warn("WARN: Start minimized to tray activation contract missing or ambiguous");
    return source;
  }
  let patched = source.replace(state[0], state[0] +
    preferenceDeclaration(state[1]));
  patched = patched.replace(background[0],
    `console.info(\`[start-minimized-to-tray] startup preference\`,codexLinuxStartMinimizedPreferences);${background[0]}`);
  patched = patched.replace(traySetup[0],
    `;let codexLinuxStartMinimizedTraySetup=(${traySetup[1]}||"linux"===process.platform)?${traySetup[2]}():null;`);
  patched = patched.replace(first[0],
    trayReadinessStatement(first[2], trayReady[1]) + first[0]);
  // Reuse upstream's background creation, attribution, and progress-window
  // guards, leaving its actual background-launch lifecycle state untouched.
  // EXPECTED_LAUNCH_PARTS rejects additional references rather than patching
  // an unverified consumer.
  patched = patched.replaceAll(launchBackground, `(${launchBackground}||codexLinuxStartMinimized)`);
  patched = patched.replace(windowMode[0], windowMode[0] + hiddenWindowModeBody(...windowMode.slice(1, 4)));
  const clearHidden = `codexLinuxStartMinimized=!1;${first[2]}.windowManager.codexLinuxStartMinimized=!1;`;
  // Upstream second-instance activation is already usable before host ready.
  // Tray navigation still needs its explicit exception for our hidden window.
  patched = patched.replace(activations[0], activations[0].replace("=>{", `=>{${clearHidden}`));
  patched = patched.replace(trayActivation[0], trayActivation[0]
    .replace("=>{", `=>{${clearHidden}`)
    .replace(`if(!${trayActivation[4]})`, `if(!${trayActivation[4]}&&(!codexLinuxStartMinimizedRequested||${first[2]}.getPrimaryWindow()==null))`));
  patched = patched.replace(queuedActivation[0], queuedActivation[0]
    .replace(`${queuedActivation[1]}&&`, `(${queuedActivation[1]}||codexLinuxStartMinimizedRequested)&&`));
  patched = patched.replace(interactive[0], interactive[0].replace("=>{", `=>{${clearHidden}`));
  // rspack chunks are CommonJS files; these helpers become chunk-scoped
  // declarations visible to the startup module factory below them.
  return installFetchRoute(`${codexLinuxStartMinimizedRoute.toString()}\n${codexLinuxStartMinimizedAutostart.toString()}\n${codexLinuxStartMinimizedPreference.toString()}\n${codexLinuxStartMinimizedTrayReady.toString()}\n${patched}`);
}

const MEMBER = `${ID}(?:\\.${ID})*`;
const SETTINGS_ASSET_NEEDLES = ['"settings.general.macMenuBar.ariaLabel"', ".macMenuBarEnabled"];
const LOCALE_LOADER_NEEDLES = ['"../locales/', ".json\":function(){return "];
const MAC_MENU_BAR_LABEL = '"settings.general.macMenuBar.label"';
const POST_FUNCTION = "codexLinuxStartMinimizedPost";

// rspack chunks hold `__webpack_modules__={id(module,exports,require){...},...}`.
// Injected settings code must live inside the owning module factory, whose
// imported bindings are factory-local variables.
function webpackModuleFactories(source) {
  const marker = "__webpack_modules__={";
  const markerIndex = source.indexOf(marker);
  if (markerIndex === -1 || source.indexOf(marker, markerIndex + 1) !== -1) return null;
  const factories = [];
  const head = new RegExp(`(?:"[^"\\\\]+"|${ID})\\((${ID})(?:,(${ID}))?(?:,(${ID}))?\\)\\{`, "y");
  let index = markerIndex + marker.length;
  while (source[index] !== "}") {
    head.lastIndex = index;
    const match = head.exec(source);
    if (!match) return null;
    const open = index + match[0].length - 1;
    const end = findMatchingBrace(source, open);
    if (end === -1) return null;
    factories.push({ start: index, open, end, requireName: match[3] ?? null });
    index = end + 1;
    if (source[index] === ",") index += 1;
  }
  return factories;
}

function factoryImports(factory, source, name) {
  if (factory.requireName == null) return false;
  const body = source.slice(factory.open, factory.end);
  return new RegExp(`(?:var |,)${escapeRegExp(name)}=${escapeRegExp(factory.requireName)}\\("`).test(body) ||
    new RegExp(`(?:^|[;{}])function ${escapeRegExp(name)}\\(`).test(body.slice(1));
}

function settingsContract(source) {
  const owner = unique(source, new RegExp(`function (${ID})\\((${ID})\\)\\{let [^;]*?\\{platform:(${ID})\\}=\\(0,(${MEMBER})\\)\\(\\),(${ID})=\\(0,${MEMBER}\\)\\(${MEMBER}\\.macMenuBarEnabled\\);if\\("macOS"!==\\3\\)return null;`, "g"));
  const factories = owner && webpackModuleFactories(source);
  const factory = factories?.find(({ open, end }) => open < owner.index && end > owner.index);
  if (!factory) return null;
  const ownerEnd = findMatchingBrace(source, source.indexOf("{", owner.index));
  if (ownerEnd === -1 || !/[;{}]/.test(source[owner.index - 1])) return null;
  const body = source.slice(owner.index, ownerEnd + 1);
  const row = unique(body, new RegExp(`\\(0,(${ID})\\.jsx\\)\\((${MEMBER}),\\{label:${ID},description:${ID},control:${ID}\\}\\)`, "g"));
  const toggle = unique(body, new RegExp(`\\(0,${ID}\\.jsx\\)\\((${MEMBER}),\\{checked:${ID},onChange:${ID},ariaLabel:${ID}\\}\\)`, "g"));
  const intlUse = unique(body, new RegExp(`(${ID})\\.formatMessage\\(\\{id:"settings\\.general\\.macMenuBar\\.ariaLabel"`, "g"));
  const intl = intlUse && unique(body, new RegExp(`(?<![\\w$.])${escapeRegExp(intlUse[1])}=\\(0,(${MEMBER})\\)\\(\\)`, "g"));
  const factorySource = source.slice(factory.open, factory.end + 1);
  const reactUses = [...factorySource.matchAll(new RegExp(`\\(0,(${ID})\\.use(?:State|Effect)\\)\\(`, "g"))].map((match) => match[1]);
  const react = reactUses.length > 0 && reactUses.every((name) => name === reactUses[0]) ? reactUses[0] : null;
  if (!row || !toggle || !intl || !react) return null;
  const jsx = row[1];
  const renderPattern = new RegExp(`\\(0,${escapeRegExp(jsx)}\\.jsx\\)\\(${escapeRegExp(owner[1])},\\{appName:[^{}]*\\}\\)(?=[,\\]])`, "g");
  const renders = [...factorySource.matchAll(renderPattern)].map((match) => ({ index: factory.open + match.index, text: match[0] }));
  const bindings = [jsx, react, row[2], toggle[1], owner[4], intl[1]].map((name) => name.split(".")[0]);
  if (renders.length === 0 || renders.some(({ index }) => index > owner.index && index < ownerEnd) ||
      !bindings.every((name) => factoryImports(factory, source, name))) {
    return null;
  }
  return { ownerEnd, factoryEnd: factory.end, renders, row: row[2], toggle: toggle[1], react, platformHook: owner[4], jsx, intlHook: intl[1] };
}

// Self-contained webview client for this feature's main-process route. It
// mirrors the upstream view-message transport and response channel.
function settingsPostSource() {
  return `function ${POST_FUNCTION}(codexLinuxBody){let codexLinuxState=globalThis.codexLinuxStartMinimizedRequests;if(codexLinuxState==null){codexLinuxState={sequence:0,pending:new Map};globalThis.codexLinuxStartMinimizedRequests=codexLinuxState;window.addEventListener("message",codexLinuxEvent=>{let codexLinuxData=codexLinuxEvent?.data;if(codexLinuxData==null||"object"!=typeof codexLinuxData||"fetch-response"!==codexLinuxData.type)return;let codexLinuxEntry=codexLinuxState.pending.get(codexLinuxData.requestId);if(codexLinuxEntry==null)return;codexLinuxState.pending.delete(codexLinuxData.requestId);clearTimeout(codexLinuxEntry.timer);if("success"===codexLinuxData.responseType){let codexLinuxParsed=null;try{codexLinuxParsed=codexLinuxData.bodyJsonString?JSON.parse(codexLinuxData.bodyJsonString):null}catch{}codexLinuxEntry.resolve(codexLinuxParsed)}else codexLinuxEntry.reject(Error(codexLinuxData.error||"Could not reach the startup preference service"))})}let codexLinuxRequestId="codex-linux-start-minimized-"+Date.now()+"-"+ ++codexLinuxState.sequence;return new Promise((codexLinuxResolve,codexLinuxReject)=>{let codexLinuxTimer=setTimeout(()=>{codexLinuxState.pending.delete(codexLinuxRequestId);codexLinuxReject(Error("Timed out reading the startup preference"))},1e4);codexLinuxState.pending.set(codexLinuxRequestId,{resolve:codexLinuxResolve,reject:codexLinuxReject,timer:codexLinuxTimer});let codexLinuxPayload={type:"fetch",requestId:codexLinuxRequestId,method:"POST",url:${JSON.stringify(ROUTE_URL)},body:JSON.stringify(codexLinuxBody)},codexLinuxBridge=window.electronBridge,codexLinuxMessage=new CustomEvent("codex-message-from-view",{detail:codexLinuxPayload});if(codexLinuxBridge?.sendMessageFromView){codexLinuxMessage.__codexForwardedViaBridge=!0;codexLinuxBridge.sendMessageFromView(codexLinuxPayload).catch(()=>{})}window.dispatchEvent(codexLinuxMessage)})}`;
}

function settingComponent({ row, toggle, react, platformHook, jsx, intlHook }, bootOnly = false) {
  const key = bootOnly ? BOOT_ONLY_SETTINGS_KEY : SETTINGS_KEY;
  const marker = bootOnly ? BOOT_ONLY_UI_MARKER : UI_MARKER;
  const label = bootOnly ? "Start minimized to tray only on boot" : "Start minimized to tray";
  const description = bootOnly
    ? "Hide the main window only when started automatically at login. Manual launches open normally. Takes priority over Start minimized to tray; does not enable autostart."
    : "Start with the main window hidden in the system tray. Applies after quitting and restarting the app, unless the boot-only option is enabled.";
  return `function ${marker}(){let{platform:codexLinuxPlatform}=(0,${platformHook})(),[codexLinuxEnabled,codexLinuxSetEnabled]=(0,${react}.useState)(!1),[codexLinuxPending,codexLinuxSetPending]=(0,${react}.useState)(!0),[codexLinuxError,codexLinuxSetError]=(0,${react}.useState)(null),codexLinuxIntl=(0,${intlHook})(),codexLinuxLabel=codexLinuxIntl.formatMessage({id:${JSON.stringify(LABEL_IDS[Number(bootOnly)])},defaultMessage:${JSON.stringify(label)}}),codexLinuxDescription=codexLinuxIntl.formatMessage({id:${JSON.stringify(DESCRIPTION_IDS[Number(bootOnly)])},defaultMessage:${JSON.stringify(description)}});(0,${react}.useEffect)(()=>{let codexLinuxAlive=!0;return ${POST_FUNCTION}({action:"get",key:${JSON.stringify(key)}}).then(codexLinuxResult=>{if(codexLinuxAlive)codexLinuxSetEnabled(codexLinuxResult?.value===!0)}).catch(codexLinuxProblem=>{if(codexLinuxAlive)codexLinuxSetError(String(codexLinuxProblem))}).finally(()=>{if(codexLinuxAlive)codexLinuxSetPending(!1)}),()=>{codexLinuxAlive=!1}},[]);if("linux"!==codexLinuxPlatform)return null;let codexLinuxChange=async codexLinuxValue=>{codexLinuxSetPending(!0);codexLinuxSetError(null);try{let codexLinuxResult=await ${POST_FUNCTION}({action:"set",key:${JSON.stringify(key)},value:codexLinuxValue===!0});if(codexLinuxResult?.success!==!0)throw Error("Could not save startup preference");codexLinuxSetEnabled(codexLinuxValue===!0)}catch(codexLinuxProblem){codexLinuxSetError(String(codexLinuxProblem))}finally{codexLinuxSetPending(!1)}};return(0,${jsx}.jsx)(${row},{label:codexLinuxLabel,description:codexLinuxError??codexLinuxDescription,control:(0,${jsx}.jsx)(${toggle},{checked:codexLinuxEnabled,disabled:codexLinuxPending,onChange:codexLinuxChange,ariaLabel:codexLinuxLabel})})}`;
}

function escapeSingleQuotedJson(text) {
  return text.replace(/\\/g, "\\\\").replace(/'/g, "\\'");
}

// The locale loader maps "../locales/<locale>.json" to a numbered async chunk
// and the module inside it; each catalog module is `e.exports=JSON.parse('...')`.
function labelCatalogPatches(extractedDir) {
  const assetsDir = path.join(extractedDir, "webview", "assets");
  const loaders = findWebviewAssetsContaining(extractedDir, LOCALE_LOADER_NEEDLES);
  if (loaders.length !== 1) throw Error("Start minimized to tray locale loader missing or ambiguous");
  const loader = fs.readFileSync(path.join(assetsDir, loaders[0]), "utf8");
  const entries = [...loader.matchAll(new RegExp(`"\\.\\./locales/([A-Za-z]{2}(?:-(?:[A-Za-z]{2,4}|\\d{3}))?)\\.json":function\\(\\)\\{return (${ID})\\.e\\((\\d+)\\)\\.then\\(\\2\\.t\\.bind\\(\\2,"([^"\\\\]+)",\\d+\\)\\)\\}`, "g"))]
    .map(([, locale, , chunk, moduleId]) => ({ locale, chunk, moduleId }));
  if (entries.length === 0 || entries.length !== loader.split('"../locales/').length - 1) {
    throw Error("Start minimized to tray locale loader contract missing or ambiguous");
  }
  const asyncNames = fs.readdirSync(path.join(assetsDir, "async"));
  const patches = [];
  for (const { locale, chunk, moduleId } of entries) {
    const files = asyncNames.filter((name) => name.startsWith(`${chunk}.`) && name.endsWith(".js"));
    if (files.length !== 1) throw Error(`Start minimized to tray ${locale} label catalog chunk missing or ambiguous`);
    const target = path.join(assetsDir, "async", files[0]);
    const source = fs.readFileSync(target, "utf8");
    if (!source.includes(MAC_MENU_BAR_LABEL)) continue;
    const labels = LABEL_TRANSLATIONS[locale];
    if (!labels) throw Error(`Start minimized to tray label translations missing for ${locale}`);
    const descriptions = DESCRIPTION_TRANSLATIONS[locale];
    if (!descriptions) throw Error(`Start minimized to tray description translations missing for ${locale}`);
    const id = escapeRegExp(moduleId);
    const catalog = unique(source, new RegExp(`(?:"${id}"|(?<![\\w$."])${id})\\((${ID})\\)\\{\\1\\.exports=JSON\\.parse\\('\\{`, "g"));
    if (!catalog) throw Error(`Start minimized to tray ${locale} label catalog contract missing or ambiguous`);
    const open = catalog.index + catalog[0].length;
    const ids = [...LABEL_IDS, ...DESCRIPTION_IDS];
    const messages = [...labels, ...descriptions];
    const inserted = escapeSingleQuotedJson(
      ids.map((messageId, index) => `${JSON.stringify(messageId)}:${JSON.stringify(messages[index])},`).join(""),
    );
    if (ids.some((messageId) => source.includes(JSON.stringify(messageId)))) {
      if (source.slice(open, open + inserted.length) !== inserted ||
          ids.some((messageId) => source.split(JSON.stringify(messageId)).length !== 2)) {
        throw Error(`Start minimized to tray ${locale} patched label catalog contract missing or ambiguous`);
      }
      continue;
    }
    patches.push({ target, source: source.slice(0, open) + inserted + source.slice(open) });
  }
  return patches;
}

function applySettingsPatch(extractedDir) {
  const assetsDir = path.join(extractedDir, "webview", "assets");
  const candidates = findWebviewAssetsContaining(extractedDir, SETTINGS_ASSET_NEEDLES);
  if (candidates.length !== 1) throw Error("Start minimized to tray General settings asset missing or ambiguous");
  const target = path.join(assetsDir, candidates[0]);
  const source = fs.readFileSync(target, "utf8");
  const contract = settingsContract(source);
  if (!contract) throw Error("Start minimized to tray General settings contract missing or ambiguous");
  const injected = `${settingsPostSource()}${settingComponent(contract)}${settingComponent(contract, true)}`;
  const rendered = `,(0,${contract.jsx}.jsx)(${UI_MARKER},{}),(0,${contract.jsx}.jsx)(${BOOT_ONLY_UI_MARKER},{})`;
  // Validate every affected catalog before writing settings or translations.
  const catalogs = labelCatalogPatches(extractedDir);
  let patched = source;
  if (source.includes(`function ${UI_MARKER}(`)) {
    // Other Linux settings features may declare their own rows in the same
    // factory, so the declarations need not stay adjacent to the owner.
    const injectedIndex = source.indexOf(injected);
    if (source.split(injected).length !== 2 || injectedIndex <= contract.ownerEnd || injectedIndex > contract.factoryEnd ||
        source.split(rendered).length - 1 !== contract.renders.length ||
        contract.renders.some(({ index, text }) => source.slice(index + text.length, index + text.length + rendered.length) !== rendered)) {
      throw Error("Start minimized to tray patched General settings contract missing or ambiguous");
    }
  } else {
    if (source.includes("codexLinuxStartMinimized")) {
      throw Error("Start minimized to tray patched General settings contract missing or ambiguous");
    }
    const edits = [
      { index: contract.ownerEnd + 1, text: injected },
      ...contract.renders.map(({ index, text }) => ({ index: index + text.length, text: rendered })),
    ].sort((left, right) => right.index - left.index);
    for (const edit of edits) patched = patched.slice(0, edit.index) + edit.text + patched.slice(edit.index);
  }
  if (patched !== source) fs.writeFileSync(target, patched);
  for (const catalog of catalogs) fs.writeFileSync(catalog.target, catalog.source);
  return { changed: patched !== source || catalogs.length > 0 };
}

module.exports = {
  SETTINGS_KEY, BOOT_ONLY_SETTINGS_KEY, ROUTE_URL, applyMainPatch, applySettingsPatch, settingsContract, settingComponent,
  settingsPostSource, codexLinuxStartMinimizedRoute,
  codexLinuxStartMinimizedTrayReady, codexLinuxStartMinimizedAutostart, codexLinuxStartMinimizedPreference,
  LABEL_IDS, LABEL_TRANSLATIONS, DESCRIPTION_IDS, DESCRIPTION_TRANSLATIONS,
  descriptors: [
    { id: "startup", phase: "main-bundle", order: 20970, apply: applyMainPatch },
    { id: "general-setting", phase: "extracted-app:post-webview", order: 20970, apply: applySettingsPatch },
  ],
};
