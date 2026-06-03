"use strict";

const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const zlib = require("node:zlib");
const { execFileSync } = require("node:child_process");

const featureDir = __dirname;
const featureId = "x11-ewmh-computer-use";

function upstreamRepoRoot() {
  const candidates = [
    process.env.CODEX_DESKTOP_LINUX_REPO,
    process.env.CODEX_DESKTOP_LINUX_FULL_PATH,
    path.resolve(featureDir, "..", ".."),
    "/home/as/Документы/AI_PROJECTS/codex-desktop-linux",
  ].filter(Boolean);
  for (const candidate of candidates) {
    if (fs.existsSync(path.join(candidate, "scripts/lib/linux-features.js"))) {
      return candidate;
    }
  }
  throw new Error("Could not locate codex-desktop-linux scripts/lib/linux-features.js; set CODEX_DESKTOP_LINUX_REPO");
}

function linuxFeaturesLib() {
  const repoRoot = upstreamRepoRoot();
  return require(path.join(repoRoot, "scripts/lib/linux-features.js"));
}

function copyFeatureTo(featuresRoot) {
  const target = path.join(featuresRoot, featureId);
  fs.mkdirSync(target, { recursive: true });
  for (const file of ["feature.json", "README.md", "stage.sh", "patches.js"]) {
    fs.copyFileSync(path.join(featureDir, file), path.join(target, file));
  }
  fs.chmodSync(path.join(target, "stage.sh"), 0o755);
}

function tempDir(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), `${prefix}-`));
}

function makeFakeExecutable(file) {
  fs.writeFileSync(file, "#!/bin/sh\nif [ \"$1\" = doctor ]; then echo '{\"project\":\"codex-computer-use-x11\",\"version\":\"test\",\"backend\":\"x11-ewmh\",\"readiness\":{\"ok\":true}}'; fi\nexit 0\n");
  fs.chmodSync(file, 0o755);
}


function sha256(file) {
  return crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex");
}

function writeTarOctal(header, offset, length, value) {
  const text = value.toString(8).padStart(length - 1, "0").slice(-(length - 1));
  header.write(`${text}\0`, offset, length, "ascii");
}

function writeTarString(header, offset, length, value) {
  const encoded = Buffer.from(value, "utf8");
  assert.equal(encoded.length <= length, true, `tar field too long: ${value}`);
  encoded.copy(header, offset);
}

function tarHeader(entry) {
  const content = Buffer.isBuffer(entry.content) ? entry.content : Buffer.from(entry.content ?? "");
  const header = Buffer.alloc(512, 0);
  writeTarString(header, 0, 100, entry.name);
  writeTarOctal(header, 100, 8, entry.mode ?? (entry.type === "5" ? 0o755 : 0o644));
  writeTarOctal(header, 108, 8, 0);
  writeTarOctal(header, 116, 8, 0);
  writeTarOctal(header, 124, 12, entry.type === "0" || entry.type == null ? content.length : 0);
  writeTarOctal(header, 136, 12, 0);
  header.fill(" ", 148, 156);
  header.write(entry.type ?? "0", 156, 1, "ascii");
  if (entry.linkname) writeTarString(header, 157, 100, entry.linkname);
  header.write("ustar\0", 257, 6, "ascii");
  header.write("00", 263, 2, "ascii");
  header.write("0", 265, 1, "ascii");
  header.write("0", 297, 1, "ascii");
  let checksum = 0;
  for (const byte of header) checksum += byte;
  const checksumText = checksum.toString(8).padStart(6, "0").slice(-6);
  header.write(`${checksumText}\0 `, 148, 8, "ascii");
  const padding = Buffer.alloc((512 - (content.length % 512)) % 512, 0);
  return [header, content, padding];
}

function writeTarGz(file, entries) {
  const chunks = [];
  for (const entry of entries) chunks.push(...tarHeader(entry));
  chunks.push(Buffer.alloc(1024, 0));
  fs.writeFileSync(file, zlib.gzipSync(Buffer.concat(chunks)));
}

function safePluginTarball(file) {
  writeTarGz(file, [
    { name: "codex-computer-use-x11/", type: "5" },
    { name: "codex-computer-use-x11/bin/", type: "5" },
    { name: "codex-computer-use-x11/.mcp.json", type: "0", content: '{"mcpServers":{"codex-computer-use-x11":{"command":"./bin/codex-computer-use-x11"}}}\n' },
    { name: "codex-computer-use-x11/bin/codex-computer-use-x11", type: "0", mode: 0o755, content: "#!/bin/sh\nexit 0\n" },
  ]);
}

function runStage(workspace, extraEnv = {}) {
  return execFileSync("bash", [path.join(featureDir, "stage.sh")], {
    cwd: workspace,
    env: {
      ...process.env,
      SCRIPT_DIR: upstreamRepoRoot(),
      INSTALL_DIR: path.join(workspace, "install"),
      WORK_DIR: path.join(workspace, "work"),
      ARCH: "x86_64",
      CODEX_UPSTREAM_APP_DIR: path.join(workspace, "Codex.app"),
      ...extraEnv,
    },
    stdio: "pipe",
  });
}

function applyPatchTwice(patchFn, source) {
  const patched = patchFn(source);
  assert.equal(patchFn(patched), patched);
  return patched;
}


test("x11-ewmh-computer-use documents and pins v0.1.3 release artifact", () => {
  const stage = fs.readFileSync(path.join(featureDir, "stage.sh"), "utf8");
  const readme = fs.readFileSync(path.join(featureDir, "README.md"), "utf8");
  const url = "https://github.com/AlekseiSeleznev/codex-computer-use-x11/releases/download/v0.1.3/codex-computer-use-x11-v0.1.3-x86_64-unknown-linux-gnu.tar.gz";
  const sha = "067244a16f9e812eb369af42149658c8cf138b13057445bb9d10318f29b0c26b";
  assert.equal(stage.includes(url), true);
  assert.equal(stage.includes(sha), true);
  assert.equal(readme.includes(url), true);
  assert.equal(readme.includes(sha), true);
});


test("x11-ewmh-computer-use default release fails fast on unsupported architectures", () => {
  const workspace = tempDir("x11-ewmh-arch");
  assert.throws(
    () => runStage(workspace, { ARCH: "aarch64" }),
    (error) => {
      assert.match(String(error.stderr), /no default release artifact for ARCH=aarch64/);
      return true;
    },
  );
});

test("x11-ewmh-computer-use validates tarball entries before extraction", () => {
  const cases = [
    {
      name: "absolute",
      entry: { name: "/tmp/evil", type: "0", content: "evil" },
      message: /unsafe absolute path/,
    },
    {
      name: "parent",
      entry: { name: "../evil", type: "0", content: "evil" },
      message: /unsafe parent path/,
    },
    {
      name: "symlink",
      entry: { name: "codex-computer-use-x11/bin/link", type: "2", linkname: "/tmp/evil" },
      message: /unsupported symlink entry/,
    },
    {
      name: "hardlink",
      entry: { name: "codex-computer-use-x11/bin/link", type: "1", linkname: "codex-computer-use-x11/bin/codex-computer-use-x11" },
      message: /unsupported hardlink entry/,
    },
  ];

  for (const item of cases) {
    const workspace = tempDir(`x11-ewmh-tar-${item.name}`);
    const tarball = path.join(workspace, "malicious.tar.gz");
    writeTarGz(tarball, [item.entry]);
    assert.throws(
      () => runStage(workspace, {
        CODEX_X11_COMPUTER_USE_RELEASE_TARBALL: tarball,
        CODEX_X11_COMPUTER_USE_RELEASE_SHA256: sha256(tarball),
      }),
      (error) => {
        assert.match(String(error.stderr), item.message);
        return true;
      },
    );
  }
});

test("x11-ewmh-computer-use stages a validated safe release tarball", () => {
  const workspace = tempDir("x11-ewmh-safe-tar");
  const tarball = path.join(workspace, "safe.tar.gz");
  safePluginTarball(tarball);
  runStage(workspace, {
    CODEX_X11_COMPUTER_USE_RELEASE_TARBALL: tarball,
    CODEX_X11_COMPUTER_USE_RELEASE_SHA256: sha256(tarball),
  });
  const pluginDir = path.join(workspace, "install/resources/plugins/openai-bundled/plugins/codex-computer-use-x11");
  assert.equal(fs.existsSync(path.join(pluginDir, ".mcp.json")), true);
  assert.equal(fs.existsSync(path.join(pluginDir, "bin/codex-computer-use-x11")), true);
});

test("x11-ewmh-computer-use stays disabled until listed in features.json", () => {
  const { enabledLinuxFeatureStageHooks, loadLinuxFeaturePatchDescriptors } = linuxFeaturesLib();
  const workspace = tempDir("x11-ewmh-feature");
  const featuresRoot = path.join(workspace, "features");
  fs.mkdirSync(featuresRoot, { recursive: true });
  copyFeatureTo(featuresRoot);
  fs.writeFileSync(path.join(featuresRoot, "features.example.json"), '{"enabled":[]}\n');

  assert.deepEqual(enabledLinuxFeatureStageHooks({ featuresRoot }), []);
  assert.deepEqual(loadLinuxFeaturePatchDescriptors({ featuresRoot }), []);

  fs.writeFileSync(path.join(featuresRoot, "features.json"), `{"enabled":["${featureId}"]}\n`);
  assert.equal(enabledLinuxFeatureStageHooks({ featuresRoot }).length, 1);
  assert.equal(loadLinuxFeaturePatchDescriptors({ featuresRoot }).length, 1);
});

test("x11-ewmh-computer-use plugin gate is idempotent and narrow", () => {
  const { applyX11ComputerUsePluginGatePatch } = require("./patches.js");
  const source = [
    "var lt=`browser-use`,ft=`computer-use`,pt=`latex-tectonic`;",
    "var Kr=[{forceReload:!0,installWhenMissing:!0,name:lt,isAvailable:({features:e})=>e.inAppBrowserUseAllowed},{name:ft,isAvailable:({features:e,platform:t})=>t===`darwin`&&e.computerUse,migrate:vr},{name:pt,isAvailable:()=>!0}];",
  ].join("");
  const patched = applyPatchTwice(applyX11ComputerUsePluginGatePatch, source);
  assert.match(patched, /name:`codex-computer-use-x11`,isAvailable:\(\{platform:e\}\)=>e===`linux`/);
  assert.match(patched, /name:ft,isAvailable:\(\{features:e,platform:t\}\)=>t===`darwin`&&e\.computerUse/);
});


test("x11-ewmh-computer-use plugin gate surfaces upstream computerUse marker drift", () => {
  const { applyX11ComputerUsePluginGatePatch } = require("./patches.js");
  assert.throws(
    () => applyX11ComputerUsePluginGatePatch("var Kr=[{name:`latex-tectonic`,isAvailable:()=>!0}];"),
    /expected upstream \.computerUse plugin descriptor array/,
  );
});

test("x11-ewmh-computer-use plugin gate descriptor stays optional", () => {
  const { descriptors } = require("./patches.js");
  assert.equal(descriptors[0].ciPolicy, "optional");
});

test("x11-ewmh-computer-use stage hook records marketplace entry and preserves computer-use", () => {
  const workspace = tempDir("x11-ewmh-stage");
  const installDir = path.join(workspace, "install");
  const workDir = path.join(workspace, "work");
  const fakeBinary = path.join(workspace, "codex-computer-use-x11");
  const computerUseDir = path.join(installDir, "resources/plugins/openai-bundled/plugins/computer-use");
  const computerUseMarker = path.join(computerUseDir, ".mcp.json");
  const marketplace = path.join(installDir, "resources/plugins/openai-bundled/.agents/plugins/marketplace.json");
  fs.mkdirSync(computerUseDir, { recursive: true });
  fs.mkdirSync(path.dirname(marketplace), { recursive: true });
  fs.writeFileSync(computerUseMarker, '{"mcpServers":{"computer-use":{"command":"./bin/codex-computer-use-linux"}}}\n');
  fs.writeFileSync(marketplace, JSON.stringify({ plugins: [{ name: "computer-use", source: { path: "./plugins/computer-use" } }] }));
  const beforeComputerUse = fs.readFileSync(computerUseMarker, "utf8");
  makeFakeExecutable(fakeBinary);

  execFileSync("bash", [path.join(featureDir, "stage.sh")], {
    cwd: workspace,
    env: {
      ...process.env,
      SCRIPT_DIR: upstreamRepoRoot(),
      INSTALL_DIR: installDir,
      WORK_DIR: workDir,
      ARCH: process.arch === "arm64" ? "aarch64" : "x86_64",
      CODEX_UPSTREAM_APP_DIR: path.join(workspace, "Codex.app"),
      CODEX_X11_COMPUTER_USE_BINARY: fakeBinary,
    },
    stdio: "pipe",
  });

  const pluginDir = path.join(installDir, "resources/plugins/openai-bundled/plugins/codex-computer-use-x11");
  assert.equal(fs.existsSync(path.join(pluginDir, ".mcp.json")), true);
  assert.equal(fs.existsSync(path.join(pluginDir, "bin/codex-computer-use-x11")), true);
  assert.equal(fs.statSync(path.join(pluginDir, "bin/codex-computer-use-x11")).mode & 0o111 ? true : false, true);
  assert.equal(fs.readFileSync(computerUseMarker, "utf8"), beforeComputerUse);

  const parsedMarketplace = JSON.parse(fs.readFileSync(marketplace, "utf8"));
  assert.equal(parsedMarketplace.plugins.some((plugin) => plugin.name === "codex-computer-use-x11" && plugin.source?.path === "./plugins/codex-computer-use-x11" && plugin.policy?.authentication === "ON_INSTALL"), true);
  assert.equal(parsedMarketplace.plugins.some((plugin) => plugin.name === "computer-use"), true);
});
