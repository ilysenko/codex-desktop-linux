#!/usr/bin/env node
"use strict";

// Experimental direct-host packaging. Like the Nix build, this changes only
// ELF loading metadata; host tools never inherit a foreign PATH or libc.
const fs = require("node:fs");
const path = require("node:path");
const cp = require("node:child_process");
const crypto = require("node:crypto");
const elf = require("../../nix/elf-runtime.cjs");

function run(command, args) {
  cp.execFileSync(command, args, { stdio: "inherit" });
}

function main(argv) {
  const [source, runtimeSource, destination] = argv;
  if (!source || !runtimeSource || !destination || argv.length !== 3)
    throw new Error("usage: build.cjs VERIFIED-APP VERIFIED-RUNTIME NEW-OUTPUT");
  if (process.arch !== "x64") throw new Error("Alpine prototype currently validates amd64 only");
  const appSource = fs.realpathSync(source);
  const runtime = fs.realpathSync(runtimeSource);
  const output = path.resolve(destination);
  if (fs.existsSync(output)) throw new Error("output must not already exist");
  for (const input of [appSource, runtime])
    if (output.startsWith(input + path.sep))
      throw new Error("output must be outside both input trees");
  for (const required of [".codex-linux/build-info.json", "start.sh"])
    if (!fs.statSync(path.join(appSource, required)).isFile())
      throw new Error(`not a built Community app: ${required}`);
  const runtimeManifest = JSON.parse(fs.readFileSync(path.join(runtime, "manifest.json"), "utf8"));
  if (!runtimeManifest.some((item) => item.Package === "libc6" && item.Architecture === "amd64"))
    throw new Error("runtime manifest has no amd64 libc6");
  elf.validateUpstreamInventory(appSource, "amd64");
  fs.mkdirSync(output, { recursive: true });
  const app = path.join(output, "opt/codex-desktop");
  const libraryRoot = path.join(output, "runtime");
  fs.cpSync(appSource, app, { recursive: true, verbatimSymlinks: true });
  fs.cpSync(path.join(runtime, "root/usr/lib"), path.join(libraryRoot, "lib"), { recursive: true, verbatimSymlinks: true });
  fs.cpSync(path.join(runtime, "root/usr/share"), path.join(libraryRoot, "share"), { recursive: true, verbatimSymlinks: true });
  fs.copyFileSync(path.join(runtime, "manifest.json"), path.join(libraryRoot, "manifest.json"));
  const libraryPath = [path.join(libraryRoot, "lib/x86_64-linux-gnu"), path.join(libraryRoot, "lib")].join(":");
  const linker = path.join(libraryRoot, "lib/x86_64-linux-gnu/ld-linux-x86-64.so.2");
  const asarPath = path.join(app, "resources/app.asar");
  const originalAsar = crypto.createHash("sha256").update(fs.readFileSync(asarPath)).digest("hex");

  for (const item of elf.inventoryTree(libraryRoot, "amd64")) {
    if (item.target && item.platform === "glibc" && item.linkage === "dynamic-object") {
      if (item.absolutePath === linker) continue;
      // Give every dependency its own search path; do not export LD_LIBRARY_PATH
      // into musl shells, compilers, tests, or child processes.
      run("patchelf", ["--no-default-lib", "--add-rpath", libraryPath, item.absolutePath]);
    }
  }
  for (const item of elf.inventoryTree(app, "amd64")) {
    if (item.target && item.platform === "glibc" &&
        ["dynamic-object", "dynamic-executable"].includes(item.linkage))
      run("patchelf", ["--no-default-lib", item.absolutePath]);
  }
  elf.applyFixups({
    root: app, architecture: "amd64", dynamicLinker: linker,
    runtimeLibraryPath: libraryPath,
    chatgptRelocator: path.resolve(__dirname, "../../nix/relocate-elf-interpreter.cjs"),
  });
  elf.auditFixedTree({
    root: app, architecture: "amd64", dynamicLinker: linker,
    runtimeLibraryPath: libraryPath, checkDependencies: true,
    // FHS shebangs deliberately resolve to the actual Alpine host.
    checkShebangs: false,
  });
  const finalAsar = crypto.createHash("sha256").update(fs.readFileSync(asarPath)).digest("hex");
  if (finalAsar !== originalAsar) throw new Error("ASAR changed during ELF fixups");
  fs.writeFileSync(path.join(output, "alpine-build.json"), JSON.stringify({
    architecture: "amd64", source: appSource, runtimeSource: runtime,
    libraryPath, linker, asarSha256: finalAsar,
    hostOs: fs.readFileSync("/etc/os-release", "utf8"),
  }, null, 2) + "\n");
  console.log(`Alpine host app: ${app}/start.sh`);
}

if (require.main === module) {
  try { main(process.argv.slice(2)); }
  catch (error) { console.error(error.message); process.exitCode = 1; }
}

module.exports = { main };
