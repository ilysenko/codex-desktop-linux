"use strict";

const fs = require("node:fs");
const path = require("node:path");

const COMPUTER_USE_UI_ENV_VAR = "CODEX_LINUX_ENABLE_COMPUTER_USE_UI";
const COMPUTER_USE_UI_SETTINGS_KEY = "codex-linux-computer-use-ui-enabled";
const COMPUTER_USE_CURSOR_HANDLER_MARKER =
  "setRemoteHostedPIPContentComputerUseCursorLocationHandler";
const LINUX_COMPUTER_USE_CURSOR_BRIDGE_MARKER =
  "codexLinuxRegisterComputerUseCursorHandler";

function linuxComputerUseCursorBridgeRuntimeSource() {
  return [
    "function codexLinuxComputerUseCursorComponent(e){return typeof e==`string`&&e!==`.`&&e!==`..`&&/^[A-Za-z0-9._-]+$/.test(e)}function codexLinuxComputerUseCursorSocketPath(){let e=process.env.XDG_RUNTIME_DIR?.trim();if(!e)return null;let t=require(`node:path`);if(!t.isAbsolute(e))return null;let n=(process.env.CODEX_LINUX_APP_ID||process.env.CODEX_APP_ID||`codex-desktop`).trim();codexLinuxComputerUseCursorComponent(n)||(n=`codex-desktop`);let r=process.env.CODEX_LINUX_INSTANCE_ID?.trim()||``;if(r&&!codexLinuxComputerUseCursorComponent(r))return null;let i=r?t.join(e,n,`instances`,r,`computer-use-cursor.sock`):t.join(e,n,`computer-use-cursor.sock`);return Buffer.byteLength(i,`utf8`)<=100?i:null}",
    "function codexLinuxRegisterComputerUseCursorHandler(e){let t=codexLinuxRegisterComputerUseCursorHandler;t.handler=e;if(t.server!=null)return!0;let n=codexLinuxComputerUseCursorSocketPath();if(n==null)return!1;try{let r=require(`node:path`),i=require(`node:fs`),a=require(`node:net`),o=require(`electron`),s=r.dirname(n),l=typeof process.getuid==`function`?process.getuid():null,u=i.lstatSync(process.env.XDG_RUNTIME_DIR.trim());if(!u.isDirectory()||u.isSymbolicLink()||l!=null&&u.uid!==l||(u.mode&63)!==0)return!1;i.mkdirSync(s,{recursive:!0,mode:448});let c=i.lstatSync(s);if(!c.isDirectory()||c.isSymbolicLink()||l!=null&&c.uid!==l)return!1;i.chmodSync(s,448);if(i.existsSync(n)){let e=i.lstatSync(n);if(!(e.isSocket()||e.isSymbolicLink())||l!=null&&e.uid!==l)return!1;i.unlinkSync(n)}let d=()=>{let e=t.socketIdentity;t.socketIdentity=null;if(e==null)return;try{let r=i.lstatSync(n);r.dev===e.dev&&r.ino===e.ino&&r.isSocket()&&i.unlinkSync(n)}catch{}},p=()=>{t.timer!=null&&(clearTimeout(t.timer),t.timer=null);let e=t.server;t.server=null;try{e?.close()}catch{}d()},m=()=>{try{let e=t.handler;if(typeof e!=`function`)return;let n=o.screen.getCursorScreenPoint();e({isActive:!0,x:n.x,y:n.y}),t.timer!=null&&clearTimeout(t.timer),t.timer=setTimeout(()=>{try{let e=t.handler;typeof e==`function`&&e({isActive:!1,x:n.x,y:n.y})}catch{}finally{t.timer=null}},900),t.timer.unref?.()}catch{}},f=a.createServer(e=>{let t=``,n=!1;e.setEncoding(`utf8`),e.setTimeout(250,()=>e.destroy()),e.on(`error`,()=>{}),e.on(`data`,r=>{if(n)return;t+=r;if(t.length>64){n=!0,e.destroy();return}if(t.includes(`\n`)){n=!0,t.trim()===`pointer`&&m(),e.end()}})});return t.server=f,f.on(`error`,()=>{t.server===f&&(t.server=null),d()}),f.listen(n,()=>{try{i.chmodSync(n,384);let e=i.lstatSync(n);if(!e.isSocket()||l!=null&&e.uid!==l)throw Error(`unsafe cursor socket`);t.socketIdentity={dev:e.dev,ino:e.ino},f.unref()}catch{p()}}),t.cleanupRegistered||(t.cleanupRegistered=!0,o.app.once(`before-quit`,p)),!0}catch{return t.server=null,!1}}",
  ].join("");
}

// The rspack main process inlines the macOS cursor-location registration as an
// anonymous function inside the avatar overlay constructor. Function
// declarations cannot be inserted there, so the bridge runtime is prepended to
// the CommonJS chunk and the registration gains a Linux branch.
const COMPUTER_USE_CURSOR_REGISTRATION_PATTERN = new RegExp(
  String.raw`function(?: [\w$]+)?\((?<handler>[\w$]+),\{(?:[^{}]*,)?platform:(?<platform>[\w$]+)=process\.platform(?:,[^{}]*)?\}=\{\}\)\{` +
    String.raw`(?<linux>if\("linux"===\k<platform>\)return ${LINUX_COMPUTER_USE_CURSOR_BRIDGE_MARKER}\(\k<handler>\);)?` +
    String.raw`if\("darwin"===\k<platform>\)try\{\((?:(?!function)[^;])*?\)\.${COMPUTER_USE_CURSOR_HANDLER_MARKER}\(\k<handler>\)\}`,
  "g",
);

function countOccurrences(source, needle) {
  return source.split(needle).length - 1;
}

function applyLinuxComputerUseAvatarCursorBridgePatch(currentSource) {
  const skip = (reason) => {
    console.warn(`WARN: ${reason} - skipping Linux avatar cursor bridge patch`);
    return currentSource;
  };
  const markerCount = countOccurrences(currentSource, COMPUTER_USE_CURSOR_HANDLER_MARKER);
  if (markerCount === 0) {
    return skip("Could not find the Computer Use cursor handler marker");
  }
  const registrations = [...currentSource.matchAll(COMPUTER_USE_CURSOR_REGISTRATION_PATTERN)];
  if (markerCount !== 1 || registrations.length !== 1) {
    return skip("Could not identify the Computer Use cursor registration function");
  }

  const runtime = linuxComputerUseCursorBridgeRuntimeSource();
  const runtimeCount = countOccurrences(currentSource, runtime);
  const bridgeCount = countOccurrences(currentSource, LINUX_COMPUTER_USE_CURSOR_BRIDGE_MARKER);
  const [registration] = registrations;
  if (registration.groups.linux != null) {
    // Runtime: two declarations plus three self references; guard: one call.
    if (runtimeCount === 1 && bridgeCount === countOccurrences(runtime, LINUX_COMPUTER_USE_CURSOR_BRIDGE_MARKER) + 1) {
      return currentSource;
    }
    return skip("Computer Use cursor bridge is partially applied");
  }
  if (runtimeCount !== 0 || bridgeCount !== 0) {
    return skip("Computer Use cursor bridge is partially applied");
  }

  const { handler, platform } = registration.groups;
  const darwinGuard = `if("darwin"===${platform})try{`;
  const guardIndex = registration.index + registration[0].indexOf(darwinGuard);
  const patched = currentSource.slice(0, guardIndex) +
    `if("linux"===${platform})return ${LINUX_COMPUTER_USE_CURSOR_BRIDGE_MARKER}(${handler});` +
    currentSource.slice(guardIndex);
  // Chunk files are CommonJS modules; top-level declarations are visible to
  // every module factory in the chunk and may use Node's require directly.
  return runtime + patched;
}

// Computer Use has two postures: the bundled plugin gate is default-on Linux
// platform glue; the visible UI gates remain opt-in because they bypass rollout
// checks in upstream webview code.
function isComputerUseUiEnabled(env = process.env) {
  if (env[COMPUTER_USE_UI_ENV_VAR] === "1") {
    return true;
  }
  return readComputerUseUiSettingsFlag(env);
}

function readComputerUseUiSettingsFlag(env) {
  const settingsPath = computerUseUiSettingsPath(env);
  if (settingsPath == null) {
    return false;
  }
  try {
    if (!fs.existsSync(settingsPath)) {
      return false;
    }
    const raw = fs.readFileSync(settingsPath, "utf8");
    const parsed = JSON.parse(raw);
    if (parsed == null || typeof parsed !== "object" || Array.isArray(parsed)) {
      return false;
    }
    return parsed[COMPUTER_USE_UI_SETTINGS_KEY] === true;
  } catch {
    return false;
  }
}

function computerUseUiSettingsPath(env) {
  const override = env.CODEX_LINUX_SETTINGS_FILE;
  if (typeof override === "string" && override.length > 0) {
    return override;
  }
  const xdgConfig = env.XDG_CONFIG_HOME;
  const home = env.HOME;
  const configHome = (xdgConfig && xdgConfig.length > 0)
    ? xdgConfig
    : home
      ? path.join(home, ".config")
      : null;
  if (configHome == null) {
    return null;
  }
  const appId = computerUseUiSettingsAppId(env);
  return path.join(configHome, appId, "settings.json");
}

function computerUseUiSettingsAppId(env) {
  const appId = env.CODEX_LINUX_APP_ID || env.CODEX_APP_ID || "codex-desktop";
  return /^[A-Za-z0-9._-]+$/.test(appId) ? appId : "codex-desktop";
}

// Lookback/lookahead windows used when searching for the nearest minified
// identifier or surrounding context around a regex anchor in the bundle.
// Sized empirically to the typical distance between a feature's anchor and
// the helper aliases it depends on.
const TRAY_GUARD_LOOKAHEAD = 1200;
const CLOSE_GATE_PREFIX_LOOKBACK = 8000;
const HANDLER_PREFIX_LOOKBACK = 12000;
const DIRECT_HANDLER_PROXIMITY = 1200;

const linuxSettingsKeys = {
  promptWindow: "codex-linux-prompt-window-enabled",
  systemTray: "codex-linux-system-tray-enabled",
  warmStart: "codex-linux-warm-start-enabled",
};

function applyLinuxComputerUseFeaturePatch(currentSource) {
  const identifier = "[A-Za-z_$][\\w$]*";
  const windowsOverride = (platformVar, envVar, featuresVar, featuresRef) =>
    `"win32"===${platformVar}&&"1"===${envVar}\\.CODEX_ELECTRON_ENABLE_WINDOWS_COMPUTER_USE\\?` +
    `\\{\\.\\.\\.${featuresVar},computerUse:!0\\}:${featuresRef},`;
  const currentPattern = new RegExp(
    `let (${identifier})=` +
      windowsOverride(`(${identifier})`, `(${identifier})`, `(${identifier})`, "\\4"),
    "g",
  );
  const patchedPattern = new RegExp(
    `let (${identifier})="linux"===(${identifier})\\?\\{\\.\\.\\.(${identifier}),computerUse:!0\\}:` +
      windowsOverride("\\2", `(${identifier})`, "\\3", "\\3"),
    "g",
  );
  const current = [...currentSource.matchAll(currentPattern)];
  const patched = [...currentSource.matchAll(patchedPattern)];
  if (patched.length === 1 && current.length === 0) return currentSource;
  if (current.length === 1 && patched.length === 0) {
    const match = current[0];
    const [, gateVar, platformVar, envVar, featuresVar] = match;
    const replacement =
      `let ${gateVar}="linux"===${platformVar}?{...${featuresVar},computerUse:!0}:` +
      `"win32"===${platformVar}&&"1"===${envVar}.CODEX_ELECTRON_ENABLE_WINDOWS_COMPUTER_USE?` +
      `{...${featuresVar},computerUse:!0}:${featuresVar},`;
    return currentSource.slice(0, match.index) + replacement +
      currentSource.slice(match.index + match[0].length);
  }

  console.warn(
    "WARN: Could not find Computer Use desktop feature gate — skipping Linux Computer Use feature patch",
  );

  return currentSource;
}

function applyCurrentComputerUseHostPlatformContract(currentSource) {
  const contractPattern =
    /([A-Za-z_$][\w$]*)=([A-Za-z_$][\w$]*)\(\{areRequirementsPending:([A-Za-z_$][\w$]*),areRequiredFeaturesEnabled:([A-Za-z_$][\w$]*),enabled:([A-Za-z_$][\w$]*),isBrowserAndComputerUseAllowed:([A-Za-z_$][\w$]*),isAnyFeatureLoading:([A-Za-z_$][\w$]*),isComputerUseGateEnabled:([A-Za-z_$][\w$]*),isHostCompatiblePlatform:([^,{}]+),isPlatformLoading:([A-Za-z_$][\w$]*),windowType:`electron`\}\)/g;
  const candidates = [];
  let match;
  while ((match = contractPattern.exec(currentSource)) != null) {
    const context = currentSource.slice(Math.max(0, match.index - 1200), match.index + match[0].length);
    if (!context.includes("featureName:`computer_use`")) {
      continue;
    }

    const hostExpression = match[9];
    const pristine = hostExpression.match(
      /^([A-Za-z_$][\w$]*)\(([A-Za-z_$][\w$]*)\)$/,
    );
    const patched = hostExpression.match(
      /^([A-Za-z_$][\w$]*)===`linux`\|\|([A-Za-z_$][\w$]*)\(([A-Za-z_$][\w$]*)\)$/,
    );
    let kind = "malformed";
    let platformVar = null;
    if (pristine != null) {
      kind = "pristine";
      platformVar = pristine[2];
    } else if (patched != null && patched[1] === patched[3]) {
      kind = "patched";
      platformVar = patched[1];
    }
    candidates.push({ hostExpression, kind, match, platformVar });
  }

  if (candidates.length !== 1 || candidates[0].kind === "malformed") {
    return null;
  }

  const candidate = candidates[0];
  if (candidate.kind === "patched") {
    return currentSource;
  }

  const hostExpressionStart = candidate.match.index +
    candidate.match[0].indexOf(candidate.hostExpression);
  const hostExpressionEnd = hostExpressionStart + candidate.hostExpression.length;
  return currentSource.slice(0, hostExpressionStart) +
    `${candidate.platformVar}===\`linux\`||${candidate.hostExpression}` +
    currentSource.slice(hostExpressionEnd);
}

function matchesLinuxComputerUseHostPlatformContract(currentSource) {
  return applyCurrentComputerUseHostPlatformContract(currentSource) != null;
}

function applyLinuxComputerUseHostPlatformPatch(currentSource) {
  const patchedSource = applyCurrentComputerUseHostPlatformContract(currentSource);
  if (patchedSource != null) {
    return patchedSource;
  }

  console.warn(
    "WARN: Could not find current Computer Use host-platform gate — skipping Linux Computer Use host-platform patch",
  );
  return currentSource;
}

module.exports = {
  COMPUTER_USE_UI_ENV_VAR,
  COMPUTER_USE_UI_SETTINGS_KEY,
  applyLinuxComputerUseAvatarCursorBridgePatch,
  applyLinuxComputerUseFeaturePatch,
  applyLinuxComputerUseHostPlatformPatch,
  isComputerUseUiEnabled,
  linuxComputerUseCursorBridgeRuntimeSource,
  matchesLinuxComputerUseHostPlatformContract,
};
