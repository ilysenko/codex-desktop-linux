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
  for (const params of [
    {max_nodes:0}, {max_nodes:2001}, {max_depth:-1}, {max_depth:65},
    {max_width:0}, {max_height:4097}, {max_bytes:1023}, {max_bytes:4194305},
    {scale:0}, {scale:1.1}, {format:'webp'}, {quality:0}, {quality:96},
  ]) {
    const method = Object.keys(params)[0].startsWith('max_n') || Object.hasOwn(params, 'max_depth') ? 'get_app_state' : 'screenshot';
    await assert.rejects(handleRpc({method, app:'editor', params}), /Invalid native/);
  }
});

const { mkdtemp, writeFile, readFile, rm } = require('node:fs/promises');
const { tmpdir } = require('node:os');
const { join } = require('node:path');
async function fixture(t, { windowId, structured = false, capture = false, captureError = false, captureMalformed } = {}) {
  const dir = await mkdtemp(join(tmpdir(), 'native-mcp-'));
  const script = join(dir, 'backend.cjs');
  const log = join(dir, 'requests.jsonl');
  await writeFile(script, `
const readline = require('node:readline');
let initialized = false, focused = false;
readline.createInterface({ input: process.stdin }).on('line', line => {
  const r = JSON.parse(line);
  const reply = result => process.stdout.write(JSON.stringify({jsonrpc:'2.0',id:r.id,result})+'\\n');
  if(r.method === 'initialize') return reply({protocolVersion:'2024-11-05',capabilities:{tools:{}},serverInfo:{name:'fixture',version:'1'}});
  if(r.method === 'notifications/initialized') { initialized=true; return; }
  if(!initialized) process.exit(9);
  const {name,arguments:a} = r.params;
  require('node:fs').appendFileSync(${JSON.stringify(log)}, line+'\\n');
  if (${capture}) {
    if(name === 'get_app_state') return reply({content:[{type:'text',text:JSON.stringify({accessibility_tree:[{name:'Document'}],window_context:{focused},...(a.include_screenshot ? {screenshot_error:'requested window is not focused'} : {})})}]});
    if(name === 'screenshot') {
      if(${captureError}) return reply({isError:true,content:[{type:'text',text:'requested window could not be focused exactly'}]});
      focused = true;
      return reply({content:[{type:'image',mimeType:'image/png',data:'AQID'},{type:'text',text:JSON.stringify({width:100,height:50,coordinate_width:200,coordinate_height:100,cropped_to_window:${captureMalformed !== 'uncropped'},scale:0.5})}].filter(item => !(${captureMalformed === 'missing-image'} && item.type === 'image'))});
    }
    return reply({isError:true,content:[{type:'text',text:'unexpected operation'}]});
  }
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
  return { ...service, readCalls: async () => (await readFile(log, 'utf8')).trim().split('\n').map(line => JSON.parse(line, (key, value, context) => key === 'window_id' ? context.source : value).params) };
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

test('trusted service forwards bounded observation options exactly', async t => {
  const stateService = await fixture(t);
  const state = await stateService.handleRpc({method:'get_app_state',app:'editor',params:{include_screenshot:true,max_nodes:20,max_depth:5,max_width:800,max_height:600,max_bytes:65536,scale:0.5,format:'jpeg',quality:70}});
  assert.deepEqual(state.arguments, {include_screenshot:true,max_nodes:20,max_depth:5,max_width:800,max_height:600,max_bytes:65536,scale:0.5,format:'jpeg',quality:70,app_id:'editor'});

  const captureService = await fixture(t, {capture:true});
  await captureService.handleRpc({method:'screenshot',app:'editor',params:{max_width:800,max_height:600,max_bytes:65536,scale:0.5,format:'jpeg',quality:70}});
  const calls = await captureService.readCalls();
  assert.deepEqual(calls.at(-1).arguments, {max_width:800,max_height:600,max_bytes:65536,scale:0.5,format:'jpeg',quality:70,app_id:'editor'});
});

test('native client compacts and suppresses repeated large accessibility observations', async () => {
  const { installLinuxComputerUse } = await import('./native-client.mjs');
  const original = globalThis.nodeRepl;
  const calls = [], writes = [];
  const tree = Array.from({length:237}, (_, index) => ({
    index,
    parent_index:index ? index - 1 : null,
    depth:index,
    object_ref:`:1.234/org/a11y/atspi/accessible/${'metadata'.repeat(8)}/${index}`,
    role:index === 236 ? 'button' : 'section',
    name:index === 236 ? 'Save' : null,
    description:null,
    child_count:index === 236 ? 0 : 1,
    bounds:index === 236 ? {x:40,y:50,width:80,height:30} : null,
    states:['enabled','sensitive','showing','visible','focusable',...(index === 236 ? ['focused','selected'] : [])],
    actions:[{index:0,name:index === 236 ? 'click' : '',description:'',keybinding:''}],
    value:null,
    text:{character_count:1,caret_offset:0,content:' \uFFFC ',truncated:false,selections:[]},
    supports_editable_text:true,
  }));
  let response = {accessibility_tree:tree,window_context:{focused:true}};
  globalThis.nodeRepl = {
    write:value=>writes.push(value),
    rpc:async (_, request)=>{calls.push(request); return response;},
  };
  try {
    const app = await installLinuxComputerUse({}).getApp('editor');
    const initial = writes.find(value => typeof value === 'string' && value.startsWith('{'));
    const compact = JSON.parse(initial);
    const button = compact.accessibility_tree.at(-1);
    assert.ok(initial.length < JSON.stringify(response).length / 2);
    assert.equal(button.index,236);
    assert.equal(button.parent_index,235);
    assert.deepEqual(button.bounds,{x:40,y:50,width:80,height:30});
    assert.equal(button.states,'enabled sensitive showing visible focusable focused selected');
    assert.deepEqual(button.actions,['click']);
    assert.equal(button.actionable,true);
    assert.equal(button.editable,true);
    assert.equal(button.object_ref,undefined);
    assert.equal(button.text.content,undefined);

    const repeated = JSON.parse(await app.getAXState({emit:false,maxNodes:20,maxDepth:5}));
    assert.deepEqual(repeated,{accessibility_tree_unchanged:true});
    assert.deepEqual(calls.at(-1).params,{include_screenshot:false,max_nodes:20,max_depth:5});

    const refreshed = JSON.parse(await app.getAXState({emit:false,disableDiffing:true,max_nodes:21,max_depth:6}));
    assert.equal(refreshed.accessibility_tree.length,237);
    assert.deepEqual(calls.at(-1).params,{include_screenshot:false,max_nodes:21,max_depth:6});

    const full = JSON.parse(await app.getAXState({emit:false,compact:false}));
    assert.match(full.accessibility_tree[0].object_ref,/org\/a11y/);

    response = {...response,accessibility_tree:tree.map((node,index) => index === 236
      ? {...node,states:node.states.filter(state => state !== 'enabled' && state !== 'showing')}
      : node)};
    const disabled = JSON.parse(await app.getAXState({emit:false}));
    assert.doesNotMatch(disabled.accessibility_tree.at(-1).states,/enabled|showing/);

    response = {...response,window_context:{focused:false}};
    const changed = JSON.parse(await app.getAXState({emit:false}));
    assert.equal(changed.window_context.focused,false);
    await assert.rejects(app.getAXState({maxNodes:20,max_nodes:21}),/Conflicting maxNodes/);
  } finally { globalThis.nodeRepl=original; }
});

test('native client routes screenshot limits separately from accessibility limits', async () => {
  const { installLinuxComputerUse } = await import('./native-client.mjs');
  const original = globalThis.nodeRepl;
  const calls = [];
  globalThis.nodeRepl = {
    write(){},
    emitImage:async()=>{},
    rpc:async (_, request) => {
      calls.push(request);
      return request.method === 'screenshot'
        ? {screenshot:{data_url:'data:image/png;base64,AQID',width:100,height:50,coordinate_width:100,coordinate_height:50}}
        : {accessibility_tree:[]};
    },
  };
  try {
    const app = await installLinuxComputerUse({}).getApp('editor');
    await app.getAXStateAndScreenshot({
      emit:false, disableDiffing:true, maxNodes:40, maxDepth:7,
      maxWidth:800, maxHeight:600, maxBytes:65536, scale:0.5, format:'jpeg', quality:70,
    });
    const [capture, state] = calls.slice(-2);
    assert.deepEqual(capture.params,{max_width:800,max_height:600,max_bytes:65536,scale:0.5,format:'jpeg',quality:70});
    assert.deepEqual(state.params,{include_screenshot:false,max_nodes:40,max_depth:7});
  } finally { globalThis.nodeRepl=original; }
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
    const observed=await app.getAXStateAndScreenshot({emit:false,disableDiffing:true});
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

for (const api of ['getScreenshot', 'getAXStateAndScreenshot']) {
  test(`${api} captures a background exact u64 target through client and service`, async t => {
    const service = await fixture(t, { capture: true });
    const { installLinuxComputerUse } = await import('./native-client.mjs');
    const original = globalThis.nodeRepl;
    const images = [], writes = [];
    globalThis.nodeRepl = { write: value => writes.push(value), emitImage: async value => images.push(value), rpc: (_, request) => service.handleRpc(request) };
    try {
      const app = await installLinuxComputerUse({}).getApp('linux-window:18446744073709551615');
      assert.equal(JSON.parse(await app.getAXState({emit:false,disableDiffing:true})).window_context.focused, false);
      const result = await app[api](api === 'getAXStateAndScreenshot' ? {disableDiffing:true} : {});
      assert.deepEqual([...(api === 'getScreenshot' ? result : result.screenshot)], [1,2,3]);
      assert.deepEqual(images, ['data:image/png;base64,AQID']);
      assert.deepEqual(writes.find(value => value?.screenshot)?.screenshot, {width:100,height:50,coordinate_width:200,coordinate_height:100});
      if (api === 'getAXStateAndScreenshot') {
        const state = JSON.parse(result.state);
        assert.equal(state.window_context.focused, true);
        assert.deepEqual(state.accessibility_tree, [{name:'Document'}]);
        assert.equal(state.screenshot.coordinate_width, 200);
      }
      const calls = await service.readCalls();
      assert.equal(calls.filter(call => call.name === 'screenshot').length, 1);
      assert.ok(calls.every(call => call.arguments.window_id === '18446744073709551615'));
      assert.ok(calls.filter(call => call.name === 'get_app_state').every(call => call.arguments.include_screenshot === false));
    } finally { globalThis.nodeRepl = original; }
  });

  test(`${api} exposes failed exact activation without capture fallback or replay`, async t => {
    const service = await fixture(t, {capture:true, captureError:true});
    const { installLinuxComputerUse } = await import('./native-client.mjs');
    const original = globalThis.nodeRepl;
    globalThis.nodeRepl = {write(){}, emitImage: async () => assert.fail('failed capture emitted an image'), rpc: (_, request) => service.handleRpc(request)};
    try {
      const app = await installLinuxComputerUse({}).getApp('editor');
      if(api === 'getScreenshot') await assert.rejects(app[api]({emit:false}), /could not be focused exactly/);
      else {
        const result = await app[api]({emit:false});
        assert.match(JSON.parse(result.state).screenshot_error, /could not be focused exactly/);
        assert.equal(result.screenshot, undefined);
      }
      const calls = await service.readCalls();
      assert.equal(calls.filter(call => call.name === 'screenshot').length, 1);
      assert.ok(calls.every(call => call.arguments.app_id === 'editor'));
      assert.ok(calls.every(call => call.name === 'screenshot' || (call.name === 'get_app_state' && call.arguments.include_screenshot === false)));
    } finally { globalThis.nodeRepl = original; }
  });
}

test('screenshot service requires a target and rejects desktop or focus overrides before launch', async t => {
  const { createNativeService } = await import('./native-service.mjs');
  const service = createNativeService({command:'/nonexistent/native-backend'});
  t.after(() => service.shutdown());
  await assert.rejects(service.handleRpc({method:'screenshot'}), /app id is required/);
  for (const params of [{full_screen:true}, {raise_window:false}, {window_id:22}]) {
    await assert.rejects(service.handleRpc({method:'screenshot',app:'editor',params}), /parameter/);
  }
});

for (const captureMalformed of ['missing-image', 'uncropped']) {
  test(`screenshot service rejects ${captureMalformed} backend capture`, async t => {
    const service = await fixture(t, {capture:true, captureMalformed});
    await assert.rejects(service.handleRpc({method:'screenshot',app:'editor'}), /targeted screenshot/);
  });
}
