#!/usr/bin/env node
"use strict";

const assert = require("node:assert/strict");
const { spawn, spawnSync } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const REAPER = path.join(__dirname, "reaper.sh");
const COLD_START_HOOK = path.join(__dirname, "cold-start-hook.sh");
const AFTER_EXIT_HOOK = path.join(__dirname, "after-exit-hook.sh");
const LONG_RUNNING_NODE_ARGS = ["-e", "setInterval(() => {}, 1000)"];

function commandPath(name) {
  for (const directory of (process.env.PATH || "").split(path.delimiter)) {
    if (!directory || !path.isAbsolute(directory)) continue;
    const candidate = path.join(directory, name);
    try {
      fs.accessSync(candidate, fs.constants.X_OK);
      if (!fs.statSync(candidate).isFile()) continue;
      return candidate;
    } catch {}
  }
  throw new Error(`could not resolve executable from PATH: ${name}`);
}

const BASH = commandPath("bash");

test("tracks only the latest official ChatGPT and CUA helper layout", () => {
  const source = fs.readFileSync(REAPER, "utf8");
  assert.match(source, /\$APP_DIR\/ChatGPT/);
  assert.match(source, /\$APP_DIR\/resources\/cua_node\/bin\/node_repl/);
  assert.doesNotMatch(source, /\$APP_DIR\/electron/);
  assert.doesNotMatch(source, /\$APP_DIR\/resources\/node_repl(?:\.|\")/);
});

function makeFakeApp() {
  const appDir = fs.mkdtempSync(path.join(os.tmpdir(), "codex-node-repl-reaper-test-"));
  fs.mkdirSync(path.join(appDir, "resources", "cua_node", "bin"), { recursive: true });
  // The fake binaries run Node through app-local symlinks; what matters is
  // that /proc/<pid>/cmdline starts with the install-scoped executable path,
  // like the official ChatGPT and CUA node_repl helpers.
  const nodeReplBin = path.join(appDir, "resources", "cua_node", "bin", "node_repl");
  fs.symlinkSync(process.execPath, nodeReplBin);
  const chatGptBin = path.join(appDir, "ChatGPT");
  fs.symlinkSync(process.execPath, chatGptBin);
  return { appDir, nodeReplBin, chatGptBin };
}

function pidAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function runReaperOnce(appDir) {
  const result = spawnSync(BASH, [REAPER, appDir, "once"], {
    encoding: "utf8",
    env: { ...process.env, CODEX_NODE_REPL_REAPER_KILL_GRACE: "1" },
  });
  assert.equal(result.status, 0, `reaper failed: ${result.stderr}\n${result.stdout}`);
  return result.stdout;
}

function waitForExit(pid, timeoutMs = 4000) {
  return new Promise((resolve, reject) => {
    const deadline = Date.now() + timeoutMs;
    const poll = () => {
      if (!pidAlive(pid)) return resolve();
      if (Date.now() > deadline) return reject(new Error(`pid ${pid} still alive`));
      setTimeout(poll, 100);
    };
    poll();
  });
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function spawnOrphan(nodeReplBin) {
  const launcher = spawn(BASH, ["-c", '"$1" -e "setInterval(() => {}, 1000)" </dev/null >/dev/null 2>&1 & printf "%s" "$!"', "test", nodeReplBin], {
    stdio: ["ignore", "pipe", "pipe"],
  });
  let output = "";
  launcher.stdout.on("data", (chunk) => { output += chunk; });
  await new Promise((resolve, reject) => {
    launcher.once("error", reject);
    launcher.once("close", (code) => code === 0 ? resolve() : reject(new Error(`orphan launcher exited ${code}`)));
  });
  assert.match(output, /^\d+$/);
  const pid = Number(output);
  try {
    await waitForFileContent(`/proc/${pid}/cmdline`, (content) => content.split("\0")[0] === nodeReplBin);
    return pid;
  } catch (error) {
    if (pidAlive(pid)) process.kill(pid, "SIGKILL");
    throw error;
  }
}

function runReaperFunctions(fixture) {
  const source = fs.readFileSync(REAPER, "utf8");
  const main = source.lastIndexOf('\nif [ "$MODE" = "watch" ]; then');
  assert.ok(main > 0);
  return spawnSync(BASH, ["-c", `${source.slice(0, main)}\n${fixture}`, "test", "/tmp/test-reaper-app"], { encoding: "utf8" });
}

test("ancestry checks preserve helpers on cycles, unreadable processes, and bounded traversal", () => {
  const cases = [
    ["proc_ppid() { echo 0; }", 0],
    ["proc_ppid() { echo 17; }", 1],
    ["proc_ppid() { return 1; }", 1],
    ["proc_ppid() { echo invalid; }", 1],
    ["proc_ppid() { echo $(($1 + 1)); }", 1],
    ["proc_ppid() { echo 17; }; parent_is_live_codex_owner() { return 2; }", 1],
    ["proc_ppid() { echo 17; }; parent_is_live_codex_owner() { return 0; }", 1],
  ];
  for (const [fixture, expected] of cases) {
    const result = runReaperFunctions(`proc_is_install_node_repl() { return 0; }\nparent_is_live_codex_owner() { return 1; }\n${fixture}\nnode_repl_is_leaked 10`);
    assert.equal(result.status, expected, `${fixture}\n${result.stderr}`);
  }
});

test("rechecks ownership before SIGTERM and before escalation", () => {
  const beforeTerm = runReaperFunctions(`
    leaked_node_repl_pids() { echo 10; }
    node_repl_is_leaked() { return 1; }
    kill() { echo unexpected-signal; }
    reap_leaked_node_repls
  `);
  assert.equal(beforeTerm.status, 0, beforeTerm.stderr);
  assert.equal(beforeTerm.stdout, "");
  const beforeKill = runReaperFunctions(`
    changed=0
    leaked_node_repl_pids() { echo 10; }
    node_repl_is_leaked() { [ "$changed" = 0 ]; }
    kill() { echo "signal:$*"; }
    sleep() { changed=1; }
    reap_leaked_node_repls
  `);
  assert.equal(beforeKill.status, 0, beforeKill.stderr);
  assert.match(beforeKill.stdout, /signal:10/);
  assert.doesNotMatch(beforeKill.stdout, /SIGKILL|signal:-9/);
});

for (const { wrapped, executableOwner, launcherName } of [
  { wrapped: false, executableOwner: false, launcherName: "node" },
  { wrapped: true, executableOwner: false, launcherName: "node" },
  { wrapped: false, executableOwner: true, launcherName: "node" },
  { wrapped: false, executableOwner: true, launcherName: "codex-linux-sandbox" },
  { wrapped: false, executableOwner: true, launcherName: "codex-mcp-helper-reaper" },
]) {
  test(`preserves a ${wrapped ? "wrapped " : ""}helper through ${launcherName} until its ${executableOwner ? "executable" : "script"} Codex owner exits`, async () => {
    const { appDir, nodeReplBin } = makeFakeApp();
    const helperBin = wrapped ? `${nodeReplBin}.codex-linux-original` : nodeReplBin;
    if (wrapped) fs.symlinkSync(process.execPath, helperBin);
    const launcher = path.join(appDir, "launch.mjs");
    fs.writeFileSync(launcher, `
      import { spawn } from "node:child_process";
      const child = spawn(${JSON.stringify(helperBin)}, ${JSON.stringify(LONG_RUNNING_NODE_ARGS)}, { stdio: "ignore" });
      child.once("spawn", () => console.log("launcher=" + process.pid + " child=" + child.pid));
      setInterval(() => {}, 1000);
    `);
    const fakeCodex = path.join(appDir, "codex");
    let ownerArgs;
    if (executableOwner) {
      fs.symlinkSync(process.execPath, fakeCodex);
      const launcherBin = path.join(appDir, launcherName);
      fs.symlinkSync(process.execPath, launcherBin);
      ownerArgs = ["-e", `require("node:child_process").spawn(${JSON.stringify(launcherBin)}, [${JSON.stringify(launcher)}], { stdio: "inherit" });`, "app-server"];
    } else {
      fs.writeFileSync(fakeCodex, `#!${BASH}\n"${process.execPath}" "${launcher}" &\nwait\n`);
      fs.chmodSync(fakeCodex, 0o755);
      ownerArgs = ["app-server"];
    }
    const owner = spawn(fakeCodex, ownerArgs, { stdio: ["ignore", "pipe", "ignore"] });
    let launcherPid;
    let childPid;
    try {
      ({ launcherPid, childPid } = await new Promise((resolve, reject) => {
        let buffer = "";
        owner.stdout.on("data", (chunk) => {
          buffer += chunk;
          const match = buffer.match(/launcher=(\d+) child=(\d+)/);
          if (match) resolve({ launcherPid: Number(match[1]), childPid: Number(match[2]) });
        });
        owner.once("exit", () => reject(new Error("fake Codex exited before launcher startup")));
      }));
      const output = runReaperOnce(appDir);
      assert.doesNotMatch(output, new RegExp(`pid=${childPid}\\b`));
      assert.ok(pidAlive(childPid), "live launcher's helper was killed");
      owner.kill("SIGKILL");
      await waitForExit(owner.pid);
      assert.ok(pidAlive(launcherPid), "launcher must remain alive to test ancestor ownership");
      assert.match(runReaperOnce(appDir), new RegExp(`reaping leaked node_repl pid=${childPid}\\b`));
      await waitForExit(childPid);
    } finally {
      for (const pid of [childPid, launcherPid, owner.pid]) {
        if (pid && pidAlive(pid)) process.kill(pid, "SIGKILL");
      }
      fs.rmSync(appDir, { recursive: true, force: true });
    }
  });
}

async function waitForFileContent(file, predicate, timeoutMs = 2000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (fs.existsSync(file)) {
      const content = fs.readFileSync(file, "utf8");
      if (predicate(content)) return content;
    }
    await delay(20);
  }
  assert.fail(`timed out waiting for complete content in ${file}`);
}

test("lifecycle hooks use exported app context instead of desktop arguments", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "codex-node-repl-hook-test-"));
  const appDir = path.join(root, "app");
  const stateDir = path.join(root, "state");
  const callLog = path.join(root, "calls.log");
  const stagedReaper = path.join(appDir, ".codex-linux", "node-repl-reaper.sh");
  fs.mkdirSync(path.dirname(stagedReaper), { recursive: true });
  fs.writeFileSync(
    stagedReaper,
    `#!${BASH}
printf '%s %s\\n' "$1" "$2" >> "${callLog}"
`,
    { mode: 0o755 },
  );
  const env = {
    ...process.env,
    CODEX_LINUX_APP_DIR: appDir,
    CODEX_LINUX_APP_STATE_DIR: stateDir,
  };

  const coldStart = spawnSync(BASH, [COLD_START_HOOK, "codex://thread/123"], {
    encoding: "utf8",
    env,
  });
  assert.equal(coldStart.status, 0, coldStart.stderr);
  const afterExit = spawnSync(BASH, [AFTER_EXIT_HOOK, "codex://thread/123"], {
    encoding: "utf8",
    env,
  });
  assert.equal(afterExit.status, 0, afterExit.stderr);
  assert.equal(fs.existsSync(path.join(stateDir, "node-repl-reaper.pid")), true);

  const calls = await waitForFileContent(
    callLog,
    (content) => content.includes(`${appDir} watch`) && content.includes(`${appDir} once`),
  );
  assert.ok(calls.split("\n").includes(`${appDir} watch`));
  assert.ok(calls.split("\n").includes(`${appDir} once`));

  fs.rmSync(root, { recursive: true, force: true });
});

test("reaps an orphaned node_repl after its launching process exits", async () => {
  const { appDir, nodeReplBin } = makeFakeApp();
  const leakedPid = await spawnOrphan(nodeReplBin);
  try {
    const output = runReaperOnce(appDir);
    assert.match(output, new RegExp(`reaping leaked node_repl pid=${leakedPid}\\b`));
    await waitForExit(leakedPid);
  } finally {
    if (pidAlive(leakedPid)) process.kill(leakedPid, "SIGKILL");
    fs.rmSync(appDir, { recursive: true, force: true });
  }
});

test("reaps a wrapped node_repl running from the original backup path", async () => {
  const { appDir } = makeFakeApp();
  const originalNodeReplBin = path.join(appDir, "resources", "cua_node", "bin", "node_repl.codex-linux-original");
  fs.symlinkSync(process.execPath, originalNodeReplBin);
  const leakedPid = await spawnOrphan(originalNodeReplBin);
  try {
    const output = runReaperOnce(appDir);
    assert.match(output, new RegExp(`reaping leaked node_repl pid=${leakedPid}\\b`));
    await waitForExit(leakedPid);
  } finally {
    if (pidAlive(leakedPid)) process.kill(leakedPid, "SIGKILL");
    fs.rmSync(appDir, { recursive: true, force: true });
  }
});

test("leaves a node_repl with a live codex app-server parent alone", async () => {
  const { appDir, nodeReplBin } = makeFakeApp();
  // Fake app-server: an executable named codex run with an app-server arg,
  // so the parent's /proc cmdline matches "*codex*app-server*". It spawns
  // the helper and stays alive holding it.
  const fakeCodex = path.join(appDir, "codex");
  fs.writeFileSync(
    fakeCodex,
    `#!${BASH}\n"${nodeReplBin}" -e 'setInterval(() => {}, 1000)' &\necho "child=$!"\nwait\n`,
  );
  fs.chmodSync(fakeCodex, 0o755);
  const appServer = spawn(fakeCodex, ["app-server"], { stdio: ["ignore", "pipe", "ignore"] });
  try {
    const childPid = await new Promise((resolve, reject) => {
      let buffer = "";
      appServer.stdout.on("data", (chunk) => {
        buffer += chunk;
        const match = buffer.match(/child=(\d+)/);
        if (match) resolve(Number(match[1]));
      });
      appServer.once("exit", () => reject(new Error("fake app-server exited early")));
    });
    assert.ok(pidAlive(childPid));

    const output = runReaperOnce(appDir);
    assert.doesNotMatch(output, new RegExp(`pid=${childPid}\\b`));
    assert.ok(pidAlive(childPid), "protected node_repl was killed");

    // Once the app-server dies, the same helper becomes leaked and is reaped.
    appServer.kill("SIGKILL");
    await waitForExit(appServer.pid);
    runReaperOnce(appDir);
    await waitForExit(childPid);
  } finally {
    try { appServer.kill("SIGKILL"); } catch {}
    spawnSync("pkill", ["-9", "-f", nodeReplBin]);
    fs.rmSync(appDir, { recursive: true, force: true });
  }
});

test("leaves a node_repl with a live codex resume parent alone", async () => {
  const { appDir, nodeReplBin } = makeFakeApp();
  const fakeCodex = path.join(appDir, "codex");
  fs.writeFileSync(
    fakeCodex,
    `#!${BASH}\n"${nodeReplBin}" -e 'setInterval(() => {}, 1000)' &\necho "child=$!"\nwait\n`,
  );
  fs.chmodSync(fakeCodex, 0o755);
  const cliSession = spawn(fakeCodex, ["resume"], { stdio: ["ignore", "pipe", "ignore"] });
  try {
    const childPid = await new Promise((resolve, reject) => {
      let buffer = "";
      cliSession.stdout.on("data", (chunk) => {
        buffer += chunk;
        const match = buffer.match(/child=(\d+)/);
        if (match) resolve(Number(match[1]));
      });
      cliSession.once("exit", () => reject(new Error("fake codex resume exited early")));
    });
    assert.ok(pidAlive(childPid));

    const output = runReaperOnce(appDir);
    assert.doesNotMatch(output, new RegExp(`pid=${childPid}\\b`));
    assert.ok(pidAlive(childPid), "protected node_repl was killed");
  } finally {
    try { cliSession.kill("SIGKILL"); } catch {}
    spawnSync("pkill", ["-9", "-f", nodeReplBin]);
    fs.rmSync(appDir, { recursive: true, force: true });
  }
});

test("watch mode waits for the cold-start ChatGPT process before self-terminating", async () => {
  const { appDir, chatGptBin } = makeFakeApp();
  const watcher = spawn("bash", [REAPER, appDir, "watch"], {
    encoding: "utf8",
    env: {
      ...process.env,
      CODEX_NODE_REPL_REAPER_INTERVAL: "1",
      CODEX_NODE_REPL_REAPER_STARTUP_GRACE: "5",
      CODEX_NODE_REPL_REAPER_KILL_GRACE: "1",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let chatGpt;
  try {
    await new Promise((resolve) => watcher.once("spawn", resolve));
    await delay(1200);
    assert.ok(pidAlive(watcher.pid), "watchdog exited before ChatGPT appeared");

    chatGpt = spawn(chatGptBin, ["-e", "setTimeout(() => {}, 3000)"], { stdio: "ignore" });
    await new Promise((resolve) => chatGpt.once("spawn", resolve));
    await waitForExit(chatGpt.pid, 6000);
    await waitForExit(watcher.pid, 6000);
  } finally {
    try { watcher.kill("SIGKILL"); } catch {}
    try { chatGpt?.kill("SIGKILL"); } catch {}
    fs.rmSync(appDir, { recursive: true, force: true });
  }
});
