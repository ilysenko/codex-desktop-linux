#!/usr/bin/env node
"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const {
  enabledLinuxFeatureIds,
  loadLinuxFeaturePatchDescriptors,
} = require("../../scripts/lib/linux-features.js");
const {
  createPatchReport,
} = require("../../scripts/lib/patch-report.js");
const {
  patchExtractedApp,
} = require("../../scripts/patches/runner.js");
const {
  descriptors: featurePatches,
} = require("./patch.js");

function withTempFeatureConfig(enabled, fn) {
  const originalConfig = process.env.CODEX_LINUX_FEATURES_CONFIG;
  const root = path.resolve(__dirname, "..");
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "codex-remote-control-feature-test-"));
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
  console.warn = (...args) => {
    warnings.push(args.map(String).join(" "));
  };
  try {
    return { value: fn(), warnings };
  } finally {
    console.warn = originalWarn;
  }
}

test("remote-control UI feature stays disabled until listed in features.json", () => {
  withTempFeatureConfig([], (root) => {
    assert.deepEqual(enabledLinuxFeatureIds({ featuresRoot: root }), []);
    assert.deepEqual(loadLinuxFeaturePatchDescriptors({ featuresRoot: root }), []);
  });
});

test("remote-control UI feature exposes optional webview asset descriptors when enabled", () => {
  withTempFeatureConfig(["remote-control-ui"], (root) => {
    assert.deepEqual(enabledLinuxFeatureIds({ featuresRoot: root }), ["remote-control-ui"]);

    const patches = loadLinuxFeaturePatchDescriptors({ featuresRoot: root });
    assert.equal(patches.length, 3);
    assert.deepEqual(
      patches.map((patch) => [patch.name, patch.phase, patch.ciPolicy]),
      [
        ["feature:remote-control-ui:remote-connections-visibility", "webview-asset", "optional"],
        ["feature:remote-control-ui:remote-control-connections-visibility", "webview-asset", "optional"],
        ["feature:remote-control-ui:experimental-features", "webview-asset", "optional"],
      ],
    );
  });
});

// rspack/SWC fixtures: jotai atoms read the Statsig gate through their getter,
// strings are double-quoted and comparisons are literal-first.
const REMOTE_CONNECTIONS_SOURCE =
  'let d=(0,r.un)(s.u,({get:e})=>{let t=e(i.Dc),{data:n}=e(a.I2,t),r=e(l.JW,"4114442250");if(!0===n?.config["features.remote_connections"])return!0;let s=n?.config.features;return null==s||"object"!=typeof s||Array.isArray(s)?r:Object.getOwnPropertyDescriptor(s,"remote_connections")?.value===!0||r});' +
  'let m=(0,r.un)(l.u,({get:e})=>{let t=e(a.Dc),n=e(s.I2,t);if(e(p.JW,"4114442250"))return"enabled";if(n.isLoading)return"loading";return"disabled"});';
const REMOTE_CONTROL_CONNECTIONS_SOURCE =
  "function r({remoteControlConnectionsState:e,slingshotEnabled:t}){return t&&(e?.available??!0)&&e?.accessRequired!==!0}";
const EXPERIMENTAL_FEATURES_SOURCE =
  'v6J2(e,t,n){var s=n("DBCl"),i=n("TjCl"),a=n("b6Vw");function r(e){return"beta"===e.stage&&e.name!==i.j&&"multi_agent"!==e.name&&"plugins"!==e.name&&"plugin"!==e.name&&"remote_control"!==e.name&&!e.name.startsWith("realtime_")&&e.name!==a.c&&e.name!==s.R1o}n.d(t,{R:()=>r})}';

function rspackChunk(id, modules) {
  return `export const __rspack_esm_id=${id};export const __rspack_esm_ids=[${id}];export const __webpack_modules__={${modules}};`;
}

test("remote-control UI feature patches are idempotent and fail soft", () => {
  const remoteConnectionsPatch = featurePatches.find((patch) => patch.id === "remote-connections-visibility");
  const remoteControlConnectionsPatch = featurePatches.find((patch) => patch.id === "remote-control-connections-visibility");
  const experimentalFeaturesPatch = featurePatches.find((patch) => patch.id === "experimental-features");

  const remoteConnectionsPatched = remoteConnectionsPatch.apply(REMOTE_CONNECTIONS_SOURCE, {});
  assert.match(remoteConnectionsPatched, /r=\(e\(l\.JW,"4114442250"\)\|\|navigator\.userAgent\.includes\(`Linux`\)\);/);
  assert.match(remoteConnectionsPatched, /if\(\(e\(p\.JW,"4114442250"\)\|\|navigator\.userAgent\.includes\(`Linux`\)\)\)return"enabled"/);
  assert.equal(remoteConnectionsPatch.apply(remoteConnectionsPatched, {}), remoteConnectionsPatched);
  const atoms = new Function("navigator", "r", "s", "i", "a", "l", "p",
    `${remoteConnectionsPatched.replaceAll("let ", "var ")};return{d,m}`);
  const get = (gate) => (atom) => atom === "gate" ? gate : atom === "config" ? { data: { config: {} }, isLoading: false } : null;
  const result = atoms({ userAgent: "X11; Linux x86_64" }, { un: (_scope, read) => read }, { u: 0, I2: "config" },
    { Dc: "host" }, { I2: "config", Dc: "host" }, { JW: "gate", u: 0 }, { JW: "gate" });
  const linuxGet = (atom, _arg) => get(false)(atom);
  assert.equal(result.d({ get: linuxGet }), true);
  assert.equal(result.m({ get: linuxGet }), "enabled");

  const currentRemoteControlConnectionsPatched = remoteControlConnectionsPatch.apply(REMOTE_CONTROL_CONNECTIONS_SOURCE, {});
  assert.match(currentRemoteControlConnectionsPatched, /\(t\|\|navigator\.userAgent\.includes\(`Linux`\)\)&&\(e\?\.available\?\?!0\)/);
  const { value: remoteControlPatchedAgain, warnings: remoteControlPatchedAgainWarnings } = captureWarns(() =>
    remoteControlConnectionsPatch.apply(currentRemoteControlConnectionsPatched, {}),
  );
  assert.equal(remoteControlPatchedAgain, currentRemoteControlConnectionsPatched);
  assert.deepEqual(remoteControlPatchedAgainWarnings, []);

  const currentGate = new Function(
    "remoteControlConnectionsState",
    "slingshotEnabled",
    "navigator",
    `${currentRemoteControlConnectionsPatched};return r({remoteControlConnectionsState,slingshotEnabled})`,
  );
  const linuxNavigator = { userAgent: "Linux" };
  assert.equal(currentGate({ available: false, accessRequired: false }, false, linuxNavigator), false);
  assert.equal(currentGate({ available: true, accessRequired: true }, false, linuxNavigator), false);
  assert.equal(currentGate({ available: true, accessRequired: false }, false, linuxNavigator), true);

  const filtered = experimentalFeaturesPatch.apply(EXPERIMENTAL_FEATURES_SOURCE, {});
  assert.doesNotMatch(filtered, /remote_control/);
  assert.match(filtered, /"plugin"!==e\.name&&!e\.name\.startsWith\("realtime_"\)/);
  const { value: filteredAgain, warnings: filteredAgainWarnings } = captureWarns(() =>
    experimentalFeaturesPatch.apply(filtered, {}),
  );
  assert.equal(filteredAgain, filtered);
  assert.deepEqual(filteredAgainWarnings, []);
  const visible = new Function(`${filtered.replace(/^v6J2\(e,t,n\)\{var s=n\("DBCl"\),i=n\("TjCl"\),a=n\("b6Vw"\);/, "var s={R1o:'x'},i={j:'y'},a={c:'z'};").replace(/n\.d\(t,\{R:\(\)=>r\}\)\}$/, "")};return r`)();
  assert.equal(visible({ stage: "beta", name: "remote_control" }), true);
  assert.equal(visible({ stage: "beta", name: "multi_agent" }), false);

  for (const [patch, drifted, message] of [
    [remoteConnectionsPatch, "real codex bundle", /Could not find remote connections Statsig gate/],
    [remoteConnectionsPatch, 'const unrelated=flag||navigator.userAgent.includes(`Linux`);const gate=get("4114442250")', /Could not find remote connections Statsig gate/],
    [remoteControlConnectionsPatch, "const unrelated=(flag||navigator.userAgent.includes(`Linux`))&&other;function RD(){return enabled&&state?.available}", /Could not find remote control connections visibility gate/],
    [experimentalFeaturesPatch, EXPERIMENTAL_FEATURES_SOURCE.replaceAll('"', "`"), /Could not find remote_control experimental feature filter/],
    [experimentalFeaturesPatch, EXPERIMENTAL_FEATURES_SOURCE + EXPERIMENTAL_FEATURES_SOURCE, /Could not find remote_control experimental feature filter/],
  ]) {
    const { value, warnings } = captureWarns(() => patch.apply(drifted, {}));
    assert.equal(value, drifted);
    assert.match(warnings.join("\n"), message);
  }
});

test("remote-control UI descriptors find rspack chunks by content", () => {
  for (const patch of featurePatches) {
    assert.equal(patch.pattern, undefined, patch.id);
    assert.equal(patch.assetPattern, undefined, patch.id);
    assert.equal(patch.assetMatch, undefined, `${patch.id} patches every chunk copy of its module`);
    assert.ok(patch.assetNeedles.length > 0, patch.id);
  }
  const needles = Object.fromEntries(featurePatches.map((patch) => [patch.id, patch.assetNeedles]));
  const has = (id, source) => needles[id].every((needle) => source.includes(needle));
  assert.equal(has("remote-connections-visibility", REMOTE_CONNECTIONS_SOURCE), true);
  assert.equal(has("remote-control-connections-visibility", REMOTE_CONTROL_CONNECTIONS_SOURCE), true);
  assert.equal(has("experimental-features", EXPERIMENTAL_FEATURES_SOURCE), true);
  assert.equal(has("experimental-features", featurePatches[2].apply(EXPERIMENTAL_FEATURES_SOURCE, {})), true);
});

test("remote-control visibility edits only its unique destructured owner", () => {
  const patch = featurePatches.find((candidate) => candidate.id === "remote-control-connections-visibility");
  const unrelated = "function other(){return x&&(y?.available??!0)&&y?.accessRequired!==!0}";
  const owner =
    "function a({remoteControlConnectionsState:e,slingshotEnabled:t}){return t&&(e?.available??!0)&&e?.accessRequired!==!0}";
  const source = unrelated + owner;
  const patched = patch.apply(source, {});

  assert.equal(patched.slice(0, unrelated.length), unrelated);
  assert.match(patched.slice(unrelated.length), /\(t\|\|navigator\.userAgent\.includes\(`Linux`\)\)/u);
});

test("remote-control visibility rejects duplicate and partial owners byte-identically", () => {
  const patch = featurePatches.find((candidate) => candidate.id === "remote-control-connections-visibility");
  const current =
    "function a({remoteControlConnectionsState:e,slingshotEnabled:t}){return t&&(e?.available??!0)&&e?.accessRequired!==!0}";
  const patched = patch.apply(current, {});
  const partial = current.replace("e?.accessRequired!==!0", "e?.accessRequired===!1");

  for (const source of [current + current, current + patched, partial]) {
    const result = captureWarns(() => patch.apply(source, {}));
    assert.equal(result.value, source);
    assert.match(result.warnings.join("\n"), /Could not find remote control connections visibility gate/);
  }
});

test("remote-control visibility validates the earlier remote-mobile owner before marking it", () => {
  const patch = featurePatches.find((candidate) => candidate.id === "remote-control-connections-visibility");
  const mobile =
    "function a({remoteControlConnectionsState:e,slingshotEnabled:n}){let codexLinuxRemoteControlOnLinux=typeof navigator!=`undefined`&&navigator.userAgent.includes(`Linux`);/*codexLinuxRemoteControlVisibilityEnabled*/return(codexLinuxRemoteControlOnLinux||n)&&(codexLinuxRemoteControlOnLinux||(e?.available??!0))&&e?.accessRequired!==!0}";
  const patched = patch.apply(mobile, {});

  assert.match(patched, /codexLinuxRemoteControlVisibilityEnabled\*\/\/\*codexLinuxRemoteControlUiVisibilityEnabled/u);
  assert.equal(patch.apply(patched, {}), patched);

  const ambiguous = mobile + mobile;
  const result = captureWarns(() => patch.apply(ambiguous, {}));
  assert.equal(result.value, ambiguous);
  assert.match(result.warnings.join("\n"), /Could not find remote control connections visibility gate/);
});

test("remote-control UI feature patches every rspack chunk copy and records patch report entries", () => {
  withTempFeatureConfig(["remote-control-ui"], (root) => {
    withLinuxFeatureRootEnv(root, () => {
      const tempApp = fs.mkdtempSync(path.join(os.tmpdir(), "codex-remote-control-feature-app-"));
      try {
        const buildDir = path.join(tempApp, ".vite", "build");
        const assetsDir = path.join(tempApp, "webview", "assets");
        fs.mkdirSync(path.join(assetsDir, "async"), { recursive: true });
        fs.mkdirSync(buildDir, { recursive: true });
        fs.writeFileSync(path.join(buildDir, "main.js"), "console.log('main bundle');");
        fs.writeFileSync(path.join(tempApp, "package.json"), JSON.stringify({ name: "codex" }));

        const chunks = {
          "async/24191.7b05d5cf83.js": rspackChunk(24191, `PIwo(e,t,n){${REMOTE_CONNECTIONS_SOURCE}}`),
          "async/435221.eac941d988.js": rspackChunk(435221, `uodG(e,t,n){${REMOTE_CONTROL_CONNECTIONS_SOURCE}n.d(t,{Zi:()=>r})}`),
          "async/446738.83dee6513b.js": rspackChunk(446738, `uodG(e,s,t){${REMOTE_CONTROL_CONNECTIONS_SOURCE.replace("slingshotEnabled:t}){return t&&", "slingshotEnabled:s}){return s&&")}t.d(s,{Zi:()=>r})}`),
          "async/208689.77fb5123f8.js": rspackChunk(208689, EXPERIMENTAL_FEATURES_SOURCE),
          "async/968499.fa029184f4.js": rspackChunk(968499, EXPERIMENTAL_FEATURES_SOURCE),
          "async/1.decoy.js": rspackChunk(1, 'abcd(e,t,n){let x="remoteControlConnectionsState:"}'),
        };
        for (const [name, source] of Object.entries(chunks)) fs.writeFileSync(path.join(assetsDir, name), source);

        const report = createPatchReport();
        const { warnings } = captureWarns(() => patchExtractedApp(tempApp, { report }));
        assert.ok(
          warnings.every((warning) => !warning.includes("remote control UI")),
          warnings.join("\n"),
        );

        const read = (name) => fs.readFileSync(path.join(assetsDir, name), "utf8");
        assert.equal(read("async/24191.7b05d5cf83.js").split("||navigator.userAgent.includes(`Linux`)").length - 1, 2);
        for (const name of ["async/435221.eac941d988.js", "async/446738.83dee6513b.js"]) {
          assert.match(read(name), /\|\|navigator\.userAgent\.includes\(`Linux`\)\)&&\(e\?\.available/);
        }
        for (const name of ["async/208689.77fb5123f8.js", "async/968499.fa029184f4.js"]) {
          assert.doesNotMatch(read(name), /remote_control/);
        }
        assert.equal(read("async/1.decoy.js"), chunks["async/1.decoy.js"]);
        assert.deepEqual(
          report.patches
            .filter((patch) => patch.featureId === "remote-control-ui")
            .map((patch) => [patch.name, patch.status]),
          [
            ["feature:remote-control-ui:remote-connections-visibility", "applied"],
            ["feature:remote-control-ui:remote-control-connections-visibility", "applied"],
            ["feature:remote-control-ui:experimental-features", "applied"],
          ],
        );
      } finally {
        fs.rmSync(tempApp, { recursive: true, force: true });
      }
    });
  });
});

const signedApp = process.env.CODEX_SIGNED_EXTRACTED_APP;
test("signed webview chunks satisfy every remote-control UI contract", { skip: !signedApp }, () => {
  const { findWebviewAssetsContaining } = require("../../scripts/patches/lib/assets.js");
  for (const patch of featurePatches) {
    const names = findWebviewAssetsContaining(signedApp, patch.assetNeedles);
    assert.ok(names.length > 0, patch.id);
    for (const name of names) {
      const source = fs.readFileSync(path.join(signedApp, "webview", "assets", name), "utf8");
      const { value: patched, warnings } = captureWarns(() => patch.apply(source, {}));
      assert.deepEqual(warnings, [], `${patch.id} ${name}`);
      assert.notEqual(patched, source, `${patch.id} ${name}`);
      assert.equal(patch.apply(patched, {}), patched, `${patch.id} ${name}`);
    }
  }
});
