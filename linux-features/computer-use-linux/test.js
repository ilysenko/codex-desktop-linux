"use strict";

const assert = require("node:assert/strict");
const { execFileSync } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const vm = require("node:vm");

const manifest = require("./feature.json");
const descriptors = require("./patch.js");
const { applyLinuxComputerUsePluginGatePatch } = require("./plugin-gate.js");
const {
  applyLinuxComputerUseHostPlatformPatch,
  matchesLinuxComputerUseHostPlatformContract,
} = require("../../scripts/patches/impl/computer-use.js");

test("computer-use-linux is opt-in and owns the current Linux descriptors", () => {
  assert.equal(manifest.defaultEnabled, false);
  assert.deepEqual(
    descriptors.map(({ id }) => id),
    [
      "avatar-cursor",
      "ui-feature",
      "plugin-gate",
      "native-desktop-apps",
      "ui-availability",
      "host-platform",
    ],
  );
});

test("computer-use-linux staging consumes release artifacts without invoking Cargo", () => {
  const stage = fs.readFileSync(path.join(__dirname, "stage.sh"), "utf8");
  assert.doesNotMatch(stage, /cargo\s+(?:build|install)/);
  assert.match(stage, /target\/release\/codex-computer-use-linux/);
});

test("computer-use-linux staging registers the bundled plugin idempotently", (t) => {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "computer-use-linux-stage-"));
  t.after(() => fs.rmSync(workspace, { recursive: true, force: true }));

  const installDir = path.join(workspace, "app");
  const releaseDir = path.join(workspace, "target", "release");
  const marketplacePath = path.join(
    installDir,
    "resources/plugins/openai-bundled/.agents/plugins/marketplace.json",
  );
  fs.mkdirSync(path.dirname(marketplacePath), { recursive: true });
  fs.writeFileSync(
    marketplacePath,
    `${JSON.stringify({ plugins: [{ name: "browser", source: { source: "local", path: "./plugins/browser" } }] })}\n`,
  );
  fs.mkdirSync(releaseDir, { recursive: true });
  for (const binary of ["codex-computer-use-linux", "codex-computer-use-cosmic"]) {
    const binaryPath = path.join(releaseDir, binary);
    fs.writeFileSync(binaryPath, "#!/bin/sh\nexit 0\n", { mode: 0o755 });
  }

  const env = {
    ...process.env,
    SCRIPT_DIR: workspace,
    INSTALL_DIR: installDir,
    CODEX_COMPUTER_USE_BINARY_SOURCE: path.join(releaseDir, "codex-computer-use-linux"),
    CODEX_COMPUTER_USE_COSMIC_BINARY_SOURCE: path.join(releaseDir, "codex-computer-use-cosmic"),
  };
  fs.mkdirSync(path.join(workspace, "plugins/openai-bundled/plugins"), { recursive: true });
  fs.cpSync(
    path.resolve(__dirname, "../../plugins/openai-bundled/plugins/computer-use"),
    path.join(workspace, "plugins/openai-bundled/plugins/computer-use"),
    { recursive: true },
  );

  execFileSync("bash", [path.join(__dirname, "stage.sh")], { env });
  execFileSync("bash", [path.join(__dirname, "stage.sh")], { env });

  const marketplace = JSON.parse(fs.readFileSync(marketplacePath, "utf8"));
  assert.equal(marketplace.plugins.filter(({ name }) => name === "computer-use").length, 1);
  assert.ok(marketplace.plugins.some(({ name }) => name === "browser"));
  assert.deepEqual(
    marketplace.plugins.find(({ name }) => name === "computer-use"),
    {
      name: "computer-use",
      source: { source: "local", path: "./plugins/computer-use" },
      policy: { installation: "AVAILABLE", authentication: "ON_INSTALL" },
      category: "Productivity",
    },
  );
  assert.equal(
    fs.existsSync(
      path.join(
        installDir,
        "resources/plugins/openai-bundled/plugins/computer-use/bin/codex-computer-use-linux",
      ),
    ),
    true,
  );
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

const currentPluginRegistry = "var defs={computerUse:{name:`computer-use`,installWhenMissing:!0,installWhenMissingRequiresOptIn:!0}},optOut=e=>e,migrate=()=>{};var plugins=[{...defs.computerUse,autoInstallOptOutKey:optOut(defs.computerUse.name),isAvailable:({features:f,platform:p})=>p===`darwin`&&f.computerUse,migrate:migrate},{...defs.computerUse,autoInstallOptOutKey:optOut(defs.computerUse.name),isAvailable:({features:f,platform:p})=>p===`win32`&&f.computerUse}];";

const currentMarketplaceSelector = "function choose(e){if(!(e.platform!==`darwin`||!e.marketplacePluginNames.includes(`computer-use`)))return e.desktopFeatureAvailability.computerUseNodeRepl?`node-repl`:`legacy-mcp`}";

test("current spread registry exposes exactly one Linux plugin without inherited install opt-in", () => {
  const patched = applyLinuxComputerUsePluginGatePatch(currentPluginRegistry + currentMarketplaceSelector);
  const registry = vm.runInNewContext(`${patched};plugins`);
  for (const enabled of [false, true]) {
    const linux = registry.filter((plugin) =>
      plugin.isAvailable({ platform: "linux", features: { computerUse: enabled } }),
    );
    assert.equal(linux.length, 1);
    assert.equal(linux[0].name, "computer-use");
    assert.equal(linux[0].installWhenMissing, true);
    assert.equal(linux[0].installWhenMissingRequiresOptIn, false);
  }
  for (const platform of ["darwin", "win32"]) {
    for (const enabled of [false, true]) {
      const available = registry.filter((plugin) =>
        plugin.isAvailable({ platform, features: { computerUse: enabled } }),
      );
      assert.equal(available.length, enabled ? 1 : 0);
    }
  }
  assert.equal(registry[1].installWhenMissingRequiresOptIn, true);
  assert.equal(applyLinuxComputerUsePluginGatePatch(patched), patched);
});

test("plugin gate fails closed for missing, ambiguous, or changed availability contracts", () => {
  const selector = "function choose(e){if(!((e.platform!==`darwin`&&e.platform!==`linux`)||!e.marketplacePluginNames.includes(`computer-use`)))return e.platform===`darwin`&&e.desktopFeatureAvailability.computerUseNodeRepl?`node-repl`:`legacy-mcp`}";
  assert.throws(() => applyLinuxComputerUsePluginGatePatch(selector), /found 0/);
  assert.throws(() => applyLinuxComputerUsePluginGatePatch(currentPluginRegistry + currentPluginRegistry), /found 2/);
  const changedRegistry = currentPluginRegistry.replace(
    "p===`darwin`&&f.computerUse",
    "p===`darwin`&&f.computerUse&&f.newGate",
  );
  assert.throws(() => applyLinuxComputerUsePluginGatePatch(changedRegistry), /expression changed/);
});

test("Linux keeps the legacy MCP skill selector with the current registry", () => {
  const selector = "function choose(e){if(!(e.platform!==`darwin`||!e.marketplacePluginNames.includes(`computer-use`)))return e.desktopFeatureAvailability.computerUseNodeRepl?`node-repl`:`legacy-mcp`}";
  const choose = vm.runInNewContext(`${applyLinuxComputerUsePluginGatePatch(currentPluginRegistry + selector)};choose`);
  assert.equal(
    choose({
      platform: "linux",
      marketplacePluginNames: ["computer-use"],
      desktopFeatureAvailability: { computerUseNodeRepl: true },
    }),
    "legacy-mcp",
  );
});


test("marketplace selector requires exactly one pristine or patched contract", () => {
  const patchedSource = applyLinuxComputerUsePluginGatePatch(currentPluginRegistry + currentMarketplaceSelector);
  const patchedSelector = patchedSource.slice(patchedSource.indexOf("function choose"));
  for (const selector of [currentMarketplaceSelector, patchedSelector]) {
    const source = currentPluginRegistry + selector;
    const patched = applyLinuxComputerUsePluginGatePatch(source);
    assert.equal(applyLinuxComputerUsePluginGatePatch(patched), patched);
    assert.throws(
      () => applyLinuxComputerUsePluginGatePatch(source + selector),
      /marketplace selector, found 2/,
    );
  }
  assert.throws(
    () => applyLinuxComputerUsePluginGatePatch(currentPluginRegistry),
    /marketplace selector, found 0/,
  );
  assert.throws(
    () => applyLinuxComputerUsePluginGatePatch(patchedSource + currentMarketplaceSelector),
    /marketplace selector, found 2/,
  );
  for (const selector of [currentMarketplaceSelector, patchedSelector]) {
    for (const changed of [
      selector.replace("computerUseNodeRepl", "newGate"),
      selector.replace("`legacy-mcp`", "`other-backend`"),
      selector.replace("e.desktopFeatureAvailability", "other.desktopFeatureAvailability"),
      selector.replace("e.platform", "other.platform"),
      selector.replace("return ", "return extra&&"),
    ]) {
      assert.throws(
        () => applyLinuxComputerUsePluginGatePatch(currentPluginRegistry + changed),
        /marketplace selector changed/,
      );
      assert.throws(
        () => applyLinuxComputerUsePluginGatePatch(currentPluginRegistry + selector + changed),
        /marketplace selector changed/,
      );
    }
  }
});
