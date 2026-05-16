#!/usr/bin/env node
"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const vm = require("node:vm");

const {
  loadLinuxFeaturePatchDescriptors,
} = require("../../scripts/lib/linux-features.js");
const {
  createPatchReport,
  patchExtractedApp,
  patchMainBundleSource,
} = require("../../scripts/patch-linux-window-ui.js");
const {
  applyLinuxRemoteControlDeviceKeyPatch,
  applyLinuxRemoteControlCopyPatch,
  applyLinuxRemoteControlPreserveConfigPatch,
  applyLinuxRemoteControlVisibilityPatch,
} = require("./patch.js");

function syntheticMainBundle() {
  return [
    "let i=require(`node:path`),o=require(`node:fs`),s=require(`node:crypto`),b={createRequire:()=>()=>({})};",
    "function TV(e){return Buffer.from(JSON.stringify(e),`utf8`)}",
    "var bV=(0,b.createRequire)(__filename),xV=`remote-control-device-key.node`,SV=`codex-device-key-sign-payload/v1`;",
    "function wV({resourcesPath:e}){let t=null,n=()=>{if(process.platform!==`darwin`)throw Error(`Remote control device keys are only available on macOS`);if(e==null)throw Error(`Remote control device keys require resourcesPath`);return t??=bV(i.join(e,`native`,xV)),t};return{createDeviceKey:e=>n().createDeviceKey(e??`hardware_only`),deleteDeviceKey:e=>n().deleteDeviceKey(e),getDeviceKeyPublic:e=>n().getDeviceKeyPublic(e),signDeviceKey:async(e,t)=>{let r=TV(t);return{...await n().signDeviceKey(e,r),signedPayloadBase64:r.toString(`base64`)}}}}",
    "async function mV({codexHome:e,hostConfig:n,logger:r=t.Jr()}){if(n.kind===`local`)try{await hV(i.default.join(e??t.Rr({hostConfig:n,preferWsl:t.Kr(n)}),pV))&&r.info(`Removed remote_control from config before app-server start`)}catch(e){r.warning(`Failed to remove remote_control before app-server start`,{safe:{},sensitive:{error:e}})}}",
  ].join("");
}

function syntheticVisibilityBundle() {
  return "function a({remoteControlConnectionsState:e,slingshotEnabled:t}){return t&&(e?.available??!0)&&e?.accessRequired!==!0}export{a as t};";
}

function syntheticCurrentMainBundle() {
  return [
    "let i=require(`node:path`),o=require(`node:fs`),s=require(`node:crypto`),b={createRequire:()=>()=>({})};",
    "function mz(e){return Buffer.from(JSON.stringify({domain:`codex-device-key-sign-payload/v1`,payload:e}),`utf8`)}",
    "var lz=(0,b.createRequire)(__filename),uz=`remote-control-device-key.node`,dz=`codex-device-key-sign-payload/v1`;",
    "function pz({resourcesPath:e}){let t=null,n=()=>{if(process.platform!==`darwin`)throw Error(`Remote control device keys are only available on macOS`);if(e==null)throw Error(`Remote control device keys require resourcesPath`);return t??=lz((0,i.join)(e,`native`,uz)),t};return{createDeviceKey:e=>n().createDeviceKey(e??`hardware_only`),deleteDeviceKey:e=>n().deleteDeviceKey(e),getDeviceKeyPublic:e=>n().getDeviceKeyPublic(e),signDeviceKey:async(e,t)=>{let r=mz(t);return{...await n().signDeviceKey(e,r),signedPayloadBase64:r.toString(`base64`)}}}}",
  ].join("");
}

function syntheticCurrentVisibilityBundle() {
  return "function Et({remoteControlConnectionsState:e,slingshotEnabled:t}){return t&&(e?.available??!0)}export{Et as t};";
}

function syntheticMobileConnectedSettingsBundle() {
  return "let y={id:`codexMobile.setupDialog.connected.computerUse.description`,defaultMessage:`Let Codex control the apps on your Mac.`,description:`Description for enabling Computer Use after mobile setup`};";
}

function syntheticRemoteConnectionsSettingsCopyBundle() {
  return [
    syntheticCurrentVisibilityBundle(),
    "let platformLabel={id:`settings.remoteConnections.platform.mac`,defaultMessage:`Mac`,description:`Short label for a Mac device`};",
    "let a={id:`settings.remoteConnections.tabs.controlThisMac`,defaultMessage:`Control this Mac`,description:`Tab label for settings that let other devices control this computer`};",
    "let b={id:`settings.remoteControlConnections.devices.title`,defaultMessage:`Devices that can control this Mac`,description:`Header title for devices that can control this Mac`};",
    "let c={id:`settings.remoteConnections.accessOtherDevices.header.title`,defaultMessage:`Devices you can control from this Mac`,description:`Header title for the devices this computer can access`};",
    "let d={id:`settings.remoteConnections.ssh.header.title`,defaultMessage:`SSH connections from this Mac`,description:`Header title for SSH connections from this Mac`};",
    "let e={id:`settings.remoteControlConnections.keepAwake.title`,defaultMessage:`Keep this Mac awake`,description:`Keep awake title`};",
  ].join("");
}

function syntheticMobileSetupFlowCopyBundle() {
  return [
    "let a={id:`codexMobile.setupDialog.connected.lockedComputerUse.title`,defaultMessage:`Use your Mac apps while locked`,description:`Title for enabling Locked Computer Use after mobile setup`};",
    "let b={id:`codexMobile.setupDialog.connected.lockedComputerUse.description`,defaultMessage:`Control Mac apps from your phone`,description:`Description for enabling Locked Computer Use after mobile setup`};",
    "let c={id:`codexMobile.setupDialog.connected.computerUse.description`,defaultMessage:`Let Codex control the apps on your Mac`,description:`Description for enabling Computer Use after mobile setup`};",
    "let d={id:`codexMobile.setupPage.initial.heading`,defaultMessage:`Connect your phone to this Mac`,description:`Heading for Codex mobile setup`};",
  ].join("");
}

function withTempFeatureRoot(enabled, fn) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "codex-remote-mobile-feature-test-"));
  try {
    fs.writeFileSync(path.join(root, "features.example.json"), JSON.stringify({ enabled: [] }, null, 2));
    fs.writeFileSync(path.join(root, "features.json"), JSON.stringify({ enabled }, null, 2));
    fs.cpSync(__dirname, path.join(root, "remote-mobile-control"), { recursive: true });
    return fn(root);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

function withFeatureRootEnv(root, fn) {
  const previous = process.env.CODEX_LINUX_FEATURES_ROOT;
  process.env.CODEX_LINUX_FEATURES_ROOT = root;
  try {
    return fn();
  } finally {
    if (previous == null) {
      delete process.env.CODEX_LINUX_FEATURES_ROOT;
    } else {
      process.env.CODEX_LINUX_FEATURES_ROOT = previous;
    }
  }
}

test("remote mobile control feature stays disabled until listed in features.json", () => {
  withTempFeatureRoot([], (root) => {
    assert.deepEqual(loadLinuxFeaturePatchDescriptors({ featuresRoot: root }), []);
  });
});

test("remote mobile control feature exposes opt-in main-bundle and webview patches", () => {
  withTempFeatureRoot(["remote-mobile-control"], (root) => {
    const descriptors = loadLinuxFeaturePatchDescriptors({ featuresRoot: root });
    assert.deepEqual(descriptors.map((descriptor) => descriptor.id), [
      "feature:remote-mobile-control:linux-remote-control-device-key",
      "feature:remote-mobile-control:linux-remote-control-preserve-config",
      "feature:remote-mobile-control:linux-remote-control-visibility",
      "feature:remote-mobile-control:linux-remote-control-copy",
    ]);
    assert.deepEqual(descriptors.map((descriptor) => descriptor.phase), [
      "main-bundle",
      "main-bundle",
      "webview-asset",
      "webview-asset",
    ]);
  });
});

test("Linux remote-control patches update the device-key provider and preserve config", () => {
  const source = syntheticMainBundle();
  const patched = applyLinuxRemoteControlPreserveConfigPatch(
    applyLinuxRemoteControlDeviceKeyPatch(source),
  );

  assert.notEqual(patched, source);
  assert.match(patched, /codexLinuxRemoteControlDeviceKeyClient/);
  assert.match(patched, /process\.platform===`linux`\)return codexLinuxRemoteControlDeviceKeyClient\(\)/);
  assert.match(patched, /n\.kind===`local`&&process\.platform!==`linux`/);
  assert.equal(
    applyLinuxRemoteControlPreserveConfigPatch(applyLinuxRemoteControlDeviceKeyPatch(patched)),
    patched,
  );
});

test("Linux remote-control device-key patch handles current minified aliases", () => {
  const source = syntheticCurrentMainBundle();
  const patched = applyLinuxRemoteControlDeviceKeyPatch(source);

  assert.notEqual(patched, source);
  assert.match(patched, /codexLinuxRemoteControlDeviceKeyClient/);
  assert.match(patched, /process\.platform===`linux`\)return codexLinuxRemoteControlDeviceKeyClient\(\)/);
  assert.equal(applyLinuxRemoteControlDeviceKeyPatch(patched), patched);
});

test("Linux remote-control visibility patch allows Linux when upstream marks availability false", () => {
  const source = syntheticVisibilityBundle();
  const patched = applyLinuxRemoteControlVisibilityPatch(source);

  assert.notEqual(patched, source);
  assert.match(patched, /navigator\.userAgent\.includes\(`Linux`\)/);
  assert.match(patched, /\(n\|\|t\)&&\(n\|\|\(e\?\.available\?\?!0\)\)&&e\?\.accessRequired!==!0/);
  assert.equal(applyLinuxRemoteControlVisibilityPatch(patched), patched);
});

test("Linux remote-control visibility patch handles current settings bundle shape", () => {
  const source = syntheticCurrentVisibilityBundle();
  const patched = applyLinuxRemoteControlVisibilityPatch(source);

  assert.notEqual(patched, source);
  assert.match(patched, /navigator\.userAgent\.includes\(`Linux`\)/);
  assert.match(patched, /return\(n\|\|t\)&&\(n\|\|\(e\?\.available\?\?!0\)\)/);
  assert.equal(applyLinuxRemoteControlVisibilityPatch(patched), patched);
});

test("Linux mobile setup copy does not refer to Mac-only Computer Use", () => {
  const source = syntheticMobileConnectedSettingsBundle();
  const patched = applyLinuxRemoteControlCopyPatch(source);

  assert.notEqual(patched, source);
  assert.doesNotMatch(patched, /apps on your Mac/);
  assert.match(patched, /apps on this Linux desktop/);
  assert.equal(applyLinuxRemoteControlCopyPatch(patched), patched);
});

test("Linux remote-control settings copy does not refer to this Mac", () => {
  const source = syntheticRemoteConnectionsSettingsCopyBundle();
  const patched = applyLinuxRemoteControlCopyPatch(source);

  assert.notEqual(patched, source);
  assert.doesNotMatch(patched, /defaultMessage:`[^`]*Mac/);
  assert.match(patched, /Control this Linux desktop/);
  assert.match(patched, /Devices that can control this Linux desktop/);
  assert.match(patched, /Devices you can control from this Linux desktop/);
  assert.match(patched, /SSH connections from this Linux desktop/);
  assert.match(patched, /Keep this Linux desktop awake/);
  assert.match(patched, /defaultMessage:`Linux`/);
  assert.equal(applyLinuxRemoteControlCopyPatch(patched), patched);
});

test("Linux mobile setup flow copy does not refer to Mac-only setup", () => {
  const source = syntheticMobileSetupFlowCopyBundle();
  const patched = applyLinuxRemoteControlCopyPatch(source);

  assert.notEqual(patched, source);
  assert.doesNotMatch(patched, /defaultMessage:`[^`]*Mac/);
  assert.match(patched, /Use your Linux apps while locked/);
  assert.match(patched, /Control Linux apps from your phone/);
  assert.match(patched, /apps on this Linux desktop/);
  assert.match(patched, /Connect your phone to this Linux desktop/);
  assert.equal(applyLinuxRemoteControlCopyPatch(patched), patched);
});

test("patched Linux device-key provider can create, sign with, and delete a key", async () => {
  const configHome = fs.mkdtempSync(path.join(os.tmpdir(), "codex-remote-mobile-key-store-"));
  try {
    const patched = applyLinuxRemoteControlDeviceKeyPatch(syntheticMainBundle());
    const context = {
      Buffer,
      Date,
      Error,
      JSON,
      Promise,
      console,
      __filename: path.join(configHome, "main.js"),
      module: { exports: {} },
      process: {
        env: { XDG_CONFIG_HOME: configHome },
        pid: process.pid,
        platform: "linux",
      },
      require,
    };

    vm.runInNewContext(`${patched};module.exports=wV({resourcesPath:null});`, context);
    const client = context.module.exports;
    const created = await client.createDeviceKey("allow_os_protected_nonextractable");
    assert.equal(created.algorithm, "ecdsa_p256_sha256");
    assert.equal(created.protectionClass, "os_protected_nonextractable");
    assert.match(created.publicKeySpkiDerBase64, /^[A-Za-z0-9+/]+=*$/);

    const readBack = await client.getDeviceKeyPublic(created.keyId);
    assert.deepEqual(readBack, created);

    const signature = await client.signDeviceKey(created.keyId, {
      type: "remoteControlClientEnrollment",
      nonce: "test",
    });
    assert.equal(signature.algorithm, "ecdsa_p256_sha256");
    assert.match(signature.signatureDerBase64, /^[A-Za-z0-9+/]+=*$/);
    assert.match(signature.signedPayloadBase64, /^[A-Za-z0-9+/]+=*$/);

    const storePath = path.join(configHome, "codex-desktop", "remote-control-device-keys-v1.json");
    assert.equal(fs.statSync(storePath).mode & 0o777, 0o600);

    await client.deleteDeviceKey(created.keyId);
    await assert.rejects(() => client.getDeviceKeyPublic(created.keyId), /not found/);
  } finally {
    fs.rmSync(configHome, { recursive: true, force: true });
  }
});

test("remote mobile control feature participates in ASAR patching and reports", () => {
  withTempFeatureRoot(["remote-mobile-control"], (root) => {
    withFeatureRootEnv(root, () => {
      const source = syntheticMainBundle();
      const patched = patchMainBundleSource(source, null);
      assert.match(patched, /codexLinuxRemoteControlDeviceKeyClient/);
      assert.match(patched, /n\.kind===`local`&&process\.platform!==`linux`/);

      const tempApp = fs.mkdtempSync(path.join(os.tmpdir(), "codex-remote-mobile-app-"));
      try {
        const buildDir = path.join(tempApp, ".vite", "build");
        const assetsDir = path.join(tempApp, "webview", "assets");
        fs.mkdirSync(buildDir, { recursive: true });
        fs.mkdirSync(assetsDir, { recursive: true });
        fs.writeFileSync(path.join(buildDir, "main.js"), source);
        fs.writeFileSync(
          path.join(assetsDir, "remote-control-connections-visibility-test.js"),
          syntheticVisibilityBundle(),
        );
        fs.writeFileSync(
          path.join(assetsDir, "remote-connections-settings-test.js"),
          syntheticRemoteConnectionsSettingsCopyBundle(),
        );
        fs.writeFileSync(
          path.join(assetsDir, "codex-mobile-setup-flow-test.js"),
          syntheticMobileSetupFlowCopyBundle(),
        );
        fs.writeFileSync(
          path.join(assetsDir, "use-codex-mobile-connected-settings-test.js"),
          syntheticMobileConnectedSettingsBundle(),
        );

        const report = createPatchReport();
        patchExtractedApp(tempApp, { report });

        const patchedFile = fs.readFileSync(path.join(buildDir, "main.js"), "utf8");
        const patchedVisibilityFile = fs.readFileSync(
          path.join(assetsDir, "remote-control-connections-visibility-test.js"),
          "utf8",
        );
        const patchedRemoteConnectionsSettingsFile = fs.readFileSync(
          path.join(assetsDir, "remote-connections-settings-test.js"),
          "utf8",
        );
        const patchedMobileSetupFlowFile = fs.readFileSync(
          path.join(assetsDir, "codex-mobile-setup-flow-test.js"),
          "utf8",
        );
        const patchedMobileConnectedSettingsFile = fs.readFileSync(
          path.join(assetsDir, "use-codex-mobile-connected-settings-test.js"),
          "utf8",
        );
        assert.match(patchedFile, /codexLinuxRemoteControlDeviceKeyClient/);
        assert.match(patchedFile, /n\.kind===`local`&&process\.platform!==`linux`/);
        assert.match(patchedVisibilityFile, /navigator\.userAgent\.includes\(`Linux`\)/);
        assert.match(patchedRemoteConnectionsSettingsFile, /Control this Linux desktop/);
        assert.match(patchedRemoteConnectionsSettingsFile, /SSH connections from this Linux desktop/);
        assert.match(patchedMobileSetupFlowFile, /Connect your phone to this Linux desktop/);
        assert.match(patchedMobileConnectedSettingsFile, /apps on this Linux desktop/);
        assert.ok(
          report.patches.some((patch) =>
            patch.name === "feature:remote-mobile-control:linux-remote-control-device-key" &&
            patch.status === "applied",
          ),
        );
        assert.ok(
          report.patches.some((patch) =>
            patch.name === "feature:remote-mobile-control:linux-remote-control-preserve-config" &&
            patch.status === "applied",
          ),
        );
        assert.ok(
          report.patches.some((patch) =>
            patch.name === "feature:remote-mobile-control:linux-remote-control-visibility" &&
            patch.status === "applied",
          ),
        );
        assert.ok(
          report.patches.some((patch) =>
            patch.name === "feature:remote-mobile-control:linux-remote-control-copy" &&
            patch.status === "applied",
          ),
        );
      } finally {
        fs.rmSync(tempApp, { recursive: true, force: true });
      }
    });
  });
});
