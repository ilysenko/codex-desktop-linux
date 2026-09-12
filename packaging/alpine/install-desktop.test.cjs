"use strict";

const assert = require("node:assert/strict");
const cp = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const { installDesktop } = require("./install-desktop.cjs");

function fixture(t, name = "app") {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "alpine-desktop-test-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const output = path.join(root, name);
  const tools = path.join(root, "tools");
  const userHome = path.join(root, "user");
  const dataHome = path.join(root, "data");
  const app = path.join(output, "opt/codex-desktop");
  const desktop = path.join(dataHome, "applications/codex-desktop.desktop");
  const userPs = path.join(userHome, ".local/bin/ps");
  fs.mkdirSync(path.join(app, ".codex-linux"), { recursive: true });
  fs.mkdirSync(path.join(tools, "root/bin"), { recursive: true });
  fs.mkdirSync(userHome);
  fs.writeFileSync(path.join(output, "alpine-build.json"), "{}");
  fs.writeFileSync(path.join(app, ".codex-linux/codex-desktop.png"), "icon");
  fs.writeFileSync(path.join(app, "start.sh"), '#!/bin/sh\nprintf "%s\\n" "$PATH" "${LD_LIBRARY_PATH-unset}" "$@"\n', { mode: 0o755 });
  fs.writeFileSync(path.join(tools, "root/bin/ps"), "#!/bin/sh\nexit 0\n", { mode: 0o755 });
  return { output, tools, userHome, dataHome, desktop, userPs,
    install: () => installDesktop(output, tools, { userHome, dataHome }) };
}

function assertNoInstall(f) {
  for (const target of [f.userPs, path.join(f.output, "host-bin"), path.join(f.output, "launch.sh")])
    assert.equal(fs.lstatSync(target, { throwIfNoEntry: false }), undefined, `left behind ${target}`);
  assert.deepEqual(fs.readdirSync(f.output).sort(), ["alpine-build.json", "opt"]);
}

test("an existing desktop entry is rejected before any installation writes", (t) => {
  const f = fixture(t);
  fs.mkdirSync(path.dirname(f.desktop), { recursive: true });
  fs.writeFileSync(f.desktop, "user-owned entry");
  assert.throws(f.install, /exist/i);
  assert.equal(fs.readFileSync(f.desktop, "utf8"), "user-owned entry");
  assertNoInstall(f);
});

test("a dangling desktop symlink is also an occupied destination", (t) => {
  const f = fixture(t);
  fs.mkdirSync(path.dirname(f.desktop), { recursive: true });
  fs.symlinkSync("missing-user-file", f.desktop);
  assert.throws(f.install, /exist/i);
  assert.equal(fs.readlinkSync(f.desktop), "missing-user-file");
  assertNoInstall(f);
});

test("a conflicting launcher is preserved without creating helpers", (t) => {
  const f = fixture(t);
  const launcher = path.join(f.output, "launch.sh");
  fs.writeFileSync(launcher, "user-owned launcher");
  assert.throws(f.install, /exist/i);
  assert.equal(fs.readFileSync(launcher, "utf8"), "user-owned launcher");
  assert.equal(fs.existsSync(f.userPs), false);
  assert.equal(fs.existsSync(path.join(f.output, "host-bin")), false);
});

test("an invalid existing ps is never replaced", (t) => {
  const f = fixture(t);
  fs.mkdirSync(path.dirname(f.userPs), { recursive: true });
  fs.writeFileSync(f.userPs, "#!/bin/sh\nexit 1\n", { mode: 0o755 });
  assert.throws(f.install);
  assert.equal(fs.readFileSync(f.userPs, "utf8"), "#!/bin/sh\nexit 1\n");
  assert.equal(fs.existsSync(path.join(f.output, "host-bin")), false);
  assert.equal(fs.existsSync(f.desktop), false);
});

test("the launcher forwards arguments and keeps host tools and library environment", (t) => {
  const f = fixture(t, "app with 'quotes' and spaces");
  const { launcher } = f.install();
  const args = ["codex://test?value=a b&next=$literal", "--literal='quoted'", ""];
  const env = { ...process.env };
  delete env.LD_LIBRARY_PATH;
  const lines = cp.execFileSync(launcher, args, { env, encoding: "utf8" }).split("\n");
  assert.equal(lines[0], `${path.join(f.output, "host-bin")}:${env.PATH}`);
  assert.equal(lines[1], "unset");
  assert.deepEqual(lines.slice(2, -1), ["--ui-toolkit=gtk", "--gtk-version=3", "--ozone-platform=x11", ...args]);
  assert.deepEqual(fs.readdirSync(path.join(f.output, "host-bin")), ["ps"]);
  assert.equal(fs.readlinkSync(f.userPs), path.join(f.tools, "root/bin/ps"));
});

test("a late publishing error rolls back owned paths and allows a clean retry", (t) => {
  const f = fixture(t);
  const link = fs.linkSync;
  const fault = t.mock.method(fs, "linkSync", (source, target) => {
    if (target === f.desktop) throw new Error("injected publish failure");
    return link(source, target);
  });
  assert.throws(f.install, /injected publish failure/);
  assertNoInstall(f);
  assert.equal(fs.existsSync(f.dataHome), false);
  assert.deepEqual(fs.readdirSync(f.userHome), []);
  fault.mock.restore();
  assert.equal(f.install().desktop, f.desktop);
});

test("a partial file write is cleaned up before retry", (t) => {
  const f = fixture(t);
  const write = fs.writeFileSync;
  const fault = t.mock.method(fs, "writeFileSync", (target, contents, ...rest) => {
    if (typeof target === "number") {
      write(target, contents.slice(0, 12), ...rest);
      throw new Error("injected disk full");
    }
    return write(target, contents, ...rest);
  });
  assert.throws(f.install, /injected disk full/);
  assertNoInstall(f);
  assert.equal(fs.existsSync(f.desktop), false);
  fault.mock.restore();
  assert.ok(fs.existsSync(f.install().launcher));
});

test("a desktop entry created after preflight is not overwritten or removed", (t) => {
  const f = fixture(t);
  const link = fs.linkSync;
  t.mock.method(fs, "linkSync", (source, target) => {
    if (target === f.desktop) fs.writeFileSync(target, "concurrent entry", { flag: "wx" });
    return link(source, target);
  });
  assert.throws(f.install, /EEXIST/);
  assert.equal(fs.readFileSync(f.desktop, "utf8"), "concurrent entry");
  assertNoInstall(f);
});

test("rollback preserves existing ps and unrelated files", (t) => {
  const f = fixture(t);
  fs.mkdirSync(path.dirname(f.userPs), { recursive: true });
  fs.copyFileSync(path.join(f.tools, "root/bin/ps"), f.userPs);
  const before = fs.statSync(f.userPs);
  fs.mkdirSync(path.dirname(f.desktop), { recursive: true });
  const unrelated = path.join(path.dirname(f.desktop), "other.desktop");
  fs.writeFileSync(unrelated, "unrelated");
  const link = fs.linkSync;
  t.mock.method(fs, "linkSync", (source, target) => {
    if (target === f.desktop) throw new Error("injected publish failure");
    return link(source, target);
  });
  assert.throws(f.install, /injected publish failure/);
  assert.equal(fs.statSync(f.userPs).ino, before.ino);
  assert.equal(fs.readFileSync(unrelated, "utf8"), "unrelated");
  assert.deepEqual(fs.readdirSync(f.output).sort(), ["alpine-build.json", "opt"]);
});

test("rollback does not delete an owned path replaced by another writer", (t) => {
  const f = fixture(t);
  fs.mkdirSync(path.dirname(f.userPs), { recursive: true });
  const link = fs.linkSync;
  t.mock.method(fs, "linkSync", (source, target) => {
    if (target === f.desktop) {
      fs.renameSync(f.userPs, path.join(f.userHome, "original-ps"));
      fs.symlinkSync("replacement", f.userPs);
      throw new Error("injected publish failure");
    }
    return link(source, target);
  });
  assert.throws(f.install, /injected publish failure/);
  assert.equal(fs.readlinkSync(f.userPs), "replacement");
});

test("repeating a successful installation refuses to overwrite its files", (t) => {
  const f = fixture(t);
  const { launcher, desktop } = f.install();
  const before = [launcher, desktop, f.userPs].map((file) => fs.lstatSync(file).ino);
  assert.throws(f.install, /already exists/);
  assert.deepEqual([launcher, desktop, f.userPs].map((file) => fs.lstatSync(file).ino), before);
});

test("a file replaced immediately after publication is not owned by rollback", (t) => {
  const f = fixture(t);
  const launcher = path.join(f.output, "launch.sh");
  const link = fs.linkSync;
  t.mock.method(fs, "linkSync", (source, target) => {
    if (target === f.desktop) throw new Error("injected publish failure");
    link(source, target);
    if (target === launcher) {
      fs.unlinkSync(target);
      fs.writeFileSync(target, "replacement launcher", { flag: "wx" });
    }
  });
  assert.throws(f.install, /injected publish failure/);
  assert.equal(fs.readFileSync(launcher, "utf8"), "replacement launcher");
});

test("desktop Exec and Icon escape backslashes and shell metacharacters", (t) => {
  const f = fixture(t, 'app "quoted" \\backslash $dollar `tick` %u');
  const { launcher, desktop } = f.install();
  const entry = fs.readFileSync(desktop, "utf8");
  // Independent two-stage decoder, following Desktop Entry sections 4 and 7.
  const decodeValue = (value) => value.replace(/\\([sntr\\])/g, (_, c) => ({ s: " ", n: "\n", t: "\t", r: "\r", "\\": "\\" })[c]);
  const exec = decodeValue(entry.match(/^Exec=(.*)$/m)[1]);
  const match = exec.match(/^"((?:\\.|[^"\\])*)" %u$/);
  assert.ok(match, "Exec must have one quoted executable followed by the URI field");
  const executable = match[1].replace(/\\(["`$\\])/g, "$1").replaceAll("%%", "%");
  assert.equal(executable, launcher);
  assert.equal(decodeValue(entry.match(/^Icon=(.*)$/m)[1]), path.join(f.output, "opt/codex-desktop/.codex-linux/codex-desktop.png"));
  assert.equal(entry.includes("\\\\$dollar"), true);
  assert.equal(entry.includes('\\\\"quoted\\\\"'), true);
  assert.equal(cp.spawnSync(launcher, [], { encoding: "utf8" }).status, 0);
});

for (const name of ["app\nExec=injected", "app=invalid"]) {
  test("unrepresentable desktop path is rejected: " + JSON.stringify(name), (t) => {
    const f = fixture(t, name);
    assert.throws(f.install, /path/);
    assertNoInstall(f);
  });
}

test("relative XDG data directory is rejected before writes", (t) => {
  const f = fixture(t);
  assert.throws(() => installDesktop(f.output, f.tools, { userHome: f.userHome, dataHome: "relative" }), /absolute/);
  assertNoInstall(f);
});
