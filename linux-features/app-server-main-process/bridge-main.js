"use strict";

// Only the utility process receives the port. In particular, the app-server and
// sandboxed commands never receive a socket path or a reusable bearer token.
function attach(worker, electron, spawn = require("node:child_process").spawn) {
  const { port1, port2 } = new electron.MessageChannelMain();
  const children = new Map();
  let closed = false;
  function post(message) {
    if (!closed) port1.postMessage(message);
  }
  function cleanup() {
    if (closed) return;
    closed = true;
    for (const entry of children.values()) entry.child.kill();
    children.clear();
    port1.close();
  }
  worker.once("exit", cleanup);
  port1.on("close", cleanup);
  port1.on("message", ({ data: message }) => {
    if (!message || typeof message !== "object" || !Number.isSafeInteger(message.id)) return;
    const { id, type } = message;
    if (type === "spawn") {
      if (children.has(id) || typeof message.command !== "string" || !Array.isArray(message.args) ||
          message.args.some((arg) => typeof arg !== "string") || !message.env || typeof message.env !== "object" ||
          (message.cwd != null && typeof message.cwd !== "string")) {
        post({ id, type: "spawn-error", message: "Invalid app-server launch request" });
        return;
      }
      let child;
      try {
        child = spawn(message.command, message.args, {
          cwd: message.cwd || undefined, env: message.env, stdio: ["pipe", "pipe", "pipe"],
        });
      } catch (error) {
        post({ id, type: "spawn-error", message: error.message });
        return;
      }
      const entry = { child, spawned: false };
      children.set(id, entry);
      child.once("spawn", () => { entry.spawned = true; post({ id, type: "spawned", pid: child.pid }); });
      child.on("error", (error) => post({ id, type: entry.spawned ? "error" : "spawn-error", message: error.message }));
      for (const name of ["stdout", "stderr"]) {
        const stream = child[name];
        stream.on("data", (data) => { stream.pause(); post({ id, type: "data", stream: name, data }); });
        stream.on("end", () => post({ id, type: "end", stream: name }));
        stream.on("error", (error) => post({ id, type: "stream-error", stream: name, message: error.message }));
      }
      child.stdin.on("error", (error) => post({ id, type: "stream-error", stream: "stdin", message: error.message }));
      child.once("close", (code, signal) => { children.delete(id); post({ id, type: "exit", code, signal }); });
      return;
    }
    const entry = children.get(id);
    if (!entry) return;
    if (type === "resume" && (message.stream === "stdout" || message.stream === "stderr")) {
      entry.child[message.stream].resume();
    } else if (type === "stdin" && (message.data instanceof Uint8Array || typeof message.data === "string")) {
      entry.child.stdin.write(message.data, (error) => post({ id, type: "stdin-ack", seq: message.seq, error: error?.message }));
    } else if (type === "stdin-end") {
      entry.child.stdin.end();
    } else if (type === "kill") {
      entry.child.kill("SIGTERM");
    }
  });
  port1.start();
  worker.postMessage({ type: "codex-linux-app-server-bridge" }, [port2]);
  return cleanup;
}

module.exports = { attach };
