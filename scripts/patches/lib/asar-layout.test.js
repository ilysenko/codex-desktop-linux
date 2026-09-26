"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const {
  deriveUpstreamLayout,
  parsePackState,
  verifyRepackedLayout,
} = require("./asar-layout.js");

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "asar-layout-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  for (const relative of [
    "app/main.js",
    "native/addon.node",
    "vendor/runtime/README.md",
    "vendor/runtime/runtime.node",
  ]) {
    const target = path.join(root, relative);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, relative);
  }
  return root;
}

const PACK_STATE = [
  "pack   : /app",
  "pack   : /app/main.js",
  "pack   : /native",
  "unpack : /native/addon.node",
  "pack   : /vendor",
  "unpack : /vendor/runtime",
  "unpack : /vendor/runtime/README.md",
  "unpack : /vendor/runtime/runtime.node",
  "",
].join("\n");

test("derives original ordering and maximal unpack directories", (t) => {
  const layout = deriveUpstreamLayout(PACK_STATE, fixture(t));
  assert.deepEqual(layout.ordering, [
    "app",
    "app/main.js",
    "native",
    "native/addon.node",
    "vendor",
    "vendor/runtime",
    "vendor/runtime/README.md",
    "vendor/runtime/runtime.node",
  ]);
  assert.deepEqual(layout.unpackDirectories, ["vendor/runtime"]);
  assert.equal(layout.unpackDirectoryPattern, "vendor/runtime");
});

test("combines multiple safe unpack roots without release-specific paths", (t) => {
  const root = fixture(t);
  fs.mkdirSync(path.join(root, "other/runtime"), { recursive: true });
  const source = PACK_STATE + "unpack : /other/runtime\n";
  const layout = deriveUpstreamLayout(source, root);
  assert.equal(layout.unpackDirectoryPattern, "{vendor/runtime,other/runtime}");
});

test("fails closed for layouts the native glob cannot preserve", (t) => {
  const root = fixture(t);
  assert.throws(
    () => deriveUpstreamLayout(PACK_STATE.replace("pack   : /app/main.js", "unpack : /app/main.js"), root),
    /Cannot preserve non-native upstream unpack files: app\/main\.js/,
  );
  assert.throws(
    () => deriveUpstreamLayout(PACK_STATE.replace("unpack : /native/addon.node", "pack   : /native/addon.node"), root),
    /Cannot preserve packed native upstream files.*native\/addon\.node/,
  );
  fs.mkdirSync(path.join(root, "vendor/{runtime}"));
  assert.throws(
    () => deriveUpstreamLayout(PACK_STATE.replace("vendor/runtime", "vendor/{runtime}"), root),
    /Cannot safely preserve upstream unpack directory: vendor\/\{runtime\}/,
  );
});

test("rejects malformed, traversal, empty, and incomplete layouts", (t) => {
  const root = fixture(t);
  assert.throws(() => parsePackState(""), /layout is empty/);
  assert.throws(() => parsePackState("packed : /app"), /Invalid app\.asar layout entry/);
  assert.throws(() => parsePackState("pack   : /../app"), /Invalid app\.asar layout entry/);
  assert.throws(
    () => deriveUpstreamLayout("pack   : /missing.js\n", root),
    /missing after extraction: missing\.js/,
  );
});

test("allows feature entries while preserving the official layout as an exact subsequence", () => {
  const output = PACK_STATE.replace(
    "pack   : /native\n",
    [
      "pack   : /feature-package",
      "unpack : /feature-package/addon.node",
      "pack   : /native",
      "",
    ].join("\n"),
  );
  assert.doesNotThrow(() => verifyRepackedLayout(PACK_STATE, output));
});

test("repacked layout verification fails closed for official layout drift", () => {
  assert.throws(
    () => verifyRepackedLayout(
      PACK_STATE,
      PACK_STATE.replace("unpack : /native/addon.node", "pack   : /native/addon.node"),
    ),
    /changed official unpack metadata: native\/addon\.node/,
  );
  assert.throws(
    () => verifyRepackedLayout(
      PACK_STATE,
      PACK_STATE.replace(
        "pack   : /app\npack   : /app/main.js",
        "pack   : /app/main.js\npack   : /app",
      ),
    ),
    /changed official entry ordering: app\/main\.js/,
  );
  assert.throws(
    () => verifyRepackedLayout(
      PACK_STATE,
      PACK_STATE.replace("unpack : /vendor/runtime/runtime.node\n", ""),
    ),
    /missing official layout entry: vendor\/runtime\/runtime\.node/,
  );
  assert.throws(
    () => verifyRepackedLayout(PACK_STATE, PACK_STATE + "pack   : /app\n"),
    /Repacked app\.asar layout contains a duplicate entry: app/,
  );
});
