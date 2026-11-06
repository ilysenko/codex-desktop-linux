"use strict";
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const vm = require("node:vm");
const fixture = fs.readFileSync(path.join(__dirname, "fixtures/current-native-applications.js"), "utf8");
const { applyNativeApplicationsPatch: patch } = require("./native-applications.js");

test("current signed native Applications factory has a Linux metadata implementation", () => {
  const patched = patch(fixture);
  assert.notEqual(patched, fixture);
  assert.doesNotThrow(() => new vm.Script(patched));
  assert.equal(patch(patched), patched);
});

function metadataService(platform, { windows = [{ app_id: "org.editor", wm_class: "Editor", title: "Document", window_id: 42, focused: true }], backendFailure = false } = {}, isolated = null) {
  const calls = [];
  const desktop = "/xdg/applications/org.editor.desktop";
  const icon = "/icons/editor.svg";
  const fsMock = {
    constants: { X_OK: 1 }, accessSync: () => {},
    existsSync: file => ["/backend", "/xdg/applications", desktop, icon].includes(file),
    readdirSync: () => [{ name: "org.editor.desktop", isDirectory: () => false, isFile: () => true }],
    readFileSync: file => {
      if (file === desktop) return "[Desktop Entry]\nName=Editor\nIcon=/icons/editor.svg\nStartupWMClass=Editor\n";
      assert.equal(file, icon);
      return Buffer.from("<svg/>");
    },
  };
  const native = { list: async () => [{ bundleId: "official-app" }], findById: async id => ({ bundleId: id, displayName: "Official" }) };
  const modules = {
    "node:fs": fsMock, "node:path": path, "node:os": { homedir: () => "/home/test" },
    "node:child_process": { spawnSync: (file, args, options) => {
      calls.push({ file, args: Array.from(args) });
      assert.equal(options.timeout, 2500);
      return backendFailure ? { status: 1, stdout: "" } : { status: 0, stdout: JSON.stringify({ windows }) };
    } },
  };
  const context = {
    require: name => modules[name], Buffer,
    process: { platform, env: { HOME: "/home/test", XDG_DATA_HOME: "/xdg", XDG_DATA_DIRS: "/empty", CODEX_LINUX_COMPUTER_USE_BACKEND_SOURCE: "/backend" } },
    catalog: native, cachedApp: async () => null, mediumIcon: async () => "official-medium", smallIcon: async () => "official-small",
    prefixOptions: {}, AppHost: class { constructor(options) { Object.assign(this, options); } },
    VisualizationApi: class {}, exports: {},
  };
  context.globalThis = context;
  if (isolated) {
    Object.assign(context, isolated.bindings(native));
    // Execute only the extracted ordinary platform factory with inert modules.
    return { service: vm.runInNewContext(isolated.runtime + ";(" + isolated.expression + ")", context), native, calls };
  }
  vm.runInNewContext(patch(fixture), context);
  Object.values(context.exports.modules)[0]({}, {}, () => { throw Error("unexpected module require"); });
  return { service: context.makeNativeApplications(), native, calls };
}

test("Linux native metadata uses direct arrays, nullable lookup, and both icon sizes", async () => {
  const { service, calls } = metadataService("linux");
  const apps = await service.list({ order: "display-name", lastUsedWithinDays: 14 });
  assert.equal(Array.isArray(apps), true);
  assert.equal(apps.length, 1);
  assert.equal(apps[0].bundleId, "org.editor");
  assert.equal(apps[0].appPath, "/xdg/applications/org.editor.desktop");
  assert.equal(apps[0].displayName, "Editor");
  assert.equal((await service.getByBundleId("ORG.EDITOR")).windowId, 42);
  assert.equal(await service.getByBundleId("missing"), null);
  assert.equal(await service.getByBundleId({ appPath: "/secret" }), null);
  for (const size of ["small", "medium"]) {
    const icon = await service.getIcon({ appPath: apps[0].appPath, size });
    if (size === "medium") {
      assert.equal(icon.iconSmall, null);
      assert.equal(icon.iconMedium, "data:image/svg+xml;base64,PHN2Zy8+");
    } else assert.equal(icon.iconSmall, "data:image/svg+xml;base64,PHN2Zy8+");
  }
  assert(calls.length > 0);
  for (const call of calls) assert.deepEqual(call, { file: "/backend", args: ["windows"] });
});

test("native macOS and Windows metadata services remain unchanged", async () => {
  for (const platform of ["darwin", "win32"]) {
    const { service, native, calls } = metadataService(platform);
    assert.equal(service.list, native.list);
    assert.equal((await service.getByBundleId("official-app")).displayName, "Official");
    assert.equal((await service.getIcon({ appPath: "/official", size: "small" })).iconSmall, "official-small");
    const medium = await service.getIcon({ appPath: "/official", size: "medium" });
    assert.equal(medium.iconSmall, null);
    assert.equal(medium.iconMedium, "official-medium");
    assert.equal(calls.length, 0);
  }
  assert.equal(metadataService("freebsd").service, undefined);
});

test("Linux metadata is a bounded running-window inventory and backend failure stays empty", async () => {
  const windows = Array.from({ length: 25 }, (_, index) => ({
    app_id: `org.application${index}`, window_id: index + 1, focused: index === 24,
  }));
  const { service } = metadataService("linux", { windows });
  const apps = await service.list({ order: "usage" });
  assert.equal(apps.length, 20);
  assert.equal(apps[0].windowId, 25);
  const failed = metadataService("linux", { backendFailure: true }).service;
  assert.equal((await failed.list()).length, 0);
  assert.equal(await failed.getByBundleId("org.editor"), null);
  assert.equal((await failed.getIcon({ appPath: "linux:missing" })).iconSmall, null);
});

test("chunks without the metadata owner are left unchanged with a diagnostic", (t) => {
  const warnings = [];
  t.mock.method(console, "warn", message => warnings.push(message));
  const chunk = 'exports.ids=[87],exports.modules={1(e,t,r){"use strict";e.exports=1}};';
  assert.equal(patch(chunk), chunk);
  assert.match(warnings.join("\n"), /native Applications metadata owner/);
});

const crypto = require("node:crypto");
const os = require("node:os");
const { applyExtractedAppPatchDescriptors } = require("../../scripts/patches/engine.js");
const { loadLinuxFeaturePatchDescriptors } = require("../../scripts/lib/linux-features.js");
const { createPatchReport, captureWarnings, enabledFeatureFailuresFromReport } = require("../../scripts/lib/patch-report.js");
const { findMainProcessChunks } = require("../../scripts/patches/lib/assets.js");
const RUNTIME_HEAD = "function codexLinuxNativeApplications(){";
const LINUX_BRANCH = '/* linux-native-applications */if("linux"===process.platform)return codexLinuxNativeApplications();';
const RUNTIME_BYTES = 8379;
const RUNTIME_SHA = "e6e1dc7d391c592470a0b37a486f0219828ce042ce445145699d7056dce3ef75";

function runtimeFrom(source) {
  const at = source.indexOf(RUNTIME_HEAD);
  assert(at >= 0);
  const runtime = source.slice(at, at + RUNTIME_BYTES);
  assert.equal(Buffer.byteLength(runtime), RUNTIME_BYTES);
  assert.equal(crypto.createHash("sha256").update(runtime).digest("hex"), RUNTIME_SHA);
  return runtime;
}
function changed(source, from, to) {
  const result = source.replace(from, to);
  assert.notEqual(result, source, from);
  assert.doesNotThrow(() => new vm.Script(result), from);
  return result;
}
function refuseBoth(from, to) {
  for (const source of [fixture, patch(fixture)]) {
    assert.throws(() => patch(changed(source, from, to)), /native Applications contract drift/, from);
  }
}

test("native metadata preserves the frozen runtime and original platform expression exactly", () => {
  const patched = patch(fixture), runtime = runtimeFrom(patched);
  assert.equal(patched.replace(runtime, "").replace(LINUX_BRANCH, ""), fixture);
  assert.equal(patched.length - fixture.length, RUNTIME_BYTES + LINUX_BRANCH.length);
});

test("native metadata keeps global directive prologues and canonical factory identities", () => {
  const prologues = [
    { prefix: '"use strict";', boundary: '"use strict";' },
    { prefix: '// lead\n"first";/* between */"use strict";\n', boundary: '// lead\n"first";/* between */"use strict";' },
    { prefix: '"first"\n"use strict"\n', boundary: '"first"\n"use strict"\n' },
    ...['!globalThis.lead;', '~0;', '{};', '++globalThis.counter;', '--globalThis.counter;', '0;', 'true;', 'null;']
      .map(statement => ({ prefix: '"use strict"\n' + statement + "\n", boundary: '"use strict"\n' })),
  ];
  for (const { prefix, boundary } of prologues) {
    for (const identity of ["14630", '"14630"', "0x3926", "1.463e4"]) {
      const raw = prefix + fixture.replace("14630(e,t,r)", `${identity}(e,t,r)`);
      const patched = patch(raw), runtime = runtimeFrom(patched);
      assert(patched.indexOf(runtime) >= boundary.length);
      const sandbox = { exports: {} };
      vm.runInNewContext(patched + ";try{undeclaredStrictProbe=1;globalThis.strictProbe=false}catch{globalThis.strictProbe=true}", sandbox);
      assert.equal(sandbox.strictProbe, true);
      assert.equal(patched.replace(runtime, "").replace(LINUX_BRANCH, ""), raw);
      assert.equal(patch(patched), patched);
      assert.doesNotThrow(() => new vm.Script(patched));
    }
  }
  for (const continuation of ["+1", "(function(){})", "`tagged`", ".length", "[0]"]) {
    const raw = '"use strict"\n' + continuation + ";" + fixture;
    const patched = patch(raw), runtime = runtimeFrom(patched);
    assert(patched.startsWith(runtime));
    assert.equal(patched.replace(runtime, "").replace(LINUX_BRANCH, ""), raw);
    assert.equal(patch(patched), patched);
  }
});

test("native metadata requires the provider's ordinary local platform factory and direct binding", () => {
  for (const pair of [
    ["nativeApplications=function(){", "nativeApplications=async function(){"],
    ["nativeApplications=function(){", "nativeApplications=function*(){"],
    ["iconSmall:await smallIcon(e)}}}();", "iconSmall:await smallIcon(e)}}}()&&other;"],
    ["({globalState:this.scopedState})}createAppHost", "({globalState:this.scopedState})&&other}createAppHost"],
    ["return Promise.resolve().catch", "nativeApplications=other;return Promise.resolve().catch"],
    ["return Promise.resolve().catch", "let alias=nativeApplications;return Promise.resolve().catch"],
    ["nativeApplications:nativeApplications,workspaceRoots", "nativeApplications:other,workspaceRoots"],
    ["nativeApplications:nativeApplications,workspaceRoots", "nativeApplications:nativeApplications,nativeApplications:other,workspaceRoots"],
    ["nativeApplications:nativeApplications,workspaceRoots", "nativeApplications,workspaceRoots"],
    ["iconSmall:null,iconMedium:", "iconSmall:undefined,iconMedium:"],
    ["globalState:this.scopedState", "globalState:other"],
    ["this.desktopServices=function(", "this.desktopServices=async function("],
    ["this.desktopServices=function(", "this.desktopServices=function*("],
  ]) refuseBoth(...pair);
  const shadowed = changed(changed(fixture, "let globalStateService=state", "var globalStateService=state"),
    "callback=()=>({})", "callback=()=>({}),nativeApplications");
  assert.throws(() => patch(shadowed), /native Applications contract drift/);
});

test("native metadata requires the constructed instance's ordinary returned AppHost exposure", () => {
  for (const pair of [
    ["nativeApplications:this.desktopServices.nativeApplications", "nativeApplications:this.other.nativeApplications"],
    ["createAppHost(e){", "async createAppHost(e){"],
    ["createAppHost(e){", "*createAppHost(e){"],
    ["createAppHost(e){", "createAppHost=()=>other;createAppHost(e){"],
    ["createAppHost(e){", "createAppHost(){return other}createAppHost(e){"],
    ["createAppHost(e){", "get desktopServices(){return other}createAppHost(e){"],
    ["createAppHost(e){let side", String.raw`createAppHost(e){this.\u0064esktopServices={nativeApplications:null};let side`],
    ["createAppHost(e){let side", String.raw`createAppHost(e){this.desktopServices.\u006eativeApplications=null;let side`],
    ["constructor(){this.scopedState", "constructor(){this.createAppHost=()=>({nativeApplications:null});this.scopedState"],
    ["constructor(){this.scopedState", "constructor(){this /* receiver */ . createAppHost=()=>({nativeApplications:null});this.scopedState"],
    ["createAppHost(e){let side", "createAppHost(e){this /* receiver */ . desktopServices={nativeApplications:null};let side"],
    ["createAppHost(e){let side", "createAppHost(e){this.desktopServices /* receiver */ . nativeApplications=null;let side"],
    ["constructor(){this.scopedState", String.raw`constructor(){this.\u0063reateAppHost=()=>({nativeApplications:null});this.scopedState`],
    ["return new AppHost({", "return other,new AppHost({"],
    ["...this.visualizations.createServices(e,()=>{})})", "...this.visualizations.createServices(e,()=>{})}),other"],
    ["createAppHost(e){let side", "createAppHost(e){this.desktopServices=other;let side"],
    ["createAppHost(e){let side", "createAppHost(e){this.desktopServices.nativeApplications=other;let side"],
    ["globalThis.makeNativeApplications=()", "TestApplication=other;globalThis.makeNativeApplications=()"],
    ["globalThis.makeNativeApplications=()", "let alias=TestApplication;globalThis.makeNativeApplications=()"],
  ]) refuseBoth(...pair);
  const decoy = fixture.replace("nativeApplications:this.desktopServices.nativeApplications", "nativeApplications:other")
    .replace("globalThis.makeNativeApplications=()", "function expose(){return{nativeApplications:this.desktopServices.nativeApplications}}globalThis.makeNativeApplications=()");
  assert.doesNotThrow(() => new vm.Script(decoy));
  assert.throws(() => patch(decoy), /native Applications contract drift/);
});

test("native metadata proves that every AppHost spread after its explicit edge cannot override it", () => {
  for (const pair of [
    ["...{pageCreationIntents:null}", "...unknownOptions"],
    ["...{pageCreationIntents:null}", "...{nativeApplications:other}"],
    ["...(side=this.options,{textGeneration:null})", "...(side=this.options,{nativeApplications:other})"],
    ["{cloudThreadAttachments:this.cloudThreadAttachments}", "{nativeApplications:other}"],
    ["...null==side?{}:{cloudThreadSampling:side}", "...null==side?{nativeApplications:other}:{cloudThreadSampling:side}"],
    ["systemPermissions:null,globalDictationHotkeys:void 0", "nativeApplications:other,globalDictationHotkeys:void 0"],
    ["dictation=function(", "dictation=async function("],
    ["dictation=function(", "dictation=function*("],
    ["return new AppHost({", "dictation=other;return new AppHost({"],
    ["return{visualizations:new VisualizationApi(e)}", "return{nativeApplications:other}"],
    ["createServices(e,t){", "async createServices(e,t){"],
    ["createServices(e,t){", "*createServices(e,t){"],
    ["createAppHost(e){let side", "createAppHost(e){this.visualizations=other;let side"],
    ["createAppHost(e){", "get visualizations(){return other}createAppHost(e){"],
    ["globalThis.makeNativeApplications=()", "VisualizationServices=other;globalThis.makeNativeApplications=()"],
  ]) refuseBoth(...pair);
});

test("native metadata requires the complete canonical runtime at its directive-safe location", () => {
  const patched = patch('"use strict";' + fixture), runtime = runtimeFrom(patched);
  for (const source of [
    patched.replace(runtime, ""),
    patched.replace(LINUX_BRANCH, ""),
    patched.replace("list:async(e={})", "list:async(e=other)"),
    runtime + patched,
    runtime + patched.replace(runtime, ""),
    patched + ";codexLinuxNativeApplications=other;",
    patched + ";let alias=codexLinuxNativeApplications;",
    patched + ";codexLinuxNativeApplications();",
    patched + ";function shadow(codexLinuxNativeApplications){return codexLinuxNativeApplications()}",
  ]) {
    assert.doesNotThrow(() => new vm.Script(source));
    assert.throws(() => patch(source), /native Applications contract drift/);
  }
});

function extractedWorkspace(t, sources, enabled = true) {
  const scratch = path.join(process.env.XDG_CACHE_HOME || path.join(os.homedir(), ".cache"), "codex-desktop-dev", "tmp");
  fs.mkdirSync(scratch, { recursive: true });
  const root = fs.mkdtempSync(path.join(scratch, "native-applications-owner-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const config = path.join(root, "features.json");
  fs.writeFileSync(config, JSON.stringify({ enabled: enabled ? ["computer-use-linux"] : [] }));
  const loaded = loadLinuxFeaturePatchDescriptors({ featuresRoot: path.join(__dirname, ".."), featuresConfigPath: config })
    .filter(item => item.id === "feature:computer-use-linux:native-applications");
  const files = Object.entries(sources).map(([name, source]) => {
    const file = path.join(root, ".vite/build", name);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, source);
    return { file, source };
  });
  const run = () => {
    const report = createPatchReport();
    report.enabledFeatures = enabled ? ["computer-use-linux"] : [];
    captureWarnings(() => applyExtractedAppPatchDescriptors(root, loaded, {}, report, "extracted-app:pre-webview"));
    return report;
  };
  return { root, files, loaded, run };
}
function assertNoWrites(project) {
  for (const { file, source } of project.files) assert.equal(fs.readFileSync(file, "utf8"), source);
}

test("registered native metadata descriptor applies once through the feature-owned extracted entry", t => {
  const project = extractedWorkspace(t, { "early-bootstrap.js": "const entry=true;", "early-bootstrap-747-abcdef12.js": fixture });
  assert.equal(project.loaded.length, 1);
  assert.equal(project.loaded[0].phase, "extracted-app:pre-webview");
  assert.equal(project.loaded[0].order, 20_130);
  assert.equal(project.run().patches[0].status, "applied");
  assert.equal(fs.readFileSync(project.files[1].file, "utf8"), patch(fixture));
  assert.equal(project.run().patches[0].status, "already-applied");
});

test("registered native metadata descriptor refuses missing, duplicate, mixed and hidden damaged cohorts before writes", t => {
  const patched = patch(fixture), hidden = fixture.replaceAll("nativeApplications", "otherApplications").replaceAll("desktopServices", "otherServices");
  for (const sources of [
    { "early-bootstrap.js": "const entry=true;" },
    { "early-bootstrap-747-abcdef12.js": fixture, "early-bootstrap-999-abcdef12.js": fixture },
    { "early-bootstrap-747-abcdef12.js": fixture, "early-bootstrap-999-abcdef12.js": patched },
    { "early-bootstrap-747-abcdef12.js": patched, "early-bootstrap-999-abcdef12.js": patched },
    { "early-bootstrap-747-abcdef12.js": fixture, "early-bootstrap-999-abcdef12.js": hidden },
    { "early-bootstrap-747-abcdef12.js": fixture, "early-bootstrap-999-abcdef12.js": hidden.replace("14630(e,t,r)", '"14630"(e,t,r)') },
    { "early-bootstrap-747-abcdef12.js": fixture, "early-bootstrap-999-abcdef12.js": fixture.replace("14630(e,t,r)", "14631(e,t,r)") },
    { "early-bootstrap-747-abcdef12.js": patched, "early-bootstrap-999-abcdef12.js": hidden },
  ]) {
    const project = extractedWorkspace(t, sources);
    assert.equal(enabledFeatureFailuresFromReport(project.run()).length, 1);
    assertNoWrites(project);
  }
});

test("registered native metadata descriptor rolls back a truncated owner write", t => {
  const project = extractedWorkspace(t, { "early-bootstrap-747-abcdef12.js": fixture });
  const originalWrite = fs.writeFileSync;
  let failed = false;
  t.mock.method(fs, "writeFileSync", (file, bytes, ...args) => {
    if (file === project.files[0].file && !failed) {
      failed = true;
      originalWrite(file, "truncated");
      throw new Error("injected native metadata write failure");
    }
    return originalWrite(file, bytes, ...args);
  });
  assert.equal(enabledFeatureFailuresFromReport(project.run()).length, 1);
  assert.equal(failed, true);
  assertNoWrites(project);
});

test("disabled native metadata feature performs zero main-process discovery", t => {
  const project = extractedWorkspace(t, {}, false);
  assert.deepEqual(project.loaded, []);
  let discovered = false;
  t.mock.method(fs, "readdirSync", () => { discovered = true; throw new Error("unexpected main-process inventory"); });
  assert.deepEqual(project.run().patches, []);
  assert.equal(discovered, false);
});

test("latest signed native metadata applies through all nineteen main chunks and preserves signed inputs", {
  skip: !process.env.CODEX_SIGNED_EXTRACTED_APP,
}, t => {
  const inventory = findMainProcessChunks(process.env.CODEX_SIGNED_EXTRACTED_APP);
  assert.equal(inventory.chunks.length, 19);
  const sources = Object.fromEntries(inventory.chunks.map(name => [name, fs.readFileSync(path.join(inventory.buildDir, name), "utf8")]));
  const project = extractedWorkspace(t, sources);
  assert.equal(project.run().patches[0].status, "applied");
  const changedFiles = project.files.filter(({ file, source }) => fs.readFileSync(file, "utf8") !== source);
  assert.equal(changedFiles.length, 1);
  const [{ file, source }] = changedFiles, patched = fs.readFileSync(file, "utf8"), runtime = runtimeFrom(patched);
  assert.equal(patched, patch(source));
  assert.equal(patched.replace(runtime, "").replace(LINUX_BRANCH, ""), source);
  assert.equal(project.run().patches[0].status, "already-applied");
  assert.doesNotThrow(() => new vm.Script(patched));
  for (const [name, original] of Object.entries(sources)) assert.equal(fs.readFileSync(path.join(inventory.buildDir, name), "utf8"), original);
});

test("latest signed native metadata rejects hidden same-ID siblings and disconnected exposed edge with zero writes", {
  skip: !process.env.CODEX_SIGNED_EXTRACTED_APP,
}, t => {
  const inventory = findMainProcessChunks(process.env.CODEX_SIGNED_EXTRACTED_APP);
  const sources = Object.fromEntries(inventory.chunks.map(name => [name, fs.readFileSync(path.join(inventory.buildDir, name), "utf8")]));
  const [ownerName, owner] = Object.entries(sources).find(([, source]) => source.includes("nativeApplications:this.desktopServices.nativeApplications"));
  const hidden = owner.replaceAll("nativeApplications", "otherApplications").replaceAll("desktopServices", "otherServices");
  const hiddenProject = extractedWorkspace(t, { ...sources, "early-bootstrap-999-abcdef12.js": hidden });
  assert.equal(enabledFeatureFailuresFromReport(hiddenProject.run()).length, 1);
  assertNoWrites(hiddenProject);
  for (const raw of [owner, patch(owner)]) {
    const bad = changed(raw, "nativeApplications:this.desktopServices.nativeApplications", "nativeApplications:this.other.nativeApplications");
    const project = extractedWorkspace(t, { ...sources, [ownerName]: bad });
    assert.equal(enabledFeatureFailuresFromReport(project.run()).length, 1);
    assertNoWrites(project);
  }
  for (const [name, original] of Object.entries(sources)) assert.equal(fs.readFileSync(path.join(inventory.buildDir, name), "utf8"), original);
});

test("latest actual ordinary platform factory retains direct arrays, native pointers and unsupported-platform result", {
  skip: !process.env.CODEX_SIGNED_EXTRACTED_APP,
}, async () => {
  const { createJavaScriptLexicalIndex } = require("../../scripts/patches/lib/minified-js.js");
  const inventory = findMainProcessChunks(process.env.CODEX_SIGNED_EXTRACTED_APP);
  const actual = inventory.chunks.map(name => fs.readFileSync(path.join(inventory.buildDir, name), "utf8"))
    .find(source => source.includes("nativeApplications:this.desktopServices.nativeApplications"));
  const patched = patch(actual), lexical = createJavaScriptLexicalIndex(patched), runtime = runtimeFrom(patched);
  const heads = [...patched.matchAll(/(?<![\w$.])([A-Za-z_$][\w$]*)=function\(\)\{\/\* linux-native-applications \*\//gu)]
    .filter(match => lexical.isCode(match.index));
  assert.equal(heads.length, 1);
  const [head] = heads, start = head.index + head[0].indexOf("function"), open = head.index + head[0].indexOf("{");
  const close = lexical.matchingBrace(open);
  assert.equal(patched.slice(close + 1, close + 3), "()");
  const expression = patched.slice(start, close + 3);
  const native = /getByBundleId:async (?<argument>[A-Za-z_$][\w$]*)=>await (?<cache>[A-Za-z_$][\w$]*)\(\k<argument>\)\?\?await \(0,(?<module>[A-Za-z_$][\w$]*)\.(?<lookup>[A-Za-z_$][\w$]*)\)\(\k<argument>\),list:\k<module>\.(?<list>[A-Za-z_$][\w$]*),getIcon:async\(\{appPath:(?<app>[A-Za-z_$][\w$]*),size:(?<size>[A-Za-z_$][\w$]*)\}\)=>"medium"===\k<size>\?\{iconSmall:null,iconMedium:await (?<medium>[A-Za-z_$][\w$]*)\(\k<app>\)\}:\{iconSmall:await (?<small>[A-Za-z_$][\w$]*)\(\k<app>\)\}/u.exec(expression);
  assert(native, "Expected the original current native collaborators");
  const isolated = { runtime, expression, bindings: service => ({
    [native.groups.cache]: async () => null,
    [native.groups.module]: { [native.groups.lookup]: service.findById, [native.groups.list]: service.list },
    [native.groups.medium]: async () => "official-medium",
    [native.groups.small]: async () => "official-small",
  }) };
  const linux = metadataService("linux", {}, isolated);
  const apps = await linux.service.list();
  assert.equal(Array.isArray(apps), true);
  assert.equal(apps[0].bundleId, "org.editor");
  assert.equal(await linux.service.getByBundleId("missing"), null);
  assert.equal((await linux.service.getIcon({ appPath: apps[0].appPath, size: "medium" })).iconMedium,
    "data:image/svg+xml;base64,PHN2Zy8+");
  for (const platform of ["darwin", "win32"]) {
    const result = metadataService(platform, {}, isolated);
    assert.equal(result.service.list, result.native.list);
    assert.equal((await result.service.getByBundleId("official-app")).displayName, "Official");
    assert.equal((await result.service.getIcon({ appPath: "/official", size: "small" })).iconSmall, "official-small");
    assert.equal((await result.service.getIcon({ appPath: "/official", size: "medium" })).iconMedium, "official-medium");
    assert.equal(result.calls.length, 0);
  }
  assert.equal(metadataService("freebsd", {}, isolated).service, undefined);
});
