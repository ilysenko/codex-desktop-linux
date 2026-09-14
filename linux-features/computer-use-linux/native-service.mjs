import path from 'node:path';
import { maxBridgeMessageBytes, validateNativeRequest } from './native-protocol.mjs';

function defaultConnection() {
  const runtime = globalThis.nodeRepl;
  const socketPath = runtime?.env?.CODEX_LINUX_CUA_HOST_SOCKET;
  if (typeof socketPath !== 'string' || !path.isAbsolute(socketPath)) {
    throw new Error('Linux Computer Use host socket is unavailable');
  }
  if (typeof runtime?.nativePipe?.createConnection !== 'function') {
    throw new Error('Linux Computer Use requires the trusted native pipe bridge');
  }
  return runtime.nativePipe.createConnection(socketPath);
}

// The trusted worker keeps the agent kernel sandboxed and reaches the host-side
// validator through NodeREPL's privileged native-pipe bridge. A failed or timed
// out action poisons this connection and is never replayed.
export function createNativeService({ connect = defaultConnection, timeoutMs = 120_000 } = {}) {
  let connection, ready, failure, sequence = 0, buffered = Buffer.alloc(0);
  const pending = new Map();
  function stop(error) {
    failure ??= error;
    for (const { reject, timer } of pending.values()) {
      clearTimeout(timer);
      reject(failure);
    }
    pending.clear();
    connection?.end();
  }
  const shutdown = () => stop(new Error('Linux Computer Use host bridge shut down'));
  function handleData(chunk) {
    buffered = Buffer.concat([buffered, Buffer.from(chunk)]);
    for (;;) {
      const newline = buffered.indexOf(10);
      if (newline < 0) {
        if (buffered.length > maxBridgeMessageBytes) stop(new Error('Linux Computer Use host bridge response is too large'));
        return;
      }
      if (newline > maxBridgeMessageBytes) {
        stop(new Error('Linux Computer Use host bridge response is too large'));
        return;
      }
      const line = buffered.subarray(0, newline).toString('utf8');
      buffered = buffered.subarray(newline + 1);
      let message;
      try { message = JSON.parse(line); }
      catch { stop(new Error('Linux Computer Use host bridge returned invalid JSON')); return; }
      const call = pending.get(message.id);
      if (!call) continue;
      pending.delete(message.id);
      clearTimeout(call.timer);
      if (typeof message.error === 'string') call.reject(new Error(message.error));
      else call.resolve(message.result);
    }
  }
  async function start() {
    if (failure) throw failure;
    if (!ready) ready = (async () => {
      connection = await connect();
      connection.on('data', handleData);
      connection.on('error', error => stop(new Error(`Linux Computer Use host bridge: ${error.message}`)));
      connection.on('close', () => stop(new Error('Linux Computer Use host bridge closed; not replayed')));
    })();
    await ready;
  }
  async function handleRpc(input) {
    if (input?.type === 'setup') return { target: 'linux', methods: [] };
    validateNativeRequest(input);
    await start();
    if (failure) throw failure;
    return await new Promise((resolve, reject) => {
      const id = ++sequence;
      const message = Buffer.from(`${JSON.stringify({ id, input })}\n`);
      if (message.length > maxBridgeMessageBytes) throw new Error('Linux Computer Use host bridge request is too large');
      const timer = setTimeout(() => stop(new Error(`Linux Computer Use ${input.method} timed out; not replayed`)), timeoutMs);
      pending.set(id, { resolve, reject, timer });
      try { connection.write(message); }
      catch (error) { stop(error); }
    });
  }
  return { handleRpc, shutdown };
}

const service = createNativeService();
export const handleRpc = service.handleRpc;
export const shutdown = service.shutdown;
process.once('exit', shutdown);
