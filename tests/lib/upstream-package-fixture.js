"use strict";

const childProcess = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");

function makeDeb(root, options = {}) {
  const packageName = options.packageName ?? "chatgpt";
  const version = options.version ?? "26.1021.22027";
  const architecture = options.architecture ?? "amd64";
  const payload = path.join(root, "payload");
  const control = path.join(payload, "DEBIAN");
  fs.mkdirSync(control, { recursive: true });
  fs.writeFileSync(path.join(control, "control"), [
    `Package: ${packageName}`, `Version: ${version}`, `Architecture: ${architecture}`,
    "Maintainer: Test <fixture@example.invalid>", "Depends: libc6", "Description: Test fixture", "",
  ].join("\n"));
  // Extracting data must never run upstream maintainer scripts.
  fs.writeFileSync(path.join(control, "postinst"), "#!/bin/sh\nexit 99\n", { mode: 0o755 });
  for (const relative of [
    "ChatGPT", "resources/app.asar", "resources/codex", "resources/rg",
    "resources/codex-code-mode-host", "resources/owl-electron-app.json", "resources/owl-app.ini",
  ]) {
    if (relative === options.missingPayload) continue;
    const target = path.join(payload, "usr/lib/chatgpt", relative);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, "fixture\n", { mode: 0o755 });
  }
  const file = path.join(root, "input package.deb");
  childProcess.execFileSync("dpkg-deb", ["--build", "--root-owner-group", payload, file], { stdio: "pipe" });
  return file;
}

module.exports = { makeDeb };
