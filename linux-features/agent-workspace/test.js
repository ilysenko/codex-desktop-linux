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
    '"get-global-state":async({key:t})=>({value:this.globalState.get(t)}),',
    '"set-global-state":async({key:t,value:n})=>(this.globalState.set(t,n),{success:!0})',
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

function syntheticSettingsShared() {
  return [
    "var c=r({",
    '"general-settings":{id:`settings.nav.general-settings`,defaultMessage:`General`,description:`Title for general settings section`},',
    '"local-environments":{id:`settings.nav.local-environments`,defaultMessage:`Environments`,description:`Title for environments settings section`},',
    "worktrees:{id:`settings.nav.worktrees`,defaultMessage:`Worktrees`,description:`Title for worktrees settings section`}",
    "});",
    "function m(e){let t=(0,u.c)(3),{slug:r}=e;switch(r){",
    "case`general-settings`:{return (0,d.jsx)(n,{id:`settings.section.general-settings`,defaultMessage:`General`})}",
    "case`local-environments`:{return (0,d.jsx)(n,{id:`settings.section.local-environments`,defaultMessage:`Environments`})}",
    "case`worktrees`:{return (0,d.jsx)(n,{id:`settings.section.worktrees`,defaultMessage:`Worktrees`})}",
    "}}",
  ].join("");
}

function syntheticCurrentAppMainRouteRegistry() {
  return [
    "function render(e){return currentRouteMap[e.slug]}",
    'var currentRouteMap={"general-settings":BN(async()=>(await Y(async()=>{let{GeneralSettings:e}=await import(`./general-settings-TbWU8D8b.js`);return{GeneralSettings:e}},__vite__mapDeps([1,2]),import.meta.url)).GeneralSettings),',
    'import:BN(async()=>(await Y(async()=>{let{ImportSettings:e}=await import(`./import-settings-DmsueF_s.js`);return{ImportSettings:e}},__vite__mapDeps([3]),import.meta.url)).ImportSettings)};',
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
  fs.writeFileSync(path.join(buildDir, "main.js"), syntheticMainBundle());
  fs.writeFileSync(path.join(root, "package.json"), JSON.stringify({ name: "codex" }));
  fs.writeFileSync(path.join(assetsDir, "local-conversation-thread-test.js"), staleConversationMonitorBundle());
  fs.writeFileSync(path.join(assetsDir, "composer-test.js"), syntheticComposerBundle());
  fs.writeFileSync(path.join(assetsDir, "mcp-settings-test.js"), syntheticMcpSettingsBundle());
  fs.writeFileSync(path.join(assetsDir, "general-settings-test.js"), syntheticGeneralSettingsBundle());
  fs.writeFileSync(path.join(assetsDir, "chunk-test.js"), "export function s(e){return e}");
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
    'import{s}from"./chunk-test.js";export{ReactFactory as r,jsxFactory as j};function ReactFactory(){return{createElement(){return{}},useState(value){return[value,()=>{}]},useCallback(fn){return fn},useEffect(){}}}function jsxFactory(){return{jsx(){},jsxs(){}}}',
  );
  fs.writeFileSync(
    path.join(assetsDir, "settings-page-test.js"),
    [
      'import{s as __toESM}from"./chunk-test.js";',
      'import{r as ReactFactory,j as jsxFactory}from"./runtime-test.js";',
      'var React=__toESM(ReactFactory(),1),$=jsxFactory();',
      'function RuntimeProbe(){let [value]=(0,React.useState)(0);return (0,$.jsx)("span",{children:value})}',
      "var Z=$,S=e=>(0,Z.jsxs)(`svg`,{children:[]}),ln=S,F=S;",
      'var Hn={"linux-desktop":S,"general-settings":S,"local-environments":ln,worktrees:F,environments:ln,"mcp-settings":S,connections:S};',
      "var Wn=[`general-settings`,`linux-desktop`,`local-environments`,`worktrees`,`data-controls`],Gn=[{key:`personal`,slugs:[`general-settings`,`linux-desktop`]},{key:`coding`,slugs:[`local-environments`,`environments`,`worktrees`]}];",
      "function visible(S){switch(S.slug){case`computer-use`:return!0;case`browser-use`:return!0;case`appearance`:return!0;case`pets`:case`git-settings`:case`worktrees`:case`local-environments`:case`environments`:return!0;case`data-controls`:return!0;case`linux-desktop`:case`general-settings`:case`agent`:case`personalization`:return!0;}}",
      "function load(S){let T=!1;switch(S.slug){case`local-environments`:case`worktrees`:case`environments`:case`mcp-settings`:case`connections`:T=!1;break}return T}",
      "var lr=[`profile`,`agent`,`personalization`,`mcp-settings`,`hooks-settings`,`local-environments`,`worktrees`,`data-controls`];",
    ].join(""),
  );
  fs.writeFileSync(
    path.join(assetsDir, "app-initial~app-main~messages-test.js"),
    syntheticSettingsShared(),
  );
  fs.writeFileSync(
    path.join(assetsDir, "app-initial~app-main~automations-page-test.js"),
    syntheticCurrentAppMainRouteRegistry(),
  );
  fs.writeFileSync(
    path.join(assetsDir, "app-initial~app-main~hotkey-window-thread-page~keyboard-shortcuts-settings~thread-app-shell~current-test.js"),
    syntheticCurrentSettingsCatalog(),
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

function createSettingsRenderHarness(post) {
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
    __post: post,
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

test("main bridge patch resolves quoted require aliases", () => {
  const quotedBundle = [
    "let c=require(\"node:child_process\"),o=require('node:fs'),i=require(`node:path`);",
    "class Host{handlers(){return {",
    '"get-global-state":async({key:t})=>({value:this.globalState.get(t)}),',
    '"set-global-state":async({key:t,value:n})=>(this.globalState.set(t,n),{success:!0})',
    "}}}",
  ].join("");
  const patched = applyAgentWorkspaceMainBridgePatch(quotedBundle);
  assert.match(patched, /"linux-agent-workspace":async/);
  assert.match(patched, /execFile\(__codexCommand,__codexArgs/);
  assert.equal(applyAgentWorkspaceMainBridgePatch(patched), patched);
});

test("main bridge patch adds an allowlisted linux-agent-workspace handler", () => {
  const patched = applyAgentWorkspaceMainBridgePatch(syntheticMainBundle());
  assert.match(patched, /"linux-agent-workspace":async/);
  assert.match(patched, /"linux-agent-workspace-pick-app":async/);
  assert.match(patched, /"linux-agent-workspace-pick-mount":async/);
  assert.match(patched, /"linux-agent-workspace-pick-browser-data":async/);
  assert.match(patched, /"linux-agent-workspace-copy-browser-data":async/);
  assert.match(patched, /showOpenDialog/);
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
  assert.match(warnings.join("\n"), /Could not find Node module aliases/);
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
  const legacyHandler = [
    '"linux-agent-workspace-copy-browser-data":async()=>({ok:true,action:`copyBrowserData`}),',
    '"linux-agent-workspace":async({action:__codexAction}={})=>{let __codexActionName=__codexAction;',
    'try{switch(__codexActionName){case`profileList`:return{ok:true,json:{profiles:[]}};',
    'case`workspaceList`:return{ok:true,json:{workspaces:[]}};',
    'default:throw Error(`unsupported agent workspace action`)}}',
    'catch(e){return{ok:false,action:__codexActionName,message:e instanceof Error?e.message:String(e)}}},',
  ].join("");
  const legacy = syntheticMainBundle().replace('"get-global-state":async({key:t})=>', `${legacyHandler}"get-global-state":async({key:t})=>`);

  const upgraded = applyAgentWorkspaceMainBridgePatch(legacy);
  assert.match(upgraded, /"linux-agent-workspace-pick-app":async/);
  assert.match(upgraded, /"linux-agent-workspace-pick-mount":async/);
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
      ["install", "-g", "--prefix", path.join(tempDir, "home", ".local"), "@agent-sh/agent-workspace-linux"],
    );
    assert.equal(execCalls[0].options.timeout, 300000);
    assert.equal(execCalls.length, 1);
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
      ["install", "-g", "--prefix", path.join(home, "npm-prefix"), "@agent-sh/agent-workspace-linux"],
    );
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test("main bridge reads page-owned permission file and applies it to CLI calls", async () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "codex-agent-workspace-page-permissions-"));
  try {
    const permissionsPath = path.join(tempDir, "permissions.json");
    fs.writeFileSync(
      permissionsPath,
      JSON.stringify({ network: { mode: "disabled" }, apps: { allow: ["sh"] } }, null, 2),
    );

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
    assert.equal(config.json.ceiling.network.mode, "disabled");

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

test("main bridge saves page-authored permission rules as the active ceiling", async () => {
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
    assert.equal(saved.json.ceiling.network.mode, "local_only");
    assert.deepEqual(JSON.parse(JSON.stringify(saved.json.ceiling.network.allow_hosts)), ["localhost:3000"]);
    assert.deepEqual(JSON.parse(JSON.stringify(saved.json.ceiling.apps.allow)), ["/usr/bin/google-chrome"]);
    assert.equal(saved.json.ceiling.mounts[0].host_path, tempDir);

    const savedPath = globalState.get(SETTINGS_PERMISSIONS_KEY);
    assert.equal(saved.json.permissions_path, savedPath);
    assert.match(savedPath, /agent-workspace-linux\/permissions\/codex-agent-workspace-permissions\.json$/);
    assert.deepEqual(JSON.parse(fs.readFileSync(savedPath, "utf8")), permissions);

    const profiles = await handlers["linux-agent-workspace"]({ action: "profileList" });
    assert.equal(profiles.ok, true);
    assert.deepEqual(Array.from(execCalls[0].args.slice(0, 4)), ["--permissions", savedPath, "profile", "list"]);
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
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
  assert.match(source, /function approvalAckParams/);
  assert.match(source, /approve_cli_flags/);
  assert.match(source, /--ack-unenforced-policy/);
  assert.match(source, /--ack-hidden-workspace/);
  assert.match(source, /Workspace permissions/);
  assert.match(source, /Permission file/);
  assert.match(source, /Permission rules/);
  assert.match(source, /Network ceiling/);
  assert.match(source, /Allowed file access/);
  assert.match(source, /Allowed apps/);
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
  assert.match(source, /function profileMountMode/);
  assert.match(source, /function profileMounts/);
  assert.match(source, /function addMountsFromPaths/);
  assert.match(source, /function pickMount/);
  assert.match(source, /startup_app/);
  assert.match(source, /function profileAllowHosts/);
  assert.match(source, /function addNetworkHost/);
  assert.match(source, /function removeNetworkHost/);
  assert.match(source, /allow_hosts/);
  assert.match(source, /NETWORK_MODE_OPTIONS/);
  assert.match(source, /Closed/);
  assert.match(source, /Local/);
  assert.match(source, /Open/);
  assert.match(source, /Local hosts/);
  assert.doesNotMatch(source, /\["inherit_host","local_only","disabled","allowlist"\]/);
  assert.doesNotMatch(source, /Allowed hosts/);
  assert.match(source, /Add host/);
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
  assert.match(source, /Create from copy/);
  assert.match(source, /Create direct/);
  assert.match(source, /function createProjectProfile/);
  assert.match(source, /templateKind:"project-dev"/);
  assert.match(source, /function createRestrictedChromeProfile/);
  assert.match(source, /function createBrowserSessionProfile/);
  assert.match(source, /function finishBrowserSessionProfile/);
  assert.match(source, /linux-agent-workspace-pick-browser-data/);
  assert.match(source, /linux-agent-workspace-copy-browser-data/);
  assert.match(source, /profileFromResponse\(response\)/);
  assert.match(source, /profileTemplate/);
  assert.match(source, /restricted-chrome/);
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
  assert.match(source, /Add file\/folder/);
  assert.match(source, /Add a file or folder before choosing read-only or read-write access/);
  assert.match(source, /Workspace status/);
  assert.match(source, /Hide status/);
  assert.match(source, /function openWorkspaceViewer/);
  assert.match(source, /workspaceOpenViewer/);
  assert.match(source, /function openWorkspaceViewer\(workspaceId\)\{\s*callAgentWorkspace\("workspaceOpenViewer",\{workspaceId:workspaceId\}\);\s*\}/);
  assert.match(source, /workspaceIdFromStartResponse/);
  assert.match(source, /viewer "\+\(viewerResponse\?\.ok===false\?"failed":"opened"\)/);
  assert.match(source, /Open Viewer/);
  assert.match(source, /File access/);
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

test("generated settings UI saves structured permission rules from page controls", async () => {
  const calls = [];
  const permissionMount = path.join(os.tmpdir(), "permission-surface-project");
  const clone = (value) => JSON.parse(JSON.stringify(value ?? {}));
  const post = async (method, request = {}) => {
    const params = request.params || {};
    calls.push({ method, params: clone(params) });
    if (method === "get-global-state") return { value: "" };
    if (method === "linux-agent-workspace-pick-mount") {
      return { ok: true, action: "pickMount", json: { path: permissionMount, paths: [permissionMount] } };
    }
    if (method !== "linux-agent-workspace") return { ok: true };
    if (params.action === "permissionConfig") {
      return {
        ok: true,
        action: "permissionConfig",
        json: {
          configured: false,
          restricted: false,
          permissions_path: null,
          ceiling: { network: { mode: "inherit_host" }, mounts: [], apps: { allow: [] } },
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
  const networkLabel = findNode(
    rendered.tree,
    (node) => node.type === "label" && nodeText(node).startsWith("Network ceiling"),
  );
  assert.ok(networkLabel, "Permission network selector should render");
  const networkSelect = findNode(networkLabel, (node) => node.type === "select");
  assert.ok(networkSelect, "Permission network selector should be a select control");
  networkSelect.props.onChange({ target: { value: "local_only" } });

  rendered = harness.render();
  const hostInput = findInput(rendered.tree, (node) => node.props.placeholder === "localhost:3000");
  assert.ok(hostInput, "Local host input should render after choosing local-only permissions");
  hostInput.props.onChange({ target: { value: "localhost:3000" } });

  rendered = harness.render();
  const addHostButton = findButton(rendered.tree, "Add host");
  assert.ok(addHostButton, "Add host button should render");
  assert.equal(addHostButton.props.disabled, false);
  addHostButton.props.onClick();

  rendered = harness.render();
  const addMountButton = findNode(
    rendered.tree,
    (node) => node.type === "button" && nodeText(node) === "Add file/folder" && node.props.disabled === false,
  );
  assert.ok(addMountButton, "Permission mount picker button should render");
  addMountButton.props.onClick();
  await flushPromises();
  await flushPromises();

  rendered = harness.render();
  assert.match(nodeText(rendered.tree), new RegExp(permissionMount.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
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
  assert.deepEqual(saveCall.params.permissions.network, { mode: "local_only", allow_hosts: ["localhost:3000"] });
  assert.equal(saveCall.params.permissions.mounts.length, 1);
  assert.equal(saveCall.params.permissions.mounts[0].host_path, permissionMount);
  assert.match(saveCall.params.permissions.mounts[0].workspace_path, /^\/workspace\//);
  assert.equal(saveCall.params.permissions.mounts[0].mode, "read_only");
  assert.deepEqual(saveCall.params.permissions.apps.allow, ["/usr/bin/google-chrome"]);
  assert.ok(calls.some((call) => call.method === "linux-agent-workspace" && call.params.action === "doctor"));
});

test("generated settings UI auto-opens the GPUI viewer after approved workspace start", async () => {
  const calls = [];
  const savedProfile = {
    id: "qa-profile",
    description: "QA profile",
    network: { mode: "inherit_host" },
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
  assert.deepEqual(JSON.parse(JSON.stringify(viewer)), {
    method: "linux-agent-workspace",
    params: {
      action: "workspaceOpenViewer",
      workspaceId: "qa-live",
    },
  });
});

test("settings asset patches add navigation, route, visibility, and title", () => {
  const shared = applyAgentWorkspaceSettingsSharedPatch(syntheticSettingsShared());
  assert.match(shared, new RegExp(`settings\\.nav\\.${SETTINGS_SLUG}`));
  assert.match(shared, new RegExp(`settings\\.section\\.${SETTINGS_SLUG}`));
  assert.equal(applyAgentWorkspaceSettingsSharedPatch(shared), shared);

  const currentAppMain = applyAgentWorkspaceSettingsIndexPatch(syntheticCurrentAppMainRouteRegistry());
  assert.match(
    currentAppMain,
    /"agent-workspaces":BN\(async\(\)=>\(await Y\(async\(\)=>\{let\{default:e\}=await import\(`\.\/agent-workspaces-linux\.js`\);return\{default:e\}\},\[\],import\.meta\.url\)\)\.default\),"general-settings":/,
  );
  assert.equal(applyAgentWorkspaceSettingsIndexPatch(currentAppMain), currentAppMain);

  const settingsPage = applyAgentWorkspaceSettingsPagePatch(
    [
      'var Hn={"linux-desktop":S,"general-settings":S,"local-environments":ln,worktrees:F,environments:ln,"mcp-settings":S,connections:S};',
      "var Wn=[`general-settings`,`linux-desktop`,`local-environments`,`worktrees`,`data-controls`],Gn=[{key:`coding`,slugs:[`local-environments`,`environments`,`worktrees`]}];",
      "function visible(S){switch(S.slug){case`pets`:case`git-settings`:case`worktrees`:case`local-environments`:case`environments`:return!0;case`data-controls`:return!0;}}",
      "function load(S){switch(S.slug){case`local-environments`:case`worktrees`:case`environments`:case`mcp-settings`:return!1}}",
    ].join(""),
  );
  assert.match(settingsPage, new RegExp(`"local-environments":ln,"${SETTINGS_SLUG}":ln,worktrees`));
  assert.match(settingsPage, /`local-environments`,`agent-workspaces`,`worktrees`/);
  assert.match(settingsPage, /case`worktrees`:case`local-environments`:case`agent-workspaces`:case`environments`:return!0/);
  assert.match(settingsPage, /case`local-environments`:case`agent-workspaces`:case`worktrees`:case`environments`/);
  assert.equal(applyAgentWorkspaceSettingsPagePatch(settingsPage), settingsPage);
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
        assert.match(fs.readFileSync(path.join(buildDir, "main.js"), "utf8"), /"linux-agent-workspace":async/);
        assert.ok(fs.existsSync(path.join(assetsDir, SETTINGS_ASSET)));
        assert.match(fs.readFileSync(path.join(assetsDir, SETTINGS_ASSET), "utf8"), /AgentWorkspacesSettings/);
        assert.match(fs.readFileSync(path.join(assetsDir, "settings-page-test.js"), "utf8"), /agent-workspaces/);
        assert.match(fs.readFileSync(path.join(assetsDir, "app-initial~app-main~messages-test.js"), "utf8"), /Agent Workspaces/);
        assert.match(fs.readFileSync(path.join(assetsDir, "app-initial~app-main~automations-page-test.js"), "utf8"), new RegExp(SETTINGS_ASSET));
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
    assert.match(fs.readFileSync(path.join(assetsDir, "app-initial~app-main~automations-page-test.js"), "utf8"), new RegExp(SETTINGS_ASSET));
  } finally {
    fs.rmSync(tempApp, { recursive: true, force: true });
  }
});

test("agent-workspace settings infer runtime dependencies from bundled settings page", () => {
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
    assert.match(settingsSource, /function SettingsPage/);
    assert.match(settingsSource, /AgentWorkspacesSettings/);
    assert.match(fs.readFileSync(path.join(assetsDir, "settings-page-test.js"), "utf8"), /agent-workspaces/);
    assert.match(fs.readFileSync(path.join(assetsDir, "app-initial~app-main~automations-page-test.js"), "utf8"), new RegExp(SETTINGS_ASSET));
  } finally {
    fs.rmSync(tempApp, { recursive: true, force: true });
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
    assert.match(settingsPageSource, /"local-environments":ln,"agent-workspaces":ln,worktrees:F/);
    assert.match(settingsPageSource, /`local-environments`,`agent-workspaces`,`worktrees`/);
    assert.match(settingsPageSource, /slugs:\[`local-environments`,`agent-workspaces`,`environments`,`worktrees`\]/);
    assert.match(settingsPageSource, /case`worktrees`:case`local-environments`:case`agent-workspaces`:case`environments`:return!0/);
    assert.match(settingsPageSource, /case`local-environments`:case`agent-workspaces`:case`worktrees`:case`environments`/);
    assert.match(settingsPageSource, /lr=\[`profile`,`agent`,`personalization`,`mcp-settings`,`hooks-settings`,`local-environments`,`agent-workspaces`,`worktrees`,`data-controls`\]/);

    const sharedSource = fs.readFileSync(path.join(assetsDir, "app-initial~app-main~messages-test.js"), "utf8");
    assert.match(sharedSource, /settings\.nav\.agent-workspaces/);
    assert.match(sharedSource, /settings\.section\.agent-workspaces/);

    const routeSource = fs.readFileSync(path.join(assetsDir, "app-initial~app-main~automations-page-test.js"), "utf8");
    assert.match(routeSource, new RegExp(SETTINGS_ASSET));
    assert.match(routeSource, /"agent-workspaces":BN\(async\(\)=>\(await Y\(/);

    const catalogSource = fs.readFileSync(
      path.join(assetsDir, "app-initial~app-main~hotkey-window-thread-page~keyboard-shortcuts-settings~thread-app-shell~current-test.js"),
      "utf8",
    );
    assert.match(catalogSource, /local-environments\.agent-workspaces\.worktrees/);
    assert.match(catalogSource, /\{slug:`local-environments`\},\{slug:`agent-workspaces`\},\{slug:`worktrees`\}/);
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
      "app-initial~app-main~hotkey-window-thread-page~keyboard-shortcuts-settings~thread-app-shell~current-test.js",
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
