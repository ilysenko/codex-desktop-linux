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
    "var Kr=[{...n.Ds.codexAppTools,isAvailable:()=>!0},{...n.Ds.browser,autoInstallOptOutKey:n.As(n.Ds.browser.name),isAvailable:({features:e})=>e.inAppBrowserUseAllowed},{...n.Ds.computerUse,autoInstallOptOutKey:n.As(n.Ds.computerUse.name),isAvailable:({features:e,platform:t})=>t===`darwin`&&e.computerUse},{...n.Ds.computerUse,autoInstallOptOutKey:n.As(n.Ds.computerUse.name),isAvailable:({features:e,platform:t})=>t===`win32`&&e.computerUse},{...n.Ds.latex,isAvailable:()=>!0},{...n.Ds.visualize,syncToRemoteSshHosts:!0,isAvailable:()=>!0}];",
  ].join("");

  const patched = applyPatchTwice(applyLinuxReadAloudPluginGatePatch, source);

  assert.match(
    patched,
    /\{installWhenMissing:!0,name:`read-aloud`,isAvailable:\(\{platform:e\}\)=>e===`linux`\},\{\.\.\.n\.Ds\.latex,isAvailable:\(\)=>!0\}/,
  );
});

test("read-aloud-mcp plugin gate ignores unrelated read-aloud strings", () => {
  const source = [
    "function codexLinuxReadAloudSettings(){return `read-aloud-settings`}",
    "var Kr=[{...r.plugins.browser,autoInstallOptOutKey:r.opt(r.plugins.browser.name),isAvailable:()=>!0},{...r.plugins.computerUse,autoInstallOptOutKey:r.opt(r.plugins.computerUse.name),isAvailable:()=>!0},{...r.plugins.latex,isAvailable:()=>!0},{...r.plugins.visualize,isAvailable:()=>!0}];",
  ].join("");

  const patched = applyLinuxReadAloudPluginGatePatch(source);

  assert.match(
    patched,
    /name:`read-aloud`,isAvailable:\(\{platform:e\}\)=>e===`linux`/,
  );
});

test("read-aloud-mcp plugin gate rejects a descriptor array missing current semantic anchors", () => {
  const source = [
    "var ti=[{...n.Ds.computerUse,autoInstallOptOutKey:n.As(n.Ds.computerUse.name),isAvailable:()=>!0},{...n.Ds.latex,isAvailable:()=>!0}];",
  ].join("");

  assert.throws(
    () => applyLinuxReadAloudPluginGatePatch(source),
    /could not find bundled plugin descriptor array/,
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
      CODEX_UPSTREAM_APP_DIR: path.join(workspace, "upstream", "usr", "lib", "chatgpt"),
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

test("read-aloud-mcp stage hook consumes a release artifact without invoking Cargo", () => {
  const stage = fs.readFileSync(path.join(__dirname, "stage.sh"), "utf8");
  assert.doesNotMatch(stage, /cargo\s+(?:build|install)/);
  assert.match(stage, /target\/release\/codex-read-aloud-linux/);
});
