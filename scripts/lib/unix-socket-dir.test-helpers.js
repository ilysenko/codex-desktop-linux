"use strict";

// Directories for tests that bind or connect to Unix sockets.
//
// A socket path must fit sun_path, 108 bytes with the terminating NUL. Under a
// long TMPDIR a fixture then fails with EINVAL or "path too long", which reads
// like a product bug. makeSocketTempDir picks the place instead: the temp dir
// when the longest socket path fits, else XDG_RUNTIME_DIR, else it throws with
// the limit and the path. Standalone computer-use-linux's test_sockets.rs and
// socket_fixture.py follow the same rule.

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

// sun_path holds 108 bytes, including the terminating NUL.
const SOCKET_PATH_MAX = 107;
// dbus-daemon refuses a listen path longer than this.
const DBUS_SOCKET_PATH_MAX = 99;
// fs.mkdtempSync appends six characters to the prefix.
const MKDTEMP_SUFFIX = "XXXXXX";

function isDirectory(dir) {
  return fs.statSync(dir, { throwIfNoEntry: false })?.isDirectory() === true;
}

// The base directory for a fixture `prefix` + six characters whose longest
// socket path is `deepest` below it. Nothing is created.
function socketDirBase({
  prefix,
  deepest,
  limit = SOCKET_PATH_MAX,
  tempDir = os.tmpdir(),
  runtimeDir = process.env.XDG_RUNTIME_DIR,
  directoryExists = isDirectory,
}) {
  const overflow = (base) => {
    const longest = path.join(base, `${prefix}${MKDTEMP_SUFFIX}`, deepest);
    const length = Buffer.byteLength(longest);
    return length > limit ? `${longest} is ${length} bytes, over the ${limit}-byte limit` : null;
  };
  const first = overflow(tempDir);
  if (first === null) return tempDir;
  let fallback;
  if (!runtimeDir) {
    fallback = "XDG_RUNTIME_DIR is unset";
  } else if (!path.isAbsolute(runtimeDir) || !directoryExists(runtimeDir)) {
    fallback = `XDG_RUNTIME_DIR (${runtimeDir}) is not an absolute directory`;
  } else {
    const second = overflow(runtimeDir);
    if (second === null) return runtimeDir;
    fallback = `under XDG_RUNTIME_DIR, ${second}`;
  }
  throw new Error(
    `No usable Unix socket path: ${first}; ${fallback}. Set TMPDIR or XDG_RUNTIME_DIR to a path that fits.`,
  );
}

// A new private directory `prefix` + six characters where `deepest`, a path
// relative to it, fits as a Unix socket path of at most `limit` bytes. A test
// that removes XDG_RUNTIME_DIR from its environment passes the host's value.
function makeSocketTempDir(prefix, deepest, { limit = SOCKET_PATH_MAX, runtimeDir } = {}) {
  return fs.mkdtempSync(path.join(socketDirBase({ prefix, deepest, limit, runtimeDir }), prefix));
}

module.exports = { DBUS_SOCKET_PATH_MAX, SOCKET_PATH_MAX, makeSocketTempDir, socketDirBase };
