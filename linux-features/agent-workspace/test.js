#!/usr/bin/env node
"use strict";

const assert = require("node:assert/strict");
const { spawnSync } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const vm = require("node:vm");
const {
  enabledLinuxFeatureIds,
  enabledLinuxFeatureInstallPlan,
  enabledLinuxFeatureStageHooks,
  loadLinuxFeaturePatchDescriptors,
  stageEnabledLinuxFeatureInstall,
} = require("../../scripts/lib/linux-features.js");
const {
  createPatchReport,
} = require("../../scripts/lib/patch-report.js");
const {
  patchExtractedApp,
} = require("../../scripts/patches/runner.js");
const {
  SETTINGS_ASSET,
  SETTINGS_COMMAND_KEY,
  SETTINGS_PERMISSIONS_KEY,
  SETTINGS_SLUG,
  applyAgentWorkspaceMainBridgePatch,
  applyAgentWorkspaceSettingsCatalogPatch,
  applyAgentWorkspaceSettingsIndexPatch,
  applyAgentWorkspaceSettingsPagePatch,
  applyAgentWorkspaceSettingsSharedPatch,
  buildAgentWorkspaceSettingsSource,
  patchAgentWorkspaceSettingsAssets,
  descriptors: featurePatches,
} = require("./patch.js");

function withTempFeatureConfig(enabled, fn) {
  const originalConfig = process.env.CODEX_LINUX_FEATURES_CONFIG;
  const root = path.resolve(__dirname, "..");
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "codex-agent-workspace-feature-"));
  process.env.CODEX_LINUX_FEATURES_CONFIG = path.join(tempDir, "features.json");
  try {
    fs.writeFileSync(process.env.CODEX_LINUX_FEATURES_CONFIG, JSON.stringify({ enabled }, null, 2));
    return fn(root);
  } finally {
    if (originalConfig == null) {
      delete process.env.CODEX_LINUX_FEATURES_CONFIG;
    } else {
      process.env.CODEX_LINUX_FEATURES_CONFIG = originalConfig;
    }
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
}

function withLinuxFeatureRootEnv(root, fn) {
  const originalRoot = process.env.CODEX_LINUX_FEATURES_ROOT;
  process.env.CODEX_LINUX_FEATURES_ROOT = root;
  try {
    return fn();
  } finally {
    if (originalRoot == null) {
      delete process.env.CODEX_LINUX_FEATURES_ROOT;
    } else {
      process.env.CODEX_LINUX_FEATURES_ROOT = originalRoot;
    }
  }
}

function captureWarns(fn) {
  const warnings = [];
  const originalWarn = console.warn;
  console.warn = (...args) => warnings.push(args.map(String).join(" "));
  try {
    return { value: fn(), warnings };
  } finally {
    console.warn = originalWarn;
  }
}

function syntheticMainBundle() {
  return [
    "let c=require(`node:child_process`),o=require(`node:fs`),i=require(`node:path`);",
    "class Host{handlers(){return {",
    '"set-remote-wsl-connections-enabled":async()=>({})',
    "}}}",
  ].join("");
}

function buildBridgeHarness({ env = {}, globalState = new Map(), execFile, spawn, electron = null } = {}) {
  const patched = applyAgentWorkspaceMainBridgePatch(syntheticMainBundle());
  const execCalls = [];
  const spawnCalls = [];
  const childProcess = {
    execFile:
      execFile ||
      ((command, args, options, callback) => {
        execCalls.push({ command, args, options });
        callback(null, '{"profiles":[]}\n', "");
      }),
    spawn:
      spawn ||
      ((command, args, options) => {
        const call = { command, args, options, unref: false };
        spawnCalls.push(call);
        return {
          pid: 4242,
          unref() {
            call.unref = true;
          },
        };
      }),
  };
  const sandbox = {
    require(name) {
      if (name === "node:child_process") return childProcess;
      if (name === "node:fs") return fs;
      if (name === "node:path") return path;
      if (name === "electron" && electron) return electron;
      throw new Error(`unexpected require ${name}`);
    },
    process: { env: { ...process.env, ...env } },
    Buffer,
    clearTimeout,
    setTimeout,
  };
  vm.runInNewContext(`${patched};this.Host=Host;`, sandbox);
  const host = new sandbox.Host();
  host.globalState = {
    get(key) {
      return globalState.get(key);
    },
    set(key, value) {
      globalState.set(key, value);
    },
  };
  return { handlers: host.handlers(), execCalls, spawnCalls };
}

function syntheticCurrentSettingsMetadata() {
  return [
    "var c=r({",
    '"general-settings":{id:`settings.nav.general-settings`,defaultMessage:`General`,description:`Title for general settings section`},',
    '"local-environments":{id:`settings.nav.local-environments`,defaultMessage:`Environments`,description:`Title for environments settings section`},',
    "worktrees:{id:`settings.nav.worktrees`,defaultMessage:`Worktrees`,description:`Title for worktrees settings section`}",
    "});",
    "function m(e){let t=(0,u.c)(30),{slug:r}=e;switch(r){",
    "case`general-settings`:{let e;return t[0]===Symbol.for(`react.memo_cache_sentinel`)?(e=(0,d.jsx)(n,{id:`settings.section.general-settings`,defaultMessage:`General`}),t[0]=e):e=t[0],e}",
    "case`local-environments`:{let e;return t[21]===Symbol.for(`react.memo_cache_sentinel`)?(e=(0,g7.jsx)(Z,{id:`settings.section.local-environments`,defaultMessage:`Environments`}),t[21]=e):e=t[21],e}",
    "case`worktrees`:{let e;return t[22]===Symbol.for(`react.memo_cache_sentinel`)?(e=(0,g7.jsx)(Z,{id:`settings.section.worktrees.v2`,defaultMessage:`Worktrees`}),t[22]=e):e=t[22],e}",
    "}}",
  ].join("");
}

function syntheticCurrentAppInitialBundle() {
  return [
    "function render(e){return currentRouteMap[e.slug]}",
    'var generalRoute=BN(async()=>(await Y(async()=>{let{GeneralSettings:e}=await import(`./general-settings-TbWU8D8b.js`);return{GeneralSettings:e}},__vite__mapDeps([1,2]),import.meta.url)).GeneralSettings),',
    'currentRouteMap={billing:BN(Billing),"general-settings":generalRoute,notifications:BN(async()=>(await Y(async()=>{let{NotificationsSettingsPage:e}=await import(`./notifications-settings-DmsueF_s.js`);return{NotificationsSettingsPage:e}},__vite__mapDeps([3]),import.meta.url)).NotificationsSettingsPage)};',
    syntheticCurrentSettingsMetadata(),
    syntheticCurrentSettingsCatalog(),
  ].join("");
}

function syntheticCurrentSettingsNavigation() {
  return [
    'import{r,j as jsxFactory}from"./runtime-test.js";',
    'var React=r(),$=jsxFactory();',
    'function RuntimeProbe(){let [value]=(0,React.useState)(0);return (0,$.jsx)("span",{children:value})}',
    "var nn=`general-settings.linux-desktop.import.profile.appearance.voice.chronicle.appshots.agent.personalization.pets.usage.debug.keyboard-shortcuts.codex-micro.mcp-settings.hooks-settings.connections.cloud-settings.cloud-environments.code-review.git-settings.local-environments.worktrees.browser-use.computer-use.data-controls`.split(`.`);",
    "var rn=[{key:`personal`,slugs:[`general-settings`,`linux-desktop`]},{key:`coding`,slugs:[`hooks-settings`,`connections`,`cloud-settings`,`cloud-environments`,`code-review`,`git-settings`,`local-environments`,`environments`,`worktrees`]}];",
  ].join("");
}

function syntheticCurrentSettingsVisibility() {
  return [
    "var H=e=>e,F=e=>e;",
    'var it={"linux-desktop":{component:H},"general-settings":{component:H},"local-environments":{component:H,commandAsset:F,navigation:{assets:{16:F,20:H},ariaHidden:!1}},worktrees:{component:F,commandAsset:H,navigation:{assets:{16:H,20:F},ariaHidden:!1}},environments:{component:H},"mcp-settings":{component:H},connections:{component:H}};',
    "function visible(S){switch(S.slug){case`computer-use`:return!0;case`browser-use`:return!0;case`appearance`:return!0;case`pets`:case`git-settings`:case`worktrees`:case`local-environments`:case`environments`:return!0;case`data-controls`:return!0;case`linux-desktop`:case`general-settings`:case`agent`:case`personalization`:return!0;}}",
    "function loading(r){switch(r){case`browser-use`:return!1;case`hooks-settings`:case`mcp-settings`:return!1}}",
    'var policy={"local-environments":`codexLocal`,"mcp-settings":`codexOrWorkLocal`,worktrees:`codexLocal`};',
    "var remoteHostPreloadSlugs=[`profile`,`agent`,`personalization`,`mcp-settings`,`plugins-settings`,`file-type-handlers`,`hooks-settings`,`gateways`,`local-environments`,`worktrees`,`storage`,`archived-chats`,`voice`];",
    "function selectedHostVisibility(isLocal,section){if(!(isLocal||remoteHostPreloadSlugs.includes(section.slug)))return{section,visible:!1,pending:!1,error:!0};return{section,visible:!0,pending:!1,error:!1}}",
  ].join("");
}

function syntheticCurrentSettingsCatalog() {
  return [
    "var Vr=`general-settings.linux-desktop.import.profile.keyboard-shortcuts.codex-micro.appshots.appearance.voice.pets.agent.git-settings.data-controls.cloud-settings.cloud-environments.code-review.personalization.usage.debug.browser-use.computer-use.local-environments.worktrees.environments.mcp-settings.hooks-settings.connections.plugins-settings.skills-settings`.split(`.`);",
    "var Gr=[{slug:`general-settings`},{slug:`linux-desktop`},{slug:`local-environments`},{slug:`worktrees`},{slug:`agent`},{slug:`data-controls`}];",
  ].join("");
}

function syntheticComposerBundle() {
  return "const YH={default:e=>e};function sU(e,t){return t??(e==null?[]:Object.entries(e).map(([e,t])=>({name:e,value:t,displayName:(0,YH.default)(e.trim())})))}";
}

function syntheticMcpSettingsBundle() {
  return "export function McpSettings(){return `MCP settings untouched`}";
}

function syntheticGeneralSettingsBundle() {
  return "export function GeneralSettings(){return `General settings untouched`}";
}

function staleConversationMonitorBundle() {
  return [
    "let thread=1;",
    ';(()=>{const VERSION="agent-workspace-conversation-v12";if(globalThis.codexLinuxAgentWorkspaceConversationVersion===VERSION)return;try{globalThis.codexLinuxAgentWorkspaceConversationCleanup?.()}catch{}globalThis.codexLinuxAgentWorkspaceConversationVersion=VERSION;function start(){document.body?.insertAdjacentHTML?.("beforeend","<section class=\\"codex-linux-agent-workspace-panel\\"></section>")}if(document.readyState==="loading")document.addEventListener("DOMContentLoaded",start,{once:true});else start();})();',
    "",
  ].join("\n");
}

function writeSyntheticExtractedApp(root) {
  const buildDir = path.join(root, ".vite", "build");
  const assetsDir = path.join(root, "webview", "assets");
  fs.mkdirSync(buildDir, { recursive: true });
  fs.mkdirSync(assetsDir, { recursive: true });
  fs.writeFileSync(path.join(buildDir, "early-bootstrap.js"), syntheticMainBundle());
  fs.writeFileSync(path.join(root, "package.json"), JSON.stringify({ name: "codex" }));
  fs.writeFileSync(path.join(assetsDir, "local-conversation-thread-test.js"), staleConversationMonitorBundle());
  fs.writeFileSync(path.join(assetsDir, "composer-test.js"), syntheticComposerBundle());
  fs.writeFileSync(path.join(assetsDir, "mcp-settings-test.js"), syntheticMcpSettingsBundle());
  fs.writeFileSync(path.join(assetsDir, "general-settings-test.js"), syntheticGeneralSettingsBundle());
  fs.writeFileSync(path.join(assetsDir, "chunk-test.js"), "export function o(e){return e}");
  fs.writeFileSync(
    path.join(assetsDir, "setting-storage-test.js"),
    "async function send(e,t,n,r,i){return fetch(`vscode://codex/${e}`)}async function request(...e){let[t,n]=e,{params:r,select:i,signal:a,source:o}=n??{};return send(t,r,i,a,o)}export{request as l};",
  );
  fs.writeFileSync(path.join(assetsDir, "app-test.png"), "");
  rewriteSettingsAssetsWithConsolidatedCurrentLayout(assetsDir);
  return { buildDir, assetsDir };
}

function rewriteSettingsAssetsWithConsolidatedCurrentLayout(assetsDir) {
  fs.writeFileSync(
    path.join(assetsDir, "runtime-test.js"),
    'import{o}from"./chunk-test.js";export{ReactFactory as r,jsxFactory as j};function ReactFactory(){return{createElement(){return{}},useState(value){return[value,()=>{}]},useCallback(fn){return fn},useEffect(){}}}function jsxFactory(){return{jsx(){},jsxs(){}}}',
  );
  fs.writeFileSync(
    path.join(assetsDir, "settings-page-test.js"),
    syntheticCurrentSettingsNavigation(),
  );
  fs.writeFileSync(
    path.join(assetsDir, "app-initial-test.js"),
    syntheticCurrentAppInitialBundle(),
  );
  fs.writeFileSync(
    path.join(assetsDir, "use-visible-settings-sections-test.js"),
    syntheticCurrentSettingsVisibility(),
  );
}

function writeModernCodexRequestAsset(assetsDir) {
  fs.writeFileSync(
    path.join(assetsDir, "setting-storage-test.js"),
    "async function send(e,t,n,r,i){return fetch(`vscode://codex/${e}`)}async function request(...e){let[t,n]=e,{params:r,select:i,signal:a,source:o}=n??{};return send(t,r,i,a,o)}export{request as l};",
  );
}

function flushPromises() {
  return new Promise((resolve) => setImmediate(resolve));
}

function buildSettingsVmSource() {
  return buildAgentWorkspaceSettingsSource({
    chunkAsset: "chunk-test.js",
    reactAsset: "runtime-test.js",
    reactExportName: "r",
    settingsPageAsset: "settings-page-test.js",
    settingsPageExportName: "t",
    codexRequestAsset: "setting-storage-test.js",
    codexRequestExportName: "l",
  })
    .replace('import{s as __toESM}from"./chunk-test.js";\n', "")
    .replace('import{r as __reactFactory}from"./runtime-test.js";\n', "")
    .replace('import{l as __post}from"./setting-storage-test.js";\n', "")
    .replace('import{t as SettingsPage}from"./settings-page-test.js";\n', "")
    .replace(
      "export{AgentWorkspacesSettings,AgentWorkspacesSettings as default};",
      "globalThis.__commandArgv=commandArgv;globalThis.__startupAppFromManual=startupAppFromManual;globalThis.AgentWorkspacesSettings=AgentWorkspacesSettings;",
    );
}

// The page checks `agent-workspace-linux --version` on load. By default the harness answers
// that check with a passing version; pass `version: null` to let `post` answer it.
function createSettingsRenderHarness(post, { window: windowOverrides = {}, version = "0.6.0" } = {}) {
  const pagePost = version == null
    ? post
    : async (method, request = {}) => {
        if (method === "linux-agent-workspace" && request.params?.action === "version") {
          return { ok: true, action: "version", json: { version } };
        }
        return post(method, request);
      };
  const state = [];
  let hookIndex = 0;
  let effects = [];
  const react = {
    createElement(type, props, ...children) {
      return { type, props: props || {}, children: children.flat(Infinity).filter((child) => child != null && child !== false) };
    },
    useCallback(callback) {
      return callback;
    },
    useEffect(callback) {
      effects.push(callback);
    },
    useState(initialValue) {
      const index = hookIndex;
      hookIndex += 1;
      if (state.length <= index) {
        state[index] = typeof initialValue === "function" ? initialValue() : initialValue;
      }
      return [
        state[index],
        (nextValue) => {
          state[index] = typeof nextValue === "function" ? nextValue(state[index]) : nextValue;
        },
      ];
    },
  };
  const context = vm.createContext({
    __post: pagePost,
    __reactFactory: () => react,
    __toESM: (value) => value,
    console,
    globalThis: null,
    SettingsPage: function SettingsPage(props) {
      return props?.children || null;
    },
    window: {
      confirm() {
        return true;
      },
      ...windowOverrides,
    },
  });
  context.globalThis = context;
  vm.runInContext(buildSettingsVmSource(), context);
  function render() {
    hookIndex = 0;
    effects = [];
    const tree = context.AgentWorkspacesSettings();
    return { tree, effects: [...effects] };
  }
  return { render };
}

function nodeText(node) {
  if (typeof node === "string" || typeof node === "number") return String(node);
  if (!node || typeof node !== "object") return "";
  return (node.children || []).map(nodeText).join("");
}

function findNode(root, predicate) {
  const stack = [root];
  while (stack.length > 0) {
    const node = stack.shift();
    if (!node || typeof node !== "object") continue;
    if (predicate(node)) return node;
    stack.unshift(...(node.children || []));
  }
  return null;
}

function findButton(root, label) {
  return findNode(root, (node) => node.type === "button" && nodeText(node) === label);
}

function findInput(root, predicate) {
  return findNode(root, (node) => node.type === "input" && predicate(node));
}

test("agent-workspace feature stays disabled until listed in features.json", () => {
  withTempFeatureConfig([], (root) => {
    assert.deepEqual(enabledLinuxFeatureIds({ featuresRoot: root }), []);
    assert.deepEqual(loadLinuxFeaturePatchDescriptors({ featuresRoot: root }), []);
  });
});

test("agent-workspace feature exposes optional bridge, settings, resources, and prelaunch hook when enabled", () => {
  withTempFeatureConfig(["agent-workspace"], (root) => {
    assert.deepEqual(enabledLinuxFeatureIds({ featuresRoot: root }), ["agent-workspace"]);
    assert.deepEqual(
      loadLinuxFeaturePatchDescriptors({ featuresRoot: root }).map((patch) => [patch.name, patch.phase, patch.ciPolicy]),
      [
        ["feature:agent-workspace:main-bridge", "main-bundle", "optional"],
        ["feature:agent-workspace:settings-page", "extracted-app:post-webview", "optional"],
      ],
    );

    assert.deepEqual(enabledLinuxFeatureStageHooks({ featuresRoot: root }), []);

    const plan = enabledLinuxFeatureInstallPlan({ featuresRoot: root });
    assert.deepEqual(
      plan.resources.map((resource) => [
        resource.id,
        path.relative(root, resource.source),
        resource.target,
        resource.mode,
      ]),
      [[
        "agent-workspace",
        path.join("agent-workspace", "skills", "agent-workspace-linux", "SKILL.md"),
        ".codex-linux/features/agent-workspace/skills/agent-workspace-linux/SKILL.md",
        0o644,
      ]],
    );
    assert.deepEqual(
      plan.runtimeHooks.map((hook) => [
        hook.id,
        hook.key,
        path.relative(root, hook.source),
        hook.target,
        hook.mode,
      ]),
      [
        [
          "agent-workspace",
          "prelaunch",
          path.join("agent-workspace", "install-skill.sh"),
          ".codex-linux/prelaunch.d/agent-workspace-install-skill.sh",
          0o755,
        ],
      ],
    );
  });
});

test("agent-workspace prelaunch hook installs the staged bundled Codex skill only", () => {
  const featureDir = __dirname;
  const hook = path.join(featureDir, "install-skill.sh");
  const skillSource = path.join(featureDir, "skills", "agent-workspace-linux", "SKILL.md");
  const hookSource = fs.readFileSync(hook, "utf8");

  assert.doesNotMatch(hookSource, /config\.toml/);
  assert.doesNotMatch(hookSource, /codex-configure/);
  assert.match(fs.readFileSync(skillSource, "utf8"), /^name: agent-workspace-linux$/m);

  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "codex-agent-workspace-prelaunch-"));
  const codexHome = path.join(tempDir, "codex-home");
  const featuresDir = path.join(tempDir, "app", ".codex-linux", "features");
  const stagedSkill = path.join(featuresDir, "agent-workspace", "skills", "agent-workspace-linux", "SKILL.md");
  try {
    fs.mkdirSync(path.dirname(stagedSkill), { recursive: true });
    fs.copyFileSync(skillSource, stagedSkill);

    const result = spawnSync("bash", [hook], {
      cwd: path.resolve(featureDir, "../.."),
      encoding: "utf8",
      env: {
        ...process.env,
        CODEX_HOME: codexHome,
        CODEX_LINUX_FEATURES_DIR: featuresDir,
        HOME: "",
      },
    });

    assert.equal(result.status, 0, `${result.stderr}\n${result.stdout}`);
    assert.match(result.stderr, /Installed Agent Workspaces skill to /);

    const installedSkill = path.join(codexHome, "skills", "agent-workspace-linux", "SKILL.md");
    assert.equal(fs.readFileSync(installedSkill, "utf8"), fs.readFileSync(skillSource, "utf8"));
    assert.equal(fs.existsSync(path.join(codexHome, "config.toml")), false);

    const missingResult = spawnSync("bash", [hook], {
      cwd: path.resolve(featureDir, "../.."),
      encoding: "utf8",
      env: {
        ...process.env,
        CODEX_HOME: codexHome,
        CODEX_LINUX_FEATURES_DIR: path.join(tempDir, "missing-features"),
        HOME: "",
      },
    });
    assert.equal(missingResult.status, 0, `${missingResult.stderr}\n${missingResult.stdout}`);
    assert.match(missingResult.stderr, /WARN: Agent Workspaces skill source not found/);
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test("agent-workspace declarative staging copies skill and prelaunch hook into the app", () => {
  withTempFeatureConfig(["agent-workspace"], (featuresRoot) => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "codex-agent-workspace-stage-app-"));
    try {
      const appDir = path.join(tempDir, "codex-app");
      stageEnabledLinuxFeatureInstall(appDir, { featuresRoot });
      assert.equal(
        fs.readFileSync(
          path.join(appDir, ".codex-linux", "features", "agent-workspace", "skills", "agent-workspace-linux", "SKILL.md"),
          "utf8",
        ),
        fs.readFileSync(path.join(featuresRoot, "agent-workspace", "skills", "agent-workspace-linux", "SKILL.md"), "utf8"),
      );
      assert.equal(fs.existsSync(path.join(appDir, ".codex-linux", "env.d", "agent-workspace-pin-renderer.env")), false);
      const hookPath = path.join(appDir, ".codex-linux", "prelaunch.d", "agent-workspace-install-skill.sh");
      assert.match(fs.readFileSync(hookPath, "utf8"), /CODEX_LINUX_FEATURES_DIR/);
      assert.equal((fs.statSync(hookPath).mode & 0o777), 0o755);
    } finally {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });
});

test("main bridge patch captures explicit Node modules despite nearby require calls", () => {
  const quotedBundle = [
    "function distractors(){let __codexChild=require(`node:child_process`).spawn(`true`);let t=require('node:path').join(`a`,`b`);let n=require(\"node:fs\").existsSync(`a`)}",
    "let c=require(\"node:child_process\"),o=require('node:fs'),i=require(`node:path`);",
    "class Host{handlers(){return {",
    '"set-remote-wsl-connections-enabled":async()=>({})',
    "}}}",
  ].join("");
  const patched = applyAgentWorkspaceMainBridgePatch(quotedBundle);
  assert.match(patched, /"linux-agent-workspace":async/);
  assert.match(
    patched,
    /let __codexChildProcessModule=require\("node:child_process"\),__codexFsModule=require\("node:fs"\),__codexPathModule=require\("node:path"\);/,
  );
  assert.match(patched, /__codexPathModule\.join\(/);
  assert.match(patched, /__codexFsModule\.existsSync\(/);
  assert.match(patched, /execFile\(__codexCommand,__codexArgs/);
  assert.equal(applyAgentWorkspaceMainBridgePatch(patched), patched);
});

test("main bridge patch adds an allowlisted linux-agent-workspace handler", () => {
  const patched = applyAgentWorkspaceMainBridgePatch(syntheticMainBundle());
  assert.match(patched, /"linux-agent-workspace":async/);
  assert.match(patched, /"linux-agent-workspace-pick-app":async/);
  assert.match(patched, /"linux-agent-workspace-pick-project":async/);
  assert.doesNotMatch(patched, /linux-agent-workspace-pick-mount/);
  assert.doesNotMatch(patched, /Choose file or folder to mount/);
  assert.match(patched, /"linux-agent-workspace-pick-browser-data":async/);
  assert.match(patched, /"linux-agent-workspace-copy-browser-data":async/);
  assert.match(patched, /showOpenDialog/);
  // agent-workspace-linux 0.6.0 removed the sandbox: no unenforced-policy ack, network or mount ceilings.
  assert.doesNotMatch(patched, /ack-unenforced-policy/);
  assert.doesNotMatch(patched, /AckUnenforcedPolicy/);
  assert.doesNotMatch(patched, /inherit_host|local_only|allow_hosts/);
  assert.doesNotMatch(patched, /\.mounts|host_path|workspace_path/);
  assert.match(patched, /Desktop Entry/);
  assert.match(patched, /startup_app/);
  assert.match(patched, /desktop_file/);
  assert.match(patched, /browser-sessions/);
  assert.match(patched, /SingletonLock/);
  assert.match(patched, new RegExp(SETTINGS_COMMAND_KEY));
  assert.match(patched, new RegExp(SETTINGS_PERMISSIONS_KEY));
  assert.match(patched, /\.local`\,`bin`\,`agent-workspace-linux`/);
  assert.match(patched, /CODEX_AGENT_WORKSPACE_BIN/);
  // Binary resolution prefers already-present global binaries before ad-hoc local fallbacks.
  assert.match(patched, /CARGO_HOME/);
  assert.match(patched, /\.cargo/);
  assert.match(patched, /NPM_CONFIG_PREFIX/);
  assert.match(patched, /\.npm-global/);
  assert.match(patched, /\.local`\,`share`\,`npm/);
  assert.match(patched, /process\.env\.PATH/);
  assert.match(patched, /split\(.+\.delimiter\)/);
  assert.match(patched, /\/usr\/local\/bin\/agent-workspace-linux/);
  assert.match(patched, /\/usr\/local\/lib\/node_modules\/@agent-sh\/agent-workspace-linux\/bin\/agent-workspace-linux\.js/);
  assert.match(patched, /startsWith\(`~\/`\)/);
  assert.match(patched, /case`installRuntime`/);
  assert.match(patched, /@agent-sh\/agent-workspace-linux/);
  assert.match(patched, /--prefix/);
  assert.match(patched, /\.local/);
  assert.doesNotMatch(patched, /\[`install`,`--force`,`agent-workspace-linux`\]/);
  assert.match(patched, /case`permissionConfig`/);
  assert.match(patched, /case`permissionSave`/);
  assert.match(patched, /codex-agent-workspace-permissions\.json/);
  assert.doesNotMatch(patched, /case`mcpConfig`/);
  assert.doesNotMatch(patched, /config\.toml/);
  assert.doesNotMatch(patched, /mcp_servers/);
  assert.match(patched, /--permissions/);
  assert.match(patched, /__codexPermissionConfig\?\.permissions_path/);
  assert.match(patched, /case`profileValidate`/);
  assert.match(patched, /\[`profile`,`validate`,`--json`,__codexTempPath\]/);
  assert.match(patched, /case`profileTemplate`/);
  assert.match(patched, /--browser-path/);
  assert.match(patched, /--user-data-dir/);
  assert.match(patched, /case`workspaceOpenProfile`/);
  assert.match(patched, /case`workspaceOpenViewer`/);
  assert.match(patched, /--always-on-top/);
  assert.match(patched, /--exit-when-workspace-gone/);
  assert.match(patched, /spawn\(__codexCommand,__codexArgs/);
  assert.match(patched, /detached:!0/);
  assert.match(patched, /stdio:`ignore`/);
  assert.match(patched, /unref\?\.\(\)/);
  assert.match(patched, /case`workspaceStart`/);
  assert.doesNotMatch(patched, /case`workspaceObserve`/);
  assert.doesNotMatch(patched, /--include-hidden/);
  assert.doesNotMatch(patched, /__codexAttachScreenshot/);
  assert.doesNotMatch(patched, /data:image\/png;base64/);
  assert.match(patched, /execFile\(__codexCommand,__codexArgs/);
  assert.equal(applyAgentWorkspaceMainBridgePatch(patched), patched);
  const stalePatched = patched.replace(
    '"linux-agent-workspace-copy-browser-data":async',
    '"linux-agent-workspace-copy-browser-data-old":async',
  );
  assert.match(applyAgentWorkspaceMainBridgePatch(stalePatched), /"linux-agent-workspace-copy-browser-data":async/);

  const { value, warnings } = captureWarns(() => applyAgentWorkspaceMainBridgePatch("real bundle"));
  assert.equal(value, "real bundle");
  assert.match(warnings.join("\n"), /Could not find global-state handler insertion point/);
});

test("main bridge limits global-state access to agent workspace settings", async () => {
  const values = new Map([[SETTINGS_COMMAND_KEY, "/opt/agent-workspace-linux"]]);
  let reads = 0;
  let writes = 0;
  const globalState = {
    get(key) {
      reads += 1;
      return values.get(key);
    },
    set(key, value) {
      writes += 1;
      values.set(key, value);
    },
  };
  const { handlers } = buildBridgeHarness({ globalState });
  assert.deepEqual(
    JSON.parse(JSON.stringify(await handlers["get-global-state"]({ params: { key: SETTINGS_COMMAND_KEY } }))),
    { value: "/opt/agent-workspace-linux" },
  );
  assert.deepEqual(
    JSON.parse(JSON.stringify(await handlers["set-global-state"]({ params: { key: SETTINGS_PERMISSIONS_KEY, value: "/permissions.json" } }))),
    { success: true },
  );
  assert.equal(reads, 1);
  assert.equal(writes, 1);
  await assert.rejects(handlers["get-global-state"]({ params: { key: "setting" } }), /Unsupported global-state key/);
  await assert.rejects(handlers["set-global-state"]({ params: { key: "setting", value: true } }), /Unsupported global-state key/);
  assert.equal(reads, 1);
  assert.equal(writes, 1);
  assert.equal(values.has("setting"), false);
});

test("main bridge generator does not carry removed conversation monitor observe code", () => {
  const patchSource = fs.readFileSync(path.join(__dirname, "patch.js"), "utf8");
  assert.doesNotMatch(patchSource, /case\\`workspaceObserve\\`/);
  assert.doesNotMatch(patchSource, /__codexAttachScreenshot/);
  assert.doesNotMatch(patchSource, /data:image\/png;base64/);
  assert.doesNotMatch(patchSource, /codexLinuxAgentWorkspaceConversationCleanup=cleanup/);
  assert.doesNotMatch(patchSource, /codex-linux-agent-workspace-panel/);
});

test("main bridge patch upgrades stale installed agent workspace handlers", () => {
  const retiredMountPicker =
    '"linux-agent-workspace-pick-mount":async()=>{let __codexElectron;try{__codexElectron=require(`electron`)}catch(e){return{ok:!1,action:`pickMount`,message:`file picker unavailable`}}try{let e=await __codexElectron.dialog.showOpenDialog({title:`Choose file or folder to mount`,properties:[`openFile`,`openDirectory`,`multiSelections`]});let t=Array.isArray(e.filePaths)?e.filePaths:[];return{ok:!e.canceled&&t.length>0,action:`pickMount`,json:{canceled:!!e.canceled,path:t[0]||null,paths:t}}}catch(e){return{ok:!1,action:`pickMount`,message:e instanceof Error?e.message:String(e)}}},';
  const legacyHandler = [
    '"linux-agent-workspace-copy-browser-data":async()=>({ok:true,action:`copyBrowserData`}),',
    retiredMountPicker,
    '"linux-agent-workspace":async({action:__codexAction}={})=>{let __codexActionName=__codexAction;',
    'try{switch(__codexActionName){case`profileList`:return{ok:true,json:{profiles:[]}};',
    'case`workspaceList`:return{ok:true,json:{workspaces:[]}};',
    'default:throw Error(`unsupported agent workspace action`)}}',
    'catch(e){return{ok:false,action:__codexActionName,message:e instanceof Error?e.message:String(e)}}},',
  ].join("");
  const legacy = syntheticMainBundle().replace(
    '"set-remote-wsl-connections-enabled":',
    `${legacyHandler}"set-remote-wsl-connections-enabled":`,
  );

  assert.match(legacy, /"linux-agent-workspace-pick-mount":async/);

  const upgraded = applyAgentWorkspaceMainBridgePatch(legacy);
  assert.doesNotMatch(upgraded, /linux-agent-workspace-pick-mount|pickMount|Choose file or folder to mount/);
  assert.doesNotThrow(() => new vm.Script(upgraded), "upgraded bundle must stay valid JavaScript");
  assert.match(upgraded, /"linux-agent-workspace-pick-app":async/);
  assert.match(upgraded, /"linux-agent-workspace-pick-project":async/);
  assert.match(upgraded, /"linux-agent-workspace-pick-browser-data":async/);
  assert.match(upgraded, /"linux-agent-workspace-copy-browser-data":async/);
  assert.match(upgraded, /case`permissionConfig`/);
  assert.match(upgraded, /case`installRuntime`/);
  assert.match(upgraded, /__codexPermissionConfig/);
  assert.doesNotMatch(upgraded, /case`mcpConfig`/);
  assert.doesNotMatch(upgraded, /config\.toml/);
  assert.match(upgraded, /case`workspaceOpenViewer`/);
  assert.match(upgraded, /case`workspaceStart`/);
  assert.match(upgraded, /case`profileTemplate`/);
  assert.doesNotMatch(upgraded, /case`profileList`:return\{ok:true,json:\{profiles:\[\]\}\}/);
  assert.equal(applyAgentWorkspaceMainBridgePatch(upgraded), upgraded);

  const retiredLast = syntheticMainBundle().replace(
    '"set-remote-wsl-connections-enabled":async()=>({})',
    `"set-remote-wsl-connections-enabled":async()=>({}),${legacyHandler.replace(retiredMountPicker, "")}${retiredMountPicker.slice(0, -1)}`,
  );
  const upgradedLast = applyAgentWorkspaceMainBridgePatch(retiredLast);
  assert.doesNotMatch(upgradedLast, /linux-agent-workspace-pick-mount/);
  assert.doesNotThrow(() => new vm.Script(upgradedLast), "removing a trailing retired entry must keep valid JavaScript");
  assert.equal(applyAgentWorkspaceMainBridgePatch(upgradedLast), upgradedLast);
});

test("app picker converts desktop launchers into startup app commands", async () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "codex-agent-workspace-desktop-app-"));
  try {
    const desktopPath = path.join(tempDir, "canva.desktop");
    fs.writeFileSync(
      desktopPath,
      [
        "[Desktop Entry]",
        "Name=Canva",
        'Exec="/opt/Canva/canva" --new-window %U',
        "Type=Application",
        "",
      ].join("\n"),
    );

    const { handlers } = buildBridgeHarness({
      electron: {
        dialog: {
          showOpenDialog: async () => ({ canceled: false, filePaths: [desktopPath] }),
        },
      },
    });

    const response = await handlers["linux-agent-workspace-pick-app"]();
    assert.equal(response.ok, true);
    assert.equal(response.json.desktop, true);
    assert.equal(response.json.startup_app.name, "Canva");
    assert.equal(response.json.startup_app.desktop_file, desktopPath);
    assert.deepEqual(Array.from(response.json.startup_app.command), ["/opt/Canva/canva", "--new-window"]);
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test("browser data copy bridge creates a managed copy without lock files", async () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "codex-agent-workspace-browser-copy-"));
  try {
    const home = path.join(tempDir, "home");
    const source = path.join(tempDir, "chrome-user-data");
    fs.mkdirSync(path.join(source, "Default"), { recursive: true });
    fs.writeFileSync(path.join(source, "Default", "Cookies"), "cookie-db");
    fs.writeFileSync(path.join(source, "SingletonLock"), "lock");

    const { handlers } = buildBridgeHarness({
      env: {
        HOME: home,
        XDG_DATA_HOME: path.join(tempDir, "data"),
      },
    });

    const response = await handlers["linux-agent-workspace-copy-browser-data"]({
      sourcePath: source,
      profileId: "Browser Session!",
    });

    assert.equal(response.ok, true);
    assert.equal(response.action, "copyBrowserData");
    assert.match(response.json.path, /browser-sessions\/browser-session/);
    assert.equal(fs.readFileSync(path.join(response.json.path, "Default", "Cookies"), "utf8"), "cookie-db");
    assert.equal(fs.existsSync(path.join(response.json.path, "SingletonLock")), false);
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test("main bridge resolves existing global binaries before local fallbacks", async () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "codex-agent-workspace-resolve-"));
  try {
    const cargoHome = path.join(tempDir, "cargo-home");
    const npmPrefix = path.join(tempDir, "npm-prefix");
    const pathBin = path.join(tempDir, "path-bin");
    const home = path.join(tempDir, "home");
    const cargoBin = path.join(cargoHome, "bin", "agent-workspace-linux");
    const npmBin = path.join(npmPrefix, "bin", "agent-workspace-linux");
    const pathCandidate = path.join(pathBin, "agent-workspace-linux");
    const localCandidate = path.join(home, ".local", "bin", "agent-workspace-linux");
    for (const candidate of [cargoBin, npmBin, pathCandidate, localCandidate]) {
      fs.mkdirSync(path.dirname(candidate), { recursive: true });
      fs.writeFileSync(candidate, "#!/bin/sh\n", { mode: 0o755 });
    }
    const { handlers, execCalls } = buildBridgeHarness({
      env: { CARGO_HOME: cargoHome, NPM_CONFIG_PREFIX: npmPrefix, HOME: home, PATH: pathBin },
    });
    await handlers["linux-agent-workspace"]({ action: "doctor" });
    assert.equal(execCalls[0].command, cargoBin);
    assert.deepEqual(JSON.parse(JSON.stringify(execCalls[0].args)), ["doctor"]);
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test("main bridge install action uses fixed npm package command", async () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "codex-agent-workspace-npm-install-"));
  const { handlers, execCalls } = buildBridgeHarness({
    env: {
      HOME: path.join(tempDir, "home"),
    },
    execFile(command, args, options, callback) {
      execCalls.push({ command, args, options });
      callback(null, "installed\n", "");
    },
  });

  try {
    const npm = await handlers["linux-agent-workspace"]({ action: "installRuntime" });
    assert.equal(npm.ok, true);
    assert.equal(path.basename(execCalls[0].command), "npm");
    assert.deepEqual(
      JSON.parse(JSON.stringify(execCalls[0].args)),
      ["install", "-g", "--prefix", path.join(tempDir, "home", ".local"), "@agent-sh/agent-workspace-linux@>=0.6.0"],
    );
    assert.equal(execCalls[0].options.timeout, 300000);
    assert.equal(execCalls.length, 1);
    assert.equal(npm.json.command, path.join(tempDir, "home", ".local", "bin", "agent-workspace-linux"));
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test("main bridge install action expands tilde npm prefix", async () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "codex-agent-workspace-npm-prefix-"));
  const home = path.join(tempDir, "home");
  const { handlers, execCalls } = buildBridgeHarness({
    env: {
      HOME: home,
      NPM_CONFIG_PREFIX: "~/npm-prefix",
    },
    execFile(command, args, options, callback) {
      execCalls.push({ command, args, options });
      callback(null, "installed\n", "");
    },
  });

  try {
    const npm = await handlers["linux-agent-workspace"]({ action: "installRuntime" });
    assert.equal(npm.ok, true);
    assert.deepEqual(
      JSON.parse(JSON.stringify(execCalls[0].args)),
      ["install", "-g", "--prefix", path.join(home, "npm-prefix"), "@agent-sh/agent-workspace-linux@>=0.6.0"],
    );
    assert.equal(npm.json.command, path.join(home, "npm-prefix", "bin", "agent-workspace-linux"));
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test("main bridge reads page-owned permission file and applies it to CLI calls", async () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "codex-agent-workspace-page-permissions-"));
  try {
    const permissionsPath = path.join(tempDir, "permissions.json");
    fs.writeFileSync(permissionsPath, JSON.stringify({ apps: { allow: ["sh"] } }, null, 2));

    const { handlers, execCalls, spawnCalls } = buildBridgeHarness({
      env: {
        CODEX_AGENT_WORKSPACE_BIN: "/tmp/agent-workspace-linux",
      },
      globalState: new Map([[SETTINGS_PERMISSIONS_KEY, permissionsPath]]),
    });

    const config = await handlers["linux-agent-workspace"]({ action: "permissionConfig" });
    assert.equal(config.ok, true);
    assert.equal(config.json.configured, true);
    assert.equal(config.json.restricted, true);
    assert.equal(config.json.permissions_path, permissionsPath);
    assert.deepEqual(JSON.parse(JSON.stringify(config.json.ceiling)), { apps: { allow: ["sh"] } });

    const response = await handlers["linux-agent-workspace"]({ action: "profileList" });
    assert.equal(response.ok, true);
    assert.deepEqual(Array.from(execCalls[0].args.slice(0, 4)), ["--permissions", permissionsPath, "profile", "list"]);

    const template = await handlers["linux-agent-workspace"]({
      action: "profileTemplate",
      templateKind: "browser-session",
      profileId: "browser-session",
      browserPath: "/usr/bin/google-chrome",
      userDataDir: "/tmp/browser-profile",
    });
    assert.equal(template.ok, true);
    assert.deepEqual(Array.from(execCalls[1].args.slice(0, 5)), [
      "--permissions",
      permissionsPath,
      "profile",
      "template",
      "browser-session",
    ]);
    assert.match(execCalls[1].args.join("\n"), /--user-data-dir\n\/tmp\/browser-profile/);

    const viewer = await handlers["linux-agent-workspace"]({
      action: "workspaceOpenViewer",
      workspaceId: "default",
      alwaysOnTop: true,
    });
    assert.equal(viewer.ok, true);
    assert.equal(viewer.json.id, "default");
    assert.equal(viewer.json.pid, 4242);
    assert.equal(viewer.json.always_on_top, true);
    assert.equal(viewer.json.exit_when_workspace_gone, true);
    assert.equal(spawnCalls.length, 1);
    assert.deepEqual(Array.from(spawnCalls[0].args.slice(0, 5)), [
      "--permissions",
      permissionsPath,
      "viewer",
      "--id",
      "default",
    ]);
    assert.match(spawnCalls[0].args.join("\n"), /--exit-when-workspace-gone/);
    assert.match(spawnCalls[0].args.join("\n"), /--always-on-top/);
    assert.equal(spawnCalls[0].options.detached, true);
    assert.equal(spawnCalls[0].options.stdio, "ignore");
    assert.equal(spawnCalls[0].unref, true);
    assert.equal(execCalls.length, 2);
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test("main bridge reports page-owned permission file failures before spawning", async () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "codex-agent-workspace-missing-permissions-"));
  try {
    const missingPath = path.join(tempDir, "permissions.json");
    const { handlers, execCalls, spawnCalls } = buildBridgeHarness({
      env: {
        CODEX_AGENT_WORKSPACE_BIN: "/tmp/agent-workspace-linux",
      },
      globalState: new Map([[SETTINGS_PERMISSIONS_KEY, missingPath]]),
    });

    const config = await handlers["linux-agent-workspace"]({ action: "permissionConfig" });
    assert.equal(config.ok, false);
    assert.equal(config.json.configured, true);
    assert.equal(config.json.permissions_path, missingPath);
    assert.equal(config.json.error, "permission file does not exist");

    const response = await handlers["linux-agent-workspace"]({ action: "profileList" });
    assert.equal(response.ok, false);
    assert.match(response.message, /Workspace permission file could not be loaded/);
    assert.equal(execCalls.length, 0);
    assert.equal(spawnCalls.length, 0);
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test("main bridge treats a legacy network or mount ceiling as open", async () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "codex-agent-workspace-legacy-permissions-"));
  try {
    const permissionsPath = path.join(tempDir, "permissions.json");
    fs.writeFileSync(
      permissionsPath,
      JSON.stringify({
        network: { mode: "disabled" },
        mounts: [{ host_path: tempDir, workspace_path: "/workspace/legacy", mode: "read_only" }],
        apps: { allow: [] },
      }),
    );
    const { handlers } = buildBridgeHarness({
      env: { CODEX_AGENT_WORKSPACE_BIN: "/tmp/agent-workspace-linux" },
      globalState: new Map([[SETTINGS_PERMISSIONS_KEY, permissionsPath]]),
    });

    const config = await handlers["linux-agent-workspace"]({ action: "permissionConfig" });
    assert.equal(config.ok, true);
    assert.equal(config.json.configured, true);
    assert.equal(config.json.restricted, false);
    assert.match(config.json.message, /configured but open/);
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test("main bridge saves page-authored permission rules as an apps-only ceiling", async () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "codex-agent-workspace-save-permissions-"));
  try {
    const dataHome = path.join(tempDir, "data");
    const globalState = new Map();
    const { handlers, execCalls } = buildBridgeHarness({
      env: {
        XDG_DATA_HOME: dataHome,
        CODEX_AGENT_WORKSPACE_BIN: "/tmp/agent-workspace-linux",
      },
      globalState,
    });
    const permissions = {
      network: { mode: "local_only", allow_hosts: ["localhost:3000"] },
      mounts: [{ host_path: tempDir, workspace_path: "/workspace/save-permissions", mode: "read_only" }],
      apps: { allow: ["/usr/bin/google-chrome"] },
    };

    const saved = await handlers["linux-agent-workspace"]({ action: "permissionSave", permissions });
    assert.equal(saved.ok, true);
    assert.equal(saved.json.configured, true);
    assert.equal(saved.json.restricted, true);
    assert.deepEqual(JSON.parse(JSON.stringify(saved.json.ceiling)), { apps: { allow: ["/usr/bin/google-chrome"] } });

    const savedPath = globalState.get(SETTINGS_PERMISSIONS_KEY);
    assert.equal(saved.json.permissions_path, savedPath);
    assert.match(savedPath, /agent-workspace-linux\/permissions\/codex-agent-workspace-permissions\.json$/);
    assert.deepEqual(JSON.parse(fs.readFileSync(savedPath, "utf8")), { apps: { allow: ["/usr/bin/google-chrome"] } });

    const profiles = await handlers["linux-agent-workspace"]({ action: "profileList" });
    assert.equal(profiles.ok, true);
    assert.deepEqual(Array.from(execCalls[0].args.slice(0, 4)), ["--permissions", savedPath, "profile", "list"]);

    const open = await handlers["linux-agent-workspace"]({ action: "permissionSave", permissions: {} });
    assert.equal(open.ok, true);
    assert.equal(open.json.restricted, false);
    assert.deepEqual(JSON.parse(fs.readFileSync(savedPath, "utf8")), { apps: { allow: [] } });

    for (const [bad, message] of [
      [{ apps: [] }, /permission apps must be an object/],
      [{ apps: { allow: "/usr/bin/xterm" } }, /permission app allow must be a list/],
      [{ apps: { allow: [""] } }, /non-empty strings/],
      [{ apps: { allow: ["bin/xterm"] } }, /absolute paths or bare command names/],
    ]) {
      const rejected = await handlers["linux-agent-workspace"]({ action: "permissionSave", permissions: bad });
      assert.equal(rejected.ok, false);
      assert.match(rejected.message, message);
    }
    assert.deepEqual(JSON.parse(fs.readFileSync(savedPath, "utf8")), { apps: { allow: [] } });
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test("main bridge start and open-profile never pass the removed unenforced-policy flag", async () => {
  const { handlers, execCalls } = buildBridgeHarness({
    env: { CODEX_AGENT_WORKSPACE_BIN: "/tmp/agent-workspace-linux" },
  });
  const legacyAck = { ackHiddenWorkspace: true, ackUnenforcedPolicy: true, acknowledgeUnenforcedPolicy: true };

  await handlers["linux-agent-workspace"]({ action: "workspaceStart", dryRun: true, profileId: "qa", workspaceId: "qa-live" });
  await handlers["linux-agent-workspace"]({ action: "workspaceStart", profileId: "qa", workspaceId: "qa-live", ...legacyAck });
  await handlers["linux-agent-workspace"]({ action: "workspaceOpenProfile", dryRun: true, profileId: "qa", runSetup: true });
  await handlers["linux-agent-workspace"]({ action: "workspaceOpenProfile", profileId: "qa", runSetup: true, ...legacyAck });

  const args = execCalls.map((call) => Array.from(call.args));
  assert.deepEqual(args, [
    ["workspace", "start", "--dry-run", "--profile", "qa", "--id", "qa-live"],
    ["workspace", "start", "--ack-hidden-workspace", "--profile", "qa", "--id", "qa-live"],
    ["workspace", "open-profile", "--dry-run", "--profile", "qa", "--setup"],
    ["workspace", "open-profile", "--ack-hidden-workspace", "--profile", "qa", "--setup"],
  ]);
});

test("main bridge opens viewer in clean default mode without adding a ceiling or topmost state", async () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "codex-agent-workspace-clean-viewer-"));
  try {
    const { handlers, execCalls, spawnCalls } = buildBridgeHarness({
      env: {
        CODEX_AGENT_WORKSPACE_BIN: "/tmp/agent-workspace-linux",
      },
    });

    const config = await handlers["linux-agent-workspace"]({ action: "permissionConfig" });
    assert.equal(config.ok, true);
    assert.equal(config.json.configured, false);
    assert.equal(config.json.restricted, false);
    assert.equal(config.json.permissions_path, null);
    assert.match(config.json.message, /No workspace permission file configured/);

    const profiles = await handlers["linux-agent-workspace"]({ action: "profileList" });
    assert.equal(profiles.ok, true);
    assert.equal(execCalls.length, 1);
    assert.deepEqual(Array.from(execCalls[0].args), ["profile", "list"]);

    const viewer = await handlers["linux-agent-workspace"]({
      action: "workspaceOpenViewer",
      workspaceId: "qa-live",
    });
    assert.equal(viewer.ok, true);
    assert.equal(viewer.json.id, "qa-live");
    assert.equal(viewer.json.always_on_top, false);
    assert.equal(viewer.json.exit_when_workspace_gone, true);
    assert.equal(execCalls.length, 1);
    assert.equal(spawnCalls.length, 1);
    assert.deepEqual(Array.from(spawnCalls[0].args), ["viewer", "--id", "qa-live", "--exit-when-workspace-gone"]);
    assert.equal(spawnCalls[0].options.detached, true);
    assert.equal(spawnCalls[0].options.stdio, "ignore");
    assert.equal(spawnCalls[0].unref, true);
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test("main bridge reports detached viewer spawn errors without exec fallback", async () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "codex-agent-workspace-viewer-error-"));
  const calls = [];
  try {
    const { handlers, execCalls } = buildBridgeHarness({
      env: {
        CODEX_HOME: path.join(tempDir, "codex-home"),
        CODEX_AGENT_WORKSPACE_BIN: "/tmp/missing-agent-workspace-linux",
      },
      spawn(command, args, options) {
        const call = { command, args, options, unref: false };
        calls.push(call);
        return {
          pid: null,
          once(event, callback) {
            if (event === "error") {
              process.nextTick(() => callback(new Error("spawn ENOENT")));
            }
            return this;
          },
          unref() {
            call.unref = true;
          },
        };
      },
    });

    const viewer = await handlers["linux-agent-workspace"]({
      action: "workspaceOpenViewer",
      workspaceId: "qa-live",
    });
    assert.equal(viewer.ok, false);
    assert.equal(viewer.action, "workspaceOpenViewer");
    assert.match(viewer.message, /spawn ENOENT/);
    assert.equal(execCalls.length, 0);
    assert.equal(calls.length, 1);
    assert.deepEqual(Array.from(calls[0].args), ["viewer", "--id", "qa-live", "--exit-when-workspace-gone"]);
    assert.equal(calls[0].unref, false);
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test("manual startup argv parser preserves explicit argv tokens", () => {
  const context = vm.createContext({
    __post: async () => ({}),
    __reactFactory: () => ({ createElement() {} }),
    __toESM: (value) => value,
    SettingsPage: function SettingsPage() {},
    globalThis: null,
  });
  context.globalThis = context;
  vm.runInContext(buildSettingsVmSource(), context);

  assert.deepEqual(Array.from(context.__commandArgv('firefox --new-window \"https://example.test/a b\"')), [
    "firefox",
    "--new-window",
    "https://example.test/a b",
  ]);
  assert.deepEqual(Array.from(context.__commandArgv('printf \"\" \"a b\"')), ["printf", "", "a b"]);
  assert.throws(() => context.__startupAppFromManual('"" --flag'), /program is required/);
  assert.throws(() => context.__commandArgv('firefox "unterminated'), /unterminated quote/);
});

test("generated agent workspace settings module is valid ESM syntax", () => {
  const source = buildAgentWorkspaceSettingsSource({
    chunkAsset: "chunk-test.js",
    reactAsset: "runtime-test.js",
    reactExportName: "r",
    settingsPageAsset: "settings-page-test.js",
    settingsPageExportName: "t",
    codexRequestAsset: "setting-storage-test.js",
    codexRequestExportName: "l",
  });
  const check = spawnSync(process.execPath, ["--input-type=module", "--check"], {
    encoding: "utf8",
    input: source,
  });
  assert.equal(check.status, 0, check.stderr || check.stdout);
  assert.match(source, /export\{AgentWorkspacesSettings,AgentWorkspacesSettings as default\}/);
  assert.match(source, /function resultSummary/);
  assert.match(source, /function permissionConfigView/);
  assert.match(source, /function permissionsPathFromArgs/);
  assert.match(source, /function permissionConfigFromResponses/);
  assert.match(source, /function defaultPermissions/);
  assert.match(source, /function normalizePermissions/);
  assert.match(source, /function commandArgv/);
  assert.match(source, /function startupAppFromManual/);
  assert.doesNotMatch(source, /\["sh","-lc",command\.trim\(\)\]/);
  assert.match(source, /function permissionsFromConfig/);
  assert.match(source, /function smokeResultFromResponses/);
  assert.match(source, /function approvalPreviewView/);
  assert.match(source, /function approvalBundleFromResponse/);
  assert.doesNotMatch(source, /function approvalAckParams/);
  assert.doesNotMatch(source, /unenforced/i);
  assert.match(source, /ackHiddenWorkspace:true/);
  assert.match(source, /Workspace permissions/);
  assert.match(source, /Permission file/);
  assert.match(source, /Permission rules/);
  assert.doesNotMatch(source, /Network ceiling/);
  assert.doesNotMatch(source, /Allowed file access/);
  assert.match(source, /Allowed apps/);
  assert.match(source, /Apps in a workspace run as you, with your files, network, keyring and SSH agent\./);
  assert.match(source, /The app allowlist limits what agents may launch\./);
  assert.doesNotMatch(source, /sandbox|isolat|enforc/i);
  assert.match(source, /Save permissions/);
  assert.match(source, /Apply/);
  assert.match(source, /Remove/);
  assert.match(source, /Reconnect/);
  assert.match(source, /Smoke test/);
  assert.match(source, /Checking workspace permissions/);
  assert.match(source, /No workspace permission file detected; Codex session permissions apply/);
  assert.match(source, /Codex session permissions apply after hidden-workspace approval\./);
  assert.match(source, /callAgentWorkspace\("permissionConfig"\)/);
  assert.match(source, /callAgentWorkspace\("permissionSave",\{permissions:permissionPolicy\}\)/);
  assert.match(source, /reconnected:true/);
  assert.match(source, /Permission file is active for workspace actions/);
  assert.match(source, /permissionConfig\?permissionConfigView\(permissionConfig\):null/);
  assert.doesNotMatch(source, /MCP permissions/);
  assert.doesNotMatch(source, /MCP locked/);
  assert.doesNotMatch(source, /MCP open/);
  assert.doesNotMatch(source, /Inspecting MCP permissions/);
  assert.doesNotMatch(source, /callAgentWorkspace\("mcpConfig"\)/);
  assert.doesNotMatch(source, /mcp-settings/);
  assert.match(source, /function responseOk/);
  assert.match(source, /function profileFromResponse/);
  assert.match(source, /function cleanupProcessActionCount/);
  assert.match(source, /process_cleanup/);
  assert.match(source, /process action/);
  assert.match(source, /function resultView\(result,open,setOpen\)/);
  assert.match(source, /function workspaceRunning/);
  assert.match(source, /function workspaceSummary/);
  assert.match(source, /function workspacePrimary/);
  assert.match(source, /function workspaceSecondary/);
  assert.match(source, /function statusDot/);
  assert.match(source, /startup_app/);
  for (const removed of [
    /function profileMountMode/,
    /function profileMounts/,
    /function addMountsFromPaths/,
    /function pickMount/,
    /function pickPermissionMount/,
    /function profileAllowHosts/,
    /function addNetworkHost/,
    /function addPermissionHost/,
    /function setNetworkMode/,
    /function setPermissionNetworkMode/,
    /NETWORK_MODE_OPTIONS/,
    /inherit_host|local_only|allow_hosts|require_enforced_policy/,
    /mounts|host_path|workspace_path|\/workspace\//,
    /linux-agent-workspace-pick-mount/,
    /Local hosts|Add host|Add file\/folder|File access|Read write/,
  ]) {
    assert.doesNotMatch(source, removed);
  }
  assert.match(source, /linux-agent-workspace-pick-project/);
  assert.match(source, /DEFAULT_COMMAND_LABEL="Auto-discovered agent-workspace-linux"/);
  assert.match(source, /Custom command/);
  assert.match(source, /function installRuntime\(\)/);
  assert.match(source, /callAgentWorkspace\("installRuntime",\{timeoutMs:300000\}\)/);
  assert.match(source, /Install from npm/);
  assert.doesNotMatch(source, new RegExp("Install with " + "Cargo"));
  assert.match(source, /Active workspace/);
  assert.match(source, /statusPill\("Active","active",true\)/);
  assert.match(source, /statusPill\("Idle","idle"\)/);
  assert.doesNotMatch(source, /statusDot\(mountMode/);
  assert.match(source, /Workspace control/);
  assert.match(source, /Connection/);
  assert.match(source, /Saved workspaces/);
  assert.match(source, /Workspace name/);
  assert.doesNotMatch(source, /Saved profiles/);
  assert.match(source, /Create new/);
  assert.match(source, /Project template/);
  assert.match(source, /Chrome template/);
  assert.match(source, /Browser session/);
  assert.match(source, /Prepare browser session/);
  assert.match(source, /Copy profile/);
  assert.match(source, /Use folder directly/);
  assert.match(source, /profile locks/);
  assert.match(source, /Runs Chrome directly on the selected folder\. Close the host browser first/);
  assert.doesNotMatch(source, /Mounts the selected folder/);
  assert.match(source, /Create from copy/);
  assert.match(source, /Create direct/);
  assert.match(source, /function createProjectProfile/);
  assert.match(source, /templateKind:"project-dev"/);
  assert.match(source, /function createChromeProfile/);
  assert.doesNotMatch(source, /createRestrictedChromeProfile/);
  assert.match(source, /function createBrowserSessionProfile/);
  assert.match(source, /function finishBrowserSessionProfile/);
  assert.match(source, /linux-agent-workspace-pick-browser-data/);
  assert.match(source, /linux-agent-workspace-copy-browser-data/);
  assert.match(source, /profileFromResponse\(response\)/);
  assert.match(source, /profileTemplate/);
  assert.match(source, /templateKind:"chrome"/);
  assert.doesNotMatch(source, /restricted-chrome|no-sandbox/);
  assert.match(source, /browser-session/);
  assert.match(source, /userDataDir/);
  assert.match(source, /Edit saved/);
  assert.match(source, /profileValidate/);
  assert.match(source, /Save changes/);
  assert.match(source, /Stop to edit/);
  assert.match(source, /profileFormLocked/);
  assert.match(source, /editingSaved/);
  assert.match(source, /advancedOpen/);
  assert.match(source, /resultOpen/);
  assert.match(source, /fixed inset-0 z-50 overflow-y-auto/);
  assert.match(source, /max-h-\[calc\(100vh-2rem\)\]/);
  assert.match(source, /resultView\(result,resultOpen,setResultOpen\)/);
  assert.doesNotMatch(source, /Overwrite/);
  assert.doesNotMatch(source, /Create profile/);
  assert.match(source, /Advanced settings/);
  assert.match(source, /Pick app/);
  assert.match(source, /Workspace status/);
  assert.match(source, /Hide status/);
  assert.match(source, /function openWorkspaceViewer/);
  assert.match(source, /workspaceOpenViewer/);
  assert.match(source, /function openWorkspaceViewer\(workspaceId\)\{\s*callAgentWorkspace\("workspaceOpenViewer",\{workspaceId:workspaceId\}\);\s*\}/);
  assert.match(source, /workspaceIdFromStartResponse/);
  assert.match(source, /viewer "\+\(viewerResponse\?\.ok===false\?"failed":"opened"\)/);
  assert.match(source, /Open Viewer/);
  assert.match(source, /aria-pressed/);
  assert.match(source, /Stopped workspaces \(/);
  assert.match(source, /var stoppedWorkspaces=workspaces\.filter/);
  assert.match(source, /stoppedWorkspaces\.map\(function\(workspace\)/);
  assert.match(source, /function startStoppedWorkspace/);
  assert.match(source, /function deleteStoppedWorkspace/);
  assert.match(source, /function startSavedWorkspace/);
  assert.match(source, /startSavedWorkspace\(savedProfile\)/);
  assert.match(source, /var pendingApprovalState=React\.useState\(null\)/);
  assert.match(source, /function requestStartApproval/);
  assert.match(source, /callAgentWorkspace\(action,\{\.\.\.params,dryRun:true\}\)/);
  assert.match(source, /Approve hidden workspace/);
  assert.match(source, /Approval required/);
  assert.match(source, /Codex wants to start an agent-controlled Linux workspace/);
  assert.match(source, /The native GPUI viewer opens after the workspace starts/);
  assert.match(source, /Approve and start/);
  assert.match(source, /approvalPreviewView\(pendingApproval,approvePendingStart/);
  assert.match(source, /workspaceStart/);
  assert.match(source, /Delete stale/);
  assert.doesNotMatch(source, /workspaceDisplay\(activeWorkspace\)/);
  assert.doesNotMatch(source, /workspaceDisplay\(workspace\)/);
  assert.match(source, /h\("details"/);
  assert.match(source, /function activeWorkspaceFromList/);
  assert.match(source, /var activeWorkspace=activeWorkspaceFromList\(workspaces\)/);
  assert.doesNotMatch(source, /workspace\.profile_id\|\|workspace\.purpose\|\|workspace\.status/);
  assert.doesNotMatch(source, /workspaces\.map\(function\(workspace\)/);
  assert.doesNotMatch(source, /Cleanup stale/);
  assert.doesNotMatch(source, /workspaceCleanup",\{dryRun:true\}/);
});

test("generated settings UI stores manual startup apps as argv without an implicit shell", async () => {
  const post = async (method, request = {}) => {
    const params = request.params || {};
    if (method === "get-global-state") return { value: "" };
    if (method !== "linux-agent-workspace") return { ok: true };
    if (params.action === "permissionConfig") {
      return {
        ok: true,
        json: {
          configured: false,
          restricted: false,
          permissions_path: null,
          message: "No workspace permission file configured",
        },
      };
    }
    if (params.action === "profileList") return { ok: true, json: { profiles: [] } };
    if (params.action === "workspaceList") return { ok: true, json: { workspaces: [] } };
    return { ok: true, action: params.action, json: { ok: true } };
  };

  const harness = createSettingsRenderHarness(post);
  const firstRender = harness.render();
  for (const effect of firstRender.effects) effect();
  await flushPromises();
  await flushPromises();

  let rendered = harness.render();
  const createButton = findButton(rendered.tree, "Create new");
  assert.ok(createButton, "Create new button should render");
  createButton.props.onClick();

  rendered = harness.render();
  const manualInput = findInput(
    rendered.tree,
    (node) => node.props.placeholder === "firefox --new-window",
  );
  assert.ok(manualInput, "Manual app command input should render");
  manualInput.props.onChange({ target: { value: 'firefox --new-window "https://example.test/a b"' } });

  rendered = harness.render();
  const addButton = findButton(rendered.tree, "Add manually");
  assert.ok(addButton, "Add manually button should render");
  assert.equal(addButton.props.disabled, false);
  addButton.props.onClick();

  rendered = harness.render();
  const text = nodeText(rendered.tree);
  assert.match(text, /firefox --new-window https:\/\/example\.test\/a b/);
  assert.doesNotMatch(text, /sh -lc/);
});

test("generated settings UI opens the GPUI viewer with the clean default action shape", async () => {
  const calls = [];
  const post = async (method, request = {}) => {
    const params = request.params || {};
    calls.push({ method, params });
    if (method === "get-global-state") return { value: "" };
    if (method !== "linux-agent-workspace") return { ok: true };
    if (params.action === "permissionConfig") {
      return {
        ok: true,
        json: {
          configured: false,
          restricted: false,
          permissions_path: null,
          message: "No workspace permission file configured",
        },
      };
    }
    if (params.action === "profileList") return { ok: true, json: { profiles: [] } };
    if (params.action === "workspaceList") {
      return {
        ok: true,
        json: {
          workspaces: [
            {
              id: "qa-live",
              running: true,
              status: {
                id: "qa-live",
                ready: true,
                purpose: "QA live view",
                apps: [],
              },
            },
          ],
        },
      };
    }
    if (params.action === "workspaceOpenViewer") {
      return {
        ok: true,
        json: {
          ok: true,
          id: params.workspaceId,
          always_on_top: !!params.alwaysOnTop,
        },
      };
    }
    return { ok: true, json: { ok: true } };
  };

  const harness = createSettingsRenderHarness(post);
  const firstRender = harness.render();
  for (const effect of firstRender.effects) effect();
  await flushPromises();
  await flushPromises();

  const { tree } = harness.render();
  const openViewerButton = findNode(
    tree,
    (node) => node.type === "button" && nodeText(node) === "Open Viewer",
  );
  assert.ok(openViewerButton, "Open Viewer button should render for the active workspace");
  assert.equal(openViewerButton.props.disabled, false);

  openViewerButton.props.onClick();
  await flushPromises();
  const viewerCall = calls.find((call) => call.params.action === "workspaceOpenViewer");
  assert.deepEqual(JSON.parse(JSON.stringify(viewerCall)), {
    method: "linux-agent-workspace",
    params: {
      action: "workspaceOpenViewer",
      workspaceId: "qa-live",
    },
  });
});

test("generated settings UI controls the page-owned permission file", async () => {
  const calls = [];
  const globalState = new Map();
  const post = async (method, request = {}) => {
    const params = request.params || {};
    calls.push({ method, params: { ...params } });
    if (method === "get-global-state") return { value: globalState.get(params.key) ?? "" };
    if (method === "set-global-state") {
      if (params.value == null) globalState.delete(params.key);
      else globalState.set(params.key, params.value);
      return { success: true };
    }
    if (method !== "linux-agent-workspace") return { ok: true };
    if (params.action === "permissionConfig") {
      const permissionsPath = globalState.get(SETTINGS_PERMISSIONS_KEY);
      return {
        ok: true,
        action: "permissionConfig",
        json: permissionsPath
          ? { configured: true, restricted: true, permissions_path: permissionsPath }
          : { configured: false, restricted: false, permissions_path: null },
      };
    }
    if (params.action === "profileList") return { ok: true, action: "profileList", json: { profiles: [] } };
    if (params.action === "workspaceList") return { ok: true, action: "workspaceList", json: { workspaces: [] } };
    if (params.action === "doctor") return { ok: true, action: "doctor", json: { ok: true } };
    return { ok: true, action: params.action, json: { ok: true } };
  };

  const harness = createSettingsRenderHarness(post);
  const firstRender = harness.render();
  for (const effect of firstRender.effects) effect();
  await flushPromises();
  await flushPromises();

  const permissionPath = "/tmp/agent-workspace-permissions.json";
  let rendered = harness.render();
  const permissionInput = findInput(
    rendered.tree,
    (node) => node.props.placeholder === "/path/to/agent-workspace-permissions.json",
  );
  assert.ok(permissionInput, "Permission file input should render on the Agent Workspaces page");
  permissionInput.props.onChange({ target: { value: permissionPath } });

  rendered = harness.render();
  const applyButton = findButton(rendered.tree, "Apply");
  assert.ok(applyButton, "Apply button should render next to the permission file input");
  assert.equal(applyButton.props.disabled, false);
  applyButton.props.onClick();
  await flushPromises();
  await flushPromises();
  await flushPromises();

  assert.equal(globalState.get(SETTINGS_PERMISSIONS_KEY), permissionPath);
  assert.ok(
    calls.some(
      (call) =>
        call.method === "set-global-state" &&
        call.params.key === SETTINGS_PERMISSIONS_KEY &&
        call.params.value === permissionPath,
    ),
    "Apply should store the permission path through app global state",
  );
  assert.ok(calls.some((call) => call.params.action === "doctor"), "Apply should reconnect via doctor");
  assert.ok(calls.some((call) => call.params.action === "permissionConfig"), "Apply should refresh permission state");
  rendered = harness.render();
  assert.match(nodeText(rendered.tree), new RegExp(permissionPath.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));

  const removeButton = findButton(rendered.tree, "Remove");
  assert.ok(removeButton, "Remove button should render next to the permission file input");
  assert.equal(removeButton.props.disabled, false);
  removeButton.props.onClick();
  await flushPromises();
  await flushPromises();
  await flushPromises();

  assert.equal(globalState.has(SETTINGS_PERMISSIONS_KEY), false);
  assert.ok(
    calls.some(
      (call) =>
        call.method === "set-global-state" &&
        call.params.key === SETTINGS_PERMISSIONS_KEY &&
        Object.prototype.hasOwnProperty.call(call.params, "value") &&
        call.params.value === undefined,
    ),
    "Remove should clear the permission path through app global state",
  );
  rendered = harness.render();
  assert.doesNotMatch(nodeText(rendered.tree), new RegExp(permissionPath.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
});

test("generated settings UI saves an apps-only permission file from page controls", async () => {
  const calls = [];
  const clone = (value) => JSON.parse(JSON.stringify(value ?? {}));
  const post = async (method, request = {}) => {
    const params = request.params || {};
    calls.push({ method, params: clone(params) });
    if (method === "get-global-state") return { value: "" };
    if (method !== "linux-agent-workspace") return { ok: true };
    if (params.action === "permissionConfig") {
      return {
        ok: true,
        action: "permissionConfig",
        json: {
          configured: true,
          restricted: false,
          permissions_path: "/tmp/legacy-permissions.json",
          ceiling: {
            network: { mode: "local_only", allow_hosts: ["localhost:3000"] },
            mounts: [{ host_path: "/srv/project", workspace_path: "/workspace/project", mode: "read_only" }],
            apps: { allow: ["/usr/bin/xterm"] },
          },
        },
      };
    }
    if (params.action === "permissionSave") {
      return {
        ok: true,
        action: "permissionSave",
        json: {
          configured: true,
          restricted: true,
          permissions_path: "/tmp/generated-permissions.json",
          ceiling: clone(params.permissions),
        },
      };
    }
    if (params.action === "profileList") return { ok: true, action: "profileList", json: { profiles: [] } };
    if (params.action === "workspaceList") return { ok: true, action: "workspaceList", json: { workspaces: [] } };
    if (params.action === "doctor") return { ok: true, action: "doctor", json: { ok: true } };
    return { ok: true, action: params.action, json: { ok: true } };
  };

  const harness = createSettingsRenderHarness(post);
  const firstRender = harness.render();
  for (const effect of firstRender.effects) effect();
  await flushPromises();
  await flushPromises();

  let rendered = harness.render();
  const text = nodeText(rendered.tree);
  assert.match(text, /Apps in a workspace run as you, with your files, network, keyring and SSH agent\./);
  assert.match(text, /The app allowlist limits what agents may launch\./);
  assert.doesNotMatch(text, /Network ceiling|Local host|Allowed file access|No file access|Read write/);
  assert.equal(findNode(rendered.tree, (node) => node.type === "select"), null, "no network selector");
  assert.equal(findButton(rendered.tree, "Add file/folder"), null, "no mount picker");
  assert.equal(findButton(rendered.tree, "Add host"), null, "no host entry");
  assert.match(text, /\/usr\/bin\/xterm/);
  assert.doesNotMatch(text, /\/srv\/project|localhost:3000/);

  const appInput = findInput(rendered.tree, (node) => node.props.placeholder === "/usr/bin/google-chrome");
  assert.ok(appInput, "Permission app input should render");
  appInput.props.onChange({ target: { value: "/usr/bin/google-chrome" } });

  rendered = harness.render();
  const addAppButton = findNode(
    rendered.tree,
    (node) => node.type === "button" && nodeText(node) === "Add app" && node.props.disabled === false,
  );
  assert.ok(addAppButton, "Add app button should enable after entering a command");
  addAppButton.props.onClick();

  rendered = harness.render();
  const saveButton = findButton(rendered.tree, "Save permissions");
  assert.ok(saveButton, "Save permissions button should render");
  assert.equal(saveButton.props.disabled, false);
  saveButton.props.onClick();
  await flushPromises();
  await flushPromises();
  await flushPromises();

  const saveCall = calls.find((call) => call.method === "linux-agent-workspace" && call.params.action === "permissionSave");
  assert.ok(saveCall, "Save should call the bridge permissionSave action");
  assert.deepEqual(saveCall.params.permissions, { apps: { allow: ["/usr/bin/xterm", "/usr/bin/google-chrome"] } });
  assert.ok(calls.some((call) => call.method === "linux-agent-workspace" && call.params.action === "doctor"));
});

test("generated settings UI writes profiles without network, mounts, or enforced-policy fields", async () => {
  const calls = [];
  const post = async (method, request = {}) => {
    const params = request.params || {};
    calls.push({ method, params: JSON.parse(JSON.stringify(params)) });
    if (method === "get-global-state") return { value: "" };
    if (method !== "linux-agent-workspace") return { ok: true };
    if (params.action === "permissionConfig") return { ok: true, json: { configured: false, restricted: false } };
    if (params.action === "profileList") return { ok: true, json: { profiles: [] } };
    if (params.action === "workspaceList") return { ok: true, json: { workspaces: [] } };
    return { ok: true, action: params.action, json: { ok: true } };
  };

  const harness = createSettingsRenderHarness(post);
  const firstRender = harness.render();
  for (const effect of firstRender.effects) effect();
  await flushPromises();
  await flushPromises();

  let rendered = harness.render();
  findButton(rendered.tree, "Create new").props.onClick();
  rendered = harness.render();
  const editorText = nodeText(rendered.tree);
  assert.doesNotMatch(editorText, /Network|File access|Add file\/folder|Local hosts|Read only/);
  assert.equal(findNode(rendered.tree, (node) => node.type === "select"), null, "profile editor has no network selector");
  const cwdInput = findInput(rendered.tree, (node) => node.props.placeholder === "/path/to/project");
  assert.ok(cwdInput, "Working folder takes a host path");
  assert.equal(cwdInput.props.value, "");

  findButton(rendered.tree, "Validate").props.onClick();
  findButton(rendered.tree, "Create").props.onClick();
  await flushPromises();

  for (const action of ["profileValidate", "profileSave"]) {
    const call = calls.find((entry) => entry.params.action === action);
    assert.ok(call, `${action} should be called`);
    const profile = call.params.profile;
    assert.equal(profile.id, "desktop-qa");
    for (const removed of ["network", "mounts", "require_enforced_policy", "cwd"]) {
      assert.equal(Object.prototype.hasOwnProperty.call(profile, removed), false, `${action} profile carries ${removed}`);
    }
  }
});

test("generated settings UI Chrome starter uses the chrome template", async () => {
  const calls = [];
  const post = async (method, request = {}) => {
    const params = request.params || {};
    calls.push({ method, params: { ...params } });
    if (method === "get-global-state") return { value: "" };
    if (method !== "linux-agent-workspace") return { ok: true };
    if (params.action === "permissionConfig") return { ok: true, json: { configured: false, restricted: false } };
    if (params.action === "profileList") return { ok: true, json: { profiles: [{ id: "chrome" }] } };
    if (params.action === "workspaceList") return { ok: true, json: { workspaces: [] } };
    if (params.action === "profileTemplate") {
      return { ok: true, json: { id: params.profileId, startup_apps: [{ name: "chrome", command: ["google-chrome"] }] } };
    }
    return { ok: true, action: params.action, json: { ok: true } };
  };

  const harness = createSettingsRenderHarness(post);
  const firstRender = harness.render();
  for (const effect of firstRender.effects) effect();
  await flushPromises();
  await flushPromises();

  const rendered = harness.render();
  const chromeButton = findButton(rendered.tree, "Chrome template");
  assert.ok(chromeButton, "Chrome template button should render");
  await chromeButton.props.onClick();
  await flushPromises();

  const templateCalls = calls.filter((call) => call.params.action === "profileTemplate");
  assert.deepEqual(templateCalls.map((call) => call.params), [
    { action: "profileTemplate", templateKind: "chrome", profileId: "chrome-2" },
  ]);
  const editor = harness.render().tree;
  const nameInput = findInput(editor, (node) => node.props.placeholder === "desktop-qa");
  assert.ok(nameInput, "the profile editor should open with the chrome template");
  assert.equal(nameInput.props.value, "chrome-2");
  assert.ok(findButton(editor, "Validate"), "the open editor shows its Validate action");
});

test("generated settings UI project starter picks a host folder for the project-dev template", async () => {
  const calls = [];
  const projectDir = "/home/me/src/My Project";
  const post = async (method, request = {}) => {
    const params = request.params || {};
    calls.push({ method, params: { ...params } });
    if (method === "get-global-state") return { value: "" };
    if (method === "linux-agent-workspace-pick-project") {
      return { ok: true, action: "pickProject", json: { canceled: false, path: projectDir, paths: [projectDir] } };
    }
    if (method !== "linux-agent-workspace") return { ok: true };
    if (params.action === "permissionConfig") return { ok: true, json: { configured: false, restricted: false } };
    if (params.action === "profileList") return { ok: true, json: { profiles: [] } };
    if (params.action === "workspaceList") return { ok: true, json: { workspaces: [] } };
    if (params.action === "profileTemplate") return { ok: true, json: { id: params.profileId, cwd: params.hostPath } };
    return { ok: true, action: params.action, json: { ok: true } };
  };

  const harness = createSettingsRenderHarness(post);
  const firstRender = harness.render();
  for (const effect of firstRender.effects) effect();
  await flushPromises();
  await flushPromises();

  await findButton(harness.render().tree, "Project template").props.onClick();
  await flushPromises();

  assert.ok(calls.some((call) => call.method === "linux-agent-workspace-pick-project"));
  assert.equal(calls.some((call) => call.method === "linux-agent-workspace-pick-mount"), false);
  const templateCall = calls.find((call) => call.params.action === "profileTemplate");
  assert.deepEqual(templateCall.params, {
    action: "profileTemplate",
    templateKind: "project-dev",
    profileId: "my-project",
    hostPath: projectDir,
  });
});

test("generated settings UI browser session direct use runs Chrome on the chosen folder", async () => {
  const calls = [];
  const confirms = [];
  const dataDir = "/home/me/.config/google-chrome-agent";
  const post = async (method, request = {}) => {
    const params = request.params || {};
    calls.push({ method, params: { ...params } });
    if (method === "get-global-state") return { value: "" };
    if (method === "linux-agent-workspace-pick-browser-data") {
      return { ok: true, action: "pickBrowserData", json: { canceled: false, path: dataDir, paths: [dataDir] } };
    }
    if (method !== "linux-agent-workspace") return { ok: true };
    if (params.action === "permissionConfig") return { ok: true, json: { configured: false, restricted: false } };
    if (params.action === "profileList") return { ok: true, json: { profiles: [] } };
    if (params.action === "workspaceList") return { ok: true, json: { workspaces: [] } };
    if (params.action === "profileTemplate") return { ok: true, json: { id: params.profileId } };
    return { ok: true, action: params.action, json: { ok: true } };
  };

  const harness = createSettingsRenderHarness(post, {
    window: {
      confirm(message) {
        confirms.push(message);
        return true;
      },
    },
  });
  const firstRender = harness.render();
  for (const effect of firstRender.effects) effect();
  await flushPromises();
  await flushPromises();

  await findButton(harness.render().tree, "Browser session").props.onClick();
  let rendered = harness.render();
  const dialogText = nodeText(rendered.tree);
  assert.match(dialogText, /Runs Chrome directly on the selected folder\. Close the host browser first/);
  assert.doesNotMatch(dialogText, /[Mm]ount/);
  const direct = findNode(rendered.tree, (node) => node.type === "button" && nodeText(node).startsWith("Use folder directly"));
  direct.props.onClick();
  rendered = harness.render();
  await findButton(rendered.tree, "Create direct").props.onClick();
  await flushPromises();

  assert.equal(calls.some((call) => call.method === "linux-agent-workspace-copy-browser-data"), false);
  assert.equal(confirms.length, 1);
  assert.match(confirms[0], /Close the host browser first/);
  assert.match(confirms[0], /refuses a profile a desktop browser holds/);
  const templateCall = calls.find((call) => call.params.action === "profileTemplate");
  assert.deepEqual(templateCall.params, {
    action: "profileTemplate",
    templateKind: "browser-session",
    profileId: "browser-session",
    userDataDir: dataDir,
  });
});

test("main bridge version action runs --version without the permissions prefix", async () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "codex-agent-workspace-version-"));
  try {
    const permissionsPath = path.join(tempDir, "permissions.json");
    fs.writeFileSync(permissionsPath, JSON.stringify({ apps: { allow: ["sh"] } }));
    const outputs = [
      [null, "agent-workspace-linux 0.6.0\n", ""],
      [Object.assign(new Error("Command failed"), { code: 1 }), "", "Error: unknown command '--version'. Expected one of: doctor\n"],
      [null, "something else\n", ""],
    ];
    for (const globalState of [
      new Map([[SETTINGS_PERMISSIONS_KEY, permissionsPath]]),
      new Map([[SETTINGS_PERMISSIONS_KEY, path.join(tempDir, "missing.json")]]),
    ]) {
      const calls = [];
      const queue = [...outputs];
      const { handlers } = buildBridgeHarness({
        env: { CODEX_AGENT_WORKSPACE_BIN: "/tmp/agent-workspace-linux" },
        globalState,
        execFile(command, args, options, callback) {
          calls.push(Array.from(args));
          callback(...queue.shift());
        },
      });
      const current = await handlers["linux-agent-workspace"]({ action: "version" });
      assert.equal(current.ok, true);
      assert.equal(current.json.version, "0.6.0");
      const old = await handlers["linux-agent-workspace"]({ action: "version" });
      assert.equal(old.ok, false);
      assert.equal(old.json.version, null);
      assert.match(old.stderr, /unknown command '--version'/);
      const garbled = await handlers["linux-agent-workspace"]({ action: "version" });
      assert.equal(garbled.ok, false);
      assert.equal(garbled.json.version, null);
      assert.deepEqual(calls, [["--version"], ["--version"], ["--version"]]);
    }
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

function versionGateBridge(versionOutput) {
  const output = { current: versionOutput };
  const savedProfile = { id: "qa-profile", description: "QA profile", startup_apps: [] };
  const { handlers, execCalls } = buildBridgeHarness({
    env: { CODEX_AGENT_WORKSPACE_BIN: "/tmp/agent-workspace-linux" },
    execFile(command, args, options, callback) {
      const argv = Array.from(args);
      execCalls.push(argv);
      if (argv[0] === "--version") {
        const [error, stdout] = output.current;
        return callback(
          typeof error === "string" ? Object.assign(new Error("Command failed"), { code: 1 }) : error,
          stdout,
          typeof error === "string" ? error : "",
        );
      }
      if (argv[0] === "profile" && argv[1] === "list") return callback(null, JSON.stringify({ profiles: [savedProfile] }), "");
      if (argv[0] === "workspace" && argv[1] === "list") return callback(null, JSON.stringify({ workspaces: [] }), "");
      return callback(null, JSON.stringify({ ok: true }), "");
    },
  });
  const post = async (method, request = {}) => {
    if (method === "get-global-state") return { value: "" };
    if (method === "set-global-state") return { success: true };
    return handlers[method](request.params || {});
  };
  return { post, output, execCalls };
}

async function settle() {
  for (let index = 0; index < 6; index += 1) await flushPromises();
}

const GATED_BUTTONS = ["Save permissions", "Project template", "Chrome template", "Browser session", "Start"];

function gatedButtonStates(tree) {
  return Object.fromEntries(GATED_BUTTONS.map((label) => [label, findButton(tree, label)?.props.disabled]));
}

test("settings page blocks writes and starts until agent-workspace-linux reports 0.6.0 or newer", async () => {
  for (const [output, expected] of [
    [["Error: unknown command '--version'.", ""], "installed: too old to report a version"],
    [[null, "agent-workspace-linux 0.5.1\n"], "installed: 0.5.1"],
    [[null, "agent-workspace-linux 0.5.10\n"], "installed: 0.5.10"],
  ]) {
    const { post } = versionGateBridge(output);
    const harness = createSettingsRenderHarness(post, { version: null });
    for (const effect of harness.render().effects) effect();
    await settle();

    const tree = harness.render().tree;
    const alert = findNode(tree, (node) => node.props?.role === "alert");
    assert.ok(alert, `version banner should render for ${expected}`);
    assert.equal(
      nodeText(alert),
      `This page needs agent-workspace-linux 0.6.0 or newer; ${expected}. Update with Install from npm.`,
    );
    assert.deepEqual(gatedButtonStates(tree), Object.fromEntries(GATED_BUTTONS.map((label) => [label, true])));
    assert.equal(findButton(tree, "Install from npm").props.disabled, false);
    findButton(tree, "Create new").props.onClick();
    assert.equal(findButton(harness.render().tree, "Create").props.disabled, true, "profile saves stay blocked");
  }

  for (const version of ["0.6.0", "0.10.0", "1.0.0"]) {
    const { post } = versionGateBridge([null, `agent-workspace-linux ${version}\n`]);
    const harness = createSettingsRenderHarness(post, { version: null });
    for (const effect of harness.render().effects) effect();
    await settle();
    const tree = harness.render().tree;
    assert.equal(findNode(tree, (node) => node.props?.role === "alert"), null, `${version} passes the gate`);
    assert.deepEqual(gatedButtonStates(tree), Object.fromEntries(GATED_BUTTONS.map((label) => [label, false])));
  }
});

test("settings page distinguishes missing commands, timeouts and failed version checks", async () => {
  for (const [error, stdout, expected] of [
    [Object.assign(new Error("spawn ENOENT"), { code: "ENOENT" }), "", /not found/i],
    [Object.assign(new Error("Command failed"), { killed: true, signal: "SIGTERM" }), "", /timed out/i],
    [Object.assign(new Error("permission denied"), { code: "EACCES" }), "", /could not check.*permission denied/i],
    [null, "unexpected output\n", /could not check.*unrecognized version output/i],
  ]) {
    const { post } = versionGateBridge([error, stdout]);
    const harness = createSettingsRenderHarness(post, { version: null });
    for (const effect of harness.render().effects) effect();
    await settle();
    const tree = harness.render().tree;
    const message = nodeText(findNode(tree, (node) => node.props?.role === "alert"));
    assert.match(message, expected);
    assert.match(message, /\/tmp\/agent-workspace-linux/);
    assert.doesNotMatch(message, /too old/i);
    assert.deepEqual(gatedButtonStates(tree), Object.fromEntries(GATED_BUTTONS.map((label) => [label, true])));
  }
});

test("installing from the page selects the installed binary instead of an older Cargo binary", async () => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), "codex-agent-workspace-installed-command-"));
  try {
    for (const customPrefix of [false, true]) {
      for (const installFails of [false, true]) {
        const home = path.join(temp, `${customPrefix}-${installFails}`);
        const cargoHome = path.join(home, ".cargo");
        const prefix = customPrefix ? path.join(home, "npm-prefix") : path.join(home, ".local");
        const oldBinary = path.join(cargoHome, "bin", "agent-workspace-linux");
        const installedBinary = path.join(prefix, "bin", "agent-workspace-linux");
        fs.mkdirSync(path.dirname(oldBinary), { recursive: true });
        fs.writeFileSync(oldBinary, "#!/bin/sh\n", { mode: 0o755 });
        const globalState = new Map([[SETTINGS_COMMAND_KEY, oldBinary]]);
        const calls = [];
        const { handlers } = buildBridgeHarness({
          env: { HOME: home, CARGO_HOME: cargoHome, NPM_CONFIG_PREFIX: customPrefix ? prefix : "", CODEX_AGENT_WORKSPACE_BIN: "", PATH: "", XDG_DATA_HOME: path.join(home, "data") },
          globalState,
          execFile(command, args, options, callback) {
            const argv = Array.from(args);
            calls.push({ command, args: argv });
            if (argv[0] === "install") {
              if (installFails) return callback(new Error("npm install failed"), "", "registry unavailable");
              fs.mkdirSync(path.dirname(installedBinary), { recursive: true });
              fs.writeFileSync(installedBinary, "#!/bin/sh\n", { mode: 0o755 });
              return callback(null, "installed\n", "");
            }
            if (argv[0] === "--version") return callback(null, `agent-workspace-linux ${command === oldBinary ? "0.5.1" : "0.6.0"}\n`, "");
            if (argv[0] === "profile" && argv[1] === "list") return callback(null, '{"profiles":[]}', "");
            if (argv[0] === "workspace" && argv[1] === "list") return callback(null, '{"workspaces":[]}', "");
            callback(null, '{"ok":true}', "");
          },
        });
        const post = async (method, request = {}) => {
          const params = request.params || {};
          if (method === "get-global-state") return { value: globalState.get(params.key) };
          if (method === "set-global-state") { globalState.set(params.key, params.value); return { success: true }; }
          return handlers[method](params);
        };
        const harness = createSettingsRenderHarness(post, { version: null });
        for (const effect of harness.render().effects) effect();
        await settle();
        await findButton(harness.render().tree, "Install from npm").props.onClick();
        await settle();
        const tree = harness.render().tree;
        if (installFails) {
          assert.equal(globalState.get(SETTINGS_COMMAND_KEY), oldBinary);
          assert.match(nodeText(findNode(tree, (node) => node.props?.role === "alert")), /installed: 0\.5\.1/);
        } else {
          assert.equal(globalState.get(SETTINGS_COMMAND_KEY), installedBinary);
          assert.equal(calls.filter((call) => call.args[0] === "--version").at(-1).command, installedBinary);
          assert.equal(findNode(tree, (node) => node.props?.role === "alert"), null);
          assert.ok(findInput(tree, (node) => node.props.value === installedBinary), "Command shows the installed executable");
        }
      }
    }
  } finally {
    fs.rmSync(temp, { recursive: true, force: true });
  }
});

test("main bridge resolves npm's prefix when HOME and NPM_CONFIG_PREFIX are absent", async () => {
  const prefix = path.join(os.tmpdir(), "npm-configured-prefix");
  const calls = [];
  const { handlers } = buildBridgeHarness({
    env: { HOME: "", NPM_CONFIG_PREFIX: "", PATH: "" },
    execFile(command, args, options, callback) {
      calls.push(Array.from(args));
      callback(null, args[0] === "prefix" ? `${prefix}\n` : "installed\n", "");
    },
  });
  const response = await handlers["linux-agent-workspace"]({ action: "installRuntime" });
  assert.equal(response.ok, true);
  assert.deepEqual(calls, [["prefix", "-g"], ["install", "-g", "--prefix", prefix, "@agent-sh/agent-workspace-linux@>=0.6.0"]]);
  assert.equal(response.json.command, path.join(prefix, "bin", "agent-workspace-linux"));
});

test("settings page Reconnect and Smoke test rerun the version gate", async () => {
  const { post, output, execCalls } = versionGateBridge([null, "agent-workspace-linux 0.5.1\n"]);
  const harness = createSettingsRenderHarness(post, { version: null });
  for (const effect of harness.render().effects) effect();
  await settle();
  assert.equal(findButton(harness.render().tree, "Start").props.disabled, true);

  findButton(harness.render().tree, "Smoke test").props.onClick();
  await settle();
  let tree = harness.render().tree;
  const smoke = findNode(tree, (node) => node.type === "details" && nodeText(node).startsWith("Error"));
  assert.ok(smoke, "smoke test should report the failed version check");
  assert.match(nodeText(findNode(tree, (node) => node.props?.role === "alert")), /installed: 0\.5\.1/);

  output.current = [null, "agent-workspace-linux 0.6.0\n"];
  findButton(tree, "Reconnect").props.onClick();
  await settle();
  tree = harness.render().tree;
  assert.equal(findNode(tree, (node) => node.props?.role === "alert"), null);
  assert.equal(findButton(tree, "Start").props.disabled, false);
  assert.equal(execCalls.filter((argv) => argv[0] === "--version").length, 3, "load, Smoke test and Reconnect each check");
  assert.ok(execCalls.every((argv) => argv[0] !== "--permissions" || argv[2] !== "--version"));
});

test("approved start from the settings page reaches the CLI without the removed unenforced-policy flag", async () => {
  const savedProfile = { id: "qa-profile", description: "QA profile", startup_apps: [] };
  const { handlers, execCalls } = buildBridgeHarness({
    env: { CODEX_AGENT_WORKSPACE_BIN: "/tmp/agent-workspace-linux" },
    execFile(command, args, options, callback) {
      execCalls.push({ command, args: Array.from(args), options });
      const argv = Array.from(args);
      if (argv[0] === "--version") return callback(null, "agent-workspace-linux 0.6.0\n", "");
      if (argv[0] === "profile" && argv[1] === "list") return callback(null, JSON.stringify({ profiles: [savedProfile] }), "");
      if (argv[0] === "workspace" && argv[1] === "list") return callback(null, JSON.stringify({ workspaces: [] }), "");
      if (argv.includes("--dry-run")) {
        return callback(
          null,
          JSON.stringify({
            ok: true,
            approval_bundle: {
              required_acknowledgements: [
                { id: "hidden_workspace", label: "Hidden workspace", cli_flag: "--ack-hidden-workspace" },
                { id: "unenforced_policy", label: "Legacy policy", cli_flag: "--ack-unenforced-policy" },
              ],
              approve_cli_flags: ["--ack-hidden-workspace", "--ack-unenforced-policy"],
            },
          }),
          "",
        );
      }
      return callback(null, JSON.stringify({ ok: true, workspace_id: "qa-live" }), "");
    },
  });
  const post = async (method, request = {}) => {
    if (method === "get-global-state") return { value: "" };
    return handlers[method](request.params || {});
  };

  const harness = createSettingsRenderHarness(post, { version: null });
  const firstRender = harness.render();
  for (const effect of firstRender.effects) effect();
  for (let index = 0; index < 4; index += 1) await flushPromises();

  const startButton = findNode(
    harness.render().tree,
    (node) => node.type === "button" && nodeText(node) === "Start" && node.props.disabled === false,
  );
  assert.ok(startButton, "Start button should render for the saved profile");
  startButton.props.onClick();
  for (let index = 0; index < 4; index += 1) await flushPromises();

  const approveButton = findButton(harness.render().tree, "Approve and start");
  assert.ok(approveButton, "approval card should render");
  approveButton.props.onClick();
  for (let index = 0; index < 4; index += 1) await flushPromises();

  const openCalls = execCalls.filter((call) => call.args[0] === "workspace" && call.args[1] === "open-profile");
  assert.equal(openCalls.length, 2);
  assert.ok(openCalls[0].args.includes("--dry-run"));
  assert.ok(openCalls[1].args.includes("--ack-hidden-workspace"));
  for (const call of execCalls) {
    assert.equal(call.args.includes("--ack-unenforced-policy"), false, call.args.join(" "));
  }
});

test("generated settings UI auto-opens the GPUI viewer after approved workspace start", async () => {
  const calls = [];
  const savedProfile = {
    id: "qa-profile",
    description: "QA profile",
    startup_apps: [],
  };
  const post = async (method, request = {}) => {
    const params = request.params || {};
    calls.push({ method, params });
    if (method === "get-global-state") return { value: "" };
    if (method !== "linux-agent-workspace") return { ok: true };
    if (params.action === "permissionConfig") return { ok: true, json: { configured: false, restricted: false } };
    if (params.action === "profileList") return { ok: true, json: { profiles: [savedProfile] } };
    if (params.action === "workspaceList") return { ok: true, json: { workspaces: [] } };
    if (params.action === "workspaceOpenProfile" && params.dryRun) {
      return {
        ok: true,
        json: {
          ok: true,
          approval_bundle: {
            required_acknowledgements: [{ id: "hidden_workspace", label: "Hidden workspace" }],
          },
        },
      };
    }
    if (params.action === "workspaceOpenProfile") {
      return { ok: true, json: { ok: true, workspace_id: "qa-live" } };
    }
    if (params.action === "workspaceOpenViewer") {
      return { ok: true, json: { ok: true, id: params.workspaceId, exit_when_workspace_gone: true } };
    }
    return { ok: true, json: { ok: true } };
  };

  const harness = createSettingsRenderHarness(post);
  const firstRender = harness.render();
  for (const effect of firstRender.effects) effect();
  await flushPromises();
  await flushPromises();

  let rendered = harness.render();
  const startButton = findNode(
    rendered.tree,
    (node) => node.type === "button" && nodeText(node) === "Start" && node.props.disabled === false,
  );
  assert.ok(startButton, "Start button should render for a saved inactive profile");
  startButton.props.onClick();
  await flushPromises();

  rendered = harness.render();
  const approveButton = findNode(
    rendered.tree,
    (node) => node.type === "button" && nodeText(node) === "Approve and start",
  );
  assert.ok(approveButton, "approval card should render before starting a hidden workspace");
  approveButton.props.onClick();
  await flushPromises();
  await flushPromises();
  await flushPromises();

  const workspaceCalls = calls.filter((call) => call.method === "linux-agent-workspace");
  const dryRun = workspaceCalls.find((call) => call.params.action === "workspaceOpenProfile" && call.params.dryRun === true);
  const realStart = workspaceCalls.find(
    (call) => call.params.action === "workspaceOpenProfile" && call.params.ackHiddenWorkspace === true,
  );
  const viewer = workspaceCalls.find((call) => call.params.action === "workspaceOpenViewer");
  assert.equal(dryRun?.params.profileId, "qa-profile");
  assert.equal(realStart?.params.profileId, "qa-profile");
  assert.equal(Object.prototype.hasOwnProperty.call(realStart.params, "ackUnenforcedPolicy"), false);
  assert.deepEqual(JSON.parse(JSON.stringify(viewer)), {
    method: "linux-agent-workspace",
    params: {
      action: "workspaceOpenViewer",
      workspaceId: "qa-live",
    },
  });
});

test("settings asset patches add navigation, route, visibility, and title", () => {
  const shared = applyAgentWorkspaceSettingsSharedPatch(syntheticCurrentAppInitialBundle());
  assert.match(shared, new RegExp(`settings\\.nav\\.${SETTINGS_SLUG}`));
  assert.match(shared, new RegExp(`settings\\.section\\.${SETTINGS_SLUG}`));
  assert.match(
    shared,
    /case`agent-workspaces`:\{return \(0,g7\.jsx\)\(Z,\{id:`settings\.section\.agent-workspaces`/,
  );
  assert.doesNotMatch(
    shared,
    /case`agent-workspaces`:\{return \(0,d\.jsx\)\(n,/,
  );
  assert.equal(applyAgentWorkspaceSettingsSharedPatch(shared), shared);

  const currentAppMain = applyAgentWorkspaceSettingsIndexPatch(shared);
  assert.match(
    currentAppMain,
    /"agent-workspaces":BN\(async\(\)=>\(await Y\(async\(\)=>\{let\{default:e\}=await import\(`\.\/agent-workspaces-linux\.js`\);return\{default:e\}\},\[\],import\.meta\.url\)\)\.default\),"general-settings":/,
  );
  assert.equal(applyAgentWorkspaceSettingsIndexPatch(currentAppMain), currentAppMain);
  assert.throws(
    () => applyAgentWorkspaceSettingsIndexPatch(
      shared.replace("general-settings-TbWU8D8b.js", "general-preferences-TbWU8D8b.js"),
    ),
    /could not add agent workspace settings route/,
  );
  assert.throws(
    () => applyAgentWorkspaceSettingsIndexPatch(shared + shared),
    /could not add agent workspace settings route/,
  );

  const catalog = applyAgentWorkspaceSettingsCatalogPatch(currentAppMain);
  assert.match(catalog, /local-environments\.agent-workspaces\.worktrees/);
  assert.match(catalog, /\{slug:`local-environments`\},\{slug:`agent-workspaces`\},\{slug:`worktrees`\}/);
  assert.equal(applyAgentWorkspaceSettingsCatalogPatch(catalog), catalog);

  const settingsNavigation = applyAgentWorkspaceSettingsPagePatch(
    syntheticCurrentSettingsNavigation(),
  );
  assert.match(settingsNavigation, /local-environments\.agent-workspaces\.worktrees\.browser-use/);
  assert.match(
    settingsNavigation,
    /`local-environments`,`agent-workspaces`,`environments`,`worktrees`/,
  );
  assert.equal(applyAgentWorkspaceSettingsPagePatch(settingsNavigation), settingsNavigation);

  const settingsVisibility = applyAgentWorkspaceSettingsPagePatch(
    syntheticCurrentSettingsVisibility(),
  );
  assert.match(
    settingsVisibility,
    new RegExp(`"${SETTINGS_SLUG}":\\{component:H,commandAsset:F,navigation:`),
  );
  assert.match(
    settingsVisibility,
    /case`worktrees`:case`local-environments`:case`agent-workspaces`:case`environments`:return!0/,
  );
  assert.match(settingsVisibility, /"local-environments":`codexLocal`,"agent-workspaces":`codexLocal`,"mcp-settings":/);
  assert.match(
    settingsVisibility,
    /`hooks-settings`,`gateways`,`local-environments`,`agent-workspaces`,`worktrees`,`storage`/,
  );

  const currentVisibilityContext = {};
  vm.runInNewContext(
    `${syntheticCurrentSettingsVisibility()};this.selectedHostVisibility=selectedHostVisibility;`,
    currentVisibilityContext,
  );
  assert.equal(
    currentVisibilityContext.selectedHostVisibility(false, { slug: SETTINGS_SLUG }).visible,
    false,
  );

  const patchedVisibilityContext = {};
  vm.runInNewContext(
    `${settingsVisibility};this.selectedHostVisibility=selectedHostVisibility;`,
    patchedVisibilityContext,
  );
  assert.equal(
    patchedVisibilityContext.selectedHostVisibility(true, { slug: SETTINGS_SLUG }).visible,
    true,
  );
  assert.equal(
    patchedVisibilityContext.selectedHostVisibility(false, { slug: SETTINGS_SLUG }).visible,
    true,
  );
  assert.equal(
    patchedVisibilityContext.selectedHostVisibility(false, { slug: "not-preloaded" }).visible,
    false,
  );
  assert.equal(applyAgentWorkspaceSettingsPagePatch(settingsVisibility), settingsVisibility);
});

test("settings visibility patch rejects missing and duplicate preload allowlist contracts", () => {
  const currentAllowlist =
    "`hooks-settings`,`gateways`,`local-environments`,`worktrees`,`storage`";
  assert.throws(
    () => applyAgentWorkspaceSettingsPagePatch(
      syntheticCurrentSettingsVisibility().replace(currentAllowlist, "`hooks-settings`,`gateways`,`storage`"),
    ),
    /could not add agent workspace to current settings visibility contracts/,
  );
  assert.throws(
    () => applyAgentWorkspaceSettingsPagePatch(
      syntheticCurrentSettingsVisibility().replace(
        currentAllowlist,
        `${currentAllowlist},${currentAllowlist}`,
      ),
    ),
    /could not uniquely resolve current settings preload allowlist/,
  );
});

test("settings title patch rejects unresolved renderer aliases", () => {
  const source = syntheticCurrentAppInitialBundle().replace(
    "(0,g7.jsx)(Z,{id:`settings.section.local-environments`",
    "renderMessage({id:`settings.section.local-environments`",
  );
  assert.throws(
    () => applyAgentWorkspaceSettingsSharedPatch(source),
    /could not resolve current settings section renderer aliases/,
  );
});

test("agent-workspace feature participates in ASAR patching and reports", () => {
  withTempFeatureConfig(["agent-workspace"], (featuresRoot) => {
    withLinuxFeatureRootEnv(featuresRoot, () => {
      const tempApp = fs.mkdtempSync(path.join(os.tmpdir(), "codex-agent-workspace-app-"));
      try {
        const { buildDir, assetsDir } = writeSyntheticExtractedApp(tempApp);
        const report = createPatchReport();
        const { warnings } = captureWarns(() => patchExtractedApp(tempApp, { report }));

        assert.ok(
          warnings.every((warning) => !warning.includes("Agent Workspaces")),
          warnings.join("\n"),
        );
        assert.match(fs.readFileSync(path.join(buildDir, "early-bootstrap.js"), "utf8"), /"linux-agent-workspace":async/);
        assert.ok(fs.existsSync(path.join(assetsDir, SETTINGS_ASSET)));
        assert.match(fs.readFileSync(path.join(assetsDir, SETTINGS_ASSET), "utf8"), /AgentWorkspacesSettings/);
        assert.match(fs.readFileSync(path.join(assetsDir, "settings-page-test.js"), "utf8"), /agent-workspaces/);
        assert.match(fs.readFileSync(path.join(assetsDir, "use-visible-settings-sections-test.js"), "utf8"), /agent-workspaces/);
        assert.match(fs.readFileSync(path.join(assetsDir, "app-initial-test.js"), "utf8"), /Agent Workspaces/);
        assert.match(fs.readFileSync(path.join(assetsDir, "app-initial-test.js"), "utf8"), new RegExp(SETTINGS_ASSET));
        assert.equal(
          fs.readFileSync(path.join(assetsDir, "local-conversation-thread-test.js"), "utf8"),
          staleConversationMonitorBundle(),
        );
        assert.equal(fs.readFileSync(path.join(assetsDir, "composer-test.js"), "utf8"), syntheticComposerBundle());
        assert.equal(fs.readFileSync(path.join(assetsDir, "mcp-settings-test.js"), "utf8"), syntheticMcpSettingsBundle());
        assert.equal(
          fs.readFileSync(path.join(assetsDir, "general-settings-test.js"), "utf8"),
          syntheticGeneralSettingsBundle(),
        );
        assert.ok(report.patches.some((patch) => patch.name === "feature:agent-workspace:main-bridge" && patch.status === "applied"));
        assert.ok(report.patches.some((patch) => patch.name === "feature:agent-workspace:settings-page" && patch.status === "applied"));
        assert.equal(report.patches.some((patch) => patch.name === "feature:agent-workspace:conversation-view"), false);
        assert.equal(report.patches.some((patch) => patch.name === "feature:agent-workspace:stale-runtime-cleanup"), false);
        assert.equal(report.patches.some((patch) => patch.name === "feature:agent-workspace:approval-rendering"), false);
      } finally {
        fs.rmSync(tempApp, { recursive: true, force: true });
      }
    });
  });
});

test("agent-workspace settings resolve latest upstream request API asset", () => {
  const tempApp = fs.mkdtempSync(path.join(os.tmpdir(), "codex-agent-workspace-modern-api-"));
  try {
    const { assetsDir } = writeSyntheticExtractedApp(tempApp);
    writeModernCodexRequestAsset(assetsDir);

    const { value: result, warnings } = captureWarns(() => patchAgentWorkspaceSettingsAssets(tempApp));

    assert.equal(result.matched, true);
    assert.ok(
      warnings.every((warning) => !warning.includes("Agent Workspaces")),
      warnings.join("\n"),
    );
    const settingsSource = fs.readFileSync(path.join(assetsDir, SETTINGS_ASSET), "utf8");
    assert.match(settingsSource, /import\{l as __post\}from"\.\/setting-storage-test\.js"/);
    assert.match(settingsSource, /AgentWorkspacesSettings/);
    assert.match(fs.readFileSync(path.join(assetsDir, "app-initial-test.js"), "utf8"), new RegExp(SETTINGS_ASSET));
  } finally {
    fs.rmSync(tempApp, { recursive: true, force: true });
  }
});

test("agent-workspace settings infer runtime dependencies from the current settings page", () => {
  const tempApp = fs.mkdtempSync(path.join(os.tmpdir(), "codex-agent-workspace-bundled-runtime-"));
  try {
    const { assetsDir } = writeSyntheticExtractedApp(tempApp);

    assert.equal(fs.existsSync(path.join(assetsDir, "runtime-test.js")), true);
    assert.equal(fs.existsSync(path.join(assetsDir, "settings-page-test.js")), true);
    const { value: result, warnings } = captureWarns(() => patchAgentWorkspaceSettingsAssets(tempApp));

    assert.equal(result.matched, true);
    assert.ok(
      warnings.every((warning) => !warning.includes("Agent Workspaces")),
      warnings.join("\n"),
    );
    const settingsSource = fs.readFileSync(path.join(assetsDir, SETTINGS_ASSET), "utf8");
    assert.match(settingsSource, /import\{r as __reactFactory\}from"\.\/runtime-test\.js"/);
    assert.match(settingsSource, /var React=__reactFactory\(\)/);
    assert.doesNotMatch(settingsSource, /__toESM/);
    assert.match(settingsSource, /function SettingsPage/);
    assert.match(settingsSource, /AgentWorkspacesSettings/);
    assert.match(fs.readFileSync(path.join(assetsDir, "settings-page-test.js"), "utf8"), /agent-workspaces/);
    assert.match(fs.readFileSync(path.join(assetsDir, "app-initial-test.js"), "utf8"), new RegExp(SETTINGS_ASSET));
  } finally {
    fs.rmSync(tempApp, { recursive: true, force: true });
  }
});

test("agent-workspace settings reject duplicate semantic owners atomically", () => {
  const tempApp = fs.mkdtempSync(path.join(os.tmpdir(), "codex-agent-workspace-duplicate-owner-"));
  try {
    const { assetsDir } = writeSyntheticExtractedApp(tempApp);
    fs.writeFileSync(
      path.join(assetsDir, "settings-page-lazy-test.js"),
      syntheticCurrentSettingsNavigation(),
    );
    const before = new Map(
      fs.readdirSync(assetsDir).map((name) => [name, fs.readFileSync(path.join(assetsDir, name))]),
    );

    const { value: result, warnings } = captureWarns(() => patchAgentWorkspaceSettingsAssets(tempApp));

    assert.equal(result.matched, false);
    assert.equal(result.changed, 0);
    assert.match(result.reason, /uniquely resolve webview settings semantic owners/);
    assert.match(result.reason, /navigation=2/);
    assert.ok(warnings.some((warning) => warning.includes("navigation=2")));
    assert.equal(fs.existsSync(path.join(assetsDir, SETTINGS_ASSET)), false);
    for (const [name, source] of before) {
      assert.deepEqual(fs.readFileSync(path.join(assetsDir, name)), source, name);
    }
  } finally {
    fs.rmSync(tempApp, { recursive: true, force: true });
  }
});

test("agent-workspace settings infer the current direct React factory export", () => {
  const tempApp = fs.mkdtempSync(path.join(os.tmpdir(), "codex-agent-workspace-direct-runtime-"));
  try {
    const { assetsDir } = writeSyntheticExtractedApp(tempApp);
    const current = syntheticCurrentSettingsNavigation()
      .replace("RuntimeProbe", "RenamedRuntimeProbe");
    fs.writeFileSync(path.join(assetsDir, "settings-page-test.js"), current);

    const { value: result, warnings } = captureWarns(() => patchAgentWorkspaceSettingsAssets(tempApp));

    assert.equal(result.matched, true);
    assert.ok(warnings.every((warning) => !warning.includes("Agent Workspaces")), warnings.join("\n"));
    const settingsSource = fs.readFileSync(path.join(assetsDir, SETTINGS_ASSET), "utf8");
    assert.match(settingsSource, /import\{r as __reactFactory\}from"\.\/runtime-test\.js"/);
    assert.match(settingsSource, /var React=__reactFactory\(\)/);
    assert.doesNotMatch(settingsSource, /__toESM/);
  } finally {
    fs.rmSync(tempApp, { recursive: true, force: true });
  }
});

test("agent-workspace settings reject retired, missing, and ambiguous runtime relationships", () => {
  const variants = {
    retired: (source) => source
      .replace('import{r,j as jsxFactory}from"./runtime-test.js";', 'import{o as __toESM}from"./chunk-test.js";import{r as ReactFactory,j as jsxFactory}from"./runtime-test.js";')
      .replace("var React=r(),$=jsxFactory();", "var React=__toESM(ReactFactory(),1),$=jsxFactory();"),
    missing: (source) => source.replace("var React=r(),$=jsxFactory();", "var $=jsxFactory();"),
    ambiguous: (source) => source
      .replace('import{r,j as jsxFactory}from"./runtime-test.js";', 'import{r,q,j as jsxFactory}from"./runtime-test.js";')
      .replace(
        'function RuntimeProbe(){let [value]=(0,React.useState)(0);',
        'var Other=q();function RuntimeProbe(){let [other]=(0,Other.useState)(0),[value]=(0,React.useState)(0);',
      ),
  };

  for (const [name, mutate] of Object.entries(variants)) {
    const tempApp = fs.mkdtempSync(path.join(os.tmpdir(), `codex-agent-workspace-${name}-runtime-`));
    try {
      const { assetsDir } = writeSyntheticExtractedApp(tempApp);
      const settingsPath = path.join(assetsDir, "settings-page-test.js");
      fs.writeFileSync(settingsPath, mutate(syntheticCurrentSettingsNavigation()));
      const before = fs.readFileSync(settingsPath, "utf8");

      const { value: result } = captureWarns(() => patchAgentWorkspaceSettingsAssets(tempApp));

      assert.equal(result.matched, false, name);
      assert.match(result.reason, /current settings runtime dependencies/, name);
      assert.equal(fs.readFileSync(settingsPath, "utf8"), before, name);
      assert.equal(fs.existsSync(path.join(assetsDir, SETTINGS_ASSET)), false, name);
    } finally {
      fs.rmSync(tempApp, { recursive: true, force: true });
    }
  }
});

test("agent-workspace settings patch supports consolidated current settings bundles", () => {
  const tempApp = fs.mkdtempSync(path.join(os.tmpdir(), "codex-agent-workspace-current-settings-"));
  try {
    const { assetsDir } = writeSyntheticExtractedApp(tempApp);

    const { value: result, warnings } = captureWarns(() => patchAgentWorkspaceSettingsAssets(tempApp));

    assert.equal(result.matched, true);
    assert.ok(
      warnings.every((warning) => !warning.includes("Agent Workspaces")),
      warnings.join("\n"),
    );
    const settingsSource = fs.readFileSync(path.join(assetsDir, SETTINGS_ASSET), "utf8");
    assert.match(settingsSource, /import\{r as __reactFactory\}from"\.\/runtime-test\.js"/);
    assert.match(settingsSource, /function SettingsPage/);

    const settingsPageSource = fs.readFileSync(path.join(assetsDir, "settings-page-test.js"), "utf8");
    assert.match(settingsPageSource, /local-environments\.agent-workspaces\.worktrees\.browser-use/);
    assert.match(
      settingsPageSource,
      /`local-environments`,`agent-workspaces`,`environments`,`worktrees`/,
    );

    const visibilitySource = fs.readFileSync(
      path.join(assetsDir, "use-visible-settings-sections-test.js"),
      "utf8",
    );
    assert.match(
      visibilitySource,
      /"agent-workspaces":\{component:H,commandAsset:F,navigation:/,
    );
    assert.match(
      visibilitySource,
      /case`worktrees`:case`local-environments`:case`agent-workspaces`:case`environments`:return!0/,
    );

    const appInitialSource = fs.readFileSync(path.join(assetsDir, "app-initial-test.js"), "utf8");
    assert.match(appInitialSource, /settings\.nav\.agent-workspaces/);
    assert.match(appInitialSource, /settings\.section\.agent-workspaces/);
    assert.match(appInitialSource, new RegExp(SETTINGS_ASSET));
    assert.match(appInitialSource, /"agent-workspaces":BN\(async\(\)=>\(await Y\(/);
    assert.match(appInitialSource, /local-environments\.agent-workspaces\.worktrees/);
    assert.match(appInitialSource, /\{slug:`local-environments`\},\{slug:`agent-workspaces`\},\{slug:`worktrees`\}/);
    assert.equal(patchAgentWorkspaceSettingsAssets(tempApp).changed, 0);
  } finally {
    fs.rmSync(tempApp, { recursive: true, force: true });
  }
});

test("agent-workspace settings patch rejects a partially patched current catalog atomically", () => {
  const tempApp = fs.mkdtempSync(path.join(os.tmpdir(), "codex-agent-workspace-partial-catalog-"));
  try {
    const { assetsDir } = writeSyntheticExtractedApp(tempApp);
    const catalogPath = path.join(
      assetsDir,
      "app-initial-test.js",
    );
    fs.writeFileSync(
      catalogPath,
      syntheticCurrentSettingsCatalog().replace(
        "local-environments.worktrees.environments",
        "local-environments.agent-workspaces.worktrees.environments",
      ),
    );
    const before = new Map(
      fs.readdirSync(assetsDir).map((name) => [name, fs.readFileSync(path.join(assetsDir, name))]),
    );

    const { value: result, warnings } = captureWarns(() => patchAgentWorkspaceSettingsAssets(tempApp));

    assert.equal(result.matched, false);
    assert.equal(result.changed, 0);
    assert.match(result.reason, /catalog is partially patched/);
    assert.ok(warnings.some((warning) => warning.includes("catalog is partially patched")));
    assert.equal(fs.existsSync(path.join(assetsDir, SETTINGS_ASSET)), false);
    for (const [name, source] of before) {
      assert.deepEqual(fs.readFileSync(path.join(assetsDir, name)), source);
    }
  } finally {
    fs.rmSync(tempApp, { recursive: true, force: true });
  }
});

test("feature patch list is intentionally small", () => {
  assert.deepEqual(
    featurePatches.map((patch) => [patch.id, patch.phase]),
    [
      ["main-bridge", "main-bundle"],
      ["settings-page", "extracted-app:post-webview"],
    ],
  );
});
