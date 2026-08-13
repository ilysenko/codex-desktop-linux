"use strict";

const assert = require("node:assert/strict");
const childProcess = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const templatePath = path.join(__dirname, "start.sh.template");

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
    "--ozone-platform=wayland",
    "--enable-features=WaylandWindowDecorations",
    "--ozone-platform=x11",
    "codex://thread/123",
  ]);
  assert.deepEqual(
    fs.readFileSync(path.join(root, "launcher-hook-arguments"), "utf8").trim().split("\n"),
    [
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
  assert.equal(fs.readFileSync(path.join(root, "arguments"), "utf8"), "--ozone-platform=wayland\n");
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
