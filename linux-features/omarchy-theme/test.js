#!/usr/bin/env node
"use strict";

const assert = require("node:assert/strict");
const { spawnSync } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const vm = require("node:vm");

const {
  enabledLinuxFeatureIds,
  enabledLinuxFeatureInstallPlan,
  loadLinuxFeaturePatchDescriptors,
} = require("../../scripts/lib/linux-features.js");
const {
  RUNTIME_VERSION,
  STYLE_LINK_ID,
  THEME_CSS_ENV,
  INDEX_ENTRY_NEEDLES,
  applyOmarchyThemeLoader,
  isWebviewIndexEntry,
  omarchyThemeRuntimeSource,
} = require("./patch.js");

// Shape of the rspack runtime entry chunks referenced by webview/index.html
// and webview/detached-window.html in the signed 26.1029.61003 package.
const INDEX_ENTRY_FIXTURE =
  'var e,a,c,p={Gav4(e,a,c){let f="codex-host-chunked-message-v1"},' +
  'R2r9(e,a,c){c.a(e,async function(e,a){try{c("TL6G"),a()}catch(e){a(e)}},1)}};' +
  'var O=p.O(void 0,["782259","727403","158624"],()=>p("R2r9"));p.O(O);export{v as __webpack_require__};\n' +
  "//# sourceMappingURL=348410.09aab3f377.js.map";
const DETACHED_ENTRY_FIXTURE = INDEX_ENTRY_FIXTURE.replace(
  'c("TL6G"),a()',
  'let{initializeDetachedWindow:e}=await c.e(770265).then(c.bind(c,"b9YD"));await e(),a()',
);

const FEATURE_DIR = __dirname;

function commandPath(name) {
  for (const directory of (process.env.PATH || "").split(path.delimiter)) {
    if (!directory || !path.isAbsolute(directory)) continue;
    const candidate = path.join(directory, name);
    try {
      fs.accessSync(candidate, fs.constants.X_OK);
      if (!fs.statSync(candidate).isFile()) continue;
      return candidate;
    } catch {}
  }
  throw new Error(`could not resolve executable from PATH: ${name}`);
}

const BASH = commandPath("bash");

function withFeatureConfig(enabled, fn) {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "codex-omarchy-theme-config-"));
  const originalConfig = process.env.CODEX_LINUX_FEATURES_CONFIG;
  const configPath = path.join(tempDir, "features.json");
  fs.writeFileSync(configPath, `${JSON.stringify({ enabled }, null, 2)}\n`);
  process.env.CODEX_LINUX_FEATURES_CONFIG = configPath;
  try {
    return fn(path.resolve(FEATURE_DIR, ".."));
  } finally {
    if (originalConfig == null) {
      delete process.env.CODEX_LINUX_FEATURES_CONFIG;
    } else {
      process.env.CODEX_LINUX_FEATURES_CONFIG = originalConfig;
    }
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
}

test("omarchy-theme stays disabled until selected", () => {
  withFeatureConfig([], (featuresRoot) => {
    assert.deepEqual(enabledLinuxFeatureIds({ featuresRoot }), []);
    assert.deepEqual(loadLinuxFeaturePatchDescriptors({ featuresRoot }), []);
  });
});

test("omarchy-theme exposes optional patches, resources, and hooks when enabled", () => {
  withFeatureConfig(["omarchy-theme"], (featuresRoot) => {
    assert.deepEqual(enabledLinuxFeatureIds({ featuresRoot }), ["omarchy-theme"]);

    const descriptors = loadLinuxFeaturePatchDescriptors({ featuresRoot });
    assert.equal(descriptors.length, 1);
    assert.equal(descriptors[0].id, "feature:omarchy-theme:omarchy-theme-css-loader");
    assert.equal(descriptors[0].ciPolicy, "optional");
    assert.equal(descriptors[0].pattern, undefined);
    assert.deepEqual(descriptors[0].assetNeedles, INDEX_ENTRY_NEEDLES);
    assert.equal(descriptors[0].assetMatch(INDEX_ENTRY_FIXTURE, "348410.09aab3f377.js"), true);
    assert.equal(descriptors[0].assetMatch(DETACHED_ENTRY_FIXTURE, "357055.8ef98feffe.js"), false);
    assert.equal(descriptors[0].assetMatch(INDEX_ENTRY_FIXTURE, "async/202543.e3d6d1466d.js"), false);

    const plan = enabledLinuxFeatureInstallPlan({ featuresRoot });
    assert.deepEqual(
      plan.resources.map((resource) => [resource.id, resource.target, resource.mode]),
      [[
        "omarchy-theme",
        ".codex-linux/features/omarchy-theme/codex-desktop.css.tpl",
        0o644,
      ]],
    );
    assert.deepEqual(
      plan.runtimeHooks.map((hook) => [hook.id, hook.key, hook.target, hook.mode]),
      [
        [
          "omarchy-theme",
          "prelaunch",
          ".codex-linux/prelaunch.d/omarchy-theme-install-template.sh",
          0o755,
        ],
        [
          "omarchy-theme",
          "launcher",
          ".codex-linux/launcher.d/omarchy-theme-stylesheet-env.sh",
          0o755,
        ],
      ],
    );
  });
});

test("renderer patch targets only the index entry chunk", () => {
  assert.equal(isWebviewIndexEntry(INDEX_ENTRY_FIXTURE), true);
  const warnings = [];
  const originalWarn = console.warn;
  console.warn = (message) => warnings.push(message);
  try {
    for (const source of [DETACHED_ENTRY_FIXTURE, "console.log('codex');"]) {
      assert.equal(applyOmarchyThemeLoader(source), source);
    }
  } finally {
    console.warn = originalWarn;
  }
  assert.equal(warnings.length, 2);
});

test("renderer patch is idempotent and installs one guarded runtime", () => {
  const source = INDEX_ENTRY_FIXTURE;
  const patched = applyOmarchyThemeLoader(source);
  assert.notEqual(patched, source);
  assert.equal(applyOmarchyThemeLoader(patched), patched);
  assert.match(patched, new RegExp(RUNTIME_VERSION));
  assert.match(patched, new RegExp(STYLE_LINK_ID));
  assert.match(patched, new RegExp(THEME_CSS_ENV));

  const links = new Map();
  const windowListeners = new Map();
  const documentListeners = new Map();
  let intervalCount = 0;
  let clearIntervalCount = 0;
  let appendCount = 0;
  const sandbox = {
    Date: { now: () => 1234 },
    process: { env: { [THEME_CSS_ENV]: "file:///tmp/theme.css" } },
    document: {
      readyState: "complete",
      hidden: false,
      head: {
        appendChild(link) {
          appendCount += 1;
          links.set(link.id, link);
        },
      },
      documentElement: null,
      getElementById(id) {
        return links.get(id) ?? null;
      },
      createElement(tag) {
        return { tag };
      },
      addEventListener(name, listener) {
        documentListeners.set(name, listener);
      },
      removeEventListener(name, listener) {
        if (documentListeners.get(name) === listener) documentListeners.delete(name);
      },
    },
    window: {
      addEventListener(name, listener) {
        windowListeners.set(name, listener);
      },
      removeEventListener(name, listener) {
        if (windowListeners.get(name) === listener) windowListeners.delete(name);
      },
    },
    setInterval() {
      intervalCount += 1;
      return 7;
    },
    clearInterval() {
      clearIntervalCount += 1;
    },
  };

  vm.createContext(sandbox);
  vm.runInContext(omarchyThemeRuntimeSource(), sandbox);
  vm.runInContext(omarchyThemeRuntimeSource(), sandbox);

  assert.equal(appendCount, 1);
  assert.equal(intervalCount, 1);
  assert.equal(windowListeners.size, 1);
  assert.equal(documentListeners.size, 1);
  assert.equal(links.get(STYLE_LINK_ID).href, "file:///tmp/theme.css?t=1234");

  sandbox.codexLinuxOmarchyThemeCleanup();
  assert.equal(clearIntervalCount, 1);
  assert.equal(windowListeners.size, 0);
  assert.equal(documentListeners.size, 0);
});

test("launcher hook publishes the generated stylesheet as a file URI", () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "codex-omarchy-theme-uri-"));
  try {
    const stylesheet = path.join(tempDir, "theme.css");
    const result = spawnSync(BASH, [path.join(FEATURE_DIR, "stylesheet-env.sh")], {
      env: { ...process.env, CODEX_LINUX_OMARCHY_STYLESHEET: stylesheet },
      encoding: "utf8",
    });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stdout.trim(), `env ${THEME_CSS_ENV}=${new URL(`file://${stylesheet}`).href}`);
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test("prelaunch hook installs the template, refreshes missing CSS, and preserves local edits", () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "codex-omarchy-template-install-"));
  try {
    const home = path.join(tempDir, "home");
    const featuresDir = path.join(tempDir, "features");
    const stagedDir = path.join(featuresDir, "omarchy-theme");
    const omarchyHome = path.join(home, ".config", "omarchy");
    const target = path.join(omarchyHome, "themed", "codex-desktop.css.tpl");
    const generated = path.join(omarchyHome, "current", "theme", "codex-desktop.css");
    const binDir = path.join(tempDir, "bin");
    const callLog = path.join(tempDir, "omarchy.log");
    fs.mkdirSync(stagedDir, { recursive: true });
    fs.mkdirSync(binDir, { recursive: true });
    fs.copyFileSync(path.join(FEATURE_DIR, "codex-desktop.css.tpl"), path.join(stagedDir, "codex-desktop.css.tpl"));
    const fakeOmarchy = path.join(binDir, "omarchy");
    fs.writeFileSync(
      fakeOmarchy,
      `#!${BASH}\nset -e\nprintf '%s\\n' "$*" >> "$OMARCHY_TEST_LOG"\nmkdir -p "$HOME/.config/omarchy/current/theme"\nprintf 'generated' > "$HOME/.config/omarchy/current/theme/codex-desktop.css"\n`,
    );
    fs.chmodSync(fakeOmarchy, 0o755);

    const env = {
      ...process.env,
      HOME: home,
      PATH: `${binDir}${path.delimiter}${process.env.PATH || ""}`,
      CODEX_LINUX_FEATURES_DIR: featuresDir,
      OMARCHY_TEST_LOG: callLog,
    };
    const first = spawnSync(BASH, [path.join(FEATURE_DIR, "install-template.sh")], {
      env,
      encoding: "utf8",
    });
    assert.equal(first.status, 0, first.stderr);
    assert.equal(fs.readFileSync(target, "utf8"), fs.readFileSync(path.join(FEATURE_DIR, "codex-desktop.css.tpl"), "utf8"));
    assert.equal(fs.readFileSync(generated, "utf8"), "generated");
    assert.equal(fs.readFileSync(callLog, "utf8"), "theme refresh\n");

    fs.writeFileSync(target, "/* local customization */\n");
    fs.rmSync(generated);
    const second = spawnSync(BASH, [path.join(FEATURE_DIR, "install-template.sh")], {
      env,
      encoding: "utf8",
    });
    assert.equal(second.status, 0, second.stderr);
    assert.equal(fs.readFileSync(target, "utf8"), "/* local customization */\n");
    assert.equal(fs.readFileSync(generated, "utf8"), "generated");
    assert.equal(fs.readFileSync(callLog, "utf8"), "theme refresh\ntheme refresh\n");
    assert.match(second.stderr, /leaving it untouched/);

    fs.rmSync(generated);
    fs.writeFileSync(
      fakeOmarchy,
      `#!${BASH}\nsleep 30\n`,
    );
    const startedAt = Date.now();
    const hanging = spawnSync(BASH, [path.join(FEATURE_DIR, "install-template.sh")], {
      env: {
        ...env,
        CODEX_OMARCHY_THEME_REFRESH_TIMEOUT_SECONDS: "1",
      },
      encoding: "utf8",
    });
    assert.equal(hanging.status, 0, hanging.stderr);
    assert.ok(Date.now() - startedAt < 5000, "prelaunch hook must not wait for a hung refresh");
    assert.match(hanging.stderr, /timed out or failed/);
    assert.equal(fs.existsSync(generated), false);

    const timeoutLog = path.join(tempDir, "timeout.log");
    fs.writeFileSync(
      path.join(binDir, "timeout"),
      `#!${BASH}\nprintf '%s\\n' "$*" > "$OMARCHY_TEST_TIMEOUT_LOG"\nexit 124\n`,
    );
    fs.chmodSync(path.join(binDir, "timeout"), 0o755);
    const oversizedTimeout = spawnSync(BASH, [path.join(FEATURE_DIR, "install-template.sh")], {
      env: {
        ...env,
        CODEX_OMARCHY_THEME_REFRESH_TIMEOUT_SECONDS: "999999999999999999999",
        OMARCHY_TEST_TIMEOUT_LOG: timeoutLog,
      },
      encoding: "utf8",
    });
    assert.equal(oversizedTimeout.status, 0, oversizedTimeout.stderr);
    assert.match(oversizedTimeout.stderr, /whole number between 1 and 60 seconds/);
    assert.equal(fs.readFileSync(timeoutLog, "utf8"), "--kill-after=2s 15s omarchy theme refresh\n");
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});
