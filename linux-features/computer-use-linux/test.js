"use strict";

const assert = require("node:assert/strict");
const { execFileSync } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const manifest = require("./feature.json");
const descriptors = require("./patch.js");
const {
  applyLinuxComputerUseHostPlatformPatch,
  matchesLinuxComputerUseHostPlatformContract,
} = require("../../scripts/patches/impl/computer-use.js");

test("computer-use-linux is opt-in and owns the current Linux descriptors", () => {
  assert.equal(manifest.defaultEnabled, false);
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
  fs.writeFileSync(path.join(target, ".codex-plugin/plugin.json"), JSON.stringify({ name: "unified-computer-use", version: "26.901.41600" }));
  fs.writeFileSync(path.join(target, "scripts/launch.mjs"), 'const env = {NODE_REPL_TRUSTED_SERVICES: JSON.stringify({sky:"@oai/sky/service"}),NODE_REPL_JS_BANNER: banner,};');
  const backend = path.join(workspace, "backend");
  fs.writeFileSync(backend, "#!/bin/sh\nexit 0\n", { mode: 0o755 });
  const env = { ...process.env, SCRIPT_DIR: path.resolve(__dirname, "../.."), INSTALL_DIR: installDir,
    CODEX_COMPUTER_USE_BINARY_SOURCE: backend, CODEX_COMPUTER_USE_COSMIC_BINARY_SOURCE: backend };
  const stage = () => execFileSync("bash", [path.join(__dirname, "stage.sh")], { env, stdio: "pipe" });
  stage();
  const version = JSON.parse(fs.readFileSync(path.join(target, ".codex-plugin/plugin.json"))).version;
  assert.notEqual(version, "26.901.41600");
  assert.deepEqual(JSON.parse(fs.readFileSync(marketplacePath)).plugins.map(p => p.name), ["unified-computer-use", "browser", "computer-use"]);
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(target, "../computer-use/.mcp.json"))), { mcpServers: {} });
  assert.equal(fs.existsSync(path.join(target, "../computer-use/bin/codex-computer-use-linux")), false);
  assert.equal(fs.existsSync(path.join(target, "scripts/native-service.mjs")), true);
  assert.equal(fs.readFileSync(path.join(target, "bin/codex-computer-use-linux"), "utf8"), fs.readFileSync(backend, "utf8"));
  stage();
  assert.equal(JSON.parse(fs.readFileSync(path.join(target, ".codex-plugin/plugin.json"))).version, version);
  fs.writeFileSync(path.join(target, "scripts/launch.mjs"), "upstream drift");
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
