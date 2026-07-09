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
    assert.equal(patches.length, 5);
    assert.deepEqual(
      patches.map((patch) => [patch.name, patch.phase, patch.ciPolicy]),
      [
        ["feature:remote-control-ui:remote-connections-visibility", "webview-asset", "optional"],
        ["feature:remote-control-ui:remote-control-connections-visibility", "webview-asset", "optional"],
        ["feature:remote-control-ui:experimental-features", "webview-asset", "optional"],
        ["feature:remote-control-ui:nux-gate", "webview-asset", "optional"],
        ["feature:remote-control-ui:app-main", "webview-asset", "optional"],
      ],
    );
  });
});

test("remote-control UI feature patches are idempotent and fail soft", () => {
  const remoteConnectionsPatch = featurePatches.find((patch) => patch.id === "remote-connections-visibility");
  const remoteControlConnectionsPatch = featurePatches.find((patch) => patch.id === "remote-control-connections-visibility");
  const experimentalFeaturesPatch = featurePatches.find((patch) => patch.id === "experimental-features");
  const appMainPatch = featurePatches.find((patch) => patch.id === "app-main");
  const nuxGatePatch = featurePatches.find((patch) => patch.id === "nux-gate");
  const remoteConnectionsSource =
    "function c(){let e=(0,s.c)(3),{data:n}=t(a,r(i)),c=o(`4114442250`);if(n?.config[`features.remote_connections`]===!0)return!0;let l=n?.config.features;if(typeof l!=`object`||!l||Array.isArray(l))return c;let u;return e[0]!==l||e[1]!==c?(u=Object.getOwnPropertyDescriptor(l,`remote_connections`)?.value===!0||c,e[0]=l,e[1]=c,e[2]=u):u=e[2],u}";
  const currentRemoteConnectionsSource =
    "function d(){let e=(0,u.c)(3),{data:i}=n(s,r(t)),a=c(`4114442250`);if(i?.config[`features.remote_connections`]===!0)return!0;let o=i?.config.features;if(typeof o!=`object`||!o||Array.isArray(o))return a;let l;return e[0]!==o||e[1]!==a?(l=Object.getOwnPropertyDescriptor(o,`remote_connections`)?.value===!0||a,e[0]=o,e[1]=a,e[2]=l):l=e[2],l}";
  const currentRemoteControlConnectionsSource =
    "function a({remoteControlConnectionsState:e,slingshotEnabled:t}){return t&&(e?.available??!0)&&e?.accessRequired!==!0}";
  const currentAppMainSource =
    "function m_(){let e=(0,Z.c)(14),t=Pg(),{data:n,isLoading:r}=Ps(d.CODEX_MOBILE_SETUP_COMPLETED),i=Ql(),a=ec(`2798711298`),[o]=ts(`local_app_server_feature_enablement`),[s,c]=gt(Vg),l=o?.remote_control??!1,u=t&&i&&a&&!l&&!r&&!n&&!s;return u}";
  const currentNuxGateSource =
    "import{r as ee}from\"./remote-connection-visibility-6MV6akfy.js\";function wt(){let i=ee(),a=z(),[o]=E(`remote_connections`),s=o?.some(Tt)??!1;return i&&!a&&o!=null&&s}";
  const experimentalFeaturesSource =
    "var Z=`remote_control`;function Ie(e){return e.stage===`beta`?e.name!==`memories`&&e.name!==`multi_agent`&&e.name!==`plugins`&&e.name!==`plugin`&&e.name!==`realtime_conversation`&&e.name!==`remote_control`&&e.name!==`chronicle`&&e.name!==`workspace_dependencies`:!1}";

  const firstPatched = remoteConnectionsPatch.apply(remoteConnectionsSource, {});
  assert.match(firstPatched, /navigator\.userAgent\.includes\(`Linux`\)/);
  assert.equal(remoteConnectionsPatch.apply(firstPatched, {}), firstPatched);

  const currentRemoteConnectionsPatched = remoteConnectionsPatch.apply(currentRemoteConnectionsSource, {});
  assert.match(currentRemoteConnectionsPatched, /c\(`4114442250`\)\|\|navigator\.userAgent\.includes\(`Linux`\)/);
  assert.equal(remoteConnectionsPatch.apply(currentRemoteConnectionsPatched, {}), currentRemoteConnectionsPatched);

  const currentRemoteControlConnectionsPatched = remoteControlConnectionsPatch.apply(currentRemoteControlConnectionsSource, {});
  assert.match(currentRemoteControlConnectionsPatched, /\(t\|\|navigator\.userAgent\.includes\(`Linux`\)\)&&\(e\?\.available\?\?!0\)/);
  assert.equal(remoteControlConnectionsPatch.apply(currentRemoteControlConnectionsPatched, {}), currentRemoteControlConnectionsPatched);

  const currentAppMainPatched = appMainPatch.apply(currentAppMainSource, {});
  assert.match(currentAppMainPatched, /ec\(`2798711298`\)\|\|navigator\.userAgent\.includes\(`Linux`\)/);
  assert.equal(appMainPatch.apply(currentAppMainPatched, {}), currentAppMainPatched);

  const { value: currentNuxGatePatched, warnings: currentNuxGateWarnings } = captureWarns(() =>
    nuxGatePatch.apply(currentNuxGateSource, {}),
  );
  assert.equal(currentNuxGatePatched, currentNuxGateSource);
  assert.deepEqual(currentNuxGateWarnings, []);

  const filtered = experimentalFeaturesPatch.apply(experimentalFeaturesSource, {});
  assert.doesNotMatch(filtered, /e\.name!==`remote_control`/);
  assert.equal(experimentalFeaturesPatch.apply(filtered, {}), filtered);

  const { value, warnings } = captureWarns(() => remoteConnectionsPatch.apply("real codex bundle", {}));
  assert.equal(value, "real codex bundle");
  assert.match(warnings.join("\n"), /Could not find remote connections Statsig gate/);
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
          path.join(assetsDir, "remote-connection-visibility-test.js"),
          "function c(){let e=(0,s.c)(3),{data:n}=t(a,r(i)),c=o(`4114442250`);if(n?.config[`features.remote_connections`]===!0)return!0;let l=n?.config.features;if(typeof l!=`object`||!l||Array.isArray(l))return c;let u;return e[0]!==l||e[1]!==c?(u=Object.getOwnPropertyDescriptor(l,`remote_connections`)?.value===!0||c,e[0]=l,e[1]=c,e[2]=u):u=e[2],u}",
        );
        fs.writeFileSync(
          path.join(assetsDir, "remote-control-connections-visibility-test.js"),
          "function p(){let e=t(`1042620455`),n=r(`remote_control_connections_state`);return!!e&&n?.available===!0}",
        );
        fs.writeFileSync(
          path.join(assetsDir, "experimental-features-queries-test.js"),
          "var Z=`remote_control`;function Ie(e){return e.stage===`beta`?e.name!==`memories`&&e.name!==`multi_agent`&&e.name!==`plugins`&&e.name!==`plugin`&&e.name!==`realtime_conversation`&&e.name!==`remote_control`&&e.name!==`chronicle`&&e.name!==`workspace_dependencies`:!1}",
        );
        fs.writeFileSync(
          path.join(assetsDir, "nux-gate-test.js"),
          "function g(){let e=o(`2798711298`),t=n?.remote_control??!1;return e&&!t}",
        );
        fs.writeFileSync(
          path.join(assetsDir, "app-main-test.js"),
          "function h(){let e=o(`2798711298`),t=n?.remote_control??!1;return e&&!t&&r!==`CODEX_MOBILE_SETUP_COMPLETED`}",
        );

        const report = createPatchReport();
        const { warnings } = captureWarns(() => patchExtractedApp(tempApp, { report }));
        assert.ok(
          warnings.every((warning) => !warning.includes("remote control UI")),
          warnings.join("\n"),
        );

        assert.match(
          fs.readFileSync(path.join(assetsDir, "remote-connection-visibility-test.js"), "utf8"),
          /navigator\.userAgent\.includes\(`Linux`\)/,
        );
        assert.match(
          fs.readFileSync(path.join(assetsDir, "remote-control-connections-visibility-test.js"), "utf8"),
          /navigator\.userAgent\.includes\(`Linux`\)/,
        );
        assert.doesNotMatch(
          fs.readFileSync(path.join(assetsDir, "experimental-features-queries-test.js"), "utf8"),
          /e\.name!==`remote_control`/,
        );
        assert.match(
          fs.readFileSync(path.join(assetsDir, "nux-gate-test.js"), "utf8"),
          /o\(`2798711298`\)\|\|navigator\.userAgent\.includes\(`Linux`\)/,
        );
        assert.match(
          fs.readFileSync(path.join(assetsDir, "app-main-test.js"), "utf8"),
          /o\(`2798711298`\)\|\|navigator\.userAgent\.includes\(`Linux`\)/,
        );
        assert.ok(
          report.patches.some((patch) =>
            patch.name === "feature:remote-control-ui:remote-connections-visibility" && patch.status === "applied"
          ),
        );
      } finally {
        fs.rmSync(tempApp, { recursive: true, force: true });
      }
    });
  });
});
