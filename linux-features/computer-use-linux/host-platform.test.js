"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const vm = require("node:vm");
const descriptors = require("./patch.js");
const { applyLinuxComputerUseHostPlatformPatch: patch, matchesLinuxComputerUseHostPlatformContract: matches } = require("./host-platform.js");
const { createPatchReport } = require("../../scripts/lib/patch-report.js");
const { applyWebviewAssetPatchDescriptors } = require("../../scripts/patches/engine.js");
const { listWebviewAssetFiles } = require("../../scripts/patches/lib/assets.js");
const { javascriptSourceParses } = require("../../scripts/patches/lib/javascript-syntax.js");

// The current signed evaluator is inline. Its input uses the same platform and
// loading state returned by the platform hook; feature queries keep hostId.
const evaluator = 'function({areRequirementsPending:e,areRequiredFeaturesEnabled:t,enabled:n,isBrowserAndComputerUseAllowed:r,isAnyFeatureLoading:i,isComputerUseGateEnabled:a,isHostCompatiblePlatform:s,isPlatformLoading:o,windowType:l}){return n?"electron"!==l?"window-type-disabled":e?"loading":r?a?o?"loading":s?i?"loading":t?"available":"config-requirement-disabled":"unsupported-platform":"statsig-disabled":"config-requirement-disabled":"disabled"}';
const source = `function owner(options){let {pending,features,enabled,allowed,loading,gate,hostId}=options,{isLoading:platformLoading,platform:platform}=(0,platformApi.V)(),feature={enabled:enabled,featureName:"computer_use",hostId:hostId},result=${evaluator}({areRequirementsPending:pending,areRequiredFeaturesEnabled:features,enabled:enabled,isBrowserAndComputerUseAllowed:allowed,isAnyFeatureLoading:loading,isComputerUseGateEnabled:gate,isHostCompatiblePlatform:"macOS"===platform||"windows"===platform,isPlatformLoading:platformLoading,windowType:"electron"});return {result,feature}}`;

function expected(platform, { pending, features, enabled, allowed, loading, gate, platformLoading }) {
  if (!enabled) return "disabled";
  if (pending) return "loading";
  if (!allowed) return "config-requirement-disabled";
  if (!gate) return "statsig-disabled";
  if (platformLoading) return "loading";
  if (!["linux", "macOS", "windows"].includes(platform)) return "unsupported-platform";
  if (loading) return "loading";
  return features ? "available" : "config-requirement-disabled";
}

test("current inline host gate supports Linux and preserves every availability prerequisite", () => {
  const patched = patch(source);
  assert.equal(matches(source), true);
  assert.equal(matches(patched), true);
  assert.equal(patch(patched), patched);
  assert.equal(patched.replace('"linux"===platform||', ""), source);
  assert.equal(javascriptSourceParses(patched), true);
  const fields = ["pending", "features", "enabled", "allowed", "loading", "gate", "platformLoading"];
  for (const platform of ["linux", "macOS", "windows", "unknown"]) {
    for (let bits = 0; bits < 2 ** fields.length; bits += 1) {
      const options = Object.fromEntries(fields.map((key, index) => [key, Boolean(bits & (1 << index))]));
      for (const hostId of ["local", "ssh-remote"]) {
        options.hostId = hostId;
        const result = vm.runInNewContext(`${patched};owner(options)`, {
          options, platformApi: { V: () => ({ platform, isLoading: options.platformLoading }) },
        });
        assert.equal(result.result, expected(platform, options));
        assert.equal(result.feature.hostId, hostId);
        assert.equal(result.feature.enabled, options.enabled);
      }
    }
  }
});

test("host platform rejects retired, missing, ambiguous, partial, and changed variable relationships", () => {
  const patched = patch(source);
  const damaged = patched.replace('"linux"===platform', '"linux"===other');
  for (const current of [
    "function unrelated(){}",
    source + source,
    patched + source,
    source + patched,
    patched + patched,
    patched + damaged,
    damaged,
    source.replace('"windows"===platform', '"windows"===other'),
    source.replace('isPlatformLoading:platformLoading', 'isPlatformLoading:other'),
    source.replace('featureName:"computer_use"', 'featureName:"browser_use_external"'),
    source.replace('return n?', 'return !0?'),
    source.replace(evaluator, "evaluate"),
    source.replace('windowType:"electron"', 'windowType:"chrome-extension"'),
  ]) {
    assert.notEqual(current, source);
    assert.equal(matches(current), false);
    assert.throws(() => patch(current), /host-platform contract/);
  }
});

function workspace(t) {
  const cache = path.join(process.env.XDG_CACHE_HOME || path.join(os.homedir(), ".cache"), "codex-desktop-dev");
  fs.mkdirSync(cache, { recursive: true });
  const root = fs.mkdtempSync(path.join(cache, "cua-host-platform-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const assets = path.join(root, "webview", "assets");
  const write = (name, text) => {
    const file = path.join(assets, name);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, text);
    return file;
  };
  const run = () => {
    const report = createPatchReport();
    applyWebviewAssetPatchDescriptors(root, [descriptors.find(({ id }) => id === "host-platform")], {}, report);
    return report.patches[0];
  };
  return { write, run };
}

test("host production descriptor handles nested numeric owners and fails closed without writes", t => {
  t.mock.method(console, "warn", () => {});
  const { write, run } = workspace(t);
  const owner = write("async/24191.hash.js", source);
  const other = write("other/24191.hash.js", "function unrelated(){}");
  assert.equal(run().status, "applied");
  const patched = fs.readFileSync(owner, "utf8");
  assert.equal(run().status, "already-applied");
  fs.writeFileSync(other, source);
  assert.equal(run().status, "skipped-optional");
  assert.equal(fs.readFileSync(owner, "utf8"), patched);
  assert.equal(fs.readFileSync(other, "utf8"), source);
  fs.writeFileSync(other, "function unrelated(){}");
  const partial = patched.replace('"linux"===platform', '"linux"===other');
  fs.writeFileSync(owner, partial);
  assert.equal(run().status, "skipped-optional");
  assert.equal(fs.readFileSync(owner, "utf8"), partial);
});

test("host production descriptor patches the current signed inline owner on an independent copy", {
  skip: !process.env.CODEX_SIGNED_EXTRACTED_APP,
}, t => {
  const upstream = path.join(process.env.CODEX_SIGNED_EXTRACTED_APP, "webview", "assets");
  const owners = listWebviewAssetFiles(upstream, /\.js$/).map(assetName => ({assetName,source:fs.readFileSync(path.join(upstream,assetName),"utf8")})).filter(({source}) => matches(source));
  assert.equal(owners.length,1);
  const {assetName,source:actual}=owners[0];
  const { write, run } = workspace(t);
  const file = write(assetName, actual);
  const result = run();
  assert.equal(result.status, "applied");
  assert.equal(result.assetName, assetName);
  const patched = fs.readFileSync(file, "utf8");
  assert.notEqual(patched, actual);
  assert.equal(javascriptSourceParses(patched), true);
  assert.equal(run().status, "already-applied");
  assert.equal(fs.readFileSync(path.join(upstream, assetName), "utf8"), actual);
});


test("host platform accepts the current inline export only with its real publication authority", t => {
  t.mock.method(console,"warn",()=>{});
  const body = `n.d(t,{},{gate:${source.replace("function owner", "function")}})`;
  const chunk = text => `export const __rspack_esm_ids=[1];export const __webpack_modules__={Host(e,t,n){${text}}};`;
  const original = chunk(body), changed = patch(original);
  assert.notEqual(changed,original);
  assert.equal(patch(changed),changed);
  assert.equal(changed.replace('"linux"===platform||',""),original);
  for (const text of [body.replace("n.d(t,","n.d(other,"),body.replace("n.d(t,","other.d(t,"),"({n}=other);"+body,"({t}=other);"+body]) {
    const input=chunk(text);assert.equal(matches(input),false);assert.throws(()=>patch(input),/host-platform contract/);
  }
});
