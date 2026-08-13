"use strict";

const assert = require("node:assert/strict");
const childProcess = require("node:child_process");
const fs = require("node:fs");
const net = require("node:net");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const templatePath = path.join(__dirname, "start.sh.template");

// Launcher tests must never contact the production usage counter. Individual
// reporting tests opt back in with an isolated fake curl executable.
process.env.CODEX_LINUX_DISABLE_USAGE_REPORTING = "1";

function writeExecutable(filePath, source) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, source, { mode: 0o755 });
}

function createApp(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "codex-launcher-test-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
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

  const missingRoot = createApp(t);
  const missingBin = path.join(missingRoot, "bin");
  fs.mkdirSync(missingBin, { recursive: true });
  fs.symlinkSync("/usr/bin/dirname", path.join(missingBin, "dirname"));
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

function launcherEnvironment(root, overrides = {}) {
  const env = {
    ...process.env,
    CODEX_HOME: path.join(root, "codex-home"),
    XDG_CONFIG_HOME: path.join(root, "config"),
    TEST_ROOT: root,
  };
  for (const key of ["DISPLAY", "NIXOS_OZONE_WL", "WAYLAND_DISPLAY", "XDG_RUNTIME_DIR", "XDG_SESSION_TYPE"]) {
    delete env[key];
  }
  return { ...env, ...overrides };
}

function launch(root, args = [], env = {}) {
  return childProcess.spawnSync(path.join(root, "start.sh"), args, {
    env: launcherEnvironment(root, env),
    encoding: "utf8",
  });
}

function capturedArguments(root) {
  const output = fs.readFileSync(path.join(root, "arguments"), "utf8").trimEnd();
  return output === "" ? [] : output.split("\n");
}

function listenUnixSocket(socketPath) {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once("error", reject);
    server.listen(socketPath, () => resolve(server));
  });
}

function closeUnixSocket(server) {
  return new Promise((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
}

function createStaleUnixSocket(socketPath) {
  const child = childProcess.spawn(
    process.execPath,
    ["-e", "require('node:net').createServer().listen(process.argv[1], () => process.stdout.write('ready'))", socketPath],
    { stdio: ["ignore", "pipe", "inherit"] },
  );
  return new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("exit", (code, signal) => reject(new Error(`socket helper exited before ready: ${code}/${signal}`)));
    child.stdout.once("data", (output) => {
      if (output.toString() !== "ready") {
        reject(new Error(`socket helper failed to start: ${output}`));
        return;
      }
      child.removeAllListeners("exit");
      child.once("exit", () => resolve());
      child.kill("SIGKILL");
    });
  });
}

function createBoundUnixSocket(socketPath, socketType) {
  const source = [
    "import signal, socket, sys",
    "sock = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM if sys.argv[1] == 'stream' else socket.SOCK_DGRAM)",
    "sock.bind(sys.argv[2])",
    "print('ready', flush=True)",
    "signal.pause()",
  ].join("\n");
  const child = childProcess.spawn("python3", ["-c", source, socketType, socketPath], {
    stdio: ["ignore", "pipe", "inherit"],
  });
  return new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("exit", (code, signal) => reject(new Error(`socket helper exited before ready: ${code}/${signal}`)));
    child.stdout.once("data", (output) => {
      if (output.toString() !== "ready\n") {
        reject(new Error(`socket helper failed to start: ${output}`));
        return;
      }
      child.removeAllListeners("exit");
      resolve(child);
    });
  });
}

function stopSocketHelper(child) {
  return new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("exit", () => resolve());
    child.kill("SIGTERM");
  });
}

const nativeWaylandDefaults = [
  "--ozone-platform=wayland",
  "--enable-wayland-ime=true",
  "--wayland-text-input-version=3",
];

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

  const env = launcherEnvironment(root);
  delete env.CHROME_DESKTOP;
  delete env.BAMF_DESKTOP_FILE_HINT;
  const result = childProcess.spawnSync(path.join(root, "start.sh"), ["codex://thread/123", "--new-window"], { env, encoding: "utf8" });
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
      env: launcherEnvironment(root, { XDG_CONFIG_HOME: configHome }),
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
  const env = launcherEnvironment(root, { HOME: home });
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

test("launcher selects native Wayland from a live relative display socket", async (t) => {
  const root = createApp(t);
  const runtimeDir = path.join(root, "runtime");
  const socketName = "wayland-test";
  fs.mkdirSync(runtimeDir);
  const server = await listenUnixSocket(path.join(runtimeDir, socketName));
  try {
    fs.mkdirSync(path.join(root, "config"), { recursive: true });
    fs.writeFileSync(path.join(root, "config", "electron-flags.conf"), "--unrelated-config\n");
    fs.mkdirSync(path.join(root, ".codex-linux", "electron-args.d"), { recursive: true });
    fs.writeFileSync(path.join(root, ".codex-linux", "electron-args.d", "fixture.args"), "--unrelated-feature\n");
    writeExecutable(
      path.join(root, ".codex-linux", "launcher.d", "fixture.sh"),
      "#!/bin/bash\nprintf '%s\\n' 'electron-arg --unrelated-launcher'\n",
    );

    const result = launch(root, ["codex://thread/123", "--new-window"], {
      DISPLAY: ":0",
      XDG_RUNTIME_DIR: runtimeDir,
      XDG_SESSION_TYPE: "wayland",
      WAYLAND_DISPLAY: socketName,
    });

    assert.equal(result.status, 7);
    assert.deepEqual(capturedArguments(root), [
      ...nativeWaylandDefaults,
      "--class=codex-desktop",
      "--unrelated-config",
      "--unrelated-feature",
      "--unrelated-launcher",
      "codex://thread/123",
      "--new-window",
    ]);
  } finally {
    await closeUnixSocket(server);
  }
});

test("launcher accepts a live absolute Wayland display socket", async (t) => {
  const root = createApp(t);
  const socketDir = path.join(root, "sockets");
  const socketPath = path.join(socketDir, "absolute-wayland.sock");
  fs.mkdirSync(socketDir);
  const server = await listenUnixSocket(socketPath);
  try {
    const aliases = [
      ["absolute", socketPath],
      ["symlink", path.join(root, "socket-link", "absolute-wayland.sock")],
      ["dot-dot", `${socketDir}/../sockets/absolute-wayland.sock`],
    ];
    fs.symlinkSync(socketDir, path.join(root, "socket-link"));

    for (const [name, displayPath] of aliases) {
      const result = launch(root, ["--absolute-socket"], {
        XDG_SESSION_TYPE: "wayland",
        WAYLAND_DISPLAY: displayPath,
      });
      assert.equal(result.status, 7, name);
      assert.deepEqual(capturedArguments(root), [...nativeWaylandDefaults, "--class=codex-desktop", "--absolute-socket"], name);
    }

    const trailingSpaceSocket = path.join(socketDir, "trailing-space ");
    const trailingSpaceServer = await listenUnixSocket(trailingSpaceSocket);
    try {
      const result = launch(root, ["--trailing-space-socket"], {
        XDG_SESSION_TYPE: "wayland",
        WAYLAND_DISPLAY: trailingSpaceSocket,
      });
      assert.equal(result.status, 7);
      assert.deepEqual(capturedArguments(root), [...nativeWaylandDefaults, "--class=codex-desktop", "--trailing-space-socket"]);
    } finally {
      await closeUnixSocket(trailingSpaceServer);
    }
  } finally {
    await closeUnixSocket(server);
  }
});

test("launcher requires a live Wayland session socket for automatic defaults", async (t) => {
  const root = createApp(t);
  const runtimeDir = path.join(root, "runtime");
  const socketName = "wayland-test";
  const socketPath = path.join(runtimeDir, socketName);
  fs.mkdirSync(runtimeDir);
  const server = await listenUnixSocket(socketPath);
  const staleSocket = path.join(runtimeDir, "stale-wayland");
  await createStaleUnixSocket(staleSocket);
  assert.equal(fs.lstatSync(staleSocket).isSocket(), true);
  let boundStream;
  let datagramSocket;
  try {
    boundStream = await createBoundUnixSocket(path.join(runtimeDir, "bound-stream"), "stream");
    datagramSocket = await createBoundUnixSocket(path.join(runtimeDir, "datagram"), "datagram");
    const cases = [
      ["non-Wayland session", { XDG_RUNTIME_DIR: runtimeDir, XDG_SESSION_TYPE: "x11", WAYLAND_DISPLAY: socketName }],
      ["missing runtime directory", { XDG_SESSION_TYPE: "wayland", WAYLAND_DISPLAY: socketName }],
      ["stale display socket", { XDG_RUNTIME_DIR: runtimeDir, XDG_SESSION_TYPE: "wayland", WAYLAND_DISPLAY: "stale-wayland" }],
      ["missing display socket", { XDG_RUNTIME_DIR: runtimeDir, XDG_SESSION_TYPE: "wayland", WAYLAND_DISPLAY: "missing-wayland" }],
      ["bound non-listening stream socket", { XDG_RUNTIME_DIR: runtimeDir, XDG_SESSION_TYPE: "wayland", WAYLAND_DISPLAY: "bound-stream" }],
      ["datagram socket", { XDG_RUNTIME_DIR: runtimeDir, XDG_SESSION_TYPE: "wayland", WAYLAND_DISPLAY: "datagram" }],
    ];
    const nonSocket = path.join(runtimeDir, "not-a-socket");
    fs.writeFileSync(nonSocket, "fixture");
    cases.push([
      "non-socket display path",
      { XDG_RUNTIME_DIR: runtimeDir, XDG_SESSION_TYPE: "wayland", WAYLAND_DISPLAY: "not-a-socket" },
    ]);

    for (const [name, environment] of cases) {
      const result = launch(root, ["--probe"], environment);
      assert.equal(result.status, 7, name);
      assert.deepEqual(capturedArguments(root), ["--class=codex-desktop", "--probe"], name);
    }
  } finally {
    if (datagramSocket) await stopSocketHelper(datagramSocket);
    if (boundStream) await stopSocketHelper(boundStream);
    await closeUnixSocket(server);
  }
});

test("explicit --ozone-platform selections from every source suppress automatic Wayland defaults", async (t) => {
  const scenarios = [
    {
      name: "global Electron flags exact ozone platform",
      setup: (root) => {
        fs.mkdirSync(path.join(root, "config"), { recursive: true });
        fs.writeFileSync(path.join(root, "config", "electron-flags.conf"), "--ozone-platform\n");
      },
      expected: ["--class=codex-desktop", "--ozone-platform", "--probe"],
    },
    {
      name: "direct assigned ozone platform",
      setup: () => {},
      args: ["--ozone-platform=x11", "--probe"],
      expected: ["--class=codex-desktop", "--ozone-platform=x11", "--probe"],
    },
  ];

  for (const scenario of scenarios) {
    const root = createApp(t);
    const runtimeDir = path.join(root, "runtime");
    const socketName = "wayland-test";
    fs.mkdirSync(runtimeDir);
    const server = await listenUnixSocket(path.join(runtimeDir, socketName));
    try {
      scenario.setup(root);
      const result = launch(root, scenario.args ?? ["--probe"], {
        XDG_RUNTIME_DIR: runtimeDir,
        XDG_SESSION_TYPE: "wayland",
        WAYLAND_DISPLAY: socketName,
      });
      assert.equal(result.status, 7, scenario.name);
      assert.deepEqual(capturedArguments(root), scenario.expected, scenario.name);
    } finally {
      await closeUnixSocket(server);
    }
  }
});

test("explicit Wayland IME configuration keeps precedence over automatic defaults", async (t) => {
  const root = createApp(t);
  const runtimeDir = path.join(root, "runtime");
  const socketName = "wayland-test";
  fs.mkdirSync(runtimeDir);
  const server = await listenUnixSocket(path.join(runtimeDir, socketName));
  try {
    const result = launch(root, ["--disable-wayland-ime", "--probe"], {
      XDG_RUNTIME_DIR: runtimeDir,
      XDG_SESSION_TYPE: "wayland",
      WAYLAND_DISPLAY: socketName,
    });
    assert.equal(result.status, 7);
    assert.deepEqual(capturedArguments(root), [
      "--ozone-platform=wayland",
      "--class=codex-desktop",
      "--disable-wayland-ime",
      "--probe",
    ]);
  } finally {
    await closeUnixSocket(server);
  }
});

test("NIXOS_OZONE_WL preserves its explicit compatibility opt-in", (t) => {
  const root = createApp(t);
  const result = launch(root, ["--probe"], {
    NIXOS_OZONE_WL: "1",
    WAYLAND_DISPLAY: "wayland-without-session-metadata",
  });
  assert.equal(result.status, 7);
  assert.deepEqual(capturedArguments(root), [...nativeWaylandDefaults, "--class=codex-desktop", "--probe"]);

  const optOut = launch(root, ["--ozone-platform=x11", "--probe"], {
    NIXOS_OZONE_WL: "1",
    WAYLAND_DISPLAY: "wayland-without-session-metadata",
  });
  assert.equal(optOut.status, 7);
  assert.deepEqual(capturedArguments(root), ["--class=codex-desktop", "--ozone-platform=x11", "--probe"]);
});

test("diagnose validates the official runtime without starting it", (t) => {
  const root = createApp(t);
  const result = childProcess.spawnSync(path.join(root, "start.sh"), ["--diagnose"], {
    env: launcherEnvironment(root), encoding: "utf8",
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
    env: launcherEnvironment(root, { CODEX_HOME: codexHome }),
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
