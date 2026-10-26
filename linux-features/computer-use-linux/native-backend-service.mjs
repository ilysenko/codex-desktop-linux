import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';
import { maxBridgeMessageBytes, nativeTarget, validateNativeRequest } from './native-protocol.mjs';

function parseBackendJson(text) {
  return JSON.parse(text, (key, value, context) =>
    key === 'window_id' && typeof value === 'number' && !Number.isSafeInteger(value)
      ? context.source : value);
}

// A large tree comes back as its leading nodes; the backend keeps the whole tree
// cached (and may also spill it to a private file the agent's sandbox cannot read).
// The host pages the rest from that cache with get_tree_page, within the bridge's
// size limit, so the agent gets the whole tree or an explicit partial one. Calls are
// serialized, so no other snapshot replaces the cache between the two.
const treeBudgetMargin = 256 * 1024;

// This host-side process owns the Rust backend. Failed or interrupted requests
// are never retried because input may already have reached the desktop.
export function createNativeBackendService({
  command = fileURLToPath(new URL('../bin/codex-computer-use-linux', import.meta.url)),
  args = ['mcp'], timeoutMs = 120_000, treeBudgetBytes = maxBridgeMessageBytes - treeBudgetMargin,
} = {}) {
  let child, ready, failure, sequence = 0, queue = Promise.resolve();
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
      child.stderr.resume();
      createInterface({ input: child.stdout }).on('line', line => {
        let message;
        try { message = parseBackendJson(line); }
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
  // One call at a time: a later snapshot replaces the spill file an earlier one names.
  function handleRpc(input) {
    const run = queue.then(() => handleOne(input));
    queue = run.catch(() => {});
    return run;
  }
  async function callTool(name, args) {
    const result = await request('tools/call', { name, arguments: args });
    const message = result?.content?.filter(item => item.type === 'text').map(item => item.text).join('\n');
    if (result?.isError) throw new Error(message || 'Linux Computer Use tool failed');
    let data = result?.structuredContent;
    if (data === undefined) {
      try { data = parseBackendJson(message); }
      catch { throw new Error('Linux Computer Use backend returned no structured result'); }
    }
    return { result, data };
  }
  // The whole cached tree, or as much as fits the bridge, marked when it is partial.
  async function wholeTree(data) {
    const { accessibility_tree_spill: _spill, ...rest } = data;
    const nodes = Array.isArray(data.accessibility_tree) ? [...data.accessibility_tree] : [];
    if (!nodes.length) return rest;
    let used = Buffer.byteLength(JSON.stringify(rest));
    let offset = nodes.length, total = nodes.length;
    while (offset !== null && offset !== undefined) {
      const { data: page } = await callTool('get_tree_page', { offset });
      total = Number.isInteger(page.node_count) ? page.node_count : total;
      if (!Array.isArray(page.nodes) || !page.nodes.length) break;
      const size = Buffer.byteLength(JSON.stringify(page.nodes));
      if (used + size > treeBudgetBytes) break;
      nodes.push(...page.nodes);
      used += size;
      offset = page.next_offset;
    }
    const tree = { ...rest, accessibility_tree: nodes };
    if (nodes.length < total) {
      tree.accessibility_tree_truncated = true;
      tree.accessibility_tree_note = `Partial tree: ${nodes.length} of ${total} nodes fit the host bridge. Request a narrower target or a smaller maxNodes for the rest.`;
    }
    return tree;
  }
  async function handleOne(input) {
    const { method, app, params } = validateNativeRequest(input);
    const target = nativeTarget(app);
    await start();
    const { result, data: raw } = await callTool(method === 'list_apps' ? 'list_windows' : method, { ...params, ...target });
    let data = raw;
    if (method === 'get_app_state' && data.window_error) throw new Error(data.window_error);
    if (method === 'get_app_state') data = await wholeTree(data);
    if (data.ok === false) throw new Error(data.message || 'Linux Computer Use action failed');
    if (method === 'screenshot') {
      const images = result?.content?.filter(item => item.type === 'image') ?? [];
      if (data.cropped_to_window !== true || images.length !== 1 || !images[0].data || !/^image\//.test(images[0].mimeType)) {
        throw new Error('Linux Computer Use backend returned no valid targeted screenshot');
      }
      return { screenshot: { ...data, data_url: `data:${images[0].mimeType};base64,${images[0].data}` } };
    }
    if (method === 'list_apps') {
      if (data.error) throw new Error(data.error);
      return data.windows.map(window => ({ id: `linux-window:${window.window_id}`, displayName: window.app_id || window.wm_class || window.title || 'Linux app', title: window.title, isRunning: true, focused: window.focused }));
    }
    return data;
  }
  return { handleRpc, shutdown };
}
