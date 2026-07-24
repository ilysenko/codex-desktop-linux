#!/usr/bin/env node
"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const {
  enabledLinuxFeaturePackageDependencies,
  enabledLinuxFeaturePackageFiles,
  enabledLinuxFeaturePackagePlan,
  enabledLinuxFeaturePackageResourceMetadata,
  loadLinuxFeaturePatchDescriptors,
  stageEnabledLinuxFeaturePackageResources,
  stageEnabledLinuxFeatureInstall,
} = require("./linux-features.js");

function makeFeatureRoot(root, featureManifest) {
  const featuresRoot = path.join(root, "linux-features");
  const featureDir = path.join(featuresRoot, "unsafe-link");
  fs.mkdirSync(featureDir, { recursive: true });
  fs.writeFileSync(path.join(featuresRoot, "features.example.json"), '{"enabled":[]}\n');
  fs.writeFileSync(path.join(featuresRoot, "features.json"), '{"enabled":["unsafe-link"]}\n');
  fs.writeFileSync(path.join(featureDir, "README.md"), "# Unsafe Link\n");
  fs.writeFileSync(path.join(featureDir, "feature.json"), `${JSON.stringify(featureManifest, null, 2)}\n`);
  return { featureDir, featuresRoot };
}

function stageFeature(root, featuresRoot) {
  stageEnabledLinuxFeatureInstall(path.join(root, "app"), {
    featuresConfigPath: path.join(featuresRoot, "features.json"),
    featuresRoot,
  });
}

function writeStagedManifest(appDir, manifest) {
  const manifestPath = path.join(appDir, ".codex-linux", "linux-features-staged.json");
  fs.mkdirSync(path.dirname(manifestPath), { recursive: true });
  fs.writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
}

test("Linux feature asset matchers receive feature settings", (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "codex-feature-asset-match-context-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));

  const { featureDir, featuresRoot } = makeFeatureRoot(root, {
    id: "unsafe-link",
    title: "Unsafe Link",
    entrypoints: { patchDescriptors: "./patch.js" },
  });
  fs.writeFileSync(
    path.join(featuresRoot, "features.json"),
    JSON.stringify({
      enabled: ["unsafe-link"],
      settings: { "unsafe-link": { expectedContract: "current-contract" } },
    }),
  );
  fs.writeFileSync(
    path.join(featureDir, "patch.js"),
    [
      "module.exports = [{",
      "  id: 'settings-aware-asset',",
      "  phase: 'webview-asset',",
      "  pattern: /^app-.*\\.js$/,",
      "  assetMatch: (source, assetName, context) =>",
      "    source === context.feature.settings.expectedContract && assetName === 'app-current.js',",
      "  apply: (source) => source,",
      "}];",
      "",
    ].join("\n"),
  );

  const [descriptor] = loadLinuxFeaturePatchDescriptors({ featuresRoot });
  assert.equal(descriptor.assetMatch("current-contract", "app-current.js", {}), true);
});

test("Linux feature staging rejects duplicate resource targets", (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "codex-feature-duplicate-resource-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));

  const appDir = path.join(root, "app");
  const preservedTarget = ".codex-linux/features/preserved/payload.txt";
  const target = ".codex-linux/features/unsafe-link/payload.txt";
  const { featureDir, featuresRoot } = makeFeatureRoot(root, {
    id: "unsafe-link",
    title: "Unsafe Link",
    resources: [
      { source: "first.txt", target, mode: "0644" },
      { source: "second.txt", target, mode: "0644" },
    ],
  });
  fs.writeFileSync(path.join(featureDir, "first.txt"), "first\n");
  fs.writeFileSync(path.join(featureDir, "second.txt"), "second\n");
  fs.mkdirSync(path.dirname(path.join(appDir, preservedTarget)), { recursive: true });
  fs.writeFileSync(path.join(appDir, preservedTarget), "preserved\n");
  writeStagedManifest(appDir, {
    version: 1,
    resources: [{ id: "preserved", type: "resource", target: preservedTarget, mode: "0644" }],
    runtimeHooks: [],
  });

  assert.throws(
    () => stageFeature(root, featuresRoot),
    /duplicate Linux feature install target/i,
  );
  assert.equal(fs.existsSync(path.join(root, "app", target)), false);
  assert.equal(fs.readFileSync(path.join(appDir, preservedTarget), "utf8"), "preserved\n");
});

test("Linux feature staging rejects ancestor and descendant target overlaps", (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "codex-feature-target-overlap-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));

  const parentTarget = ".codex-linux/features/unsafe-link/payload";
  const childTarget = `${parentTarget}/nested.txt`;
  const { featureDir, featuresRoot } = makeFeatureRoot(root, {
    id: "unsafe-link",
    title: "Unsafe Link",
    resources: [
      { source: "payload", target: parentTarget, mode: "0644" },
      { source: "nested.txt", target: childTarget, mode: "0644" },
    ],
  });
  fs.mkdirSync(path.join(featureDir, "payload"));
  fs.writeFileSync(path.join(featureDir, "payload", "nested.txt"), "parent\n");
  fs.writeFileSync(path.join(featureDir, "nested.txt"), "child\n");

  assert.throws(
    () => stageFeature(root, featuresRoot),
    /overlapping Linux feature install target/i,
  );
  assert.equal(fs.existsSync(path.join(root, "app", parentTarget)), false);
});

test("Linux feature staging rejects resource and runtime hook target collisions", (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "codex-feature-hook-collision-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));

  const target = ".codex-linux/prelaunch.d/unsafe-link-hook.sh";
  const { featureDir, featuresRoot } = makeFeatureRoot(root, {
    id: "unsafe-link",
    title: "Unsafe Link",
    resources: [
      { source: "payload.sh", target, mode: "0755" },
    ],
    runtimeHooks: {
      prelaunch: { source: "hook.sh", name: "hook.sh", mode: "0755" },
    },
  });
  fs.writeFileSync(path.join(featureDir, "payload.sh"), "resource\n");
  fs.writeFileSync(path.join(featureDir, "hook.sh"), "hook\n");

  assert.throws(
    () => stageFeature(root, featuresRoot),
    /duplicate Linux feature install target/i,
  );
  assert.equal(fs.existsSync(path.join(root, "app", target)), false);
});

test("Linux feature staging rejects framework manifest targets", (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "codex-feature-manifest-target-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));

  const target = ".codex-linux/linux-features-staged.json";
  const { featureDir, featuresRoot } = makeFeatureRoot(root, {
    id: "unsafe-link",
    title: "Unsafe Link",
    resources: [{ source: "payload.json", target, mode: "0644" }],
  });
  fs.writeFileSync(path.join(featureDir, "payload.json"), "payload\n");

  assert.throws(
    () => stageFeature(root, featuresRoot),
    /Linux feature staging framework/,
  );
  assert.equal(fs.existsSync(path.join(root, "app", target)), false);
});

test("Linux feature staging rejects normalized target aliases across features", (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "codex-feature-cross-feature-target-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));

  const target = ".codex-linux/features/shared/payload.txt";
  const { featureDir, featuresRoot } = makeFeatureRoot(root, {
    id: "unsafe-link",
    title: "Unsafe Link",
    resources: [{ source: "first.txt", target, mode: "0644" }],
  });
  const secondFeatureDir = path.join(featuresRoot, "second");
  fs.mkdirSync(secondFeatureDir);
  fs.writeFileSync(path.join(featureDir, "first.txt"), "first\n");
  fs.writeFileSync(path.join(secondFeatureDir, "README.md"), "# Second\n");
  fs.writeFileSync(path.join(secondFeatureDir, "second.txt"), "second\n");
  fs.writeFileSync(path.join(secondFeatureDir, "feature.json"), `${JSON.stringify({
    id: "second",
    title: "Second",
    resources: [{ source: "second.txt", target: ".codex-linux\\features\\shared\\payload.txt", mode: "0644" }],
  }, null, 2)}\n`);
  fs.writeFileSync(path.join(featuresRoot, "features.json"), '{"enabled":["unsafe-link","second"]}\n');

  assert.throws(
    () => stageFeature(root, featuresRoot),
    /feature 'second'.*feature 'unsafe-link'/,
  );
  assert.equal(fs.existsSync(path.join(root, "app", target)), false);
});

test("Linux feature staging rejects symlinked resource sources", (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "codex-feature-symlink-source-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));

  const outside = path.join(root, "outside");
  const { featureDir, featuresRoot } = makeFeatureRoot(root, {
    id: "unsafe-link",
    title: "Unsafe Link",
    resources: [
      {
        source: "payload-link",
        target: ".codex-linux/features/unsafe-link/payload.txt",
        mode: "0644",
      },
    ],
  });
  fs.mkdirSync(outside, { recursive: true });
  fs.writeFileSync(path.join(outside, "payload.txt"), "outside\n");
  fs.symlinkSync(outside, path.join(featureDir, "payload-link"), "junction");

  assert.throws(
    () => stageFeature(root, featuresRoot),
    /must not contain symbolic links/,
  );
  assert.equal(
    fs.existsSync(path.join(root, "app", ".codex-linux", "features", "unsafe-link", "payload.txt")),
    false,
  );
});

test("Linux feature staging rejects symlinked install target parents", (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "codex-feature-symlink-target-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));

  const outside = path.join(root, "outside");
  const appDir = path.join(root, "app");
  const { featureDir, featuresRoot } = makeFeatureRoot(root, {
    id: "unsafe-link",
    title: "Unsafe Link",
    resources: [
      {
        source: "payload.txt",
        target: ".codex-linux/features/unsafe-link/payload.txt",
        mode: "0644",
      },
    ],
  });
  fs.mkdirSync(path.join(appDir, ".codex-linux", "features"), { recursive: true });
  fs.mkdirSync(outside, { recursive: true });
  fs.writeFileSync(path.join(featureDir, "payload.txt"), "payload\n");
  fs.symlinkSync(outside, path.join(appDir, ".codex-linux", "features", "unsafe-link"), "junction");

  assert.throws(
    () => stageFeature(root, featuresRoot),
    /must stay inside the install directory/,
  );
  assert.equal(fs.existsSync(path.join(outside, "payload.txt")), false);
});

test("Linux feature staging rejects symlinked install target ancestors before creating parents", (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "codex-feature-symlink-target-ancestor-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));

  const outside = path.join(root, "outside");
  const appDir = path.join(root, "app");
  const { featureDir, featuresRoot } = makeFeatureRoot(root, {
    id: "unsafe-link",
    title: "Unsafe Link",
    resources: [
      {
        source: "payload.txt",
        target: ".codex-linux/features/unsafe-link/nested/payload.txt",
        mode: "0644",
      },
    ],
  });
  fs.mkdirSync(path.join(appDir, ".codex-linux", "features"), { recursive: true });
  fs.mkdirSync(outside, { recursive: true });
  fs.writeFileSync(path.join(featureDir, "payload.txt"), "payload\n");
  fs.symlinkSync(outside, path.join(appDir, ".codex-linux", "features", "unsafe-link"), "junction");

  assert.throws(
    () => stageFeature(root, featuresRoot),
    /must (stay inside the install directory|not contain symbolic links)/,
  );
  assert.equal(fs.existsSync(path.join(outside, "nested")), false);
});

test("Linux feature staging does not clean stale manifest targets through symlinked parents", (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "codex-feature-symlink-manifest-cleanup-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));

  const outside = path.join(root, "outside");
  const appDir = path.join(root, "app");
  const { featureDir, featuresRoot } = makeFeatureRoot(root, {
    id: "unsafe-link",
    title: "Unsafe Link",
    resources: [
      {
        source: "payload.txt",
        target: ".codex-linux/features/unsafe-link/payload.txt",
        mode: "0644",
      },
    ],
  });
  fs.mkdirSync(path.join(appDir, ".codex-linux", "features"), { recursive: true });
  fs.mkdirSync(outside, { recursive: true });
  fs.writeFileSync(path.join(featureDir, "payload.txt"), "payload\n");
  fs.writeFileSync(path.join(outside, "payload.txt"), "outside\n");
  fs.symlinkSync(outside, path.join(appDir, ".codex-linux", "features", "unsafe-link"), "junction");
  writeStagedManifest(appDir, {
    version: 1,
    resources: [
      {
        id: "unsafe-link",
        type: "resource",
        target: ".codex-linux/features/unsafe-link/payload.txt",
        mode: "0644",
      },
    ],
    runtimeHooks: [],
  });

  assert.throws(
    () => stageFeature(root, featuresRoot),
    /must (stay inside the install directory|not contain symbolic links)/,
  );
  assert.equal(fs.readFileSync(path.join(outside, "payload.txt"), "utf8"), "outside\n");
});

test("Linux feature staging does not clean legacy hooks through symlinked hook dirs", (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "codex-feature-symlink-hook-cleanup-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));

  const outside = path.join(root, "outside-hooks");
  const appDir = path.join(root, "app");
  const { featuresRoot } = makeFeatureRoot(root, {
    id: "unsafe-link",
    title: "Unsafe Link",
  });
  fs.mkdirSync(path.join(appDir, ".codex-linux"), { recursive: true });
  fs.mkdirSync(outside, { recursive: true });
  fs.writeFileSync(path.join(outside, "unsafe-link-old-hook.sh"), "outside\n");
  fs.symlinkSync(outside, path.join(appDir, ".codex-linux", "prelaunch.d"), "junction");

  assert.throws(
    () => stageFeature(root, featuresRoot),
    /must (stay inside the install directory|not contain symbolic links)/,
  );
  assert.equal(fs.readFileSync(path.join(outside, "unsafe-link-old-hook.sh"), "utf8"), "outside\n");
});

test("disabled Linux features do not add package resources or dependencies", (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "codex-feature-package-disabled-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));

  const { featureDir, featuresRoot } = makeFeatureRoot(root, {
    id: "unsafe-link",
    title: "Unsafe Link",
    packageResources: [
      {
        source: "70-unsafe-link.rules",
        target: "usr/lib/udev/rules.d/70-unsafe-link.rules",
        mode: "0644",
        formats: ["deb", "rpm", "pacman"],
      },
    ],
    packageDependencies: {
      deb: ["libudev1"],
      rpm: ["systemd-udev"],
      pacman: ["systemd-libs"],
    },
  });
  fs.writeFileSync(path.join(featureDir, "70-unsafe-link.rules"), "SUBSYSTEM==\"hidraw\"\n");
  fs.writeFileSync(path.join(featuresRoot, "features.json"), '{"enabled":[]}\n');

  const options = { featuresRoot, packageFormat: "deb" };
  assert.deepEqual(enabledLinuxFeaturePackagePlan(options), {
    resources: [],
    dependencies: [],
  });
  assert.deepEqual(enabledLinuxFeaturePackageDependencies(options), []);
  assert.deepEqual(enabledLinuxFeaturePackageFiles(options), []);

  const packageRoot = path.join(root, "package-root");
  fs.mkdirSync(packageRoot);
  fs.writeFileSync(path.join(packageRoot, "sentinel"), "preserved\n");
  assert.deepEqual(stageEnabledLinuxFeaturePackageResources(packageRoot, options), {
    resources: [],
    dependencies: [],
  });
  assert.deepEqual(fs.readdirSync(packageRoot), ["sentinel"]);
});

test("enabled Linux features stage package resources with exact modes and reject payload collisions", (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "codex-feature-package-stage-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));

  const target = "usr/lib/udev/rules.d/70-unsafe-link.rules";
  const { featureDir, featuresRoot } = makeFeatureRoot(root, {
    id: "unsafe-link",
    title: "Unsafe Link",
    packageResources: [
      {
        source: "70-unsafe-link.rules",
        target,
        mode: "0640",
        formats: ["deb", "rpm"],
      },
    ],
    packageDependencies: {
      deb: ["libudev1"],
      rpm: ["systemd-udev"],
      pacman: ["systemd-libs"],
    },
  });
  const rule = 'SUBSYSTEM=="hidraw", TAG+="uaccess"\n';
  fs.writeFileSync(path.join(featureDir, "70-unsafe-link.rules"), rule);

  const options = { featuresRoot, packageFormat: "deb" };
  const plan = enabledLinuxFeaturePackagePlan(options);
  assert.deepEqual(plan.dependencies, ["libudev1"]);
  assert.equal(plan.resources.length, 1);
  assert.equal(plan.resources[0].id, "unsafe-link");
  assert.equal(plan.resources[0].target, target);
  assert.equal(plan.resources[0].mode, 0o640);
  assert.deepEqual(plan.resources[0].formats, ["deb", "rpm"]);
  assert.deepEqual(enabledLinuxFeaturePackageResourceMetadata(options), [
    { target, mode: "0640" },
  ]);

  const packageRoot = path.join(root, "package-root");
  assert.deepEqual(stageEnabledLinuxFeaturePackageResources(packageRoot, options), plan);
  const stagedTarget = path.join(packageRoot, target);
  assert.equal(fs.readFileSync(stagedTarget, "utf8"), rule);
  assert.equal(fs.statSync(stagedTarget).mode & 0o777, 0o640);

  fs.writeFileSync(stagedTarget, "tampered\n");
  fs.chmodSync(stagedTarget, 0o777);
  assert.throws(
    () => stageEnabledLinuxFeaturePackageResources(packageRoot, options),
    /conflicts with existing package payload/i,
  );
  assert.equal(fs.readFileSync(stagedTarget, "utf8"), "tampered\n");
  assert.equal(fs.statSync(stagedTarget).mode & 0o777, 0o777);
});

test("Linux feature package dependencies and files are sorted, deduplicated, and format-specific", (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "codex-feature-package-lists-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));

  const { featureDir, featuresRoot } = makeFeatureRoot(root, {
    id: "unsafe-link",
    title: "Unsafe Link",
    packageResources: [
      {
        source: "90-last.rules",
        target: "usr/lib/udev/rules.d/90-last.rules",
        formats: ["rpm", "deb", "deb"],
      },
      {
        source: "70-first.rules",
        target: "etc/udev/rules.d/70-first.rules",
        formats: ["deb"],
      },
      {
        source: "80-shared.rules",
        target: "usr/lib/udev/rules.d/80-shared.rules",
      },
    ],
    packageDependencies: {
      deb: ["zlib1g", "libudev1", "zlib1g"],
      rpm: ["zlib", "systemd-udev", "zlib"],
      pacman: ["zlib", "systemd-libs", "zlib"],
    },
  });
  for (const name of ["90-last.rules", "70-first.rules", "80-shared.rules"]) {
    fs.writeFileSync(path.join(featureDir, name), `${name}\n`);
  }

  const debOptions = { featuresRoot, packageFormat: "deb" };
  assert.deepEqual(enabledLinuxFeaturePackageDependencies(debOptions), ["libudev1", "zlib1g"]);
  assert.deepEqual(enabledLinuxFeaturePackageFiles(debOptions), [
    "/etc/udev/rules.d/70-first.rules",
    "/usr/lib/udev/rules.d/80-shared.rules",
    "/usr/lib/udev/rules.d/90-last.rules",
  ]);
  assert.deepEqual(
    enabledLinuxFeaturePackagePlan(debOptions).resources.map((resource) => resource.target),
    [
      "etc/udev/rules.d/70-first.rules",
      "usr/lib/udev/rules.d/80-shared.rules",
      "usr/lib/udev/rules.d/90-last.rules",
    ],
  );

  const rpmOptions = { featuresRoot, packageFormat: "rpm" };
  assert.deepEqual(enabledLinuxFeaturePackageDependencies(rpmOptions), ["systemd-udev", "zlib"]);
  assert.deepEqual(enabledLinuxFeaturePackageFiles(rpmOptions), [
    "/usr/lib/udev/rules.d/80-shared.rules",
    "/usr/lib/udev/rules.d/90-last.rules",
  ]);

  const pacmanOptions = { featuresRoot, packageFormat: "pacman" };
  assert.deepEqual(enabledLinuxFeaturePackageDependencies(pacmanOptions), ["systemd-libs", "zlib"]);
  assert.deepEqual(enabledLinuxFeaturePackageFiles(pacmanOptions), [
    "/usr/lib/udev/rules.d/80-shared.rules",
  ]);
});

test("Linux feature package resources reject traversal and package-root targets", () => {
  const cases = [
    { target: ".", error: /must not target the package root/i },
    { target: "./", error: /must not target the package root/i },
    { target: "../escape.rules", error: /must stay inside the package root/i },
    { target: "usr/lib/udev/../../escape.rules", error: /must stay inside the package root/i },
    { target: "DEBIAN", error: /reserved Debian control namespace/i },
    { target: "DEBIAN/preinst", error: /reserved Debian control namespace/i },
    { target: "usr/lib/udev/rules.d/bad\npath.rules", error: /unsafe package path component/i },
    { target: "usr/%{_libdir}/bad.rules", error: /unsafe package path component/i },
    { target: "usr/lib/udev/rules.d/*.rules", error: /unsafe package path component/i },
    { target: "usr/lib/udev/rules.d/-bad.rules", error: /unsafe package path component/i },
  ];

  for (const { target, error } of cases) {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "codex-feature-package-target-"));
    try {
      const { featureDir, featuresRoot } = makeFeatureRoot(root, {
        id: "unsafe-link",
        title: "Unsafe Link",
        packageResources: [{ source: "payload.rules", target, mode: "0644", formats: ["deb"] }],
      });
      fs.writeFileSync(path.join(featureDir, "payload.rules"), "payload\n");

      assert.throws(
        () => enabledLinuxFeaturePackagePlan({ featuresRoot, packageFormat: "deb" }),
        error,
        target,
      );
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  }
});

test("Linux feature package resources reject ancestor and descendant target overlaps", (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "codex-feature-package-overlap-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const { featureDir, featuresRoot } = makeFeatureRoot(root, {
    id: "unsafe-link",
    title: "Unsafe Link",
    packageResources: [
      { source: "tree", target: "usr/share/unsafe-link", mode: "0644", formats: ["deb"] },
      { source: "child.txt", target: "usr/share/unsafe-link/child.txt", mode: "0644", formats: ["deb"] },
    ],
  });
  fs.mkdirSync(path.join(featureDir, "tree"));
  fs.writeFileSync(path.join(featureDir, "tree", "payload.txt"), "tree\n");
  fs.writeFileSync(path.join(featureDir, "child.txt"), "child\n");

  assert.throws(
    () => enabledLinuxFeaturePackagePlan({ featuresRoot, packageFormat: "deb" }),
    /overlapping Linux feature package target/i,
  );
});

test("Linux feature package staging rejects symlinked resource sources", (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "codex-feature-package-source-link-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));

  const outside = path.join(root, "outside.rules");
  const target = "usr/lib/udev/rules.d/70-unsafe-link.rules";
  const { featureDir, featuresRoot } = makeFeatureRoot(root, {
    id: "unsafe-link",
    title: "Unsafe Link",
    packageResources: [
      { source: "payload-link.rules", target, mode: "0644", formats: ["deb"] },
    ],
  });
  fs.writeFileSync(outside, "outside\n");
  fs.symlinkSync(outside, path.join(featureDir, "payload-link.rules"));

  const packageRoot = path.join(root, "package-root");
  assert.throws(
    () => stageEnabledLinuxFeaturePackageResources(packageRoot, { featuresRoot, packageFormat: "deb" }),
    /must not contain symbolic links/i,
  );
  assert.equal(fs.existsSync(path.join(packageRoot, target)), false);
});

test("Linux feature package staging rejects symlinked source ancestors", (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "codex-feature-package-source-ancestor-link-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));

  const outside = path.join(root, "outside");
  const target = "usr/lib/udev/rules.d/70-unsafe-link.rules";
  const { featureDir, featuresRoot } = makeFeatureRoot(root, {
    id: "unsafe-link",
    title: "Unsafe Link",
    packageResources: [
      { source: "linked/payload.rules", target, mode: "0644", formats: ["deb"] },
    ],
  });
  fs.mkdirSync(outside);
  fs.writeFileSync(path.join(outside, "payload.rules"), "outside\n");
  fs.symlinkSync(outside, path.join(featureDir, "linked"), "junction");

  assert.throws(
    () => enabledLinuxFeaturePackagePlan({ featuresRoot, packageFormat: "deb" }),
    /must not contain symbolic links/i,
  );
});

test("Linux feature package staging rejects symlinked target parents", (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "codex-feature-package-target-link-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));

  const outside = path.join(root, "outside");
  const packageRoot = path.join(root, "package-root");
  const target = "usr/lib/udev/rules.d/70-unsafe-link.rules";
  const { featureDir, featuresRoot } = makeFeatureRoot(root, {
    id: "unsafe-link",
    title: "Unsafe Link",
    packageResources: [
      { source: "payload.rules", target, mode: "0644", formats: ["deb"] },
    ],
  });
  fs.writeFileSync(path.join(featureDir, "payload.rules"), "payload\n");
  fs.mkdirSync(path.join(packageRoot, "usr", "lib", "udev"), { recursive: true });
  fs.mkdirSync(outside);
  fs.symlinkSync(outside, path.join(packageRoot, "usr", "lib", "udev", "rules.d"), "junction");

  assert.throws(
    () => stageEnabledLinuxFeaturePackageResources(packageRoot, { featuresRoot, packageFormat: "deb" }),
    /must (stay inside the package root|not contain symbolic links)/i,
  );
  assert.equal(fs.existsSync(path.join(outside, "70-unsafe-link.rules")), false);
});

test("Linux feature package resources reject invalid modes and formats", () => {
  const invalidResources = [
    {
      resource: {
        source: "payload.rules",
        target: "usr/lib/udev/rules.d/payload.rules",
        mode: 644,
        formats: ["deb"],
      },
      error: /file mode must be a quoted octal string/i,
    },
    {
      resource: {
        source: "payload.rules",
        target: "usr/lib/udev/rules.d/payload.rules",
        mode: "0899",
        formats: ["deb"],
      },
      error: /file mode must be a quoted octal string/i,
    },
    {
      resource: {
        source: "payload.rules",
        target: "usr/lib/udev/rules.d/payload.rules",
        mode: "0644",
        formats: ["deb", "appimage"],
      },
      error: /unsupported package format.*appimage/i,
    },
    {
      resource: {
        source: "payload.rules",
        target: "usr/lib/udev/rules.d/payload.rules",
        mode: "0644",
        formats: "deb",
      },
      error: /formats must be an array/i,
    },
  ];

  for (const { resource, error } of invalidResources) {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "codex-feature-package-invalid-resource-"));
    try {
      const { featureDir, featuresRoot } = makeFeatureRoot(root, {
        id: "unsafe-link",
        title: "Unsafe Link",
        packageResources: [resource],
      });
      fs.writeFileSync(path.join(featureDir, "payload.rules"), "payload\n");
      assert.throws(
        () => enabledLinuxFeaturePackagePlan({ featuresRoot, packageFormat: "deb" }),
        error,
      );
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  }

  const root = fs.mkdtempSync(path.join(os.tmpdir(), "codex-feature-package-invalid-format-"));
  try {
    const { featuresRoot } = makeFeatureRoot(root, {
      id: "unsafe-link",
      title: "Unsafe Link",
    });
    assert.throws(
      () => enabledLinuxFeaturePackagePlan({ featuresRoot, packageFormat: "appimage" }),
      /unsupported package format.*appimage/i,
    );
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("Linux feature package dependencies reject unsafe tokens and unsupported formats", () => {
  const invalidDependencies = [
    { packageDependencies: { deb: ["libudev1;curl"] }, error: /invalid.*dependency/i },
    { packageDependencies: { deb: [""] }, error: /invalid.*dependency/i },
    { packageDependencies: { deb: "libudev1" }, error: /dependencies.*array/i },
    { packageDependencies: { appimage: ["libudev1"] }, error: /unsupported package format.*appimage/i },
    { packageDependencies: { rpm: ["libudev.so.1%(id)"] }, error: /invalid.*dependency/i },
    { packageDependencies: { rpm: ["libudev.so.1%{_libdir}"] }, error: /invalid.*dependency/i },
    {
      packageDependencies: { rpm: ["libudev.so.1%{codex_elf_suffix}%(id)"] },
      error: /invalid.*dependency/i,
    },
  ];

  for (const { packageDependencies, error } of invalidDependencies) {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "codex-feature-package-invalid-dependency-"));
    try {
      const { featuresRoot } = makeFeatureRoot(root, {
        id: "unsafe-link",
        title: "Unsafe Link",
        packageDependencies,
      });
      assert.throws(
        () => enabledLinuxFeaturePackagePlan({ featuresRoot, packageFormat: "deb" }),
        error,
      );
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  }
});
