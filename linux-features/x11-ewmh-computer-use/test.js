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
  fs.mkdirSync(path.join(target, "upstream-overlay"), { recursive: true });
  for (const file of fs.readdirSync(path.join(featureDir, "upstream-overlay"))) {
    fs.copyFileSync(
      path.join(featureDir, "upstream-overlay", file),
      path.join(target, "upstream-overlay", file),
    );
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

function fakeSourceInputRs() {
  return `use crate::doctor::{BACKEND_ID, PROJECT_NAME};\nuse crate::list_windows::{self, WindowInfo, WindowListingDiagnostics};\n\npub fn report_from_listing(\n    action: TargetedInputAction,\n    target: WindowTarget,\n    listing: list_windows::WindowListReport,\n) -> TargetedInputReport {\n    let requested_window = resolve_target(&listing.windows, &target).unwrap();\n    let focus = crate::focus::focus_window_report_from_listing(requested_window.window_id, listing.clone());\n\n    let keyboard = run_keyboard_backend(&action);\n    if keyboard.ok {\n        success(&action, listing, requested_window, focus, keyboard)\n    } else {\n        failure_with_keyboard(\n            &action,\n            listing,\n            Some(requested_window),\n            Some(focus),\n            Some(keyboard),\n            \"InputBackendFailed\",\n            \"Keyboard backend command failed after focus verification.\",\n            Vec::new(),\n        )\n    }\n}\n\nfn success(\n    action: &TargetedInputAction,\n    listing: list_windows::WindowListReport,\n    target: WindowInfo,\n    focus: FocusWindowReport,\n    keyboard: KeyboardAttempt,\n) -> TargetedInputReport {\n    TargetedInputReport {\n        project: PROJECT_NAME.to_string(),\n        version: env!(\"CARGO_PKG_VERSION\").to_string(),\n        backend: BACKEND_ID.to_string(),\n        action: action.name().to_string(),\n        success: true,\n        input_sent: true,\n        target: Some(target),\n        focus: Some(focus),\n        keyboard: Some(keyboard),\n        error_code: None,\n        note: \"Input was sent through active-context xdotool only after exact X11 active-window focus verification; xdotool --window direct events were not used as a safety boundary.\"\n            .to_string(),\n        diagnostics: TargetedInputDiagnostics {\n            ok: listing.diagnostics.blockers.is_empty(),\n            blockers: listing.diagnostics.blockers.clone(),\n            degraded_reasons: listing.diagnostics.degraded_reasons.clone(),\n            candidates: Vec::new(),\n            listing: listing.diagnostics,\n        },\n    }\n}\n\nfn run_keyboard_backend(action: &TargetedInputAction) -> KeyboardAttempt {\n    let (args, route, requested_key, normalized_key) = match action {\n        TargetedInputAction::TypeText { text } if !text.is_ascii() => {\n            return run_unicode_text_backend(text);\n        }\n        TargetedInputAction::TypeText { text } => (\n            vec![\n                \"type\".to_string(),\n                \"--clearmodifiers\".to_string(),\n                text.clone(),\n            ],\n            \"xdotool-type\".to_string(),\n            None,\n            None,\n        ),\n        TargetedInputAction::PressKey { key } => {\n            let normalized = normalize_key_alias(key);\n            (\n                vec![\n                    \"key\".to_string(),\n                    \"--clearmodifiers\".to_string(),\n                    normalized.clone(),\n                ],\n                \"xdotool-key\".to_string(),\n                Some(key.clone()),\n                Some(normalized),\n            )\n        }\n    };\n    let output = std::process::Command::new(\"xdotool\").args(&args).output();\n    match output {\n        Ok(output) => {\n            let detail = command_detail(&output);\n            let semantic_stderr_error = has_xdotool_semantic_stderr_error(&output);\n            KeyboardAttempt {\n                command: \"xdotool\".to_string(),\n                args,\n                ok: output.status.success() && !semantic_stderr_error,\n                detail,\n                active_context: true,\n                used_direct_window: false,\n                route,\n                requested_key,\n                normalized_key,\n                semantic_stderr_error,\n            }\n        }\n        Err(err) => KeyboardAttempt {\n            command: \"xdotool\".to_string(),\n            args,\n            ok: false,\n            detail: err.to_string(),\n            active_context: true,\n            used_direct_window: false,\n            route,\n            requested_key,\n            normalized_key,\n            semantic_stderr_error: false,\n        },\n    }\n}\n\nfn run_unicode_text_backend(text: &str) -> KeyboardAttempt {\n    let keysyms = unicode_keysyms(text);\n    let mut args = vec![\"key\".to_string(), \"--clearmodifiers\".to_string()];\n    args.extend(keysyms);\n    todo!()\n}\n`;
}

function fakeSourceTargetedInputTestRs() {
  return `#[cfg(unix)]\n#[test]\nfn targeted_type_text_invokes_active_context_xdotool_after_verified_focus() {\n    assert!(true);\n    assert!(\n        !false,\n        \"xdotool direct-window mode must not be used: test\"\n    );\n}\n\n#[cfg(unix)]\n#[test]\nfn targeted_press_key_invokes_active_context_xdotool_after_verified_focus() {\n    assert!(true);\n}\n`;
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

test("x11-ewmh-computer-use documents pinned source-build overlay mode", () => {
  const stage = fs.readFileSync(path.join(featureDir, "stage.sh"), "utf8");
  const readme = fs.readFileSync(path.join(featureDir, "README.md"), "utf8");
  const overlayPatch = path.join(featureDir, "upstream-overlay", "0001-terminal-return-uses-literal-newline.patch");
  const sourceUrl = "https://github.com/AlekseiSeleznev/codex-computer-use-x11/archive/refs/tags/v0.1.3.tar.gz";
  const sourceSha = "42948a01d3e821e817503c37466884ac8867e2d83a3cb97008ffc054e1df6e3a";
  assert.equal(stage.includes(sourceUrl), true);
  assert.equal(stage.includes(sourceSha), true);
  assert.equal(stage.includes("CODEX_X11_COMPUTER_USE_BUILD_FROM_SOURCE"), true);
  assert.equal(readme.includes(sourceUrl), true);
  assert.equal(readme.includes(sourceSha), true);
  assert.equal(readme.includes("CODEX_X11_COMPUTER_USE_BUILD_FROM_SOURCE=1"), true);
  assert.equal(fs.existsSync(overlayPatch), true);
  assert.match(fs.readFileSync(overlayPatch, "utf8"), /xdotool-type-literal-newline/);
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
  assert.equal(fs.existsSync(path.join(pluginDir, "bin/codex-computer-use-x11-launcher")), true);
  assert.match(fs.readFileSync(path.join(pluginDir, ".mcp.json"), "utf8"), /codex-computer-use-x11-launcher/);
});

test("x11-ewmh-computer-use applies the source overlay before building from source", () => {
  const workspace = tempDir("x11-ewmh-source-overlay");
  const sourceDir = path.join(workspace, "source");
  const binDir = path.join(workspace, "bin");
  const installDir = path.join(workspace, "install");
  const targetBinary = path.join(sourceDir, "target/release/codex-computer-use-x11");
  fs.mkdirSync(path.join(sourceDir, "src"), { recursive: true });
  fs.mkdirSync(path.join(sourceDir, "tests"), { recursive: true });
  fs.mkdirSync(binDir, { recursive: true });
  fs.writeFileSync(path.join(sourceDir, "Cargo.toml"), "[package]\nname = \"codex-computer-use-x11\"\nversion = \"0.1.3\"\n");
  fs.writeFileSync(path.join(sourceDir, "src/input.rs"), fakeSourceInputRs());
  fs.writeFileSync(path.join(sourceDir, "tests/targeted_input_cli.rs"), fakeSourceTargetedInputTestRs());
  fs.writeFileSync(path.join(binDir, "cargo"), `#!/bin/sh\nset -eu\nrepo=\"$PWD\"\ngrep -q 'xdotool-type-literal-newline' \"$repo/src/input.rs\"\ngrep -q 'targeted_press_key_return_uses_literal_newline_for_terminal_windows' \"$repo/tests/targeted_input_cli.rs\"\nmkdir -p \"$repo/target/release\"\ncat > \"$repo/target/release/codex-computer-use-x11\" <<'SH'\n#!/bin/sh\nexit 0\nSH\nchmod 0755 \"$repo/target/release/codex-computer-use-x11\"\n`);
  fs.chmodSync(path.join(binDir, "cargo"), 0o755);

  execFileSync("bash", [path.join(featureDir, "stage.sh")], {
    cwd: workspace,
    env: {
      ...process.env,
      PATH: `${binDir}:${process.env.PATH || ""}`,
      SCRIPT_DIR: upstreamRepoRoot(),
      INSTALL_DIR: installDir,
      WORK_DIR: path.join(workspace, "work"),
      ARCH: "x86_64",
      CODEX_UPSTREAM_APP_DIR: path.join(workspace, "Codex.app"),
      CODEX_X11_COMPUTER_USE_SOURCE: sourceDir,
    },
    stdio: "pipe",
  });

  assert.equal(fs.existsSync(path.join(installDir, "resources/plugins/openai-bundled/plugins/codex-computer-use-x11/bin/codex-computer-use-x11")), true);
  assert.equal(fs.existsSync(targetBinary), false, "overlay build should use a copied work tree, not mutate the original source checkout");
});

test("x11-ewmh-computer-use source tarball mode accepts pax headers and applies the overlay", () => {
  const workspace = tempDir("x11-ewmh-source-tarball");
  const binDir = path.join(workspace, "bin");
  const installDir = path.join(workspace, "install");
  const tarball = path.join(workspace, "source.tar.gz");
  const archiveRoot = path.join(workspace, "archive-root");
  const sourceRoot = path.join(archiveRoot, "codex-computer-use-x11-0.1.3");
  fs.mkdirSync(binDir, { recursive: true });
  fs.mkdirSync(path.join(sourceRoot, "src"), { recursive: true });
  fs.mkdirSync(path.join(sourceRoot, "tests"), { recursive: true });
  fs.writeFileSync(path.join(sourceRoot, "Cargo.toml"), "[package]\nname = \"codex-computer-use-x11\"\nversion = \"0.1.3\"\n");
  fs.writeFileSync(path.join(sourceRoot, "src/input.rs"), fakeSourceInputRs());
  fs.writeFileSync(path.join(sourceRoot, "tests/targeted_input_cli.rs"), fakeSourceTargetedInputTestRs());
  execFileSync("tar", ["--format=pax", "-czf", tarball, "-C", archiveRoot, "codex-computer-use-x11-0.1.3"]);
  fs.writeFileSync(path.join(binDir, "cargo"), `#!/bin/sh\nset -eu\nrepo=\"$PWD\"\ngrep -q 'xdotool-type-literal-newline' \"$repo/src/input.rs\"\ngrep -q 'targeted_press_key_return_uses_literal_newline_for_terminal_windows' \"$repo/tests/targeted_input_cli.rs\"\nmkdir -p \"$repo/target/release\"\ncat > \"$repo/target/release/codex-computer-use-x11\" <<'SH'\n#!/bin/sh\nexit 0\nSH\nchmod 0755 \"$repo/target/release/codex-computer-use-x11\"\n`);
  fs.chmodSync(path.join(binDir, "cargo"), 0o755);

  execFileSync("bash", [path.join(featureDir, "stage.sh")], {
    cwd: workspace,
    env: {
      ...process.env,
      PATH: `${binDir}:${process.env.PATH || ""}`,
      SCRIPT_DIR: upstreamRepoRoot(),
      INSTALL_DIR: installDir,
      WORK_DIR: path.join(workspace, "work"),
      ARCH: "x86_64",
      CODEX_UPSTREAM_APP_DIR: path.join(workspace, "Codex.app"),
      CODEX_X11_COMPUTER_USE_BUILD_FROM_SOURCE: "1",
      CODEX_X11_COMPUTER_USE_SOURCE_TARBALL: tarball,
      CODEX_X11_COMPUTER_USE_SOURCE_SHA256: sha256(tarball),
    },
    stdio: "pipe",
  });

  assert.equal(fs.existsSync(path.join(installDir, "resources/plugins/openai-bundled/plugins/codex-computer-use-x11/bin/codex-computer-use-x11")), true);
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
  assert.equal(fs.existsSync(path.join(pluginDir, "bin/codex-computer-use-x11-launcher")), true);
  assert.equal(fs.statSync(path.join(pluginDir, "bin/codex-computer-use-x11")).mode & 0o111 ? true : false, true);
  assert.equal(fs.statSync(path.join(pluginDir, "bin/codex-computer-use-x11-launcher")).mode & 0o111 ? true : false, true);
  const launcher = fs.readFileSync(path.join(pluginDir, "bin/codex-computer-use-x11-launcher"), "utf8");
  assert.match(launcher, /unset NO_AT_BRIDGE/);
  assert.match(fs.readFileSync(path.join(pluginDir, ".mcp.json"), "utf8"), /codex-computer-use-x11-launcher/);
  assert.equal(fs.readFileSync(computerUseMarker, "utf8"), beforeComputerUse);

  const parsedMarketplace = JSON.parse(fs.readFileSync(marketplace, "utf8"));
  assert.equal(parsedMarketplace.plugins.some((plugin) => plugin.name === "codex-computer-use-x11" && plugin.source?.path === "./plugins/codex-computer-use-x11" && plugin.policy?.authentication === "ON_INSTALL"), true);
  assert.equal(parsedMarketplace.plugins.some((plugin) => plugin.name === "computer-use"), true);
});
