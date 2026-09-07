#!/usr/bin/env node
"use strict";

const assert = require("node:assert/strict");
const { spawn, spawnSync } = require("node:child_process");
const fs = require("node:fs");
const net = require("node:net");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const vm = require("node:vm");

const {
  enabledLinuxFeatureIds,
  enabledLinuxFeatureInstallPlan,
  loadLinuxFeaturePatchDescriptors,
} = require("../../scripts/lib/linux-features.js");
const { applyFlatpakChromeProfileRoot } = require("./patch.js");

const FEATURE_DIR = __dirname;
const BRIDGE = path.join(FEATURE_DIR, "bridge.mjs");
const HOST_NAME = "com.openai.codexextension";
const EXTENSION_ID = "hehggadaopoacecdllhhajmbjkdcmajg";
const ORIGIN = `chrome-extension://${EXTENSION_ID}/`;

function commandPath(name) {
  for (const directory of (process.env.PATH || "").split(path.delimiter)) {
    if (!directory || !path.isAbsolute(directory)) continue;
    const candidate = path.join(directory, name);
    try {
      fs.accessSync(candidate, fs.constants.X_OK);
      if (fs.statSync(candidate).isFile()) return candidate;
    } catch {}
  }
  throw new Error(`could not resolve executable from PATH: ${name}`);
}

const BASH = commandPath("bash");

function withFeatureConfig(enabled, fn) {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "codex-flatpak-chrome-config-"));
  const configPath = path.join(tempDir, "features.json");
  const originalConfig = process.env.CODEX_LINUX_FEATURES_CONFIG;
  fs.writeFileSync(configPath, `${JSON.stringify({ enabled }, null, 2)}\n`);
  process.env.CODEX_LINUX_FEATURES_CONFIG = configPath;
  try {
    return fn(path.resolve(FEATURE_DIR, ".."));
  } finally {
    if (originalConfig == null) delete process.env.CODEX_LINUX_FEATURES_CONFIG;
    else process.env.CODEX_LINUX_FEATURES_CONFIG = originalConfig;
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
}

function createFixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "codex-flatpak-chrome-"));
  const appDir = path.join(root, "app");
  const codexHome = path.join(root, "codex-home");
  const stateDir = path.join(root, "state", "bridge");
  const flatpakRoot = path.join(root, "flatpak");
  const registryPath = path.join(root, "chrome-native-hosts-v2.json");
  const extensionRegistry = path.join(
    appDir,
    "resources/plugins/openai-bundled/plugins/chrome/scripts/extension-ids.json",
  );
  const hostPath = path.join(
    codexHome,
    "plugins/cache/openai-bundled/chrome/1/extension-host/linux/x64/extension-host",
  );
  const hostMarker = path.join(root, "host-started");
  fs.mkdirSync(path.dirname(extensionRegistry), { recursive: true });
  fs.mkdirSync(path.dirname(hostPath), { recursive: true });
  fs.mkdirSync(flatpakRoot, { recursive: true });
  fs.writeFileSync(extensionRegistry, `${JSON.stringify({
    extensionHostName: HOST_NAME,
    extensionIds: [EXTENSION_ID],
  })}\n`);
  fs.writeFileSync(hostPath, `#!/usr/bin/bash\nprintf started >> '${hostMarker}'\ncat\n`, { mode: 0o700 });
  fs.writeFileSync(registryPath, `${JSON.stringify({
    schemaVersion: 2,
    entries: [{
      schemaVersion: 2,
      nativeHostNames: [HOST_NAME],
      extensionIds: [EXTENSION_ID],
      paths: {
        codexHome,
        resourcesPath: path.join(appDir, "resources"),
        extensionHostPath: hostPath,
      },
      presence: { lastSeenAt: new Date().toISOString() },
    }],
  })}\n`);
  const options = [
    "--app-dir", appDir,
    "--codex-home", codexHome,
    "--state-dir", stateDir,
    "--flatpak-root", flatpakRoot,
    "--owner-pid", String(process.pid),
  ];
  const env = { ...process.env, CODEX_CHROME_NATIVE_HOST_REGISTRY: registryPath };
  return {
    root,
    appDir,
    codexHome,
    stateDir,
    flatpakRoot,
    registryPath,
    hostPath,
    hostMarker,
    options,
    env,
    stateFile: path.join(stateDir, "bridge-state.json"),
    manifestPath: path.join(
      flatpakRoot,
      "config/google-chrome/NativeMessagingHosts",
      `${HOST_NAME}.json`,
    ),
  };
}

function bridgeCommand(fixture, command) {
  return spawnSync(process.execPath, [BRIDGE, command, ...fixture.options], {
    env: fixture.env,
    encoding: "utf8",
    timeout: 10000,
  });
}

async function waitFor(predicate, timeout = 3000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  assert.fail("timed out waiting for condition");
}

async function cleanupFixture(fixture) {
  bridgeCommand(fixture, "cleanup");
  await waitFor(() => !fs.existsSync(fixture.stateFile)).catch(() => {});
  fs.rmSync(fixture.root, { recursive: true, force: true });
}

test("flatpak-chrome-native-messaging stays disabled until selected", () => {
  withFeatureConfig([], (featuresRoot) => {
    assert.deepEqual(enabledLinuxFeatureIds({ featuresRoot }), []);
  });
});

test("feature stages the relay and lifecycle hooks only when enabled", () => {
  withFeatureConfig(["flatpak-chrome-native-messaging"], (featuresRoot) => {
    assert.deepEqual(enabledLinuxFeatureIds({ featuresRoot }), ["flatpak-chrome-native-messaging"]);
    const descriptors = loadLinuxFeaturePatchDescriptors({ featuresRoot });
    assert.equal(descriptors.length, 1);
    assert.equal(
      descriptors[0].id,
      "feature:flatpak-chrome-native-messaging:flatpak-chrome-profile-status",
    );
    assert.equal(descriptors[0].ciPolicy, "opt-in");
    const plan = enabledLinuxFeatureInstallPlan({ featuresRoot });
    assert.deepEqual(
      plan.resources.map(({ target, mode }) => [target, mode]),
      [[".codex-linux/features/flatpak-chrome-native-messaging/bridge.mjs", 0o644]],
    );
    assert.deepEqual(
      plan.runtimeHooks.map(({ key, mode }) => [key, mode]),
      [["prelaunch", 0o755], ["launcher", 0o755], ["afterExit", 0o755]],
    );
  });
});

test("Settings detector adds only the explicit Flatpak Chrome profile", () => {
  const source = "function Va({browserFamily:e,chromeConfigHome:t,homeDir:r," +
    "localAppDataDir:i,roamingAppDataDir:a,platform:o,xdgConfigHome:s}){" +
    "let c=n.as[e];if(o===`darwin`)return[(0,p.join)(r,...c.macos.userDataDirectorySegments)];" +
    "if(o===`win32`)return[i,a];if(o===`linux`){let i=n.F({chromeConfigHome:" +
    "e===`chrome`?t:void 0,homeDir:r,xdgConfigHome:s});return c.linux.installations.map(" +
    "e=>(0,p.join)(i,e.userDataDirName))}return[]}";
  const patched = applyFlatpakChromeProfileRoot(source);
  const sandbox = {
    n: {
      as: {
        chrome: {
          linux: { installations: [{ userDataDirName: "google-chrome" }] },
          macos: { userDataDirectorySegments: ["Library", "Chrome"] },
        },
        edge: {
          linux: { installations: [{ userDataDirName: "microsoft-edge" }] },
          macos: { userDataDirectorySegments: ["Library", "Edge"] },
        },
      },
      F: ({ homeDir }) => `${homeDir}/.config`,
    },
    p: { join: path.join },
    process: { env: { CODEX_CHROME_USER_DATA_DIR: "/flatpak/google-chrome" } },
  };
  const resolveProfiles = vm.runInNewContext(`${patched}; Va`, sandbox);
  assert.deepEqual(
    [...resolveProfiles({ browserFamily: "chrome", homeDir: "/home/test", platform: "linux" })],
    ["/home/test/.config/google-chrome", "/flatpak/google-chrome"],
  );
  assert.deepEqual(
    [...resolveProfiles({ browserFamily: "edge", homeDir: "/home/test", platform: "linux" })],
    ["/home/test/.config/microsoft-edge"],
  );
  assert.deepEqual(
    [...resolveProfiles({ browserFamily: "chrome", homeDir: "/home/test", platform: "darwin" })],
    ["/home/test/Library/Chrome"],
  );
  assert.throws(() => applyFlatpakChromeProfileRoot("function unrelated(){}"), /found 0/);
  assert.throws(() => applyFlatpakChromeProfileRoot(`${source}${source}`), /found 2/);
});

test("launcher points upstream diagnostics at the Flatpak Chrome profile", () => {
  const fixture = createFixture();
  try {
    const result = spawnSync(BASH, [path.join(FEATURE_DIR, "runtime.sh")], {
      env: {
        ...process.env,
        CODEX_LINUX_FEATURE_HOOK_PHASE: "launcher",
        CODEX_FLATPAK_CHROME_ROOT: fixture.flatpakRoot,
      },
      encoding: "utf8",
    });
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, new RegExp(`CODEX_CHROME_USER_DATA_DIR=${fixture.flatpakRoot}`));
    assert.match(result.stdout, /CODEX_CHROME_NATIVE_HOST_MANIFEST_PATH=/);
  } finally {
    fs.rmSync(fixture.root, { recursive: true, force: true });
  }
});

test("relay preserves binary native-messaging bytes and rejects invalid authentication", async () => {
  const fixture = createFixture();
  try {
    const started = bridgeCommand(fixture, "ensure");
    assert.equal(started.status, 0, started.stderr);
    const state = JSON.parse(fs.readFileSync(fixture.stateFile, "utf8"));
    const manifest = JSON.parse(fs.readFileSync(fixture.manifestPath, "utf8"));
    assert.equal(manifest.name, HOST_NAME);
    assert.equal(manifest.path, path.join(path.dirname(fixture.manifestPath), `${HOST_NAME}-codex-desktop-bridge`));
    assert.deepEqual(manifest.allowed_origins, [ORIGIN]);
    assert.equal(fs.statSync(manifest.path).mode & 0o777, 0o700);
    assert.equal(fs.statSync(fixture.stateFile).mode & 0o777, 0o600);

    await new Promise((resolve, reject) => {
      const socket = net.createConnection({ host: "127.0.0.1", port: state.port });
      socket.on("connect", () => socket.resetAndDestroy());
      socket.on("close", resolve);
      socket.on("error", (error) => {
        if (error.code === "ECONNRESET") resolve();
        else reject(error);
      });
    });
    const afterReset = bridgeCommand(fixture, "ensure");
    assert.equal(afterReset.status, 0, afterReset.stderr);
    assert.equal(JSON.parse(fs.readFileSync(fixture.stateFile, "utf8")).serverPid, state.serverPid);

    await new Promise((resolve, reject) => {
      const socket = net.createConnection({ host: "127.0.0.1", port: state.port });
      socket.on("connect", () => socket.end(`wrong-token\n${ORIGIN}\n`));
      socket.on("close", resolve);
      socket.on("error", reject);
    });
    assert.equal(fs.existsSync(fixture.hostMarker), false);

    const payload = Buffer.alloc(4096);
    for (let index = 0; index < payload.length; index += 1) payload[index] = index % 256;
    const echoed = await new Promise((resolve, reject) => {
      const chunks = [];
      let length = 0;
      const socket = net.createConnection({ host: "127.0.0.1", port: state.port });
      socket.on("connect", () => {
        socket.write(Buffer.concat([Buffer.from(`${state.token}\n${ORIGIN}\n`), payload]));
      });
      socket.on("data", (chunk) => {
        chunks.push(chunk);
        length += chunk.length;
        if (length >= payload.length) socket.end();
      });
      socket.on("close", () => resolve(Buffer.concat(chunks)));
      socket.on("error", reject);
    });
    assert.deepEqual(echoed, payload);
    assert.equal(fs.readFileSync(fixture.hostMarker, "utf8"), "started");
  } finally {
    await cleanupFixture(fixture);
  }
});

test("Flatpak wrapper forwards bytes and a repeated launch reuses the live relay", async () => {
  const fixture = createFixture();
  try {
    const first = bridgeCommand(fixture, "ensure");
    assert.equal(first.status, 0, first.stderr);
    const initialState = JSON.parse(fs.readFileSync(fixture.stateFile, "utf8"));
    const second = bridgeCommand(fixture, "ensure");
    assert.equal(second.status, 0, second.stderr);
    assert.deepEqual(JSON.parse(fs.readFileSync(fixture.stateFile, "utf8")), initialState);

    const saturatedSockets = await Promise.all(Array.from({ length: 8 }, () => (
      new Promise((resolve, reject) => {
        const socket = net.createConnection({ host: "127.0.0.1", port: initialState.port });
        socket.on("connect", () => { socket.write("partial-auth"); resolve(socket); });
        socket.on("error", reject);
      })
    )));
    const whileSaturated = bridgeCommand(fixture, "ensure");
    assert.notEqual(whileSaturated.status, 0);
    assert.deepEqual(JSON.parse(fs.readFileSync(fixture.stateFile, "utf8")), initialState);
    for (const socket of saturatedSockets) socket.destroy();
    await new Promise((resolve) => setTimeout(resolve, 25));
    const afterSaturation = bridgeCommand(fixture, "ensure");
    assert.equal(afterSaturation.status, 0, afterSaturation.stderr);

    const manifest = JSON.parse(fs.readFileSync(fixture.manifestPath, "utf8"));
    const child = spawn(BASH, [manifest.path, ORIGIN], { stdio: ["pipe", "pipe", "pipe"] });
    const payload = Buffer.from([8, 0, 0, 0, 0, 1, 2, 3, 255, 4, 5, 6]);
    const received = await new Promise((resolve, reject) => {
      const chunks = [];
      let length = 0;
      child.stdout.on("data", (chunk) => {
        chunks.push(chunk);
        length += chunk.length;
        if (length >= payload.length) {
          child.stdin.end();
          resolve(Buffer.concat(chunks));
        }
      });
      child.on("error", reject);
      child.stdin.write(payload);
    });
    assert.deepEqual(received, payload);
    await new Promise((resolve) => child.once("exit", resolve));
  } finally {
    await cleanupFixture(fixture);
  }
});

test("relay drains a final host response before closing the browser pipe", async () => {
  const fixture = createFixture();
  const outputSize = 4 * 1024 * 1024;
  fs.writeFileSync(
    fixture.hostPath,
    `#!/usr/bin/bash\nhead -c ${outputSize} /dev/zero\n`,
    { mode: 0o700 },
  );
  try {
    const started = bridgeCommand(fixture, "ensure");
    assert.equal(started.status, 0, started.stderr);
    const state = JSON.parse(fs.readFileSync(fixture.stateFile, "utf8"));
    const received = await new Promise((resolve, reject) => {
      let byteCount = 0;
      let allZero = true;
      const socket = net.createConnection({ host: "127.0.0.1", port: state.port });
      socket.on("connect", () => socket.write(`${state.token}\n${ORIGIN}\n`));
      socket.on("data", (chunk) => {
        byteCount += chunk.length;
        if (chunk.some((byte) => byte !== 0)) allZero = false;
        socket.pause();
        setTimeout(() => socket.resume(), 1);
      });
      socket.on("end", () => resolve({ byteCount, allZero }));
      socket.on("error", reject);
    });
    assert.deepEqual(received, { byteCount: outputSize, allZero: true });
  } finally {
    await cleanupFixture(fixture);
  }
});

test("cleanup restores a recognized official manifest byte for byte", async () => {
  const fixture = createFixture();
  const nativeDirectory = path.dirname(fixture.manifestPath);
  const original = `${JSON.stringify({
    name: HOST_NAME,
    description: "Official host",
    path: fixture.hostPath,
    type: "stdio",
    allowed_origins: [ORIGIN],
  }, null, 2)}\n`;
  fs.mkdirSync(nativeDirectory, { recursive: true });
  fs.writeFileSync(fixture.manifestPath, original);
  try {
    const started = bridgeCommand(fixture, "ensure");
    assert.equal(started.status, 0, started.stderr);
    assert.notEqual(fs.readFileSync(fixture.manifestPath, "utf8"), original);
    const stopped = bridgeCommand(fixture, "cleanup");
    assert.equal(stopped.status, 0, stopped.stderr);
    await waitFor(() => fs.existsSync(fixture.manifestPath) && fs.readFileSync(fixture.manifestPath, "utf8") === original);
  } finally {
    await cleanupFixture(fixture);
  }
});

test("relay leaves an unrelated native-host manifest untouched", () => {
  const fixture = createFixture();
  const nativeDirectory = path.dirname(fixture.manifestPath);
  const foreign = `${JSON.stringify({
    name: HOST_NAME,
    description: "Local override",
    path: "/opt/local/custom-host",
    type: "stdio",
    allowed_origins: [ORIGIN],
  })}\n`;
  fs.mkdirSync(nativeDirectory, { recursive: true });
  fs.writeFileSync(fixture.manifestPath, foreign);
  try {
    const result = bridgeCommand(fixture, "ensure");
    assert.notEqual(result.status, 0);
    assert.equal(fs.readFileSync(fixture.manifestPath, "utf8"), foreign);
  } finally {
    const state = fs.existsSync(fixture.stateFile) ? JSON.parse(fs.readFileSync(fixture.stateFile, "utf8")) : null;
    if (state?.serverPid) {
      try { process.kill(state.serverPid, "SIGTERM"); } catch {}
    }
    fs.rmSync(fixture.root, { recursive: true, force: true });
  }
});

test("a manifest replaced while running becomes the next recovery baseline", async () => {
  const fixture = createFixture();
  const official = `${JSON.stringify({
    name: HOST_NAME,
    description: "Updated official host",
    path: fixture.hostPath,
    type: "stdio",
    allowed_origins: [ORIGIN],
  }, null, 2)}\n`;
  try {
    assert.equal(bridgeCommand(fixture, "ensure").status, 0);
    fs.writeFileSync(fixture.manifestPath, official);
    assert.equal(bridgeCommand(fixture, "cleanup").status, 0);
    await waitFor(() => !fs.existsSync(fixture.stateFile));
    assert.equal(fs.readFileSync(fixture.manifestPath, "utf8"), official);

    assert.equal(bridgeCommand(fixture, "ensure").status, 0);
    assert.notEqual(fs.readFileSync(fixture.manifestPath, "utf8"), official);
    assert.equal(bridgeCommand(fixture, "cleanup").status, 0);
    await waitFor(() => fs.readFileSync(fixture.manifestPath, "utf8") === official);
  } finally {
    await cleanupFixture(fixture);
  }
});
