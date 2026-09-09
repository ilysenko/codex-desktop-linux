#!/usr/bin/env node
"use strict";

const fs = require("node:fs");
const path = require("node:path");
const cp = require("node:child_process");

const [outputArg, toolsArg] = process.argv.slice(2);
if (!outputArg || !toolsArg || process.argv.length !== 4)
  throw new Error("usage: install-desktop.cjs BUILT-OUTPUT ALPINE-TOOLS");
const output = fs.realpathSync(outputArg);
const tools = fs.realpathSync(toolsArg);
const app = path.join(output, "opt/codex-desktop");
if (!fs.statSync(path.join(output, "alpine-build.json")).isFile())
  throw new Error("output has not passed the Alpine build audit");
const ps = path.join(tools, "root/bin/ps");
cp.execFileSync(ps, ["-ax", "-o", "pid=,ppid="], { stdio: "ignore" });
// The desktop refreshes PATH from the user's login shell. Expose the native
// Alpine helper in the conventional user bin directory as well as launch PATH.
const userBin = path.join(process.env.HOME, ".local/bin");
fs.mkdirSync(userBin, { recursive: true });
const userPs = path.join(userBin, "ps");
let existingPs = false;
try { fs.lstatSync(userPs); existingPs = true; }
catch (error) { if (error.code !== "ENOENT") throw error; }
if (existingPs)
  cp.execFileSync(userPs, ["-ax", "-o", "pid=,ppid="], { stdio: "ignore" });
else
  fs.symlinkSync(ps, userPs);
const hostBin = path.join(output, "host-bin");
fs.mkdirSync(hostBin);
fs.symlinkSync(ps, path.join(hostBin, "ps"));
const quote = (value) => "'" + value.replaceAll("'", "'\\''") + "'";
const launcher = path.join(output, "launch.sh");
fs.writeFileSync(launcher, `#!/bin/sh\n# Only Alpine's native ps is added; all other host tools retain their PATH.\nexport PATH=${quote(hostBin)}:"$PATH"\nexec ${quote(path.join(app, "start.sh"))} --ui-toolkit=gtk --gtk-version=3 --ozone-platform=x11 "$@"\n`, { mode: 0o755, flag: "wx" });
const data = process.env.XDG_DATA_HOME || path.join(process.env.HOME, ".local/share");
const applications = path.join(data, "applications");
fs.mkdirSync(applications, { recursive: true });
// Desktop Exec uses its own quoting rules, not shell quoting.
const desktopQuote = (value) => '"' + value.replaceAll("%", "%%").replaceAll("\\", "\\\\\\\\").replaceAll('"', '\\"').replaceAll("`", "\\`").replaceAll("$", "\\$") + '"';
const desktop = path.join(applications, "codex-desktop.desktop");
fs.writeFileSync(desktop, `[Desktop Entry]\nName=ChatGPT Community\nComment=ChatGPT Community on Alpine Linux\nExec=${desktopQuote(launcher)} %u\nIcon=${path.join(app, ".codex-linux/codex-desktop.png")}\nTerminal=false\nType=Application\nCategories=Development;\nMimeType=x-scheme-handler/codex;x-scheme-handler/codex-browser-sidebar;\nStartupNotify=true\nStartupWMClass=codex-desktop\n`, { flag: "wx" });
console.log(`Installed ${desktop}`);
console.log(`Launch with ${launcher}`);
