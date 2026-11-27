"use strict";

const { EventEmitter } = require("node:events");
const { PassThrough, Writable } = require("node:stream");
let port;
let disconnected = false;
let nextId = 0;
const pending = new Map();
let readyResolve;
const ready = new Promise((resolve) => { readyResolve = resolve; });

function accept(event) {
  if (port || event.ports?.length !== 1) throw Error("Invalid app-server bridge port");
  port = event.ports[0];
  port.on("message", ({ data }) => {
    const child = pending.get(data?.id);
    if (child) child.receive(data);
  });
  port.on("close", () => {
    disconnected = true;
    for (const child of pending.values()) child.disconnect();
    pending.clear();
  });
  port.start();
  readyResolve();
}

class RemoteChild extends EventEmitter {
  constructor(id) {
    super();
    this.id = id;
    this.pid = undefined;
    this.exitCode = null;
    this.signalCode = null;
    this.killed = false;
    this.stdout = new PassThrough();
    this.stderr = new PassThrough();
    this.callbacks = new Map();
    this.sequence = 0;
    this.stdin = new Writable({
      write: (data, _encoding, callback) => {
        if (disconnected) return callback(Error("App-server bridge disconnected"));
        const seq = ++this.sequence;
        this.callbacks.set(seq, callback);
        port.postMessage({ id, type: "stdin", seq, data });
      },
      final: (callback) => {
        if (disconnected) return callback(Error("App-server bridge disconnected"));
        port.postMessage({ id, type: "stdin-end" }); callback();
      },
    });
    // Error events can precede upstream's listener registration during the
    // asynchronous spawn handshake. The error is also returned to the caller.
    this.spawned = new Promise((resolve, reject) => { this.resolveSpawn = resolve; this.rejectSpawn = reject; });
  }
  receive(message) {
    const { id } = this;
    switch (message.type) {
      case "spawned":
        this.pid = message.pid;
        this.resolveSpawn(this);
        break;
      case "spawn-error":
        pending.delete(id);
        this.rejectSpawn(Error(message.message));
        this.stdout.end(); this.stderr.end();
        break;
      case "data": {
        const stream = this[message.stream];
        if (stream !== this.stdout && stream !== this.stderr) break;
        const resume = () => port.postMessage({ id, type: "resume", stream: message.stream });
        if (stream.write(Buffer.from(message.data))) resume();
        else stream.once("drain", resume);
        break;
      }
      case "end":
        if (message.stream === "stdout" || message.stream === "stderr") this[message.stream].end();
        break;
      case "stdin-ack": {
        const callback = this.callbacks.get(message.seq);
        this.callbacks.delete(message.seq);
        if (callback) callback(message.error ? Error(message.error) : null);
        break;
      }
      case "stream-error":
        if (["stdin", "stdout", "stderr"].includes(message.stream)) this[message.stream].destroy(Error(message.message));
        break;
      case "error": this.emit("error", Error(message.message)); break;
      case "exit":
        pending.delete(id);
        this.exitCode = message.code;
        this.signalCode = message.signal;
        this.emit("exit", message.code, message.signal);
        break;
    }
  }
  disconnect() {
    const error = Error("App-server bridge disconnected");
    if (this.pid == null) this.rejectSpawn(error);
    else this.emit("error", error);
    for (const callback of this.callbacks.values()) callback(error);
    this.callbacks.clear();
    this.stdout.end(); this.stderr.end();
    if (this.pid != null) this.emit("exit", null, "SIGTERM");
  }
  kill() {
    if (disconnected || this.killed || this.exitCode != null || this.signalCode != null) return false;
    this.killed = true;
    port.postMessage({ id: this.id, type: "kill" });
    return true;
  }
}

async function spawn(command, args, options) {
  // A missing or rejected bridge must never silently fall back to the utility
  // child, because that would reintroduce the restriction without explanation.
  let timer;
  try {
    await Promise.race([ready, new Promise((_, reject) => {
      timer = setTimeout(() => reject(Error("App-server bridge did not start")), 10000);
      timer.unref?.();
    })]);
  } finally { clearTimeout(timer); }
  if (disconnected) throw Error("App-server bridge disconnected");
  const child = new RemoteChild(++nextId);
  pending.set(child.id, child);
  // Upstream resolves an omitted cwd in the utility process, not in its
  // parent. Preserve that behavior even if the two processes have diverged.
  port.postMessage({ id: child.id, type: "spawn", command, args, env: options.env, cwd: options.cwd ?? process.cwd() });
  return child.spawned;
}

module.exports = { accept, spawn };
