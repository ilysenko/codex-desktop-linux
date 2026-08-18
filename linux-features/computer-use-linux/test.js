"use strict";

const assert = require("node:assert/strict");
const { execFileSync } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const manifest = require("./feature.json");
const descriptors = require("./patch.js");

test("computer-use-linux is opt-in and owns the current Linux descriptors", () => {
  assert.equal(manifest.defaultEnabled, false);
  assert.deepEqual(
    descriptors.map(({ id }) => id),
    [
      "avatar-cursor",
      "ui-feature",
      "plugin-gate",
      "native-desktop-apps",
      "ui-availability",
      "host-platform",
    ],
  );
});

test("computer-use-linux staging consumes release artifacts without invoking Cargo", () => {
  const stage = fs.readFileSync(path.join(__dirname, "stage.sh"), "utf8");
  assert.doesNotMatch(stage, /cargo\s+(?:build|install)/);
  assert.match(stage, /target\/release\/codex-computer-use-linux/);
});

test("computer-use-linux staging registers the bundled plugin idempotently", (t) => {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "computer-use-linux-stage-"));
  t.after(() => fs.rmSync(workspace, { recursive: true, force: true }));

  const installDir = path.join(workspace, "app");
  const releaseDir = path.join(workspace, "target", "release");
  const marketplacePath = path.join(
    installDir,
    "resources/plugins/openai-bundled/.agents/plugins/marketplace.json",
  );
  fs.mkdirSync(path.dirname(marketplacePath), { recursive: true });
  fs.writeFileSync(
    marketplacePath,
    `${JSON.stringify({ plugins: [{ name: "browser", source: { source: "local", path: "./plugins/browser" } }] })}\n`,
  );
  fs.mkdirSync(releaseDir, { recursive: true });
  for (const binary of ["codex-computer-use-linux", "codex-computer-use-cosmic"]) {
    const binaryPath = path.join(releaseDir, binary);
    fs.writeFileSync(binaryPath, "#!/bin/sh\nexit 0\n", { mode: 0o755 });
  }

  const env = {
    ...process.env,
    SCRIPT_DIR: workspace,
    INSTALL_DIR: installDir,
    CODEX_COMPUTER_USE_BINARY_SOURCE: path.join(releaseDir, "codex-computer-use-linux"),
    CODEX_COMPUTER_USE_COSMIC_BINARY_SOURCE: path.join(releaseDir, "codex-computer-use-cosmic"),
  };
  fs.mkdirSync(path.join(workspace, "plugins/openai-bundled/plugins"), { recursive: true });
  fs.cpSync(
    path.resolve(__dirname, "../../plugins/openai-bundled/plugins/computer-use"),
    path.join(workspace, "plugins/openai-bundled/plugins/computer-use"),
    { recursive: true },
  );

  execFileSync("bash", [path.join(__dirname, "stage.sh")], { env });
  execFileSync("bash", [path.join(__dirname, "stage.sh")], { env });

  const marketplace = JSON.parse(fs.readFileSync(marketplacePath, "utf8"));
  assert.equal(marketplace.plugins.filter(({ name }) => name === "computer-use").length, 1);
  assert.ok(marketplace.plugins.some(({ name }) => name === "browser"));
  assert.deepEqual(
    marketplace.plugins.find(({ name }) => name === "computer-use"),
    {
      name: "computer-use",
      source: { source: "local", path: "./plugins/computer-use" },
      policy: { installation: "AVAILABLE", authentication: "ON_INSTALL" },
      category: "Productivity",
    },
  );
  assert.equal(
    fs.existsSync(
      path.join(
        installDir,
        "resources/plugins/openai-bundled/plugins/computer-use/bin/codex-computer-use-linux",
      ),
    ),
    true,
  );
});
