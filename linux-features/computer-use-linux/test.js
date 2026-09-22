"use strict";

const { applyLinuxComputerUsePluginGatePatch } = require("./plugin-gate.js");

const assert = require("node:assert/strict");
const { execFileSync } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const manifest = require("./feature.json");
const descriptors = require("./patch.js");
const {
  createPatchReport,
  enabledFeatureFailuresFromReport,
} = require("../../scripts/lib/patch-report.js");
const {
  applyMainBundlePatchDescriptors,
} = require("../../scripts/patches/engine.js");
const {
  applyLinuxComputerUseFeaturePatch,
  applyLinuxComputerUseHostPlatformPatch,
  matchesLinuxComputerUseHostPlatformContract,
} = require("../../scripts/patches/impl/computer-use.js");

test("computer-use-linux is opt-in and owns the current Linux descriptors", () => {
  assert.equal(manifest.defaultEnabled, false);
  assert.deepEqual(manifest.resources, [{
    source: "host-service.mjs",
    target: ".codex-linux/features/computer-use-linux/host-service.mjs",
    mode: "0644",
  }]);
  assert.deepEqual(Object.keys(manifest.runtimeHooks), ["launcher", "afterExit"]);
  assert.deepEqual(
    descriptors.map(({ id }) => id),
    [
      "unified-runtime",
      "avatar-cursor",
      "ui-feature",
      "plugin-gate",
      "native-desktop-apps",
      "ui-availability",
      "host-platform",
      "native-settings-visibility",
    ],
  );
  const visibility = descriptors.find(({ id }) => id === "native-settings-visibility");
  assert.equal(visibility.pattern.test("app-initial-3e128f859aa3.js"), true);
  assert.equal(visibility.pattern.test("app-primary-72206882651c.js"), false);
});

test("computer-use-linux staging consumes release artifacts without invoking Cargo", () => {
  const stage = fs.readFileSync(path.join(__dirname, "stage.sh"), "utf8");
  assert.doesNotMatch(stage, /cargo\s+(?:build|install)/);
  assert.match(stage, /target\/release\/codex-computer-use-linux/);
});

test("staging extends the hidden unified plugin and invalidates the browser-only cache", (t) => {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "computer-use-linux-stage-"));
  t.after(() => fs.rmSync(workspace, { recursive: true, force: true }));
  const installDir = path.join(workspace, "app");
  const target = path.join(installDir, "resources/plugins/openai-bundled/plugins/unified-computer-use");
  const marketplacePath = path.join(target, "../../.agents/plugins/marketplace.json");
  fs.mkdirSync(path.dirname(marketplacePath), { recursive: true });
  const marketplace = JSON.stringify({ plugins: [{ name: "unified-computer-use" }, { name: "browser" }] });
  fs.writeFileSync(marketplacePath, marketplace);
  fs.mkdirSync(path.join(target, "scripts"), { recursive: true });
  fs.mkdirSync(path.join(target, ".codex-plugin"));
  fs.writeFileSync(path.join(target, ".codex-plugin/plugin.json"), JSON.stringify({ name: "unified-computer-use", version: "26.908.31748", mcpServers: "./.mcp.json" }));
  fs.writeFileSync(path.join(target, ".mcp.json"), JSON.stringify({ mcpServers: { cua_repl: { command: "node", args: [], enabled: false } } }));
  const backend = path.join(workspace, "backend");
  fs.writeFileSync(backend, "#!/bin/sh\nexit 0\n", { mode: 0o755 });
  const env = { ...process.env, SCRIPT_DIR: path.resolve(__dirname, "../.."), INSTALL_DIR: installDir,
    CODEX_COMPUTER_USE_BINARY_SOURCE: backend, CODEX_COMPUTER_USE_COSMIC_BINARY_SOURCE: backend };
  const stage = () => execFileSync("bash", [path.join(__dirname, "stage.sh")], { env, stdio: "pipe" });
  const mcpPath = path.join(target, ".mcp.json");
  const originalMcp = fs.readFileSync(mcpPath, "utf8");
  const originalManifest = fs.readFileSync(path.join(target, ".codex-plugin/plugin.json"), "utf8");
  for (const invalid of [
    originalMcp.replace('"command":"node"', '"command":"changed"'),
    originalMcp.replace('"args":[]', '"args":["changed"]'),
    originalMcp.replace('"enabled":false', '"enabled":true'),
  ]) {
    fs.writeFileSync(mcpPath, invalid);
    assert.throws(stage, /unified.*contract/i);
    assert.equal(fs.readFileSync(mcpPath, "utf8"), invalid);
    assert.equal(fs.readFileSync(path.join(target, ".codex-plugin/plugin.json"), "utf8"), originalManifest);
    assert.equal(fs.readFileSync(marketplacePath, "utf8"), marketplace);
    assert.equal(fs.existsSync(path.join(target, "scripts/native-client.mjs")), false);
    assert.equal(fs.existsSync(path.join(target, "scripts/native-service.mjs")), false);
  }
  fs.writeFileSync(mcpPath, originalMcp);
  stage();
  const version = JSON.parse(fs.readFileSync(path.join(target, ".codex-plugin/plugin.json"))).version;
  assert.equal(version, "26.908.31748-linux-native.6");
  assert.deepEqual(JSON.parse(fs.readFileSync(marketplacePath)).plugins.map(p => p.name), ["unified-computer-use", "browser", "computer-use"]);
  const settingsManifest = JSON.parse(fs.readFileSync(path.join(target, "../computer-use/.codex-plugin/plugin.json")));
  assert.equal(settingsManifest.mcpServers, undefined);
  assert.equal(fs.existsSync(path.join(target, "../computer-use/.mcp.json")), false);
  assert.equal(fs.existsSync(path.join(target, "../computer-use/bin/codex-computer-use-linux")), false);
  assert.equal(fs.existsSync(path.join(target, "scripts/native-client.mjs")), true);
  assert.equal(fs.existsSync(path.join(target, "scripts/native-service.mjs")), true);
  assert.equal(fs.existsSync(path.join(target, "scripts/native-backend-service.mjs")), true);
  assert.equal(fs.existsSync(path.join(target, "scripts/native-protocol.mjs")), true);
  assert.equal(fs.readFileSync(path.join(target, "bin/codex-computer-use-linux"), "utf8"), fs.readFileSync(backend, "utf8"));
  const legacyMcp = path.join(target, "../computer-use/.mcp.json");
  fs.writeFileSync(legacyMcp, JSON.stringify({ mcpServers: { "computer-use": { command: "./bin/codex-computer-use-linux", args: ["mcp"] } } }));
  stage();
  assert.equal(fs.existsSync(legacyMcp), false);
  assert.equal(JSON.parse(fs.readFileSync(path.join(target, ".codex-plugin/plugin.json"))).version, version);
  const manifestPath = path.join(target, ".codex-plugin/plugin.json");
  const previousManifest = JSON.parse(fs.readFileSync(manifestPath));
  previousManifest.version = "26.901.41600-linux-native.1";
  fs.writeFileSync(manifestPath, JSON.stringify(previousManifest));
  stage();
  assert.equal(JSON.parse(fs.readFileSync(manifestPath)).version, "26.901.41600-linux-native.6");
  stage();
  assert.equal(JSON.parse(fs.readFileSync(manifestPath)).version, "26.901.41600-linux-native.6");
  fs.writeFileSync(mcpPath, "upstream drift");
  assert.throws(stage, /unified.*contract/i);
});

test("current host-platform contract enables Linux without dropping requirement gates", () => {
  const source = "function owner(){let feature={featureName:`computer_use`},p=`linux`,r=h({areRequirementsPending:a,areRequiredFeaturesEnabled:b,enabled:c,isBrowserAndComputerUseAllowed:d,isAnyFeatureLoading:e,isComputerUseGateEnabled:f,isHostCompatiblePlatform:g(p),isPlatformLoading:i,windowType:`electron`});return r}";
  const patched = applyLinuxComputerUseHostPlatformPatch(source);

  assert.notEqual(patched, source);
  assert.match(patched, /areRequirementsPending:a/);
  assert.match(patched, /isBrowserAndComputerUseAllowed:d/);
  assert.match(patched, /isHostCompatiblePlatform:p===`linux`\|\|g\(p\)/);
  assert.equal(matchesLinuxComputerUseHostPlatformContract(patched), true);
  assert.equal(applyLinuxComputerUseHostPlatformPatch(patched), patched);
});

test("retired host-platform contract is rejected byte-identically", () => {
  const source = "function owner(){let feature={featureName:`computer_use`},p=`linux`,r=h({areRequiredFeaturesEnabled:b,enabled:c,isAnyFeatureLoading:e,isComputerUseGateEnabled:f,isHostCompatiblePlatform:g(p),isPlatformLoading:i,windowType:`electron`});return r}";

  assert.equal(matchesLinuxComputerUseHostPlatformContract(source), false);
  assert.equal(applyLinuxComputerUseHostPlatformPatch(source), source);
});

test("incomplete patched host-platform contract is rejected byte-identically", () => {
  const source = "function owner(){let feature={featureName:`computer_use`},p=`linux`,r=h({areRequiredFeaturesEnabled:b,enabled:c,isBrowserAndComputerUseAllowed:d,isAnyFeatureLoading:e,isComputerUseGateEnabled:f,isHostCompatiblePlatform:p===`linux`||g(p),isPlatformLoading:i,windowType:`electron`});return r}";

  assert.equal(matchesLinuxComputerUseHostPlatformContract(source), false);
  assert.equal(applyLinuxComputerUseHostPlatformPatch(source), source);
});

test("duplicate patched host-platform contracts are rejected byte-identically", () => {
  const contract = "p=`linux`,r=h({areRequirementsPending:a,areRequiredFeaturesEnabled:b,enabled:c,isBrowserAndComputerUseAllowed:d,isAnyFeatureLoading:e,isComputerUseGateEnabled:f,isHostCompatiblePlatform:p===`linux`||g(p),isPlatformLoading:i,windowType:`electron`})";
  const source = `function first(){let feature={featureName:\`computer_use\`},${contract};return r}function second(){let feature={featureName:\`computer_use\`},${contract};return r}`;

  assert.equal(matchesLinuxComputerUseHostPlatformContract(source), false);
  assert.equal(applyLinuxComputerUseHostPlatformPatch(source), source);
});

test("mixed pristine and patched host-platform contracts are rejected byte-identically", () => {
  const pristine = "p=`linux`,r=h({areRequirementsPending:a,areRequiredFeaturesEnabled:b,enabled:c,isBrowserAndComputerUseAllowed:d,isAnyFeatureLoading:e,isComputerUseGateEnabled:f,isHostCompatiblePlatform:g(p),isPlatformLoading:i,windowType:`electron`})";
  const patched = "q=`linux`,s=j({areRequirementsPending:k,areRequiredFeaturesEnabled:l,enabled:m,isBrowserAndComputerUseAllowed:n,isAnyFeatureLoading:o,isComputerUseGateEnabled:t,isHostCompatiblePlatform:q===`linux`||u(q),isPlatformLoading:v,windowType:`electron`})";
  const source = `function owner(){let feature={featureName:\`computer_use\`},${pristine},${patched};return[r,s]}`;

  assert.equal(matchesLinuxComputerUseHostPlatformContract(source), false);
  assert.equal(applyLinuxComputerUseHostPlatformPatch(source), source);
});

test("malformed patched host-platform variable relationship is rejected byte-identically", () => {
  const source = "function owner(){let feature={featureName:`computer_use`},p=`linux`,q=`darwin`,r=h({areRequirementsPending:a,areRequiredFeaturesEnabled:b,enabled:c,isBrowserAndComputerUseAllowed:d,isAnyFeatureLoading:e,isComputerUseGateEnabled:f,isHostCompatiblePlatform:p===`linux`||g(q),isPlatformLoading:i,windowType:`electron`});return r}";

  assert.equal(matchesLinuxComputerUseHostPlatformContract(source), false);
  assert.equal(applyLinuxComputerUseHostPlatformPatch(source), source);
});

const nativeRegistration = "{...n.nc.computerUse,autoInstallOptOutKey:n.sc(n.nc.computerUse.name),isAvailable:({features:e,platform:t})=>(t===`darwin`||t===`win32`)&&e.computerUse}";
const registrationFixture = `var kd=[${nativeRegistration}];`;

function evaluateNativeRegistration(source) {
  const n = {
    nc: { computerUse: { name: "computer-use", installWhenMissing: true, installWhenMissingRequiresOptIn: true } },
    sc: name => `auto-install-opt-out:${name}`,
  };
  return new Function("n", `${source};return kd`)(n);
}

test("current native registration enables Linux while preserving shared consent metadata", () => {
  const source = applyLinuxComputerUsePluginGatePatch(registrationFixture);
  const [native] = evaluateNativeRegistration(source);
  assert.equal(evaluateNativeRegistration(source).length, 1);
  for (const platform of ["linux", "darwin", "win32", "freebsd"]) {
    for (const computerUse of [false, true]) {
      const context = { platform, features: { computerUse } };
      assert.equal(
        native.isAvailable(context),
        computerUse && ["linux", "darwin", "win32"].includes(platform),
      );
    }
  }
  assert.equal(native.installWhenMissingRequiresOptIn, true);
  assert.equal(native.installWhenMissing, true);
  assert.equal(native.autoInstallOptOutKey, "auto-install-opt-out:computer-use");
  assert.equal(applyLinuxComputerUsePluginGatePatch(source), source);
});

test("native registration matching follows renamed aliases and preserves unrelated browser descriptors", () => {
  const browser = "{...n.nc.browser,isAvailable:({features:e})=>e.computerUse||e.externalBrowserUse}";
  const fixture = registrationFixture.replace("var kd=[", `var kd=[${browser},`).replaceAll("n.nc", "q.registry").replaceAll("n.sc", "q.optOut").replaceAll("features:e,platform:t", "features:flags,platform:os").replaceAll("t===", "os===").replaceAll("e.computerUse", "flags.computerUse");
  const result = applyLinuxComputerUsePluginGatePatch(fixture);
  assert.ok(result.includes("os===`linux`)&&flags.computerUse"));
  assert.ok(result.includes(browser.replaceAll("n.nc", "q.registry").replaceAll("e.computerUse", "flags.computerUse")));
});

for (const [name, fixture] of [
  ["missing registration", "var kd=[];"],
  ["duplicate native registration", registrationFixture.replace(nativeRegistration, `${nativeRegistration},${nativeRegistration}`)],
  ["mixed patched and original registration", registrationFixture + applyLinuxComputerUsePluginGatePatch(registrationFixture)],
  ["wrong opt-out reference", registrationFixture.replace("n.sc(n.nc.computerUse.name)", "n.sc(n.nc.browser.name)")],
  ["unsupported gate", registrationFixture.replace("(t===`darwin`||t===`win32`)&&e.computerUse", "t===`darwin`||e.computerUse")],
]) {
  test(`native plugin patch rejects ${name}`, () => {
    assert.throws(() => applyLinuxComputerUsePluginGatePatch(fixture), /Required Linux Computer Use plugin gate patch failed/);
  });
}


test("native plugin patch rejects partial Linux registrations", () => {
  const patched = applyLinuxComputerUsePluginGatePatch(registrationFixture);
  for (const bad of [
    patched.replace("||t===`linux`", "||t===`freebsd`"),
    patched.replace(")&&e.computerUse", ")||e.computerUse"),
    patched.replace(".name),isAvailable", ".name),installWhenMissing:!0,isAvailable"),
  ]) {
    assert.throws(() => applyLinuxComputerUsePluginGatePatch(bad), /Required Linux Computer Use plugin gate patch failed/);
  }
});

test("desktop feature gate enables Linux in the unique current Windows override", () => {
  const current = "function features(e,n,r){let i=r===`win32`&&n.CODEX_ELECTRON_ENABLE_WINDOWS_COMPUTER_USE===`1`?{...e,computerUse:!0}:e,o=i;return o}";
  const patched = applyLinuxComputerUseFeaturePatch(current);
  assert.match(patched, /r===`linux`\?\{\.\.\.e,computerUse:!0\}:r===`win32`/);
  assert.equal(applyLinuxComputerUseFeaturePatch(patched), patched);
  assert.equal(new Function("e", "n", "r", `${patched};return features(e,n,r).computerUse`)(
    { computerUse: false }, {}, "linux",
  ), true);
});

test("desktop feature gate rejects missing, duplicate, and partial current contracts byte-identically", () => {
  const current = "function features(e,n,r){let i=r===`win32`&&n.CODEX_ELECTRON_ENABLE_WINDOWS_COMPUTER_USE===`1`?{...e,computerUse:!0}:e;return i}";
  const patched = applyLinuxComputerUseFeaturePatch(current);
  for (const source of [
    current + current,
    patched + current,
    current.replace("computerUse:!0", "computerUse:!1"),
  ]) {
    assert.equal(applyLinuxComputerUseFeaturePatch(source), source);
  }
});

test("anchor-free desktop feature gate reports enabled-feature drift", () => {
  const source = "function unrelated(){return!0}";
  const descriptor = {
    ...descriptors.find(({ id }) => id === "ui-feature"),
    featureId: "computer-use-linux",
    sourceKind: "feature",
  };
  const report = createPatchReport();
  report.enabledFeatures = ["computer-use-linux"];

  const result = applyMainBundlePatchDescriptors(source, [descriptor], {}, report);

  assert.equal(result.patchedSource, source);
  assert.equal(result.warnings.length, 1);
  assert.match(result.warnings[0], /Could not find Computer Use desktop feature gate/);
  assert.equal(report.patches[0].status, "skipped-optional");
  assert.notEqual(report.patches[0].status, "already-applied");
  assert.equal(enabledFeatureFailuresFromReport(report).length, 1);
});
