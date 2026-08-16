#!/usr/bin/env node
"use strict";

const assert = require("node:assert/strict");
const childProcess = require("node:child_process");
const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const {
  createPatchReport,
  criticalFailuresFromReport,
  enabledFeatureFailuresFromReport,
} = require("../../scripts/lib/patch-report.js");
const {
  applyExtractedAppPatchDescriptors,
} = require("../../scripts/patches/engine.js");

const {
  DEFAULT_MAX_WATCHES,
  HELPER_NAME,
  PARCEL_FALLBACK_SYMBOL_KEY,
  PARCEL_WATCH_MARKER,
  PARCEL_WORKING_TREE_WATCH,
  QUALIFICATION_WARNINGS_SYMBOL_KEY,
  REPORT_SHIM_SYMBOL_KEY,
  WATCHBOUND_VERSION,
  codexLinuxStartDirectoryOnlyWorkingTreeWatch,
  descriptors,
  findLocalFileWatchBundles,
  normalizedSettings,
  patchWorker,
  patchWorkerSource,
} = require("./patch.js");
const {
  commitPackageDirectoryNoReplace,
  currentArtifactManifest,
  packageHelperExitCode,
  packageTarget,
  stageWatchboundPackages,
  validateArtifactManifest,
  validateTargetRuntime,
  verifyControlledPackageRoot,
} = require("./watchbound-package.js");

test("Nix Node 24.14 compatibility keeps a separate exact loader hash", () => {
  const original = process.env.CODEX_WATCHBOUND_NIX_NODE_24_14;
  delete process.env.CODEX_WATCHBOUND_NIX_NODE_24_14;
  const upstreamHash = currentArtifactManifest().packages.loader.files["native-matrix.json"];
  process.env.CODEX_WATCHBOUND_NIX_NODE_24_14 = "1";
  const nixHash = currentArtifactManifest().packages.loader.files["native-matrix.json"];
  if (original === undefined) delete process.env.CODEX_WATCHBOUND_NIX_NODE_24_14;
  else process.env.CODEX_WATCHBOUND_NIX_NODE_24_14 = original;
  assert.equal(upstreamHash, "4f63e441d5fc05a80ede19d32aefc9c6b4b3309a28e3c225078224099ad07769");
  assert.equal(nixHash, "8ea0c8101cc7d0f97a5d988ce30240914a1ae5fecce7f6c4d02a7b80359e6cf4");
});

const MODULE_OVERRIDE_KEY = Symbol.for(
  "codex-linux.directory-only-working-tree-watch.test-module",
);
const ENGINE_KEY = Symbol.for(
  "codex-linux.directory-only-working-tree-watch.watchbound-engine",
);
const QUALIFICATION_WARNINGS_KEY = Symbol.for(QUALIFICATION_WARNINGS_SYMBOL_KEY);

function tempDirectory(t, prefix) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  return directory;
}

function writeFile(filePath, contents, mode) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, contents, mode == null ? undefined : { mode });
}

function writeJson(filePath, value) {
  writeFile(filePath, `${JSON.stringify(value, null, 2)}\n`);
}

function sha256(contents) {
  return crypto.createHash("sha256").update(contents).digest("hex");
}

function currentBundleFixture() {
  return [
    "var CurrentWatcher=class{runsInsideWsl;hostConfig={id:`local`," +
      "display_name:`Local`,kind:`local`};id=`local`;isLocal=!0;",
    "async platformPath(){return x}",
    "getFileSystemPath(e){return e}",
    "async startFileWatch(e){",
    "let t=await this.platformPath(),n=(0,r.watch)(",
    "this.getFileSystemPath(e.path),{recursive:e.recursive});",
    "return {path:e.path,dispose(){n.close()}}",
    "}",
    "}",
  ].join("");
}

// Exact relevant fragments from OpenAI Desktop 26.803.41515. Keep these
// independent of patch.js so drift in the production contract cannot silently
// rewrite the test fixture into a passing shape.
const CURRENT_WORKER_LOCAL_FILE_WATCH = [
  "async startFileWatch(e){let t=oV(),n=!1,r=await this.platformPath(),",
  "i=(0,w.watch)(this.getFileSystemPath(e.path),{recursive:e.recursive},(t,n)=>{",
  "let i=n==null?null:r.join(e.path,...n.split(this.runsInsideWsl?",
  "E.default.win32.sep:E.default.sep)),a=i==null?[]:[i];i!=null&&t===`rename`&&",
  "e.renameEventHandling===`changed-path-with-parent-directory`&&a.push(r.dirname(i)),",
  "e.onChange({changedPaths:a})}),a=e=>{n||(n=!0,i.close(),t.resolve(e))};",
  "return i.on(`error`,e=>{a({reason:`watch-error`,error:e})}),{coverage:{recursive:",
  "e.recursive,typedPathChanges:!1},path:e.path,closed:t.promise,dispose:async()=>{",
  "a({reason:`disposed`})}}}",
].join("");

const CURRENT_SRC_LOCAL_FILE_WATCH = [
  "async startFileWatch(e){let t=gb(),n=!1,r=await this.platformPath(),",
  "a=(0,c.watch)(this.getFileSystemPath(e.path),{recursive:e.recursive},(t,n)=>{",
  "let a=n==null?null:r.join(e.path,...n.split(this.runsInsideWsl?",
  "i.default.win32.sep:i.default.sep)),o=a==null?[]:[a];a!=null&&t===`rename`&&",
  "e.renameEventHandling===`changed-path-with-parent-directory`&&o.push(r.dirname(a)),",
  "e.onChange({changedPaths:o})}),o=e=>{n||(n=!0,a.close(),t.resolve(e))};",
  "return a.on(`error`,e=>{o({reason:`watch-error`,error:e})}),{coverage:{recursive:",
  "e.recursive,typedPathChanges:!1},path:e.path,closed:t.promise,dispose:async()=>{",
  "o({reason:`disposed`})}}}",
].join("");

const CURRENT_WORKER_REMOTE_FILE_WATCH = [
  "async startFileWatch(e){let{onChange:t,...n}=e,r=await this.callHost(e=>",
  "e.startFileWatch(n,t)),i=!1,a=()=>{i||(i=!0,r[Symbol.dispose]())},o,s;try{",
  "[o,s]=await Promise.all([r.coverage,r.path])}catch(e){throw a(),e}let c=r.closed()",
  ".finally(a);return{coverage:o,path:s,closed:c,dispose:async()=>{try{await r.dispose()}",
  "finally{a()}}}}",
].join("");

const CURRENT_SRC_REMOTE_FILE_WATCH = [
  "async startFileWatch(e){let t=await this.startFileWatchSession({onChange:e.onChange,",
  "path:e.path,watchId:e.watchId});return{coverage:t.coverage,path:t.path,closed:t.closed,",
  "dispose:async()=>{await t.dispose()}}}",
].join("");

const CURRENT_PARCEL_HELPER =
  "async function oye(e,t){return new sye(await import(`@parcel/watcher`),e,t).start()}";
const CURRENT_GIT_ROUTE_PREFIX =
  "case`git`:{let e=new Que;return{git:{createExecutionHost:e=>{if(n==null)" +
  "throw Error(`Git hosts require a main RPC connection`);return new nde(n,e)},";
const CURRENT_PARCEL_ROUTE =
  "startWorkingTreeWatch:(t,n)=>t.isLocal?process.platform===`linux`?" +
  "oye(n,{ignoredPaths:[E.posix.join(n.path,`.git`)]}):e.startFileWatch(n):" +
  "t.startFileWatch(n)";
const CURRENT_WATCHBOUND_ROUTE =
  `startWorkingTreeWatch:(t,n)=>t.isLocal?process.platform===\`linux\`?` +
  `/*${PARCEL_WATCH_MARKER}*/e.startFileWatch({...n,` +
  `[Symbol.for(\`${PARCEL_FALLBACK_SYMBOL_KEY}\`)]:()=>` +
  "oye(n,{ignoredPaths:[E.posix.join(n.path,`.git`)]})}):" +
  "e.startFileWatch(n):t.startFileWatch(n)";
const CURRENT_GIT_ROUTE_SUFFIX = "}}}case`open-in`:";

function currentWorkerSource(route = CURRENT_PARCEL_ROUTE) {
  return [
    "var Que=class{runsInsideWsl;hostConfig={id:`local`,display_name:`Local`," +
      "kind:`local`};id=`local`;isLocal=!0;",
    CURRENT_WORKER_LOCAL_FILE_WATCH,
    "};var CurrentWorkerRemote=class{",
    CURRENT_WORKER_REMOTE_FILE_WATCH,
    "};",
    CURRENT_PARCEL_HELPER,
    "function currentDependencies(r,n){switch(r){",
    CURRENT_GIT_ROUTE_PREFIX,
    route,
    CURRENT_GIT_ROUTE_SUFFIX,
    "return{openIn:null}}}",
  ].join("");
}

function currentSrcSource() {
  return [
    "var CurrentSrcRemote=class{",
    CURRENT_SRC_REMOTE_FILE_WATCH,
    "};var are=class{runsInsideWsl;hostConfig={id:`local`,display_name:`Local`," +
      "kind:`local`};id=`local`;isLocal=!0;",
    CURRENT_SRC_LOCAL_FILE_WATCH,
    "};",
  ].join("");
}

function currentBundlePair(t, overrides = {}) {
  const extractedDir = tempDirectory(t, "directory-watch-current-contract-");
  const buildDir = path.join(extractedDir, ".vite", "build");
  const sources = new Map([
    ["src-Cz_uUmVl.js", overrides.src ?? currentSrcSource()],
    ["worker.js", overrides.worker ?? currentWorkerSource()],
    ...Object.entries(overrides.extra ?? {}),
  ]);
  for (const [name, source] of sources) {
    writeFile(path.join(buildDir, name), source);
  }
  return { buildDir, extractedDir, sources };
}

function readBundlePair(candidate) {
  return new Map(
    [...candidate.sources].map(([name]) => [
      name,
      fs.readFileSync(path.join(candidate.buildDir, name), "utf8"),
    ]),
  );
}

function captureWarns(fn) {
  const warnings = [];
  const originalWarn = console.warn;
  console.warn = (...args) => warnings.push(args.map(String).join(" "));
  try {
    return { value: fn(), warnings };
  } finally {
    console.warn = originalWarn;
  }
}

test("settings retain the existing bounded policy surface", () => {
  assert.deepEqual(normalizedSettings(), {
    maxWatches: DEFAULT_MAX_WATCHES,
    honorGitIgnore: true,
    ignoredDirectoryNames: [],
  });
  assert.deepEqual(normalizedSettings({
    feature: {
      settings: {
        maxWatches: 100_000,
        honorGitIgnore: false,
        ignoredDirectoryNames: [
          "node_modules",
          "node_modules",
          ".next",
          "..",
          "a/b",
          "nul\0name",
        ],
      },
    },
  }), {
    maxWatches: 65_536,
    honorGitIgnore: false,
    ignoredDirectoryNames: ["node_modules", ".next"],
  });
});

test("the worker patch injects one Watchbound adapter and is idempotent", () => {
  const settings = normalizedSettings({
    feature: {
      settings: {
        maxWatches: 4096,
        ignoredDirectoryNames: ["node_modules"],
      },
    },
  });
  const first = patchWorkerSource(currentBundleFixture(), settings);
  assert.equal(first.matched, 1);
  assert.equal(first.changed, 1);
  assert.match(first.source, new RegExp(`function ${HELPER_NAME}\\(`, "u"));
  assert.match(first.source, /await import\("watchbound"\)/u);
  assert.match(first.source, /initialExclusions/u);
  assert.match(first.source, /excludedDirectoryNames/u);
  assert.match(first.source, /observedExcludedPaths/u);
  assert.match(first.source, /replaceExclusions/u);
  assert.doesNotMatch(first.source, /discoverNameExclusions/u);
  assert.doesNotMatch(first.source, /fs\.promises\.readdir/u);
  assert.match(first.source, /recoverRoot/u);
  assert.match(first.source, /nativeWatchBudget/u);
  assert.match(
    first.source,
    /defaultQualificationRetryDelays = \[250, 500, 1000, 2000\]/u,
  );
  assert.match(first.source, /"maxWatches":4096/u);
  assert.match(first.source, /"ignoredDirectoryNames":\["node_modules"\]/u);

  const second = patchWorkerSource(first.source, settings);
  assert.equal(second.matched, 1);
  assert.equal(second.changed, 0);
  assert.equal(second.source, first.source);
  const legacy = patchWorkerSource(
    first.source.replace('await import("watchbound")', "Promise.resolve({})"),
    settings,
  );
  assert.equal(legacy.matched, 0);
  assert.match(legacy.reason, /current 26\.803\.41515 working-tree contract rejected/iu);
});

test("the current OpenAI Parcel route hands the working tree to the Watchbound host", () => {
  const first = patchWorkerSource(
    currentWorkerSource(),
    normalizedSettings(),
  );
  assert.equal(first.matched, 1);
  assert.equal(first.changed, 1);
  assert.equal(first.source.split(PARCEL_WATCH_MARKER).length - 1, 1);
  PARCEL_WORKING_TREE_WATCH.lastIndex = 0;
  assert.equal(PARCEL_WORKING_TREE_WATCH.test(first.source), false);
  assert.match(
    first.source,
    /codexLinuxWatchboundParcelWorkingTreeWatch\*\/e\.startFileWatch\(\{\.\.\.n,/u,
  );
  assert.match(
    first.source,
    /e\.recursive&&e\.renameEventHandling===`changed-path-with-parent-directory`\)\{let codexLinuxWatchboundWatcher=await codexLinuxStartDirectoryOnlyWorkingTreeWatch/u,
  );
  assert.ok(first.source.includes(CURRENT_WATCHBOUND_ROUTE));
  assert.ok(first.source.includes(CURRENT_PARCEL_HELPER));
  assert.match(first.source, /\]:\(\)=>oye\(n,\{ignoredPaths:/u);
  assert.ok(first.source.includes(CURRENT_WORKER_REMOTE_FILE_WATCH));

  const second = patchWorkerSource(first.source, normalizedSettings());
  assert.deepEqual(second, { source: first.source, matched: 1, changed: 0, reason: null });

  const helperOnly = patchWorkerSource(currentBundleFixture(), normalizedSettings());
  const partial = patchWorkerSource(
    `${helperOnly.source}${CURRENT_PARCEL_HELPER}` +
      `${CURRENT_GIT_ROUTE_PREFIX}${CURRENT_PARCEL_ROUTE}${CURRENT_GIT_ROUTE_SUFFIX}`,
    normalizedSettings(),
  );
  assert.equal(partial.matched, 0);
  assert.equal(partial.changed, 0);
  assert.equal(partial.source, `${helperOnly.source}${CURRENT_PARCEL_HELPER}` +
    `${CURRENT_GIT_ROUTE_PREFIX}${CURRENT_PARCEL_ROUTE}${CURRENT_GIT_ROUTE_SUFFIX}`);
});

test("correlates minified aliases instead of pinning their spellings", () => {
  const parcelHelper =
    "async function parcelStart(root,settings){return new ParcelWatcher(" +
    "await import(`@parcel/watcher`),root,settings).start()}";
  const gitRoutePrefix =
    "case`git`:{let localHost=new LocalHost;return{git:{" +
    "createExecutionHost:executionOptions=>{if(mainConnection==null)" +
    "throw Error(`Git hosts require a main RPC connection`);" +
    "return new RemoteHost(mainConnection,executionOptions)},";
  const parcelRoute =
    "startWorkingTreeWatch:(host,options)=>host.isLocal?process.platform===`linux`?" +
    "parcelStart(options,{ignoredPaths:[pathApi.posix.join(options.path,`.git`)]}):" +
    "localHost.startFileWatch(options):host.startFileWatch(options)";
  const worker = currentWorkerSource(parcelRoute)
    .replace(CURRENT_PARCEL_HELPER, parcelHelper)
    .replace(CURRENT_GIT_ROUTE_PREFIX, gitRoutePrefix)
    .replace("var Que=class{", "var LocalHost=class{");

  const first = patchWorkerSource(worker, normalizedSettings());
  assert.equal(first.matched, 1);
  assert.equal(first.changed, 1);
  assert.ok(first.source.includes(parcelHelper));
  assert.ok(first.source.includes(
    `startWorkingTreeWatch:(host,options)=>host.isLocal?process.platform===\`linux\`?` +
      `/*${PARCEL_WATCH_MARKER}*/localHost.startFileWatch({...options,` +
      `[Symbol.for(\`${PARCEL_FALLBACK_SYMBOL_KEY}\`)]:()=>` +
      "parcelStart(options,{ignoredPaths:[pathApi.posix.join(options.path,`.git`)]})}):" +
      "localHost.startFileWatch(options):host.startFileWatch(options)",
  ));
  assert.match(first.source, /parcelStart\(options,/u);

  const second = patchWorkerSource(first.source, normalizedSettings());
  assert.deepEqual(second, { source: first.source, matched: 1, changed: 0, reason: null });
});

test("feature patch reports drift instead of patching an ambiguous bundle", () => {
  const result = patchWorkerSource(
    `${currentBundleFixture()}${currentBundleFixture()}`,
    normalizedSettings(),
  );

  assert.equal(result.matched, 0);
  assert.equal(result.changed, 0);
  assert.match(result.reason, /current 26\.803\.41515 working-tree contract rejected/iu);
  const descriptor = descriptors.find(({ id }) => id === "worker-directory-watch");
  assert.equal(descriptor.status(result, []).status, "skipped-optional");
});

test("bundle discovery patches the current src and worker copies", (t) => {
  const extractedDir = tempDirectory(t, "directory-watch-bundle-");
  const buildDir = path.join(extractedDir, ".vite", "build");
  writeFile(path.join(buildDir, "unrelated.js"), "const unrelated=true;");
  const targets = [
    path.join(buildDir, "src-Cz_uUmVl.js"),
    path.join(buildDir, "worker.js"),
  ];
  writeFile(targets[0], currentSrcSource());
  writeFile(targets[1], currentWorkerSource());

  const discovery = findLocalFileWatchBundles(
    extractedDir,
    normalizedSettings(),
  );
  assert.deepEqual(
    discovery.targets.map(({ bundlePath, result }) => ({
      bundlePath,
      matched: result.matched,
      changed: result.changed,
    })),
    targets.map((bundlePath) => ({ bundlePath, matched: 1, changed: 1 })),
  );

  const first = patchWorker(extractedDir);
  assert.equal(first.matched, 2);
  assert.equal(first.changed, 2);
  assert.deepEqual(first.targets, [
    path.join(".vite", "build", "src-Cz_uUmVl.js"),
    path.join(".vite", "build", "worker.js"),
  ]);
  for (const target of targets) {
    const source = fs.readFileSync(target, "utf8");
    assert.match(source, /watchbound/u);
    assert.doesNotThrow(() => new Function(source));
  }
  const workerSource = fs.readFileSync(targets[1], "utf8");
  assert.equal(workerSource.split(PARCEL_WATCH_MARKER).length - 1, 1);
  PARCEL_WORKING_TREE_WATCH.lastIndex = 0;
  assert.equal(PARCEL_WORKING_TREE_WATCH.test(workerSource), false);

  const second = patchWorker(extractedDir);
  assert.equal(second.matched, 2);
  assert.equal(second.changed, 0);
  assert.deepEqual(second.targets, first.targets);
});

test("bundle discovery rejects a missing Parcel route without changing either bundle", (t) => {
  const extractedDir = tempDirectory(t, "directory-watch-missing-parcel-");
  const buildDir = path.join(extractedDir, ".vite", "build");
  const sources = new Map([
    ["src-current.js", currentBundleFixture()],
    ["worker.js", currentBundleFixture()],
  ]);
  for (const [name, source] of sources) writeFile(path.join(buildDir, name), source);

  const originalWarn = console.warn;
  console.warn = () => {};
  let result;
  try {
    result = patchWorker(extractedDir);
  } finally {
    console.warn = originalWarn;
  }
  assert.equal(result.matched, 0);
  assert.equal(result.changed, 0);
  assert.match(result.reason, /0 Parcel route contracts/u);
  for (const [name, source] of sources) {
    assert.equal(fs.readFileSync(path.join(buildDir, name), "utf8"), source);
  }
});

test("bundle discovery rejects duplicate Parcel routes without changing either bundle", (t) => {
  const extractedDir = tempDirectory(t, "directory-watch-duplicate-parcel-");
  const buildDir = path.join(extractedDir, ".vite", "build");
  const sources = new Map([
    ["src-current.js", currentBundleFixture()],
    [
      "worker.js",
      `${currentWorkerSource()}${CURRENT_GIT_ROUTE_PREFIX}` +
        `${CURRENT_PARCEL_ROUTE}${CURRENT_GIT_ROUTE_SUFFIX}`,
    ],
  ]);
  for (const [name, source] of sources) writeFile(path.join(buildDir, name), source);

  const originalWarn = console.warn;
  console.warn = () => {};
  let result;
  try {
    result = patchWorker(extractedDir);
  } finally {
    console.warn = originalWarn;
  }
  assert.equal(result.matched, 0);
  assert.equal(result.changed, 0);
  assert.match(result.reason, /2 Parcel route contracts/u);
  for (const [name, source] of sources) {
    assert.equal(fs.readFileSync(path.join(buildDir, name), "utf8"), source);
  }
});

test("bundle discovery rejects a Parcel route outside worker.js without changing bundles", (t) => {
  const extractedDir = tempDirectory(t, "directory-watch-misplaced-parcel-");
  const buildDir = path.join(extractedDir, ".vite", "build");
  const sources = new Map([
    [
      "src-current.js",
      `${currentBundleFixture()}${CURRENT_PARCEL_HELPER}${CURRENT_GIT_ROUTE_PREFIX}` +
        `${CURRENT_PARCEL_ROUTE}${CURRENT_GIT_ROUTE_SUFFIX}`,
    ],
    ["worker.js", currentBundleFixture()],
  ]);
  for (const [name, source] of sources) writeFile(path.join(buildDir, name), source);

  const originalWarn = console.warn;
  console.warn = () => {};
  let result;
  try {
    result = patchWorker(extractedDir);
  } finally {
    console.warn = originalWarn;
  }
  assert.equal(result.matched, 0);
  assert.equal(result.changed, 0);
  assert.match(result.reason, /1 Parcel route contracts, and 0 in worker\.js/u);
  for (const [name, source] of sources) {
    assert.equal(fs.readFileSync(path.join(buildDir, name), "utf8"), source);
  }
});

test("bundle discovery rejects copies outside the current src and worker pair", (t) => {
  const extractedDir = tempDirectory(t, "directory-watch-ambiguous-");
  const buildDir = path.join(extractedDir, ".vite", "build");
  for (const name of ["src-first.js", "src-second.js", "worker.js"]) {
    writeFile(path.join(buildDir, name), currentBundleFixture());
  }

  const originalWarn = console.warn;
  console.warn = () => {};
  let result;
  try {
    result = patchWorker(extractedDir);
  } finally {
    console.warn = originalWarn;
  }
  assert.equal(result.matched, 0);
  assert.equal(result.changed, 0);
  assert.match(result.reason, /Found 3 current local startFileWatch bundles/u);
});

test("patches the pristine 26.803.41515 bundle contract and accepts only its exact completed state", (t) => {
  const candidate = currentBundlePair(t, {
    extra: { "unrelated.js": "const unrelatedWatch=host.startFileWatch(options);" },
  });
  const pristine = readBundlePair(candidate);

  const first = patchWorker(candidate.extractedDir);
  assert.equal(first.matched, 2);
  assert.equal(first.changed, 2);
  assert.deepEqual(first.targets, [
    path.join(".vite", "build", "src-Cz_uUmVl.js"),
    path.join(".vite", "build", "worker.js"),
  ]);

  const completed = readBundlePair(candidate);
  assert.notDeepEqual(completed, pristine);
  const worker = completed.get("worker.js");
  const src = completed.get("src-Cz_uUmVl.js");
  assert.equal(worker.split(PARCEL_WATCH_MARKER).length - 1, 1);
  assert.match(worker, new RegExp(`function ${HELPER_NAME}\\(`, "u"));
  assert.match(src, new RegExp(`function ${HELPER_NAME}\\(`, "u"));
  assert.ok(worker.includes(CURRENT_WATCHBOUND_ROUTE));
  assert.ok(worker.includes(CURRENT_PARCEL_HELPER));
  assert.ok(worker.includes(CURRENT_WORKER_REMOTE_FILE_WATCH));
  assert.ok(src.includes(CURRENT_SRC_REMOTE_FILE_WATCH));
  assert.ok(worker.includes(":t.startFileWatch(n)"));
  assert.equal(completed.get("unrelated.js"), pristine.get("unrelated.js"));

  const second = patchWorker(candidate.extractedDir);
  assert.deepEqual(second, {
    matched: 2,
    changed: 0,
    reason: null,
    targets: first.targets,
  });
  assert.deepEqual(readBundlePair(candidate), completed);
});

test("rejects markers outside the exact 26.803.41515 Watchbound handoff", (t) => {
  const unmarkedHandoff = CURRENT_WATCHBOUND_ROUTE.replace(
    `/*${PARCEL_WATCH_MARKER}*/`,
    "",
  );
  const cases = [
    {
      name: "marker elsewhere in worker.js",
      overrides: {
        worker: `/*${PARCEL_WATCH_MARKER}*/${currentWorkerSource(unmarkedHandoff)}`,
      },
    },
    {
      name: "marker in the src bundle",
      overrides: {
        worker: currentWorkerSource(unmarkedHandoff),
        src: `/*${PARCEL_WATCH_MARKER}*/${currentSrcSource()}`,
      },
    },
    {
      name: "marker beside an active Parcel route",
      overrides: {
        worker: `/*${PARCEL_WATCH_MARKER}*/${currentWorkerSource()}`,
      },
    },
  ];

  for (const entry of cases) {
    const candidate = currentBundlePair(t, entry.overrides);
    const before = readBundlePair(candidate);
    const { value: result } = captureWarns(() => patchWorker(candidate.extractedDir));
    assert.equal(result.matched, 0, entry.name);
    assert.equal(result.changed, 0, entry.name);
    assert.match(result.reason, /Watchbound|Parcel|route|contract|marker/u, entry.name);
    assert.deepEqual(readBundlePair(candidate), before, entry.name);
  }
});

test("rejects dual ownership, unrelated lookalikes, and unproven minified aliases", (t) => {
  const parcelCall =
    "oye(n,{ignoredPaths:[E.posix.join(n.path,`.git`)]})";
  const unmarkedHandoff = CURRENT_WATCHBOUND_ROUTE.replace(
    `/*${PARCEL_WATCH_MARKER}*/`,
    "",
  );
  const unrelatedLookalike =
    "function unrelated(n,e){return process.platform===`linux`?" +
    `${parcelCall}:e.startFileWatch(n)}`;
  const cases = [
    {
      name: "Parcel and Watchbound both own the subscription",
      worker: currentWorkerSource(
        `startWorkingTreeWatch:(t,n)=>t.isLocal?/*${PARCEL_WATCH_MARKER}*/` +
        `(${parcelCall},e.startFileWatch(n)):t.startFileWatch(n)`,
      ),
    },
    {
      name: "an unrelated raw-route lookalike",
      worker: `${currentWorkerSource(unmarkedHandoff)}${unrelatedLookalike}`,
    },
    {
      name: "a changed minified Parcel alias",
      worker: currentWorkerSource(CURRENT_PARCEL_ROUTE.replace("oye(n,", "Qve(n,")),
    },
    {
      name: "an uncorrelated local host alias",
      worker: currentWorkerSource(
        CURRENT_PARCEL_ROUTE.replace(":e.startFileWatch(n)", ":other.startFileWatch(n)"),
      ),
    },
    {
      name: "a routed local host with a different class",
      worker: currentWorkerSource().replace("let e=new Que", "let e=new OtherHost"),
    },
    {
      name: "a local method moved outside the routed class",
      worker: currentWorkerSource().replace(
        CURRENT_WORKER_LOCAL_FILE_WATCH,
        `};var OtherHost=class extends BaseHost{${CURRENT_WORKER_LOCAL_FILE_WATCH}`,
      ),
    },
    {
      name: "an uncorrelated main connection alias",
      worker: currentWorkerSource().replace("new nde(n,e)", "new nde(other,e)"),
    },
  ];

  for (const entry of cases) {
    const candidate = currentBundlePair(t, { worker: entry.worker });
    const before = readBundlePair(candidate);
    const { value: result } = captureWarns(() => patchWorker(candidate.extractedDir));
    assert.equal(result.matched, 0, entry.name);
    assert.equal(result.changed, 0, entry.name);
    assert.match(result.reason, /current|Watchbound|Parcel|route|contract/u, entry.name);
    assert.deepEqual(readBundlePair(candidate), before, entry.name);
  }
});

test("rejects missing, duplicate, and partial current contracts", (t) => {
  const completedWorker = patchWorkerSource(
    currentWorkerSource(),
    normalizedSettings(),
  ).source;
  const completedSrc = patchWorkerSource(
    currentSrcSource(),
    normalizedSettings(),
  ).source;
  const staleSettings = { ...normalizedSettings(), maxWatches: 4096 };
  const staleWorker = patchWorkerSource(currentWorkerSource(), staleSettings).source;
  const staleSrc = patchWorkerSource(currentSrcSource(), staleSettings).source;
  const workerOriginalIndex = completedWorker.indexOf("var Que=class{");
  const workerHelper = completedWorker.slice(0, workerOriginalIndex);
  const workerWithoutHelper = completedWorker.slice(workerOriginalIndex);
  const workerBranchStart = completedWorker.indexOf(
    "if(process.platform===`linux`&&e.recursive&&",
    workerOriginalIndex,
  );
  const workerBranchEnd = completedWorker.indexOf("}let t=oV()", workerBranchStart) + 1;
  const workerBranch = completedWorker.slice(workerBranchStart, workerBranchEnd);
  const cases = [
    {
      name: "missing semantic route",
      overrides: {
        worker: currentWorkerSource(
          "startWorkingTreeWatch:(t,n)=>t.isLocal?e.startFileWatch(n):t.startFileWatch(n)",
        ),
      },
    },
    {
      name: "duplicate semantic route",
      overrides: {
        worker: `${currentWorkerSource()}${CURRENT_GIT_ROUTE_PREFIX}` +
          `${CURRENT_PARCEL_ROUTE}${CURRENT_GIT_ROUTE_SUFFIX}`,
      },
    },
    {
      name: "damaged completed helper body",
      overrides: {
        worker: completedWorker.replace(
          "const GIT_QUERY_TIMEOUT_MS = 5000;",
          "const GIT_QUERY_TIMEOUT_MS = 5001;",
        ),
        src: completedSrc,
      },
    },
    {
      name: "missing completed helper",
      overrides: {
        worker: workerWithoutHelper,
        src: completedSrc,
      },
    },
    {
      name: "duplicate completed helper",
      overrides: {
        worker: `${workerHelper}${completedWorker}`,
        src: completedSrc,
      },
    },
    {
      name: "one completed bundle plus one pristine bundle",
      overrides: {
        worker: completedWorker,
        src: currentSrcSource(),
      },
    },
    {
      name: "duplicate completed marker",
      overrides: {
        worker: `/*${PARCEL_WATCH_MARKER}*/${completedWorker}`,
        src: completedSrc,
      },
    },
    {
      name: "missing completed marker",
      overrides: {
        worker: completedWorker.replace(`/*${PARCEL_WATCH_MARKER}*/`, ""),
        src: completedSrc,
      },
    },
    {
      name: "missing completed branch",
      overrides: {
        worker: completedWorker.replace(
          `${HELPER_NAME}(this,e,`,
          `missing${HELPER_NAME}(this,e,`,
        ),
        src: completedSrc,
      },
    },
    {
      name: "duplicate completed branch",
      overrides: {
        worker: completedWorker.replace(workerBranch, `${workerBranch}${workerBranch}`),
        src: completedSrc,
      },
    },
    {
      name: "completed route retargeted to a different local class",
      overrides: {
        worker: completedWorker.replace("let e=new Que", "let e=new OtherHost"),
        src: completedSrc,
      },
    },
    {
      name: "stale completed settings",
      overrides: {
        worker: staleWorker,
        src: staleSrc,
      },
    },
  ];

  for (const entry of cases) {
    const candidate = currentBundlePair(t, entry.overrides);
    const before = readBundlePair(candidate);
    const { value: result } = captureWarns(() => patchWorker(candidate.extractedDir));
    assert.equal(result.matched, 0, entry.name);
    assert.equal(result.changed, 0, entry.name);
    assert.match(result.reason, /current|Watchbound|Parcel|route|contract|helper|branch/u, entry.name);
    assert.deepEqual(readBundlePair(candidate), before, entry.name);
  }
});

test("a rejected current contract is an enabled-feature failure", (t) => {
  const candidate = currentBundlePair(t, {
    worker: currentWorkerSource(
      "startWorkingTreeWatch:(t,n)=>t.isLocal?e.startFileWatch(n):t.startFileWatch(n)",
    ),
  });
  const before = readBundlePair(candidate);
  const baseDescriptor = descriptors.find(({ id }) => id === "worker-directory-watch");
  const descriptor = {
    ...baseDescriptor,
    id: "feature:directory-only-working-tree-watch:worker-directory-watch",
    name: "feature:directory-only-working-tree-watch:worker-directory-watch",
    sourceKind: "feature",
    featureId: "directory-only-working-tree-watch",
  };
  const report = createPatchReport();
  report.enabledFeatures = ["directory-only-working-tree-watch"];
  captureWarns(() => applyExtractedAppPatchDescriptors(
    candidate.extractedDir,
    [descriptor],
    {},
    report,
    descriptor.phase,
  ));

  const [failure] = enabledFeatureFailuresFromReport(report);
  assert.equal(failure?.name, descriptor.id);
  assert.equal(failure?.status, "skipped-optional");
  assert.match(failure?.reason ?? "", /current|Parcel|route|contract/u);
  assert.deepEqual(readBundlePair(candidate), before);
});

test("restores both current bundles after injected writes and permits retry", (t) => {
  const descriptor = descriptors.find(({ id }) => id === "worker-directory-watch");
  for (const failedWrite of [1, 2]) {
    const candidate = currentBundlePair(t);
    const before = readBundlePair(candidate);
    let writeCount = 0;
    const { value: result } = captureWarns(() => patchWorker(
      candidate.extractedDir,
      {},
      {
        writeFileSync(filePath, source, encoding) {
          writeCount += 1;
          if (writeCount === failedWrite) {
            fs.writeFileSync(filePath, `partial-write-${failedWrite}`, encoding);
            throw new Error(`simulated write ${failedWrite} failure`);
          }
          fs.writeFileSync(filePath, source, encoding);
        },
      },
    ));
    assert.equal(result.matched, 0, `write ${failedWrite}`);
    assert.equal(result.changed, 0, `write ${failedWrite}`);
    assert.match(result.reason, /write.*current.*bundle|current.*bundle.*write/iu);
    assert.equal(descriptor.status(result, []).status, "skipped-optional");
    assert.deepEqual(readBundlePair(candidate), before, `write ${failedWrite}`);

    const retry = patchWorker(candidate.extractedDir);
    assert.equal(retry.matched, 2, `retry after write ${failedWrite}`);
    assert.equal(retry.changed, 2, `retry after write ${failedWrite}`);
    const idempotent = patchWorker(candidate.extractedDir);
    assert.equal(idempotent.matched, 2, `idempotent after write ${failedWrite}`);
    assert.equal(idempotent.changed, 0, `idempotent after write ${failedWrite}`);
  }
});

test("rejects non-lossless UTF-8 bundles without changing their bytes", (t) => {
  const candidate = currentBundlePair(t);
  const srcPath = path.join(candidate.buildDir, "src-Cz_uUmVl.js");
  fs.appendFileSync(srcPath, Buffer.from([0xff]));
  const before = new Map(
    ["src-Cz_uUmVl.js", "worker.js"].map((name) => [
      name,
      fs.readFileSync(path.join(candidate.buildDir, name)),
    ]),
  );
  let writeCount = 0;

  const { value: result } = captureWarns(() => patchWorker(
    candidate.extractedDir,
    {},
    {
      writeFileSync(...args) {
        writeCount += 1;
        fs.writeFileSync(...args);
      },
    },
  ));

  assert.equal(result.matched, 0);
  assert.equal(result.changed, 0);
  assert.match(result.reason, /source byte verification failed/u);
  assert.equal(writeCount, 0);
  for (const [name, source] of before) {
    assert.deepEqual(fs.readFileSync(path.join(candidate.buildDir, name)), source);
  }
});

test("keeps transaction byte oracles private from injected writers", (t) => {
  const candidate = currentBundlePair(t);
  const before = new Map(
    ["src-Cz_uUmVl.js", "worker.js"].map((name) => [
      name,
      fs.readFileSync(path.join(candidate.buildDir, name)),
    ]),
  );
  let writeCount = 0;

  const { value: result } = captureWarns(() => patchWorker(
    candidate.extractedDir,
    {},
    {
      writeFileSync(filePath, source) {
        writeCount += 1;
        if (writeCount === 1) source[0] = source[0] === 0x63 ? 0x64 : 0x63;
        fs.writeFileSync(filePath, source);
      },
    },
  ));

  assert.equal(result.matched, 0);
  assert.equal(result.changed, 0);
  assert.match(result.reason, /write byte verification failed/u);
  assert.equal(writeCount, 2);
  for (const [name, source] of before) {
    assert.deepEqual(fs.readFileSync(path.join(candidate.buildDir, name)), source);
  }
});

test("keeps transaction byte oracles private from injected readers", (t) => {
  const candidate = currentBundlePair(t);
  const before = new Map(
    ["src-Cz_uUmVl.js", "worker.js"].map((name) => [
      name,
      fs.readFileSync(path.join(candidate.buildDir, name)),
    ]),
  );
  let readCount = 0;
  let hostileEqualsCalls = 0;
  let writeCount = 0;

  const { value: result } = captureWarns(() => patchWorker(
    candidate.extractedDir,
    {},
    {
      readFileSync(filePath) {
        readCount += 1;
        const source = fs.readFileSync(filePath);
        if (readCount === 3) {
          source.equals = (oracle) => {
            hostileEqualsCalls += 1;
            oracle[0] ^= 1;
            return true;
          };
        }
        return source;
      },
      writeFileSync(filePath, source) {
        writeCount += 1;
        if (writeCount === 1) {
          fs.writeFileSync(filePath, "partial-first-write");
          throw new Error("simulated first-write failure");
        }
        fs.writeFileSync(filePath, source);
      },
    },
  ));

  assert.equal(result.matched, 0);
  assert.equal(result.changed, 0);
  assert.match(result.reason, /write.*current.*bundle|current.*bundle.*write/iu);
  assert.equal(hostileEqualsCalls, 0);
  assert.equal(writeCount, 2);
  for (const [name, source] of before) {
    assert.deepEqual(fs.readFileSync(path.join(candidate.buildDir, name)), source);
  }
});

test("keeps a rollback fail-soft when restored bytes can still be proven", (t) => {
  const candidate = currentBundlePair(t);
  const before = readBundlePair(candidate);
  let writeCount = 0;
  const { value: result } = captureWarns(() => patchWorker(
    candidate.extractedDir,
    {},
    {
      writeFileSync(filePath, source, encoding) {
        writeCount += 1;
        if (writeCount === 2) {
          fs.writeFileSync(filePath, "partial-second-write", encoding);
          throw new Error("simulated second-write failure");
        }
        fs.writeFileSync(filePath, source, encoding);
        if (writeCount === 3) {
          throw new Error("rollback writer threw after restoring bytes");
        }
      },
    },
  ));
  assert.equal(result.matched, 0);
  assert.equal(result.changed, 0);
  assert.deepEqual(readBundlePair(candidate), before);
});

test("reports failed-integrity when rollback cannot prove original current bundle bytes", (t) => {
  const candidate = currentBundlePair(t);
  const before = readBundlePair(candidate);
  let writeCount = 0;
  const writeFileSync = (filePath, source, encoding) => {
    writeCount += 1;
    if (writeCount === 2) {
      fs.writeFileSync(filePath, "corrupt-current-worker", encoding);
      throw new Error("simulated second-write failure");
    }
    if (writeCount === 3) {
      throw new Error("simulated rollback failure");
    }
    fs.writeFileSync(filePath, source, encoding);
  };
  const baseDescriptor = descriptors.find(({ id }) => id === "worker-directory-watch");
  const descriptor = {
    ...baseDescriptor,
    id: "feature:directory-only-working-tree-watch:worker-directory-watch",
    name: "feature:directory-only-working-tree-watch:worker-directory-watch",
    sourceKind: "feature",
    featureId: "directory-only-working-tree-watch",
    apply: (extractedDir, context) => patchWorker(
      extractedDir,
      context,
      { writeFileSync },
    ),
  };
  const report = createPatchReport();
  report.enabledFeatures = ["directory-only-working-tree-watch"];
  assert.throws(
    () => captureWarns(() => applyExtractedAppPatchDescriptors(
      candidate.extractedDir,
      [descriptor],
      {},
      report,
      descriptor.phase,
    )),
    (error) => error?.code === "PATCH_INTEGRITY_FAILURE",
  );
  const [failure] = criticalFailuresFromReport(report);
  assert.equal(failure?.name, descriptor.id);
  assert.equal(failure?.status, "failed-integrity");
  assert.match(
    failure?.reason ?? "",
    /rollback byte verification failed.*rollback write also failed: simulated rollback failure/u,
  );
  assert.equal(
    fs.readFileSync(path.join(candidate.buildDir, "src-Cz_uUmVl.js"), "utf8"),
    before.get("src-Cz_uUmVl.js"),
  );
  assert.equal(
    fs.readFileSync(path.join(candidate.buildDir, "worker.js"), "utf8"),
    "corrupt-current-worker",
  );
});

test("feature descriptors stage Watchbound before patching the worker", () => {
  assert.equal(WATCHBOUND_VERSION, "2.1.1");
  assert.deepEqual(
    descriptors.map(({ id, phase, order, ciPolicy }) => ({
      id,
      phase,
      order,
      ciPolicy,
    })),
    [
      {
        id: "watchbound-package",
        phase: "extracted-app:pre-webview",
        order: 20_930,
        ciPolicy: "opt-in",
      },
      {
        id: "worker-directory-watch",
        phase: "extracted-app:pre-webview",
        order: 20_940,
        ciPolicy: "opt-in",
      },
    ],
  );
  const packageDescriptor = descriptors.find(({ id }) => id === "watchbound-package");
  assert.deepEqual(packageDescriptor.status({
    changed: true,
    source: "inspect",
    version: WATCHBOUND_VERSION,
  }), {
    status: "applied",
    reason: `watchbound ${WATCHBOUND_VERSION} (inspect)`,
  });
});

test("the package helper subprocess preserves failed-integrity reporting", (t) => {
  const extractedDir = tempDirectory(t, "watchbound-helper-integrity-");
  const baseDescriptor = descriptors.find(({ id }) => id === "watchbound-package");
  const descriptor = {
    ...baseDescriptor,
    id: "feature:directory-only-working-tree-watch:watchbound-package",
    name: "feature:directory-only-working-tree-watch:watchbound-package",
    sourceKind: "feature",
    featureId: "directory-only-working-tree-watch",
  };
  const originalExecFileSync = childProcess.execFileSync;
  childProcess.execFileSync = () => {
    const error = new Error("package helper exited with integrity failure");
    error.status = 86;
    error.stderr =
      "ERROR [PATCH_INTEGRITY_FAILURE]: package rollback could not be proven";
    throw error;
  };
  try {
    const report = createPatchReport();
    report.enabledFeatures = ["directory-only-working-tree-watch"];
    assert.throws(
      () => applyExtractedAppPatchDescriptors(
        extractedDir,
        [descriptor],
        {},
        report,
        descriptor.phase,
      ),
      (error) => error?.code === "PATCH_INTEGRITY_FAILURE",
    );
    const [failure] = criticalFailuresFromReport(report);
    assert.equal(failure?.name, descriptor.id);
    assert.equal(failure?.status, "failed-integrity");
    assert.match(failure?.reason ?? "", /package rollback could not be proven/u);
  } finally {
    childProcess.execFileSync = originalExecFileSync;
  }
});

function makeElf(machine = 62, elfClass = 64) {
  const contents = Buffer.alloc(96);
  contents.set([0x7f, 0x45, 0x4c, 0x46], 0);
  contents[4] = elfClass === 32 ? 1 : 2;
  contents[5] = 1;
  contents[6] = 1;
  contents.writeUInt16LE(3, 16);
  contents.writeUInt16LE(machine, 18);
  contents.writeUInt32LE(1, 20);
  contents.write("watchbound-fixture", 64, "utf8");
  return contents;
}

function createPackageFixture(t, name, version, files, metadataOverrides = {}) {
  const packageDir = path.join(
    tempDirectory(t, "watchbound-package-fixture-"),
    "package",
  );
  const metadata = {
    name,
    version,
    license: "MIT",
    engines: { node: ">=24.15.0 <25" },
    watchbound: { delivery: "bundled-native-package" },
    ...metadataOverrides,
  };
  writeJson(path.join(packageDir, "package.json"), metadata);
  for (const [relativePath, contents] of Object.entries(files)) {
    writeFile(path.join(packageDir, relativePath), contents);
  }
  const fileHashes = {};
  for (const relativePath of [
    ...Object.keys(files),
    "package.json",
  ].sort()) {
    fileHashes[relativePath] = sha256(
      fs.readFileSync(path.join(packageDir, relativePath)),
    );
  }
  return { packageDir, fileHashes };
}

const QUALIFIED_ELECTRON_VERSION = "42.3.0";

function writeExtractedAppRuntime(extractedDir, electron = QUALIFIED_ELECTRON_VERSION) {
  writeJson(path.join(extractedDir, "package.json"), {
    name: "openai-codex-electron",
    version: "26.803.41515",
    devDependencies: { electron },
  });
}

function packageStageOptions(extractedDir, fixture, overrides = {}) {
  return {
    extractedDir,
    manifest: fixture.manifest,
    targetElectronVersion: QUALIFIED_ELECTRON_VERSION,
    targetNodeVersion: "24.15.0",
    ...overrides,
  };
}

function fixtureMaterializer(fixture, hooks = {}) {
  return async (request) => {
    hooks.before?.(request);
    return {
      packageDir: fixture.packages.get(request.name),
      integrity: request.integrity,
      shasum: request.shasum,
      sha256: request.sha256,
      source: "fixture",
      cleanup: hooks.cleanup,
    };
  };
}

function packageFixtureManifest(t) {
  const version = WATCHBOUND_VERSION;
  const x64Binding = makeElf(62);
  const arm64Binding = makeElf(183);
  const wrapper = createPackageFixture(t, "watchbound", version, {
    "index.js": "export const fixture = true;\n",
  });
  const loader = createPackageFixture(t, "@gadicc/watchbound-node", version, {
    "index.js": "module.exports = {};\n",
  });
  const targetFixture = (architecture, binding) => {
    const target = `linux-${architecture}-gnu`;
    const targetTriple = architecture === "x64"
      ? "x86_64-unknown-linux-gnu"
      : "aarch64-unknown-linux-gnu";
    const bindingPath = `watchbound.${target}.node`;
    const nativeSha256 = sha256(binding);
    return createPackageFixture(
      t,
      `@gadicc/watchbound-node-${target}`,
      version,
      { [bindingPath]: binding },
      {
        cpu: [architecture],
        libc: ["glibc"],
        watchbound: {
          delivery: "target-native-package",
          target,
          targetTriple,
          architecture,
          libc: "glibc",
          binary: bindingPath,
          nativeSha256,
        },
      },
    );
  };
  const x64 = targetFixture("x64", x64Binding);
  const arm64 = targetFixture("arm64", arm64Binding);
  const artifact = (key, name, fixture, extra = {}) => ({
    name,
    license: "MIT",
    url: `https://registry.example/${key}.tgz`,
    integrity: `sha512-${Buffer.from(key).toString("base64")}`,
    shasum: sha256(key).slice(0, 40),
    sha256: sha256(`archive-${key}`),
    archiveEnvironment: `CODEX_WATCHBOUND_${key.toUpperCase()}_ARCHIVE`,
    files: fixture.fileHashes,
    ...extra,
  });
  return {
    manifest: {
      version,
      source: {
        revision: "1".repeat(40),
        url: "https://github.example/watchbound.tar.gz",
        sha256: "2".repeat(64),
      },
      runtime: {
        electron: QUALIFIED_ELECTRON_VERSION,
        node: "24.15.0",
        nodeRange: ">=24.15.0 <25",
      },
      packages: {
        wrapper: artifact("wrapper", "watchbound", wrapper),
        loader: artifact("loader", "@gadicc/watchbound-node", loader),
        targets: {
          x64: artifact("x64", "@gadicc/watchbound-node-linux-x64-gnu", x64, {
            nativeBinding: {
              path: "watchbound.linux-x64-gnu.node",
              architecture: "x64",
              target: "linux-x64-gnu",
              targetTriple: "x86_64-unknown-linux-gnu",
              libc: "glibc",
              elfClass: 64,
              elfMachine: 62,
              sha256: sha256(x64Binding),
            },
          }),
          arm64: artifact(
            "arm64",
            "@gadicc/watchbound-node-linux-arm64-gnu",
            arm64,
            {
              nativeBinding: {
                path: "watchbound.linux-arm64-gnu.node",
                architecture: "arm64",
                target: "linux-arm64-gnu",
                targetTriple: "aarch64-unknown-linux-gnu",
                libc: "glibc",
                elfClass: 64,
                elfMachine: 183,
                sha256: sha256(arm64Binding),
              },
            },
          ),
        },
      },
    },
    packages: new Map([
      ["watchbound", wrapper.packageDir],
      ["@gadicc/watchbound-node", loader.packageDir],
      ["@gadicc/watchbound-node-linux-x64-gnu", x64.packageDir],
      ["@gadicc/watchbound-node-linux-arm64-gnu", arm64.packageDir],
    ]),
  };
}

test("the shipped artifact manifest pins the 2.1.1 source and four packages", () => {
  const manifest = JSON.parse(
    fs.readFileSync(path.join(__dirname, "watchbound-artifacts.json"), "utf8"),
  );
  validateArtifactManifest(manifest);
  assert.equal(manifest.version, WATCHBOUND_VERSION);
  assert.deepEqual(manifest.runtime, {
    electron: QUALIFIED_ELECTRON_VERSION,
    node: "24.15.0",
    nodeRange: ">=24.15.0 <25",
  });
  assert.equal(manifest.source.revision.length, 40);
  assert.equal(manifest.packages.wrapper.name, "watchbound");
  assert.equal(manifest.packages.loader.name, "@gadicc/watchbound-node");
  assert.equal(
    manifest.packages.targets.x64.nativeBinding.path,
    "watchbound.linux-x64-gnu.node",
  );
  assert.equal(
    manifest.packages.targets.arm64.nativeBinding.path,
    "watchbound.linux-arm64-gnu.node",
  );
  assert.deepEqual(Object.keys(manifest.packages.targets), ["x64", "arm64"]);
});

test("the artifact manifest requires every supported Codex architecture", (t) => {
  const fixture = packageFixtureManifest(t);
  for (const architecture of ["x64", "arm64"]) {
    const incomplete = structuredClone(fixture.manifest);
    delete incomplete.packages.targets[architecture];
    assert.throws(
      () => validateArtifactManifest(incomplete),
      /must contain exactly the x64 and arm64 targets/u,
    );
  }
});

test("Watchbound staging uses pinned runtime metadata without executing Electron", async (t) => {
  const fixture = packageFixtureManifest(t);
  const extractedDir = tempDirectory(t, "watchbound-runtime-app-");
  writeExtractedAppRuntime(extractedDir);
  let materializations = 0;
  const materializePackage = fixtureMaterializer(fixture, {
    before: () => { materializations += 1; },
  });

  await assert.rejects(
    stageWatchboundPackages(packageStageOptions(extractedDir, fixture, {
      arch: "x64",
      targetElectronVersion: "42.2.0",
      materializePackage,
    })),
    /does not match build target/u,
  );
  assert.equal(materializations, 0);

  assert.deepEqual(validateTargetRuntime(
    extractedDir,
    fixture.manifest,
    undefined,
    undefined,
  ), {
    electron: QUALIFIED_ELECTRON_VERSION,
    node: "24.15.0",
    qualification: "pinned-artifact-manifest",
  });

  await assert.rejects(
    stageWatchboundPackages(packageStageOptions(extractedDir, fixture, {
      arch: "x64",
      targetNodeVersion: "24.14.0",
      materializePackage,
    })),
    /qualified for Electron 42\.3\.0 \/ Node\.js 24\.15\.0, got Node\.js 24\.14\.0/u,
  );
  assert.equal(materializations, 0);
  assert.equal(fs.existsSync(path.join(extractedDir, "node_modules")), false);

  writeExtractedAppRuntime(extractedDir, "43.0.0");
  await assert.rejects(
    stageWatchboundPackages(packageStageOptions(extractedDir, fixture, {
      arch: "x64",
      targetElectronVersion: "43.0.0",
      materializePackage,
    })),
    /qualified for Electron 42\.3\.0 \/ Node\.js 24\.15\.0/u,
  );
  assert.equal(materializations, 0);

  writeExtractedAppRuntime(extractedDir);
  const pinnedResult = await stageWatchboundPackages(packageStageOptions(
    extractedDir,
    fixture,
    {
      arch: "x64",
      targetElectronVersion: undefined,
      targetNodeVersion: undefined,
      materializePackage,
    },
  ));
  assert.equal(pinnedResult.runtime.qualification, "pinned-artifact-manifest");
  assert.equal(materializations, 3);

  const unsupportedNodeManifest = structuredClone(fixture.manifest);
  unsupportedNodeManifest.runtime.node = "24.14.0";
  assert.throws(
    () => validateArtifactManifest(unsupportedNodeManifest),
    /target runtime contract is invalid/u,
  );
});

test("verified Watchbound packages stage idempotently into app node_modules", async (t) => {
  const extractedDir = tempDirectory(t, "watchbound-extracted-app-");
  writeExtractedAppRuntime(extractedDir);
  const fixture = packageFixtureManifest(t);
  const materializePackage = async (request) => ({
    packageDir: fixture.packages.get(request.name),
    integrity: request.integrity,
    shasum: request.shasum,
    sha256: request.sha256,
    source: "fixture",
  });

  const first = await stageWatchboundPackages(packageStageOptions(extractedDir, fixture, {
    arch: "x64",
    materializePackage,
  }));
  assert.equal(first.changed, true);
  assert.equal(first.alreadyApplied, false);
  assert.equal(
    fs.existsSync(packageTarget(extractedDir, "watchbound")),
    true,
  );
  assert.equal(
    fs.existsSync(packageTarget(extractedDir, "@gadicc/watchbound-node")),
    true,
  );
  assert.equal(
    fs.existsSync(packageTarget(
      extractedDir,
      "@gadicc/watchbound-node-linux-x64-gnu",
    )),
    true,
  );
  assert.equal(
    fs.existsSync(packageTarget(
      extractedDir,
      "@gadicc/watchbound-node-linux-arm64-gnu",
    )),
    false,
  );

  const second = await stageWatchboundPackages(packageStageOptions(extractedDir, fixture, {
    arch: "x64",
    materializePackage: async () => {
      throw new Error("idempotent staging must not materialize packages");
    },
  }));
  assert.equal(second.changed, false);
  assert.equal(second.alreadyApplied, true);

  writeFile(
    path.join(packageTarget(extractedDir, "watchbound"), "index.js"),
    "tampered\n",
  );
  await assert.rejects(
    stageWatchboundPackages(packageStageOptions(extractedDir, fixture, {
      arch: "x64",
      materializePackage,
    })),
    /hash mismatch/u,
  );
});

test("idempotent staging revalidates packages after asynchronous preparation", async (t) => {
  const extractedDir = tempDirectory(t, "watchbound-idempotent-revalidation-");
  writeExtractedAppRuntime(extractedDir);
  const fixture = packageFixtureManifest(t);
  const materializePackage = fixtureMaterializer(fixture);
  await stageWatchboundPackages(packageStageOptions(extractedDir, fixture, {
    arch: "x64",
    materializePackage,
  }));
  const targetArtifact = fixture.manifest.packages.targets.x64;
  const bindingPath = path.join(
    packageTarget(extractedDir, targetArtifact.name),
    targetArtifact.nativeBinding.path,
  );

  queueMicrotask(() => fs.appendFileSync(bindingPath, "concurrent corruption"));
  await assert.rejects(
    stageWatchboundPackages(packageStageOptions(extractedDir, fixture, {
      arch: "x64",
      materializePackage: async () => {
        throw new Error("idempotent staging must not materialize packages");
      },
    })),
    /hash mismatch/u,
  );
});

test("a pinned Nix native build stages with manifest-verified JavaScript packages", async (t) => {
  const fixture = packageFixtureManifest(t);
  const sourceParent = tempDirectory(t, "watchbound-nix-source-");
  const packageNames = [
    "watchbound",
    "@gadicc/watchbound-node",
    "@gadicc/watchbound-node-linux-x64-gnu",
  ];
  for (const name of packageNames) {
    fs.mkdirSync(path.dirname(packageTarget(sourceParent, name)), { recursive: true });
    fs.cpSync(fixture.packages.get(name), packageTarget(sourceParent, name), {
      recursive: true,
    });
  }

  const targetDir = packageTarget(
    sourceParent,
    "@gadicc/watchbound-node-linux-x64-gnu",
  );
  const rebuiltBinding = makeElf(62);
  rebuiltBinding.write("nix-source-build", 40, "utf8");
  writeFile(path.join(targetDir, "watchbound.linux-x64-gnu.node"), rebuiltBinding);
  const targetMetadata = JSON.parse(
    fs.readFileSync(path.join(targetDir, "package.json"), "utf8"),
  );
  targetMetadata.watchbound.nativeSha256 = sha256(rebuiltBinding);
  writeJson(path.join(targetDir, "package.json"), targetMetadata);

  assert.deepEqual(
    verifyControlledPackageRoot(
      path.join(sourceParent, "node_modules"),
      fixture.manifest,
      "x64",
    ),
    {
      arch: "x64",
      packages: [
        "@gadicc/watchbound-node-linux-x64-gnu",
        "@gadicc/watchbound-node",
        "watchbound",
      ],
      version: WATCHBOUND_VERSION,
    },
  );

  const extractedDir = tempDirectory(t, "watchbound-nix-app-");
  writeExtractedAppRuntime(extractedDir);
  const first = await stageWatchboundPackages(packageStageOptions(extractedDir, fixture, {
    arch: "x64",
    sourcePackageRoot: path.join(sourceParent, "node_modules"),
  }));
  assert.equal(first.changed, true);
  assert.equal(first.source, "nix-source-build");
  assert.equal(
    sha256(fs.readFileSync(path.join(
      packageTarget(extractedDir, "@gadicc/watchbound-node-linux-x64-gnu"),
      "watchbound.linux-x64-gnu.node",
    ))),
    sha256(rebuiltBinding),
  );

  const second = await stageWatchboundPackages(packageStageOptions(extractedDir, fixture, {
    arch: "x64",
    sourcePackageRoot: path.join(sourceParent, "node_modules"),
  }));
  assert.equal(second.alreadyApplied, true);
});

test("Nix wrapper and loader sources must match the shared artifact manifest", async (t) => {
  const fixture = packageFixtureManifest(t);
  for (const packageName of ["watchbound", "@gadicc/watchbound-node"]) {
    await t.test(packageName, async (t) => {
      const sourceParent = tempDirectory(t, "watchbound-nix-manifest-source-");
      for (const name of [
        "watchbound",
        "@gadicc/watchbound-node",
        "@gadicc/watchbound-node-linux-x64-gnu",
      ]) {
        fs.mkdirSync(path.dirname(packageTarget(sourceParent, name)), { recursive: true });
        fs.cpSync(fixture.packages.get(name), packageTarget(sourceParent, name), {
          recursive: true,
        });
      }
      fs.appendFileSync(
        path.join(packageTarget(sourceParent, packageName), "index.js"),
        "// source drift\n",
      );

      const extractedDir = tempDirectory(t, "watchbound-nix-manifest-app-");
      writeExtractedAppRuntime(extractedDir);
      await assert.rejects(
        stageWatchboundPackages(packageStageOptions(extractedDir, fixture, {
          arch: "x64",
          sourcePackageRoot: path.join(sourceParent, "node_modules"),
        })),
        /hash mismatch/u,
      );
      assert.equal(fs.existsSync(path.join(extractedDir, "node_modules")), false);
    });
  }
});

test("controlled source staging rejects installed wrapper and loader inventory drift", async (t) => {
  const fixture = packageFixtureManifest(t);
  const sourceParent = tempDirectory(t, "watchbound-controlled-inventory-source-");
  const sourcePackageRoot = path.join(sourceParent, "node_modules");
  for (const name of [
    "watchbound",
    "@gadicc/watchbound-node",
    "@gadicc/watchbound-node-linux-x64-gnu",
  ]) {
    fs.mkdirSync(path.dirname(packageTarget(sourceParent, name)), { recursive: true });
    fs.cpSync(fixture.packages.get(name), packageTarget(sourceParent, name), {
      recursive: true,
    });
  }

  const mutations = [
    {
      name: "modified",
      apply: (packageDir) => writeFile(path.join(packageDir, "index.js"), "tampered\n"),
      pattern: /hash mismatch/u,
    },
    {
      name: "missing",
      apply: (packageDir) => fs.rmSync(path.join(packageDir, "index.js")),
      pattern: /file count mismatch/u,
    },
    {
      name: "extra",
      apply: (packageDir) => writeFile(path.join(packageDir, "unexpected.js"), "extra\n"),
      pattern: /file count mismatch/u,
    },
  ];

  for (const packageName of ["watchbound", "@gadicc/watchbound-node"]) {
    for (const mutation of mutations) {
      await t.test(`${packageName} ${mutation.name}`, async (t) => {
        const extractedDir = tempDirectory(t, "watchbound-controlled-inventory-app-");
        writeExtractedAppRuntime(extractedDir);
        const options = packageStageOptions(extractedDir, fixture, {
          arch: "x64",
          sourcePackageRoot,
        });
        await stageWatchboundPackages(options);

        mutation.apply(packageTarget(extractedDir, packageName));
        await assert.rejects(stageWatchboundPackages(options), mutation.pattern);
      });
    }
  }
});

test("Watchbound package staging selects the ARM64 target", async (t) => {
  const fixture = packageFixtureManifest(t);
  const materializePackage = async (request) => ({
    packageDir: fixture.packages.get(request.name),
    integrity: request.integrity,
    shasum: request.shasum,
    sha256: request.sha256,
    source: "fixture",
  });
  for (const arch of ["arm64"]) {
    const extractedDir = tempDirectory(t, `watchbound-${arch}-app-`);
    writeExtractedAppRuntime(extractedDir);
    await stageWatchboundPackages(packageStageOptions(extractedDir, fixture, {
      arch,
      materializePackage,
    }));
    for (const [candidate, artifact] of Object.entries(fixture.manifest.packages.targets)) {
      assert.equal(
        fs.existsSync(packageTarget(extractedDir, artifact.name)),
        candidate === arch,
      );
    }
  }

  await assert.rejects(
    stageWatchboundPackages({
      extractedDir: tempDirectory(t, "watchbound-unsupported-app-"),
      arch: "ppc64",
      manifest: fixture.manifest,
      materializePackage: async () => {
        throw new Error("must not materialize");
      },
    }),
    /no Linux GNU target/u,
  );
  await assert.rejects(
    stageWatchboundPackages({
      extractedDir: tempDirectory(t, "watchbound-musl-app-"),
      arch: "x64",
      libc: "musl",
      manifest: fixture.manifest,
      materializePackage: async () => {
        throw new Error("must not materialize");
      },
    }),
    /requires Linux glibc/u,
  );
});

test("Watchbound staging rejects architecture switches before changing the package set", async (t) => {
  const fixture = packageFixtureManifest(t);
  const materializePackage = fixtureMaterializer(fixture);
  for (const [firstArch, secondArch] of [
    ["x64", "arm64"],
    ["arm64", "x64"],
  ]) {
    const extractedDir = tempDirectory(t, `watchbound-${firstArch}-switch-`);
    writeExtractedAppRuntime(extractedDir);
    await stageWatchboundPackages(packageStageOptions(extractedDir, fixture, {
      arch: firstArch,
      materializePackage,
    }));
    const firstTarget = packageTarget(
      extractedDir,
      fixture.manifest.packages.targets[firstArch].name,
    );
    const firstBinding = fs.readFileSync(path.join(
      firstTarget,
      fixture.manifest.packages.targets[firstArch].nativeBinding.path,
    ));
    let secondMaterializations = 0;
    await assert.rejects(
      stageWatchboundPackages(packageStageOptions(extractedDir, fixture, {
        arch: secondArch,
        materializePackage: fixtureMaterializer(fixture, {
          before: () => { secondMaterializations += 1; },
        }),
      })),
      /Unselected Watchbound native target must be absent/u,
    );
    assert.equal(secondMaterializations, 0);
    assert.deepEqual(
      fs.readFileSync(path.join(
        firstTarget,
        fixture.manifest.packages.targets[firstArch].nativeBinding.path,
      )),
      firstBinding,
    );
    assert.equal(
      fs.existsSync(packageTarget(
        extractedDir,
        fixture.manifest.packages.targets[secondArch].name,
      )),
      false,
    );
  }
});

test("Watchbound staging rejects an unsafe unselected target before materialization", async (t) => {
  const fixture = packageFixtureManifest(t);
  const extractedDir = tempDirectory(t, "watchbound-unsafe-opposite-");
  const outside = tempDirectory(t, "watchbound-unsafe-opposite-outside-");
  writeExtractedAppRuntime(extractedDir);
  const oppositeTarget = packageTarget(
    extractedDir,
    fixture.manifest.packages.targets.arm64.name,
  );
  fs.mkdirSync(path.dirname(oppositeTarget), { recursive: true });
  fs.symlinkSync(outside, oppositeTarget);
  let materializations = 0;

  await assert.rejects(
    stageWatchboundPackages(packageStageOptions(extractedDir, fixture, {
      arch: "x64",
      materializePackage: fixtureMaterializer(fixture, {
        before: () => { materializations += 1; },
      }),
    })),
    /must not contain symlinks/u,
  );
  assert.equal(materializations, 0);
  assert.equal(fs.lstatSync(oppositeTarget).isSymbolicLink(), true);
});

test("Watchbound rejects an opposite architecture introduced during materialization", async (t) => {
  const fixture = packageFixtureManifest(t);
  const extractedDir = tempDirectory(t, "watchbound-opposite-race-");
  writeExtractedAppRuntime(extractedDir);
  const oppositeArtifact = fixture.manifest.packages.targets.arm64;
  const oppositeTarget = packageTarget(extractedDir, oppositeArtifact.name);
  const oppositeMarker = path.join(oppositeTarget, "introduced-during-materialization");
  let materializations = 0;
  let cleanups = 0;

  await assert.rejects(
    stageWatchboundPackages(packageStageOptions(extractedDir, fixture, {
      arch: "x64",
      materializePackage: fixtureMaterializer(fixture, {
        before: () => {
          materializations += 1;
          if (materializations === 1) writeFile(oppositeMarker, "opposite-target\n");
        },
        cleanup: () => { cleanups += 1; },
      }),
    })),
    /Unselected Watchbound native target must be absent/u,
  );

  assert.equal(materializations, 3);
  assert.equal(cleanups, 3);
  for (const artifact of [
    fixture.manifest.packages.targets.x64,
    fixture.manifest.packages.loader,
    fixture.manifest.packages.wrapper,
  ]) {
    assert.equal(fs.existsSync(packageTarget(extractedDir, artifact.name)), false);
  }
  assert.equal(fs.readFileSync(oppositeMarker, "utf8"), "opposite-target\n");
  assert.deepEqual(
    fs.readdirSync(extractedDir).filter((name) =>
      name.startsWith(".codex-watchbound-package-set-")
    ),
    [],
  );
});

test("Watchbound materializes and validates the full package set before mutation", async (t) => {
  const fixture = packageFixtureManifest(t);
  const extractedDir = tempDirectory(t, "watchbound-package-preflight-");
  writeExtractedAppRuntime(extractedDir);
  let materializations = 0;
  let cleanups = 0;

  await assert.rejects(
    stageWatchboundPackages(packageStageOptions(extractedDir, fixture, {
      arch: "x64",
      materializePackage: async (request) => {
        materializations += 1;
        if (materializations === 3) throw new Error("third package unavailable");
        return {
          packageDir: fixture.packages.get(request.name),
          integrity: request.integrity,
          shasum: request.shasum,
          sha256: request.sha256,
          source: "fixture",
          cleanup: () => { cleanups += 1; },
        };
      },
    })),
    /third package unavailable/u,
  );
  assert.equal(materializations, 3);
  assert.equal(cleanups, 2);
  for (const artifact of [
    fixture.manifest.packages.targets.x64,
    fixture.manifest.packages.loader,
    fixture.manifest.packages.wrapper,
  ]) {
    assert.equal(fs.existsSync(packageTarget(extractedDir, artifact.name)), false);
  }
});

test("Watchbound revalidates an existing target after later packages materialize", async (t) => {
  const fixture = packageFixtureManifest(t);
  const extractedDir = tempDirectory(t, "watchbound-existing-target-race-");
  writeExtractedAppRuntime(extractedDir);
  const targetArtifact = fixture.manifest.packages.targets.x64;
  const targetDir = packageTarget(extractedDir, targetArtifact.name);
  fs.mkdirSync(path.dirname(targetDir), { recursive: true });
  fs.cpSync(fixture.packages.get(targetArtifact.name), targetDir, {
    recursive: true,
  });
  let materializations = 0;
  let cleanups = 0;

  await assert.rejects(
    stageWatchboundPackages(packageStageOptions(extractedDir, fixture, {
      arch: "x64",
      materializePackage: fixtureMaterializer(fixture, {
        before: () => {
          materializations += 1;
          if (materializations === 1) {
            fs.appendFileSync(
              path.join(targetDir, targetArtifact.nativeBinding.path),
              "concurrent corruption",
            );
          }
        },
        cleanup: () => { cleanups += 1; },
      }),
    })),
    /hash mismatch/u,
  );
  assert.equal(materializations, 2);
  assert.equal(cleanups, 2);
  assert.equal(fs.existsSync(packageTarget(extractedDir, "watchbound")), false);
  assert.equal(
    fs.existsSync(packageTarget(extractedDir, "@gadicc/watchbound-node")),
    false,
  );
});

test("Watchbound package-set commit rolls back an injected partial failure", async (t) => {
  const fixture = packageFixtureManifest(t);
  const extractedDir = tempDirectory(t, "watchbound-package-rollback-");
  writeExtractedAppRuntime(extractedDir);
  let renames = 0;

  await assert.rejects(
    stageWatchboundPackages(packageStageOptions(extractedDir, fixture, {
      arch: "x64",
      materializePackage: fixtureMaterializer(fixture),
      renamePackage: (source, target) => {
        renames += 1;
        if (renames === 2) throw new Error("injected second commit failure");
        fs.renameSync(source, target);
      },
    })),
    /injected second commit failure/u,
  );
  assert.equal(renames, 2);
  for (const artifact of [
    fixture.manifest.packages.targets.x64,
    fixture.manifest.packages.loader,
    fixture.manifest.packages.wrapper,
  ]) {
    assert.equal(fs.existsSync(packageTarget(extractedDir, artifact.name)), false);
  }
  assert.equal(fs.existsSync(path.join(extractedDir, "node_modules")), false);
  assert.deepEqual(
    fs.readdirSync(extractedDir).filter((name) =>
      name.startsWith(".codex-watchbound-package-set-")
    ),
    [],
  );
});

test("the default package commit atomically refuses an existing destination", (t) => {
  const workspace = tempDirectory(t, "watchbound-package-no-replace-");
  const sourceDir = path.join(workspace, "source");
  const targetDir = path.join(workspace, "target");
  writeFile(path.join(sourceDir, "owned"), "owned\n");
  writeFile(path.join(targetDir, "foreign"), "preserve\n");
  const targetIdentity = fs.lstatSync(targetDir, { bigint: true });
  let reserved = false;

  assert.throws(
    () => commitPackageDirectoryNoReplace(
      sourceDir,
      targetDir,
      () => { reserved = true; },
    ),
    (error) => error?.code === "EEXIST",
  );

  const after = fs.lstatSync(targetDir, { bigint: true });
  assert.equal(reserved, false);
  assert.equal(after.dev, targetIdentity.dev);
  assert.equal(after.ino, targetIdentity.ino);
  assert.equal(fs.readFileSync(path.join(targetDir, "foreign"), "utf8"), "preserve\n");
  assert.equal(fs.existsSync(path.join(targetDir, "owned")), false);
});

test("the default package commit rejects a swapped reservation before copying", (t) => {
  const workspace = tempDirectory(t, "watchbound-package-reservation-swap-");
  const sourceDir = path.join(workspace, "source");
  const targetDir = path.join(workspace, "target");
  const movedTarget = path.join(workspace, "moved-target");
  const markerPath = path.join(targetDir, "foreign-owner");
  writeFile(path.join(sourceDir, "owned"), "owned\n");

  assert.throws(
    () => commitPackageDirectoryNoReplace(
      sourceDir,
      targetDir,
      () => {
        fs.renameSync(targetDir, movedTarget);
        writeFile(markerPath, "preserve\n");
      },
    ),
    (error) => {
      assert.equal(error?.code, "PATCH_INTEGRITY_FAILURE");
      assert.match(error.message, /reservation identity changed before package copy/u);
      return true;
    },
  );

  assert.equal(fs.readFileSync(markerPath, "utf8"), "preserve\n");
  assert.equal(fs.existsSync(path.join(targetDir, "owned")), false);
  assert.equal(fs.existsSync(movedTarget), true);
});

test("the default package commit verifies reservation identity after copying", (t) => {
  const workspace = tempDirectory(t, "watchbound-package-reservation-post-copy-");
  const sourceDir = path.join(workspace, "source");
  const targetDir = path.join(workspace, "target");
  const movedTarget = path.join(workspace, "moved-target");
  const markerPath = path.join(targetDir, "foreign-owner");
  writeFile(path.join(sourceDir, "owned"), "owned\n");
  const originalCpSync = fs.cpSync;
  fs.cpSync = (...args) => {
    originalCpSync(...args);
    fs.renameSync(targetDir, movedTarget);
    writeFile(markerPath, "preserve\n");
  };

  try {
    assert.throws(
      () => commitPackageDirectoryNoReplace(sourceDir, targetDir),
      (error) => {
        assert.equal(error?.code, "PATCH_INTEGRITY_FAILURE");
        assert.match(error.message, /reservation identity changed during package copy/u);
        return true;
      },
    );
  } finally {
    fs.cpSync = originalCpSync;
  }

  assert.equal(fs.readFileSync(markerPath, "utf8"), "preserve\n");
  assert.equal(fs.existsSync(path.join(targetDir, "owned")), false);
  assert.equal(fs.readFileSync(path.join(movedTarget, "owned"), "utf8"), "owned\n");
});

test("the default package copy remains bound to a moved reservation", (t) => {
  const workspace = tempDirectory(t, "watchbound-package-reservation-bound-copy-");
  const sourceDir = path.join(workspace, "source");
  const targetDir = path.join(workspace, "target");
  const movedTarget = path.join(workspace, "moved-target");
  const markerPath = path.join(targetDir, "foreign-owner");
  writeFile(path.join(sourceDir, "owned"), "owned\n");
  const originalCpSync = fs.cpSync;
  fs.cpSync = (...args) => {
    fs.renameSync(targetDir, movedTarget);
    writeFile(markerPath, "preserve\n");
    originalCpSync(...args);
  };

  try {
    assert.throws(
      () => commitPackageDirectoryNoReplace(sourceDir, targetDir),
      (error) => {
        assert.equal(error?.code, "PATCH_INTEGRITY_FAILURE");
        assert.match(error.message, /reservation identity changed during package copy/u);
        return true;
      },
    );
  } finally {
    fs.cpSync = originalCpSync;
  }

  assert.equal(fs.readFileSync(markerPath, "utf8"), "preserve\n");
  assert.equal(fs.existsSync(path.join(targetDir, "owned")), false);
  assert.equal(fs.readFileSync(path.join(movedTarget, "owned"), "utf8"), "owned\n");
});

test("package reservation identity ambiguity is failed-integrity", async (t) => {
  const fixture = packageFixtureManifest(t);
  const extractedDir = tempDirectory(t, "watchbound-package-reservation-identity-");
  writeExtractedAppRuntime(extractedDir);
  fs.mkdirSync(path.join(extractedDir, "node_modules", "@gadicc"), { recursive: true });
  const firstTarget = packageTarget(
    extractedDir,
    fixture.manifest.packages.targets.x64.name,
  );
  const originalLstatSync = fs.lstatSync;
  let injected = false;
  fs.lstatSync = (candidate, ...args) => {
    if (
      !injected &&
      candidate === firstTarget &&
      originalLstatSync(candidate, { throwIfNoEntry: false }) != null
    ) {
      injected = true;
      throw Object.assign(new Error("injected reservation identity failure"), {
        code: "EIO",
      });
    }
    return originalLstatSync(candidate, ...args);
  };

  try {
    await assert.rejects(
      stageWatchboundPackages(packageStageOptions(extractedDir, fixture, {
        arch: "x64",
        materializePackage: fixtureMaterializer(fixture),
      })),
      (error) => {
        assert.equal(error?.code, "PATCH_INTEGRITY_FAILURE");
        assert.equal(packageHelperExitCode(error), 86);
        assert.match(error.message, /reservation identity changed before package copy/u);
        return true;
      },
    );
  } finally {
    fs.lstatSync = originalLstatSync;
  }

  assert.equal(injected, true);
  assert.equal(fs.existsSync(firstTarget), false);
});

test("the default package commit rejects a swapped ancestor at its caller boundary", async (t) => {
  const fixture = packageFixtureManifest(t);
  const extractedDir = tempDirectory(t, "watchbound-package-commit-ancestor-");
  writeExtractedAppRuntime(extractedDir);
  const nodeModulesDir = path.join(extractedDir, "node_modules");
  const movedNodeModulesDir = path.join(extractedDir, "moved-node-modules");
  const firstTarget = packageTarget(
    extractedDir,
    fixture.manifest.packages.targets.x64.name,
  );
  const originalCpSync = fs.cpSync;
  let swapped = false;
  fs.cpSync = (source, target, options) => {
    originalCpSync(source, target, options);
    if (!swapped && target.startsWith("/proc/self/fd/")) {
      swapped = true;
      fs.renameSync(nodeModulesDir, movedNodeModulesDir);
      fs.symlinkSync(movedNodeModulesDir, nodeModulesDir, "dir");
    }
  };

  try {
    await assert.rejects(
      stageWatchboundPackages(packageStageOptions(extractedDir, fixture, {
        arch: "x64",
        materializePackage: fixtureMaterializer(fixture),
      })),
      (error) => {
        assert.equal(error?.code, "PATCH_INTEGRITY_FAILURE");
        assert.equal(packageHelperExitCode(error), 86);
        assert.match(error.message, /must not contain symlinks/u);
        return true;
      },
    );
  } finally {
    fs.cpSync = originalCpSync;
  }

  assert.equal(swapped, true);
  assert.equal(fs.lstatSync(nodeModulesDir).isSymbolicLink(), true);
  assert.equal(
    fs.existsSync(path.join(
      movedNodeModulesDir,
      "@gadicc",
      "watchbound-node-linux-x64-gnu",
    )),
    true,
  );
});

test("Watchbound package-set rolls back a rename that committed before throwing", async (t) => {
  const fixture = packageFixtureManifest(t);
  const extractedDir = tempDirectory(t, "watchbound-package-ambiguous-rename-");
  writeExtractedAppRuntime(extractedDir);
  let renames = 0;

  await assert.rejects(
    stageWatchboundPackages(packageStageOptions(extractedDir, fixture, {
      arch: "x64",
      materializePackage: fixtureMaterializer(fixture),
      renamePackage: (source, target) => {
        renames += 1;
        fs.renameSync(source, target);
        if (renames === 2) throw new Error("rename reported failure after commit");
      },
    })),
    (error) => {
      assert.equal(error?.code, undefined);
      assert.equal(packageHelperExitCode(error), 1);
      assert.match(error.message, /rename reported failure after commit/u);
      return true;
    },
  );
  assert.equal(renames, 2);
  for (const artifact of [
    fixture.manifest.packages.targets.x64,
    fixture.manifest.packages.loader,
    fixture.manifest.packages.wrapper,
  ]) {
    assert.equal(fs.existsSync(packageTarget(extractedDir, artifact.name)), false);
  }
  assert.equal(fs.existsSync(path.join(extractedDir, "node_modules")), false);
  assert.deepEqual(
    fs.readdirSync(extractedDir).filter((name) =>
      name.startsWith(".codex-watchbound-package-set-")
    ),
    [],
  );
});

test("Watchbound package-set preserves an unowned ambiguous rename target", async (t) => {
  const fixture = packageFixtureManifest(t);
  const extractedDir = tempDirectory(t, "watchbound-package-ambiguous-owner-");
  writeExtractedAppRuntime(extractedDir);
  let renames = 0;
  let markerPath = null;

  await assert.rejects(
    stageWatchboundPackages(packageStageOptions(extractedDir, fixture, {
      arch: "x64",
      materializePackage: fixtureMaterializer(fixture),
      renamePackage: (source, target) => {
        renames += 1;
        if (renames === 2) {
          fs.mkdirSync(target, { recursive: true });
          markerPath = path.join(target, "concurrent-owner");
          fs.writeFileSync(markerPath, "preserve\n");
          throw new Error("rename collided with concurrent target");
        }
        fs.renameSync(source, target);
      },
    })),
    (error) => {
      assert.equal(error?.code, "PATCH_INTEGRITY_FAILURE");
      assert.equal(packageHelperExitCode(error), 86);
      assert.match(error.message, /rename ownership could not be proven/u);
      return true;
    },
  );
  assert.equal(renames, 2);
  assert.equal(fs.readFileSync(markerPath, "utf8"), "preserve\n");
  assert.equal(
    fs.existsSync(packageTarget(
      extractedDir,
      fixture.manifest.packages.targets.x64.name,
    )),
    false,
  );
});

test("Watchbound package-set verifies ambiguous rename destination identity", async (t) => {
  const fixture = packageFixtureManifest(t);
  const extractedDir = tempDirectory(t, "watchbound-package-ambiguous-identity-");
  writeExtractedAppRuntime(extractedDir);
  let renames = 0;
  let markerPath = null;

  await assert.rejects(
    stageWatchboundPackages(packageStageOptions(extractedDir, fixture, {
      arch: "x64",
      materializePackage: fixtureMaterializer(fixture),
      renamePackage: (source, target) => {
        renames += 1;
        if (renames === 2) {
          // Unlink the staged name so this regression exercises the exact
          // inode-reuse window. Production keeps the original directory open,
          // so the foreign destination cannot recycle and counterfeit it.
          fs.rmSync(source, { recursive: true, force: true });
          fs.mkdirSync(target, { recursive: true });
          markerPath = path.join(target, "concurrent-owner");
          fs.writeFileSync(markerPath, "preserve\n");
          throw new Error("rename outcome replaced by concurrent target");
        }
        fs.renameSync(source, target);
      },
    })),
    (error) => {
      assert.equal(error?.code, "PATCH_INTEGRITY_FAILURE");
      assert.equal(packageHelperExitCode(error), 86);
      assert.match(error.message, /destination identity does not match/u);
      return true;
    },
  );
  assert.equal(renames, 2);
  assert.equal(fs.readFileSync(markerPath, "utf8"), "preserve\n");
  assert.equal(
    fs.existsSync(packageTarget(
      extractedDir,
      fixture.manifest.packages.targets.x64.name,
    )),
    false,
  );
});

test("package rollback preserves a replacement at a committed target", async (t) => {
  const fixture = packageFixtureManifest(t);
  const extractedDir = tempDirectory(t, "watchbound-package-rollback-owner-");
  writeExtractedAppRuntime(extractedDir);
  const firstTarget = packageTarget(
    extractedDir,
    fixture.manifest.packages.targets.x64.name,
  );
  const movedTarget = `${firstTarget}.owned`;
  const markerPath = path.join(firstTarget, "foreign-owner");
  let renames = 0;

  await assert.rejects(
    stageWatchboundPackages(packageStageOptions(extractedDir, fixture, {
      arch: "x64",
      materializePackage: fixtureMaterializer(fixture),
      renamePackage: (source, target) => {
        renames += 1;
        if (renames === 2) {
          fs.renameSync(firstTarget, movedTarget);
          writeFile(markerPath, "preserve\n");
          throw new Error("injected failure after target replacement");
        }
        fs.renameSync(source, target);
      },
    })),
    (error) => {
      assert.equal(error?.code, "PATCH_INTEGRITY_FAILURE");
      assert.equal(packageHelperExitCode(error), 86);
      assert.match(error.message, /identity changed before rollback/u);
      return true;
    },
  );

  assert.equal(fs.readFileSync(markerPath, "utf8"), "preserve\n");
  assert.equal(fs.existsSync(movedTarget), true);
});

test("package rollback treats pre-removal disappearance as failed-integrity", async (t) => {
  const fixture = packageFixtureManifest(t);
  const extractedDir = tempDirectory(t, "watchbound-package-rollback-disappeared-");
  writeExtractedAppRuntime(extractedDir);
  fs.mkdirSync(path.join(extractedDir, "node_modules", "@gadicc"), { recursive: true });
  const firstTarget = packageTarget(
    extractedDir,
    fixture.manifest.packages.targets.x64.name,
  );
  const movedTarget = `${firstTarget}.moved`;
  let renames = 0;

  await assert.rejects(
    stageWatchboundPackages(packageStageOptions(extractedDir, fixture, {
      arch: "x64",
      materializePackage: fixtureMaterializer(fixture),
      renamePackage: (source, target) => {
        renames += 1;
        if (renames === 2) {
          fs.renameSync(firstTarget, movedTarget);
          throw new Error("injected failure after committed target disappeared");
        }
        fs.renameSync(source, target);
      },
    })),
    (error) => {
      assert.equal(error?.code, "PATCH_INTEGRITY_FAILURE");
      assert.equal(packageHelperExitCode(error), 86);
      assert.match(error.message, /package directory disappeared before rollback/u);
      return true;
    },
  );

  assert.equal(fs.existsSync(firstTarget), false);
  assert.equal(fs.existsSync(movedTarget), true);
});

test("an ambiguous rename with no source or target is failed-integrity", async (t) => {
  const fixture = packageFixtureManifest(t);
  const extractedDir = tempDirectory(t, "watchbound-package-rename-disappeared-");
  writeExtractedAppRuntime(extractedDir);
  const movedTarget = path.join(extractedDir, "moved-ambiguous-package");
  let renames = 0;

  await assert.rejects(
    stageWatchboundPackages(packageStageOptions(extractedDir, fixture, {
      arch: "x64",
      materializePackage: fixtureMaterializer(fixture),
      renamePackage: (source, target) => {
        renames += 1;
        if (renames === 2) {
          fs.renameSync(source, target);
          fs.renameSync(target, movedTarget);
          throw new Error("injected ambiguous rename disappearance");
        }
        fs.renameSync(source, target);
      },
    })),
    (error) => {
      assert.equal(error?.code, "PATCH_INTEGRITY_FAILURE");
      assert.equal(packageHelperExitCode(error), 86);
      assert.match(error.message, /rename outcome could not be proven/u);
      return true;
    },
  );

  assert.equal(fs.existsSync(movedTarget), true);
});

test("package rollback never follows a swapped package ancestor", async (t) => {
  const fixture = packageFixtureManifest(t);
  const extractedDir = tempDirectory(t, "watchbound-package-rollback-symlink-");
  const foreignRoot = tempDirectory(t, "watchbound-package-rollback-foreign-");
  writeExtractedAppRuntime(extractedDir);
  const nodeModulesDir = path.join(extractedDir, "node_modules");
  const movedNodeModulesDir = path.join(extractedDir, "moved-node-modules");
  const firstPackageName = fixture.manifest.packages.targets.x64.name;
  const foreignTarget = packageTarget(foreignRoot, firstPackageName);
  const markerPath = path.join(foreignTarget, "foreign-owner");
  let renames = 0;

  await assert.rejects(
    stageWatchboundPackages(packageStageOptions(extractedDir, fixture, {
      arch: "x64",
      materializePackage: fixtureMaterializer(fixture),
      renamePackage: (source, target) => {
        renames += 1;
        if (renames === 2) {
          fs.renameSync(nodeModulesDir, movedNodeModulesDir);
          writeFile(markerPath, "preserve\n");
          fs.symlinkSync(path.join(foreignRoot, "node_modules"), nodeModulesDir, "dir");
          throw new Error("injected failure after ancestor replacement");
        }
        fs.renameSync(source, target);
      },
    })),
    (error) => {
      assert.equal(error?.code, "PATCH_INTEGRITY_FAILURE");
      assert.equal(packageHelperExitCode(error), 86);
      assert.match(error.message, /must not contain symlinks/u);
      return true;
    },
  );

  assert.equal(fs.readFileSync(markerPath, "utf8"), "preserve\n");
  assert.equal(
    fs.existsSync(path.join(
      movedNodeModulesDir,
      "@gadicc",
      "watchbound-node-linux-x64-gnu",
    )),
    true,
  );
});

test("package rollback quarantines before trusting a recursive remover", async (t) => {
  const fixture = packageFixtureManifest(t);
  const extractedDir = tempDirectory(t, "watchbound-package-rollback-quarantine-");
  writeExtractedAppRuntime(extractedDir);
  const firstTarget = packageTarget(
    extractedDir,
    fixture.manifest.packages.targets.x64.name,
  );
  const movedTarget = path.join(extractedDir, "moved-owned-package");
  const originalRenameSync = fs.renameSync;
  let quarantineTarget = null;
  let renames = 0;
  let removals = 0;
  fs.renameSync = (source, target) => {
    if (source === firstTarget) {
      originalRenameSync(source, movedTarget);
      writeFile(path.join(source, "foreign-owner"), "preserve\n");
      quarantineTarget = target;
    }
    return originalRenameSync(source, target);
  };

  try {
    await assert.rejects(
      stageWatchboundPackages(packageStageOptions(extractedDir, fixture, {
        arch: "x64",
        materializePackage: fixtureMaterializer(fixture),
        renamePackage: (source, target) => {
          renames += 1;
          if (renames === 2) throw new Error("injected second commit failure");
          originalRenameSync(source, target);
        },
        removePackage: (targetDir) => {
          removals += 1;
          fs.rmSync(targetDir, { recursive: true, force: true });
        },
      })),
      (error) => {
        assert.equal(error?.code, "PATCH_INTEGRITY_FAILURE");
        assert.equal(packageHelperExitCode(error), 86);
        assert.match(error.message, /identity changed during rollback quarantine/u);
        return true;
      },
    );
  } finally {
    fs.renameSync = originalRenameSync;
  }

  assert.equal(removals, 0);
  assert.equal(fs.existsSync(movedTarget), true);
  assert.equal(
    fs.readFileSync(path.join(quarantineTarget, "foreign-owner"), "utf8"),
    "preserve\n",
  );
});

test("package rollback trusts verified absence after a remover throws", async (t) => {
  const fixture = packageFixtureManifest(t);
  const extractedDir = tempDirectory(t, "watchbound-package-remove-postcondition-");
  writeExtractedAppRuntime(extractedDir);
  let renames = 0;
  let removals = 0;

  await assert.rejects(
    stageWatchboundPackages(packageStageOptions(extractedDir, fixture, {
      arch: "x64",
      materializePackage: fixtureMaterializer(fixture),
      renamePackage: (source, target) => {
        renames += 1;
        if (renames === 2) throw new Error("injected second commit failure");
        fs.renameSync(source, target);
      },
      removePackage: (targetDir) => {
        removals += 1;
        fs.rmSync(targetDir, { recursive: true, force: true });
        throw new Error("remover threw after deleting target");
      },
    })),
    (error) => {
      assert.equal(error?.code, undefined);
      assert.equal(packageHelperExitCode(error), 1);
      assert.match(error.message, /injected second commit failure/u);
      return true;
    },
  );
  assert.equal(removals, 1);
  for (const artifact of [
    fixture.manifest.packages.targets.x64,
    fixture.manifest.packages.loader,
    fixture.manifest.packages.wrapper,
  ]) {
    assert.equal(fs.existsSync(packageTarget(extractedDir, artifact.name)), false);
  }
  assert.equal(fs.existsSync(path.join(extractedDir, "node_modules")), false);
});

test("package rollback preserves concurrently created parent directories", async (t) => {
  const fixture = packageFixtureManifest(t);
  const extractedDir = tempDirectory(t, "watchbound-package-parent-owner-");
  writeExtractedAppRuntime(extractedDir);
  const nodeModulesDir = path.join(extractedDir, "node_modules");
  let renames = 0;
  let creations = 0;

  await assert.rejects(
    stageWatchboundPackages(packageStageOptions(extractedDir, fixture, {
      arch: "x64",
      materializePackage: fixtureMaterializer(fixture),
      createPackageDirectory: (directory) => {
        creations += 1;
        if (directory === nodeModulesDir) {
          fs.mkdirSync(directory);
          throw Object.assign(new Error("concurrent parent creation"), { code: "EEXIST" });
        }
        fs.mkdirSync(directory);
      },
      renamePackage: (source, target) => {
        renames += 1;
        if (renames === 2) throw new Error("injected second commit failure");
        fs.renameSync(source, target);
      },
    })),
    /injected second commit failure/u,
  );
  assert.ok(creations >= 2);
  assert.equal(fs.existsSync(nodeModulesDir), true);
  assert.deepEqual(fs.readdirSync(nodeModulesDir), []);
});

test("package staging preserves an ambiguously created parent directory", async (t) => {
  const fixture = packageFixtureManifest(t);
  const extractedDir = tempDirectory(t, "watchbound-package-parent-ambiguous-");
  writeExtractedAppRuntime(extractedDir);
  const nodeModulesDir = path.join(extractedDir, "node_modules");

  await assert.rejects(
    stageWatchboundPackages(packageStageOptions(extractedDir, fixture, {
      arch: "x64",
      materializePackage: fixtureMaterializer(fixture),
      createPackageDirectory: (directory) => {
        fs.mkdirSync(directory);
        throw new Error("mkdir reported failure after creation");
      },
    })),
    (error) => {
      assert.equal(error?.code, "PATCH_INTEGRITY_FAILURE");
      assert.equal(packageHelperExitCode(error), 86);
      assert.match(error.message, /parent creation ownership could not be proven/u);
      return true;
    },
  );
  assert.equal(fs.existsSync(nodeModulesDir), true);
  assert.deepEqual(fs.readdirSync(nodeModulesDir), []);
});

test("package parent rollback never follows a swapped symlink ancestor", async (t) => {
  const fixture = packageFixtureManifest(t);
  const extractedDir = tempDirectory(t, "watchbound-package-parent-symlink-");
  const outsideDir = tempDirectory(t, "watchbound-package-parent-outside-");
  writeExtractedAppRuntime(extractedDir);
  const nodeModulesDir = path.join(extractedDir, "node_modules");
  const movedNodeModulesDir = path.join(outsideDir, "moved-node-modules");
  const scopedParentDir = path.join(nodeModulesDir, "@gadicc");

  await assert.rejects(
    stageWatchboundPackages(packageStageOptions(extractedDir, fixture, {
      arch: "x64",
      materializePackage: fixtureMaterializer(fixture),
      createPackageDirectory: (directory) => {
        if (directory === scopedParentDir) {
          fs.renameSync(nodeModulesDir, movedNodeModulesDir);
          fs.symlinkSync(movedNodeModulesDir, nodeModulesDir, "dir");
        }
        fs.mkdirSync(directory);
      },
    })),
    (error) => {
      assert.equal(error?.code, "PATCH_INTEGRITY_FAILURE");
      assert.equal(packageHelperExitCode(error), 86);
      assert.match(error.message, /rollback could not be proven/u);
      return true;
    },
  );
  assert.equal(fs.lstatSync(nodeModulesDir).isSymbolicLink(), true);
  assert.equal(fs.existsSync(path.join(movedNodeModulesDir, "@gadicc")), true);
});

test("package parent rollback treats pre-removal disappearance as failed-integrity", async (t) => {
  const fixture = packageFixtureManifest(t);
  const extractedDir = tempDirectory(t, "watchbound-package-parent-disappeared-");
  writeExtractedAppRuntime(extractedDir);
  const nodeModulesDir = path.join(extractedDir, "node_modules");
  const scopedParentDir = path.join(nodeModulesDir, "@gadicc");
  const movedScopedParentDir = path.join(nodeModulesDir, "@gadicc-moved");
  fs.mkdirSync(nodeModulesDir);
  let renames = 0;

  await assert.rejects(
    stageWatchboundPackages(packageStageOptions(extractedDir, fixture, {
      arch: "x64",
      materializePackage: fixtureMaterializer(fixture),
      renamePackage: (source, target) => {
        renames += 1;
        if (renames === 2) throw new Error("injected second commit failure");
        fs.renameSync(source, target);
      },
      removePackage: (targetDir) => {
        fs.rmSync(targetDir, { recursive: true, force: true });
        fs.renameSync(scopedParentDir, movedScopedParentDir);
      },
    })),
    (error) => {
      assert.equal(error?.code, "PATCH_INTEGRITY_FAILURE");
      assert.equal(packageHelperExitCode(error), 86);
      assert.match(error.message, /directory disappeared before rollback/u);
      return true;
    },
  );

  assert.equal(fs.existsSync(scopedParentDir), false);
  assert.equal(fs.existsSync(movedScopedParentDir), true);
});

test("package parent rollback quarantines before calling rmdir", async (t) => {
  const fixture = packageFixtureManifest(t);
  const extractedDir = tempDirectory(t, "watchbound-package-parent-quarantine-");
  writeExtractedAppRuntime(extractedDir);
  const scopedParentDir = path.join(extractedDir, "node_modules", "@gadicc");
  const movedScopedParentDir = path.join(extractedDir, "moved-owned-parent");
  const originalRenameSync = fs.renameSync;
  let quarantineTarget = null;
  let renames = 0;
  let foreignRemovalAttempted = false;
  fs.renameSync = (source, target) => {
    if (source === scopedParentDir) {
      originalRenameSync(source, movedScopedParentDir);
      writeFile(path.join(source, "foreign-owner"), "preserve\n");
      quarantineTarget = target;
    }
    return originalRenameSync(source, target);
  };

  try {
    await assert.rejects(
      stageWatchboundPackages(packageStageOptions(extractedDir, fixture, {
        arch: "x64",
        materializePackage: fixtureMaterializer(fixture),
        renamePackage: (source, target) => {
          renames += 1;
          if (renames === 2) throw new Error("injected second commit failure");
          originalRenameSync(source, target);
        },
        removePackageDirectory: (targetDir) => {
          if (targetDir === quarantineTarget) foreignRemovalAttempted = true;
          fs.rmdirSync(targetDir);
        },
      })),
      (error) => {
        assert.equal(error?.code, "PATCH_INTEGRITY_FAILURE");
        assert.equal(packageHelperExitCode(error), 86);
        assert.match(error.message, /identity changed during rollback quarantine/u);
        return true;
      },
    );
  } finally {
    fs.renameSync = originalRenameSync;
  }

  assert.equal(foreignRemovalAttempted, false);
  assert.equal(fs.existsSync(movedScopedParentDir), true);
  assert.equal(
    fs.readFileSync(path.join(quarantineTarget, "foreign-owner"), "utf8"),
    "preserve\n",
  );
});

test("package parent rollback trusts verified absence after rmdir throws", async (t) => {
  const fixture = packageFixtureManifest(t);
  const extractedDir = tempDirectory(t, "watchbound-package-parent-cleanup-");
  writeExtractedAppRuntime(extractedDir);
  let renames = 0;
  let removals = 0;

  await assert.rejects(
    stageWatchboundPackages(packageStageOptions(extractedDir, fixture, {
      arch: "x64",
      materializePackage: fixtureMaterializer(fixture),
      renamePackage: (source, target) => {
        renames += 1;
        if (renames === 2) throw new Error("injected second commit failure");
        fs.renameSync(source, target);
      },
      removePackageDirectory: (directory) => {
        removals += 1;
        fs.rmdirSync(directory);
        throw new Error("rmdir threw after deleting parent");
      },
    })),
    (error) => {
      assert.equal(error?.code, undefined);
      assert.equal(packageHelperExitCode(error), 1);
      assert.match(error.message, /injected second commit failure/u);
      return true;
    },
  );
  assert.ok(removals >= 2);
  assert.equal(fs.existsSync(path.join(extractedDir, "node_modules")), false);
});

test("package staging trusts verified staging-root cleanup", async (t) => {
  const fixture = packageFixtureManifest(t);
  const extractedDir = tempDirectory(t, "watchbound-package-cleanup-postcondition-");
  writeExtractedAppRuntime(extractedDir);

  const result = await stageWatchboundPackages(packageStageOptions(extractedDir, fixture, {
    arch: "x64",
    materializePackage: fixtureMaterializer(fixture),
    removeStagingRoot: (stagingRoot) => {
      fs.rmSync(stagingRoot, { recursive: true, force: true });
      throw new Error("cleanup threw after deleting staging root");
    },
  }));

  assert.equal(result.changed, true);
  assert.deepEqual(
    fs.readdirSync(extractedDir).filter((name) =>
      name.startsWith(".codex-watchbound-package-set-")
    ),
    [],
  );
});

test("package staging preserves a replacement at the staging-root path", async (t) => {
  const fixture = packageFixtureManifest(t);
  const extractedDir = tempDirectory(t, "watchbound-staging-root-owner-");
  writeExtractedAppRuntime(extractedDir);
  const movedStagingRoot = path.join(extractedDir, "moved-staging-root");
  let replacementRoot = null;
  let markerPath = null;
  let renames = 0;

  await assert.rejects(
    stageWatchboundPackages(packageStageOptions(extractedDir, fixture, {
      arch: "x64",
      materializePackage: fixtureMaterializer(fixture),
      renamePackage: (source, target) => {
        renames += 1;
        fs.renameSync(source, target);
        if (renames === 3) {
          replacementRoot = fs.readdirSync(extractedDir)
            .map((name) => path.join(extractedDir, name))
            .find((candidate) =>
              path.basename(candidate).startsWith(".codex-watchbound-package-set-")
            );
          fs.renameSync(replacementRoot, movedStagingRoot);
          markerPath = path.join(replacementRoot, "foreign-owner");
          writeFile(markerPath, "preserve\n");
        }
      },
    })),
    (error) => {
      assert.equal(error?.code, "PATCH_INTEGRITY_FAILURE");
      assert.equal(packageHelperExitCode(error), 86);
      assert.match(error.message, /staging root identity changed before cleanup/u);
      return true;
    },
  );

  assert.equal(renames, 3);
  assert.equal(fs.readFileSync(markerPath, "utf8"), "preserve\n");
  assert.equal(fs.existsSync(movedStagingRoot), true);
});

test("package staging never follows a staging-root symlink during cleanup", async (t) => {
  const fixture = packageFixtureManifest(t);
  const extractedDir = tempDirectory(t, "watchbound-staging-root-symlink-");
  const foreignRoot = tempDirectory(t, "watchbound-staging-root-foreign-");
  writeExtractedAppRuntime(extractedDir);
  const movedStagingRoot = path.join(extractedDir, "moved-staging-root");
  const markerPath = path.join(foreignRoot, "foreign-owner");
  let replacementRoot = null;
  let renames = 0;

  await assert.rejects(
    stageWatchboundPackages(packageStageOptions(extractedDir, fixture, {
      arch: "x64",
      materializePackage: fixtureMaterializer(fixture),
      renamePackage: (source, target) => {
        renames += 1;
        fs.renameSync(source, target);
        if (renames === 3) {
          replacementRoot = fs.readdirSync(extractedDir)
            .map((name) => path.join(extractedDir, name))
            .find((candidate) =>
              path.basename(candidate).startsWith(".codex-watchbound-package-set-")
            );
          fs.renameSync(replacementRoot, movedStagingRoot);
          writeFile(markerPath, "preserve\n");
          fs.symlinkSync(foreignRoot, replacementRoot, "dir");
        }
      },
    })),
    (error) => {
      assert.equal(error?.code, "PATCH_INTEGRITY_FAILURE");
      assert.equal(packageHelperExitCode(error), 86);
      assert.match(error.message, /must not contain symlinks/u);
      return true;
    },
  );

  assert.equal(renames, 3);
  assert.equal(fs.readFileSync(markerPath, "utf8"), "preserve\n");
  assert.equal(fs.lstatSync(replacementRoot).isSymbolicLink(), true);
  assert.equal(fs.existsSync(movedStagingRoot), true);
});

test("package staging treats pre-removal disappearance as failed-integrity", async (t) => {
  const fixture = packageFixtureManifest(t);
  const extractedDir = tempDirectory(t, "watchbound-staging-root-disappeared-");
  writeExtractedAppRuntime(extractedDir);
  const movedStagingRoot = path.join(extractedDir, "moved-staging-root");
  let renames = 0;

  await assert.rejects(
    stageWatchboundPackages(packageStageOptions(extractedDir, fixture, {
      arch: "x64",
      materializePackage: fixtureMaterializer(fixture),
      renamePackage: (source, target) => {
        renames += 1;
        fs.renameSync(source, target);
        if (renames === 3) {
          const stagingRoot = fs.readdirSync(extractedDir)
            .map((name) => path.join(extractedDir, name))
            .find((candidate) =>
              path.basename(candidate).startsWith(".codex-watchbound-package-set-")
            );
          fs.renameSync(stagingRoot, movedStagingRoot);
        }
      },
    })),
    (error) => {
      assert.equal(error?.code, "PATCH_INTEGRITY_FAILURE");
      assert.equal(packageHelperExitCode(error), 86);
      assert.match(error.message, /staging root disappeared before cleanup/u);
      return true;
    },
  );

  assert.equal(renames, 3);
  assert.equal(fs.existsSync(movedStagingRoot), true);
});

test("package staging quarantines before trusting a recursive remover", async (t) => {
  const fixture = packageFixtureManifest(t);
  const extractedDir = tempDirectory(t, "watchbound-staging-root-quarantine-");
  writeExtractedAppRuntime(extractedDir);
  const movedStagingRoot = path.join(extractedDir, "moved-owned-staging-root");
  const originalRenameSync = fs.renameSync;
  let quarantineTarget = null;
  let removals = 0;
  fs.renameSync = (source, target) => {
    if (path.basename(source).startsWith(".codex-watchbound-package-set-")) {
      originalRenameSync(source, movedStagingRoot);
      writeFile(path.join(source, "foreign-owner"), "preserve\n");
      quarantineTarget = target;
    }
    return originalRenameSync(source, target);
  };

  try {
    await assert.rejects(
      stageWatchboundPackages(packageStageOptions(extractedDir, fixture, {
        arch: "x64",
        materializePackage: fixtureMaterializer(fixture),
        removeStagingRoot: (targetDir) => {
          removals += 1;
          fs.rmSync(targetDir, { recursive: true, force: true });
        },
      })),
      (error) => {
        assert.equal(error?.code, "PATCH_INTEGRITY_FAILURE");
        assert.equal(packageHelperExitCode(error), 86);
        assert.match(error.message, /identity changed during cleanup quarantine/u);
        return true;
      },
    );
  } finally {
    fs.renameSync = originalRenameSync;
  }

  assert.equal(removals, 0);
  assert.equal(fs.existsSync(movedStagingRoot), true);
  assert.equal(
    fs.readFileSync(path.join(quarantineTarget, "foreign-owner"), "utf8"),
    "preserve\n",
  );
});

test("staging-root ownership ambiguity is failed-integrity before the transaction", async (t) => {
  const fixture = packageFixtureManifest(t);
  const extractedDir = tempDirectory(t, "watchbound-staging-root-initial-swap-");
  const foreignRoot = tempDirectory(t, "watchbound-staging-root-initial-foreign-");
  writeExtractedAppRuntime(extractedDir);
  const movedStagingRoot = path.join(extractedDir, "moved-staging-root");
  const markerPath = path.join(foreignRoot, "foreign-owner");
  writeFile(markerPath, "preserve\n");
  const originalMkdtempSync = fs.mkdtempSync;
  let replacementRoot = null;
  let swapped = false;
  fs.mkdtempSync = (prefix, ...args) => {
    const stagingRoot = originalMkdtempSync(prefix, ...args);
    if (!swapped && prefix.includes(".codex-watchbound-package-set-")) {
      swapped = true;
      replacementRoot = stagingRoot;
      fs.renameSync(stagingRoot, movedStagingRoot);
      fs.symlinkSync(foreignRoot, stagingRoot, "dir");
    }
    return stagingRoot;
  };

  try {
    await assert.rejects(
      stageWatchboundPackages(packageStageOptions(extractedDir, fixture, {
        arch: "x64",
        materializePackage: fixtureMaterializer(fixture),
      })),
      (error) => {
        assert.equal(error?.code, "PATCH_INTEGRITY_FAILURE");
        assert.equal(packageHelperExitCode(error), 86);
        assert.match(error.message, /staging-root ownership could not be proven/u);
        return true;
      },
    );
  } finally {
    fs.mkdtempSync = originalMkdtempSync;
  }

  assert.equal(swapped, true);
  assert.equal(fs.readFileSync(markerPath, "utf8"), "preserve\n");
  assert.equal(fs.lstatSync(replacementRoot).isSymbolicLink(), true);
  assert.equal(fs.existsSync(movedStagingRoot), true);
});

test("Watchbound package-set reports failed-integrity when rollback is unprovable", async (t) => {
  const fixture = packageFixtureManifest(t);
  const extractedDir = tempDirectory(t, "watchbound-package-integrity-");
  writeExtractedAppRuntime(extractedDir);
  let renames = 0;

  await assert.rejects(
    stageWatchboundPackages(packageStageOptions(extractedDir, fixture, {
      arch: "x64",
      materializePackage: fixtureMaterializer(fixture),
      renamePackage: (source, target) => {
        renames += 1;
        if (renames === 2) throw new Error("injected commit failure");
        fs.renameSync(source, target);
      },
      removePackage: () => {
        throw new Error("injected rollback failure");
      },
    })),
    (error) =>
      error?.code === "PATCH_INTEGRITY_FAILURE" &&
      /rollback could not be proven.*injected rollback failure/u.test(error.message),
  );
  assert.equal(renames, 2);
  assert.equal(
    fs.existsSync(packageTarget(
      extractedDir,
      fixture.manifest.packages.targets.x64.name,
    )),
    false,
  );
  assert.ok(
    fs.readdirSync(extractedDir).some((name) =>
      name.startsWith(".codex-watchbound-package-set-")
    ),
  );
});

test("cleanup failures preserve an unprovable package rollback as failed-integrity", async (t) => {
  const fixture = packageFixtureManifest(t);
  const extractedDir = tempDirectory(t, "watchbound-package-cleanup-integrity-");
  writeExtractedAppRuntime(extractedDir);
  let renames = 0;
  let cleanups = 0;

  await assert.rejects(
    stageWatchboundPackages(packageStageOptions(extractedDir, fixture, {
      arch: "x64",
      materializePackage: fixtureMaterializer(fixture, {
        cleanup: () => {
          cleanups += 1;
          throw new Error("injected materializer cleanup failure");
        },
      }),
      renamePackage: (source, target) => {
        renames += 1;
        if (renames === 2) throw new Error("injected commit failure");
        fs.renameSync(source, target);
      },
      removePackage: () => {
        throw new Error("injected rollback failure");
      },
      removeStagingRoot: () => {
        throw new Error("injected staging-root cleanup failure");
      },
    })),
    (error) => {
      assert.equal(error?.code, "PATCH_INTEGRITY_FAILURE");
      assert.equal(packageHelperExitCode(error), 86);
      assert.match(
        error.message,
        /rollback could not be proven.*injected rollback failure/u,
      );
      assert.match(error.message, /staging root cleanup skipped/u);
      assert.match(error.message, /injected materializer cleanup failure/u);
      return true;
    },
  );
  assert.equal(renames, 2);
  assert.equal(cleanups, 3);
});

function fakeWatchbound(hooks = {}) {
  const physicalRoot = (root, override) => {
    if (override !== undefined) return override;
    try {
      return fs.realpathSync.native(root);
    } catch {
      return path.resolve(root);
    }
  };
  const normalizePolicy = (policy = {}) => {
    const value = Array.isArray(policy) ? { prefixes: policy } : policy;
    return {
      prefixes: [...(value.prefixes ?? [])],
      excludedDirectoryNames: [...(value.excludedDirectoryNames ?? [])],
      observedExcludedPaths: [...(value.observedExcludedPaths ?? [])],
    };
  };
  const subscriptions = [];
  const runtime = {
    active: false,
    nativeWatchBudget: null,
    nativeWatches: 0,
    deferredInterests: 0,
    subscriptions: 0,
    inotifyInstances: 0,
    workerThreads: 0,
  };
  const engine = {
    subscribe: async (root, callback, options) => {
      const resolvedPhysicalRoot = physicalRoot(root, hooks.resolvedPhysicalRoot);
      let automaticReconciliationScheduled = false;
      const initialPolicy = normalizePolicy({
        prefixes: options.initialExclusions,
        excludedDirectoryNames: options.excludedDirectoryNames,
        observedExcludedPaths: options.observedExcludedPaths,
      });
      const subscription = {
        requestedRoot: root,
        root: resolvedPhysicalRoot,
        resolvedRoot: {
          policy: options.rootPathPolicy ?? "strict",
          lexicalPath: root,
          lexicalPathBytes: Buffer.from(root),
          physicalPath: hooks.resolvedPhysicalPath === null
            ? null
            : resolvedPhysicalRoot,
          physicalPathBytes: Buffer.from(resolvedPhysicalRoot),
          pathForm: "physical",
          aliasTracking: "establishment-snapshot",
          identity: { device: 1n, inode: 1n },
        },
        callback: null,
        options,
        exclusionGeneration: 0n,
        initialPolicy,
        policy: initialPolicy,
        initialCoverage: hooks.initialCoverage ?? { state: "complete" },
        rootState: { attachment: "attached" },
        disposed: false,
        disposeCalls: 0,
        replacements: [],
        reconciliations: [],
        recoveries: [],
        stats: () => ({
          watchedDirectories: options.watchLimit === 1 ? 1 : 4,
        }),
        replaceExclusions: async (generation, nextPolicy) => {
          const policy = normalizePolicy(nextPolicy);
          if (typeof hooks.replaceExclusions === "function") {
            return hooks.replaceExclusions({
              generation,
              policy,
              ...policy,
              subscription,
            });
          }
          subscription.exclusionGeneration = generation;
          subscription.policy = policy;
          subscription.replacements.push({ generation, policy, ...policy });
          const coverage = hooks.replacementCoverage ?? { state: "complete" };
          if (hooks.emitReplacementBoundary === true) {
            queueMicrotask(() => subscription.callback({
              invalidatedPaths: [subscription.root],
              pathEncodingCollapsed: false,
              coverage,
              rootState: { attachment: "attached" },
            }, { stop() {} }));
          }
          return coverage;
        },
        reconcile: async () => {
          subscription.reconciliations.push({});
          return hooks.reconciliationResult ?? {
            exclusionGeneration: subscription.exclusionGeneration,
            coverage: { state: "complete" },
          };
        },
        recoverRoot: async (recoveryOptions) => {
          subscription.recoveries.push(recoveryOptions);
          const result = typeof hooks.recoverRoot === "function"
            ? await hooks.recoverRoot({ recoveryOptions, subscription })
            : {
                attachment: hooks.recoveryAttachment ?? "replacement-adopted",
                coverage: { state: "complete" },
              };
          if (
            result.attachment === "original-restored" ||
            result.attachment === "replacement-adopted"
          ) {
            subscription.rootState = { attachment: "attached" };
          }
          return result;
        },
        dispose: async () => {
          subscription.disposeCalls += 1;
          if (subscription.disposed) return;
          await hooks.onDispose?.({ subscription });
          subscription.disposed = true;
          runtime.subscriptions -= 1;
          runtime.nativeWatches -= subscription.stats().watchedDirectories;
          if (runtime.subscriptions === 0) {
            runtime.active = false;
            runtime.nativeWatchBudget = null;
            runtime.inotifyInstances = 0;
            runtime.workerThreads = 0;
          }
        },
      };
      subscription.callback = (batch, context) => {
        callback(batch, context);
        if (
          options.automaticReconciliation === true &&
          batch.coverage?.state === "uncertain" &&
          [
            "event-overflow",
            "topology-race",
            "consumer-backpressure",
          ].includes(batch.coverage.reason) &&
          !automaticReconciliationScheduled
        ) {
          automaticReconciliationScheduled = true;
          queueMicrotask(() => {
            automaticReconciliationScheduled = false;
            void subscription.reconcile();
          });
        }
      };
      subscriptions.push(subscription);
      runtime.active = true;
      runtime.nativeWatchBudget ??= 64;
      runtime.subscriptions += 1;
      runtime.nativeWatches += subscription.stats().watchedDirectories;
      runtime.inotifyInstances = 1;
      runtime.workerThreads = 1;
      if (typeof hooks.beforeSubscribeResolve === "function") {
        hooks.beforeSubscribeResolve({
          callback: subscription.callback,
          root: subscription.root,
          subscription,
        });
        await new Promise((resolve) => setImmediate(resolve));
      }
      return subscription;
    },
    runtimeStats: () => ({ ...runtime }),
  };
  return {
    qualificationRetryDelays: hooks.qualificationRetryDelays,
    capabilities: {
      schemaVersion: 9,
      versions: {
        wrapper: WATCHBOUND_VERSION,
        native: WATCHBOUND_VERSION,
        engine: WATCHBOUND_VERSION,
        bindingApi: 5,
      },
      support: { currentRuntime: { targetCompatible: true } },
      features: {
        initialExclusions: true,
        dynamicExclusions: true,
        directoryNameExclusions: true,
        observedExcludedPaths: true,
        reconciliation: true,
        automaticReconciliation: true,
        rootReplacementRecovery: true,
        physicalRootResolution: true,
        rootQualification: true,
        bytesOnlyInvalidations: true,
        exactPathBytes: true,
      },
      options: {
        subscription: {
          rootPathPolicy: { values: ["strict", "resolve-physical"] },
        },
      },
    },
    qualifyRoot: (root) => {
      if (typeof hooks.qualifyRoot === "function") return hooks.qualifyRoot(root);
      const qualifiedPhysicalRoot = physicalRoot(root, hooks.qualificationPhysicalRoot);
      return {
        schemaVersion: 1,
        state: "qualified",
        reasons: [],
        root: {
          lexicalPath: root,
          lexicalPathBytes: Buffer.from(root),
          physicalPath: qualifiedPhysicalRoot,
          physicalPathBytes: Buffer.from(qualifiedPhysicalRoot),
        },
      };
    },
    createEngine: ({ nativeWatchBudget }) => {
      runtime.nativeWatchBudget = nativeWatchBudget;
      return engine;
    },
    engine,
    subscriptions,
  };
}

function git(root, args) {
  return childProcess.execFileSync("git", ["-C", root, ...args], {
    encoding: "utf8",
  });
}

async function waitFor(predicate, label, timeout = 3000) {
  const deadline = Date.now() + timeout;
  while (!predicate() && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.ok(predicate(), `timed out waiting for ${label}`);
}

test("the adapter fails closed on every Watchbound 2.1.1 contract mismatch", async (t) => {
  const originalReport = Object.getOwnPropertyDescriptor(process, "report");
  t.after(() => {
    Object.defineProperty(process, "report", originalReport);
    delete globalThis[MODULE_OVERRIDE_KEY];
    delete globalThis[ENGINE_KEY];
  });
  const mismatches = [
    ["public schema", (capabilities) => { capabilities.schemaVersion = 7; }],
    ["wrapper version", (capabilities) => { capabilities.versions.wrapper = "1.2.0"; }],
    ["native version", (capabilities) => { capabilities.versions.native = "1.2.0"; }],
    ["engine version", (capabilities) => { capabilities.versions.engine = "1.2.0"; }],
    ["binding API", (capabilities) => { capabilities.versions.bindingApi = 4; }],
    ["runtime qualification", (capabilities) => {
      capabilities.support.currentRuntime.targetCompatible = false;
    }],
    ["directory-name exclusions", (capabilities) => {
      capabilities.features.directoryNameExclusions = false;
    }],
    ["observed excluded paths", (capabilities) => {
      capabilities.features.observedExcludedPaths = false;
    }],
    ["physical root resolution", (capabilities) => {
      capabilities.features.physicalRootResolution = false;
    }],
    ["root qualification", (capabilities) => {
      capabilities.features.rootQualification = false;
    }],
    ["bytes-only invalidations", (capabilities) => {
      capabilities.features.bytesOnlyInvalidations = false;
    }],
    ["exact path bytes", (capabilities) => {
      capabilities.features.exactPathBytes = false;
    }],
    ["physical root policy", (capabilities) => {
      capabilities.options.subscription.rootPathPolicy.values = ["strict"];
    }],
  ];
  for (const [label, mutate] of mismatches) {
    const fake = fakeWatchbound();
    mutate(fake.capabilities);
    globalThis[MODULE_OVERRIDE_KEY] = fake;
    delete globalThis[ENGINE_KEY];
    await assert.rejects(
      codexLinuxStartDirectoryOnlyWorkingTreeWatch(
        {
          getFileSystemPath: () => "/qualified/root",
          platformPath: async () => path.posix,
        },
        {
          path: "/logical/root",
          recursive: true,
          renameEventHandling: "changed-path-with-parent-directory",
          onChange() {},
        },
        {
          maxWatches: 64,
          honorGitIgnore: false,
          ignoredDirectoryNames: [],
        },
      ),
      /requires watchbound 2\.1\.1.*native exclusions/iu,
      label,
    );
    assert.equal(fake.subscriptions.length, 0);
  }
});

test("the adapter replaces process.report before any Watchbound code runs", async (t) => {
  const originalReport = Object.getOwnPropertyDescriptor(process, "report");
  let poisonedCalls = 0;
  Object.defineProperty(process, "report", {
    configurable: true,
    enumerable: true,
    value: {
      getReport() {
        poisonedCalls += 1;
        throw new Error("getReport is fatal inside the packaged Electron binary");
      },
    },
  });
  const fake = fakeWatchbound();
  fake.capabilities.schemaVersion = 0;
  globalThis[MODULE_OVERRIDE_KEY] = fake;
  delete globalThis[ENGINE_KEY];
  t.after(() => {
    delete globalThis[MODULE_OVERRIDE_KEY];
    delete globalThis[ENGINE_KEY];
    Object.defineProperty(process, "report", originalReport);
  });

  const start = () => codexLinuxStartDirectoryOnlyWorkingTreeWatch(
    {
      getFileSystemPath: () => "/qualified/root",
      platformPath: async () => path.posix,
    },
    {
      path: "/logical/root",
      recursive: true,
      renameEventHandling: "changed-path-with-parent-directory",
      onChange() {},
    },
    {
      maxWatches: 64,
      honorGitIgnore: false,
      ignoredDirectoryNames: [],
    },
  );
  await assert.rejects(start(), /requires watchbound 2\.1\.1/u);

  assert.equal(poisonedCalls, 0);
  const shim = process.report;
  assert.equal(shim[Symbol.for(REPORT_SHIM_SYMBOL_KEY)], true);
  const report = shim.getReport();
  assert.equal(typeof report.header, "object");
  assert.ok(Array.isArray(report.sharedObjects));
  let expectGlibc = false;
  try {
    expectGlibc = fs.readFileSync("/usr/bin/ldd", "latin1").includes("GNU C Library");
  } catch {}
  if (expectGlibc) {
    assert.match(report.header.glibcVersionRuntime, /^\d+\.\d+/u);
  }

  await assert.rejects(start(), /requires watchbound 2\.1\.1/u);
  assert.equal(process.report, shim);
});

test("the report shim reads the glibc version from a Nix store interpreter", async (t) => {
  const interpreterPath =
    "/nix/store/6q3xi2h1a7lb0k5cm9dr8v4y5zj0wf2s-glibc-2.40-66/lib64/ld-linux-x86-64.so.2";
  const interpreterBytes = Buffer.from(`${interpreterPath}\0`, "utf8");
  const image = Buffer.alloc(512);
  image.writeUInt32LE(0x464c457f, 0);
  image[4] = 2;
  image[5] = 1;
  image.writeBigUInt64LE(64n, 32);
  image.writeUInt16LE(56, 54);
  image.writeUInt16LE(1, 56);
  image.writeUInt32LE(3, 64);
  image.writeBigUInt64LE(256n, 64 + 8);
  image.writeBigUInt64LE(BigInt(interpreterBytes.length), 64 + 32);
  interpreterBytes.copy(image, 256);
  const executable = path.join(tempDirectory(t, "watchbound-nix-elf-"), "electron");
  fs.writeFileSync(executable, image);

  const originalReport = Object.getOwnPropertyDescriptor(process, "report");
  Object.defineProperty(process, "report", {
    configurable: true,
    enumerable: true,
    value: {
      getReport() {
        throw new Error("getReport is fatal inside the packaged Electron binary");
      },
    },
  });
  const fake = fakeWatchbound();
  fake.capabilities.schemaVersion = 0;
  fake.reportProbeExecutable = executable;
  globalThis[MODULE_OVERRIDE_KEY] = fake;
  delete globalThis[ENGINE_KEY];
  t.after(() => {
    delete globalThis[MODULE_OVERRIDE_KEY];
    delete globalThis[ENGINE_KEY];
    Object.defineProperty(process, "report", originalReport);
  });

  await assert.rejects(
    codexLinuxStartDirectoryOnlyWorkingTreeWatch(
      {
        getFileSystemPath: () => "/qualified/root",
        platformPath: async () => path.posix,
      },
      {
        path: "/logical/root",
        recursive: true,
        renameEventHandling: "changed-path-with-parent-directory",
        onChange() {},
      },
      {
        maxWatches: 64,
        honorGitIgnore: false,
        ignoredDirectoryNames: [],
      },
    ),
    /requires watchbound 2\.1\.1/u,
  );

  const report = process.report.getReport();
  assert.equal(report.header.glibcVersionRuntime, "2.40");
  assert.deepEqual(report.sharedObjects, []);
});

test("a failed Watchbound import degrades to the preserved fallback", async (t) => {
  const originalReport = Object.getOwnPropertyDescriptor(process, "report");
  let poisonedCalls = 0;
  Object.defineProperty(process, "report", {
    configurable: true,
    enumerable: true,
    value: {
      getReport() {
        poisonedCalls += 1;
        throw new Error("getReport is fatal inside the packaged Electron binary");
      },
    },
  });
  delete globalThis[MODULE_OVERRIDE_KEY];
  delete globalThis[ENGINE_KEY];
  t.after(() => {
    Object.defineProperty(process, "report", originalReport);
  });

  let fallbackCalls = 0;
  const preserved = { dispose() {} };
  const result = await codexLinuxStartDirectoryOnlyWorkingTreeWatch(
    {
      getFileSystemPath: () => "/qualified/root",
      platformPath: async () => path.posix,
    },
    {
      path: "/logical/root",
      recursive: true,
      renameEventHandling: "changed-path-with-parent-directory",
      onChange() {},
    },
    {
      maxWatches: 64,
      honorGitIgnore: false,
      ignoredDirectoryNames: [],
    },
    () => {
      fallbackCalls += 1;
      return preserved;
    },
  );

  assert.equal(fallbackCalls, 1);
  assert.equal(result, preserved);
  assert.equal(poisonedCalls, 0);
  assert.equal(process.report[Symbol.for(REPORT_SHIM_SYMBOL_KEY)], true);
});

test("the adapter preserves Codex policy around the Watchbound engine", async (t) => {
  const root = tempDirectory(t, "watchbound-adapter-git-");
  git(root, ["init", "-q"]);
  writeFile(path.join(root, ".gitignore"), "ignored/\n");
  writeFile(path.join(root, "ignored", "deep", "value"), "ignored");
  writeFile(path.join(root, "node_modules", "package", "value"), "ignored by name");
  writeFile(path.join(root, "visible", "value"), "visible");

  const fake = fakeWatchbound();
  globalThis[MODULE_OVERRIDE_KEY] = fake;
  delete globalThis[ENGINE_KEY];
  t.after(() => {
    delete globalThis[MODULE_OVERRIDE_KEY];
    delete globalThis[ENGINE_KEY];
  });

  const changes = [];
  const options = {
    path: "/logical/worktree",
    recursive: true,
    renameEventHandling: "changed-path-with-parent-directory",
    onChange: (change) => changes.push(change),
  };
  const host = {
    getFileSystemPath: () => root,
    platformPath: async () => path.posix,
  };
  const watcher = await codexLinuxStartDirectoryOnlyWorkingTreeWatch(
    host,
    options,
    {
      maxWatches: 64,
      honorGitIgnore: true,
      ignoredDirectoryNames: ["node_modules"],
    },
  );

  const main = fake.subscriptions.find((subscription) => subscription.root === root);
  assert.ok(main);
  assert.equal(main.options.rootPathPolicy, "resolve-physical");
  assert.equal(main.options.watchLimit, 64);
  assert.deepEqual(main.initialPolicy, {
    prefixes: [""],
    excludedDirectoryNames: [".git", "node_modules"],
    observedExcludedPaths: [],
  });
  assert.ok(main.replacements.some(({ prefixes }) => (
    prefixes.length === 1 && prefixes.includes("ignored")
  )));
  assert.ok(main.replacements.every((replacement) => (
    replacement.excludedDirectoryNames.join("\0") === ".git\0node_modules" &&
    replacement.observedExcludedPaths.join("\0") === ".git"
  )));
  assert.equal(fake.subscriptions.length, 1);
  assert.deepEqual(watcher.coverage, {
    recursive: false,
    typedPathChanges: false,
  });

  const callbackContext = { stop() {} };
  main.callback({
    invalidatedPaths: [path.join(root, "visible", "value")],
    pathEncodingCollapsed: false,
    coverage: { state: "complete" },
    rootState: { attachment: "attached" },
  }, callbackContext);
  assert.deepEqual(changes.at(-1), {
    changedPaths: [
      "/logical/worktree/visible/value",
      "/logical/worktree/visible",
    ],
  });

  const replacementCountBeforeNativeNameEvent = main.replacements.length;
  writeFile(path.join(root, "nested", "node_modules", "value"), "new");
  main.callback({
    invalidatedPaths: [path.join(root, "nested", "node_modules")],
    pathEncodingCollapsed: false,
    coverage: { state: "complete" },
    rootState: { attachment: "attached" },
  }, callbackContext);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(main.replacements.length, replacementCountBeforeNativeNameEvent);

  writeFile(path.join(root, ".gitignore"), "ignored/\nlater/\n");
  writeFile(path.join(root, "later", "value"), "later");
  main.callback({
    invalidatedPaths: [path.join(root, ".gitignore")],
    pathEncodingCollapsed: false,
    coverage: { state: "complete" },
    rootState: { attachment: "attached" },
  }, callbackContext);
  await waitFor(
    () => main.replacements.some(({ prefixes }) => prefixes.includes("later")),
    "Git-ignore exclusion refresh",
  );

  const changeCountBeforeIndex = changes.length;
  writeFile(path.join(root, "tracked"), "tracked");
  git(root, ["add", "tracked"]);
  await waitFor(
    () => changes.slice(changeCountBeforeIndex).some(
      (change) => change.changedPaths.length === 0),
    "Git index refresh outside the Watchbound budget",
  );

  main.callback({
    invalidatedPaths: [root],
    pathEncodingCollapsed: false,
    coverage: { state: "uncertain", reason: "root-replaced" },
    rootState: { attachment: "lost" },
  }, callbackContext);
  assert.deepEqual(changes.at(-1), { changedPaths: [] });
  await waitFor(
    () => main.recoveries.length === 1,
    "explicit root replacement recovery",
    2500,
  );
  assert.deepEqual(main.recoveries[0], {
    identityPolicy: "accept-replacement",
  });

  const closed = watcher.closed;
  await watcher.dispose();
  assert.deepEqual(await closed, { reason: "disposed" });
  assert.ok(fake.subscriptions.every((subscription) => subscription.disposed));
  assert.deepEqual(watcher.codexLinuxDirectoryWatchBudget(), {
    active: 0,
    limit: 64,
  });
});

test("policy work that arrives before subscribe resolves is reconciled afterward", async (t) => {
  const root = tempDirectory(t, "watchbound-early-callback-");
  git(root, ["init", "-q"]);
  writeFile(path.join(root, ".gitignore"), "initial/\n");
  writeFile(path.join(root, "initial", "value"), "initial");
  const coverageMessages = [];
  const originalInfo = console.info;
  console.info = (...args) => coverageMessages.push(args.join(" "));
  t.after(() => {
    console.info = originalInfo;
  });

  const fake = fakeWatchbound({
    beforeSubscribeResolve: ({ callback }) => {
      writeFile(path.join(root, ".gitignore"), "initial/\nlater/\n");
      writeFile(path.join(root, "later", "value"), "later");
      callback({
        invalidatedPaths: [path.join(root, ".gitignore")],
        pathEncodingCollapsed: false,
        coverage: { state: "uncertain", reason: "overflow" },
        rootState: { attachment: "attached" },
      }, { stop() {} });
    },
  });
  globalThis[MODULE_OVERRIDE_KEY] = fake;
  delete globalThis[ENGINE_KEY];
  t.after(() => {
    delete globalThis[MODULE_OVERRIDE_KEY];
    delete globalThis[ENGINE_KEY];
  });

  const watcher = await codexLinuxStartDirectoryOnlyWorkingTreeWatch(
    {
      getFileSystemPath: () => root,
      platformPath: async () => path.posix,
    },
    {
      path: "/logical/early",
      recursive: true,
      renameEventHandling: "changed-path-with-parent-directory",
      onChange() {},
    },
    {
      maxWatches: 64,
      honorGitIgnore: true,
      ignoredDirectoryNames: [],
    },
  );
  const main = fake.subscriptions[0];
  assert.deepEqual(main.initialPolicy, {
    prefixes: [""],
    excludedDirectoryNames: [".git"],
    observedExcludedPaths: [],
  });
  await waitFor(
    () => main.replacements.some(({ prefixes }) => prefixes.includes("later")),
    "latched pre-resolution policy refresh",
  );
  assert.equal(
    coverageMessages.some((message) => message.includes("coverage recovered")),
    true,
  );
  await watcher.dispose();
});

test("policy is recomputed after subscribe even without an establishment callback", async (t) => {
  const root = tempDirectory(t, "watchbound-silent-establishment-");
  git(root, ["init", "-q"]);
  writeFile(path.join(root, ".gitignore"), "initial/\n");
  writeFile(path.join(root, "initial", "value"), "initial");
  const fake = fakeWatchbound({
    beforeSubscribeResolve: () => {
      writeFile(path.join(root, ".gitignore"), "initial/\nlater/\n");
      writeFile(path.join(root, "later", "value"), "later");
    },
  });
  globalThis[MODULE_OVERRIDE_KEY] = fake;
  delete globalThis[ENGINE_KEY];
  t.after(() => {
    delete globalThis[MODULE_OVERRIDE_KEY];
    delete globalThis[ENGINE_KEY];
  });

  const watcher = await codexLinuxStartDirectoryOnlyWorkingTreeWatch(
    {
      getFileSystemPath: () => root,
      platformPath: async () => path.posix,
    },
    {
      path: "/logical/silent-establishment",
      recursive: true,
      renameEventHandling: "changed-path-with-parent-directory",
      onChange() {},
    },
    {
      maxWatches: 64,
      honorGitIgnore: true,
      ignoredDirectoryNames: [],
    },
  );
  const main = fake.subscriptions[0];
  assert.deepEqual(main.initialPolicy, {
    prefixes: [""],
    excludedDirectoryNames: [".git"],
    observedExcludedPaths: [],
  });
  await waitFor(
    () => main.replacements.some(({ prefixes }) => prefixes.includes("later")),
    "unconditional post-arm policy refresh",
  );
  await watcher.dispose();
});

test("recoverable uncertainty uses Watchbound's bounded automatic reconciliation", async (t) => {
  const root = tempDirectory(t, "watchbound-reconcile-");
  const fake = fakeWatchbound();
  globalThis[MODULE_OVERRIDE_KEY] = fake;
  delete globalThis[ENGINE_KEY];
  t.after(() => {
    delete globalThis[MODULE_OVERRIDE_KEY];
    delete globalThis[ENGINE_KEY];
  });
  const watcher = await codexLinuxStartDirectoryOnlyWorkingTreeWatch(
    {
      getFileSystemPath: () => root,
      platformPath: async () => path.posix,
    },
    {
      path: "/logical/reconcile",
      recursive: true,
      renameEventHandling: "changed-path-with-parent-directory",
      onChange() {},
    },
    {
      maxWatches: 64,
      honorGitIgnore: false,
      ignoredDirectoryNames: [],
    },
  );
  const main = fake.subscriptions[0];
  assert.equal(main.options.automaticReconciliation, true);
  main.callback({
    invalidatedPaths: [path.join(root, "visible")],
    pathEncodingCollapsed: false,
    coverage: { state: "uncertain", reason: "consumer-backpressure" },
    rootState: { attachment: "attached" },
  }, { stop() {} });
  main.callback({
    invalidatedPaths: [path.join(root, "also-visible")],
    pathEncodingCollapsed: false,
    coverage: { state: "uncertain", reason: "topology-race" },
    rootState: { attachment: "attached" },
  }, { stop() {} });
  await waitFor(
    () => main.reconciliations.length === 1,
    "coalesced automatic uncertainty reconciliation",
  );
  await watcher.dispose();
});

test("initial partial coverage emits a conservative invalidation", async (t) => {
  const root = tempDirectory(t, "watchbound-initial-partial-");
  const fake = fakeWatchbound({
    replacementCoverage: { state: "partial", reason: "watch-limit" },
    emitReplacementBoundary: true,
  });
  globalThis[MODULE_OVERRIDE_KEY] = fake;
  delete globalThis[ENGINE_KEY];
  t.after(() => {
    delete globalThis[MODULE_OVERRIDE_KEY];
    delete globalThis[ENGINE_KEY];
  });
  const changes = [];
  const watcher = await codexLinuxStartDirectoryOnlyWorkingTreeWatch(
    {
      getFileSystemPath: () => root,
      platformPath: async () => path.posix,
    },
    {
      path: "/logical/initial-partial",
      recursive: true,
      renameEventHandling: "changed-path-with-parent-directory",
      onChange: (change) => changes.push(change),
    },
    {
      maxWatches: 64,
      honorGitIgnore: false,
      ignoredDirectoryNames: [],
    },
  );
  assert.deepEqual(changes, [{ changedPaths: [] }]);
  await watcher.dispose();
});

test("the adapter preserves lexical root components at the Watchbound boundary", async (t) => {
  const parent = tempDirectory(t, "watchbound-lexical-root-");
  const lexicalRoot = `${parent}${path.sep}link${path.sep}..${path.sep}repository`;
  fs.mkdirSync(path.resolve(lexicalRoot), { recursive: true });
  const fake = fakeWatchbound();
  globalThis[MODULE_OVERRIDE_KEY] = fake;
  delete globalThis[ENGINE_KEY];
  t.after(() => {
    delete globalThis[MODULE_OVERRIDE_KEY];
    delete globalThis[ENGINE_KEY];
  });
  const watcher = await codexLinuxStartDirectoryOnlyWorkingTreeWatch(
    {
      getFileSystemPath: () => lexicalRoot,
      platformPath: async () => path.posix,
    },
    {
      path: "/logical/lexical-root",
      recursive: true,
      renameEventHandling: "changed-path-with-parent-directory",
      onChange() {},
    },
    {
      maxWatches: 64,
      honorGitIgnore: false,
      ignoredDirectoryNames: [],
    },
  );
  assert.equal(fake.subscriptions[0].requestedRoot, lexicalRoot);
  assert.equal(fake.subscriptions[0].root, path.resolve(lexicalRoot));
  await watcher.dispose();
});

test("the adapter maps a symlinked workspace from Watchbound's physical namespace", async (t) => {
  const parent = tempDirectory(t, "watchbound-symlink-root-");
  const physicalRoot = path.join(parent, "physical-repository");
  const lexicalRoot = path.join(parent, "repository-link");
  fs.mkdirSync(path.join(physicalRoot, "visible"), { recursive: true });
  fs.symlinkSync(physicalRoot, lexicalRoot);
  const fake = fakeWatchbound();
  globalThis[MODULE_OVERRIDE_KEY] = fake;
  delete globalThis[ENGINE_KEY];
  t.after(() => {
    delete globalThis[MODULE_OVERRIDE_KEY];
    delete globalThis[ENGINE_KEY];
  });
  const changes = [];
  const watcher = await codexLinuxStartDirectoryOnlyWorkingTreeWatch(
    {
      getFileSystemPath: () => lexicalRoot,
      platformPath: async () => path.posix,
    },
    {
      path: "/logical/symlink-root",
      recursive: true,
      renameEventHandling: "changed-path-with-parent-directory",
      onChange: (change) => changes.push(change),
    },
    {
      maxWatches: 64,
      honorGitIgnore: false,
      ignoredDirectoryNames: [],
    },
  );
  const main = fake.subscriptions[0];
  assert.equal(main.requestedRoot, lexicalRoot);
  assert.equal(main.root, physicalRoot);
  assert.equal(main.options.rootPathPolicy, "resolve-physical");
  main.callback({
    invalidatedPaths: [path.join(physicalRoot, "visible", "value")],
    pathEncoding: "complete",
    pathEncodingCollapsed: false,
    coverage: { state: "complete" },
    rootState: { attachment: "attached" },
  }, { stop() {} });
  assert.deepEqual(changes.at(-1), {
    changedPaths: [
      "/logical/symlink-root/visible/value",
      "/logical/symlink-root/visible",
    ],
  });
  await watcher.dispose();
});

test("a qualified root uses Watchbound and disposes without invoking Parcel", async (t) => {
  const root = tempDirectory(t, "watchbound-qualified-route-");
  const fake = fakeWatchbound();
  globalThis[MODULE_OVERRIDE_KEY] = fake;
  delete globalThis[ENGINE_KEY];
  delete globalThis[QUALIFICATION_WARNINGS_KEY];
  t.after(() => {
    delete globalThis[MODULE_OVERRIDE_KEY];
    delete globalThis[ENGINE_KEY];
    delete globalThis[QUALIFICATION_WARNINGS_KEY];
  });
  let fallbackCalls = 0;
  const watcher = await codexLinuxStartDirectoryOnlyWorkingTreeWatch(
    {
      getFileSystemPath: () => root,
      platformPath: async () => path.posix,
    },
    {
      path: "/logical/qualified",
      recursive: true,
      renameEventHandling: "changed-path-with-parent-directory",
      onChange() {},
    },
    {
      maxWatches: 64,
      honorGitIgnore: false,
      ignoredDirectoryNames: [],
    },
    () => {
      fallbackCalls += 1;
      throw new Error("qualified roots must not use Parcel");
    },
  );
  assert.equal(fallbackCalls, 0);
  assert.equal(fake.subscriptions.length, 1);
  await watcher.dispose();
  assert.equal(fake.subscriptions[0].disposed, true);
  assert.equal(fake.subscriptions[0].disposeCalls, 1);
});

test("an unqualified root uses a deduplicated, disposable Parcel fallback", async (t) => {
  const root = tempDirectory(t, "watchbound-unqualified-root-");
  const fake = fakeWatchbound({
    qualifyRoot: () => ({
      schemaVersion: 1,
      state: "unqualified",
      reasons: ["filesystem-overlay"],
      root: {
        physicalPath: root,
        physicalPathBytes: Buffer.from(root),
      },
    }),
  });
  globalThis[MODULE_OVERRIDE_KEY] = fake;
  delete globalThis[ENGINE_KEY];
  delete globalThis[QUALIFICATION_WARNINGS_KEY];
  t.after(() => {
    delete globalThis[MODULE_OVERRIDE_KEY];
    delete globalThis[ENGINE_KEY];
    delete globalThis[QUALIFICATION_WARNINGS_KEY];
  });
  let fallbackCalls = 0;
  let fallbackDisposals = 0;
  const fallback = () => {
    fallbackCalls += 1;
    return {
      coverage: { recursive: true, typedPathChanges: true },
      path: "/logical/unqualified",
      closed: Promise.resolve({ reason: "disposed" }),
      dispose: async () => {
        fallbackDisposals += 1;
      },
    };
  };
  const warnings = [];
  const originalWarn = console.warn;
  console.warn = (...args) => warnings.push(args.map(String).join(" "));
  let watchers;
  try {
    watchers = await Promise.all([0, 1].map(() =>
      codexLinuxStartDirectoryOnlyWorkingTreeWatch(
        {
          getFileSystemPath: () => root,
          platformPath: async () => path.posix,
        },
        {
          path: "/logical/unqualified",
          recursive: true,
          renameEventHandling: "changed-path-with-parent-directory",
          onChange() {},
        },
        {
          maxWatches: 64,
          honorGitIgnore: false,
          ignoredDirectoryNames: [],
        },
        fallback,
      )
    ));
  } finally {
    console.warn = originalWarn;
  }
  assert.equal(fallbackCalls, 2);
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /root is unqualified.*filesystem-overlay.*Parcel watcher/u);
  assert.equal(fake.subscriptions.length, 0);
  assert.equal(globalThis[ENGINE_KEY], undefined);
  await Promise.all(watchers.map((watcher) => watcher.dispose()));
  assert.equal(fallbackDisposals, 2);
});

test("unknown qualification retries with bounded backoff and can recover", async (t) => {
  const root = tempDirectory(t, "watchbound-unknown-recovery-");
  let qualificationCalls = 0;
  const fake = fakeWatchbound({
    qualificationRetryDelays: [0, 0, 0],
    qualifyRoot: (candidate) => {
      qualificationCalls += 1;
      if (qualificationCalls < 3) {
        return {
          schemaVersion: 1,
          state: "unknown",
          reasons: ["container-unknown"],
          root: { physicalPath: candidate, physicalPathBytes: Buffer.from(candidate) },
        };
      }
      return {
        schemaVersion: 1,
        state: "qualified",
        reasons: [],
        root: { physicalPath: candidate, physicalPathBytes: Buffer.from(candidate) },
      };
    },
  });
  globalThis[MODULE_OVERRIDE_KEY] = fake;
  delete globalThis[ENGINE_KEY];
  delete globalThis[QUALIFICATION_WARNINGS_KEY];
  t.after(() => {
    delete globalThis[MODULE_OVERRIDE_KEY];
    delete globalThis[ENGINE_KEY];
    delete globalThis[QUALIFICATION_WARNINGS_KEY];
  });
  let fallbackCalls = 0;
  const watcher = await codexLinuxStartDirectoryOnlyWorkingTreeWatch(
    {
      getFileSystemPath: () => root,
      platformPath: async () => path.posix,
    },
    {
      path: "/logical/recovered",
      recursive: true,
      renameEventHandling: "changed-path-with-parent-directory",
      onChange() {},
    },
    {
      maxWatches: 64,
      honorGitIgnore: false,
      ignoredDirectoryNames: [],
    },
    () => {
      fallbackCalls += 1;
      throw new Error("a recovered root must not use Parcel");
    },
  );
  assert.equal(qualificationCalls, 3);
  assert.equal(fallbackCalls, 0);
  assert.equal(fake.subscriptions.length, 1);
  assert.equal(globalThis[QUALIFICATION_WARNINGS_KEY], undefined);
  await watcher.dispose();
  assert.equal(fake.subscriptions[0].disposed, true);
});

test("persistently unknown qualification falls back without creating Watchbound state", async (t) => {
  const root = tempDirectory(t, "watchbound-unknown-fallback-");
  let qualificationCalls = 0;
  const fake = fakeWatchbound({
    qualificationRetryDelays: [0, 0],
    qualifyRoot: (candidate) => {
      qualificationCalls += 1;
      return {
        schemaVersion: 1,
        state: "unknown",
        reasons: ["container-unknown"],
        root: { physicalPath: candidate, physicalPathBytes: Buffer.from(candidate) },
      };
    },
  });
  globalThis[MODULE_OVERRIDE_KEY] = fake;
  delete globalThis[ENGINE_KEY];
  delete globalThis[QUALIFICATION_WARNINGS_KEY];
  t.after(() => {
    delete globalThis[MODULE_OVERRIDE_KEY];
    delete globalThis[ENGINE_KEY];
    delete globalThis[QUALIFICATION_WARNINGS_KEY];
  });
  let fallbackDisposals = 0;
  const warnings = [];
  const originalWarn = console.warn;
  console.warn = (...args) => warnings.push(args.map(String).join(" "));
  let watcher;
  try {
    watcher = await codexLinuxStartDirectoryOnlyWorkingTreeWatch(
      {
        getFileSystemPath: () => root,
        platformPath: async () => path.posix,
      },
      {
        path: "/logical/unknown",
        recursive: true,
        renameEventHandling: "changed-path-with-parent-directory",
        onChange() {},
      },
      {
        maxWatches: 64,
        honorGitIgnore: false,
        ignoredDirectoryNames: [],
      },
      () => ({
        coverage: { recursive: true, typedPathChanges: true },
        path: "/logical/unknown",
        closed: Promise.resolve({ reason: "disposed" }),
        dispose: async () => {
          fallbackDisposals += 1;
        },
      }),
    );
  } finally {
    console.warn = originalWarn;
  }
  assert.equal(qualificationCalls, 3);
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /root is unknown after 2 bounded retries.*container-unknown/u);
  assert.equal(fake.subscriptions.length, 0);
  assert.equal(globalThis[ENGINE_KEY], undefined);
  await watcher.dispose();
  assert.equal(fallbackDisposals, 1);
});

test("the adapter rejects a root alias that changes after qualification", async (t) => {
  const parent = tempDirectory(t, "watchbound-root-qualification-race-");
  const qualifiedRoot = path.join(parent, "qualified");
  const resolvedRoot = path.join(parent, "resolved");
  fs.mkdirSync(qualifiedRoot);
  fs.mkdirSync(resolvedRoot);
  const fake = fakeWatchbound({
    qualificationPhysicalRoot: qualifiedRoot,
    resolvedPhysicalRoot: resolvedRoot,
  });
  globalThis[MODULE_OVERRIDE_KEY] = fake;
  delete globalThis[ENGINE_KEY];
  t.after(() => {
    delete globalThis[MODULE_OVERRIDE_KEY];
    delete globalThis[ENGINE_KEY];
  });
  await assert.rejects(
    codexLinuxStartDirectoryOnlyWorkingTreeWatch(
      {
        getFileSystemPath: () => path.join(parent, "alias"),
        platformPath: async () => path.posix,
      },
      {
        path: "/logical/qualification-race",
        recursive: true,
        renameEventHandling: "changed-path-with-parent-directory",
        onChange() {},
      },
      {
        maxWatches: 64,
        honorGitIgnore: false,
        ignoredDirectoryNames: [],
      },
    ),
    /could not verify its qualified physical root/u,
  );
  assert.equal(fake.subscriptions.length, 1);
  assert.equal(fake.subscriptions[0].disposed, true);
  assert.equal(fake.subscriptions[0].disposeCalls, 1);
});

test("the adapter rejects a physical root that cannot be represented as a Node path", async (t) => {
  const root = tempDirectory(t, "watchbound-non-utf8-root-");
  const fake = fakeWatchbound({ resolvedPhysicalPath: null });
  globalThis[MODULE_OVERRIDE_KEY] = fake;
  delete globalThis[ENGINE_KEY];
  t.after(() => {
    delete globalThis[MODULE_OVERRIDE_KEY];
    delete globalThis[ENGINE_KEY];
  });
  await assert.rejects(
    codexLinuxStartDirectoryOnlyWorkingTreeWatch(
      {
        getFileSystemPath: () => root,
        platformPath: async () => path.posix,
      },
      {
        path: "/logical/non-utf8",
        recursive: true,
        renameEventHandling: "changed-path-with-parent-directory",
        onChange() {},
      },
      {
        maxWatches: 64,
        honorGitIgnore: false,
        ignoredDirectoryNames: [],
      },
    ),
    /could not verify its qualified physical root/u,
  );
  assert.equal(fake.subscriptions[0].disposed, true);
  assert.equal(fake.subscriptions[0].disposeCalls, 1);
});

test("staged policy conflicts fail establishment before returning excluded coverage", async (t) => {
  const root = tempDirectory(t, "watchbound-staged-policy-conflict-");
  const changes = [];
  let attempts = 0;
  const fake = fakeWatchbound({
    replaceExclusions: ({ generation, policy, subscription }) => {
      attempts += 1;
      if (attempts === 1) subscription.rootState = { attachment: "lost" };
      if (subscription.rootState.attachment !== "attached") {
        throw Object.assign(new Error("root changed during policy replacement"), {
          code: "WATCHBOUND_ROOT_STATE_CONFLICT",
        });
      }
      subscription.exclusionGeneration = generation;
      subscription.policy = policy;
      subscription.replacements.push({ generation, policy, ...policy });
      return { state: "complete" };
    },
  });
  globalThis[MODULE_OVERRIDE_KEY] = fake;
  delete globalThis[ENGINE_KEY];
  t.after(() => {
    delete globalThis[MODULE_OVERRIDE_KEY];
    delete globalThis[ENGINE_KEY];
  });
  await assert.rejects(
    codexLinuxStartDirectoryOnlyWorkingTreeWatch(
      {
        getFileSystemPath: () => root,
        platformPath: async () => path.posix,
      },
      {
        path: "/logical/staged-policy-conflict",
        recursive: true,
        renameEventHandling: "changed-path-with-parent-directory",
        onChange: (change) => changes.push(change),
      },
      {
        maxWatches: 64,
        honorGitIgnore: false,
        ignoredDirectoryNames: [],
      },
    ),
    (error) => {
      assert.match(error.message, /could not replace generation-zero exclusions/u);
      assert.equal(error.cause?.code, "WATCHBOUND_ROOT_STATE_CONFLICT");
      return true;
    },
  );
  const main = fake.subscriptions[0];
  assert.equal(attempts, 2);
  assert.equal(main.disposed, true);
  assert.deepEqual(main.policy.prefixes, [""]);
  assert.equal(main.replacements.length, 0);
  assert.equal(main.recoveries.length, 0);
  assert.ok(changes.some(({ changedPaths }) => changedPaths.length === 0));
});

test("retryable policy failures cannot return a generation-zero watcher", async (t) => {
  const root = tempDirectory(t, "watchbound-retryable-startup-policy-");
  let attempts = 0;
  const fake = fakeWatchbound({
    replaceExclusions: () => {
      attempts += 1;
      throw Object.assign(new Error("Watchbound resources unavailable"), {
        code: "WATCHBOUND_RESOURCE_UNAVAILABLE",
        retryable: true,
      });
    },
  });
  globalThis[MODULE_OVERRIDE_KEY] = fake;
  delete globalThis[ENGINE_KEY];
  t.after(() => {
    delete globalThis[MODULE_OVERRIDE_KEY];
    delete globalThis[ENGINE_KEY];
  });

  await assert.rejects(
    codexLinuxStartDirectoryOnlyWorkingTreeWatch(
      {
        getFileSystemPath: () => root,
        platformPath: async () => path.posix,
      },
      {
        path: "/logical/retryable-startup-policy",
        recursive: true,
        renameEventHandling: "changed-path-with-parent-directory",
        onChange() {},
      },
      {
        maxWatches: 64,
        honorGitIgnore: false,
        ignoredDirectoryNames: [],
      },
    ),
    (error) => {
      assert.match(error.message, /could not replace generation-zero exclusions/u);
      assert.equal(error.cause?.code, "WATCHBOUND_RESOURCE_UNAVAILABLE");
      return true;
    },
  );
  const main = fake.subscriptions[0];
  assert.equal(attempts, 2);
  assert.equal(main.disposed, true);
  assert.deepEqual(main.policy.prefixes, [""]);
  assert.equal(main.replacements.length, 0);
});


test("non-executable Git failures do not create an endless policy retry", async (t) => {
  const root = tempDirectory(t, "watchbound-git-enoent-");
  git(root, ["init", "-q"]);
  const originalExecFile = childProcess.execFile;
  let ignoredQueryCalls = 0;
  childProcess.execFile = (file, args, options, callback) => {
    if (file === "git" && args.includes("ls-files")) {
      ignoredQueryCalls += 1;
      setImmediate(() => callback(Object.assign(new Error("git is unavailable"), {
        code: "ENOENT",
      }), ""));
      return { kill() {} };
    }
    return originalExecFile(file, args, options, callback);
  };
  t.after(() => {
    childProcess.execFile = originalExecFile;
  });
  const fake = fakeWatchbound();
  globalThis[MODULE_OVERRIDE_KEY] = fake;
  delete globalThis[ENGINE_KEY];
  t.after(() => {
    delete globalThis[MODULE_OVERRIDE_KEY];
    delete globalThis[ENGINE_KEY];
  });
  const watcher = await codexLinuxStartDirectoryOnlyWorkingTreeWatch(
    {
      getFileSystemPath: () => root,
      platformPath: async () => path.posix,
    },
    {
      path: "/logical/git-enoent",
      recursive: true,
      renameEventHandling: "changed-path-with-parent-directory",
      onChange() {},
    },
    {
      maxWatches: 64,
      honorGitIgnore: true,
      ignoredDirectoryNames: [],
    },
  );
  const startupQueryCalls = ignoredQueryCalls;
  assert.equal(startupQueryCalls, 2);
  await new Promise((resolve) => setTimeout(resolve, 1200));
  assert.equal(ignoredQueryCalls, startupQueryCalls);
  await watcher.dispose();
});

test("non-executable check-ignore failures do not create an endless policy retry", async (t) => {
  const root = tempDirectory(t, "watchbound-check-ignore-enoent-");
  git(root, ["init", "-q"]);
  const originalExecFile = childProcess.execFile;
  let checkIgnoreCalls = 0;
  childProcess.execFile = (file, args, options, callback) => {
    if (file === "git" && args.includes("ls-files")) {
      setImmediate(() => callback(null, "ignored/\0"));
      return { kill() {} };
    }
    if (file === "git" && args.includes("check-ignore")) {
      checkIgnoreCalls += 1;
      setImmediate(() => callback(Object.assign(new Error("git is unavailable"), {
        code: "ENOENT",
      }), ""));
      return { kill() {} };
    }
    return originalExecFile(file, args, options, callback);
  };
  t.after(() => {
    childProcess.execFile = originalExecFile;
  });
  const fake = fakeWatchbound();
  globalThis[MODULE_OVERRIDE_KEY] = fake;
  delete globalThis[ENGINE_KEY];
  t.after(() => {
    delete globalThis[MODULE_OVERRIDE_KEY];
    delete globalThis[ENGINE_KEY];
  });
  const watcher = await codexLinuxStartDirectoryOnlyWorkingTreeWatch(
    {
      getFileSystemPath: () => root,
      platformPath: async () => path.posix,
    },
    {
      path: "/logical/check-ignore-enoent",
      recursive: true,
      renameEventHandling: "changed-path-with-parent-directory",
      onChange() {},
    },
    {
      maxWatches: 64,
      honorGitIgnore: true,
      ignoredDirectoryNames: [],
    },
  );
  const startupQueryCalls = checkIgnoreCalls;
  assert.equal(startupQueryCalls, 2);
  await new Promise((resolve) => setTimeout(resolve, 1200));
  assert.equal(checkIgnoreCalls, startupQueryCalls);
  await watcher.dispose();
});

test("definitive Git failure retires stale policy without dropping metadata watches", async (t) => {
  const root = tempDirectory(t, "watchbound-git-stale-policy-");
  fs.mkdirSync(path.join(root, ".git", "info"), { recursive: true });
  writeFile(path.join(root, ".git", "index"), "index");
  writeFile(path.join(root, ".git", "info", "exclude"), "");
  writeFile(path.join(root, ".gitignore"), "ignored/\n");
  writeFile(path.join(root, "ignored", "value"), "ignored");
  const originalExecFile = childProcess.execFile;
  let gitAvailable = true;
  let failedGitCalls = 0;
  childProcess.execFile = (file, args, options, callback) => {
    if (file !== "git") return originalExecFile(file, args, options, callback);
    if (!gitAvailable) {
      failedGitCalls += 1;
      setImmediate(() => callback(Object.assign(new Error("git is unavailable"), {
        code: "ENOENT",
      }), ""));
      return { kill() {} };
    }
    if (args.includes("ls-files")) {
      setImmediate(() => callback(null, "ignored/\0"));
      return { kill() {} };
    }
    if (args.includes("check-ignore")) {
      setImmediate(() => callback(null, "ignored/\n"));
      return { kill() {} };
    }
    if (args.includes("rev-parse")) {
      const gitPath = args.at(-1);
      setImmediate(() => callback(null, `${path.join(root, ".git", gitPath)}\n`));
      return { kill() {} };
    }
    throw new Error(`unexpected Git fixture command: ${args.join(" ")}`);
  };
  t.after(() => {
    childProcess.execFile = originalExecFile;
  });
  const originalWatch = fs.watch;
  const metadataWatches = [];
  fs.watch = (directory, options, callback) => {
    const watcher = new (require("node:events").EventEmitter)();
    const entry = { callback, closed: false, directory, options };
    watcher.close = () => { entry.closed = true; };
    metadataWatches.push(entry);
    return watcher;
  };
  t.after(() => {
    fs.watch = originalWatch;
  });
  const fake = fakeWatchbound();
  globalThis[MODULE_OVERRIDE_KEY] = fake;
  delete globalThis[ENGINE_KEY];
  t.after(() => {
    delete globalThis[MODULE_OVERRIDE_KEY];
    delete globalThis[ENGINE_KEY];
  });
  const watcher = await codexLinuxStartDirectoryOnlyWorkingTreeWatch(
    {
      getFileSystemPath: () => root,
      platformPath: async () => path.posix,
    },
    {
      path: "/logical/git-stale-policy",
      recursive: true,
      renameEventHandling: "changed-path-with-parent-directory",
      onChange() {},
    },
    {
      maxWatches: 64,
      honorGitIgnore: true,
      ignoredDirectoryNames: [],
    },
  );
  const main = fake.subscriptions[0];
  assert.ok(main.replacements.at(-1).prefixes.includes("ignored"));
  assert.equal(metadataWatches.length, 2);

  gitAvailable = false;
  writeFile(path.join(root, ".gitignore"), "");
  const replacementCount = main.replacements.length;
  main.callback({
    invalidatedPaths: [path.join(root, ".gitignore")],
    pathEncodingCollapsed: false,
    coverage: { state: "complete" },
    rootState: { attachment: "attached" },
  }, { stop() {} });

  await waitFor(
    () => (
      main.replacements.length > replacementCount &&
      !main.replacements.at(-1).prefixes.includes("ignored")
    ),
    "stale Git policy retirement",
    2500,
  );
  assert.ok(failedGitCalls >= 3);
  assert.equal(metadataWatches.length, 2);
  assert.equal(metadataWatches.some(({ closed }) => closed), false);
  await watcher.dispose();
  assert.equal(metadataWatches.every(({ closed }) => closed), true);
});

async function assertNumericGitFailureRetiresStalePolicy(t, failurePhase) {
  const root = tempDirectory(t, `watchbound-git-exit-128-${failurePhase}-`);
  fs.mkdirSync(path.join(root, ".git", "info"), { recursive: true });
  writeFile(path.join(root, ".git", "index"), "index");
  writeFile(path.join(root, ".git", "info", "exclude"), "");
  writeFile(path.join(root, ".gitignore"), "ignored/\n");
  writeFile(path.join(root, "ignored", "value"), "ignored");

  const originalExecFile = childProcess.execFile;
  let activeFailurePhase = null;
  let failedGitCalls = 0;
  childProcess.execFile = (file, args, options, callback) => {
    if (file !== "git") return originalExecFile(file, args, options, callback);
    if (args.includes("ls-files")) {
      if (activeFailurePhase === "ls-files") {
        failedGitCalls += 1;
        setImmediate(() => callback(Object.assign(new Error("fatal Git failure"), {
          code: 128,
        }), ""));
      } else {
        setImmediate(() => callback(null, "ignored/\0"));
      }
      return { kill() {} };
    }
    if (args.includes("check-ignore")) {
      if (activeFailurePhase === "check-ignore") {
        failedGitCalls += 1;
        setImmediate(() => callback(Object.assign(new Error("fatal Git failure"), {
          code: 128,
        }), ""));
      } else {
        setImmediate(() => callback(null, "ignored/\n"));
      }
      return { kill() {} };
    }
    if (args.includes("rev-parse")) {
      const gitPath = args.at(-1);
      setImmediate(() => callback(null, `${path.join(root, ".git", gitPath)}\n`));
      return { kill() {} };
    }
    throw new Error(`unexpected Git fixture command: ${args.join(" ")}`);
  };
  t.after(() => {
    childProcess.execFile = originalExecFile;
  });

  const fake = fakeWatchbound();
  globalThis[MODULE_OVERRIDE_KEY] = fake;
  delete globalThis[ENGINE_KEY];
  t.after(() => {
    delete globalThis[MODULE_OVERRIDE_KEY];
    delete globalThis[ENGINE_KEY];
  });

  const watcher = await codexLinuxStartDirectoryOnlyWorkingTreeWatch(
    {
      getFileSystemPath: () => root,
      platformPath: async () => path.posix,
    },
    {
      path: `/logical/git-exit-128-${failurePhase}`,
      recursive: true,
      renameEventHandling: "changed-path-with-parent-directory",
      onChange() {},
    },
    {
      maxWatches: 64,
      honorGitIgnore: true,
      ignoredDirectoryNames: [],
    },
  );
  t.after(() => watcher.dispose());
  const main = fake.subscriptions[0];
  assert.ok(main.replacements.at(-1).prefixes.includes("ignored"));

  activeFailurePhase = failurePhase;
  const replacementCount = main.replacements.length;
  main.callback({
    invalidatedPaths: [path.join(root, ".gitignore")],
    pathEncodingCollapsed: false,
    coverage: { state: "complete" },
    rootState: { attachment: "attached" },
  }, { stop() {} });

  await waitFor(() => failedGitCalls > 0, `${failurePhase} numeric Git failure`);
  await waitFor(
    () => (
      main.replacements.length > replacementCount &&
      !main.replacements.at(-1).prefixes.includes("ignored")
    ),
    `${failurePhase} stale Git policy retirement`,
  );
  const callsAfterRetirement = failedGitCalls;
  await new Promise((resolve) => setTimeout(resolve, 1200));
  assert.equal(failedGitCalls, callsAfterRetirement);
}

test("numeric ls-files failures retire stale Git policy", async (t) => {
  await assertNumericGitFailureRetiresStalePolicy(t, "ls-files");
});

test("numeric check-ignore failures retire stale Git policy", async (t) => {
  await assertNumericGitFailureRetiresStalePolicy(t, "check-ignore");
});

test("slow Git policy queries continue across bounded policy passes", async (t) => {
  const root = tempDirectory(t, "watchbound-slow-git-policy-");
  git(root, ["init", "-q"]);
  const originalExecFile = childProcess.execFile;
  let ignoredQueryCalls = 0;
  let checkIgnoreCalls = 0;
  childProcess.execFile = (file, args, options, callback) => {
    if (file === "git" && args.includes("ls-files")) {
      ignoredQueryCalls += 1;
      setTimeout(() => callback(null, "ignored/\0"), 1200);
      return { kill() {} };
    }
    if (file === "git" && args.includes("check-ignore")) {
      checkIgnoreCalls += 1;
      setImmediate(() => callback(null, "ignored/\n"));
      return { kill() {} };
    }
    return originalExecFile(file, args, options, callback);
  };
  t.after(() => {
    childProcess.execFile = originalExecFile;
  });
  const fake = fakeWatchbound();
  globalThis[MODULE_OVERRIDE_KEY] = fake;
  delete globalThis[ENGINE_KEY];
  t.after(() => {
    delete globalThis[MODULE_OVERRIDE_KEY];
    delete globalThis[ENGINE_KEY];
  });
  const watcher = await codexLinuxStartDirectoryOnlyWorkingTreeWatch(
    {
      getFileSystemPath: () => root,
      platformPath: async () => path.posix,
    },
    {
      path: "/logical/slow-git-policy",
      recursive: true,
      renameEventHandling: "changed-path-with-parent-directory",
      onChange() {},
    },
    {
      maxWatches: 64,
      honorGitIgnore: true,
      ignoredDirectoryNames: [],
    },
  );
  const main = fake.subscriptions[0];
  await waitFor(
    () => main.replacements.some(({ prefixes }) => prefixes.includes("ignored")),
    "slow Git policy completion",
    3500,
  );
  // The second establishment snapshot deliberately discards any older query;
  // its own deadline retry must then resume that same second query.
  assert.equal(ignoredQueryCalls, 2);
  assert.equal(checkIgnoreCalls, 1);
  await watcher.dispose();
});

test("new Git policy events discard stale in-flight query snapshots", async (t) => {
  const root = tempDirectory(t, "watchbound-stale-git-policy-");
  git(root, ["init", "-q"]);
  const fake = fakeWatchbound();
  globalThis[MODULE_OVERRIDE_KEY] = fake;
  delete globalThis[ENGINE_KEY];
  t.after(() => {
    delete globalThis[MODULE_OVERRIDE_KEY];
    delete globalThis[ENGINE_KEY];
  });
  const watcher = await codexLinuxStartDirectoryOnlyWorkingTreeWatch(
    {
      getFileSystemPath: () => root,
      platformPath: async () => path.posix,
    },
    {
      path: "/logical/stale-git-policy",
      recursive: true,
      renameEventHandling: "changed-path-with-parent-directory",
      onChange() {},
    },
    {
      maxWatches: 64,
      honorGitIgnore: true,
      ignoredDirectoryNames: [],
    },
  );
  const originalExecFile = childProcess.execFile;
  let ignoredQueryCalls = 0;
  let staleQueryAborted = false;
  let resolveFirstQuery;
  const firstQueryStarted = new Promise((resolve) => {
    resolveFirstQuery = resolve;
  });
  childProcess.execFile = (file, args, options, callback) => {
    if (file === "git" && args.includes("ls-files")) {
      ignoredQueryCalls += 1;
      if (ignoredQueryCalls === 1) {
        resolveFirstQuery();
        let settled = false;
        const finish = (error, stdout) => {
          if (settled) return;
          settled = true;
          callback(error, stdout);
        };
        const timer = setTimeout(() => finish(null, "old/\0"), 1200);
        options.signal.addEventListener("abort", () => {
          staleQueryAborted = true;
          clearTimeout(timer);
          finish(Object.assign(new Error("query aborted"), { code: "ABORT_ERR" }), "");
        }, { once: true });
        return { kill: () => finish(null, "") };
      }
      setImmediate(() => callback(null, "new/\0"));
      return { kill() {} };
    }
    if (file === "git" && args.includes("check-ignore")) {
      const separator = args.indexOf("--");
      const stdout = `${args.slice(separator + 1).join("\n")}\n`;
      setImmediate(() => callback(null, stdout));
      return { kill() {} };
    }
    return originalExecFile(file, args, options, callback);
  };
  t.after(() => {
    childProcess.execFile = originalExecFile;
  });

  const main = fake.subscriptions[0];
  main.callback({
    invalidatedPaths: [path.join(root, ".gitignore")],
    pathEncodingCollapsed: false,
    coverage: { state: "complete" },
    rootState: { attachment: "attached" },
  }, { stop() {} });
  await firstQueryStarted;
  main.callback({
    invalidatedPaths: [path.join(root, ".gitignore")],
    pathEncodingCollapsed: false,
    coverage: { state: "complete" },
    rootState: { attachment: "attached" },
  }, { stop() {} });
  await waitFor(
    () => main.replacements.some(({ prefixes }) => prefixes.includes("new")),
    "fresh Git policy after the newer event",
    3500,
  );
  await waitFor(
    () => ignoredQueryCalls >= 3,
    "queued Git policy follow-up",
    3500,
  );
  const latest = main.replacements.at(-1).prefixes;
  // The second event cancels the first query, forces an immediate fresh query,
  // and retains its own queued conservative follow-up snapshot.
  assert.equal(ignoredQueryCalls, 3);
  assert.equal(staleQueryAborted, true);
  assert.ok(latest.includes("new"));
  assert.ok(!latest.includes("old"));
  await watcher.dispose();
});

test("removing repository metadata retires the last complete Git exclusions", async (t) => {
  const root = tempDirectory(t, "watchbound-removed-git-metadata-");
  git(root, ["init", "-q"]);
  writeFile(path.join(root, ".gitignore"), "ignored/\n");
  writeFile(path.join(root, "ignored", "value"), "ignored");
  const fake = fakeWatchbound();
  globalThis[MODULE_OVERRIDE_KEY] = fake;
  delete globalThis[ENGINE_KEY];
  t.after(() => {
    delete globalThis[MODULE_OVERRIDE_KEY];
    delete globalThis[ENGINE_KEY];
  });
  const watcher = await codexLinuxStartDirectoryOnlyWorkingTreeWatch(
    {
      getFileSystemPath: () => root,
      platformPath: async () => path.posix,
    },
    {
      path: "/logical/removed-git-metadata",
      recursive: true,
      renameEventHandling: "changed-path-with-parent-directory",
      onChange() {},
    },
    {
      maxWatches: 64,
      honorGitIgnore: true,
      ignoredDirectoryNames: [],
    },
  );
  const main = fake.subscriptions[0];
  assert.ok(main.replacements.at(-1).prefixes.includes("ignored"));
  const replacementCount = main.replacements.length;
  fs.rmSync(path.join(root, ".git"), { recursive: true, force: true });
  main.callback({
    invalidatedPaths: [path.join(root, ".git")],
    pathEncodingCollapsed: false,
    coverage: { state: "complete" },
    rootState: { attachment: "attached" },
  }, { stop() {} });
  await waitFor(
    () => (
      main.replacements.length > replacementCount &&
      !main.replacements.at(-1).prefixes.includes("ignored")
    ),
    "Git exclusions to retire after metadata removal",
    2500,
  );
  assert.deepEqual(main.replacements.at(-1).prefixes, []);
  assert.deepEqual(main.replacements.at(-1).excludedDirectoryNames, [".git"]);
  assert.deepEqual(main.replacements.at(-1).observedExcludedPaths, [".git"]);
  await watcher.dispose();
});

test("repository metadata probe errors preserve the last complete Git exclusions", async (t) => {
  const root = tempDirectory(t, "watchbound-unknown-git-metadata-");
  git(root, ["init", "-q"]);
  writeFile(path.join(root, ".gitignore"), "ignored/\n");
  writeFile(path.join(root, "ignored", "value"), "ignored");
  const fake = fakeWatchbound();
  globalThis[MODULE_OVERRIDE_KEY] = fake;
  delete globalThis[ENGINE_KEY];
  t.after(() => {
    delete globalThis[MODULE_OVERRIDE_KEY];
    delete globalThis[ENGINE_KEY];
  });
  const watcher = await codexLinuxStartDirectoryOnlyWorkingTreeWatch(
    {
      getFileSystemPath: () => root,
      platformPath: async () => path.posix,
    },
    {
      path: "/logical/unknown-git-metadata",
      recursive: true,
      renameEventHandling: "changed-path-with-parent-directory",
      onChange() {},
    },
    {
      maxWatches: 64,
      honorGitIgnore: true,
      ignoredDirectoryNames: [],
    },
  );
  const main = fake.subscriptions[0];
  assert.ok(main.replacements.at(-1).prefixes.includes("ignored"));

  const originalExecFile = childProcess.execFile;
  const originalLstatSync = fs.lstatSync;
  let ignoredQueryCalls = 0;
  childProcess.execFile = (file, args, options, callback) => {
    if (file === "git" && args.includes("ls-files")) {
      ignoredQueryCalls += 1;
      setImmediate(() => callback(Object.assign(new Error("git unavailable"), {
        code: "ENOENT",
      }), ""));
      return { kill() {} };
    }
    return originalExecFile(file, args, options, callback);
  };
  fs.lstatSync = (candidate, options) => {
    if (path.resolve(candidate) === path.join(root, ".git")) {
      throw Object.assign(new Error("metadata probe denied"), { code: "EACCES" });
    }
    return originalLstatSync(candidate, options);
  };
  t.after(() => {
    childProcess.execFile = originalExecFile;
    fs.lstatSync = originalLstatSync;
  });

  main.callback({
    invalidatedPaths: [path.join(root, ".gitignore")],
    pathEncodingCollapsed: false,
    coverage: { state: "complete" },
    rootState: { attachment: "attached" },
  }, { stop() {} });
  await waitFor(() => ignoredQueryCalls >= 2, "unknown Git metadata retry", 2500);
  assert.ok(main.replacements.at(-1).prefixes.includes("ignored"));
  await watcher.dispose();
});

test("check-ignore chunk cursors resume across bounded policy deadlines", async (t) => {
  const root = tempDirectory(t, "watchbound-chunked-git-policy-");
  git(root, ["init", "-q"]);
  const fake = fakeWatchbound();
  globalThis[MODULE_OVERRIDE_KEY] = fake;
  delete globalThis[ENGINE_KEY];
  t.after(() => {
    delete globalThis[MODULE_OVERRIDE_KEY];
    delete globalThis[ENGINE_KEY];
  });
  const watcher = await codexLinuxStartDirectoryOnlyWorkingTreeWatch(
    {
      getFileSystemPath: () => root,
      platformPath: async () => path.posix,
    },
    {
      path: "/logical/chunked-git-policy",
      recursive: true,
      renameEventHandling: "changed-path-with-parent-directory",
      onChange() {},
    },
    {
      maxWatches: 64,
      honorGitIgnore: true,
      ignoredDirectoryNames: [],
    },
  );

  const candidates = Array.from({ length: 3000 }, (_, index) => (
    `ignored-${String(index).padStart(5, "0")}-directory/`
  ));
  const originalExecFile = childProcess.execFile;
  let ignoredQueryCalls = 0;
  const checkedCandidates = [];
  childProcess.execFile = (file, args, options, callback) => {
    if (file === "git" && args.includes("ls-files")) {
      ignoredQueryCalls += 1;
      setImmediate(() => callback(null, `${candidates.join("\0")}\0`));
      return { kill() {} };
    }
    if (file === "git" && args.includes("check-ignore")) {
      const separator = args.indexOf("--");
      const chunk = args.slice(separator + 1);
      checkedCandidates.push(...chunk);
      const finish = () => callback(null, `${chunk.join("\n")}\n`);
      if (checkedCandidates.length === chunk.length) setTimeout(finish, 1200);
      else setImmediate(finish);
      return { kill() {} };
    }
    return originalExecFile(file, args, options, callback);
  };
  t.after(() => {
    childProcess.execFile = originalExecFile;
  });

  const main = fake.subscriptions[0];
  main.callback({
    invalidatedPaths: [path.join(root, ".gitignore")],
    pathEncodingCollapsed: false,
    coverage: { state: "complete" },
    rootState: { attachment: "attached" },
  }, { stop() {} });
  await waitFor(
    () => main.replacements.at(-1).prefixes.includes(candidates.at(-1).slice(0, -1)),
    "all chunked Git exclusions",
    4000,
  );
  assert.equal(ignoredQueryCalls, 1);
  assert.deepEqual(checkedCandidates, candidates);
  await watcher.dispose();
});

test("disposal joins cancelled Git query work after starting native teardown", async (t) => {
  const root = tempDirectory(t, "watchbound-dispose-git-query-");
  git(root, ["init", "-q"]);
  const fake = fakeWatchbound();
  globalThis[MODULE_OVERRIDE_KEY] = fake;
  delete globalThis[ENGINE_KEY];
  t.after(() => {
    delete globalThis[MODULE_OVERRIDE_KEY];
    delete globalThis[ENGINE_KEY];
  });
  const watcher = await codexLinuxStartDirectoryOnlyWorkingTreeWatch(
    {
      getFileSystemPath: () => root,
      platformPath: async () => path.posix,
    },
    {
      path: "/logical/dispose-git-query",
      recursive: true,
      renameEventHandling: "changed-path-with-parent-directory",
      onChange() {},
    },
    {
      maxWatches: 64,
      honorGitIgnore: true,
      ignoredDirectoryNames: [],
    },
  );

  const originalExecFile = childProcess.execFile;
  let queryAborted = false;
  let resolveQueryStarted;
  let finishQuery;
  const queryStarted = new Promise((resolve) => {
    resolveQueryStarted = resolve;
  });
  childProcess.execFile = (file, args, options, callback) => {
    if (file === "git" && args.includes("ls-files")) {
      finishQuery = () => callback(
        Object.assign(new Error("query aborted"), { code: "ABORT_ERR" }),
        "",
      );
      options.signal.addEventListener("abort", () => {
        queryAborted = true;
      }, { once: true });
      resolveQueryStarted();
      return { kill() {} };
    }
    return originalExecFile(file, args, options, callback);
  };
  t.after(() => {
    childProcess.execFile = originalExecFile;
  });

  const main = fake.subscriptions[0];
  main.callback({
    invalidatedPaths: [path.join(root, ".gitignore")],
    pathEncodingCollapsed: false,
    coverage: { state: "complete" },
    rootState: { attachment: "attached" },
  }, { stop() {} });
  await queryStarted;
  let disposed = false;
  const disposal = watcher.dispose().then(() => {
    disposed = true;
  });
  await waitFor(() => main.disposed, "native teardown during Git cancellation");
  assert.equal(queryAborted, true);
  assert.equal(disposed, false);
  finishQuery();
  await disposal;
  assert.equal(disposed, true);
});


test("root recovery retries a conflict while the subscription remains lost", async (t) => {
  const root = tempDirectory(t, "watchbound-root-recovery-conflict-");
  let recoveryAttempts = 0;
  const fake = fakeWatchbound({
    recoverRoot: ({ subscription }) => {
      recoveryAttempts += 1;
      if (recoveryAttempts === 1) {
        subscription.rootState = { attachment: "lost" };
        throw Object.assign(new Error("root changed during recovery"), {
          code: "WATCHBOUND_ROOT_STATE_CONFLICT",
        });
      }
      return {
        attachment: "replacement-adopted",
        coverage: { state: "complete" },
      };
    },
  });
  globalThis[MODULE_OVERRIDE_KEY] = fake;
  delete globalThis[ENGINE_KEY];
  t.after(() => {
    delete globalThis[MODULE_OVERRIDE_KEY];
    delete globalThis[ENGINE_KEY];
  });
  const watcher = await codexLinuxStartDirectoryOnlyWorkingTreeWatch(
    {
      getFileSystemPath: () => root,
      platformPath: async () => path.posix,
    },
    {
      path: "/logical/root-recovery-conflict",
      recursive: true,
      renameEventHandling: "changed-path-with-parent-directory",
      onChange() {},
    },
    {
      maxWatches: 64,
      honorGitIgnore: false,
      ignoredDirectoryNames: [],
    },
  );
  const main = fake.subscriptions[0];
  main.rootState = { attachment: "lost" };
  main.callback({
    invalidatedPaths: [root],
    pathEncodingCollapsed: false,
    coverage: { state: "uncertain", reason: "root-replaced" },
    rootState: { attachment: "lost" },
  }, { stop() {} });
  await waitFor(() => main.recoveries.length === 2, "root recovery conflict retry", 3500);
  assert.equal(main.rootState.attachment, "attached");
  await watcher.dispose();
});

test("nonretryable root recovery errors trigger joined fatal disposal", async (t) => {
  const root = tempDirectory(t, "watchbound-root-recovery-terminal-");
  const fake = fakeWatchbound({
    recoverRoot: ({ subscription }) => {
      subscription.rootState = { attachment: "lost" };
      throw Object.assign(new Error("terminal root recovery failure"), {
        code: "WATCHBOUND_INTERNAL",
        retryable: false,
      });
    },
  });
  globalThis[MODULE_OVERRIDE_KEY] = fake;
  delete globalThis[ENGINE_KEY];
  t.after(() => {
    delete globalThis[MODULE_OVERRIDE_KEY];
    delete globalThis[ENGINE_KEY];
  });
  const watcher = await codexLinuxStartDirectoryOnlyWorkingTreeWatch(
    {
      getFileSystemPath: () => root,
      platformPath: async () => path.posix,
    },
    {
      path: "/logical/root-recovery-terminal",
      recursive: true,
      renameEventHandling: "changed-path-with-parent-directory",
      onChange() {},
    },
    {
      maxWatches: 64,
      honorGitIgnore: false,
      ignoredDirectoryNames: [],
    },
  );
  const main = fake.subscriptions[0];
  main.rootState = { attachment: "lost" };
  main.callback({
    invalidatedPaths: [root],
    pathEncodingCollapsed: false,
    coverage: { state: "uncertain", reason: "root-replaced" },
    rootState: { attachment: "lost" },
  }, { stop() {} });

  await waitFor(() => main.disposed, "terminal root-recovery disposal", 2500);
  const closed = await watcher.closed;
  assert.equal(closed.reason, "watch-error");
  assert.match(closed.error.message, /terminal root recovery failure/u);
  assert.equal(main.recoveries.length, 1);
});

test("an adopted root replacement must pass qualification again", async (t) => {
  const root = tempDirectory(t, "watchbound-recovered-root-qualification-");
  let qualificationCalls = 0;
  const qualification = (state) => ({
    schemaVersion: 1,
    state,
    reasons: state === "qualified" ? [] : ["filesystem-overlay"],
    root: {
      lexicalPath: root,
      lexicalPathBytes: Buffer.from(root),
      physicalPath: root,
      physicalPathBytes: Buffer.from(root),
    },
  });
  const fake = fakeWatchbound({
    qualifyRoot: () => qualification(
      qualificationCalls++ === 0 ? "qualified" : "unqualified",
    ),
  });
  globalThis[MODULE_OVERRIDE_KEY] = fake;
  delete globalThis[ENGINE_KEY];
  t.after(() => {
    delete globalThis[MODULE_OVERRIDE_KEY];
    delete globalThis[ENGINE_KEY];
  });
  const watcher = await codexLinuxStartDirectoryOnlyWorkingTreeWatch(
    {
      getFileSystemPath: () => root,
      platformPath: async () => path.posix,
    },
    {
      path: "/logical/recovered-root-qualification",
      recursive: true,
      renameEventHandling: "changed-path-with-parent-directory",
      onChange() {},
    },
    {
      maxWatches: 64,
      honorGitIgnore: false,
      ignoredDirectoryNames: [],
    },
  );
  const main = fake.subscriptions[0];
  main.rootState = { attachment: "lost" };
  main.callback({
    invalidatedPaths: [root],
    pathEncoding: "complete",
    pathEncodingCollapsed: false,
    coverage: { state: "uncertain", reason: "root-replaced" },
    rootState: { attachment: "lost" },
  }, { stop() {} });

  await waitFor(() => main.disposed, "unqualified recovered-root disposal", 2500);
  const closed = await watcher.closed;
  assert.equal(closed.reason, "watch-error");
  assert.match(closed.error.message, /recovered root is not qualified/u);
  assert.equal(qualificationCalls, 2);
});

test("a fatal pre-resolution callback joins the provisional subscription", async (t) => {
  const root = tempDirectory(t, "watchbound-early-fatal-");
  let stopped = false;
  const fake = fakeWatchbound({
    beforeSubscribeResolve: ({ callback }) => {
      callback({
        invalidatedPaths: null,
        pathEncodingCollapsed: false,
        coverage: { state: "complete" },
        rootState: { attachment: "attached" },
      }, {
        stop() {
          stopped = true;
        },
      });
    },
  });
  globalThis[MODULE_OVERRIDE_KEY] = fake;
  delete globalThis[ENGINE_KEY];
  t.after(() => {
    delete globalThis[MODULE_OVERRIDE_KEY];
    delete globalThis[ENGINE_KEY];
  });

  await assert.rejects(
    codexLinuxStartDirectoryOnlyWorkingTreeWatch(
      {
        getFileSystemPath: () => root,
        platformPath: async () => path.posix,
      },
      {
        path: "/logical/fatal",
        recursive: true,
        renameEventHandling: "changed-path-with-parent-directory",
        onChange() {},
      },
      {
        maxWatches: 64,
        honorGitIgnore: false,
        ignoredDirectoryNames: [],
      },
    ),
    /invalidatedPaths must be an array/u,
  );
  assert.equal(stopped, true);
  assert.equal(fake.subscriptions.length, 1);
  assert.equal(fake.subscriptions[0].disposed, true);
  assert.equal(fake.subscriptions[0].disposeCalls, 1);
});

test("a fatal pre-resolution callback is not masked by disposal failure", async (t) => {
  const root = tempDirectory(t, "watchbound-early-fatal-disposal-");
  let stopped = false;
  const fake = fakeWatchbound({
    beforeSubscribeResolve: ({ callback }) => {
      callback({
        invalidatedPaths: null,
        pathEncodingCollapsed: false,
        coverage: { state: "complete" },
        rootState: { attachment: "attached" },
      }, {
        stop() {
          stopped = true;
        },
      });
    },
    onDispose: () => {
      throw new Error("native disposal failed");
    },
  });
  globalThis[MODULE_OVERRIDE_KEY] = fake;
  delete globalThis[ENGINE_KEY];
  t.after(() => {
    delete globalThis[MODULE_OVERRIDE_KEY];
    delete globalThis[ENGINE_KEY];
  });
  await assert.rejects(
    codexLinuxStartDirectoryOnlyWorkingTreeWatch(
      {
        getFileSystemPath: () => root,
        platformPath: async () => path.posix,
      },
      {
        path: "/logical/fatal-disposal",
        recursive: true,
        renameEventHandling: "changed-path-with-parent-directory",
        onChange() {},
      },
      {
        maxWatches: 64,
        honorGitIgnore: false,
        ignoredDirectoryNames: [],
      },
    ),
    /invalidatedPaths must be an array.*additionally, watch disposal failed: native disposal failed/su,
  );
  assert.equal(stopped, true);
});

test("metadata watch retries arm first and close the gap with a fresh policy pass", async (t) => {
  const root = tempDirectory(t, "watchbound-metadata-backoff-");
  git(root, ["init", "-q"]);
  const originalWatch = fs.watch;
  const calls = [];
  fs.watch = (directory) => {
    const watcher = new (require("node:events").EventEmitter)();
    watcher.close = () => {};
    calls.push(directory);
    if (calls.length <= 2) {
      setImmediate(() => watcher.emit("error", Object.assign(
        new Error("watch limit"),
        { code: "ENOSPC" },
      )));
    }
    return watcher;
  };
  t.after(() => {
    fs.watch = originalWatch;
  });

  const fake = fakeWatchbound();
  globalThis[MODULE_OVERRIDE_KEY] = fake;
  delete globalThis[ENGINE_KEY];
  t.after(() => {
    delete globalThis[MODULE_OVERRIDE_KEY];
    delete globalThis[ENGINE_KEY];
  });
  const changes = [];
  const watcher = await codexLinuxStartDirectoryOnlyWorkingTreeWatch(
    {
      getFileSystemPath: () => root,
      platformPath: async () => path.posix,
    },
    {
      path: "/logical/backoff",
      recursive: true,
      renameEventHandling: "changed-path-with-parent-directory",
      onChange: (change) => changes.push(change),
    },
    {
      maxWatches: 64,
      honorGitIgnore: true,
      ignoredDirectoryNames: [],
    },
  );
  await new Promise((resolve) => setTimeout(resolve, 100));
  assert.equal(calls.length, 2, "metadata watches must use their one-second backoff");
  assert.equal(changes.length, 2);
  const main = fake.subscriptions[0];
  const replacementCount = main.replacements.length;
  writeFile(path.join(root, ".gitignore"), "during-backoff/\n");
  writeFile(path.join(root, "during-backoff", "value"), "unobserved interval");
  await waitFor(() => calls.length >= 4, "metadata retry after backoff", 2500);
  await waitFor(
    () => (
      main.replacements.length > replacementCount &&
      main.replacements.at(-1).prefixes.includes("during-backoff")
    ),
    "fresh policy snapshot after metadata re-arm",
    2500,
  );
  await watcher.dispose();
});

test("accepted root replacement recreates same-path metadata watches", async (t) => {
  const root = tempDirectory(t, "watchbound-root-metadata-");
  git(root, ["init", "-q"]);
  const originalWatch = fs.watch;
  const calls = [];
  fs.watch = (directory) => {
    const watcher = new (require("node:events").EventEmitter)();
    watcher.close = () => {};
    calls.push(directory);
    return watcher;
  };
  t.after(() => {
    fs.watch = originalWatch;
  });
  const fake = fakeWatchbound();
  globalThis[MODULE_OVERRIDE_KEY] = fake;
  delete globalThis[ENGINE_KEY];
  t.after(() => {
    delete globalThis[MODULE_OVERRIDE_KEY];
    delete globalThis[ENGINE_KEY];
  });
  const watcher = await codexLinuxStartDirectoryOnlyWorkingTreeWatch(
    {
      getFileSystemPath: () => root,
      platformPath: async () => path.posix,
    },
    {
      path: "/logical/root-metadata",
      recursive: true,
      renameEventHandling: "changed-path-with-parent-directory",
      onChange() {},
    },
    {
      maxWatches: 64,
      honorGitIgnore: true,
      ignoredDirectoryNames: [],
    },
  );
  assert.equal(calls.length, 2);
  const main = fake.subscriptions[0];
  main.callback({
    invalidatedPaths: [root],
    pathEncodingCollapsed: false,
    coverage: { state: "uncertain", reason: "root-replaced" },
    rootState: { attachment: "lost" },
  }, { stop() {} });
  await waitFor(() => main.recoveries.length === 1, "root recovery", 2500);
  await waitFor(() => calls.length >= 4, "same-path metadata rewatch", 2500);
  assert.deepEqual(
    new Set(calls.slice(-2)),
    new Set(calls.slice(0, 2)),
  );
  await watcher.dispose();
});

test("an observed root .git boundary forces metadata reattachment and root invalidation", async (t) => {
  const root = tempDirectory(t, "watchbound-git-boundary-metadata-");
  git(root, ["init", "-q"]);
  const originalWatch = fs.watch;
  const calls = [];
  fs.watch = (directory) => {
    const watcher = new (require("node:events").EventEmitter)();
    watcher.close = () => {};
    calls.push(directory);
    return watcher;
  };
  t.after(() => {
    fs.watch = originalWatch;
  });
  const fake = fakeWatchbound();
  globalThis[MODULE_OVERRIDE_KEY] = fake;
  delete globalThis[ENGINE_KEY];
  t.after(() => {
    delete globalThis[MODULE_OVERRIDE_KEY];
    delete globalThis[ENGINE_KEY];
  });
  const changes = [];
  const watcher = await codexLinuxStartDirectoryOnlyWorkingTreeWatch(
    {
      getFileSystemPath: () => root,
      platformPath: async () => path.posix,
    },
    {
      path: "/logical/git-boundary",
      recursive: true,
      renameEventHandling: "changed-path-with-parent-directory",
      onChange: (change) => changes.push(change),
    },
    {
      maxWatches: 64,
      honorGitIgnore: true,
      ignoredDirectoryNames: [],
    },
  );
  assert.equal(calls.length, 2);
  const main = fake.subscriptions[0];
  main.callback({
    invalidatedPaths: [path.join(root, ".git")],
    pathEncodingCollapsed: false,
    coverage: { state: "complete" },
    rootState: { attachment: "attached" },
  }, { stop() {} });
  assert.deepEqual(changes.at(-1), { changedPaths: [] });
  await waitFor(() => calls.length >= 4, "observed .git metadata rewatch");
  assert.equal(main.recoveries.length, 0);
  await watcher.dispose();
});

test("root-recovery consumer exceptions trigger joined fatal disposal", async (t) => {
  const root = tempDirectory(t, "watchbound-root-recovery-fatal-");
  const fake = fakeWatchbound();
  globalThis[MODULE_OVERRIDE_KEY] = fake;
  delete globalThis[ENGINE_KEY];
  t.after(() => {
    delete globalThis[MODULE_OVERRIDE_KEY];
    delete globalThis[ENGINE_KEY];
  });
  let changes = 0;
  let watcher;
  t.after(async () => {
    await watcher?.dispose();
  });
  watcher = await codexLinuxStartDirectoryOnlyWorkingTreeWatch(
    {
      getFileSystemPath: () => root,
      platformPath: async () => path.posix,
    },
    {
      path: "/logical/root-recovery-fatal",
      recursive: true,
      renameEventHandling: "changed-path-with-parent-directory",
      onChange() {
        changes += 1;
        if (changes === 2) throw new Error("consumer rejected root recovery");
      },
    },
    {
      maxWatches: 64,
      honorGitIgnore: false,
      ignoredDirectoryNames: [],
    },
  );
  const main = fake.subscriptions[0];
  main.callback({
    invalidatedPaths: [root],
    pathEncodingCollapsed: false,
    coverage: { state: "uncertain", reason: "root-replaced" },
    rootState: { attachment: "lost" },
  }, { stop() {} });
  await waitFor(() => main.disposed, "fatal root-recovery disposal", 2500);
  const closed = await watcher.closed;
  assert.equal(closed.reason, "watch-error");
  assert.match(closed.error.message, /consumer rejected root recovery/u);
});

test("fatal teardown retains consumer and native-disposal failures", async (t) => {
  const root = tempDirectory(t, "watchbound-fatal-disposal-");
  const fake = fakeWatchbound({
    onDispose: () => {
      throw new Error("native disposal failed");
    },
  });
  globalThis[MODULE_OVERRIDE_KEY] = fake;
  delete globalThis[ENGINE_KEY];
  t.after(() => {
    delete globalThis[MODULE_OVERRIDE_KEY];
    delete globalThis[ENGINE_KEY];
  });
  const watcher = await codexLinuxStartDirectoryOnlyWorkingTreeWatch(
    {
      getFileSystemPath: () => root,
      platformPath: async () => path.posix,
    },
    {
      path: "/logical/fatal-disposal",
      recursive: true,
      renameEventHandling: "changed-path-with-parent-directory",
      onChange() {},
    },
    {
      maxWatches: 64,
      honorGitIgnore: false,
      ignoredDirectoryNames: [],
    },
  );
  let stopped = false;
  fake.subscriptions[0].callback({
    invalidatedPaths: null,
    pathEncodingCollapsed: false,
    coverage: { state: "complete" },
    rootState: { attachment: "attached" },
  }, {
    stop() {
      stopped = true;
    },
  });
  const closed = await watcher.closed;
  assert.equal(stopped, true);
  assert.equal(closed.reason, "watch-error");
  assert.match(
    closed.error.message,
    /invalidatedPaths must be an array.*additionally, watch disposal failed: native disposal failed/su,
  );
});

test("disposal joins an in-flight root recovery after initiating native disposal", async (t) => {
  const root = tempDirectory(t, "watchbound-dispose-recovery-");
  let recoveryStarted = false;
  let releaseRecovery;
  let nativeDisposeStarted = false;
  const fake = fakeWatchbound({
    recoverRoot: () => {
      recoveryStarted = true;
      return new Promise((resolve) => {
        releaseRecovery = () => resolve({
          attachment: "replacement-adopted",
          coverage: { state: "complete" },
        });
      });
    },
    onDispose: () => {
      nativeDisposeStarted = true;
      releaseRecovery?.();
    },
  });
  globalThis[MODULE_OVERRIDE_KEY] = fake;
  delete globalThis[ENGINE_KEY];
  t.after(() => {
    delete globalThis[MODULE_OVERRIDE_KEY];
    delete globalThis[ENGINE_KEY];
  });
  const watcher = await codexLinuxStartDirectoryOnlyWorkingTreeWatch(
    {
      getFileSystemPath: () => root,
      platformPath: async () => path.posix,
    },
    {
      path: "/logical/dispose-recovery",
      recursive: true,
      renameEventHandling: "changed-path-with-parent-directory",
      onChange() {},
    },
    {
      maxWatches: 64,
      honorGitIgnore: false,
      ignoredDirectoryNames: [],
    },
  );
  const main = fake.subscriptions[0];
  main.rootState = { attachment: "lost" };
  main.callback({
    invalidatedPaths: [root],
    pathEncodingCollapsed: false,
    coverage: { state: "uncertain", reason: "root-replaced" },
    rootState: { attachment: "lost" },
  }, { stop() {} });
  await waitFor(() => recoveryStarted, "in-flight root recovery", 2500);
  const outcome = await Promise.race([
    watcher.dispose().then(() => "disposed"),
    new Promise((resolve) => setTimeout(() => resolve("timeout"), 250)),
  ]);
  assert.equal(outcome, "disposed");
  assert.equal(nativeDisposeStarted, true);
  assert.equal(main.disposed, true);
});






test("disposal interrupts policy replacement before joining policy work", async (t) => {
  const root = tempDirectory(t, "watchbound-dispose-replacement-");
  git(root, ["init", "-q"]);
  let replacementCalls = 0;
  let replacementStarted = false;
  let releaseReplacement;
  let nativeDisposeStarted = false;
  const fake = fakeWatchbound({
    replaceExclusions: ({ generation, policy, subscription }) => {
      replacementCalls += 1;
      if (replacementCalls === 1) {
        subscription.exclusionGeneration = generation;
        subscription.policy = policy;
        subscription.replacements.push({ generation, policy, ...policy });
        return { state: "complete" };
      }
      replacementStarted = true;
      return new Promise((resolve) => {
        releaseReplacement = () => {
          subscription.exclusionGeneration = generation;
          subscription.policy = policy;
          subscription.replacements.push({ generation, policy, ...policy });
          resolve({ state: "complete" });
        };
      });
    },
    onDispose: () => {
      nativeDisposeStarted = true;
      releaseReplacement?.();
    },
  });
  globalThis[MODULE_OVERRIDE_KEY] = fake;
  delete globalThis[ENGINE_KEY];
  t.after(() => {
    delete globalThis[MODULE_OVERRIDE_KEY];
    delete globalThis[ENGINE_KEY];
  });
  const watcher = await codexLinuxStartDirectoryOnlyWorkingTreeWatch(
    {
      getFileSystemPath: () => root,
      platformPath: async () => path.posix,
    },
    {
      path: "/logical/dispose-replacement",
      recursive: true,
      renameEventHandling: "changed-path-with-parent-directory",
      onChange() {},
    },
    {
      maxWatches: 64,
      honorGitIgnore: true,
      ignoredDirectoryNames: ["node_modules"],
    },
  );
  writeFile(path.join(root, ".gitignore"), "ignored/\n");
  writeFile(path.join(root, "ignored", "value"), "ignored");
  const main = fake.subscriptions[0];
  main.callback({
    invalidatedPaths: [path.join(root, ".gitignore")],
    pathEncodingCollapsed: false,
    coverage: { state: "complete" },
    rootState: { attachment: "attached" },
  }, { stop() {} });
  await waitFor(() => replacementStarted, "stalled policy replacement");
  const outcome = await Promise.race([
    watcher.dispose().then(() => "disposed"),
    new Promise((resolve) => setTimeout(() => resolve("timeout"), 250)),
  ]);
  assert.equal(outcome, "disposed");
  assert.equal(nativeDisposeStarted, true);
  assert.equal(main.disposed, true);
});

test("metadata consumer exceptions trigger joined fatal disposal", async (t) => {
  const root = tempDirectory(t, "watchbound-metadata-fatal-");
  git(root, ["init", "-q"]);
  const fake = fakeWatchbound();
  globalThis[MODULE_OVERRIDE_KEY] = fake;
  delete globalThis[ENGINE_KEY];
  t.after(() => {
    delete globalThis[MODULE_OVERRIDE_KEY];
    delete globalThis[ENGINE_KEY];
  });
  let fail = false;
  const watcher = await codexLinuxStartDirectoryOnlyWorkingTreeWatch(
    {
      getFileSystemPath: () => root,
      platformPath: async () => path.posix,
    },
    {
      path: "/logical/metadata-fatal",
      recursive: true,
      renameEventHandling: "changed-path-with-parent-directory",
      onChange() {
        if (fail) throw new Error("consumer rejected metadata event");
      },
    },
    {
      maxWatches: 64,
      honorGitIgnore: true,
      ignoredDirectoryNames: [],
    },
  );
  fail = true;
  writeFile(path.join(root, "tracked"), "tracked");
  git(root, ["add", "tracked"]);
  const closed = await watcher.closed;
  assert.equal(closed.reason, "watch-error");
  assert.match(closed.error.message, /consumer rejected metadata event/u);
  assert.equal(fake.subscriptions[0].disposed, true);
});
