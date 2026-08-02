#!/usr/bin/env node
"use strict";

const fs = require("node:fs");
const path = require("node:path");

const DESCRIPTOR_SCHEMA_VERSION = 1;
const DESCRIPTOR_KEYS = ["schemaVersion", "socketPath", "transport"];
const BIGINT_STATS = { bigint: true };

function descriptorError(reason) {
  return new Error(`app-server attachment descriptor ${reason}`);
}

function sameMetadata(left, right) {
  return (
    left.dev === right.dev &&
    left.ino === right.ino &&
    left.uid === right.uid &&
    (left.mode & 0o7777n) === (right.mode & 0o7777n) &&
    left.size === right.size &&
    left.mtimeNs === right.mtimeNs &&
    left.ctimeNs === right.ctimeNs
  );
}

function normalizeExpectedUid(expectedUid) {
  if (typeof expectedUid === "bigint") return expectedUid;
  if (Number.isInteger(expectedUid) && expectedUid >= 0) return BigInt(expectedUid);
  throw descriptorError("requires a valid expected owner");
}

function assertSafeParent(stat, expectedUid) {
  if (!stat.isDirectory()) throw descriptorError("parent is not a real directory");
  if (stat.uid !== expectedUid) throw descriptorError("parent has an unexpected owner");
  if ((stat.mode & 0o022n) !== 0n) throw descriptorError("parent is writable by group or other");
}

function assertSafeDescriptor(stat, expectedUid) {
  if (!stat.isFile()) throw descriptorError("is not a regular file");
  if (stat.uid !== expectedUid) throw descriptorError("has an unexpected owner");
  if ((stat.mode & 0o7777n) !== 0o600n) throw descriptorError("must have mode 0600");
}

function assertSameMetadata(before, after, label) {
  if (!sameMetadata(before, after)) {
    throw descriptorError(`${label} changed while it was being read`);
  }
}

function parseDescriptor(source) {
  let descriptor;
  try {
    descriptor = JSON.parse(source);
  } catch {
    throw descriptorError("contains invalid JSON");
  }
  if (descriptor == null || typeof descriptor !== "object" || Array.isArray(descriptor)) {
    throw descriptorError("must be an object");
  }
  const keys = Object.keys(descriptor).sort();
  if (keys.length !== DESCRIPTOR_KEYS.length || keys.some((key, index) => key !== DESCRIPTOR_KEYS[index])) {
    throw descriptorError("has an unsupported schema");
  }
  if (!Number.isInteger(descriptor.schemaVersion) || descriptor.schemaVersion !== DESCRIPTOR_SCHEMA_VERSION) {
    throw descriptorError("has an unsupported schema version");
  }
  if (descriptor.transport !== "unix") throw descriptorError("has an unsupported transport");
  if (typeof descriptor.socketPath !== "string" || descriptor.socketPath.length === 0) {
    throw descriptorError("has an invalid socket path");
  }
  if (
    !path.isAbsolute(descriptor.socketPath) ||
    path.normalize(descriptor.socketPath) !== descriptor.socketPath ||
    /[\0-\x1f]/.test(descriptor.socketPath)
  ) {
    throw descriptorError("has an invalid socket path");
  }
  return { socketPath: descriptor.socketPath };
}

function readAttachmentDescriptor(descriptorPath, expectedUid = process.getuid()) {
  let descriptorBefore;
  try {
    descriptorBefore = fs.lstatSync(descriptorPath, BIGINT_STATS);
  } catch (error) {
    if (error?.code === "ENOENT") return null;
    throw descriptorError("could not be inspected safely");
  }

  let parentFd = null;
  let descriptorFd = null;
  try {
    const expectedOwner = normalizeExpectedUid(expectedUid);
    const parentPath = path.dirname(descriptorPath);
    const parentBefore = fs.lstatSync(parentPath, BIGINT_STATS);
    assertSafeParent(parentBefore, expectedOwner);
    assertSafeDescriptor(descriptorBefore, expectedOwner);

    parentFd = fs.openSync(
      parentPath,
      fs.constants.O_RDONLY | fs.constants.O_DIRECTORY | fs.constants.O_NOFOLLOW,
    );
    const parentOpened = fs.fstatSync(parentFd, BIGINT_STATS);
    assertSameMetadata(parentBefore, parentOpened, "parent");
    assertSafeParent(parentOpened, expectedOwner);

    descriptorFd = fs.openSync(
      descriptorPath,
      fs.constants.O_RDONLY | fs.constants.O_NONBLOCK | fs.constants.O_NOFOLLOW,
    );
    const descriptorOpened = fs.fstatSync(descriptorFd, BIGINT_STATS);
    assertSameMetadata(descriptorBefore, descriptorOpened, "file");
    assertSafeDescriptor(descriptorOpened, expectedOwner);

    const source = fs.readFileSync(descriptorFd, "utf8");
    const descriptorRead = fs.fstatSync(descriptorFd, BIGINT_STATS);
    const descriptorAfter = fs.lstatSync(descriptorPath, BIGINT_STATS);
    const parentAfter = fs.lstatSync(parentPath, BIGINT_STATS);
    assertSameMetadata(descriptorOpened, descriptorRead, "file");
    assertSameMetadata(descriptorRead, descriptorAfter, "file");
    assertSameMetadata(descriptorBefore, descriptorAfter, "file");
    assertSameMetadata(parentBefore, parentAfter, "parent");
    assertSafeParent(parentAfter, expectedOwner);
    assertSafeDescriptor(descriptorRead, expectedOwner);
    assertSafeDescriptor(descriptorAfter, expectedOwner);
    return parseDescriptor(source);
  } catch (error) {
    if (error?.message?.startsWith("app-server attachment descriptor ")) throw error;
    throw descriptorError("could not be read safely");
  } finally {
    if (descriptorFd != null) {
      try {
        fs.closeSync(descriptorFd);
      } catch {
        // The descriptor was used only for this completed read.
      }
    }
    if (parentFd != null) {
      try {
        fs.closeSync(parentFd);
      } catch {
        // The descriptor was used only for this completed read.
      }
    }
  }
}

function routingRecords(descriptor) {
  return [
    "env CODEX_LINUX_APP_SERVER_BRIDGE_ATTACH_ONLY=1",
    `env CODEX_LINUX_APP_SERVER_BRIDGE_SOCKET=${descriptor.socketPath}`,
  ];
}

function main() {
  try {
    if (process.argv.length !== 3) throw descriptorError("path is required");
    const descriptor = readAttachmentDescriptor(process.argv[2]);
    if (descriptor != null) process.stdout.write(`${routingRecords(descriptor).join("\n")}\n`);
  } catch (error) {
    const detail = error?.message?.startsWith("app-server attachment descriptor ")
      ? error.message
      : "app-server attachment descriptor could not be read safely";
    process.stderr.write(`ERROR: ${detail}.\n`);
    process.exitCode = 1;
  }
}

if (require.main === module) main();

module.exports = {
  readAttachmentDescriptor,
  routingRecords,
};
