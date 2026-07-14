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

test("remote-control UI feature patches are idempotent and fail soft", () => {
  const remoteConnectionsPatch = featurePatches.find((patch) => patch.id === "remote-connections-visibility");
  const remoteControlConnectionsPatch = featurePatches.find((patch) => patch.id === "remote-control-connections-visibility");
  const experimentalFeaturesPatch = featurePatches.find((patch) => patch.id === "experimental-features");
  const remoteConnectionsSource =
    "function c(){let e=(0,s.c)(3),{data:n}=t(a,r(i)),c=o(`4114442250`);if(n?.config[`features.remote_connections`]===!0)return!0;let l=n?.config.features;if(typeof l!=`object`||!l||Array.isArray(l))return c;let u;return e[0]!==l||e[1]!==c?(u=Object.getOwnPropertyDescriptor(l,`remote_connections`)?.value===!0||c,e[0]=l,e[1]=c,e[2]=u):u=e[2],u}";
  const atomRemoteConnectionsSource =
    "function s(e){if(e(c,`4114442250`))return`enabled`;return`disabled`}";
  const currentRemoteConnectionsSource =
    "function d(){let e=(0,u.c)(3),{data:i}=n(s,r(t)),a=c(`4114442250`);if(i?.config[`features.remote_connections`]===!0)return!0;let o=i?.config.features;if(typeof o!=`object`||!o||Array.isArray(o))return a;let l;return e[0]!==o||e[1]!==a?(l=Object.getOwnPropertyDescriptor(o,`remote_connections`)?.value===!0||a,e[0]=o,e[1]=a,e[2]=l):l=e[2],l}";
  const currentRemoteControlConnectionsSource =
    "function a({remoteControlConnectionsState:e,slingshotEnabled:t}){return t&&(e?.available??!0)&&e?.accessRequired!==!0}";
  const experimentalFeaturesSource =
    "var Z=`remote_control`;function Ie(e){return e.stage===`beta`?e.name!==`memories`&&e.name!==`multi_agent`&&e.name!==`plugins`&&e.name!==`plugin`&&e.name!==`remote_control`&&!e.name.startsWith(`realtime_`)&&e.name!==`chronicle`&&e.name!==`workspace_dependencies`:!1}";

  const firstPatched = remoteConnectionsPatch.apply(remoteConnectionsSource, {});
  assert.match(firstPatched, /navigator\.userAgent\.includes\(`Linux`\)/);
  assert.equal(remoteConnectionsPatch.apply(firstPatched, {}), firstPatched);

  const currentRemoteConnectionsPatched = remoteConnectionsPatch.apply(currentRemoteConnectionsSource, {});
  assert.match(currentRemoteConnectionsPatched, /c\(`4114442250`\)\|\|navigator\.userAgent\.includes\(`Linux`\)/);
  assert.equal(remoteConnectionsPatch.apply(currentRemoteConnectionsPatched, {}), currentRemoteConnectionsPatched);

  const atomRemoteConnectionsPatched = remoteConnectionsPatch.apply(atomRemoteConnectionsSource, {});
  assert.match(atomRemoteConnectionsPatched, /e\(c,`4114442250`\)\|\|navigator\.userAgent\.includes\(`Linux`\)/);
  assert.equal(remoteConnectionsPatch.apply(atomRemoteConnectionsPatched, {}), atomRemoteConnectionsPatched);

  const currentRemoteControlConnectionsPatched = remoteControlConnectionsPatch.apply(currentRemoteControlConnectionsSource, {});
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
    `${currentRemoteControlConnectionsPatched};return a({remoteControlConnectionsState,slingshotEnabled})`,
  );
  const linuxNavigator = { userAgent: "Linux" };
  assert.equal(currentGate({ available: false, accessRequired: false }, false, linuxNavigator), false);
  assert.equal(currentGate({ available: true, accessRequired: true }, false, linuxNavigator), false);
  assert.equal(currentGate({ available: true, accessRequired: false }, false, linuxNavigator), true);

  const filtered = experimentalFeaturesPatch.apply(experimentalFeaturesSource, {});
  assert.doesNotMatch(filtered, /e\.name!==`remote_control`/);
  const { value: filteredAgain, warnings: filteredAgainWarnings } = captureWarns(() =>
    experimentalFeaturesPatch.apply(filtered, {}),
  );
  assert.equal(filteredAgain, filtered);
  assert.deepEqual(filteredAgainWarnings, []);

  const { value, warnings } = captureWarns(() => remoteConnectionsPatch.apply("real codex bundle", {}));
  assert.equal(value, "real codex bundle");
  assert.match(warnings.join("\n"), /Could not find remote connections Statsig gate/);

  const unrelatedLinuxGate = "const unrelated=flag||navigator.userAgent.includes(`Linux`);const gate=get(\"4114442250\")";
  const { value: driftedValue, warnings: driftedWarnings } = captureWarns(() =>
    remoteConnectionsPatch.apply(unrelatedLinuxGate, {}),
  );
  assert.equal(driftedValue, unrelatedLinuxGate);
  assert.match(driftedWarnings.join("\n"), /Could not find remote connections Statsig gate/);

  const unrelatedRemoteControlLinuxGate =
    "const unrelated=(flag||navigator.userAgent.includes(`Linux`))&&other;function RD(){return enabled&&state?.available}";
  const { value: remoteControlDriftedValue, warnings: remoteControlDriftedWarnings } = captureWarns(() =>
    remoteControlConnectionsPatch.apply(unrelatedRemoteControlLinuxGate, {}),
  );
  assert.equal(remoteControlDriftedValue, unrelatedRemoteControlLinuxGate);
  assert.match(
    remoteControlDriftedWarnings.join("\n"),
    /Could not find remote control connections visibility gate/,
  );
});

test("remote-control UI descriptors match the current app chunks", () => {
  const remoteConnectionsPatch = featurePatches.find((patch) => patch.id === "remote-connections-visibility");
  const remoteControlConnectionsPatch = featurePatches.find((patch) => patch.id === "remote-control-connections-visibility");
  const experimentalFeaturesPatch = featurePatches.find((patch) => patch.id === "experimental-features");

  assert.ok(
    remoteConnectionsPatch.pattern.test(
      "app-initial~app-main~hotkey-window-new-thread-page~hotkey-window-home-page~composer-utility-bar-D9zyQF1n.js",
    ),
  );
  assert.equal(
    remoteConnectionsPatch.pattern.test(
      "app-initial~app-main~hotkey-window-thread-page~keyboard-shortcuts-settings~thread-app-shell~cf704xib-BhQogfRL.js",
    ),
    false,
  );

  assert.ok(
    remoteControlConnectionsPatch.pattern.test(
      "app-initial~app-main~new-thread-panel-page~appgen-library-page~hotkey-window-thread-page~ho~iufn7mg3-JRP-9S5c.js",
    ),
  );
  assert.equal(
    remoteControlConnectionsPatch.pattern.test(
      "app-initial~app-main~new-thread-panel-page~appgen-library-page~hotkey-window-thread-page~ho~lzri21pz-DYeTwZrs.js",
    ),
    false,
  );

  assert.ok(experimentalFeaturesPatch.pattern.test("settings-route-state-BwIfDYxh.js"));
  assert.equal(
    experimentalFeaturesPatch.pattern.test("experimental-features-queries-old.js"),
    false,
  );
});

test("remote-control UI feature patches matching webview assets and records patch report entries", () => {
  withTempFeatureConfig(["remote-control-ui"], (root) => {
    withLinuxFeatureRootEnv(root, () => {
      const tempApp = fs.mkdtempSync(path.join(os.tmpdir(), "codex-remote-control-feature-app-"));
      try {
        const buildDir = path.join(tempApp, ".vite", "build");
        const assetsDir = path.join(tempApp, "webview", "assets");
        fs.mkdirSync(buildDir, { recursive: true });
        fs.mkdirSync(assetsDir, { recursive: true });
        fs.writeFileSync(path.join(buildDir, "main.js"), "console.log('main bundle');");
        fs.writeFileSync(path.join(tempApp, "package.json"), JSON.stringify({ name: "codex" }));

        fs.writeFileSync(
          path.join(
            assetsDir,
            "app-initial~app-main~hotkey-window-new-thread-page~hotkey-window-home-page~composer-utility-bar-D9zyQF1n.js",
          ),
          "function Twt(){let e=(0,kwt.c)(3),{data:t}=Vr(y4,Br(B2)),n=BN(`4114442250`);if(t?.config[`features.remote_connections`]===!0)return!0;let r=t?.config.features;if(typeof r!=`object`||!r||Array.isArray(r))return n;let i;return e[0]!==r||e[1]!==n?(i=Object.getOwnPropertyDescriptor(r,`remote_connections`)?.value===!0||n,e[0]=r,e[1]=n,e[2]=i):i=e[2],i}function D8(e){return e(RN,`4114442250`)?`enabled`:`disabled`}",
        );
        fs.writeFileSync(
          path.join(
            assetsDir,
            "app-initial~app-main~new-thread-panel-page~appgen-library-page~hotkey-window-thread-page~ho~iufn7mg3-JRP-9S5c.js",
          ),
          "function a({remoteControlConnectionsState:e,slingshotEnabled:t}){return t&&(e?.available??!0)&&e?.accessRequired!==!0}",
        );
        fs.writeFileSync(
          path.join(assetsDir, "settings-route-state-BwIfDYxh.js"),
          "var Z=`remote_control`;function Ie(e){return e.stage===`beta`?e.name!==`memories`&&e.name!==`multi_agent`&&e.name!==`plugins`&&e.name!==`plugin`&&e.name!==`remote_control`&&!e.name.startsWith(`realtime_`)&&e.name!==`chronicle`&&e.name!==`workspace_dependencies`:!1}",
        );

        const report = createPatchReport();
        const { warnings } = captureWarns(() => patchExtractedApp(tempApp, { report }));
        assert.ok(
          warnings.every((warning) => !warning.includes("remote control UI")),
          warnings.join("\n"),
        );

        assert.match(
          fs.readFileSync(
            path.join(
              assetsDir,
              "app-initial~app-main~hotkey-window-new-thread-page~hotkey-window-home-page~composer-utility-bar-D9zyQF1n.js",
            ),
            "utf8",
          ),
          /navigator\.userAgent\.includes\(`Linux`\)/,
        );
        assert.match(
          fs.readFileSync(
            path.join(
              assetsDir,
              "app-initial~app-main~new-thread-panel-page~appgen-library-page~hotkey-window-thread-page~ho~iufn7mg3-JRP-9S5c.js",
            ),
            "utf8",
          ),
          /navigator\.userAgent\.includes\(`Linux`\)/,
        );
        assert.doesNotMatch(
          fs.readFileSync(path.join(assetsDir, "settings-route-state-BwIfDYxh.js"), "utf8"),
          /e\.name!==`remote_control`/,
        );
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
