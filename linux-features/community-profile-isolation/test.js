"use strict";

const assert = require("node:assert/strict");
const childProcess = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const featureDir = __dirname;
const wrapperSource = path.join(featureDir, "codex-cli-wrapper.sh");
const manifest = require("./feature.json");

function makeFakeApp(root) {
  const app = path.join(root, "community");
  const wrapper = path.join(
    app,
    ".codex-linux",
    "features",
    "community-profile-isolation",
    "codex-cli-wrapper.sh",
  );

  fs.mkdirSync(path.dirname(wrapper), { recursive: true });
  fs.copyFileSync(wrapperSource, wrapper);
  fs.chmodSync(wrapper, 0o755);

  return { app, wrapper };
}

test("manifest stages the Community CLI wrapper", () => {
  assert.deepEqual(manifest.resources, [
    {
      source: "codex-cli-wrapper.sh",
      target:
        ".codex-linux/features/community-profile-isolation/codex-cli-wrapper.sh",
      mode: "0755",
    },
  ]);
});

test("community isolation env pins CODEX_HOME under HOME", () => {
  const root = fs.mkdtempSync(
    path.join(os.tmpdir(), "community-isolation-home-"),
  );

  try {
    const home = path.join(root, "home");
    const app = path.join(root, "community");
    fs.mkdirSync(home, { recursive: true });

    const script = [
      "set -a",
      `. ${JSON.stringify(path.join(featureDir, "env.sh"))}`,
      "printf '%s' \"$CODEX_HOME\"",
    ].join("; ");

    const output = childProcess.execFileSync("bash", ["-c", script], {
      encoding: "utf8",
      env: {
        ...process.env,
        HOME: home,
        CODEX_HOME: "/tmp/wrong-codex-home",
        CODEX_LINUX_APP_DIR: app,
      },
    });

    assert.equal(output, path.join(home, ".codex-community"));
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("launcher emits Community CLI wrapper and canonical Electron profile", () => {
  const root = fs.mkdtempSync(
    path.join(os.tmpdir(), "community-isolation-launcher-"),
  );

  try {
    const home = path.join(root, "home");
    fs.mkdirSync(home, { recursive: true });

    const { app, wrapper } = makeFakeApp(root);

    const output = childProcess.execFileSync(
      path.join(featureDir, "launcher-hook.sh"),
      ["--class=codex-desktop"],
      {
        encoding: "utf8",
        env: {
          ...process.env,
          HOME: home,
          CODEX_LINUX_APP_DIR: app,
        },
      },
    ).trim().split("\n");

    assert.deepEqual(output, [
      `env CODEX_CLI_PATH=${wrapper}`,
      `electron-arg --user-data-dir=${path.join(
        home,
        ".config",
        "Codex-Community",
      )}`,
    ]);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("launcher rejects a conflicting Electron profile", () => {
  const root = fs.mkdtempSync(
    path.join(os.tmpdir(), "community-isolation-conflict-"),
  );

  try {
    const home = path.join(root, "home");
    const app = path.join(root, "community");
    fs.mkdirSync(home, { recursive: true });

    const result = childProcess.spawnSync(
      path.join(featureDir, "launcher-hook.sh"),
      ["--user-data-dir=/tmp/not-community"],
      {
        encoding: "utf8",
        env: {
          ...process.env,
          HOME: home,
          CODEX_LINUX_APP_DIR: app,
        },
      },
    );

    assert.equal(result.status, 64);
    assert.match(
      result.stderr,
      /refuses non-canonical --user-data-dir/,
    );
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("launcher fails closed when Community CLI wrapper is missing", () => {
  const root = fs.mkdtempSync(
    path.join(os.tmpdir(), "community-isolation-missing-"),
  );

  try {
    const home = path.join(root, "home");
    const app = path.join(root, "community");

    fs.mkdirSync(home, { recursive: true });
    fs.mkdirSync(app, { recursive: true });

    const result = childProcess.spawnSync(
      path.join(featureDir, "launcher-hook.sh"),
      [],
      {
        encoding: "utf8",
        env: {
          ...process.env,
          HOME: home,
          CODEX_LINUX_APP_DIR: app,
        },
      },
    );

    assert.equal(result.status, 69);
    assert.match(
      result.stderr,
      /CLI isolation wrapper is missing or not executable/,
    );
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("wrapper repairs runtime-reordered PATH and pins child PATH", () => {
  const root = fs.mkdtempSync(
    path.join(os.tmpdir(), "community-isolation-wrapper-"),
  );

  try {
    const home = path.join(root, "home");
    const officialBin = path.join(home, ".local", "bin");
    const runtimeOverride = path.join(root, "runtime", "override");

    fs.mkdirSync(home, { recursive: true });
    fs.mkdirSync(officialBin, { recursive: true });
    fs.mkdirSync(runtimeOverride, { recursive: true });

    const { app, wrapper } = makeFakeApp(root);
    const communityBin = path.join(app, "resources");
    const communityCodex = path.join(communityBin, "codex");
    const officialCodex = path.join(officialBin, "codex");

    fs.mkdirSync(communityBin, { recursive: true });

    fs.writeFileSync(
      officialCodex,
      "#!/bin/sh\nexit 0\n",
      { mode: 0o755 },
    );

    fs.writeFileSync(
      communityCodex,
      [
        "#!/usr/bin/env bash",
        'printf "PATH=%s\\n" "$PATH"',
        'printf "RESOLVED=%s\\n" "$(command -v codex)"',
        'for arg in "$@"; do printf "ARG=%s\\n" "$arg"; done',
        "",
      ].join("\n"),
      { mode: 0o755 },
    );

    const brokenPath = [
      runtimeOverride,
      officialBin,
      communityBin,
      "/usr/bin",
      "/bin",
    ].join(":");

    const output = childProcess.execFileSync(
      wrapper,
      [
        "-c",
        "features.code_mode_host=true",
        "app-server",
        "--remote-control",
      ],
      {
        encoding: "utf8",
        env: {
          ...process.env,
          HOME: home,
          CODEX_HOME: path.join(home, ".codex-community"),
          CODEX_LINUX_APP_DIR: app,
          PATH: brokenPath,
        },
      },
    ).trim().split("\n");

    const expectedPath = `${communityBin}:${brokenPath}`;

    assert.equal(output[0], `PATH=${expectedPath}`);
    assert.equal(output[1], `RESOLVED=${communityCodex}`);

    assert.deepEqual(output.slice(2), [
      "ARG=-c",
      `ARG=shell_environment_policy.set.PATH=${expectedPath}`,
      "ARG=-c",
      "ARG=features.code_mode_host=true",
      "ARG=app-server",
      "ARG=--remote-control",
    ]);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("wrapper refuses a non-Community CODEX_HOME", () => {
  const root = fs.mkdtempSync(
    path.join(os.tmpdir(), "community-isolation-wrong-home-"),
  );

  try {
    const home = path.join(root, "home");
    fs.mkdirSync(home, { recursive: true });

    const { app, wrapper } = makeFakeApp(root);
    const communityBin = path.join(app, "resources");
    fs.mkdirSync(communityBin, { recursive: true });

    fs.writeFileSync(
      path.join(communityBin, "codex"),
      "#!/bin/sh\nexit 0\n",
      { mode: 0o755 },
    );

    const result = childProcess.spawnSync(wrapper, ["--version"], {
      encoding: "utf8",
      env: {
        ...process.env,
        HOME: home,
        CODEX_HOME: path.join(home, ".codex"),
        CODEX_LINUX_APP_DIR: app,
        PATH: "/usr/bin:/bin",
      },
    });

    assert.equal(result.status, 64);
    assert.match(result.stderr, /refuses CODEX_HOME=/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
