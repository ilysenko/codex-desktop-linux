#!/usr/bin/env node
"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const { execFileSync } = require("node:child_process");

const {
  applyChronicleSkysightMainBridgePatch,
  descriptors,
} = require("./patch.js");

const featureDir = __dirname;

function repoRoot() {
  return path.resolve(featureDir, "../..");
}

test("chronicle-skysight is an independent disabled-by-default feature", () => {
  const manifest = JSON.parse(
    fs.readFileSync(path.join(featureDir, "feature.json"), "utf8"),
  );

  assert.equal(manifest.id, "chronicle-skysight");
  assert.equal(manifest.title, "Chronicle / Skysight Activity Memory");
  assert.equal(manifest.defaultEnabled, false);
  assert.deepEqual(manifest.requires ?? [], []);
  assert.equal(fs.existsSync(path.join(featureDir, "README.md")), true);
});

test("chronicle-skysight owns standalone plugin and backend stage files", () => {
  for (const relative of [
    "stage.sh",
    "cleanup.sh",
    "plugin-template/.codex-plugin/plugin.json",
    "plugin-template/.mcp.json",
    "plugin-template/skills/chronicle-skysight/SKILL.md",
  ]) {
    assert.equal(fs.existsSync(path.join(featureDir, relative)), true, relative);
  }
});

test("chronicle-skysight stages restricted MCP plugin and shared backend", () => {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "codex-chronicle-skysight-stage-"));
  try {
    const installDir = path.join(workspace, "install");
    const fakeBinary = path.join(workspace, "codex-record-replay-linux");
    const marketplace = path.join(
      installDir,
      "resources/plugins/openai-bundled/.agents/plugins/marketplace.json",
    );
    fs.mkdirSync(path.dirname(marketplace), { recursive: true });
    fs.writeFileSync(marketplace, JSON.stringify({ plugins: [] }));
    fs.writeFileSync(fakeBinary, "#!/bin/sh\nprintf '{\"ok\":true}\\n'\n");
    fs.chmodSync(fakeBinary, 0o755);

    execFileSync("bash", [path.join(featureDir, "stage.sh")], {
      cwd: workspace,
      env: {
        ...process.env,
        SCRIPT_DIR: repoRoot(),
        INSTALL_DIR: installDir,
        CODEX_RECORD_REPLAY_LINUX_SOURCE: fakeBinary,
      },
      stdio: "pipe",
    });

    const nativeBinary = path.join(installDir, "resources/native/codex-record-replay-linux");
    const pluginDir = path.join(
      installDir,
      "resources/plugins/openai-bundled/plugins/chronicle-skysight",
    );
    const mcp = JSON.parse(fs.readFileSync(path.join(pluginDir, ".mcp.json"), "utf8"));
    const plugins = JSON.parse(fs.readFileSync(marketplace, "utf8")).plugins;
    assert.equal(fs.statSync(nativeBinary).mode & 0o111 ? true : false, true);
    assert.equal(fs.existsSync(path.join(pluginDir, "bin/codex-record-replay-linux")), true);
    assert.deepEqual(mcp.mcpServers["chronicle-skysight"], {
      command: "./bin/codex-record-replay-linux",
      args: ["skysight", "mcp"],
      cwd: ".",
    });
    assert.equal(
      plugins.some(
        (plugin) => plugin.name === "chronicle-skysight"
          && plugin.source?.path === "./plugins/chronicle-skysight",
      ),
      true,
    );
    assert.equal(plugins.some((plugin) => plugin.name === "record-and-replay"), false);
  } finally {
    fs.rmSync(workspace, { recursive: true, force: true });
  }
});

test("chronicle-skysight reuses the updater-staged backend without Cargo", () => {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "codex-chronicle-skysight-backend-"));
  try {
    const backend = path.join(workspace, "target/release/codex-record-replay-linux");
    fs.mkdirSync(path.dirname(backend), { recursive: true });
    fs.writeFileSync(backend, "#!/bin/sh\nexit 0\n", { mode: 0o755 });

    const selected = execFileSync(
      "bash",
      ["-c", ". \"$FEATURE_DIR/shared-backend.sh\"; build_chronicle_skysight_backend"],
      {
        cwd: workspace,
        encoding: "utf8",
        env: {
          ...process.env,
          FEATURE_DIR: featureDir,
          SCRIPT_DIR: workspace,
          CODEX_RECORD_REPLAY_LINUX_SOURCE: "",
          HOME: path.join(workspace, "home-without-cargo"),
        },
      },
    ).trim();

    assert.equal(selected, backend);
  } finally {
    fs.rmSync(workspace, { recursive: true, force: true });
  }
});

test("chronicle-skysight owns activity-memory bridge and tray integration", () => {
  const source = [
    'const cp=require("node:child_process"),fs=require("node:fs"),path=require("node:path");',
    "var tray={getChronicleSidecarControlState:()=>tt().skysight?$9:Se.appServerConnectionRegistry.getMaybeConnection(`local`)?.getChronicleSidecarControlState()??$9,toggleChronicleSidecar:async()=>{if(tt().skysight)return $9;let e=Se.appServerConnectionRegistry.getMaybeConnection(V);return e==null?$9:e.getChronicleSidecarControlState().running?e.pauseChronicleSidecar():e.resumeChronicleSidecar()}};",
    'var bridge={"get-global-state":async({key:e})=>null};',
  ].join("");

  const patched = applyChronicleSkysightMainBridgePatch(source);

  assert.equal(descriptors.length, 1);
  assert.equal(descriptors[0].id, "linux-chronicle-skysight-main-bridge");
  assert.notEqual(patched, source);
  assert.equal(applyChronicleSkysightMainBridgePatch(patched), patched);
  assert.match(patched, /"chronicle-permissions":async/);
  assert.match(patched, /"linux-record-replay-skysight-start":async/);
  assert.match(patched, /codexLinuxChronicleToggleSidecar/);
  assert.doesNotMatch(patched, /"linux-record-replay-start":async/);
  assert.doesNotMatch(patched, /"linux-record-replay-draft-skill":async/);
});
