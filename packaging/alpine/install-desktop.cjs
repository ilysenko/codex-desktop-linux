#!/usr/bin/env node
"use strict";

const fs = require("node:fs");
const path = require("node:path");
const cp = require("node:child_process");

function installDesktop(outputArg, toolsArg, {
  userHome = process.env.HOME,
  dataHome = process.env.XDG_DATA_HOME || (userHome && path.join(userHome, ".local/share")),
} = {}) {
  if (!outputArg || !toolsArg)
    throw new Error("usage: install-desktop.cjs BUILT-OUTPUT ALPINE-TOOLS");
  const output = fs.realpathSync(outputArg);
  const tools = fs.realpathSync(toolsArg);
  for (const value of [output, tools, userHome, dataHome]) {
    if (typeof value !== "string" || !path.isAbsolute(value) || /[\x00-\x1f\x7f]/.test(value))
      throw new Error("installation paths must be absolute and contain no control characters");
  }
  // '=' is forbidden in the executable path by the Desktop Entry specification.
  if (output.includes("=")) throw new Error("desktop executable path cannot contain '='");
  const app = path.join(output, "opt/codex-desktop");
  for (const file of [path.join(output, "alpine-build.json"), path.join(app, "start.sh"), path.join(app, ".codex-linux/codex-desktop.png")])
    if (!fs.statSync(file).isFile()) throw new Error(`required build file is not a file: ${file}`);

  const userBin = path.join(userHome, ".local/bin");
  const userPs = path.join(userBin, "ps");
  const hostBin = path.join(output, "host-bin");
  const launcher = path.join(output, "launch.sh");
  const applications = path.join(dataHome, "applications");
  const desktop = path.join(applications, "codex-desktop.desktop");
  const stat = (target) => fs.lstatSync(target, { throwIfNoEntry: false });
  // Check *all* conflicts before modifying anything, including dangling links.
  for (const target of [hostBin, launcher, desktop])
    if (stat(target)) throw new Error(`destination already exists: ${target}`);
  const ps = path.join(tools, "root/bin/ps");
  const checkPs = (command) => cp.execFileSync(command, ["-ax", "-o", "pid=,ppid="], { stdio: "ignore", timeout: 10000 });
  checkPs(ps);
  const existingPs = stat(userPs);
  if (existingPs) checkPs(userPs);

  const quote = (value) => "'" + value.replaceAll("'", "'\\''") + "'";
  // Exec argument escaping is decoded AFTER desktop string escaping.
  // https://specifications.freedesktop.org/desktop-entry/latest/exec-variables.html
  const desktopString = (value) => value.replaceAll("\\", "\\\\");
  const desktopQuote = (value) => desktopString('"' + value.replaceAll("%", "%%").replace(/[\\"`$]/g, "\\$&") + '"');
  const launcherText = `#!/bin/sh\n# Only Alpine's native ps is added; all other host tools retain their PATH.\nexport PATH=${quote(hostBin)}:"$PATH"\nexec ${quote(path.join(app, "start.sh"))} --ui-toolkit=gtk --gtk-version=3 --ozone-platform=x11 "$@"\n`;
  const desktopText = `[Desktop Entry]\nName=ChatGPT Community\nComment=ChatGPT Community on Alpine Linux\nExec=${desktopQuote(launcher)} %u\nIcon=${desktopString(path.join(app, ".codex-linux/codex-desktop.png"))}\nTerminal=false\nType=Application\nCategories=Development;\nMimeType=x-scheme-handler/codex;x-scheme-handler/codex-browser-sidebar;\nStartupNotify=true\nStartupWMClass=codex-desktop\n`;

  // Roll back caught failures, never pre-existing or replaced paths. This is
  // not a power-loss/SIGKILL recovery journal. Directories are only rmdir'ed;
  // no recursive removal can swallow another process's files.
  const owned = [];
  const remember = (target, info = stat(target)) => owned.push({ target, info });
  function mkdir(target) {
    if (stat(target)) {
      if (!fs.statSync(target).isDirectory()) throw new Error(`not a directory: ${target}`);
      return;
    }
    mkdir(path.dirname(target));
    fs.mkdirSync(target);
    remember(target);
  }
  function symlink(source, target) {
    fs.symlinkSync(source, target);
    remember(target);
  }
  function publish(target, contents, mode) {
    const staging = fs.mkdtempSync(path.join(path.dirname(target), ".alpine-install-"));
    remember(staging);
    const temporary = path.join(staging, "entry");
    const fd = fs.openSync(temporary, "wx", mode);
    const info = fs.fstatSync(fd);
    remember(temporary, info);
    try { fs.writeFileSync(fd, contents); }
    finally { fs.closeSync(fd); }
    // Same-filesystem link publishes the complete file without overwriting a
    // destination created after preflight (rename would silently overwrite).
    fs.linkSync(temporary, target);
    remember(target, info);
    fs.unlinkSync(temporary);
    owned.splice(owned.findIndex((entry) => entry.target === temporary), 1);
    fs.rmdirSync(staging);
    owned.splice(owned.findIndex((entry) => entry.target === staging), 1);
  }
  try {
    mkdir(userBin);
    mkdir(applications);
    // The desktop refreshes PATH from the login shell; expose native procps
    // in the user bin directory as well as the launcher's narrow host-bin.
    if (!existingPs) symlink(ps, userPs);
    fs.mkdirSync(hostBin);
    remember(hostBin);
    symlink(ps, path.join(hostBin, "ps"));
    publish(launcher, launcherText, 0o755);
    publish(desktop, desktopText, 0o644);
  } catch (error) {
    const failures = [];
    for (const { target, info } of owned.reverse()) {
      try {
        const current = stat(target);
        if (!current || current.dev !== info.dev || current.ino !== info.ino) continue;
        if (current.isDirectory()) fs.rmdirSync(target);
        else fs.unlinkSync(target);
      } catch (cleanupError) { failures.push(`${target}: ${cleanupError.message}`); }
    }
    if (failures.length) throw new Error(`${error.message}; cleanup incomplete: ${failures.join("; ")}`, { cause: error });
    throw error;
  }
  return { desktop, launcher };
}

if (require.main === module) {
  try {
    if (process.argv.length !== 4) throw new Error("usage: install-desktop.cjs BUILT-OUTPUT ALPINE-TOOLS");
    const { desktop, launcher } = installDesktop(...process.argv.slice(2));
    console.log(`Installed ${desktop}`);
    console.log(`Launch with ${launcher}`);
  } catch (error) { console.error(error.message); process.exitCode = 1; }
}

module.exports = { installDesktop };
