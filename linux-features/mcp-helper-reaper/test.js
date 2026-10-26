#!/usr/bin/env node
"use strict";

const assert = require("node:assert/strict");
const { spawnSync } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const FEATURE_DIR = __dirname;
const REPO_ROOT = path.resolve(FEATURE_DIR, "../..");
const STAGE = path.join(FEATURE_DIR, "stage.sh");
const CLEANUP = path.join(FEATURE_DIR, "cleanup.sh");
const INSTALL_SESSION_HOOK = path.join(FEATURE_DIR, "install-session-hook.sh");
const COLD_START_HOOK = path.join(FEATURE_DIR, "cold-start-hook.sh");
const LAUNCHER_TEMPLATE = path.join(REPO_ROOT, "launcher", "start.sh.template");

function makeTempDir(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function writeExecutable(file, body) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, body, { mode: 0o755 });
}

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: REPO_ROOT,
    encoding: "utf8",
    ...options,
    env: { ...process.env, ...(options.env ?? {}) },
  });
  assert.equal(
    result.status,
    0,
    `${command} ${args.join(" ")} failed\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`,
  );
  return result;
}

async function waitForFileContent(file, predicate, timeoutMs = 2000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (fs.existsSync(file)) {
      const content = fs.readFileSync(file, "utf8");
      if (predicate(content)) return content;
    }
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  assert.fail(`timed out waiting for complete content in ${file}`);
}

test("stage hook installs the orphan reaper without wrapping node_repl", () => {
  const tempDir = makeTempDir("codex-mcp-helper-reaper-stage-");
  const appDir = path.join(tempDir, "app");
  const workDir = path.join(tempDir, "work");
  const source = path.join(tempDir, "source", "codex-mcp-helper-reaper");
  const nodeRepl = path.join(appDir, "resources", "node_repl");
  fs.mkdirSync(path.dirname(nodeRepl), { recursive: true });
  fs.mkdirSync(workDir, { recursive: true });
  writeExecutable(source, "#!/usr/bin/env bash\nexit 0\n");
  writeExecutable(nodeRepl, "#!/usr/bin/env bash\necho original node_repl\n");

  const env = {
    SCRIPT_DIR: REPO_ROOT,
    INSTALL_DIR: appDir,
    WORK_DIR: workDir,
    ARCH: process.arch,
    CODEX_MCP_HELPER_REAPER_SOURCE: source,
  };

  run("bash", [STAGE], { env });
  run("bash", [STAGE], { env });

  const installedRoot = path.join(appDir, ".codex-linux");
  const installedReaper = path.join(installedRoot, "mcp-helper-reaper", "codex-mcp-helper-reaper");
  assert.equal(fs.statSync(installedReaper).mode & 0o111, 0o111);
  assert.equal(fs.statSync(path.join(installedRoot, "mcp-helper-reaper", "install-session-hook.sh")).mode & 0o111, 0o111);
  assert.equal(fs.statSync(path.join(installedRoot, "cold-start.d", "mcp-helper-reaper")).mode & 0o111, 0o111);
  assert.equal(fs.statSync(path.join(installedRoot, "after-exit.d", "mcp-helper-reaper")).mode & 0o111, 0o111);
  assert.match(fs.readFileSync(nodeRepl, "utf8"), /original node_repl/);
  assert.equal(fs.existsSync(path.join(appDir, "resources", "node_repl.codex-linux-original")), false);
  assert.equal(fs.existsSync(path.join(installedRoot, "mcp-helper-reaper", "node-repl-wrapper.sh")), false);

  fs.rmSync(tempDir, { recursive: true, force: true });
});

test("stage hook restores a node_repl wrapper left by the previous feature version", () => {
  const tempDir = makeTempDir("codex-mcp-helper-reaper-refresh-");
  const appDir = path.join(tempDir, "app");
  const workDir = path.join(tempDir, "work");
  const source = path.join(tempDir, "source", "codex-mcp-helper-reaper");
  const nodeRepl = path.join(appDir, "resources", "node_repl");
  const originalNodeRepl = path.join(appDir, "resources", "node_repl.codex-linux-original");
  fs.mkdirSync(path.dirname(nodeRepl), { recursive: true });
  fs.mkdirSync(workDir, { recursive: true });
  writeExecutable(source, "#!/usr/bin/env bash\nexit 0\n");
  writeExecutable(
    nodeRepl,
    "#!/usr/bin/env bash\n# mcp-helper-reaper-node-repl-wrapper\nexit 0\n",
  );
  writeExecutable(originalNodeRepl, "#!/usr/bin/env bash\necho original node_repl\n");

  const env = {
    SCRIPT_DIR: REPO_ROOT,
    INSTALL_DIR: appDir,
    WORK_DIR: workDir,
    ARCH: process.arch,
    CODEX_MCP_HELPER_REAPER_SOURCE: source,
  };

  run("bash", [STAGE], { env });

  assert.match(fs.readFileSync(nodeRepl, "utf8"), /original node_repl/);
  assert.doesNotMatch(fs.readFileSync(nodeRepl, "utf8"), /mcp-helper-reaper-node-repl-wrapper/);
  assert.equal(fs.existsSync(originalNodeRepl), false);

  fs.rmSync(tempDir, { recursive: true, force: true });
});

test("cleanup hook restores node_repl and removes staged hooks", () => {
  const tempDir = makeTempDir("codex-mcp-helper-reaper-cleanup-");
  const appDir = path.join(tempDir, "app");
  const workDir = path.join(tempDir, "work");
  const source = path.join(tempDir, "source", "codex-mcp-helper-reaper");
  const codexHome = path.join(tempDir, "codex-home");
  const nodeRepl = path.join(appDir, "resources", "node_repl");
  fs.mkdirSync(path.dirname(nodeRepl), { recursive: true });
  fs.mkdirSync(workDir, { recursive: true });
  fs.mkdirSync(codexHome, { recursive: true });
  writeExecutable(source, "#!/usr/bin/env bash\nexit 0\n");
  writeExecutable(nodeRepl, "#!/usr/bin/env bash\necho original node_repl\n");
  fs.writeFileSync(
    path.join(codexHome, "hooks.json"),
    JSON.stringify({
      hooks: {
        SessionStart: [
          {
            matcher: "startup|resume",
            hooks: [
              { type: "command", command: "existing mcp report # existing-session-hook", timeout: 15 },
              { type: "command", command: "true # codex-mcp-helper-reaper-session", timeout: 1 },
            ],
          },
        ],
      },
    }) + "\n",
  );

  const env = {
    SCRIPT_DIR: REPO_ROOT,
    INSTALL_DIR: appDir,
    WORK_DIR: workDir,
    ARCH: process.arch,
    CODEX_HOME: codexHome,
    CODEX_MCP_HELPER_REAPER_SOURCE: source,
  };

  run("bash", [STAGE], { env });
  run("bash", [CLEANUP], { env });
  run("bash", [CLEANUP], { env });

  assert.match(fs.readFileSync(nodeRepl, "utf8"), /original node_repl/);
  assert.equal(fs.existsSync(path.join(appDir, "resources", "node_repl.codex-linux-original")), false);
  assert.equal(fs.existsSync(path.join(appDir, ".codex-linux", "mcp-helper-reaper")), false);
  assert.equal(fs.existsSync(path.join(appDir, ".codex-linux", "cold-start.d", "mcp-helper-reaper")), false);
  assert.equal(fs.existsSync(path.join(appDir, ".codex-linux", "after-exit.d", "mcp-helper-reaper")), false);
  const hooks = JSON.parse(fs.readFileSync(path.join(codexHome, "hooks.json"), "utf8"));
  const commands = hooks.hooks.SessionStart.flatMap((entry) => entry.hooks ?? []).map((hook) => hook.command);
  assert.deepEqual(commands, ["existing mcp report # existing-session-hook"]);

  fs.rmSync(tempDir, { recursive: true, force: true });
});

test("session hook merge preserves existing SessionStart hook and deduplicates reaper hook", () => {
  const tempDir = makeTempDir("codex-mcp-helper-reaper-hooks-");
  const appDir = path.join(tempDir, "app");
  const codexHome = path.join(tempDir, "codex-home");
  const reaper = path.join(appDir, ".codex-linux", "mcp-helper-reaper", "codex-mcp-helper-reaper");
  fs.mkdirSync(codexHome, { recursive: true });
  writeExecutable(reaper, "#!/usr/bin/env bash\nexit 0\n");
  fs.writeFileSync(
    path.join(codexHome, "hooks.json"),
    JSON.stringify(
      {
        hooks: {
          SessionStart: [
            {
              matcher: "startup|resume",
              hooks: [
                {
                  type: "command",
                  command: "existing mcp report --scope project >/dev/null 2>&1 || true # existing-session-hook",
                  timeout: 15,
                },
              ],
            },
          ],
        },
      },
      null,
      2,
    ) + "\n",
  );

  const env = { CODEX_HOME: codexHome, CODEX_LINUX_APP_DIR: appDir };
  run("bash", [INSTALL_SESSION_HOOK], { env });
  run("bash", [INSTALL_SESSION_HOOK], { env });

  const merged = JSON.parse(fs.readFileSync(path.join(codexHome, "hooks.json"), "utf8"));
  const sessionHooks = merged.hooks.SessionStart.flatMap((entry) => entry.hooks ?? []);
  const commands = sessionHooks.map((hook) => hook.command);
  assert.equal(commands.filter((command) => command.includes("existing-session-hook")).length, 1);
  const reaperHooks = sessionHooks.filter((hook) =>
    hook.command.includes("codex-mcp-helper-reaper-session"),
  );
  assert.equal(reaperHooks.length, 1);
  assert.equal(reaperHooks[0].statusMessage, "MCP Helper Reaper");
  const reaperCommands = reaperHooks.map((hook) => hook.command);
  assert.equal(reaperCommands.length, 1);
  assert.match(reaperCommands[0], /--codex-parent "\$PPID"/);
  assert.match(reaperCommands[0], /--include-orphans/);
  assert.match(reaperCommands[0], /--app-dir /);

  fs.rmSync(tempDir, { recursive: true, force: true });
});

function reaperHookCommand(codexHome) {
  const hooks = JSON.parse(fs.readFileSync(path.join(codexHome, "hooks.json"), "utf8"));
  const commands = hooks.hooks.SessionStart.flatMap((entry) => entry.hooks ?? [])
    .map((hook) => hook.command)
    .filter((command) => command.includes("codex-mcp-helper-reaper-session"));
  assert.equal(commands.length, 1);
  return commands[0];
}

function writeLoggingReaper(appDir) {
  writeExecutable(
    path.join(appDir, ".codex-linux", "mcp-helper-reaper", "codex-mcp-helper-reaper"),
    "#!/usr/bin/env bash\nprintf '%s %s\\n' \"$0\" \"$*\" >> \"$CODEX_MCP_HELPER_REAPER_TEST_LOG\"\n",
  );
}

test("session hook command stays stable across AppImage mount paths", async () => {
  const tempDir = makeTempDir("codex-mcp-helper-reaper-appimage-");
  const codexHome = path.join(tempDir, "codex-home");
  const mountA = path.join(tempDir, ".mount_chatgptAAAAAA");
  const mountB = path.join(tempDir, ".mount_chatgptBBBBBB");
  const appDirA = path.join(mountA, "opt", "codex-desktop");
  const appDirB = path.join(mountB, "opt", "codex-desktop");
  const callLog = path.join(tempDir, "calls.log");
  writeLoggingReaper(appDirA);
  writeLoggingReaper(appDirB);

  run("bash", [INSTALL_SESSION_HOOK], {
    env: { CODEX_HOME: codexHome, CODEX_LINUX_APP_DIR: appDirA, APPDIR: mountA },
  });
  const firstCommand = reaperHookCommand(codexHome);
  run("bash", [INSTALL_SESSION_HOOK], {
    env: { CODEX_HOME: codexHome, CODEX_LINUX_APP_DIR: appDirB, APPDIR: `${mountB}/` },
  });
  const secondCommand = reaperHookCommand(codexHome);

  assert.equal(secondCommand, firstCommand);
  assert.doesNotMatch(secondCommand, /\.mount_/);

  // Outside the app the temporary mount is gone, so the hook does nothing.
  run("sh", ["-c", secondCommand], {
    env: { CODEX_LINUX_APP_DIR: "", CODEX_MCP_HELPER_REAPER_TEST_LOG: callLog },
  });
  await new Promise((resolve) => setTimeout(resolve, 300));
  assert.equal(fs.existsSync(callLog), false);

  // Inside the app the hook follows the current mount.
  run("sh", ["-c", secondCommand], {
    env: {
      CODEX_LINUX_APP_DIR: appDirB,
      CODEX_MCP_HELPER_REAPER_TEST_LOG: callLog,
      CODEX_MCP_HELPER_REAPER_DELAY: "0",
    },
  });
  const calls = await waitForFileContent(callLog, (content) => content.includes("--quiet"));
  assert.equal(calls.trim().split("\n").length, 1);
  assert.ok(calls.startsWith(`${appDirB}/.codex-linux/mcp-helper-reaper/codex-mcp-helper-reaper `));
  assert.ok(calls.includes(`--app-dir ${appDirB} `));
  assert.match(calls, /--codex-parent \d+ --include-orphans/);

  fs.rmSync(tempDir, { recursive: true, force: true });
});

test("session hook command has no Nix store fallback", () => {
  const tempDir = makeTempDir("codex-mcp-helper-reaper-nix-");
  const codexHome = path.join(tempDir, "codex-home");
  const appDir = path.join(tempDir, "opt", "codex-desktop");
  writeLoggingReaper(appDir);

  // The installer only needs an executable reaper at the given app dir; the
  // fallback decision depends on the path prefix alone.
  const storeApp = "/nix/store/0000000000000000000000000000000a-codex-desktop/opt/codex-desktop";
  const shim = path.join(tempDir, "install-session-hook.sh");
  fs.writeFileSync(
    shim,
    fs.readFileSync(INSTALL_SESSION_HOOK, "utf8").replace(
      'reaper="$app_dir/.codex-linux',
      `reaper=${JSON.stringify(appDir)}"/.codex-linux`,
    ),
  );

  run("bash", [shim], {
    env: { CODEX_HOME: codexHome, CODEX_LINUX_APP_DIR: storeApp, APPDIR: "" },
  });
  const command = reaperHookCommand(codexHome);
  assert.doesNotMatch(command, /\/nix\/store/);
  assert.match(command, /\|\| codex_mcp_reaper_app=''; /);

  fs.rmSync(tempDir, { recursive: true, force: true });
});

test("native session hook falls back to its install directory outside the app", async () => {
  const tempDir = makeTempDir("codex-mcp-helper-reaper-native-");
  const codexHome = path.join(tempDir, "codex-home");
  const appDir = path.join(tempDir, "opt", "codex-desktop");
  const callLog = path.join(tempDir, "calls.log");
  writeLoggingReaper(appDir);

  run("bash", [INSTALL_SESSION_HOOK], {
    env: { CODEX_HOME: codexHome, CODEX_LINUX_APP_DIR: appDir, APPDIR: "" },
  });
  const command = reaperHookCommand(codexHome);

  run("sh", ["-c", command], {
    env: { CODEX_LINUX_APP_DIR: "", CODEX_MCP_HELPER_REAPER_TEST_LOG: callLog },
  });
  const calls = await waitForFileContent(callLog, (content) => content.includes("--quiet"));
  assert.ok(calls.startsWith(`${appDir}/.codex-linux/mcp-helper-reaper/codex-mcp-helper-reaper `));
  assert.ok(calls.includes(`--app-dir ${appDir} `));

  fs.rmSync(tempDir, { recursive: true, force: true });
});

test("cold-start hook launches a short all-parent scan", async () => {
  const tempDir = makeTempDir("codex-mcp-helper-reaper-cold-");
  const appDir = path.join(tempDir, "app");
  const callLog = path.join(tempDir, "calls.log");
  const featureDir = path.join(appDir, ".codex-linux", "mcp-helper-reaper");
  const reaper = path.join(featureDir, "codex-mcp-helper-reaper");
  writeExecutable(
    reaper,
    "#!/usr/bin/env bash\nprintf '%s\\n' \"$*\" >> \"$CODEX_MCP_HELPER_REAPER_TEST_LOG\"\n",
  );

  run("bash", [COLD_START_HOOK], {
    env: {
      CODEX_LINUX_APP_DIR: appDir,
      CODEX_MCP_HELPER_REAPER_TEST_LOG: callLog,
      CODEX_MCP_HELPER_REAPER_DELAY: "0",
      CODEX_MCP_HELPER_REAPER_PASSES: "1",
    },
  });

  const calls = await waitForFileContent(
    callLog,
    (content) => content.includes("--all-codex-parents"),
  );
  assert.match(calls, /--all-codex-parents/);
  assert.match(calls, /--include-orphans/);
  assert.match(calls, /--app-dir /);

  fs.rmSync(tempDir, { recursive: true, force: true });
});

test("staged lifecycle hooks reach the reaper through the launcher", async () => {
  const tempDir = makeTempDir("codex-mcp-helper-reaper-launcher-");
  const appDir = path.join(tempDir, "app");
  const workDir = path.join(tempDir, "work");
  const source = path.join(tempDir, "source", "codex-mcp-helper-reaper");
  const callLog = path.join(tempDir, "calls.log");
  const appArgs = path.join(tempDir, "app-arguments.log");
  const codexHome = path.join(tempDir, "codex-home");
  const launcher = fs
    .readFileSync(LAUNCHER_TEMPLATE, "utf8")
    .replaceAll("__CODEX_LINUX_APP_ID__", "codex-desktop")
    .replaceAll("__CODEX_LINUX_APP_DISPLAY_NAME__", "ChatGPT Community");

  fs.mkdirSync(workDir, { recursive: true });
  writeExecutable(
    source,
    "#!/usr/bin/env bash\nprintf '%s\\t%s\\n' \"$CODEX_LINUX_FEATURE_HOOK_PHASE\" \"$*\" >> \"$CODEX_MCP_HELPER_REAPER_TEST_LOG\"\n",
  );
  for (const relative of [
    "resources/app.asar",
    "resources/codex",
    "resources/rg",
    "resources/codex-code-mode-host",
    "resources/node_repl",
  ]) {
    writeExecutable(path.join(appDir, relative), "#!/usr/bin/env bash\nexit 0\n");
  }
  writeExecutable(path.join(appDir, "start.sh"), launcher);
  writeExecutable(
    path.join(appDir, "ChatGPT"),
    `#!/usr/bin/env bash
printf '%s\\n' "$@" > "${appArgs}"
exit 7
`,
  );

  run("bash", [STAGE], {
    env: {
      ARCH: process.arch,
      CODEX_MCP_HELPER_REAPER_SOURCE: source,
      INSTALL_DIR: appDir,
      SCRIPT_DIR: REPO_ROOT,
      WORK_DIR: workDir,
    },
  });

  const result = spawnSync(path.join(appDir, "start.sh"), ["codex://thread/123"], {
    encoding: "utf8",
    env: {
      ...process.env,
      CODEX_HOME: codexHome,
      CODEX_LINUX_DISABLE_USAGE_REPORTING: "1",
      CODEX_MCP_HELPER_REAPER_DISABLE: "0",
      CODEX_MCP_HELPER_REAPER_DISABLE_HOOK: "0",
      CODEX_MCP_HELPER_REAPER_DELAY: "0",
      CODEX_MCP_HELPER_REAPER_PASSES: "1",
      CODEX_MCP_HELPER_REAPER_TEST_LOG: callLog,
      XDG_CACHE_HOME: path.join(tempDir, "cache"),
      XDG_CONFIG_HOME: path.join(tempDir, "config"),
      XDG_STATE_HOME: path.join(tempDir, "state"),
    },
  });

  assert.equal(result.status, 7, result.stderr);
  const calls = await waitForFileContent(
    callLog,
    (content) =>
      /^cold-start\t.*--all-codex-parents/m.test(content) &&
      /^after-exit\t.*--all-codex-parents/m.test(content),
  );
  assert.match(calls, /^cold-start\t.*--all-codex-parents/m);
  assert.match(calls, /^after-exit\t.*--all-codex-parents/m);
  assert.deepEqual(fs.readFileSync(appArgs, "utf8").trim().split("\n"), [
    "--class=codex-desktop",
    "codex://thread/123",
  ]);
  assert.match(fs.readFileSync(path.join(codexHome, "hooks.json"), "utf8"), /codex-mcp-helper-reaper-session/);

  fs.rmSync(tempDir, { recursive: true, force: true });
});
