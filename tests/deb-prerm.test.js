"use strict";

const assert = require("node:assert/strict");
const childProcess = require("node:child_process");
const crypto = require("node:crypto");
const fs = require("node:fs");
const net = require("node:net");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const repoRoot = path.resolve(__dirname, "..");
const template = path.join(
  repoRoot,
  "packaging/linux/codex-update-manager.prerm",
);

function stagePrerm(root) {
  const packageCommon = path.join(repoRoot, "scripts/lib/package-common.sh");
  const postinst = path.join(
    repoRoot,
    "packaging/linux/codex-update-manager.postinst",
  );
  const postrm = path.join(
    repoRoot,
    "packaging/linux/codex-update-manager.postrm",
  );
  childProcess.execFileSync(
    "bash",
    [
      "-c",
      [
        "set -euo pipefail",
        '. "$PACKAGE_COMMON"',
        'stage_deb_maintainer_scripts "$STAGE_ROOT" "$PACKAGE_NAME" "$POSTINST_TEMPLATE" "$PRERM_TEMPLATE" "$POSTRM_TEMPLATE"',
      ].join("\n"),
    ],
    {
      cwd: repoRoot,
      env: {
        ...process.env,
        PACKAGE_COMMON: packageCommon,
        STAGE_ROOT: root,
        PACKAGE_NAME: "codex-desktop",
        POSTINST_TEMPLATE: postinst,
        PRERM_TEMPLATE: template,
        POSTRM_TEMPLATE: postrm,
      },
    },
  );
  const staged = path.join(root, "DEBIAN/prerm");
  assert.equal(
    fs.readFileSync(staged, "utf8"),
    fs.readFileSync(template, "utf8"),
  );
  return staged;
}

function writeFakeCommands(root, logPath) {
  const bin = path.join(root, "bin");
  fs.mkdirSync(bin, { recursive: true });
  fs.writeFileSync(
    path.join(bin, "getent"),
    "#!/bin/sh\n[ \"${1:-}\" = passwd ] || exit 1\nprintf 'fixture:x:%s:100:Fixture:/tmp:/bin/sh\\n' \"${2:-1000}\"\n",
    { mode: 0o755 },
  );
  fs.writeFileSync(
    path.join(bin, "runuser"),
    "#!/bin/sh\nprintf '%s\\n' \"$*\" >> \"$RUNUSER_LOG\"\n",
    { mode: 0o755 },
  );
  return {
    ...process.env,
    PATH: `${bin}:${process.env.PATH || ""}`,
    RUNUSER_LOG: logPath,
  };
}

function runPrerm(staged, action, env) {
  return childProcess.spawnSync(staged, [action], {
    encoding: "utf8",
    env,
  });
}

async function usableRuntimeBus(t) {
  const uid = typeof process.getuid === "function" ? process.getuid() : 0;
  const ownBus = path.join("/run/user", String(uid), "bus");
  if (uid !== 0 && fs.existsSync(ownBus) && fs.statSync(ownBus).isSocket()) {
    return ownBus;
  }

  let runtimeDir = null;
  let fixtureIdentity = null;
  let cleanupWithSudo = false;

  if (uid !== 0) {
    const sudo = childProcess.spawnSync("sudo", ["-n", "true"], {
      stdio: "ignore",
    });
    if (sudo.status !== 0) {
      t.skip(
        "no active user bus or passwordless sudo available for maintainer-script cleanup test",
      );
      return null;
    }
    cleanupWithSudo = true;
  }

  for (let attempt = 0; attempt < 100; attempt += 1) {
    const fixtureUid = crypto.randomInt(60000, 1_000_000_000);
    const candidate = path.join("/run/user", String(fixtureUid));
    if (cleanupWithSudo) {
      const created = childProcess.spawnSync(
        "sudo",
        ["-n", "mkdir", "--mode=0700", candidate],
        { stdio: "ignore" },
      );
      if (created.status !== 0) continue;
      try {
        childProcess.execFileSync("sudo", [
          "-n",
          "chown",
          `${uid}:${typeof process.getgid === "function" ? process.getgid() : uid}`,
          candidate,
        ]);
      } catch (error) {
        childProcess.spawnSync("sudo", ["-n", "rmdir", "--", candidate], {
          stdio: "ignore",
        });
        throw error;
      }
    } else {
      try {
        fs.mkdirSync(candidate, { mode: 0o700 });
      } catch (error) {
        if (error && error.code === "EEXIST") continue;
        throw error;
      }
    }
    runtimeDir = candidate;
    const stat = fs.statSync(runtimeDir);
    fixtureIdentity = { dev: stat.dev, ino: stat.ino };
    break;
  }
  assert.ok(runtimeDir, "could not reserve a unique /run/user fixture directory");

  const ownershipMarker = path.join(runtimeDir, ".codex-prerm-test-owner");
  const ownershipToken = crypto.randomBytes(24).toString("hex");
  fs.writeFileSync(ownershipMarker, ownershipToken, { mode: 0o600 });
  const bus = path.join(runtimeDir, "bus");
  const server = net.createServer();
  t.after(async () => {
    if (server.listening) {
      await new Promise((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      });
    }

    const stat = fs.statSync(runtimeDir, { throwIfNoEntry: false });
    const marker =
      stat && fs.existsSync(ownershipMarker)
        ? fs.readFileSync(ownershipMarker, "utf8")
        : null;
    assert.equal(
      Boolean(
        stat &&
          stat.dev === fixtureIdentity.dev &&
          stat.ino === fixtureIdentity.ino &&
          marker === ownershipToken,
      ),
      true,
      "refusing to clean a /run/user directory not owned by this fixture",
    );
    if (cleanupWithSudo) {
      childProcess.execFileSync("sudo", ["-n", "rm", "-rf", runtimeDir]);
    } else {
      fs.rmSync(runtimeDir, { recursive: true, force: true });
    }
  });

  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(bus, resolve);
  });
  return bus;
}

test("staged Debian prerm upgrade has no user-service side effects", async (t) => {
  const bus = await usableRuntimeBus(t);
  if (!bus) return;

  const root = fs.mkdtempSync(path.join(os.tmpdir(), "codex-prerm-upgrade-"));
  try {
    const staged = stagePrerm(root);
    const logPath = path.join(root, "runuser.log");
    const result = runPrerm(staged, "upgrade", writeFakeCommands(root, logPath));
    assert.equal(result.status, 0, result.stderr);
    assert.equal(fs.existsSync(logPath), false);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("staged Debian prerm failed-upgrade has no user-service side effects", async (t) => {
  const bus = await usableRuntimeBus(t);
  if (!bus) return;

  const root = fs.mkdtempSync(
    path.join(os.tmpdir(), "codex-prerm-failed-upgrade-"),
  );
  try {
    const staged = stagePrerm(root);
    const logPath = path.join(root, "runuser.log");
    const result = runPrerm(
      staged,
      "failed-upgrade",
      writeFakeCommands(root, logPath),
    );
    assert.equal(result.status, 0, result.stderr);
    assert.equal(
      fs.existsSync(logPath),
      false,
      "upgrade error recovery must not stop the updater service that owns the package transaction",
    );
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

for (const action of ["remove", "deconfigure"]) {
  test(
    `staged Debian prerm ${action} retains stop, disable, and reload cleanup`,
    async (t) => {
      const bus = await usableRuntimeBus(t);
      if (!bus) return;

      const root = fs.mkdtempSync(
        path.join(os.tmpdir(), `codex-prerm-${action}-`),
      );
      try {
        const staged = stagePrerm(root);
        const logPath = path.join(root, "runuser.log");
        const result = runPrerm(
          staged,
          action,
          writeFakeCommands(root, logPath),
        );
        assert.equal(result.status, 0, result.stderr);
        const calls = fs.readFileSync(logPath, "utf8");
        assert.match(
          calls,
          /systemctl --user stop codex-update-manager\.service/,
        );
        assert.match(
          calls,
          /systemctl --user disable codex-update-manager\.service/,
        );
        assert.match(calls, /systemctl --user daemon-reload/);
      } finally {
        fs.rmSync(root, { recursive: true, force: true });
      }
    },
  );
}
