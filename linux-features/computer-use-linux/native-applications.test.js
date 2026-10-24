"use strict";
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const vm = require("node:vm");
const descriptors = require("./patch.js");
const fixture = fs.readFileSync(path.join(__dirname, "fixtures/current-native-applications.js"), "utf8");
const patch = source => descriptors.find(({ id }) => id === "native-applications")?.apply(source) ?? source;

test("current signed native Applications factory has a Linux metadata implementation", () => {
  const patched = patch(fixture);
  assert.notEqual(patched, fixture);
  assert.doesNotThrow(() => new vm.Script(patched));
  assert.equal(patch(patched), patched);
});

function metadataService(platform, { windows = [{ app_id: "org.editor", wm_class: "Editor", title: "Document", window_id: 42, focused: true }], backendFailure = false } = {}) {
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
  const factory = vm.runInNewContext(`${patch(fixture)};makeNativeApplications`, {
    require: name => modules[name], Buffer,
    process: { platform, env: { HOME: "/home/test", XDG_DATA_HOME: "/xdg", XDG_DATA_DIRS: "/empty", CODEX_LINUX_COMPUTER_USE_BACKEND_SOURCE: "/backend" } },
    catalog: native, cachedApp: async () => null, mediumIcon: async () => "official-medium", smallIcon: async () => "official-small",
  });
  return { service: factory(), native, calls };
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

test("native metadata rejects duplicate owners and partial or damaged contracts", () => {
  const patched = patch(fixture);
  for (const changed of [
    fixture + fixture, patched + fixture, patched + patched,
    fixture.replace("nativeApplications=makeNativeApplications()", "nativeApplications=other()"),
    fixture.replace("nativeApplications:this.fetchHandler.nativeApplications", "nativeApplications:this.other.nativeApplications"),
    fixture.replace("iconSmall:null,iconMedium:", "iconSmall:undefined,iconMedium:"),
    patched.replace("list:async(e={})", "list:async(e=changed)"),
    patched.replace("if(process.platform===`linux`)return codexLinuxNativeApplications();", ""),
  ]) assert.throws(() => patch(changed), /native Applications contract drift/);
});
