#!/usr/bin/env node
"use strict";

const fs = require("node:fs");
const path = require("node:path");
const cp = require("node:child_process");
const { inventoryTree } = require("../../nix/elf-runtime.cjs");

const output = path.resolve(process.argv[2] || "");
if (process.argv.length !== 3 || fs.existsSync(output)) {
  console.error("usage: prepare-tools.cjs NEW-OUTPUT (requires apk-tools 3, node, patchelf)");
  process.exit(1);
}
const run = (command, args) => cp.execFileSync(command, args, { stdio: "inherit" });
const cache = path.join(output, "packages");
const root = path.join(output, "root");
fs.mkdirSync(cache, { recursive: true });
fs.mkdirSync(root);
run("apk", ["fetch", "--recursive", "--output", cache,
  "dpkg", "gpgv", "flock", "coreutils", "findutils", "grep", "sed", "tar", "procps"]);
const packages = fs.readdirSync(cache).filter((file) => file.endsWith(".apk"))
  .sort().map((file) => path.join(cache, file));
run("apk", ["verify", ...packages]);
run("apk", ["extract", "--no-chown", "--destination", root, ...packages]);
const libraryPath = [path.join(root, "usr/lib"), path.join(root, "lib")].join(":");
for (const item of inventoryTree(root, "amd64")) {
  if (item.target && item.hasDynamic && item.needed.length)
    run("patchelf", ["--add-rpath", libraryPath, item.absolutePath]);
}
console.log(`Build tool PATH prefix: ${root}/usr/bin:${root}/bin`);
console.log(`Native host ps: ${root}/bin/ps`);
