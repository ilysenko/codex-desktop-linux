"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const vm = require("node:vm");
const { applyPreferredEditorFileLinks: apply } = require("./patch.js");
const { loadLinuxFeaturePatchDescriptors } = require("../../scripts/lib/linux-features.js");
const { applyWebviewAssetPatchDescriptors } = require("../../scripts/patches/engine.js");
const { createPatchReport, captureWarnings, enabledFeatureFailuresFromReport } = require("../../scripts/lib/patch-report.js");

// File-reference dispatch contract; upstream minified names are deliberately
// replaced by descriptive aliases. The callback before it handles directories
// and artifact-template skills; the callback after it handles modified clicks.
const fixture = "function click(file,modified,browser=false){if(directory){explicit();return}if(artifactHandled){artifactOpen();return}if(panel&&!browser&&!modified){open({scope:scope,activatePresentationAnnotationOnboarding:!0,artifactNavigationTarget:artifact,path:file,line:line,column:column,cwd:cwd,hostConfig:host,hostId:hostId,endLine:endLine,isPreview:preview,openInSidePanel:sidePanel,onOpenTargetResolved:resolved});return}fallback()}/*data-file-reference*/";

function harness(source = apply(fixture)) {
  const calls = [];
  const context = {
    panel: true, sidePanel: true, directory: false, artifactHandled: false,
    scope: {}, artifact: {}, line: 12, column: 7, cwd: "/repo",
    host: { id: "remote" }, hostId: "remote", endLine: 13,
    preview: true, resolved: () => {},
    open: args => calls.push(args), fallback: () => calls.push("fallback"),
    explicit: () => calls.push("directory"), artifactOpen: () => calls.push("artifact"),
  };
  vm.runInNewContext(source, context);
  return { calls, context };
}

test("source links bypass the panel and preserve the full location without forcing a target", () => {
  const baseline = harness(fixture);
  baseline.context.click("/repo/main.rs", false);
  assert.equal(baseline.calls[0].openInSidePanel, true);
  const { calls, context } = harness();
  for (const file of ["/repo/main.rs", "/repo/space here/a.ts", "/repo/README", "relative/main.py", "/repo/a.md"]) {
    context.click(file, false);
    const args = calls.at(-1);
    assert.equal(args.path, file);
    assert.equal(args.openInSidePanel, false);
    assert.equal(Object.hasOwn(args, "target"), false);
    assert.equal(Object.hasOwn(args, "activatePresentationAnnotationOnboarding"), false);
    for (const key of ["scope", "line", "column", "cwd", "hostId", "endLine"]) assert.equal(args[key], context[key]);
    assert.equal(args.hostConfig, context.host);
    assert.equal(args.onOpenTargetResolved, context.resolved);
  }
});

test("the 26.908.61612 resolver fixture follows preference changes between clicks", () => {
  // Verbatim preference functions from official Linux 26.908.61612 with the
  // preference-store read stubbed below. This fixture does not validate the
  // resolver in future bundles; official-code VM acceptance is a separate check.
  const resolve = vm.runInNewContext("function I0(e,t,n){let r=L0(e,t);return r&&n.has(r)?r:n.values().next().value??null}function L0(e,t){let n=P0(e);return(t?n.perPath?.[t]:void 0)??n.global??null}I0", { P0: value => value });
  const { calls, context } = harness();
  const preferences = { global: "zed", perPath: {} };
  const available = new Set(["zed", "vscode", "cursor"]);
  const chosen = [];
  context.open = args => {
    calls.push(args);
    chosen.push(args.target ?? resolve(preferences, args.cwd, available));
  };
  context.click("/repo/main.rs", false);
  preferences.global = "vscode";
  context.click("/repo/main.rs", false);
  preferences.perPath["/repo"] = "cursor";
  context.click("/repo/main.rs", false);
  assert.deepEqual(chosen, ["zed", "vscode", "cursor"]);
  available.delete("cursor");
  context.click("/repo/main.rs", false);
  assert.equal(chosen.at(-1), "zed"); // Existing available-target fallback.
});

test("previews, modifiers, directories and artifact-template routes remain unchanged", () => {
  const { calls, context } = harness();
  for (const file of ["/repo/a.html", "/repo/a.png", "/repo/a.pdf", "/repo/a.xlsx", "/repo/a.unknown"]) {
    context.click(file, false);
    assert.equal(calls.at(-1).openInSidePanel, true);
  }
  context.click("/repo/main.rs", true);
  assert.equal(calls.at(-1), "fallback");
  context.click("https://example.test/main.rs", false, true);
  assert.equal(calls.at(-1), "fallback");
  context.directory = true;
  context.click("/repo/directory.rs", false);
  assert.equal(calls.at(-1), "directory");
  context.directory = false;
  context.artifactHandled = true;
  context.click("/repo/main.rs", false);
  assert.equal(calls.at(-1), "artifact");
});

test("idempotence and minified alias changes", () => {
  const patched = apply(fixture);
  assert.equal(apply(patched), patched);
  const renamed = fixture.replace(/\bfile\b/g, "minifiedPath");
  const { calls, context } = harness(apply(renamed));
  context.click("/repo/main.rs", false);
  assert.equal(calls[0].path, "/repo/main.rs");
  assert.equal(calls[0].openInSidePanel, false);
});

test("missing, duplicate, changed and partially patched contracts fail closed", () => {
  for (const source of ["", fixture + fixture, fixture.replace("onOpenTargetResolved", "changed"), fixture.replace("hostConfig:host,", ""), "/*preferred-editor-file-links*/" + fixture, apply(fixture) + fixture]) {
    const result = captureWarnings(() => apply(source));
    assert.equal(result.value, source);
    assert.equal(result.warnings.length, 1);
    assert.match(result.warnings[0], /Disable preferred-editor-file-links and rebuild/);
  }
});

test("optional feature discovery and enabled drift reporting", () => {
  assert.equal(require("./feature.json").defaultEnabled, false);
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), "preferred-editor-links-"));
  try {
    const config = path.join(temp, "features.json");
    const assets = path.join(temp, "webview", "assets");
    fs.mkdirSync(assets, { recursive: true });
    const options = { featuresRoot: path.join(__dirname, ".."), featuresConfigPath: config };
    fs.writeFileSync(config, JSON.stringify({ enabled: [] }));
    assert.deepEqual(loadLinuxFeaturePatchDescriptors(options), []);
    fs.writeFileSync(config, JSON.stringify({ enabled: ["preferred-editor-file-links"] }));
    const descriptors = loadLinuxFeaturePatchDescriptors(options);
    assert.equal(descriptors.length, 1);
    const file = path.join(assets, "app-primary-newhash.js");
    for (const scenario of ["valid", "already", "missing", "drift", "ambiguous"]) {
      for (const name of fs.readdirSync(assets)) fs.unlinkSync(path.join(assets, name));
      const source = scenario === "already" ? apply(fixture) : scenario === "drift" ? fixture.replace("hostConfig:host,", "") : fixture;
      if (scenario !== "missing") fs.writeFileSync(file, source);
      if (scenario === "ambiguous") fs.writeFileSync(path.join(assets, "other.js"), source);
      const report = createPatchReport();
      report.enabledFeatures = ["preferred-editor-file-links"];
      captureWarnings(() => applyWebviewAssetPatchDescriptors(temp, descriptors, {}, report));
      if (["valid", "already"].includes(scenario)) {
        assert.equal(enabledFeatureFailuresFromReport(report).length, 0);
        assert.equal(fs.readFileSync(file, "utf8"), apply(fixture));
      } else {
        assert.equal(enabledFeatureFailuresFromReport(report).length, 1);
        if (scenario !== "missing") assert.equal(fs.readFileSync(file, "utf8"), source);
      }
    }
  } finally {
    fs.rmSync(temp, { recursive: true, force: true });
  }
});
