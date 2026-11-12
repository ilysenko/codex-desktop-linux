"use strict";

const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const { spawnSync } = require("node:child_process");
const { loadLinuxFeaturePatchDescriptors } = require("../../scripts/lib/linux-features.js");
const { listWebviewAssetFiles } = require("../../scripts/patches/lib/assets.js");
const { fixture, MARKER, chunk, copy, nativeGate, disabledReasons } = require("./current-composer.test-helpers.js");
const patch = require("./patch.js");
const { normalizePatchDescriptors, applyExtractedAppPatchDescriptors } = require("../../scripts/patches/engine.js");
const { createPatchReport } = require("../../scripts/lib/patch-report.js");
const nativeFiles = { "async/renamed-first.js": chunk(fixture.owners[0]), "async/deep/renamed-second.js": chunk(fixture.owners[1]), "banner-cloud.js": "const bannerAndCloudConsumerIsUnrelated=true;" };
function quiet(run) { const old = console.warn; console.warn = () => {}; try { return run(); } finally { console.warn = old; } }
function inspect(record, source = record.moduleSource) { return patch.inspectUsageLimitSendAttempt(copy(record, source)); }
function changedBody(record) {
  const plan = inspect(record);
  const { rspackModuleFactories } = require("../../scripts/patches/lib/rspack-module-assets.js");
  const copies = [...rspackModuleFactories(plan.patchedSource, "current.js")];
  return copies.find(copy => copy.moduleId === record.moduleId).moduleSource;
}
function withApp(files, run) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "usage-limit-current-"));
  const assets = path.join(root, "webview/assets");
  for (const [name, source] of Object.entries(files)) { const file = path.join(assets, name); fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, source, { mode: 0o640 }); }
  const read = name => fs.readFileSync(path.join(assets, name), "utf8");
  const snapshot = () => Object.fromEntries(Object.keys(files).map(name => [name, { source: read(name), mode: fs.statSync(path.join(assets, name)).mode & 0o777 }]));
  try { return run({ root, assets, read, snapshot }); }
  finally { fs.rmSync(root, { recursive: true, force: true }); }
}
function production(root) { const report = createPatchReport(); quiet(() => applyExtractedAppPatchDescriptors(root, normalizePatchDescriptors(patch.descriptors), {}, report, "extracted-app:post-webview")); return report.patches[0]; }

test("feature stays disabled by default and registers through the production feature tree", t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "usage-limit-registration-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const config = path.join(root, "features.json");
  const featuresRoot = path.resolve(path.dirname(require.resolve("../../scripts/lib/linux-features.js")), "../../linux-features");
  const manifest = JSON.parse(fs.readFileSync(path.join(featuresRoot, "usage-limit-send-attempt/feature.json"), "utf8"));
  assert.equal(manifest.defaultEnabled, false);
  fs.writeFileSync(config, '{"enabled":[]}\n');
  assert.deepEqual(loadLinuxFeaturePatchDescriptors({ featuresRoot, featuresConfigPath: config, strictConfig: true }), []);
  fs.writeFileSync(config, '{"enabled":["usage-limit-send-attempt"]}\n');
  const loaded = loadLinuxFeaturePatchDescriptors({ featuresRoot, featuresConfigPath: config, strictConfig: true });
  assert.deepEqual(loaded.map(descriptor => descriptor.id), ["feature:usage-limit-send-attempt:usage-limit-send-attempt-ui"]);
  assert.equal(loaded[0].phase, "extracted-app:post-webview");
});

for (const [index, owner] of fixture.owners.entries()) {
  test(`current composer ${index} changes only its local usage gate and recognizes applied source`, () => {
    assert.equal(crypto.createHash("sha256").update(owner.moduleSource).digest("hex"), owner.provenance.moduleSha256);
    const original = nativeGate(owner), plan = inspect(owner);
    assert.equal(plan.state, "native");
    const expected = owner.moduleSource.slice(0, original.index) + `${original.groups.flag}=!1/*${MARKER}*/` + owner.moduleSource.slice(original.index + original[0].length);
    assert.equal(plan.patchedSource, chunk(owner, expected));
    assert.equal(changedBody(owner), expected);
    assert.equal(inspect(owner, expected).state, "applied");
    assert.equal(inspect(owner, expected).patchedSource, chunk(owner, expected));
    const before = chunk(owner), first = patch.applyUsageLimitSendAttemptPatch(before);
    assert.equal(first, chunk(owner, expected));
    assert.equal(patch.applyUsageLimitSendAttemptPatch(first), first);
    assert.equal(expected.replace(`${original.groups.flag}=!1/*${MARKER}*/`, original[0]), owner.moduleSource);
  });

  test(`current composer ${index} preserves other ten blockers and the cloud path`, () => {
    const applied = changedBody(owner);
    assert.equal(disabledReasons(owner, owner.moduleSource, { usageBlocked: true }).submitDisabledReasons, "usage-limit");
    assert.equal(disabledReasons(owner, applied, { usageBlocked: true }).submitDisabledReasons, "");
    const cases = [["callerDisabled", "caller-disabled"], ["readOnlySsh", "read-only-ssh-chat"], ["providerBlocked", "provider-blocked"], ["modelUnavailable", "model-selection-unavailable"],
      ["environmentBusy", "environment-busy"], ["draftsLoading", "draft-tabs-restoring"], ["policyViolation", "policy-violation"],
      ["collaborationLoading", "collaboration-mode-loading"], ["tierLoading", "service-tier-loading"], ["reserveLimit", "reserve-limit"]];
    for (const [flag, reason] of cases) {
      const input = { usageBlocked: true, [flag]: true };
      assert.equal(disabledReasons(owner, owner.moduleSource, input).submitDisabledReasons, `${reason},usage-limit`);
      assert.equal(disabledReasons(owner, applied, input).submitDisabledReasons, reason);
    }
    const all = { usageBlocked: true, ...Object.fromEntries(cases.map(([flag]) => [flag, true])) };
    assert.equal(disabledReasons(owner, applied, all).submitDisabledReasons, cases.map(([, reason]) => reason).join(","));
    const cloud = { host: "cloud", usageBlocked: true, policyViolation: true };
    assert.equal(disabledReasons(owner, owner.moduleSource, cloud).submitDisabledReasons, "policy-violation");
    assert.equal(disabledReasons(owner, applied, cloud).submitDisabledReasons, "policy-violation");
  });

  test(`current composer ${index} refuses false gates, marker-only claims, opaque owners and disconnected returns`, () => {
    const applied = changedBody(owner), flag = nativeGate(owner).groups.flag;
    const reason = new RegExp(`([A-Za-z_$][\\w$]*)=${flag}&&"usage-limit"`).exec(owner.moduleSource)[1];
    const joined = /submitDisabledReasons:([A-Za-z_$][\w$]*)/.exec(owner.moduleSource)[1];
    const controller = inspect(owner).chain.controller;
    const { escapeRegExp } = require("../../scripts/patches/lib/minified-js.js");
    const rootChildren = new RegExp(`children:\\[[A-Za-z_$][\\w$]*,[A-Za-z_$][\\w$]*,${escapeRegExp(controller)}\\]`, "u").exec(owner.moduleSource)?.[0];
    assert.ok(rootChildren);
    const badSources = [
      owner.moduleSource + `/*${MARKER}*/`,
      owner.moduleSource.replace(nativeGate(owner)[0], `${flag}=!1`),
      applied.replace(`${reason}=${flag}&&"usage-limit"`, `${reason}=foreign&&"usage-limit"`),
      applied.replace(".filter(Boolean)", ".filter(()=>false)"),
      applied.replace(`submitDisabledReasons:${joined}`, "submitDisabledReasons:foreignReasons") + `;function unused(){return{submitDisabledReasons:${joined}}}`,
      applied.replace(rootChildren, rootChildren.replace(`,${controller}`, "")),
      `/*${owner.moduleSource}*/`,
      `const quoted=${JSON.stringify(owner.moduleSource)};`,
      owner.moduleSource.replace("CodexComposerAdapter:", "UnusedComposerAdapter:"),
    ];
    for (const source of badSources) {
      assert.notEqual(source, owner.moduleSource);
      assert.throws(() => inspect(owner, source));
      const carrier = chunk(owner, source);
      assert.equal(quiet(() => patch.applyUsageLimitSendAttemptPatch(carrier)), carrier);
    }
  });
}

test("normal production descriptor applies every current physical composer and repeats already-applied", () => {
  withApp(nativeFiles, ({ root, read, snapshot }) => {
    const before = snapshot();
    assert.equal(production(root).status, "applied");
    for (const [index, name] of ["async/renamed-first.js", "async/deep/renamed-second.js"].entries()) {
      assert.equal(read(name), chunk(fixture.owners[index], changedBody(fixture.owners[index])));
    }
    const first = snapshot();
    assert.equal(production(root).status, "already-applied");
    assert.deepEqual(snapshot(), first);
    assert.equal(read("banner-cloud.js"), before["banner-cloud.js"].source);
    for (const file of Object.values(first)) assert.equal(file.mode, 0o640);
  });
});

test("complete asset comments and quoted source cannot claim a live composer", () => {
  const owner = fixture.owners[0];
  for (const source of [`/*${chunk(owner)}*/`, `const quoted=${JSON.stringify(chunk(owner))};`]) {
    assert.equal(quiet(() => patch.applyUsageLimitSendAttemptPatch(source)), source);
    withApp({ ...nativeFiles, "async/opaque-full-asset.js": source }, ({ root, snapshot }) => {
      const before = snapshot(), result = quiet(() => patch.applyUsageLimitSendAttemptAppPatch(root));
      assert.equal(result.changed, 0);
      assert.equal(result.matched, 0);
      assert.ok(result.reason);
      assert.deepEqual(snapshot(), before);
    });
  }
});

test("whole composer cohort rejects mixed, damaged, duplicate, opaque and orphan claims before writing", () => {
  const [left, right] = fixture.owners;
  const cases = [
    { ...nativeFiles, "async/renamed-first.js": chunk(left, changedBody(left)) },
    { ...nativeFiles, "async/deep/renamed-second.js": chunk(right, right.moduleSource.replace('&&"usage-limit"', '&&"quota-limit"')) },
    { ...nativeFiles, "async/dead-peer.js": chunk(left, `/*${left.moduleSource}*/`) },
    { ...nativeFiles, "unrelated.js": `const text=${JSON.stringify(MARKER)};` },
    { ...nativeFiles, "async/renamed-first.js": chunk(left).replace(/};$/, `,${JSON.stringify(left.moduleId)}(${left.params}){${left.moduleSource}}};`) },
  ];
  for (const files of cases) withApp(files, ({ root, snapshot }) => {
    const before = snapshot(), result = quiet(() => patch.applyUsageLimitSendAttemptAppPatch(root));
    assert.equal(result.changed, 0);
    assert.equal(result.matched, 0);
    assert.ok(result.reason);
    assert.deepEqual(snapshot(), before);
    assert.equal(production(root).status, "skipped-optional");
    assert.deepEqual(snapshot(), before);
  });
});

test("a later composer write failure restores the complete original cohort", () => {
  withApp(nativeFiles, ({ root, assets, snapshot }) => {
    const before = snapshot(), original = fs.writeFileSync;
    let writes = 0;
    fs.writeFileSync = (file, bytes, ...options) => {
      if (String(file).startsWith(assets + path.sep) && ++writes === 2) { original(file, "truncated"); throw new Error("second usage composer write failed"); }
      return original(file, bytes, ...options);
    };
    try { assert.throws(() => patch.applyUsageLimitSendAttemptAppPatch(root), /second usage composer write failed/); }
    finally { fs.writeFileSync = original; }
    assert.ok(writes >= 2);
    assert.deepEqual(snapshot(), before);
  });
});

test("an unprovable rollback remains a classified integrity failure", () => {
  withApp(nativeFiles, ({ root, assets }) => {
    const original = fs.writeFileSync;
    let writes = 0;
    fs.writeFileSync = (file, bytes, ...options) => {
      if (String(file).startsWith(assets + path.sep)) {
        writes++;
        if (writes === 2) { original(file, "truncated"); throw new Error("usage write failed"); }
        if (writes > 2) throw new Error("usage restore failed");
      }
      return original(file, bytes, ...options);
    };
    try { assert.throws(() => patch.applyUsageLimitSendAttemptAppPatch(root), error => error.code === "PATCH_INTEGRITY_FAILURE"); }
    finally { fs.writeFileSync = original; }
  });
});


test("current signed full composer chunks apply, repeat and remain valid ESM", {
  skip: !process.env.CODEX_SIGNED_EXTRACTED_APP,
}, t => {
  const signed = path.join(process.env.CODEX_SIGNED_EXTRACTED_APP, "webview/assets");
  const files = {};
  const originals = [];
  for (const name of listWebviewAssetFiles(signed, /\.js$/u)) {
    const file = path.join(signed, name), source = fs.readFileSync(file, "utf8");
    if (!source.includes("shouldSendPermissionOverrides:") || !source.includes("submitDisabledReasons:") || !source.includes('&&"usage-limit"')) continue;
    files[name] = source;
    originals.push({ file, source });
  }
  assert.equal(originals.length, 2);
  withApp(files, ({ root, read, snapshot }) => {
    assert.equal(production(root).status, "applied");
    const first = snapshot();
    assert.equal(production(root).status, "already-applied");
    assert.deepEqual(snapshot(), first);
    for (const name of Object.keys(files)) {
      const source = read(name);
      assert.equal(source.split(MARKER).length, 2);
      const check = spawnSync(process.execPath, ["--max-old-space-size=768", "--input-type=module", "--check"], {
        input: source, encoding: "utf8", maxBuffer: 1024 * 1024, timeout: 10000,
      });
      assert.equal(check.status, 0, `${name}: ${check.stderr}`);
    }
  });
  for (const original of originals) assert.equal(fs.readFileSync(original.file, "utf8"), original.source);
});
