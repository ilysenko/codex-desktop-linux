#!/usr/bin/env node
"use strict";

const assert = require("node:assert/strict");
const { spawnSync } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const { applyMainBundlePatch } = require("./patch.js");
const {
  discoverLinuxFeatureManifests,
  enabledLinuxFeatureIds,
  enabledLinuxFeatureInstallPlan,
  enabledLinuxFeaturePackageHooks,
  enabledLinuxFeatureStageHooks,
  loadEnabledLinuxFeatures,
  loadLinuxFeatureMainBundlePatches,
  stageEnabledLinuxFeatureInstall,
  stagedLinuxFeatureFiles,
} = require("../../scripts/lib/linux-features.js");
const {
  createPatchReport,
  patchExtractedApp,
  patchMainBundleSource,
} = require("../../scripts/patch-linux-window-ui.js");

function withTempFeatureRoot(enabled, fn) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "codex-example-feature-test-"));
  const originalConfig = process.env.CODEX_LINUX_FEATURES_CONFIG;
  try {
    delete process.env.CODEX_LINUX_FEATURES_CONFIG;
    fs.writeFileSync(path.join(root, "features.example.json"), JSON.stringify({ enabled: [] }, null, 2));
    fs.writeFileSync(path.join(root, "features.json"), JSON.stringify({ enabled }, null, 2));
    copyRepositoryFeature(root, "example-feature");
    return fn(root);
  } finally {
    if (originalConfig == null) {
      delete process.env.CODEX_LINUX_FEATURES_CONFIG;
    } else {
      process.env.CODEX_LINUX_FEATURES_CONFIG = originalConfig;
    }
    fs.rmSync(root, { recursive: true, force: true });
  }
}

function copyRepositoryFeature(root, featureId) {
  fs.cpSync(path.resolve(__dirname, "..", featureId), path.join(root, featureId), { recursive: true });
}

function writeJson(filePath, value) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`);
}

function writeFeatureManifest(featureDir, value) {
  writeJson(path.join(featureDir, "feature.json"), value);
  fs.writeFileSync(path.join(featureDir, "README.md"), `# ${value.title ?? value.id}\n`);
}

test("example feature patches only its synthetic marker", () => {
  assert.equal(
    applyMainBundlePatch("before;codexLinuxExampleFeatureDisabled();after"),
    "before;codexLinuxExampleFeatureEnabled();after",
  );
});

test("example feature is a no-op without its synthetic marker", () => {
  const originalWarn = console.warn;
  console.warn = () => {};
  try {
    assert.equal(applyMainBundlePatch("real codex bundle"), "real codex bundle");
  } finally {
    console.warn = originalWarn;
  }
});

test("example feature stays disabled until listed in features.json", () => {
  withTempFeatureRoot([], (root) => {
    assert.deepEqual(enabledLinuxFeatureIds({ featuresRoot: root }), []);
    assert.deepEqual(enabledLinuxFeatureStageHooks({ featuresRoot: root }), []);
    assert.deepEqual(loadLinuxFeatureMainBundlePatches({ featuresRoot: root }), []);
  });
});

test("example feature exposes its patch and stage hook when enabled", () => {
  withTempFeatureRoot(["example-feature"], (root) => {
    assert.deepEqual(enabledLinuxFeatureIds({ featuresRoot: root }), ["example-feature"]);

    const hooks = enabledLinuxFeatureStageHooks({ featuresRoot: root });
    assert.equal(hooks.length, 1);
    assert.equal(hooks[0].id, "example-feature");
    assert.equal(path.basename(hooks[0].path), "stage.sh");

    const patches = loadLinuxFeatureMainBundlePatches({ featuresRoot: root });
    assert.equal(patches.length, 1);
    assert.equal(patches[0].name, "feature:example-feature");
    assert.equal(
      patches[0].apply("codexLinuxExampleFeatureDisabled()", {}),
      "codexLinuxExampleFeatureEnabled()",
    );
  });
});

test("legacy zed-opener configs enable open-target-discovery", () => {
  withTempFeatureRoot(["zed-opener"], (root) => {
    copyRepositoryFeature(root, "open-target-discovery");

    assert.deepEqual(enabledLinuxFeatureIds({ featuresRoot: root }), ["open-target-discovery"]);
    assert.deepEqual(
      loadEnabledLinuxFeatures({ featuresRoot: root }).map((feature) => feature.id),
      ["open-target-discovery"],
    );

    writeJson(path.join(root, "features.json"), {
      enabled: ["zed-opener", "open-target-discovery"],
    });
    assert.deepEqual(enabledLinuxFeatureIds({ featuresRoot: root }), ["open-target-discovery"]);
  });
});

test("local Linux features are discovered and enabled from linux-features/local", () => {
  withTempFeatureRoot(["local-example"], (root) => {
    const localDir = path.join(root, "local", "local-example");
    writeFeatureManifest(localDir, {
      id: "local-example",
      title: "Local Example",
      description: "Developer-local feature.",
    });

    const discovered = discoverLinuxFeatureManifests({ featuresRoot: root });
    const localFeature = discovered.find((feature) => feature.id === "local-example");
    assert.equal(localFeature.origin, "local");
    assert.equal(localFeature.local, true);
    assert.equal(localFeature.relativeDir, path.join("local", "local-example"));

    const enabled = loadEnabledLinuxFeatures({ featuresRoot: root });
    assert.deepEqual(enabled.map((feature) => feature.id), ["local-example"]);
    assert.equal(enabled[0].origin, "local");
  });
});

test("local Linux features cannot shadow repository features", () => {
  withTempFeatureRoot([], (root) => {
    writeFeatureManifest(path.join(root, "local", "example-feature"), {
      id: "example-feature",
      title: "Duplicate Example",
    });

    assert.throws(
      () => discoverLinuxFeatureManifests({ featuresRoot: root }),
      /Duplicate Linux feature id 'example-feature'/,
    );
  });
});

test("Linux features must include README documentation", () => {
  withTempFeatureRoot([], (root) => {
    writeJson(path.join(root, "local", "missing-readme", "feature.json"), {
      id: "missing-readme",
      title: "Missing README",
    });

    assert.throws(
      () => discoverLinuxFeatureManifests({ featuresRoot: root }),
      /must include README\.md next to feature\.json/,
    );
  });
});

test("Linux features must stay disabled by default", () => {
  withTempFeatureRoot([], (root) => {
    writeFeatureManifest(path.join(root, "local", "bad-default"), {
      id: "bad-default",
      title: "Bad Default",
      defaultEnabled: true,
    });

    assert.throws(
      () => discoverLinuxFeatureManifests({ featuresRoot: root }),
      /defaultEnabled true is not allowed/,
    );
  });
});

test("Linux feature dependencies and conflicts are validated", () => {
  withTempFeatureRoot(["needs-other"], (root) => {
    writeFeatureManifest(path.join(root, "local", "needs-other"), {
      id: "needs-other",
      requires: ["other-feature"],
    });

    assert.throws(
      () => loadEnabledLinuxFeatures({ featuresRoot: root }),
      /requires 'other-feature' to be enabled/,
    );
  });

  withTempFeatureRoot(["left-feature", "right-feature"], (root) => {
    writeFeatureManifest(path.join(root, "local", "left-feature"), {
      id: "left-feature",
      conflicts: ["right-feature"],
    });
    writeFeatureManifest(path.join(root, "local", "right-feature"), {
      id: "right-feature",
    });

    assert.throws(
      () => loadEnabledLinuxFeatures({ featuresRoot: root }),
      /conflicts with 'right-feature'/,
    );
  });
});

test("declarative Linux feature install plan stages resources and runtime hooks", () => {
  withTempFeatureRoot(["local-tool"], (root) => {
    const localDir = path.join(root, "local", "local-tool");
    writeFeatureManifest(localDir, {
      id: "local-tool",
      title: "Local Tool",
      resources: [
        {
          source: "payload.txt",
          target: ".codex-linux/features/local-tool/payload.txt",
          mode: "0640",
        },
      ],
      runtimeHooks: {
        env: "env",
        prelaunch: "prelaunch.sh",
        electronArgs: "electron-args",
        coldStart: "cold-start.sh",
        afterExit: "after-exit.sh",
      },
      packageHooks: [
        {
          path: "package.sh",
          formats: ["deb"],
        },
      ],
    });
    fs.writeFileSync(path.join(localDir, "payload.txt"), "payload\n");
    fs.writeFileSync(path.join(localDir, "env"), "LOCAL_TOOL=1\n");
    fs.writeFileSync(path.join(localDir, "prelaunch.sh"), "#!/bin/bash\nexit 0\n");
    fs.writeFileSync(path.join(localDir, "electron-args"), "--local-tool\n");
    fs.writeFileSync(path.join(localDir, "cold-start.sh"), "#!/bin/bash\nexit 0\n");
    fs.writeFileSync(path.join(localDir, "after-exit.sh"), "#!/bin/bash\nexit 0\n");
    fs.writeFileSync(path.join(localDir, "package.sh"), "#!/bin/bash\nexit 0\n");

    const plan = enabledLinuxFeatureInstallPlan({ featuresRoot: root });
    assert.deepEqual(plan.resources.map((resource) => resource.target), [
      ".codex-linux/features/local-tool/payload.txt",
    ]);
    assert.deepEqual(plan.runtimeHooks.map((hook) => `${hook.key}:${hook.name}`), [
      "env:local-tool-env",
      "prelaunch:local-tool-prelaunch.sh",
      "electronArgs:local-tool-electron-args",
      "coldStart:local-tool-cold-start.sh",
      "afterExit:local-tool-after-exit.sh",
    ]);

    const appDir = path.join(root, "install");
    stageEnabledLinuxFeatureInstall(appDir, { featuresRoot: root });

    assert.equal(
      fs.readFileSync(path.join(appDir, ".codex-linux", "features", "local-tool", "payload.txt"), "utf8"),
      "payload\n",
    );
    assert.equal(
      fs.readFileSync(path.join(appDir, ".codex-linux", "env.d", "local-tool-env"), "utf8"),
      "LOCAL_TOOL=1\n",
    );
    assert.equal(
      fs.readFileSync(path.join(appDir, ".codex-linux", "electron-args.d", "local-tool-electron-args"), "utf8"),
      "--local-tool\n",
    );
    assert.equal(
      fs.statSync(path.join(appDir, ".codex-linux", "features", "local-tool", "payload.txt")).mode & 0o777,
      0o640,
    );
    assert.equal(
      fs.statSync(path.join(appDir, ".codex-linux", "prelaunch.d", "local-tool-prelaunch.sh")).mode & 0o777,
      0o755,
    );
    assert.deepEqual(
      stagedLinuxFeatureFiles(appDir).map((entry) => [entry.target, entry.mode]),
      [
        [".codex-linux/features/local-tool/payload.txt", "0640"],
        [".codex-linux/env.d/local-tool-env", "0644"],
        [".codex-linux/prelaunch.d/local-tool-prelaunch.sh", "0755"],
        [".codex-linux/electron-args.d/local-tool-electron-args", "0644"],
        [".codex-linux/cold-start.d/local-tool-cold-start.sh", "0755"],
        [".codex-linux/after-exit.d/local-tool-after-exit.sh", "0755"],
      ],
    );

    const debHooks = enabledLinuxFeaturePackageHooks({ featuresRoot: root, packageFormat: "deb" });
    assert.equal(debHooks.length, 1);
    assert.equal(debHooks[0].id, "local-tool");
    assert.equal(path.basename(debHooks[0].path), "package.sh");
    assert.deepEqual(enabledLinuxFeaturePackageHooks({ featuresRoot: root, packageFormat: "rpm" }), []);
  });
});

test("declarative Linux feature staging removes stale runtime hooks after opt-out", () => {
  withTempFeatureRoot(["local-tool"], (root) => {
    const localDir = path.join(root, "local", "local-tool");
    writeFeatureManifest(localDir, {
      id: "local-tool",
      runtimeHooks: {
        env: "env",
        prelaunch: "prelaunch.sh",
        electronArgs: "electron-args",
        coldStart: "cold-start.sh",
        afterExit: "after-exit.sh",
      },
    });
    fs.writeFileSync(path.join(localDir, "env"), "LOCAL_TOOL=1\n");
    fs.writeFileSync(path.join(localDir, "prelaunch.sh"), "#!/bin/bash\nexit 0\n");
    fs.writeFileSync(path.join(localDir, "electron-args"), "--local-tool\n");
    fs.writeFileSync(path.join(localDir, "cold-start.sh"), "#!/bin/bash\nexit 0\n");
    fs.writeFileSync(path.join(localDir, "after-exit.sh"), "#!/bin/bash\nexit 0\n");

    const appDir = path.join(root, "install");
    stageEnabledLinuxFeatureInstall(appDir, { featuresRoot: root });

    const hookPaths = [
      path.join(appDir, ".codex-linux", "env.d", "local-tool-env"),
      path.join(appDir, ".codex-linux", "prelaunch.d", "local-tool-prelaunch.sh"),
      path.join(appDir, ".codex-linux", "electron-args.d", "local-tool-electron-args"),
      path.join(appDir, ".codex-linux", "cold-start.d", "local-tool-cold-start.sh"),
      path.join(appDir, ".codex-linux", "after-exit.d", "local-tool-after-exit.sh"),
    ];
    for (const hookPath of hookPaths) {
      assert.equal(fs.existsSync(hookPath), true);
    }

    writeJson(path.join(root, "features.json"), { enabled: [] });
    stageEnabledLinuxFeatureInstall(appDir, { featuresRoot: root });

    for (const hookPath of hookPaths) {
      assert.equal(fs.existsSync(hookPath), false);
    }
    assert.deepEqual(stagedLinuxFeatureFiles(appDir), []);
  });
});

test("declarative Linux feature staging cleans pre-manifest generated runtime hooks", () => {
  withTempFeatureRoot([], (root) => {
    writeFeatureManifest(path.join(root, "local", "local-tool"), {
      id: "local-tool",
      runtimeHooks: {
        env: "env",
      },
    });

    const appDir = path.join(root, "install");
    const envDir = path.join(appDir, ".codex-linux", "env.d");
    fs.mkdirSync(envDir, { recursive: true });
    const staleHook = path.join(envDir, "local-tool-env");
    const unrelatedHook = path.join(envDir, "custom-env");
    fs.writeFileSync(staleHook, "LOCAL_TOOL=1\n");
    fs.writeFileSync(unrelatedHook, "CUSTOM=1\n");

    stageEnabledLinuxFeatureInstall(appDir, { featuresRoot: root });

    assert.equal(fs.existsSync(staleHook), false);
    assert.equal(fs.existsSync(unrelatedHook), true);
  });
});

test("declarative Linux feature resources cannot target the install root", () => {
  for (const target of [".", "./"]) {
    withTempFeatureRoot(["root-target"], (root) => {
      const localDir = path.join(root, "local", "root-target");
      writeFeatureManifest(localDir, {
        id: "root-target",
        resources: [
          {
            source: "payload",
            target,
          },
        ],
      });
      fs.writeFileSync(path.join(localDir, "payload"), "payload\n");

      assert.throws(
        () => enabledLinuxFeatureInstallPlan({ featuresRoot: root }),
        /must not target the install directory root/,
      );
    });
  }
});

test("declarative Linux feature staging refuses root targets from stale manifests", () => {
  withTempFeatureRoot([], (root) => {
    const appDir = path.join(root, "install");
    fs.mkdirSync(appDir, { recursive: true });
    const sentinelPath = path.join(appDir, "sentinel.txt");
    fs.writeFileSync(sentinelPath, "keep me\n");
    writeJson(path.join(appDir, ".codex-linux", "linux-features-staged.json"), {
      version: 1,
      resources: [
        {
          id: "old-local-feature",
          type: "resource",
          target: ".",
          mode: "0644",
        },
      ],
      runtimeHooks: [],
    });

    assert.throws(
      () => stageEnabledLinuxFeatureInstall(appDir, { featuresRoot: root }),
      /must not target the install directory root/,
    );
    assert.equal(fs.readFileSync(sentinelPath, "utf8"), "keep me\n");
  });
});

test("numeric Linux feature file modes are rejected", () => {
  withTempFeatureRoot(["bad-mode"], (root) => {
    const localDir = path.join(root, "local", "bad-mode");
    writeFeatureManifest(localDir, {
      id: "bad-mode",
      resources: [
        {
          source: "payload.txt",
          target: ".codex-linux/features/bad-mode/payload.txt",
          mode: 755,
        },
      ],
    });
    fs.writeFileSync(path.join(localDir, "payload.txt"), "payload\n");

    assert.throws(
      () => enabledLinuxFeatureInstallPlan({ featuresRoot: root }),
      /file mode must be a quoted octal string/,
    );
  });
});

test("example feature participates in main bundle patching and patch reports", () => {
  withTempFeatureRoot(["example-feature"], (root) => {
    const originalRoot = process.env.CODEX_LINUX_FEATURES_ROOT;
    process.env.CODEX_LINUX_FEATURES_ROOT = root;
    const tempApp = fs.mkdtempSync(path.join(os.tmpdir(), "codex-example-feature-app-"));
    try {
      assert.equal(
        patchMainBundleSource("codexLinuxExampleFeatureDisabled()", null),
        "codexLinuxExampleFeatureEnabled()",
      );

      const buildDir = path.join(tempApp, ".vite", "build");
      fs.mkdirSync(buildDir, { recursive: true });
      fs.writeFileSync(path.join(buildDir, "main.js"), "codexLinuxExampleFeatureDisabled()");

      const report = createPatchReport();
      patchExtractedApp(tempApp, { report });

      assert.match(fs.readFileSync(path.join(buildDir, "main.js"), "utf8"), /codexLinuxExampleFeatureEnabled\(\)/);
      assert.ok(report.patches.some((patch) => patch.name === "feature:example-feature" && patch.status === "applied"));
    } finally {
      if (originalRoot == null) {
        delete process.env.CODEX_LINUX_FEATURES_ROOT;
      } else {
        process.env.CODEX_LINUX_FEATURES_ROOT = originalRoot;
      }
      fs.rmSync(tempApp, { recursive: true, force: true });
    }
  });
});

test("example feature stage hook is runnable through the Linux feature shell runner", () => {
  withTempFeatureRoot(["example-feature"], (root) => {
    const marker = path.join(root, "stage-marker.txt");
    const repoRoot = path.resolve(__dirname, "..", "..");
    const runner = path.join(repoRoot, "scripts", "lib", "linux-features.sh");
    const result = spawnSync(
      "bash",
      [
        "-lc",
        [
          "source \"$LINUX_FEATURES_RUNNER\"",
          "info(){ echo \"$*\" >&2; }",
          "warn(){ echo \"$*\" >&2; }",
          "SCRIPT_DIR=\"$REPO_ROOT\"",
          "INSTALL_DIR=\"$TMP_INSTALL_DIR\"",
          "WORK_DIR=\"$TMP_WORK_DIR\"",
          "ARCH=x86_64",
          "run_linux_feature_stage_hooks",
        ].join("\n"),
      ],
      {
        env: {
          ...process.env,
          LINUX_FEATURES_RUNNER: runner,
          REPO_ROOT: repoRoot,
          TMP_INSTALL_DIR: path.join(root, "install"),
          TMP_WORK_DIR: path.join(root, "work"),
          CODEX_LINUX_FEATURES_ROOT: root,
          CODEX_EXAMPLE_FEATURE_STAGE_MARKER: marker,
        },
        encoding: "utf8",
      },
    );

    assert.equal(result.status, 0, result.stderr);
    assert.match(fs.readFileSync(marker, "utf8"), /example-stage:x86_64:/);
    assert.match(result.stderr, /Running Linux feature stage hook: example-feature/);
  });
});

test("Linux feature shell runner fails when an enabled stage hook fails", () => {
  withTempFeatureRoot(["example-feature"], (root) => {
    fs.writeFileSync(
      path.join(root, "example-feature", "stage.sh"),
      "#!/bin/bash\nset -Eeuo pipefail\nexit 42\n",
    );
    const repoRoot = path.resolve(__dirname, "..", "..");
    const runner = path.join(repoRoot, "scripts", "lib", "linux-features.sh");
    const result = spawnSync(
      "bash",
      [
        "-lc",
        [
          "source \"$LINUX_FEATURES_RUNNER\"",
          "info(){ echo \"$*\" >&2; }",
          "warn(){ echo \"$*\" >&2; }",
          "SCRIPT_DIR=\"$REPO_ROOT\"",
          "INSTALL_DIR=\"$TMP_INSTALL_DIR\"",
          "WORK_DIR=\"$TMP_WORK_DIR\"",
          "ARCH=x86_64",
          "run_linux_feature_stage_hooks",
        ].join("\n"),
      ],
      {
        env: {
          ...process.env,
          LINUX_FEATURES_RUNNER: runner,
          REPO_ROOT: repoRoot,
          TMP_INSTALL_DIR: path.join(root, "install"),
          TMP_WORK_DIR: path.join(root, "work"),
          CODEX_LINUX_FEATURES_ROOT: root,
        },
        encoding: "utf8",
      },
    );

    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /Linux feature stage hook failed: example-feature/);
  });
});
