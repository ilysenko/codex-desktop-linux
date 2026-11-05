"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const { makeSocketTempDir, socketDirBase } = require("./unix-socket-dir.test-helpers.js");

test("a socket fixture moves from a long temp dir to XDG_RUNTIME_DIR or names the limit", () => {
  const exists = () => true;
  // 90 bytes: "/" + 89. With "f-XXXXXX/a.sock" the socket path is 106 bytes.
  const long = `/${"t".repeat(89)}`;
  const place = (options) => socketDirBase({ prefix: "f-", deepest: "a.sock", directoryExists: exists, ...options });

  assert.equal(place({ tempDir: long, runtimeDir: "/run/user/1" }), long);
  assert.equal(place({ tempDir: long, runtimeDir: "/run/user/1", limit: 100 }), "/run/user/1");

  assert.throws(
    // An empty XDG_RUNTIME_DIR counts as unset.
    () => place({ tempDir: long, runtimeDir: "", limit: 100 }),
    (error) => error.message.includes(`${long}/f-XXXXXX/a.sock is 106 bytes, over the 100-byte limit;`) &&
      error.message.includes("XDG_RUNTIME_DIR is unset"),
  );
  assert.throws(
    () => place({ tempDir: long, runtimeDir: "run", limit: 100 }),
    /XDG_RUNTIME_DIR \(run\) is not an absolute directory/,
  );
  assert.throws(
    () => place({ tempDir: long, runtimeDir: "/run/user/1", directoryExists: () => false, limit: 100 }),
    /XDG_RUNTIME_DIR \(\/run\/user\/1\) is not an absolute directory/,
  );
  assert.throws(
    () => place({ tempDir: long, runtimeDir: long, limit: 100 }),
    /under XDG_RUNTIME_DIR, \/t+\/f-XXXXXX\/a\.sock is 106 bytes/,
  );
});

test("makeSocketTempDir creates the fixture where the socket fits", (t) => {
  const dir = makeSocketTempDir("socket-dir-test-", "a.sock");
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  assert.equal(fs.statSync(dir).isDirectory(), true);
  assert.ok(Buffer.byteLength(path.join(dir, "a.sock")) <= 107);
});
