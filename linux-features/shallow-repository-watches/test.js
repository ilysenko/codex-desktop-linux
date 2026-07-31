#!/usr/bin/env node
"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const {
  loadLinuxFeaturePatchDescriptors,
} = require("../../scripts/lib/linux-features.js");
const {
  PATCH_MARKER,
  PARCEL_WATCH_MARKER,
  descriptors,
  findLocalFileWatchBundles,
  patchWorker,
  patchWorkerSource,
} = require("./patch.js");

function localWorkerSource() {
  return [
    "var LocalHost=class{",
    "async platformPath(){return E.default.posix}",
    "async startFileWatch(e){let t=jH(),n=!1,r=await this.platformPath(),",
    "i=(0,w.watch)(this.getFileSystemPath(e.path),{recursive:e.recursive},()=>{});",
    "return{coverage:{recursive:e.recursive},path:e.path,closed:t.promise}}",
    "};",
  ].join("");
}

function parcelWorkingTreeSource() {
  return [
    "function create(t,n){return t.isLocal?process.platform===`linux`?",
    "Jve(n,{ignoredPaths:[E.posix.join(n.path,`.git`)]}):",
    "e.startFileWatch(n):t.startFileWatch(n)}",
  ].join("");
}

function withFeatureConfig(enabled, callback) {
  const original = process.env.CODEX_LINUX_FEATURES_CONFIG;
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "codex-shallow-watch-config-"));
  process.env.CODEX_LINUX_FEATURES_CONFIG = path.join(tempDir, "features.json");
  try {
    fs.writeFileSync(process.env.CODEX_LINUX_FEATURES_CONFIG, JSON.stringify({ enabled }));
    return callback();
  } finally {
    if (original == null) delete process.env.CODEX_LINUX_FEATURES_CONFIG;
    else process.env.CODEX_LINUX_FEATURES_CONFIG = original;
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
}

function instantiate(source, platform, watchCalls) {
  const LocalHost = new Function(
    "process",
    "E",
    "jH",
    "w",
    `${source};return LocalHost;`,
  )(
    { platform },
    { default: { posix: path.posix } },
    () => ({ promise: Promise.resolve() }),
    {
      watch: (watchedPath, options) => {
        watchCalls.push({ watchedPath, options });
        return { close() {}, on() {} };
      },
    },
  );
  const host = new LocalHost();
  host.getFileSystemPath = (value) => value;
  return host;
}

test("feature is disabled until selected and conflicts with the directory-tree strategy", () => {
  const featuresRoot = path.resolve(__dirname, "..");
  withFeatureConfig([], () => {
    assert.equal(
      loadLinuxFeaturePatchDescriptors({ featuresRoot })
        .some((descriptor) => descriptor.id === "feature:shallow-repository-watches:local-file-watch"),
      false,
    );
  });
  withFeatureConfig(["shallow-repository-watches"], () => {
    assert.equal(
      loadLinuxFeaturePatchDescriptors({ featuresRoot })
        .some((descriptor) => descriptor.id === "feature:shallow-repository-watches:local-file-watch"),
      true,
    );
  });
  assert.throws(
    () => withFeatureConfig(
      ["shallow-repository-watches", "directory-only-working-tree-watch"],
      () => loadLinuxFeaturePatchDescriptors({ featuresRoot }),
    ),
    /conflicts with 'directory-only-working-tree-watch'/,
  );
});

test("patch is idempotent and downgrades every Linux recursive request", async () => {
  const first = patchWorkerSource(localWorkerSource());
  assert.equal(first.matched, 1);
  assert.equal(first.changed, 1);
  assert.equal(first.source.split(PATCH_MARKER).length - 1, 1);
  assert.match(
    first.source,
    /process\.platform===`linux`&&e\.recursive\)\{\/\*codexLinuxShallowRepositoryWatches\*\/e=\{\.\.\.e,recursive:!1\}\}/,
  );
  const second = patchWorkerSource(first.source);
  assert.deepEqual(second, { source: first.source, matched: 1, changed: 0, reason: null });

  for (const renameEventHandling of ["changed-path", "changed-path-with-parent-directory"]) {
    const calls = [];
    const host = instantiate(first.source, "linux", calls);
    const session = await host.startFileWatch({
      path: renameEventHandling === "changed-path" ? "/repo/.git/refs" : "/repo",
      recursive: true,
      renameEventHandling,
    });
    assert.equal(calls[0].options.recursive, false);
    assert.deepEqual(session.coverage, { recursive: false });
  }
});

test("patch preserves non-recursive Linux watches and recursive watches on other platforms", async () => {
  const source = patchWorkerSource(localWorkerSource()).source;
  const linuxCalls = [];
  const linux = instantiate(source, "linux", linuxCalls);
  const linuxSession = await linux.startFileWatch({ path: "/repo", recursive: false });
  assert.equal(linuxCalls[0].options.recursive, false);
  assert.deepEqual(linuxSession.coverage, { recursive: false });

  const darwinCalls = [];
  const darwin = instantiate(source, "darwin", darwinCalls);
  const darwinSession = await darwin.startFileWatch({ path: "/repo", recursive: true });
  assert.equal(darwinCalls[0].options.recursive, true);
  assert.deepEqual(darwinSession.coverage, { recursive: true });
});

test("routes the current Linux Parcel working-tree branch through the shallow host", () => {
  const first = patchWorkerSource(`${localWorkerSource()}${parcelWorkingTreeSource()}`);
  assert.equal(first.matched, 1);
  assert.equal(first.changed, 1);
  assert.equal(first.source.split(PARCEL_WATCH_MARKER).length - 1, 1);
  assert.doesNotMatch(first.source, /process\.platform===`linux`\?Jve/);
  assert.match(
    first.source,
    /codexLinuxShallowParcelWorkingTreeWatch\*\/e\.startFileWatch\(n\)/,
  );
  assert.deepEqual(
    patchWorkerSource(first.source),
    { source: first.source, matched: 1, changed: 0, reason: null },
  );
});

test("feature atomically patches both current build bundles", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "codex-shallow-watch-bundle-"));
  try {
    const buildDir = path.join(root, ".vite", "build");
    fs.mkdirSync(buildDir, { recursive: true });
    fs.writeFileSync(path.join(buildDir, "unrelated.js"), "var worker={startFileWatch(){}};");
    fs.writeFileSync(path.join(buildDir, "src-current.js"), localWorkerSource());
    fs.writeFileSync(
      path.join(buildDir, "worker.js"),
      `${localWorkerSource()}${parcelWorkingTreeSource()}`,
    );

    const discovery = findLocalFileWatchBundles(root);
    assert.deepEqual(
      discovery.candidates.map(({ bundlePath }) => path.basename(bundlePath)),
      ["src-current.js", "worker.js"],
    );
    const first = patchWorker(root);
    assert.deepEqual(first, {
      matched: 2,
      changed: 2,
      reason: null,
      targets: [
        path.join(".vite", "build", "src-current.js"),
        path.join(".vite", "build", "worker.js"),
      ],
    });
    const second = patchWorker(root);
    assert.equal(second.matched, 2);
    assert.equal(second.changed, 0);
    for (const { bundlePath } of discovery.candidates) {
      assert.equal(fs.readFileSync(bundlePath, "utf8").split(PATCH_MARKER).length - 1, 1);
    }
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("current bundle drift leaves every candidate byte-identical", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "codex-shallow-watch-drift-"));
  try {
    const buildDir = path.join(root, ".vite", "build");
    fs.mkdirSync(buildDir, { recursive: true });
    const source = localWorkerSource();
    fs.writeFileSync(path.join(buildDir, "worker.js"), source);

    const result = patchWorker(root);
    assert.equal(result.matched, 0);
    assert.equal(result.changed, 0);
    assert.match(result.reason, /1 local startFileWatch implementation/);
    assert.equal(fs.readFileSync(path.join(buildDir, "worker.js"), "utf8"), source);
    assert.equal(descriptors[0].status(result, []).status, "skipped-optional");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("an extra Parcel working-tree branch leaves current bundles byte-identical", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "codex-shallow-watch-parcel-drift-"));
  try {
    const buildDir = path.join(root, ".vite", "build");
    fs.mkdirSync(buildDir, { recursive: true });
    const sources = new Map([
      ["src-current.js", localWorkerSource()],
      ["worker.js", `${localWorkerSource()}${parcelWorkingTreeSource()}`],
      ["worker-extra.js", parcelWorkingTreeSource()],
    ]);
    for (const [name, source] of sources) fs.writeFileSync(path.join(buildDir, name), source);

    const result = patchWorker(root);
    assert.equal(result.matched, 0);
    assert.equal(result.changed, 0);
    assert.match(result.reason, /2 Parcel working-tree branches across 3 candidate bundles/);
    for (const [name, source] of sources) {
      assert.equal(fs.readFileSync(path.join(buildDir, name), "utf8"), source);
    }
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("ambiguous or drifted local hosts remain byte-identical", () => {
  const source = `${localWorkerSource()}${localWorkerSource()}`;
  const result = patchWorkerSource(source);
  assert.equal(result.source, source);
  assert.equal(result.matched, 0);
  assert.equal(result.changed, 0);
  assert.match(result.reason, /Found 2 local startFileWatch implementations/);
  assert.equal(descriptors[0].status(result, []).status, "skipped-optional");
});
