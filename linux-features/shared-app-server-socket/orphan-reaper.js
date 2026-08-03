#!/usr/bin/env node
"use strict";

const fs = require("node:fs");

const socketPath = process.argv[2];
if (!socketPath) {
  throw new Error("shared app-server orphan cleanup requires a socket path");
}

const lockPath = `${socketPath}.lock`;
const expectedUid = typeof process.getuid === "function" ? process.getuid() : null;

function sameIdentity(left, right) {
  return left != null && right.dev === left.dev && right.ino === left.ino;
}

function readProcess(pid) {
  try {
    const procPath = `/proc/${pid}`;
    const procStat = fs.statSync(procPath);
    const rawStat = fs.readFileSync(`${procPath}/stat`, "utf8");
    const commandEnd = rawStat.lastIndexOf(")");
    if (commandEnd < 0) return null;
    const fields = rawStat.slice(commandEnd + 2).trim().split(/\s+/);
    const commandLine = fs
      .readFileSync(`${procPath}/cmdline`)
      .toString("utf8")
      .split("\0")
      .filter(Boolean);
    return {
      pid,
      uid: procStat.uid,
      state: fields[0],
      ppid: Number(fields[1]),
      startTime: fields[19] ?? null,
      commandLine,
    };
  } catch (error) {
    if (error?.code === "ENOENT" || error?.code === "ESRCH") return null;
    throw error;
  }
}

function isRunning(processInfo) {
  if (processInfo == null || processInfo.state === "Z") return false;
  const current = readProcess(processInfo.pid);
  return current?.state !== "Z" && current?.startTime === processInfo.startTime;
}

function ownerIsDead(ownerPid, ownerStartTime) {
  const owner = readProcess(ownerPid);
  return owner == null || owner.state === "Z" || owner.startTime !== ownerStartTime;
}

function listenerInode() {
  const lines = fs.readFileSync("/proc/net/unix", "utf8").split("\n");
  for (const line of lines) {
    const match = line.match(
      /^\S+:\s+\S+\s+\S+\s+\S+\s+(\S+)\s+(\S+)\s+(\d+)(?:\s+(.*))?$/,
    );
    if (
      match != null &&
      match[1] === "0001" &&
      match[2] === "01" &&
      match[4] === socketPath
    ) {
      return match[3];
    }
  }
  return null;
}

function listenerProcesses(inode) {
  const target = `socket:[${inode}]`;
  const listeners = [];
  for (const entry of fs.readdirSync("/proc", { withFileTypes: true })) {
    if (!entry.isDirectory() || !/^\d+$/.test(entry.name)) continue;
    const pid = Number(entry.name);
    let processInfo;
    try {
      processInfo = readProcess(pid);
      if (processInfo == null || (expectedUid != null && processInfo.uid !== expectedUid)) continue;
      const fdDir = `/proc/${pid}/fd`;
      const ownsListener = fs.readdirSync(fdDir).some((fd) => {
        try {
          return fs.readlinkSync(`${fdDir}/${fd}`) === target;
        } catch (error) {
          if (error?.code === "ENOENT" || error?.code === "EACCES") return false;
          throw error;
        }
      });
      if (ownsListener) listeners.push(processInfo);
    } catch (error) {
      if (error?.code !== "ENOENT" && error?.code !== "EACCES") throw error;
    }
  }
  return listeners;
}

function isExpectedAuthority(processInfo) {
  const listenUrl = `unix://${socketPath}`;
  return processInfo.commandLine.some(
    (argument, index, commandLine) =>
      argument === "app-server" &&
      commandLine[index + 1] === "--listen" &&
      commandLine[index + 2] === listenUrl,
  );
}

function verifiedOrphanTargets(listeners) {
  const targets = new Map();
  for (const listener of listeners) {
    if (expectedUid != null && listener.uid !== expectedUid) {
      throw new Error(`listener ${listener.pid} has unexpected uid`);
    }
    if (!isExpectedAuthority(listener)) {
      throw new Error(`listener ${listener.pid} is not the expected Codex authority`);
    }
    targets.set(listener.pid, listener);
    if (listener.ppid === 1) continue;

    const parent = readProcess(listener.ppid);
    if (
      parent == null ||
      parent.ppid !== 1 ||
      parent.uid !== listener.uid ||
      !isExpectedAuthority(parent)
    ) {
      throw new Error(`listener ${listener.pid} is not a reparented Desktop authority`);
    }
    targets.set(parent.pid, parent);
  }
  return [...targets.values()];
}

function readLock() {
  let descriptor;
  try {
    descriptor = fs.openSync(lockPath, "r");
    const stat = fs.fstatSync(descriptor);
    const contents = fs.readFileSync(descriptor, "utf8");
    const owner = contents.trim().match(/^(\d+) (\S+)$/);
    if (owner == null) return null;
    return {
      identity: { dev: stat.dev, ino: stat.ino },
      contents,
      ownerPid: Number(owner[1]),
      ownerStartTime: owner[2],
    };
  } catch (error) {
    if (error?.code === "ENOENT") return null;
    throw error;
  } finally {
    if (descriptor != null) fs.closeSync(descriptor);
  }
}

function unchangedLock(snapshot) {
  try {
    const stat = fs.lstatSync(lockPath);
    return (
      sameIdentity(snapshot.identity, stat) &&
      fs.readFileSync(lockPath, "utf8") === snapshot.contents
    );
  } catch (error) {
    if (error?.code === "ENOENT") return false;
    throw error;
  }
}

function unchangedSocket(snapshot) {
  try {
    return sameIdentity(snapshot, fs.lstatSync(socketPath));
  } catch (error) {
    if (error?.code === "ENOENT") return false;
    throw error;
  }
}

function delay(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

async function reapOrphan() {
  const lock = readLock();
  if (lock == null || !ownerIsDead(lock.ownerPid, lock.ownerStartTime)) return;

  let socket;
  try {
    socket = fs.lstatSync(socketPath);
  } catch (error) {
    if (error?.code === "ENOENT") return;
    throw error;
  }
  if (!socket.isSocket()) throw new Error("shared app-server path is not a socket");
  if (expectedUid != null && socket.uid !== expectedUid) {
    throw new Error("shared app-server socket has unexpected owner");
  }

  const inode = listenerInode();
  if (inode == null) return;
  const listeners = listenerProcesses(inode);
  if (listeners.length === 0) {
    throw new Error("live shared app-server listener could not be identified");
  }
  const targets = verifiedOrphanTargets(listeners);

  if (
    !unchangedLock(lock) ||
    !ownerIsDead(lock.ownerPid, lock.ownerStartTime) ||
    !unchangedSocket(socket) ||
    listenerInode() !== inode ||
    targets.some((target) => !isRunning(target))
  ) {
    throw new Error("shared app-server ownership changed during orphan verification");
  }

  for (const target of targets) {
    try {
      process.kill(target.pid, "SIGTERM");
    } catch (error) {
      if (error?.code !== "ESRCH") throw error;
    }
  }

  const deadline = Date.now() + 3000;
  while (
    Date.now() < deadline &&
    (listenerInode() === inode || targets.some((target) => isRunning(target)))
  ) {
    await delay(50);
  }
  if (listenerInode() === inode || targets.some((target) => isRunning(target))) {
    throw new Error("orphaned shared app-server authority did not stop");
  }

  if (!unchangedLock(lock) || !ownerIsDead(lock.ownerPid, lock.ownerStartTime)) {
    throw new Error("shared app-server lock changed before orphan cleanup");
  }
  if (unchangedSocket(socket)) fs.unlinkSync(socketPath);
  if (unchangedLock(lock)) fs.unlinkSync(lockPath);

  console.error(
    `Stopped orphaned shared app-server authority: ${targets
      .map((target) => target.pid)
      .join(", ")}`,
  );
}

reapOrphan().catch((error) => {
  console.error(`Shared app-server orphan cleanup refused: ${error.message}`);
  process.exitCode = 1;
});
