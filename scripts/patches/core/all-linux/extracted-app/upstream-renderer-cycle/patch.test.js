"use strict";

const assert = require("node:assert/strict");
const childProcess = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const { createPatchReport, criticalFailuresFromReport } = require("../../../../../lib/patch-report.js");
const { patchExtractedApp } = require("../../../../runner.js");
const patchModule = require("./patch.js");
const {
  lateModuleInitializerContracts,
  patchUpstreamRendererCycle,
  rendererCycleContracts,
  routeInitializerContracts,
} = patchModule;

function fixtureRoot(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "upstream-renderer-cycle-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const assetsDir = path.join(root, "webview", "assets");
  fs.mkdirSync(assetsDir, { recursive: true });
  fs.writeFileSync(path.join(root, "package.json"), '{"type":"module"}\n');
  return { root, assetsDir };
}

function authedRouteSource(primaryAsset = "app-primary-fixture.js", patched = false) {
  const initializer = patched ? "queueMicrotask(()=>n())" : "n()";
  return [
    `import{Ac as t,jc as n,kc as r}from"./${primaryAsset}";`,
    "var o={name:`smartphone-light-16`};",
    `${initializer};export{r as AppLayoutRoute,t as AuthedRoute,o as n};`,
  ].join("");
}

function appPrimarySource(
  authedRouteAsset = "authed-route-fixture.js",
  reverseImport = true,
  initializerKind = "late",
) {
  return [
    reverseImport ? `import{n as phone}from"./${authedRouteAsset}";` : "var phone={};",
    "var initialized=false;",
    initializerKind === "late"
      ? "var initializer=moduleFactory((()=>{initialized=true}));function moduleFactory(factory){return()=>factory()}"
      : "function initializer(){initialized=true}",
    "var appLayout={},authed={};",
    "export{authed as Ac,initializer as jc,appLayout as kc};",
    "export function state(){return{initialized,phone:phone.name}}",
  ].join("");
}

function writeCycleFixture(assetsDir, options = {}) {
  const routeName = options.routeName ?? "authed-route-fixture.js";
  const primaryName = options.primaryName ?? "app-primary-fixture.js";
  fs.writeFileSync(
    path.join(assetsDir, routeName),
    authedRouteSource(primaryName, options.patched ?? false),
  );
  fs.writeFileSync(
    path.join(assetsDir, primaryName),
    appPrimarySource(
      routeName,
      options.reverseImport ?? true,
      options.initializerKind ?? "late",
    ),
  );
  return { routeName, primaryName };
}

function importPrimary(root, primaryName) {
  const primaryUrl = new URL(
    `./webview/assets/${primaryName}`,
    `file://${root}/`,
  ).href;
  return childProcess.spawnSync(
    process.execPath,
    [
      "--input-type=module",
      "--eval",
      `const m=await import(${JSON.stringify(primaryUrl)});await new Promise(queueMicrotask);console.log(JSON.stringify(m.state()))`,
    ],
    { encoding: "utf8" },
  );
}

test("renderer cycle repair is a required core descriptor", () => {
  assert.deepEqual(
    patchModule.descriptors.map(({ id, phase, ciPolicy }) => [id, phase, ciPolicy]),
    [["upstream-renderer-cycle", "extracted-app:post-webview", "required-upstream"]],
  );
});

test("renderer cycle patch defers the initializer and is idempotent", (t) => {
  const { root, assetsDir } = fixtureRoot(t);
  const { routeName } = writeCycleFixture(assetsDir);

  const before = fs.readFileSync(path.join(assetsDir, routeName), "utf8");
  const result = patchUpstreamRendererCycle(root);
  const after = fs.readFileSync(path.join(assetsDir, routeName), "utf8");

  assert.deepEqual(result, {
    matched: true,
    changed: 1,
    alreadyApplied: false,
    assetName: routeName,
  });
  assert.notEqual(after, before);
  assert.equal(after, before.replace("n();export{", "queueMicrotask(()=>n());export{"));
  assert.match(after, /queueMicrotask\(\(\)=>n\(\)\);export\{/u);
  assert.equal(rendererCycleContracts(root).length, 1);
  assert.equal(rendererCycleContracts(root)[0].patched, true);
  assert.deepEqual(patchUpstreamRendererCycle(root), {
    matched: true,
    changed: 0,
    alreadyApplied: true,
    assetName: routeName,
  });
});

test("deferred initializer repairs the executable module cycle", (t) => {
  const { root, assetsDir } = fixtureRoot(t);
  const { primaryName } = writeCycleFixture(assetsDir);

  const failed = importPrimary(root, primaryName);
  assert.notEqual(failed.status, 0);
  assert.match(failed.stderr, /is not a function/u);

  assert.equal(patchUpstreamRendererCycle(root).changed, 1);
  const repaired = importPrimary(root, primaryName);
  assert.equal(repaired.status, 0, repaired.stderr);
  assert.deepEqual(JSON.parse(repaired.stdout), {
    initialized: true,
    phone: "smartphone-light-16",
  });
});

test("patch runner reports the core cycle fix as applied then already applied", (t) => {
  const { root, assetsDir } = fixtureRoot(t);
  writeCycleFixture(assetsDir);
  const firstReport = createPatchReport();
  patchExtractedApp(root, { report: firstReport });
  assert.deepEqual(
    firstReport.patches.map(({ name, status, sourceKind, ciPolicy }) => ({
      name,
      status,
      sourceKind,
      ciPolicy,
    })),
    [{
      name: "upstream-renderer-cycle",
      status: "applied",
      sourceKind: "core",
      ciPolicy: "required-upstream",
    }],
  );
  assert.deepEqual(criticalFailuresFromReport(firstReport), []);

  const secondReport = createPatchReport();
  patchExtractedApp(root, { report: secondReport });
  assert.equal(secondReport.patches[0].status, "already-applied");
  assert.deepEqual(criticalFailuresFromReport(secondReport), []);
});

test("historical one-way authed route import does not match issue 1465 payload shape", () => {
  const source =
    'import{oc as e,sc as t}from"./app-primary-old.js";t();export{e as AuthedRoute};';
  assert.deepEqual(routeInitializerContracts(source), []);
});

test("safe hoisted app-primary initializer does not match", (t) => {
  const { root, assetsDir } = fixtureRoot(t);
  const { routeName, primaryName } = writeCycleFixture(assetsDir, {
    initializerKind: "hoisted",
  });
  const routePath = path.join(assetsDir, routeName);
  const primarySource = fs.readFileSync(path.join(assetsDir, primaryName), "utf8");
  const before = fs.readFileSync(routePath, "utf8");

  assert.deepEqual(lateModuleInitializerContracts(primarySource, "jc"), []);
  assert.deepEqual(rendererCycleContracts(root), []);
  assert.equal(patchUpstreamRendererCycle(root).matched, false);
  assert.equal(fs.readFileSync(routePath, "utf8"), before);
});

test("missing reverse import fails closed without changing the route asset", (t) => {
  const { root, assetsDir } = fixtureRoot(t);
  const { routeName } = writeCycleFixture(assetsDir, { reverseImport: false });
  const routePath = path.join(assetsDir, routeName);
  const before = fs.readFileSync(routePath, "utf8");

  const result = patchUpstreamRendererCycle(root);

  assert.equal(result.matched, false);
  assert.equal(result.changed, 0);
  assert.equal(fs.readFileSync(routePath, "utf8"), before);
});

test("missing reverse import reports a required core failure", (t) => {
  const { root, assetsDir } = fixtureRoot(t);
  writeCycleFixture(assetsDir, { reverseImport: false });
  const report = createPatchReport();

  patchExtractedApp(root, { report });

  assert.equal(report.patches[0].status, "failed-required");
  assert.deepEqual(
    criticalFailuresFromReport(report).map(({ name, status }) => ({ name, status })),
    [{ name: "upstream-renderer-cycle", status: "failed-required" }],
  );
});

test("ambiguous cycle contracts fail closed without changing either asset", (t) => {
  const { root, assetsDir } = fixtureRoot(t);
  const first = writeCycleFixture(assetsDir, {
    routeName: "authed-route-first.js",
    primaryName: "app-primary-first.js",
  });
  const second = writeCycleFixture(assetsDir, {
    routeName: "authed-route-second.js",
    primaryName: "app-primary-second.js",
  });
  const before = new Map(
    [first.routeName, second.routeName].map((name) => [
      name,
      fs.readFileSync(path.join(assetsDir, name), "utf8"),
    ]),
  );

  const result = patchUpstreamRendererCycle(root);

  assert.equal(result.matched, false);
  assert.equal(result.changed, 0);
  for (const [name, source] of before) {
    assert.equal(fs.readFileSync(path.join(assetsDir, name), "utf8"), source);
  }
});

test("mixed current and patched contracts fail closed", (t) => {
  const { root, assetsDir } = fixtureRoot(t);
  const { routeName, primaryName } = writeCycleFixture(assetsDir);
  const routePath = path.join(assetsDir, routeName);
  const mixed =
    authedRouteSource(primaryName, false) +
    authedRouteSource(primaryName, true);
  fs.writeFileSync(routePath, mixed, "utf8");

  const result = patchUpstreamRendererCycle(root);

  assert.equal(result.matched, false);
  assert.equal(result.changed, 0);
  assert.equal(fs.readFileSync(routePath, "utf8"), mixed);
});
