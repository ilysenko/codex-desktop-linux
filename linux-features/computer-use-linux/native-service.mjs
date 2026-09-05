import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';

const parameters = {
  list_apps: [],
  get_app_state: ['include_screenshot'],
  click: ['x', 'y', 'button', 'click_count', 'relative'],
  scroll: ['x', 'y', 'direction', 'pages', 'relative'],
  press_key: ['key'],
  type_text: ['text'],
};

// The process owns the Rust backend's state. Failed or interrupted requests are
// never retried: input may already have reached the desktop.
export function createNativeService({
  command = fileURLToPath(new URL('../bin/codex-computer-use-linux', import.meta.url)),
  args = ['mcp'], timeoutMs = 120_000,
} = {}) {
  let child, ready, failure, sequence = 0;
  const pending = new Map();
  function stop(error) {
    failure ??= error;
    for (const { reject, timer } of pending.values()) {
      clearTimeout(timer);
      reject(failure);
    }
    pending.clear();
    child?.kill();
  }
  const shutdown = () => stop(new Error('Linux Computer Use backend shut down'));
  function send(message) {
    child.stdin.write(`${JSON.stringify(message)}\n`, error => { if (error) stop(error); });
  }
  function request(method, params) {
    if (failure) return Promise.reject(failure);
    return new Promise((resolve, reject) => {
      const id = ++sequence;
      const timer = setTimeout(() => stop(new Error(`Linux Computer Use ${method} timed out; not replayed`)), timeoutMs);
      pending.set(id, { resolve, reject, timer });
      send({ jsonrpc: '2.0', id, method, params });
    });
  }
  async function start() {
    if (failure) throw failure;
    if (!ready) ready = (async () => {
      child = spawn(command, args, { stdio: ['pipe', 'pipe', 'pipe'] });
      child.on('error', error => stop(new Error(`Linux Computer Use backend: ${error.message}`)));
      child.on('exit', (code, signal) => stop(new Error(`Linux Computer Use backend exited (${signal ?? code}); not replayed`)));
      child.stdin.on('error', error => stop(error));
      // Drain diagnostics without leaking application text into the RPC channel.
      child.stderr.resume();
      createInterface({ input: child.stdout }).on('line', line => {
        let message;
        try { message = JSON.parse(line); }
        catch { stop(new Error('Linux Computer Use backend returned invalid JSON')); return; }
        const call = pending.get(message.id);
        if (!call) {
          if (message.method && message.id !== undefined) send({ jsonrpc: '2.0', id: message.id, error: { code: -32601, message: 'Client requests are unsupported' } });
          return;
        }
        pending.delete(message.id);
        clearTimeout(call.timer);
        if (message.error) call.reject(new Error(message.error.message || 'Linux Computer Use RPC error'));
        else call.resolve(message.result);
      });
      await request('initialize', { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'linux-unified-computer-use', version: '1' } });
      send({ jsonrpc: '2.0', method: 'notifications/initialized' });
    })();
    await ready;
  }
  async function handleRpc(input) {
    const { method, app, params = {} } = input ?? {};
    if (!Object.hasOwn(parameters, method)) throw new Error('This native Linux Computer Use operation is not supported');
    if (!params || typeof params !== 'object' || Array.isArray(params) || Object.keys(params).some(key => !parameters[method].includes(key))) throw new Error('Unsupported native operation parameter');
    let target = {};
    if (app !== undefined) {
      if (typeof app !== 'string' || !app.trim()) throw new Error('A non-empty native app id is required');
      if (app.startsWith('linux-window:')) {
        const id = app.slice('linux-window:'.length);
        if (!/^\d+$/.test(id) || !Number.isSafeInteger(Number(id))) throw new Error('Invalid native window id');
        target = { window_id: Number(id) };
      } else target = { app_id: app };
    }
    await start();
    const result = await request('tools/call', { name: method === 'list_apps' ? 'list_windows' : method, arguments: { ...params, ...target } });
    const message = result?.content?.filter(item => item.type === 'text').map(item => item.text).join('\n');
    if (result?.isError) throw new Error(message || 'Linux Computer Use tool failed');
    let data = result?.structuredContent;
    if (data === undefined) {
      try { data = JSON.parse(message); }
      catch { throw new Error('Linux Computer Use backend returned no structured result'); }
    }
    if (method === 'get_app_state' && data.window_error) throw new Error(data.window_error);
    if (data.ok === false) throw new Error(data.message || 'Linux Computer Use action failed');
    if (method === 'list_apps') {
      if (data.error) throw new Error(data.error);
      return data.windows.map(window => ({ id: `linux-window:${window.window_id}`, displayName: window.app_id || window.wm_class || window.title || 'Linux app', title: window.title, isRunning: true, focused: window.focused }));
    }
    return data;
  }
  return { handleRpc, shutdown };
}
const service = createNativeService();
export const handleRpc = service.handleRpc;
export const shutdown = service.shutdown;
process.once('exit', shutdown);
