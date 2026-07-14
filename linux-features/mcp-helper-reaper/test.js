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

function makeTempDir(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function writeExecutable(file, body) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, body, { mode: 0o755 });
}

function hostTool(name) {
  for (const dir of (process.env.PATH || "").split(path.delimiter)) {
    if (!dir || !path.isAbsolute(dir)) continue;
    const candidate = path.join(dir, name);
    try {
      fs.accessSync(candidate, fs.constants.X_OK);
      if (fs.statSync(candidate).isFile()) return candidate;
    } catch {}
  }
  throw new Error(`could not resolve executable from PATH: ${name}`);
}

function symlinkHostTools(targetDir, names) {
  fs.mkdirSync(targetDir, { recursive: true });
  for (const name of names) {
    fs.symlinkSync(hostTool(name), path.join(targetDir, name));
  }
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

test("stage hook finds cargo in HOME cargo bin when PATH omits it", () => {
  const tempDir = makeTempDir("codex-mcp-helper-reaper-cargo-");
  const scriptRoot = path.join(tempDir, "repo");
  const appDir = path.join(tempDir, "app");
  const workDir = path.join(tempDir, "work");
  const homeDir = path.join(tempDir, "home");
  const fakeBin = path.join(tempDir, "bin");
  const featureDir = path.join(scriptRoot, "linux-features", "mcp-helper-reaper");
  const reaperCrateDir = path.join(featureDir, "reaper");
  const cargoLog = path.join(tempDir, "cargo.log");
  const nodeRepl = path.join(appDir, "resources", "node_repl");

  fs.mkdirSync(reaperCrateDir, { recursive: true });
  fs.mkdirSync(workDir, { recursive: true });
  fs.mkdirSync(path.dirname(nodeRepl), { recursive: true });
  symlinkHostTools(fakeBin, ["bash", "cat", "chmod", "grep", "install", "mkdir", "mv"]);
  for (const file of [
    "install-session-hook.sh",
    "cold-start-hook.sh",
    "after-exit-hook.sh",
  ]) {
    fs.copyFileSync(path.join(FEATURE_DIR, file), path.join(featureDir, file));
  }
  writeExecutable(nodeRepl, "#!/usr/bin/env bash\necho original node_repl\n");
  writeExecutable(
    path.join(homeDir, ".cargo", "bin", "cargo"),
    `#!${hostTool("bash")}
set -euo pipefail
printf '%s\\n' "$PWD $*" > "$CODEX_MCP_HELPER_REAPER_TEST_CARGO_LOG"
mkdir -p target/release
cat > target/release/codex-mcp-helper-reaper <<'EOF'
#!${hostTool("bash")}
exit 0
EOF
chmod 0755 target/release/codex-mcp-helper-reaper
`,
  );

  run(hostTool("bash"), [STAGE], {
    env: {
      SCRIPT_DIR: scriptRoot,
      INSTALL_DIR: appDir,
      WORK_DIR: workDir,
      ARCH: process.arch,
      HOME: homeDir,
      PATH: fakeBin,
      CODEX_MCP_HELPER_REAPER_SOURCE: "",
      CODEX_MCP_HELPER_REAPER_TEST_CARGO_LOG: cargoLog,
    },
  });

  assert.match(
    fs.readFileSync(cargoLog, "utf8").trim(),
    new RegExp(`${reaperCrateDir.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")} build --release$`),
  );
  assert.equal(
    fs.existsSync(path.join(appDir, ".codex-linux", "mcp-helper-reaper", "codex-mcp-helper-reaper")),
    true,
  );
  assert.match(fs.readFileSync(nodeRepl, "utf8"), /original node_repl/);
  assert.equal(fs.existsSync(path.join(appDir, "resources", "node_repl.codex-linux-original")), false);

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
  const stateDir = path.join(tempDir, "state");
  const logDir = path.join(tempDir, "log");
  const codexHome = path.join(tempDir, "codex-home");
  const reaper = path.join(appDir, ".codex-linux", "mcp-helper-reaper", "codex-mcp-helper-reaper");
  fs.mkdirSync(codexHome, { recursive: true });
  fs.mkdirSync(stateDir, { recursive: true });
  fs.mkdirSync(logDir, { recursive: true });
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

  const env = { CODEX_HOME: codexHome };
  run("bash", [INSTALL_SESSION_HOOK, appDir, stateDir, logDir], { env });
  run("bash", [INSTALL_SESSION_HOOK, appDir, stateDir, logDir], { env });

  const merged = JSON.parse(fs.readFileSync(path.join(codexHome, "hooks.json"), "utf8"));
  const commands = merged.hooks.SessionStart.flatMap((entry) => entry.hooks ?? []).map((hook) => hook.command);
  assert.equal(commands.filter((command) => command.includes("existing-session-hook")).length, 1);
  const reaperCommands = commands.filter((command) => command.includes("codex-mcp-helper-reaper-session"));
  assert.equal(reaperCommands.length, 1);
  assert.match(reaperCommands[0], /--codex-parent "\$PPID"/);
  assert.match(reaperCommands[0], /--include-orphans/);
  assert.match(reaperCommands[0], /--app-dir /);

  fs.rmSync(tempDir, { recursive: true, force: true });
});

test("cold-start hook launches a short all-parent scan", async () => {
  const tempDir = makeTempDir("codex-mcp-helper-reaper-cold-");
  const appDir = path.join(tempDir, "app");
  const stateDir = path.join(tempDir, "state");
  const logDir = path.join(tempDir, "log");
  const callLog = path.join(tempDir, "calls.log");
  const featureDir = path.join(appDir, ".codex-linux", "mcp-helper-reaper");
  const reaper = path.join(featureDir, "codex-mcp-helper-reaper");
  fs.mkdirSync(stateDir, { recursive: true });
  fs.mkdirSync(logDir, { recursive: true });
  writeExecutable(
    reaper,
    "#!/usr/bin/env bash\nprintf '%s\\n' \"$*\" >> \"$CODEX_MCP_HELPER_REAPER_TEST_LOG\"\n",
  );

  run("bash", [COLD_START_HOOK, appDir, stateDir, logDir], {
    env: {
      CODEX_MCP_HELPER_REAPER_TEST_LOG: callLog,
      CODEX_MCP_HELPER_REAPER_DELAY: "0",
      CODEX_MCP_HELPER_REAPER_PASSES: "1",
    },
  });

  await new Promise((resolve) => setTimeout(resolve, 300));
  const calls = fs.readFileSync(callLog, "utf8");
  assert.match(calls, /--all-codex-parents/);
  assert.match(calls, /--include-orphans/);
  assert.match(calls, /--app-dir /);

  fs.rmSync(tempDir, { recursive: true, force: true });
});
