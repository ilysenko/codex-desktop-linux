#!/usr/bin/env node
"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const {
  loadLinuxFeaturePatchDescriptors,
} = require("../../scripts/lib/linux-features.js");
const {
  MAX_WRAPPER_ARGS,
  applyMainBundlePatch,
  applyWebviewPatch,
  descriptors,
  formatCommandWrapper,
  parseCommandWrapper,
  validateCommandWrapperArgs,
  wrapRemoteCommand,
} = require("./patch.js");

const mainFixture = [
  "function Gx(e,t){return e+t}",
  "function management(){return[...x,Gx(e,s)]}",
  "function proxy(){return[...x,Gx(t,i)]}",
  "function uS(e){let t=Hre(e);return t?{sshConnection:{alias:t.sshAlias,host:t.sshHost,port:t.sshPort,identity:t.identity}}:null}",
  "function Wre(e){let t=e.alias?.trim();return t?`alias:${t}`:[`direct`,e.host,String(e.port??``),e.identity?.trim()??``].join(`:",
  "aliasLoad.then(t=>t==null?null:{...t,hostId:e.hostId,connectionAnalyticsId:e.connectionAnalyticsId,displayName:e.displayName,autoConnect:!1})",
  "let direct=[{hostId:e.hostId,sshPort:e.sshPort,identity:e.identity}]),...t.filter",
  "let current=e.alias==null?{hostId:e.hostId,connectionAnalyticsId:e.connectionAnalyticsId,displayName:e.displayName,source:`codex-managed`,alias:null,hostname:e.hostname,sshPort:e.sshPort,identity:e.identity}:{hostId:e.hostId,connectionAnalyticsId:e.connectionAnalyticsId,displayName:e.displayName,source:`discovered`,alias:e.alias,hostname:null,sshPort:null,identity:null}",
  "let legacy=n==null?{hostId:t.hostId,connectionAnalyticsId:t.connectionAnalyticsId,displayName:t.displayName,source:`codex-managed`,alias:null,hostname:t.sshHost,sshPort:t.sshPort,identity:t.identity}:{hostId:t.hostId,connectionAnalyticsId:t.connectionAnalyticsId,displayName:t.displayName,source:`discovered`,alias:n,hostname:null,sshPort:null,identity:null}",
  "let host={metadata:{identity:e.identity}};return e.homeDir",
  "var O$=n.mu({sshAlias:n._u().nullable(),sshHost:n._u(),sshPort:n.pu().nullable(),identity:n._u().nullable()});",
  "let config={sshPort:e.sshPort,identity:e.identity,codexCliCommand:[]}",
].join(";");

const webviewFixture = [
  "function Pi(){return{displayName:``,targetKind:`hostname`,sshHost:``,sshPort:``,authMode:`none`,identity:``}}",
  "function Fi(e){return{authMode:e.identity==null?`none`:`identity`,identity:e.identity??``}}",
  "function Ii(e){return e.targetKind===`hostname`?{identity:e.authMode===`identity`?e.identity.trim():null}:{hostId:x,sshPort:null,identity:null}}",
  "function Li(e){let r=[],i=e.displayName.trim();return r}",
  "function Bi(e){let _,q,U,Wi,l,D,k,A,j;j=(0,q.jsx)(x,{children:(0,q.jsxs)(`div`,{children:[D,k,A]})});return j}",
  "function Gi(e){switch(e){case`other`:return null}}",
].join("");

function withFeatureConfig(enabled, callback) {
  const originalConfig = process.env.CODEX_LINUX_FEATURES_CONFIG;
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "ssh-command-wrapper-feature-"));
  process.env.CODEX_LINUX_FEATURES_CONFIG = path.join(tempDir, "features.json");
  fs.writeFileSync(process.env.CODEX_LINUX_FEATURES_CONFIG, `${JSON.stringify({ enabled })}\n`);
  try {
    return callback(path.resolve(__dirname, ".."));
  } finally {
    if (originalConfig == null) delete process.env.CODEX_LINUX_FEATURES_CONFIG;
    else process.env.CODEX_LINUX_FEATURES_CONFIG = originalConfig;
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
}

test("parses argv text without invoking a shell", () => {
  assert.deepEqual(parseCommandWrapper("ssh -T target-host --"), ["ssh", "-T", "target-host", "--"]);
  assert.deepEqual(parseCommandWrapper("env 'NAME=hello world' command\\ name \"\""), [
    "env",
    "NAME=hello world",
    "command name",
    "",
  ]);
  assert.deepEqual(parseCommandWrapper('command "a\\q" "a\\$b"'), ["command", "a\\q", "a$b"]);
  assert.deepEqual(parseCommandWrapper(""), []);
  assert.deepEqual(parseCommandWrapper("   \t "), []);
});

test("rejects snippets and malformed or oversized argv", () => {
  for (const value of [
    "ssh target-host; echo unsafe",
    "ssh target-host | tee log",
    "ssh target-host\nwhoami",
    "ssh 'target-host",
    "ssh target-host\\",
    "'' -T target-host",
    `ssh ${"x".repeat(4096)}`,
  ]) {
    assert.throws(() => parseCommandWrapper(value), { code: "invalidSshCommandWrapper" });
  }
  assert.throws(
    () => parseCommandWrapper(Array.from({ length: MAX_WRAPPER_ARGS + 1 }, () => "x").join(" ")),
    { code: "invalidSshCommandWrapper" },
  );
});

test("round trips quoted argv and preserves an empty wrapper", () => {
  const args = ["ssh", "-T", "login node", "--", "apostrophe's", ""];
  assert.deepEqual(parseCommandWrapper(formatCommandWrapper(args)), args);
  assert.equal(wrapRemoteCommand("sh -c 'echo ok'", []), "sh -c 'echo ok'");
  assert.equal(
    wrapRemoteCommand("sh -c 'echo ok'", ["ssh", "-T", "target-host", "--"]),
    "exec ssh -T target-host -- 'sh -c '\\''echo ok'\\'''",
  );
});

test("validates persisted argv independently of the editor", () => {
  assert.deepEqual(validateCommandWrapperArgs(null), []);
  assert.deepEqual(validateCommandWrapperArgs(["ssh", "-T"]), ["ssh", "-T"]);
  assert.throws(() => validateCommandWrapperArgs("ssh -T"), { code: "invalidSshCommandWrapper" });
  assert.throws(() => validateCommandWrapperArgs(["ssh\nwhoami"]), {
    code: "invalidSshCommandWrapper",
  });
});

test("patches all main-process transport and persistence paths idempotently", () => {
  const patched = applyMainBundlePatch(mainFixture);
  assert.notEqual(patched, mainFixture);
  assert.equal(applyMainBundlePatch(patched), patched);
  assert.match(patched, /codexLinuxSshWrapRemoteCommand\(Gx\(e,s\)/u);
  assert.match(patched, /codexLinuxSshWrapRemoteCommand\(Gx\(t,i\)/u);
  assert.match(patched, /codexLinuxSshCommandWrapperArgs\(e\.codexLinuxSshCommandWrapper\)/u);
  assert.ok(patched.split("codexLinuxSshCommandWrapper").length > 10);
});

test("main-process patch fails soft and byte-identical on drift", () => {
  const warnings = [];
  const originalWarn = console.warn;
  console.warn = (message) => warnings.push(String(message));
  try {
    assert.equal(applyMainBundlePatch("function Gx(){}"), "function Gx(){}");
  } finally {
    console.warn = originalWarn;
  }
  assert.ok(warnings.length > 0);
});

test("patches the SSH connection editor for manual hosts and aliases", () => {
  const patched = applyWebviewPatch(webviewFixture);
  assert.notEqual(patched, webviewFixture);
  assert.equal(applyWebviewPatch(patched), patched);
  assert.match(patched, /Remote command wrapper/u);
  assert.match(patched, /ssh -T target-host --/u);
  assert.match(patched, /invalidSshCommandWrapper/u);
  assert.match(patched, /codexLinuxSshCommandWrapper:codexLinuxParseSshCommandWrapper/u);
});

test("exports opt-in main and settings descriptors", () => {
  assert.deepEqual(
    descriptors.map(({ phase, ciPolicy }) => [phase, ciPolicy]),
    [
      ["main-bundle", "opt-in"],
      ["webview-asset", "opt-in"],
    ],
  );
  assert.equal(
    descriptors[1].pattern.test("remote-connections-settings-current.js"),
    true,
  );
});

test("feature stays disabled until explicitly enabled", () => {
  withFeatureConfig([], (featuresRoot) => {
    assert.deepEqual(loadLinuxFeaturePatchDescriptors({ featuresRoot }), []);
  });
  withFeatureConfig(["ssh-command-wrapper"], (featuresRoot) => {
    assert.deepEqual(
      loadLinuxFeaturePatchDescriptors({ featuresRoot }).map(({ id }) => id),
      [
        "feature:ssh-command-wrapper:main-bundle-ssh-command-wrapper",
        "feature:ssh-command-wrapper:webview-ssh-command-wrapper-settings",
      ],
    );
  });
});
