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
  applyMainBundlePatchDescriptors,
  applyWebviewAssetPatchDescriptors,
} = require("../../scripts/patches/engine.js");
const {
  createPatchReport,
} = require("../../scripts/lib/patch-report.js");
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

const managementCall = "n.Xn({args:[`ssh`,...oS(c),...cS(this.options.sshConnection),Gx(e,s)],spawnInsideWsl:!1})";
const proxyCall = "(0,x.spawn)(n.nr.resolve(`ssh`)??`ssh`,[`-T`,...oS(this.options.getConnectTimeoutSeconds?.()),...cS(this.options.sshConnection),Gx(t,i)],{env:r.t(process.env),stdio:[`pipe`,`pipe`,`pipe`]})";

const mainFixture = [
  "function Gx(e,t){return e+t}",
  `function management(){let u=${managementCall};return u}`,
  `function proxy(){let a=${proxyCall};return a}`,
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
  "function Li(e){let r=[],i=e.displayName.trim();i.length===0&&r.push(`displayNameRequired`);return r}",
  "function Bi(e){let _,q,U,Wi,l,D,k,A,j;j=(0,q.jsx)(x,{children:(0,q.jsxs)(`div`,{children:[D,k,A]})});return j}",
  "function Gi(e){switch(e){case`displayNameRequired`:return null}}",
].join("");

function withCapturedWarnings(callback) {
  const warnings = [];
  const originalWarn = console.warn;
  console.warn = (message) => warnings.push(String(message));
  try {
    return { value: callback(), warnings };
  } finally {
    console.warn = originalWarn;
  }
}

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

test("keeps apostrophe-heavy wrappers within the canonical editor limit", () => {
  const atLimit = ["ssh", "'".repeat(1022), "x"];
  const formatted = formatCommandWrapper(atLimit);
  assert.equal(formatted.length, 4096);
  assert.deepEqual(parseCommandWrapper(formatted), atLimit);

  const overLimitInput = `ssh "${"'".repeat(1023)}"`;
  assert.throws(() => parseCommandWrapper(overLimitInput), { code: "invalidSshCommandWrapper" });
  assert.throws(() => validateCommandWrapperArgs(["ssh", "'".repeat(1023)]), {
    code: "invalidSshCommandWrapper",
  });
  assert.throws(() => formatCommandWrapper(["ssh", "'".repeat(1023)]), {
    code: "invalidSshCommandWrapper",
  });
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

test("main-process patch rejects a stale injected helper implementation", () => {
  const patched = applyMainBundlePatch(mainFixture);
  const stale = patched.replace("e.length>64", "e.length>63");
  assert.notEqual(stale, patched);

  const { value, warnings } = withCapturedWarnings(() => applyMainBundlePatch(stale));
  assert.equal(value, stale);
  assert.match(warnings.join("\n"), /helperSource=0/u);
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

test("main-process patch rejects duplicate owned SSH targets", () => {
  const duplicateTarget = `${mainFixture};function duplicate(){return ${managementCall}}`;
  const { value, warnings } = withCapturedWarnings(() => applyMainBundlePatch(duplicateTarget));
  assert.equal(value, duplicateTarget);
  assert.match(warnings.join("\n"), /partial, ambiguous, or drifted/u);
});

test("main-process helper-only partial state is reported as feature drift", () => {
  const partial = mainFixture.replace(
    "function Gx(",
    "function codexLinuxSshCommandWrapperArgs(e){}function Gx(",
  );
  withFeatureConfig(["ssh-command-wrapper"], (featuresRoot) => {
    const descriptor = loadLinuxFeaturePatchDescriptors({ featuresRoot })
      .find((item) => item.id === "feature:ssh-command-wrapper:main-bundle-ssh-command-wrapper");
    const report = createPatchReport();
    report.enabledFeatures = ["ssh-command-wrapper"];
    const { value, warnings } = withCapturedWarnings(() =>
      applyMainBundlePatchDescriptors(partial, [descriptor], {}, report),
    );
    assert.equal(value.patchedSource, partial);
    assert.match(warnings.join("\n"), /partial, ambiguous, or drifted/u);
    assert.equal(report.patches[0].status, "skipped-optional");
  });
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

test("webview patch rejects a damaged injected helper implementation", () => {
  const patched = applyWebviewPatch(webviewFixture);
  const damaged = patched.replace("t.length>64", "t.length>63");
  assert.notEqual(damaged, patched);

  const { value, warnings } = withCapturedWarnings(() => applyWebviewPatch(damaged));
  assert.equal(value, damaged);
  assert.match(warnings.join("\n"), /helperSource=0/u);
});

test("webview patch rejects duplicate owned editor targets", () => {
  const duplicateTarget = `${webviewFixture}function duplicate(){return{authMode:\`none\`,identity:\`\`}}`;
  const { value, warnings } = withCapturedWarnings(() => applyWebviewPatch(duplicateTarget));
  assert.equal(value, duplicateTarget);
  assert.match(warnings.join("\n"), /partial, ambiguous, or drifted/u);
});

test("webview helper-only partial state is reported as feature drift", () => {
  const partial = webviewFixture.replace(
    "function Pi(){",
    "function codexLinuxParseSshCommandWrapper(e){}function Pi(){",
  );
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "ssh-command-wrapper-webview-"));
  const assetsDir = path.join(tempDir, "webview", "assets");
  const assetPath = path.join(assetsDir, "remote-connections-settings-current.js");
  fs.mkdirSync(assetsDir, { recursive: true });
  fs.writeFileSync(assetPath, partial);
  try {
    withFeatureConfig(["ssh-command-wrapper"], (featuresRoot) => {
      const descriptor = loadLinuxFeaturePatchDescriptors({ featuresRoot })
        .find((item) => item.id === "feature:ssh-command-wrapper:webview-ssh-command-wrapper-settings");
      const report = createPatchReport();
      report.enabledFeatures = ["ssh-command-wrapper"];
      const { warnings } = withCapturedWarnings(() =>
        applyWebviewAssetPatchDescriptors(tempDir, [descriptor], {}, report),
      );
      assert.equal(fs.readFileSync(assetPath, "utf8"), partial);
      assert.match(warnings.join("\n"), /partial, ambiguous, or drifted/u);
      assert.equal(report.patches[0].status, "skipped-optional");
    });
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
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
