"use strict";

// Keep this function self-contained: the ASAR patch embeds it in the transport.
function readSocketPath(socketPath, fs = require("node:fs"), uid = process.getuid?.()) {
  const path = require("node:path");
  const identity = fs.lstatSync(socketPath);
  const same = (a, b) => a.dev === b.dev && a.ino === b.ino;
  const owned = (stat) => uid == null || stat.uid === uid;
  if (!owned(identity)) throw new Error("shared app-server socket has unexpected owner");
  if (identity.isSocket()) return { identity, target: identity, targetPath: socketPath };
  if (!identity.isSymbolicLink()) throw new Error("shared app-server path is not a socket");

  const targetPath = fs.readlinkSync(socketPath);
  if (!path.isAbsolute(targetPath) || path.normalize(targetPath) !== targetPath) {
    throw new Error("shared app-server socket alias is not canonical");
  }
  const parentPath = path.dirname(targetPath);
  const parent = fs.lstatSync(parentPath);
  if (!parent.isDirectory() || !owned(parent) || (parent.mode & 0o777) !== 0o700 ||
      fs.realpathSync(parentPath) !== parentPath) {
    throw new Error("shared app-server socket alias directory is unsafe");
  }
  let target = null;
  try {
    target = fs.lstatSync(targetPath);
  } catch (error) {
    // A dead authority can leave a dangling alias. Only the alias is reclaimable.
    if (error.code !== "ENOENT") throw error;
  }
  if (target && (!target.isSocket() || !owned(target) || (target.mode & 0o777) !== 0o600)) {
    throw new Error("shared app-server socket alias target is unsafe");
  }
  if (!same(identity, fs.lstatSync(socketPath)) || fs.readlinkSync(socketPath) !== targetPath ||
      !same(parent, fs.lstatSync(parentPath))) {
    throw new Error("shared app-server socket alias changed during verification");
  }
  return { identity, target, targetPath, parent };
}

module.exports = { readSocketPath };
