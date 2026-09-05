const test = require('node:test');
const assert = require('node:assert/strict');

test('native client preserves browser inventory and binds native actions to selected app', async () => {
  const { installLinuxComputerUse } = await import('./native-client.mjs');
  const calls = [];
  const original = globalThis.nodeRepl;
  globalThis.nodeRepl = { write() {}, rpc: async (service, request) => {
    calls.push([service, request]);
    if (request.method === 'list_apps') return [{ id: 'org.example.Editor', isRunning: true }];
    if (request.method === 'get_app_state') return { accessibility_tree: [{ name: 'Document' }] };
    return { ok: true };
  }};
  try {
    const cua = { getState: async () => ({ apps: [], browsers: [{ id: 'iab' }] }) };
    installLinuxComputerUse(cua);
    assert.deepEqual(await cua.getState({ emit: false }), { apps: [{ id: 'org.example.Editor', isRunning: true }], browsers: [{ id: 'iab' }] });
    const app = await cua.getApp('org.example.Editor');
    await app.click([2, 3]);
    assert.deepEqual(calls.at(-1), ['sky', { method: 'click', app: 'org.example.Editor', params: { x: 2, y: 3, button: 'left', click_count: 1, relative: true } }]);
    const before = calls.length;
    await assert.rejects(app.drag({ x: 1, y: 2 }, { x: 3, y: 4 }), /not supported/);
    await assert.rejects(app.paste('x', { format: 'html' }), /not supported/);
    assert.equal(calls.length, before);
  } finally { globalThis.nodeRepl = original; }
});

test('trusted service validates requests before backend launch', async () => {
  const { handleRpc } = await import('./native-service.mjs');
  await assert.rejects(handleRpc({ method: 'drag', app: 'editor', params: {} }), /not supported/);
  await assert.rejects(handleRpc({ method: 'click', app: 'editor', params: { window_id: 22 } }), /parameter/);
});

const { mkdtemp, writeFile, rm } = require('node:fs/promises');
const { tmpdir } = require('node:os');
const { join } = require('node:path');
async function fixture(t, { windowId, structured = false } = {}) {
  const dir = await mkdtemp(join(tmpdir(), 'native-mcp-'));
  const script = join(dir, 'backend.cjs');
  await writeFile(script, `
const readline = require('node:readline');
let initialized = false;
readline.createInterface({ input: process.stdin }).on('line', line => {
  const r = JSON.parse(line);
  const reply = result => process.stdout.write(JSON.stringify({jsonrpc:'2.0',id:r.id,result})+'\\n');
  if(r.method === 'initialize') return reply({protocolVersion:'2024-11-05',capabilities:{tools:{}},serverInfo:{name:'fixture',version:'1'}});
  if(r.method === 'notifications/initialized') { initialized=true; return; }
  if(!initialized) process.exit(9);
  const {name,arguments:a} = r.params;
  if(a.text === 'exit') process.exit(7);
  if(a.text === 'tool-error') return reply({isError:true,content:[{type:'text',text:'denied by backend'}]});
  if(a.window_id === 99) return reply({structuredContent:{window_error:'window no longer exists',accessibility_tree:[]},content:[]});
  if(a.text === 'malformed') return process.stdout.write('garbage\\n');
  if(a.text === 'hang') return;
  if(a.text === 'action-error') return reply({structuredContent:{ok:false,message:'focus changed'},content:[]});
  const windowId = ${JSON.stringify(windowId ?? null)};
  if(windowId !== null) {
    // Construct numeric tokens from strings so the fixture cannot round them.
    const raw = name === 'list_windows'
      ? '{"windows":[{"window_id":'+windowId+',"title":"Document","app_id":"editor","focused":true}]}'
      : '{"ok":true,"window_id":'+windowId+',"received":'+JSON.stringify(line)+'}';
    if(${structured}) return process.stdout.write('{"jsonrpc":"2.0","id":'+r.id+',"result":{"structuredContent":'+raw+'}}'+'\\n');
    return reply({content:[{type:'text',text:raw}]});
  }
  let data = name === 'list_windows' ? {windows:[{window_id:22,title:'Document',app_id:'editor',focused:true}]} : {ok:true,name,arguments:a};
  reply({content:[{type:'text',text:JSON.stringify(data)}]});
});
`);
  const { createNativeService } = await import('./native-service.mjs');
  const service = createNativeService({ command: process.execPath, args: [script], timeoutMs: 1000 });
  t.after(async () => { service.shutdown(); await rm(dir, {recursive:true,force:true}); });
  return service;
}

test('MCP initialization, exact window IDs, targeted inputs and desktop inputs', async t => {
  const service = await fixture(t);
  assert.deepEqual(await service.handleRpc({method:'list_apps'}), [{id:'linux-window:22',displayName:'editor',title:'Document',isRunning:true,focused:true}]);
  const result = await service.handleRpc({method:'click',app:'linux-window:22',params:{x:2,y:3,relative:true}});
  assert.deepEqual(result.arguments, {x:2,y:3,relative:true,window_id:22});
  const zero = await service.handleRpc({method:'click',app:'linux-window:0',params:{x:2,y:3}});
  assert.equal(zero.arguments.window_id, 0);
  const desktop = await service.handleRpc({method:'press_key',params:{key:'ESC'}});
  assert.deepEqual(desktop.arguments, {key:'ESC'});
});

for (const structured of [false, true]) {
  for (const windowId of ['1017417960236020624', '18446744073709551615']) {
    test(`u64 window IDs round trip exactly through ${structured ? 'structuredContent' : 'text JSON'}: ${windowId}`, async t => {
      const service = await fixture(t, { windowId, structured });
      const apps = await service.handleRpc({ method: 'list_apps' });
      assert.equal(apps[0].id, `linux-window:${windowId}`);
      const result = await service.handleRpc({ method: 'click', app: apps[0].id, params: { x: 2, y: 3 } });
      // Match the wire token, not JSON.parse's rounded interpretation of it.
      assert.match(result.received, new RegExp(`"window_id":${windowId}(?=[,}])`));
      assert.equal(result.window_id, windowId);
      assert.deepEqual(JSON.parse(JSON.stringify(result)), result);
      assert.deepEqual(structuredClone(result), result);
    });
  }
}

test('invalid and out-of-range window IDs are rejected before backend dispatch', async t => {
  const { createNativeService } = await import('./native-service.mjs');
  const service = createNativeService({ command: '/nonexistent/native-backend' });
  t.after(() => service.shutdown());
  for (const id of ['', '-1', '1.5', '1e3', ' 22', '+22', '18446744073709551616']) {
    await assert.rejects(service.handleRpc({ method: 'click', app: `linux-window:${id}`, params: { x: 2, y: 3 } }), /Invalid native window id/);
  }
});

test('backend errors surface and an exited backend is never silently replayed or restarted', async t => {
  const service = await fixture(t);
  await assert.rejects(service.handleRpc({method:'type_text',params:{text:'tool-error'}}), /denied by backend/);
  await assert.rejects(service.handleRpc({method:'type_text',params:{text:'action-error'}}), /focus changed/);
  await assert.rejects(service.handleRpc({method:'type_text',params:{text:'exit'}}), /exited/);
  await assert.rejects(service.handleRpc({method:'list_apps'}), /exited/);
});

test('missing targets, shutdown and malformed protocol fail without replay', async t => {
  const service = await fixture(t);
  await assert.rejects(service.handleRpc({method:'get_app_state',app:'linux-window:99'}), /window no longer exists/);
  await assert.rejects(service.handleRpc({method:'type_text',params:{text:'malformed'}}), /invalid JSON/);
  await assert.rejects(service.handleRpc({method:'list_apps'}), /invalid JSON/);
  const stopped = await fixture(t);
  stopped.shutdown();
  await assert.rejects(stopped.handleRpc({method:'list_apps'}), /shut down/);
});

test('timed-out input poisons the transport rather than allowing replay', async t => {
  const service = await fixture(t);
  await assert.rejects(service.handleRpc({method:'type_text',params:{text:'hang'}}), /timed out/);
  await assert.rejects(service.handleRpc({method:'list_apps'}), /timed out/);
});

test('native observations return image bytes and expose screenshot errors and coordinate space', async () => {
  const { installLinuxComputerUse } = await import('./native-client.mjs');
  const original = globalThis.nodeRepl;
  const images = [];
  const window = { x: 300, y: 200, width: 200, height: 100 };
  const tree = [{name:'Button',bounds:{x:350,y:250,width:20,height:10}}];
  let response = {accessibility_tree:tree,window_context:window,screenshot:{data_url:'data:image/png;base64,AQID',width:100,height:50,coordinate_width:200,coordinate_height:100}};
  globalThis.nodeRepl = {write(){},emitImage:async value=>images.push(value),rpc:async()=>response};
  try {
    const app=await installLinuxComputerUse({}).getApp('linux-window:22');
    const observed=await app.getAXStateAndScreenshot({emit:false});
    assert.deepEqual([...observed.screenshot],[1,2,3]);
    const state = JSON.parse(observed.state);
    assert.deepEqual(state.accessibility_tree, tree);
    assert.deepEqual(state.window_context, window);
    assert.equal(state.coordinates.accessibility_bounds, 'screen');
    assert.match(state.coordinates.input, /window-relative/);
    assert.match(state.coordinates.guidance, /Do not pass accessibility bounds directly/);
    assert.equal(images.length,0);
    await app.getScreenshot();
    assert.equal(images.length,1);
    response={accessibility_tree:[],screenshot_error:'capture unavailable'};
    await assert.rejects(app.getScreenshot(),/capture unavailable/);
    assert.match((await app.getAXStateAndScreenshot({emit:false})).state,/capture unavailable/);
    await assert.rejects(async()=>app.click(3),/element-index.*not supported/);
  } finally { globalThis.nodeRepl=original; }
});
