"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const { execFileSync } = require("node:child_process");

const repoRoot = path.resolve(__dirname, "..", "..");
const {
  enabledLinuxFeatureStageHooks,
  loadLinuxFeaturePatchDescriptors,
} = require("../../scripts/lib/linux-features.js");
const {
  applyLinuxReadAloudPluginGatePatch,
} = require("./patches.js");

function applyPatchTwice(patchFn, source) {
  const patched = patchFn(source);
  assert.equal(patchFn(patched), patched);
  return patched;
}

test("read-aloud-mcp stays disabled until listed in features.json", () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "read-aloud-mcp-feature-"));
  const featuresRoot = path.join(tempDir, "features");
  fs.mkdirSync(path.join(featuresRoot, "read-aloud-mcp"), { recursive: true });
  fs.copyFileSync(
    path.join(__dirname, "feature.json"),
    path.join(featuresRoot, "read-aloud-mcp", "feature.json"),
  );
  fs.copyFileSync(
    path.join(__dirname, "README.md"),
    path.join(featuresRoot, "read-aloud-mcp", "README.md"),
  );
  fs.copyFileSync(
    path.join(__dirname, "stage.sh"),
    path.join(featuresRoot, "read-aloud-mcp", "stage.sh"),
  );
  fs.copyFileSync(
    path.join(__dirname, "patches.js"),
    path.join(featuresRoot, "read-aloud-mcp", "patches.js"),
  );
  fs.writeFileSync(path.join(featuresRoot, "features.example.json"), '{"enabled":[]}\n');

  assert.deepEqual(enabledLinuxFeatureStageHooks({ featuresRoot }), []);

  fs.writeFileSync(
    path.join(featuresRoot, "features.json"),
    '{"enabled":["read-aloud-mcp"]}\n',
  );
  assert.equal(enabledLinuxFeatureStageHooks({ featuresRoot }).length, 1);
  assert.equal(loadLinuxFeaturePatchDescriptors({ featuresRoot }).length, 1);
});

test("read-aloud-mcp plugin gate adds an opt-in Linux bundled plugin", () => {
  const source = [
    "var lt=`browser-use`,ut=`chrome`,dt=`chrome-internal`,ft=`computer-use`,pt=`latex-tectonic`;",
    "var Kr=[{forceReload:!0,installWhenMissing:!0,name:lt,isAvailable:({features:e})=>e.inAppBrowserUseAllowed,migrate:rr},{forceReload:!0,name:dt,isAvailable:({buildFlavor:e,features:t})=>Qn(e)&&t.externalBrowserUseAllowed},{forceReload:!0,name:ut,isAvailable:({buildFlavor:e,features:t})=>t.externalBrowserUseAllowed&&$n(e)},{name:ft,isAvailable:({features:e,platform:t})=>t===`darwin`&&e.computerUse,migrate:vr},{installWhenMissing:!0,name:ft,isAvailable:({buildFlavor:e,features:n,platform:r})=>t.T.isInternal(e)&&r===`win32`&&n.computerUse},{name:pt,isAvailable:()=>!0}];",
  ].join("");

  const patched = applyPatchTwice(applyLinuxReadAloudPluginGatePatch, source);

  assert.match(
    patched,
    /\{installWhenMissing:!0,name:`read-aloud`,isAvailable:\(\{platform:e\}\)=>e===`linux`\},\{name:pt,isAvailable:\(\)=>!0\}/,
  );
});

test("read-aloud-mcp plugin gate supports older isEnabled bundle shapes", () => {
  const source = [
    "var Qt=`openai-bundled`,$t=`browser-use`,en=`chrome-internal`,tn=`computer-use`,nn=`latex-tectonic`;",
    "var $n=[{forceReload:!0,installWhenMissing:!0,name:$t,isEnabled:({features:e})=>e.browserAgentAvailable,migrate:cn},{name:en,isEnabled:({buildFlavor:e})=>rn(e)},{name:tn,isEnabled:({features:e,platform:t})=>t===`darwin`&&e.computerUse,migrate:wn},{name:nn,isEnabled:()=>!0}];",
  ].join("");

  const patched = applyPatchTwice(applyLinuxReadAloudPluginGatePatch, source);

  assert.match(
    patched,
    /\{installWhenMissing:!0,name:`read-aloud`,isEnabled:\(\{platform:e\}\)=>e===`linux`\},\{name:nn,isEnabled:\(\)=>!0\}/,
  );
});

test("read-aloud-mcp plugin gate ignores unrelated read-aloud strings", () => {
  const source = [
    "function codexLinuxReadAloudSettings(){return `read-aloud-settings`}",
    "var lt=`browser-use`,ut=`chrome`,dt=`chrome-internal`,ft=`computer-use`,pt=`latex-tectonic`;",
    "var Kr=[{forceReload:!0,installWhenMissing:!0,name:lt,isAvailable:({features:e})=>e.inAppBrowserUseAllowed,migrate:rr},{name:ft,isAvailable:({features:e,platform:t})=>t===`darwin`&&e.computerUse,migrate:vr},{name:pt,isAvailable:()=>!0}];",
  ].join("");

  const patched = applyLinuxReadAloudPluginGatePatch(source);

  assert.match(
    patched,
    /name:`read-aloud`,isAvailable:\(\{platform:e\}\)=>e===`linux`/,
  );
});

test("read-aloud-mcp plugin gate handles current imported namespace constants", () => {
  const source = [
    "var ti=[{autoInstallOptOutKey:e.yn(e._n),installWhenMissing:!0,name:e._n,isAvailable:({buildFlavor:e})=>ei(e)},{autoInstallOptOutKey:e.yn(e.pn),forceReload:!0,installWhenMissing:!0,name:e.pn,isAvailable:({features:e})=>e.inAppBrowserUseAllowed,migrate:dr},{forceReload:!0,name:ft,isAvailable:({buildFlavor:e,env:t,features:n})=>ar(e,t)&&n.externalBrowserUseAllowed},{forceReload:!0,name:e.mn,isAvailable:({buildFlavor:e,env:t,features:n})=>or(e,t)&&n.externalBrowserUseAllowed},{forceReload:!0,installWhenMissing:!0,name:dt,isAvailable:({buildFlavor:e,features:t})=>t.externalBrowserUseAllowed&&sr(e)},{installWhenMissing:!0,name:e.hn,isAvailable:({features:e,platform:t})=>(t===`darwin`||t===`linux`)&&e.computerUse,migrate:Er},{forceReload:!0,installWhenMissing:!0,name:e.hn,isAvailable:({buildFlavor:e,features:n,platform:r})=>t.D.isInternal(e)&&r===`win32`&&n.computerUse},{name:e.gn,isAvailable:()=>!0}];",
  ].join("");

  const patched = applyPatchTwice(applyLinuxReadAloudPluginGatePatch, source);

  assert.match(
    patched,
    /\{installWhenMissing:!0,name:`read-aloud`,isAvailable:\(\{platform:e\}\)=>e===`linux`\},\{name:e\.gn,isAvailable:\(\)=>!0\}/,
  );
});

test("read-aloud-mcp stage hook records marketplace entry", () => {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "read-aloud-mcp-stage-"));
  const installDir = path.join(workspace, "install");
  const fakeBackend = path.join(workspace, "codex-read-aloud-linux");
  const marketplace = path.join(
    installDir,
    "resources/plugins/openai-bundled/.agents/plugins/marketplace.json",
  );

  fs.mkdirSync(path.dirname(marketplace), { recursive: true });
  fs.writeFileSync(
    marketplace,
    JSON.stringify({
      plugins: [
        {
          name: "browser-use",
          source: { source: "local", path: "./plugins/browser-use" },
          policy: { installation: "AVAILABLE" },
        },
      ],
    }),
  );
  fs.writeFileSync(fakeBackend, "#!/bin/sh\nexit 0\n");
  fs.chmodSync(fakeBackend, 0o755);

  execFileSync("bash", [path.join(__dirname, "stage.sh")], {
    cwd: repoRoot,
    env: {
      ...process.env,
      SCRIPT_DIR: repoRoot,
      INSTALL_DIR: installDir,
      WORK_DIR: path.join(workspace, "work"),
      ARCH: process.arch === "arm64" ? "aarch64" : "x86_64",
      CODEX_UPSTREAM_APP_DIR: path.join(workspace, "Codex.app"),
      CODEX_LINUX_READ_ALOUD_MCP_SOURCE: fakeBackend,
      ICON_SOURCE: path.join(workspace, "missing-icon.png"),
    },
    stdio: "pipe",
  });

  const pluginDir = path.join(
    installDir,
    "resources/plugins/openai-bundled/plugins/read-aloud",
  );
  assert.equal(fs.existsSync(path.join(pluginDir, ".mcp.json")), true);
  assert.equal(fs.existsSync(path.join(pluginDir, "bin/codex-read-aloud-linux")), true);
  assert.equal(fs.existsSync(path.join(pluginDir, "bin/kokoro-stdin")), true);

  const parsedMarketplace = JSON.parse(fs.readFileSync(marketplace, "utf8"));
  assert.equal(
    parsedMarketplace.plugins.some(
      (plugin) =>
        plugin.name === "read-aloud" &&
        plugin.source?.path === "./plugins/read-aloud" &&
        plugin.policy?.authentication === "ON_INSTALL",
    ),
    true,
  );
});
