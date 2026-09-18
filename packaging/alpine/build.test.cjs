"use strict";

const assert = require("node:assert/strict");
const cp = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const elf = require("../../nix/elf-runtime.cjs");
const { main: build } = require("./build.cjs");

// Real, tiny ELF fixtures, not copies of the proprietary application. No
// downloads or installed desktop are required. Only the upstream manifest and
// loader execution are substituted; copies, inventory, patchelf, and metadata
// audits run for real. verify-host.cjs covers the actual installed runtime.
function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "alpine-build-test-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const source = path.join(root, "source");
  const runtime = path.join(root, "runtime source");
  const output = path.join(root, "output with spaces");
  const lib = path.join(runtime, "root/usr/lib/x86_64-linux-gnu");
  for (const directory of [path.join(source, ".codex-linux"), path.join(source, "resources"), lib, path.join(runtime, "root/usr/share")])
    fs.mkdirSync(directory, { recursive: true });
  fs.writeFileSync(path.join(source, ".codex-linux/build-info.json"), "{}");
  fs.writeFileSync(path.join(source, "start.sh"), "#!/bin/sh\nexit 0\n", { mode: 0o755 });
  fs.writeFileSync(path.join(source, "resources/app.asar"), "fixture ASAR: preserve these bytes");
  fs.writeFileSync(path.join(runtime, "manifest.json"), JSON.stringify([{ Package: "libc6", Architecture: "amd64" }]));
  const librarySource = path.join(root, "library.c");
  const executableSource = path.join(root, "executable.c");
  const staticSource = path.join(root, "static.c");
  fs.writeFileSync(librarySource, "int sample(void) { return 42; }\n");
  fs.writeFileSync(executableSource, "extern int sample(void); void _start(void) { (void)sample(); }\n");
  fs.writeFileSync(staticSource, "void _start(void) {}\n");
  const run = (command, args) => cp.execFileSync(command, args, { encoding: "utf8" });
  run("cc", ["-shared", "-nostdlib", "-fPIC", librarySource, "-Wl,-soname,libsample.so.1", "-o", path.join(lib, "libsample.so.1")]);
  fs.symlinkSync("libsample.so.1", path.join(lib, "libsample.so"));
  run("cc", ["-shared", "-nostdlib", "-fPIC", executableSource, "-Wl,--no-as-needed", `-L${lib}`, "-l:libsample.so.1", "-o", path.join(lib, "libdependent.so")]);
  // The fixture loader is never executed. Its exclusion from library patching
  // is checked byte-for-byte below.
  fs.copyFileSync(path.join(lib, "libsample.so.1"), path.join(lib, "ld-linux-x86-64.so.2"));
  run("cc", ["-pie", "-nostdlib", executableSource, "-Wl,--dynamic-linker,/lib64/ld-linux-x86-64.so.2", `-L${lib}`, "-l:libsample.so.1", "-o", path.join(source, "fixture-app")]);
  run("cc", ["-pie", "-nostdlib", executableSource, "-Wl,--dynamic-linker,/lib/ld-musl-x86_64.so.1", `-L${lib}`, "-l:libsample.so.1", "-o", path.join(source, "fixture-musl")]);
  run("cc", ["-static", "-nostdlib", "-no-pie", staticSource, "-o", path.join(source, "fixture-static")]);
  run("cc", ["-static-pie", "-nostdlib", staticSource, "-o", path.join(source, "fixture-static-pie")]);
  fs.copyFileSync(path.join(lib, "libdependent.so"), path.join(source, "fixture-module.so"));

  const manifest = { schemaVersion: 1, architectures: { amd64: {
    machine: 62, requiredDynamicExecutables: ["fixture-app"], interpreterStrategies: {},
  } } };
  const validate = elf.validateUpstreamInventory;
  const fix = elf.applyFixups;
  const audit = elf.auditFixedTree;
  t.mock.method(elf, "validateUpstreamInventory", (directory, architecture) => validate(directory, architecture, manifest));
  t.mock.method(elf, "applyFixups", (options) => fix({ ...options, manifest }));
  t.mock.method(elf, "auditFixedTree", (options) => {
    assert.equal(options.checkDependencies, true, "production must retain the real loader audit");
    assert.equal(options.checkShebangs, false, "host FHS shebangs must be preserved");
    return audit({ ...options, manifest, checkDependencies: false });
  });
  return { source, runtime, output, lib, run, build: () => build([source, runtime, output]) };
}

test("runtime symlinks resolve to patched copies and source bytes remain unchanged", (t) => {
  const f = fixture(t);
  const before = fs.readFileSync(path.join(f.lib, "libsample.so.1"));
  f.build();
  const copiedLib = path.join(f.output, "runtime/lib/x86_64-linux-gnu");
  assert.equal(fs.readlinkSync(path.join(copiedLib, "libsample.so")), "libsample.so.1");
  assert.equal(fs.realpathSync(path.join(copiedLib, "libsample.so")), path.join(copiedLib, "libsample.so.1"));
  assert.notDeepEqual(fs.readFileSync(path.join(copiedLib, "libsample.so")), before);
  assert.deepEqual(fs.readFileSync(path.join(f.lib, "libsample.so.1")), before);
  assert.deepEqual(fs.readFileSync(path.join(copiedLib, "ld-linux-x86-64.so.2")), before);
});

test("every private DSO gets RUNPATH and NODEFLIB, including transitive dependencies", (t) => {
  const f = fixture(t);
  f.build();
  const lib = path.join(f.output, "runtime/lib/x86_64-linux-gnu");
  const expectedPath = `${lib}:${path.join(f.output, "runtime/lib")}`;
  for (const file of [path.join(lib, "libsample.so.1"), path.join(lib, "libdependent.so"), path.join(f.output, "opt/codex-desktop/fixture-module.so"), path.join(f.output, "opt/codex-desktop/fixture-app")]) {
    assert.equal(f.run("patchelf", ["--print-rpath", file]).trim(), expectedPath);
    assert.match(f.run("readelf", ["-d", file]), /\(FLAGS_1\).*NODEFLIB/);
  }
  assert.match(f.run("patchelf", ["--print-needed", path.join(lib, "libdependent.so")]), /libsample\.so\.1/);
  assert.equal(f.run("patchelf", ["--print-interpreter", path.join(f.output, "opt/codex-desktop/fixture-app")]).trim(), path.join(lib, "ld-linux-x86-64.so.2"));
});

test("ASAR, host shebangs, static binaries, and musl binaries are preserved", (t) => {
  const f = fixture(t);
  const libraryEnvironment = process.env.LD_LIBRARY_PATH;
  f.build();
  assert.equal(elf.inspectFile(path.join(f.source, "fixture-static-pie")).linkage, "static-pie");
  for (const file of ["resources/app.asar", "start.sh", "fixture-static", "fixture-static-pie", "fixture-musl"])
    assert.deepEqual(fs.readFileSync(path.join(f.output, "opt/codex-desktop", file)), fs.readFileSync(path.join(f.source, file)));
  assert.equal(process.env.LD_LIBRARY_PATH, libraryEnvironment);
  assert.equal(JSON.parse(fs.readFileSync(path.join(f.output, "alpine-build.json"))).architecture, "amd64");
});

test("an ELF patch failure cannot produce a successful build marker", (t) => {
  const f = fixture(t);
  const execute = cp.execFileSync;
  t.mock.method(cp, "execFileSync", (command, args, options) => {
    if (command === "patchelf") throw new Error("injected patchelf failure");
    return execute(command, args, options);
  });
  assert.throws(f.build, /injected patchelf failure/);
  assert.equal(fs.existsSync(path.join(f.output, "alpine-build.json")), false);
  assert.throws(f.build, /must not already exist/);
});

test("a failed dependency audit cannot produce a successful build marker", (t) => {
  const f = fixture(t);
  elf.auditFixedTree.mock.mockImplementation(() => { throw new Error("injected unresolved dependency"); });
  assert.throws(f.build, /injected unresolved dependency/);
  assert.equal(fs.existsSync(path.join(f.output, "alpine-build.json")), false);
});

test("unexpected ASAR changes fail closed without a successful build marker", (t) => {
  const f = fixture(t);
  elf.auditFixedTree.mock.mockImplementation((options) => {
    fs.appendFileSync(path.join(options.root, "resources/app.asar"), "unexpected mutation");
  });
  assert.throws(f.build, /ASAR changed/);
  assert.equal(fs.existsSync(path.join(f.output, "alpine-build.json")), false);
  assert.equal(fs.readFileSync(path.join(f.source, "resources/app.asar"), "utf8"), "fixture ASAR: preserve these bytes");
});

test("invalid runtime architecture and nested output fail before writing output", (t) => {
  const f = fixture(t);
  fs.writeFileSync(path.join(f.runtime, "manifest.json"), JSON.stringify([{ Package: "libc6", Architecture: "arm64" }]));
  assert.throws(f.build, /no amd64 libc6/);
  assert.equal(fs.existsSync(f.output), false);
  const nested = path.join(f.source, "nested");
  assert.throws(() => build([f.source, f.runtime, nested]), /outside both input trees/);
  assert.equal(fs.existsSync(nested), false);
});
