"use strict";

const assert = require("node:assert/strict");
const childProcess = require("node:child_process");
const fs = require("node:fs");
const net = require("node:net");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const templatePath = path.join(__dirname, "start.sh.template");
const bashPath = childProcess.execFileSync("bash", ["-c", "command -v bash"], { encoding: "utf8" }).trim();
const dirnamePath = childProcess.execFileSync("bash", ["-c", "command -v dirname"], { encoding: "utf8" }).trim();

// Launcher tests must never contact the production usage counter. Individual
// reporting tests opt back in with an isolated fake curl executable.
process.env.CODEX_LINUX_DISABLE_USAGE_REPORTING = "1";

// Ozone backend selection reads the session environment. Tests must not inherit
// the developer's compositor; the Wayland cases below set these explicitly.
for (const name of [
  "CODEX_DRM_CLASS_ROOT",
  "CODEX_OZONE_PLATFORM",
  "DESKTOP_SESSION",
  "SOMMELIER_VERSION",
  "SOMMELIER_VM_IDENTIFIER",
  "WAYLAND_DISPLAY",
  "XDG_CURRENT_DESKTOP",
  "XDG_RUNTIME_DIR",
  "XDG_SESSION_DESKTOP",
  "XDG_SESSION_TYPE",
]) {
  delete process.env[name];
}

function writeExecutable(filePath, source) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, source.replace(/^#!\/bin\/bash\n/, `#!${bashPath}\n`), { mode: 0o755 });
}

function createApp(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "codex-launcher-test-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 }));
  const launcher = fs.readFileSync(templatePath, "utf8")
    .replaceAll("__CODEX_LINUX_APP_ID__", "codex-desktop")
    .replaceAll("__CODEX_LINUX_APP_DISPLAY_NAME__", "ChatGPT Community");
  writeExecutable(path.join(root, "start.sh"), launcher);
  for (const relative of ["resources/app.asar", "resources/codex", "resources/rg", "resources/codex-code-mode-host"]) {
    const target = path.join(root, relative);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, "fixture", { mode: relative === "resources/app.asar" ? 0o644 : 0o755 });
  }
  writeExecutable(path.join(root, "ChatGPT"), `#!/bin/bash
printf '%s\n' "$CHROME_DESKTOP" "$BAMF_DESKTOP_FILE_HINT" "$HOOK_ENV" "$LAUNCHER_ENV" > "$TEST_ROOT/environment"
printf '%s\n' "\${CODEX_HOME:-}" > "$TEST_ROOT/codex-home"
printf '%s\n' "$@" > "$TEST_ROOT/arguments"
exit 7
`);
  return root;
}

function waitForFile(filePath, timeoutMs = 2000) {
  const deadline = Date.now() + timeoutMs;
  while (!fs.existsSync(filePath) && Date.now() < deadline) {
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 20);
  }
  assert.equal(fs.existsSync(filePath), true, `timed out waiting for ${filePath}`);
}

test("launcher reports only one anonymous usage event per UTC day", (t) => {
  const root = createApp(t);
  const binDir = path.join(root, "bin");
  const callsPath = path.join(root, "curl-calls");
  writeExecutable(
    path.join(binDir, "curl"),
    `#!/bin/bash
printf 'call\\n' >> "$TEST_ROOT/curl-calls"
printf '<%s>\\n' "$@" >> "$TEST_ROOT/curl-arguments"
`,
  );

  const env = {
    ...process.env,
    CODEX_HOME: path.join(root, "codex-home"),
    CODEX_LINUX_DISABLE_USAGE_REPORTING: "0",
    PATH: `${binDir}:${process.env.PATH}`,
    TEST_ROOT: root,
    XDG_STATE_HOME: path.join(root, "state"),
  };

  for (let launch = 0; launch < 2; launch += 1) {
    const result = childProcess.spawnSync(path.join(root, "start.sh"), [], {
      env,
      encoding: "utf8",
    });
    assert.equal(result.status, 7);
    assert.equal(result.stderr, "");
    if (launch === 0) waitForFile(callsPath);
  }

  assert.equal(fs.readFileSync(callsPath, "utf8"), "call\n");
  const args = fs.readFileSync(path.join(root, "curl-arguments"), "utf8");
  assert.match(args, /<--disable>/);
  assert.match(args, /<--connect-timeout>\n<2>/);
  assert.match(args, /<--max-time>\n<3>/);
  assert.match(args, /<--user-agent>\n<ChatGPTCommunity\/1 Usage>/);
  assert.match(args, /<--data-urlencode>\n<p=\/app-launch>/);
  assert.match(args, /<--data-urlencode>\n<ns=1>/);
  assert.match(args, /<https:\/\/gary\.goatcounter\.com\/count>/);
  assert.doesNotMatch(args, /version|architecture|language|referrer|screen|title|rnd/i);
});

test("launcher usage reporting has one opt-out and suppresses curl failures", (t) => {
  const disabledRoot = createApp(t);
  const disabledBin = path.join(disabledRoot, "bin");
  writeExecutable(
    path.join(disabledBin, "curl"),
    `#!/bin/bash
printf 'unexpected\\n' >> "$TEST_ROOT/curl-calls"
`,
  );
  const disabled = childProcess.spawnSync(path.join(disabledRoot, "start.sh"), [], {
    env: {
      ...process.env,
      CODEX_HOME: path.join(disabledRoot, "codex-home"),
      CODEX_LINUX_DISABLE_USAGE_REPORTING: "1",
      PATH: `${disabledBin}:${process.env.PATH}`,
      TEST_ROOT: disabledRoot,
      XDG_STATE_HOME: path.join(disabledRoot, "state"),
    },
    encoding: "utf8",
  });
  assert.equal(disabled.status, 7);
  assert.equal(disabled.stderr, "");
  assert.equal(fs.existsSync(path.join(disabledRoot, "curl-calls")), false);
  assert.equal(fs.existsSync(path.join(disabledRoot, "state")), false);
  assert.equal(
    fs.readFileSync(path.join(disabledRoot, "codex-home"), "utf8").trim(),
    path.join(disabledRoot, "codex-home"),
  );

  const missingRoot = createApp(t);
  const missingBin = path.join(missingRoot, "bin");
  fs.mkdirSync(missingBin, { recursive: true });
  fs.symlinkSync(dirnamePath, path.join(missingBin, "dirname"));
  const missing = childProcess.spawnSync(path.join(missingRoot, "start.sh"), [], {
    env: {
      ...process.env,
      CODEX_HOME: path.join(missingRoot, "codex-home"),
      CODEX_LINUX_DISABLE_USAGE_REPORTING: "0",
      PATH: missingBin,
      TEST_ROOT: missingRoot,
      XDG_STATE_HOME: path.join(missingRoot, "state"),
    },
    encoding: "utf8",
  });
  assert.equal(missing.status, 7);
  assert.equal(missing.stdout, "");
  assert.equal(missing.stderr, "");
  assert.equal(fs.existsSync(path.join(missingRoot, "state")), false);

  const failingRoot = createApp(t);
  const failingBin = path.join(failingRoot, "bin");
  writeExecutable(
    path.join(failingBin, "curl"),
    `#!/bin/bash
printf 'simulated curl failure\\n' >&2
exit 22
`,
  );
  const failing = childProcess.spawnSync(path.join(failingRoot, "start.sh"), [], {
    env: {
      ...process.env,
      CODEX_HOME: path.join(failingRoot, "codex-home"),
      CODEX_LINUX_DISABLE_USAGE_REPORTING: "0",
      PATH: `${failingBin}:${process.env.PATH}`,
      TEST_ROOT: failingRoot,
      XDG_STATE_HOME: path.join(failingRoot, "state"),
    },
    encoding: "utf8",
  });
  assert.equal(failing.status, 7);
  assert.equal(failing.stdout, "");
  assert.equal(failing.stderr, "");
});

test("launcher composes declarative hooks and forwards arguments", (t) => {
  const root = createApp(t);
  const hooks = path.join(root, ".codex-linux");
  fs.mkdirSync(path.join(hooks, "env.d"), { recursive: true });
  fs.writeFileSync(path.join(hooks, "env.d", "fixture.env"), "HOOK_ENV=from-env\n");
  fs.mkdirSync(path.join(hooks, "electron-args.d"), { recursive: true });
  fs.writeFileSync(path.join(hooks, "electron-args.d", "fixture.args"), "# comment\n--feature-arg=one two\n");
  writeExecutable(path.join(hooks, "prelaunch.d", "fixture.sh"), "#!/bin/bash\nprintf prelaunch > \"$TEST_ROOT/prelaunch\"\n");
  writeExecutable(path.join(hooks, "launcher.d", "fixture.sh"), "#!/bin/bash\nprintf '%s\\n' 'env LAUNCHER_ENV=from-launcher' 'electron-arg --launcher-arg=value'\n");
  writeExecutable(path.join(hooks, "after-exit.d", "fixture.sh"), "#!/bin/bash\nprintf after-exit > \"$TEST_ROOT/after-exit\"\n");

  const env = {
    ...process.env,
    CODEX_HOME: path.join(root, "codex-home"),
    XDG_CONFIG_HOME: path.join(root, "config"),
    TEST_ROOT: root,
  };
  delete env.CHROME_DESKTOP;
  delete env.BAMF_DESKTOP_FILE_HINT;
  const result = childProcess.spawnSync(path.join(root, "start.sh"), ["codex://thread/123", "--new-window"], {
    env,
    encoding: "utf8",
  });
  assert.equal(result.status, 7);
  assert.deepEqual(fs.readFileSync(path.join(root, "environment"), "utf8").trim().split("\n"), [
    "codex-desktop.desktop",
    "/usr/share/applications/codex-desktop.desktop",
    "from-env",
    "from-launcher",
  ]);
  assert.deepEqual(fs.readFileSync(path.join(root, "arguments"), "utf8").trim().split("\n"), [
    "--class=codex-desktop",
    "--feature-arg=one two",
    "--launcher-arg=value",
    "codex://thread/123",
    "--new-window",
  ]);
  assert.equal(fs.readFileSync(path.join(root, "prelaunch"), "utf8"), "prelaunch");
  assert.equal(fs.readFileSync(path.join(root, "after-exit"), "utf8"), "after-exit");
});

test("launcher preserves desktop arguments and exposes the after-exit status", (t) => {
  for (const originalArgs of [[], ["codex://thread/123", "--new-window"]]) {
    const root = createApp(t);
    const hooks = path.join(root, ".codex-linux");
    const stateDir = path.join(root, "state", "codex-desktop");
    const cacheDir = path.join(root, "cache", "codex-desktop");
    const expectedDesktopArgs = ["--class=codex-desktop", ...originalArgs];
    const expectedHookContext = [
      `app=${root}`,
      `state=${stateDir}`,
      `cache=${cacheDir}`,
      `features=${path.join(hooks, "features")}`,
      `log=${path.join(cacheDir, "launcher.log")}`,
    ];

    for (const phase of ["prelaunch", "cold-start", "after-exit"]) {
      writeExecutable(
        path.join(hooks, `${phase}.d`, "capture.sh"),
        `#!/bin/bash
output="$TEST_ROOT/${phase}-context"
{
  printf 'phase=%s\\nexit=%s\\n' "$CODEX_LINUX_FEATURE_HOOK_PHASE" "\${CODEX_LINUX_ELECTRON_EXIT_STATUS:-}"
  printf 'app=%s\\nstate=%s\\ncache=%s\\nfeatures=%s\\nlog=%s\\n' \
    "$CODEX_LINUX_APP_DIR" "$CODEX_LINUX_APP_STATE_DIR" "$CODEX_LINUX_APP_CACHE_DIR" \
    "$CODEX_LINUX_FEATURES_DIR" "$CODEX_LINUX_LAUNCHER_LOG"
  printf '%s\\n' "$@"
} > "$output.tmp"
mv "$output.tmp" "$output"
`,
      );
    }

    const result = childProcess.spawnSync(path.join(root, "start.sh"), originalArgs, {
      env: {
        ...process.env,
        CODEX_HOME: path.join(root, "codex-home"),
        CODEX_LINUX_ELECTRON_EXIT_STATUS: "99",
        TEST_ROOT: root,
        XDG_CACHE_HOME: path.join(root, "cache"),
        XDG_CONFIG_HOME: path.join(root, "config"),
        XDG_STATE_HOME: path.join(root, "state"),
      },
      encoding: "utf8",
    });

    assert.equal(result.status, 7);
    waitForFile(path.join(root, "cold-start-context"));
    assert.deepEqual(
      fs.readFileSync(path.join(root, "prelaunch-context"), "utf8").trim().split("\n"),
      ["phase=prelaunch", "exit=", ...expectedHookContext, ...originalArgs],
    );
    assert.deepEqual(
      fs.readFileSync(path.join(root, "cold-start-context"), "utf8").trim().split("\n"),
      ["phase=cold-start", "exit=", ...expectedHookContext, ...originalArgs],
    );
    assert.deepEqual(
      fs.readFileSync(path.join(root, "after-exit-context"), "utf8").trim().split("\n"),
      ["phase=after-exit", "exit=7", ...expectedHookContext, ...originalArgs],
    );
    assert.deepEqual(
      fs.readFileSync(path.join(root, "arguments"), "utf8").trim().split("\n"),
      expectedDesktopArgs,
    );
  }
});

test("launcher preserves app status when an after-exit hook fails", (t) => {
  const root = createApp(t);
  const hooks = path.join(root, ".codex-linux", "after-exit.d");
  writeExecutable(
    path.join(hooks, "01-fail.sh"),
    "#!/bin/bash\nprintf failed > \"$TEST_ROOT/failed-hook\"\nexit 42\n",
  );
  writeExecutable(
    path.join(hooks, "02-continue.sh"),
    "#!/bin/bash\nprintf continued > \"$TEST_ROOT/continued-hook\"\n",
  );

  const result = childProcess.spawnSync(path.join(root, "start.sh"), [], {
    env: {
      ...process.env,
      CODEX_HOME: path.join(root, "codex-home"),
      TEST_ROOT: root,
      XDG_CACHE_HOME: path.join(root, "cache"),
      XDG_CONFIG_HOME: path.join(root, "config"),
      XDG_STATE_HOME: path.join(root, "state"),
    },
    encoding: "utf8",
  });

  assert.equal(result.status, 7);
  assert.equal(fs.readFileSync(path.join(root, "failed-hook"), "utf8"), "failed");
  assert.equal(fs.readFileSync(path.join(root, "continued-hook"), "utf8"), "continued");
});

test("launcher exports the physical default CODEX_HOME when it is a symlink", (t) => {
  const root = createApp(t);
  const home = path.join(root, "home");
  const physicalCodexHome = path.join(root, "physical-codex-home");
  fs.mkdirSync(home, { recursive: true });
  fs.mkdirSync(physicalCodexHome, { recursive: true });
  fs.symlinkSync(physicalCodexHome, path.join(home, ".codex"), "dir");

  const env = {
    ...process.env,
    HOME: home,
    TEST_ROOT: root,
    XDG_CONFIG_HOME: path.join(root, "config"),
  };
  delete env.CODEX_HOME;

  const result = childProcess.spawnSync(path.join(root, "start.sh"), [], {
    env,
    encoding: "utf8",
  });

  assert.equal(result.status, 7);
  assert.equal(fs.readFileSync(path.join(root, "codex-home"), "utf8").trim(), physicalCodexHome);
});

test("launcher exports a physical explicit CODEX_HOME when it is a symlink", (t) => {
  const root = createApp(t);
  const physicalCodexHome = path.join(root, "physical-codex-home");
  const linkedCodexHome = path.join(root, "linked-codex-home");
  fs.mkdirSync(physicalCodexHome, { recursive: true });
  fs.symlinkSync(physicalCodexHome, linkedCodexHome, "dir");

  const result = childProcess.spawnSync(path.join(root, "start.sh"), [], {
    env: {
      ...process.env,
      CODEX_HOME: linkedCodexHome,
      TEST_ROOT: root,
      XDG_CONFIG_HOME: path.join(root, "config"),
    },
    encoding: "utf8",
  });

  assert.equal(result.status, 7);
  assert.equal(fs.readFileSync(path.join(root, "codex-home"), "utf8").trim(), physicalCodexHome);
});

test("launcher ignores CDPATH when canonicalizing a relative CODEX_HOME", (t) => {
  const root = createApp(t);
  const codexHome = path.join(root, "profile");
  const cdpathRoot = path.join(root, "cdpath");
  fs.mkdirSync(codexHome, { recursive: true });
  fs.mkdirSync(path.join(cdpathRoot, "profile"), { recursive: true });

  const result = childProcess.spawnSync(path.join(root, "start.sh"), [], {
    cwd: root,
    env: {
      ...process.env,
      CDPATH: cdpathRoot,
      CODEX_HOME: "profile",
      TEST_ROOT: root,
      XDG_CONFIG_HOME: path.join(root, "config"),
    },
    encoding: "utf8",
  });

  assert.equal(result.status, 7);
  assert.equal(fs.readFileSync(path.join(root, "codex-home"), "utf8").trim(), codexHome);
});

test("launcher treats a dash CODEX_HOME as a relative directory", (t) => {
  const root = createApp(t);
  const codexHome = path.join(root, "-");
  const oldWorkingDirectory = path.join(root, "old-working-directory");
  fs.mkdirSync(codexHome, { recursive: true });
  fs.mkdirSync(oldWorkingDirectory, { recursive: true });

  const result = childProcess.spawnSync(path.join(root, "start.sh"), [], {
    cwd: root,
    env: {
      ...process.env,
      CODEX_HOME: "-",
      OLDPWD: oldWorkingDirectory,
      TEST_ROOT: root,
      XDG_CONFIG_HOME: path.join(root, "config"),
    },
    encoding: "utf8",
  });

  assert.equal(result.status, 7);
  assert.equal(fs.readFileSync(path.join(root, "codex-home"), "utf8").trim(), codexHome);
});

test("launcher preserves the physical root CODEX_HOME spelling", (t) => {
  const root = createApp(t);

  const result = childProcess.spawnSync(path.join(root, "start.sh"), [], {
    env: {
      ...process.env,
      CODEX_HOME: "/",
      TEST_ROOT: root,
      XDG_CONFIG_HOME: path.join(root, "config"),
    },
    encoding: "utf8",
  });

  assert.equal(result.status, 7);
  assert.equal(fs.readFileSync(path.join(root, "codex-home"), "utf8").trim(), "/");
});

test("launcher canonicalizes CODEX_HOME loaded from an environment hook", (t) => {
  const root = createApp(t);
  const physicalCodexHome = path.join(root, "physical-codex-home");
  const linkedCodexHome = path.join(root, "linked-codex-home");
  fs.mkdirSync(physicalCodexHome, { recursive: true });
  fs.symlinkSync(physicalCodexHome, linkedCodexHome, "dir");
  fs.mkdirSync(path.join(root, ".codex-linux", "env.d"), { recursive: true });
  fs.writeFileSync(path.join(root, ".codex-linux", "env.d", "codex-home.env"), `CODEX_HOME=${linkedCodexHome}\n`);

  const env = {
    ...process.env,
    TEST_ROOT: root,
    XDG_CONFIG_HOME: path.join(root, "config"),
  };
  delete env.CODEX_HOME;

  const result = childProcess.spawnSync(path.join(root, "start.sh"), [], {
    env,
    encoding: "utf8",
  });

  assert.equal(result.status, 7);
  assert.equal(fs.readFileSync(path.join(root, "codex-home"), "utf8").trim(), physicalCodexHome);
});

test("launcher loads global and app-specific Electron flags", (t) => {
  const root = createApp(t);
  const configHome = path.join(root, "config");
  fs.mkdirSync(path.join(configHome, "codex-desktop"), { recursive: true });
  fs.writeFileSync(
    path.join(configHome, "electron-flags.conf"),
    "# Shared Electron flags\n  --ozone-platform=wayland  \r\n\n",
  );
  fs.writeFileSync(
    path.join(configHome, "codex-desktop", "electron-flags.conf"),
    "  # Community-only flags\n--enable-features=WaylandWindowDecorations\n",
  );
  writeExecutable(
    path.join(root, ".codex-linux", "launcher.d", "capture-args.sh"),
    "#!/bin/bash\nprintf '%s\\n' \"$@\" > \"$TEST_ROOT/launcher-hook-arguments\"\n",
  );

  const result = childProcess.spawnSync(
    path.join(root, "start.sh"),
    ["--ozone-platform=x11", "codex://thread/123"],
    {
      env: {
        ...process.env,
        CODEX_HOME: path.join(root, "codex-home"),
        XDG_CONFIG_HOME: configHome,
        TEST_ROOT: root,
      },
      encoding: "utf8",
    },
  );

  assert.equal(result.status, 7);
  assert.deepEqual(fs.readFileSync(path.join(root, "arguments"), "utf8").trim().split("\n"), [
    "--class=codex-desktop",
    "--ozone-platform=wayland",
    "--enable-features=WaylandWindowDecorations",
    "--ozone-platform=x11",
    "codex://thread/123",
  ]);
  assert.deepEqual(
    fs.readFileSync(path.join(root, "launcher-hook-arguments"), "utf8").trim().split("\n"),
    [
      "--class=codex-desktop",
      "--ozone-platform=wayland",
      "--enable-features=WaylandWindowDecorations",
      "--ozone-platform=x11",
      "codex://thread/123",
    ],
  );
});

test("launcher uses the HOME config fallback and ignores non-file flag paths", (t) => {
  const root = createApp(t);
  const home = path.join(root, "home");
  const configHome = path.join(home, ".config");
  fs.mkdirSync(path.join(configHome, "electron-flags.conf"), { recursive: true });
  fs.mkdirSync(path.join(configHome, "codex-desktop"), { recursive: true });
  fs.writeFileSync(
    path.join(configHome, "codex-desktop", "electron-flags.conf"),
    "--ozone-platform=wayland\n",
  );
  const env = {
    ...process.env,
    CODEX_HOME: path.join(root, "codex-home"),
    HOME: home,
    TEST_ROOT: root,
  };
  delete env.XDG_CONFIG_HOME;

  const result = childProcess.spawnSync(path.join(root, "start.sh"), [], {
    env,
    encoding: "utf8",
  });

  assert.equal(result.status, 7);
  assert.equal(result.stderr, "");
  assert.equal(
    fs.readFileSync(path.join(root, "arguments"), "utf8"),
    "--class=codex-desktop\n--ozone-platform=wayland\n",
  );
});

// A confirmed Wayland session: a live compositor socket in an isolated
// XDG_RUNTIME_DIR, and a systemd user manager that exports no Sommelier
// markers. Tests that need Crostini or GNOME layer their own markers on top.
function createWaylandSession(t, root, { systemdEnvironment = "", listening = true } = {}) {
  const runtimeDir = fs.mkdtempSync(path.join(os.tmpdir(), "codex-launcher-wayland-"));
  const socketPath = path.join(runtimeDir, "wayland-0");
  const server = net.createServer();
  server.listen(socketPath);
  t.after(() => {
    server.close();
    fs.rmSync(runtimeDir, { recursive: true, force: true });
  });
  const binDir = path.join(runtimeDir, "bin");
  writeExecutable(
    path.join(binDir, "systemctl"),
    `#!/bin/bash\nprintf '%b' ${JSON.stringify(systemdEnvironment)}\n`,
  );
  // iproute2 listing of listening unix sockets; a crashed compositor leaves
  // the inode without a listener, which "listening: false" reproduces.
  const listenerLines = listening === true
    ? `u_str LISTEN 0 4096 ${socketPath} 146902 * 0\nu_str LISTEN 0 4096 /run/user/1000/bus 146901 * 0\n`
    : "u_str LISTEN 0 4096 /run/user/1000/bus 146901 * 0\n";
  writeExecutable(
    path.join(binDir, "ss"),
    listening === "unavailable"
      ? "#!/bin/bash\nexit 255\n"
      : `#!/bin/bash\nprintf '%b' ${JSON.stringify(listenerLines)}\n`,
  );
  return {
    ...process.env,
    CODEX_HOME: path.join(root, "codex-home"),
    PATH: `${binDir}:${process.env.PATH}`,
    TEST_ROOT: root,
    WAYLAND_DISPLAY: "wayland-0",
    XDG_CONFIG_HOME: path.join(root, "config"),
    XDG_RUNTIME_DIR: runtimeDir,
    XDG_SESSION_TYPE: "wayland",
  };
}

function createDrmRoot(t, connectedCount) {
  const drmRoot = fs.mkdtempSync(path.join(os.tmpdir(), "codex-launcher-drm-"));
  t.after(() => fs.rmSync(drmRoot, { recursive: true, force: true }));
  for (let index = 0; index < connectedCount + 1; index += 1) {
    const connector = path.join(drmRoot, `card0-DP-${index + 1}`);
    fs.mkdirSync(connector);
    fs.writeFileSync(path.join(connector, "status"), index < connectedCount ? "connected\n" : "disconnected\n");
  }
  return drmRoot;
}

function launchArguments(root, env, args = []) {
  const result = childProcess.spawnSync(path.join(root, "start.sh"), args, { env, encoding: "utf8" });
  assert.equal(result.status, 7);
  return { result, args: fs.readFileSync(path.join(root, "arguments"), "utf8").trim().split("\n") };
}

test("launcher selects the Wayland backend for a confirmed Wayland session", (t) => {
  const root = createApp(t);
  const session = createWaylandSession(t, root);

  assert.deepEqual(launchArguments(root, session, ["codex://thread/123"]).args, [
    "--class=codex-desktop",
    "--ozone-platform=wayland",
    "codex://thread/123",
  ]);

  // An absolute socket path.
  assert.deepEqual(
    launchArguments(root, { ...session, WAYLAND_DISPLAY: path.join(session.XDG_RUNTIME_DIR, "wayland-0") }).args,
    ["--class=codex-desktop", "--ozone-platform=wayland"],
  );

  // GNOME with a single connected output is not the multi-monitor case.
  assert.deepEqual(
    launchArguments(root, {
      ...session,
      CODEX_DRM_CLASS_ROOT: createDrmRoot(t, 1),
      XDG_CURRENT_DESKTOP: "GNOME",
    }).args,
    ["--class=codex-desktop", "--ozone-platform=wayland"],
  );
});

test("launcher keeps the X11 default when no Wayland session is confirmed", (t) => {
  const root = createApp(t);
  const session = createWaylandSession(t, root);
  const expectDefault = (env) => {
    const { result, args } = launchArguments(root, env);
    assert.equal(result.stderr, "");
    assert.deepEqual(args, ["--class=codex-desktop"]);
  };

  // No compositor at all.
  const bare = { ...session };
  delete bare.WAYLAND_DISPLAY;
  delete bare.XDG_SESSION_TYPE;
  expectDefault(bare);

  // A stale WAYLAND_DISPLAY left over from an earlier session.
  expectDefault({ ...session, WAYLAND_DISPLAY: "wayland-9" });

  // An absolute socket path that no longer exists.
  expectDefault({ ...session, WAYLAND_DISPLAY: path.join(session.XDG_RUNTIME_DIR, "missing-0") });

  // An X11 session that still exports a usable Wayland socket.
  expectDefault({ ...session, XDG_SESSION_TYPE: "x11" });

  // ChromeOS Crostini, where an Electron Wayland window never surfaces.
  expectDefault({ ...session, SOMMELIER_VERSION: "0.20" });
  expectDefault({ ...session, SOMMELIER_VM_IDENTIFIER: "termina" });
});

test("launcher treats a socket inode without a listener as no session", (t) => {
  const root = createApp(t);
  const stale = createWaylandSession(t, root, { listening: false });
  const { result, args } = launchArguments(root, stale);

  assert.equal(result.stderr, "");
  assert.deepEqual(args, ["--class=codex-desktop"]);

  // Without a usable iproute2 the inode check stands on its own.
  const unlisted = createWaylandSession(t, root, { listening: "unavailable" });
  assert.deepEqual(launchArguments(root, unlisted).args, [
    "--class=codex-desktop",
    "--ozone-platform=wayland",
  ]);
});

test("launcher finds Sommelier markers that only the systemd user manager exports", (t) => {
  const root = createApp(t);
  const session = createWaylandSession(t, root, {
    systemdEnvironment: "DISPLAY=:0\nSOMMELIER_VERSION=0.20\nWAYLAND_DISPLAY=wayland-0\n",
  });

  assert.deepEqual(launchArguments(root, session).args, ["--class=codex-desktop"]);
});

test("launcher keeps GNOME Wayland multi-monitor sessions on X11", (t) => {
  const root = createApp(t);
  const session = createWaylandSession(t, root);
  const drmRoot = createDrmRoot(t, 2);

  for (const desktop of [
    { XDG_CURRENT_DESKTOP: "ubuntu:GNOME" },
    { XDG_SESSION_DESKTOP: "gnome" },
    { DESKTOP_SESSION: "gnome-wayland" },
  ]) {
    assert.deepEqual(
      launchArguments(root, { ...session, CODEX_DRM_CLASS_ROOT: drmRoot, ...desktop }).args,
      ["--class=codex-desktop"],
    );
  }

  // Another desktop with the same monitors keeps native Wayland.
  assert.deepEqual(
    launchArguments(root, { ...session, CODEX_DRM_CLASS_ROOT: drmRoot, XDG_CURRENT_DESKTOP: "KDE" }).args,
    ["--class=codex-desktop", "--ozone-platform=wayland"],
  );
});

test("CODEX_OZONE_PLATFORM pins a backend ahead of session detection", (t) => {
  const root = createApp(t);
  const session = createWaylandSession(t, root);

  // Pinning X11 inside a confirmed Wayland session, as the Nix wrapper does.
  let launch = launchArguments(root, { ...session, CODEX_OZONE_PLATFORM: "x11" });
  assert.equal(launch.result.stderr, "");
  assert.deepEqual(launch.args, ["--class=codex-desktop", "--ozone-platform=x11"]);

  // Pinning Wayland where detection would have declined.
  launch = launchArguments(root, { ...session, CODEX_OZONE_PLATFORM: "wayland", SOMMELIER_VERSION: "0.20" });
  assert.equal(launch.result.stderr, "");
  assert.deepEqual(launch.args, ["--class=codex-desktop", "--ozone-platform=wayland"]);

  // An invalid value warns and falls back to detection.
  launch = launchArguments(root, { ...session, CODEX_OZONE_PLATFORM: "gtk" });
  assert.match(launch.result.stderr, /Ignoring CODEX_OZONE_PLATFORM=gtk; expected auto, x11, or wayland/);
  assert.deepEqual(launch.args, ["--class=codex-desktop", "--ozone-platform=wayland"]);

  // An explicit switch still wins over the pin.
  launch = launchArguments(root, { ...session, CODEX_OZONE_PLATFORM: "wayland" }, ["--ozone-platform=x11"]);
  assert.deepEqual(launch.args, ["--class=codex-desktop", "--ozone-platform=x11"]);
});

test("an explicit Ozone selection suppresses the Wayland backend", (t) => {
  const root = createApp(t);
  const session = createWaylandSession(t, root);
  const configHome = session.XDG_CONFIG_HOME;
  const hooks = path.join(root, ".codex-linux");
  const expectExplicit = (args) => {
    assert.deepEqual(launchArguments(root, session, args).args, [
      "--class=codex-desktop",
      "--ozone-platform=x11",
    ]);
  };

  // A command-line argument.
  expectExplicit(["--ozone-platform=x11"]);

  // A user flag file.
  fs.mkdirSync(path.join(configHome, "codex-desktop"), { recursive: true });
  fs.writeFileSync(
    path.join(configHome, "codex-desktop", "electron-flags.conf"),
    "--ozone-platform=x11\n",
  );
  expectExplicit([]);
  fs.rmSync(path.join(configHome, "codex-desktop", "electron-flags.conf"));

  // A feature argument file.
  fs.mkdirSync(path.join(hooks, "electron-args.d"), { recursive: true });
  fs.writeFileSync(path.join(hooks, "electron-args.d", "fixture.args"), "--ozone-platform=x11\n");
  expectExplicit([]);
  fs.rmSync(path.join(hooks, "electron-args.d"), { recursive: true });

  // A launcher hook.
  writeExecutable(
    path.join(hooks, "launcher.d", "select-backend.sh"),
    "#!/bin/bash\nprintf 'electron-arg %s\\n' '--ozone-platform=x11'\n",
  );
  expectExplicit([]);
  fs.rmSync(path.join(hooks, "launcher.d"), { recursive: true });

  // A leftover hint is not a selection: this runtime ignores it, so the
  // session would otherwise stay on XWayland.
  fs.writeFileSync(
    path.join(configHome, "codex-desktop", "electron-flags.conf"),
    "--ozone-platform-hint=auto\n",
  );
  assert.deepEqual(launchArguments(root, session).args, [
    "--class=codex-desktop",
    "--ozone-platform-hint=auto",
    "--ozone-platform=wayland",
  ]);
});

test("diagnose validates the official runtime without starting it", (t) => {
  const root = createApp(t);
  const result = childProcess.spawnSync(path.join(root, "start.sh"), ["--diagnose"], {
    env: { ...process.env, XDG_CONFIG_HOME: path.join(root, "config"), TEST_ROOT: root }, encoding: "utf8",
  });
  assert.equal(result.status, 0);
  assert.match(result.stdout, /ok: .*\/ChatGPT/);
  assert.equal(fs.existsSync(path.join(root, "arguments")), false);
});

test("launcher replaces only matching retired Browser and Chrome plugin caches", (t) => {
  const root = createApp(t);
  const codexHome = path.join(root, "codex-home");
  const manifest = (pluginId) =>
    `{"name":"${pluginId}","version":"26.803.81509"}\n`;
  const matchingCaches = [];

  for (const pluginId of ["browser", "chrome"]) {
    const bundledPlugin = path.join(
      root,
      `resources/plugins/openai-bundled/plugins/${pluginId}`,
    );
    const matchingCache = path.join(
      codexHome,
      `plugins/cache/openai-bundled/${pluginId}/26.803.81509`,
    );
    const officialClient = `export const officialLinux${pluginId}Client = true;\n`;
    const officialHost = `official ${pluginId} extension host\n`;
    for (const pluginRoot of [bundledPlugin, matchingCache]) {
      fs.mkdirSync(path.join(pluginRoot, ".codex-plugin"), { recursive: true });
      fs.mkdirSync(path.join(pluginRoot, "scripts"), { recursive: true });
      fs.mkdirSync(path.join(pluginRoot, "extension-host/linux/x64"), {
        recursive: true,
      });
      fs.writeFileSync(
        path.join(pluginRoot, ".codex-plugin/plugin.json"),
        manifest(pluginId),
      );
    }
    fs.writeFileSync(
      path.join(bundledPlugin, "scripts/browser-client.mjs"),
      officialClient,
    );
    fs.writeFileSync(
      path.join(bundledPlugin, "extension-host/linux/x64/extension-host"),
      officialHost,
    );
    fs.writeFileSync(
      path.join(matchingCache, "scripts/browser-client.mjs"),
      "/*codexLinuxPerUserBrowserSocketDir*/ legacy client\n",
    );
    fs.writeFileSync(
      path.join(matchingCache, "extension-host/linux/x64/extension-host"),
      "legacy custom extension host\n",
    );
    fs.writeFileSync(path.join(matchingCache, "legacy-extra"), "remove me\n");
    matchingCaches.push({ matchingCache, officialClient, officialHost });
  }

  const cacheRoot = path.join(codexHome, "plugins/cache/openai-bundled/browser");
  const officialCache = path.join(cacheRoot, "official-copy");
  fs.mkdirSync(path.join(officialCache, ".codex-plugin"), { recursive: true });
  fs.mkdirSync(path.join(officialCache, "scripts"), { recursive: true });
  fs.writeFileSync(
    path.join(officialCache, ".codex-plugin/plugin.json"),
    manifest("browser"),
  );
  const alreadyOfficialClient = "export const cachedOfficialClient = true;\n";
  fs.writeFileSync(
    path.join(officialCache, "scripts/browser-client.mjs"),
    alreadyOfficialClient,
  );

  const unrelatedCache = path.join(cacheRoot, "custom");
  fs.mkdirSync(path.join(unrelatedCache, ".codex-plugin"), { recursive: true });
  fs.mkdirSync(path.join(unrelatedCache, "scripts"), { recursive: true });
  fs.writeFileSync(
    path.join(unrelatedCache, ".codex-plugin/plugin.json"),
    '{"name":"browser","version":"custom"}\n',
  );
  const unrelatedClient = "/*codexLinuxIabSocketScope*/ custom client\n";
  fs.writeFileSync(
    path.join(unrelatedCache, "scripts/browser-client.mjs"),
    unrelatedClient,
  );

  const pluginAppserver = path.join(codexHome, "plugins/.plugin-appserver");
  fs.mkdirSync(pluginAppserver, { recursive: true, mode: 0o775 });
  fs.chmodSync(pluginAppserver, 0o775);

  const result = childProcess.spawnSync(path.join(root, "start.sh"), [], {
    env: {
      ...process.env,
      CODEX_HOME: codexHome,
      XDG_CONFIG_HOME: path.join(root, "config"),
      TEST_ROOT: root,
    },
    encoding: "utf8",
  });
  assert.equal(result.status, 7);
  assert.match(result.stderr, /Refreshed legacy browser plugin cache/);
  assert.match(result.stderr, /Refreshed legacy chrome plugin cache/);
  for (const { matchingCache, officialClient, officialHost } of matchingCaches) {
    assert.equal(
      fs.readFileSync(path.join(matchingCache, "scripts/browser-client.mjs"), "utf8"),
      officialClient,
    );
    assert.equal(
      fs.readFileSync(
        path.join(matchingCache, "extension-host/linux/x64/extension-host"),
        "utf8",
      ),
      officialHost,
    );
    assert.equal(fs.existsSync(path.join(matchingCache, "legacy-extra")), false);
  }
  assert.equal(
    fs.readFileSync(path.join(officialCache, "scripts/browser-client.mjs"), "utf8"),
    alreadyOfficialClient,
  );
  assert.equal(
    fs.readFileSync(path.join(unrelatedCache, "scripts/browser-client.mjs"), "utf8"),
    unrelatedClient,
  );
  assert.equal(fs.statSync(pluginAppserver).mode & 0o022, 0);
});
