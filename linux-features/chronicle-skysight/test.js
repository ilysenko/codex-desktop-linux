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
  chronicleControllerContract,
  descriptors,
  recordReplayRuntimeHelperSource,
} = require("./patch.js");

const featureDir = __dirname;

function repoRoot() {
  return path.resolve(featureDir, "../..");
}

function captureWarns(fn) {
  const warnings = [];
  const originalWarn = console.warn;
  console.warn = (...args) => warnings.push(args.join(" "));
  try {
    return { value: fn(), warnings };
  } finally {
    console.warn = originalWarn;
  }
}

function currentChronicleMainFixture() {
  return [
    "var Base={Tf:class{}};",
    "var Empty={state:`stopped`,currentSegmentEventsPath:null,currentSegmentMetadataPath:null};",
    "var Hse=class{dependencies;cachedStatus=Empty;desiredState=`stopped`;pendingOperation=Promise.resolve();pendingStatus=null;constructor(e){this.dependencies=e}getCachedStatus(){return this.cachedStatus}status(){return this.pendingStatus??=this.request(`skysightStatus`).finally(()=>{this.pendingStatus=null}),this.pendingStatus}enable(){return this.desiredState=`running`,this.runSerialized(async()=>(await this.dependencies.archiveLegacyChronicleSkill(),this.dependencies.reconcileComputerHistoryPluginInstallation(!0),this.request(`skysightStart`)))}reconcileEnabled(){return this.enable()}disable(){return this.desiredState=`stopped`,this.runSerialized(()=>this.cachedStatus.state===`stopped`?this.cachedStatus:this.stopRecorder())}stop(){return this.desiredState=`stopped`,this.runSerialized(()=>this.stopRecorder())}pause(e){return this.desiredState=e==null?`paused`:`running`,this.runSerialized(()=>this.requestPauseResume(`skysightPause`,e))}resume(){return this.desiredState=`running`,this.runSerialized(async()=>{let e=await this.status();return e.state===`stopped`?this.request(`skysightStart`):e.state===`running`?e:this.requestPauseResume(`skysightResume`)})}requestPauseResume(e,t){return this.dependencies.request({method:e,params:t==null?{}:{duration:t}}).then(e=>(this.cachedStatus=e,e))}request(e){return this.dependencies.request({method:e,params:{}}).then(e=>(this.cachedStatus=e,e))}async stopRecorder(){let e=await this.request(`skysightStop`);if(e.state!==`stopped`||e.currentSegmentEventsPath!=null||e.currentSegmentMetadataPath!=null)throw Error(`invalid stop`);return e}runSerialized(e){let t=this.pendingOperation.then(e,e);return this.pendingOperation=t.then(()=>{},()=>{}),t}};",
    "var $O=class extends Base.Tf{constructor(e,t,n){super(),this.appServerConnection=e,this.getController=t,this.isEligible=n}async getState(){this.isEligible();return this.getController().status()}async setEnabled(e){return e?this.appServerConnection.enableSkysightChronicle():this.getController().disable()}async pause(){return this.getController().pause()}async resume(){return this.appServerConnection.resumeChronicle()}};",
    "function Cr(){return{skysight:false}}let N=process.platform===`darwin`,xe;",
    "var Ce={requestComputerUseWorker(){throw Error(`mac worker unavailable`)}},Xe={reconcileComputerHistoryPluginInstallation(){}},U={broadcastQueryCacheInvalidation(){}},V={codexHome:`/tmp`};async function archive(e){return e}",
    "N&&(xe=new Hse({request:Ce.requestComputerUseWorker,reconcileComputerHistoryPluginInstallation:e=>{Xe.reconcileComputerHistoryPluginInstallation(e)},archiveLegacyChronicleSkill:async()=>{await archive({codexHome:V.codexHome,reason:`skysight_gate_enabled`})&&U.broadcastQueryCacheInvalidation([`skills`])}}));",
    "var appOptions={getSkysightRecorderController:()=>Cr().skysight?xe:null,artifactSessionHostLifecycle:null};",
    "var connection={enableSkysightChronicle:()=>xe.enable(),resumeChronicle:()=>xe.resume()};",
    "var Host=class{constructor(){this.options=appOptions;let i=connection;this.services={chronicle:process.platform===`darwin`&&this.options.getSkysightRecorderController!=null?new $O(i,this.options.getSkysightRecorderController,()=>Cr().skysight,()=>[],()=>[],{}):void 0}}};var host=new Host;",
    "var bridge={\"get-global-state\":async({key:e})=>null};",
  ].join("");
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

test("chronicle-skysight owns the activity-memory bridge", () => {
  const source = currentChronicleMainFixture();

  const patched = applyChronicleSkysightMainBridgePatch(source);

  assert.equal(descriptors.length, 1);
  assert.equal(descriptors[0].id, "linux-chronicle-skysight-main-bridge");
  assert.equal(chronicleControllerContract(source), "current");
  assert.notEqual(patched, source);
  assert.equal(chronicleControllerContract(patched), "patched");
  assert.equal(applyChronicleSkysightMainBridgePatch(patched), patched);
  assert.match(patched, /"chronicle-permissions":async/);
  assert.match(patched, /"linux-record-replay-skysight-start":async/);
  assert.match(patched, /request:process\.platform===`linux`\?codexLinuxChronicleRequest:/);
  assert.match(patched, /chronicle:\(process\.platform===`darwin`\|\|process\.platform===`linux`\)/);
  assert.match(patched, /getSkysightRecorderController:\(\)=>process\.platform===`linux`\|\|Cr\(\)\.skysight\?xe:null/);
  assert.doesNotMatch(patched, /"linux-record-replay-start":async/);
  assert.doesNotMatch(patched, /"linux-record-replay-draft-skill":async/);
});

test("chronicle-skysight fails closed for missing duplicate mixed and partial controller contracts", () => {
  const current = currentChronicleMainFixture();
  const patched = applyChronicleSkysightMainBridgePatch(current);
  const variants = {
    missing: current.replace("this.request(`skysightStatus`)", "this.request(`statusChanged`)") ,
    duplicate: current + current,
    mixed: current + patched,
    partial: patched.replace(
      "chronicle:(process.platform===`darwin`||process.platform===`linux`)",
      "chronicle:process.platform===`darwin`",
    ),
  };

  for (const [name, source] of Object.entries(variants)) {
    assert.equal(chronicleControllerContract(source), "drifted", name);
    const result = captureWarns(() => applyChronicleSkysightMainBridgePatch(source));
    assert.equal(result.value, source, name);
    assert.equal(result.warnings.length, 1, name);
    assert.match(result.warnings[0], /coherent current Chronicle controller contract/, name);
  }
});

test("chronicle-skysight drives the current controller status enable pause resume and stop contract", async () => {
  const source = currentChronicleMainFixture();
  const patched = applyChronicleSkysightMainBridgePatch(source);
  const calls = [];
  const responses = [
    { state: "stopped", is_running: false, currentSegmentEventsPath: "/last/events.jsonl", currentSegmentMetadataPath: "/last/metadata.json" },
    { state: "running", is_running: true },
    { state: "paused", is_running: true, paused: true },
    { state: "paused", is_running: true, paused: true },
    { state: "running", is_running: true },
    { state: "stopped", is_running: false, currentSegmentEventsPath: "/last/events.jsonl", currentSegmentMetadataPath: "/last/metadata.json" },
  ];
  const childProcess = {
    execFile(_bin, args, _options, callback) {
      calls.push(args);
      callback(null, JSON.stringify(responses.shift()), "");
    },
  };
  const context = {
    console,
    globalThis: {},
    JSON,
    Promise,
    String,
    process: {
      platform: "linux",
      env: { CODEX_RECORD_REPLAY_LINUX_BIN: "/tmp/codex-record-replay-linux" },
      cwd: () => "/tmp",
    },
    require(id) {
      if (id === "node:child_process") return childProcess;
      if (id === "node:fs") return fs;
      if (id === "node:path") return path;
      throw new Error(`unexpected require: ${id}`);
    },
  };

  require("node:vm").runInNewContext(
    `${patched};globalThis.chronicle=host.services.chronicle;globalThis.controller=xe;`,
    context,
  );
  assert.ok(context.globalThis.chronicle);
  assert.ok(context.globalThis.controller);
  assert.equal((await context.globalThis.chronicle.getState()).state, "stopped");
  assert.equal((await context.globalThis.chronicle.setEnabled(true)).state, "running");
  assert.equal((await context.globalThis.chronicle.pause()).state, "paused");
  assert.equal((await context.globalThis.chronicle.resume()).state, "running");
  assert.equal((await context.globalThis.chronicle.setEnabled(false)).state, "stopped");
  assert.deepEqual(JSON.parse(JSON.stringify(calls)), [
    ["skysight", "status"],
    ["skysight", "start", "--source", "chronicle-desktop", "--owner", "manual-continuous", "--summary-agent", "enabled"],
    ["skysight", "pause", "--reason", "chronicle-desktop"],
    ["skysight", "status"],
    ["skysight", "resume"],
    ["skysight", "stop"],
  ]);
});

test("chronicle-skysight rejects unsupported and failed Linux controller requests", async () => {
  const helperSource = recordReplayRuntimeHelperSource({
    childProcessVar: "childProcess",
    fsVar: "fs",
    pathVar: "path",
  });
  const context = {
    childProcess: {
      execFile(_bin, _args, _options, callback) {
        callback(new Error("backend failed"), "", "failed");
      },
    },
    fs,
    path,
    process: {
      env: { CODEX_RECORD_REPLAY_LINUX_BIN: "/tmp/codex-record-replay-linux" },
      cwd: () => "/tmp",
    },
    JSON,
    Promise,
    String,
  };
  await assert.rejects(
    require("node:vm").runInNewContext(
      `${helperSource};codexLinuxChronicleRequest({method:"skysightStatus",params:{}})`,
      context,
    ),
    /backend failed/,
  );
  await assert.rejects(
    require("node:vm").runInNewContext(
      `${helperSource};codexLinuxChronicleRequest({method:"unknown",params:{}})`,
      context,
    ),
    /Unsupported Linux Chronicle method/,
  );
});
