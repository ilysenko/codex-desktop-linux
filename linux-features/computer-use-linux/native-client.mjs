// Installed after the upstream CUA factory; browser ownership remains upstream.
export function installLinuxComputerUse(cua) {
  const runtime = globalThis.nodeRepl;
  if (typeof runtime?.rpc !== 'function') throw new Error('Linux Computer Use requires trusted nodeRepl RPC');
  const call = (method, app, params = {}) => runtime.rpc('sky', { method, ...(app === undefined ? {} : { app }), params });
  const emit = (value, options) => { if (options?.emit !== false) runtime.write(value); return value; };
  const option = (options, camel, snake) => {
    const camelSet = Object.hasOwn(options, camel);
    const snakeSet = Object.hasOwn(options, snake);
    if (camelSet && snakeSet && options[camel] !== options[snake]) throw new Error(`Conflicting ${camel} and ${snake} options`);
    return camelSet ? options[camel] : options[snake];
  };
  const backendOptions = (options, entries) => Object.fromEntries(entries.flatMap(([camel, snake]) => {
    const value = option(options, camel, snake);
    return value === undefined ? [] : [[snake, value]];
  }));
  const axBackendOptions = options => backendOptions(options, [['maxNodes', 'max_nodes'], ['maxDepth', 'max_depth']]);
  const screenshotBackendOptions = options => backendOptions(options, [
    ['maxWidth', 'max_width'], ['maxHeight', 'max_height'], ['maxBytes', 'max_bytes'],
    ['scale', 'scale'], ['format', 'format'], ['quality', 'quality'],
  ]);
  const meaningful = value => typeof value === 'string' ? value.replaceAll('\uFFFC', '').trim() || undefined : undefined;
  const compactNode = node => {
    const states = Array.isArray(node.states) ? node.states.map(meaningful).filter(Boolean) : [];
    const actionNames = Array.isArray(node.actions) ? node.actions.map(action => meaningful(action?.name)).filter(Boolean) : [];
    const textContent = meaningful(node.text?.content);
    const text = node.text && {
      ...(Number.isInteger(node.text.character_count) && node.text.character_count > 0 ? { character_count: node.text.character_count } : {}),
      ...(Number.isInteger(node.text.caret_offset) && node.text.caret_offset >= 0 ? { caret_offset: node.text.caret_offset } : {}),
      ...(textContent ? { content: textContent } : {}),
      ...(node.text.truncated ? { truncated: true } : {}),
      ...(Array.isArray(node.text.selections) && node.text.selections.length ? { selections: node.text.selections } : {}),
    };
    return {
      index: node.index,
      ...(node.parent_index === null || node.parent_index === undefined ? {} : { parent_index: node.parent_index }),
      ...(node.depth ? { depth: node.depth } : {}),
      role: node.role,
      ...(meaningful(node.name) ? { name: meaningful(node.name) } : {}),
      ...(meaningful(node.description) ? { description: meaningful(node.description) } : {}),
      ...(node.child_count > 0 ? { child_count: node.child_count } : {}),
      ...(node.bounds && node.bounds.width > 0 && node.bounds.height > 0 ? { bounds: node.bounds } : {}),
      ...(states.length ? { states: states.join(' ') } : {}),
      ...(Array.isArray(node.actions) && node.actions.length ? { actionable: true } : {}),
      ...(actionNames.length ? { actions: actionNames } : {}),
      ...(node.value ? { value: Object.fromEntries(Object.entries(node.value).filter(([, value]) => value !== null && value !== undefined)) } : {}),
      ...(text && Object.keys(text).length ? { text } : {}),
      ...(node.supports_editable_text ? { editable: true } : {}),
    };
  };
  const browserState = cua.getState?.bind(cua);
  cua.listApps = async (options = {}) => emit(await call('list_apps'), options);
  cua.getState = async (options = {}) => {
    const state = browserState ? await browserState({ emit: false }) : { browsers: [] };
    return emit({ ...state, apps: await cua.listApps({ emit: false }) }, options);
  };
  cua.getApp = async (app) => {
    if (typeof app !== 'string' || !app.trim()) throw new Error('getApp requires a non-empty app id');
    const unsupported = async () => { throw new Error('This native Linux Computer Use operation is not supported'); };
    const state = options => call('get_app_state', app, { include_screenshot: false, ...axBackendOptions(options) });
    let previousAccessibilityState;
    const screenshotMetadata = (result) => result.screenshot ? {
      width: result.screenshot.width, height: result.screenshot.height,
      coordinate_width: result.screenshot.coordinate_width,
      coordinate_height: result.screenshot.coordinate_height,
    } : undefined;
    const axText = (result, options) => {
      const compactTree = Array.isArray(result.accessibility_tree) ? result.accessibility_tree.map(compactNode) : [];
      const accessibilityState = {
        accessibility_tree: compactTree,
        window_context: result.window_context,
        accessibility_error: result.accessibility_error,
        window_error: result.window_error,
      };
      const signature = JSON.stringify(accessibilityState);
      const unchanged = options?.disableDiffing !== true && options?.compact !== false && signature === previousAccessibilityState;
      previousAccessibilityState = signature;
      if (unchanged) return JSON.stringify({
        accessibility_tree_unchanged: true,
        screenshot_error: result.screenshot_error,
        screenshot: screenshotMetadata(result),
      });
      return JSON.stringify({
        accessibility_tree: options?.compact === false ? result.accessibility_tree : compactTree,
        window_context: result.window_context,
        coordinates: { accessibility_bounds: 'screen', input: 'window-relative screenshot capture coordinates', guidance: 'Do not pass accessibility bounds directly to click or scroll; display scaling can differ. Use screenshot coordinate_width and coordinate_height.' },
        accessibility_error: result.accessibility_error,
        window_error: result.window_error,
        screenshot_error: result.screenshot_error,
        screenshot: screenshotMetadata(result),
      });
    };
    const screenshot = async (result, options) => {
      const url = result.screenshot?.data_url;
      if (!url) throw new Error(result.screenshot_error || 'Native app screenshot is unavailable');
      if (options?.emit !== false) {
        runtime.write({ screenshot: screenshotMetadata(result), coordinates: 'window-relative; use coordinate_width and coordinate_height, not resized image dimensions' });
        await runtime.emitImage(url);
      }
      return Uint8Array.from(atob(url.slice(url.indexOf(',') + 1)), c => c.charCodeAt(0));
    };
    const point = (target) => {
      if (typeof target === 'number') throw new Error('Linux element-index actions are not supported; use window-relative [x,y] coordinates');
      if (!Array.isArray(target) || target.length !== 2 || !target.every(Number.isInteger)) throw new Error('Linux native input requires integer window-relative coordinates');
      return { x: target[0], y: target[1] };
    };
    const target = {
      getAXState: async (options = {}) => emit(axText(await state(options), options), options),
      getScreenshot: async (options = {}) => screenshot(await call('screenshot', app, screenshotBackendOptions(options)), options),
      getAXStateAndScreenshot: async (options = {}) => {
        // Capture raises the target first, so the passive AX observation sees
        // its resulting window state. Failed capture is reported, never retried.
        let capture;
        try { capture = await call('screenshot', app, screenshotBackendOptions(options)); }
        catch (error) { capture = { screenshot_error: error.message }; }
        const result = { ...await state(options), ...capture };
        return { state: emit(axText(result, options), options), ...(result.screenshot ? { screenshot: await screenshot(result, options) } : {}) };
      },
      click: (location, options = {}) => call('click', app, { ...point(location), button: options.mouseButton ?? 'left', click_count: options.clickCount ?? 1, relative: true }),
      pressKey: key => call('press_key', app, { key }),
      typeText: text => call('type_text', app, { text }),
      scroll: (location, direction, pages = 1) => call('scroll', app, { ...point(location), direction, pages, relative: true }),
      paste: async (text, options = {}) => {
        if (options.format && options.format !== 'text') return unsupported();
        return call('type_text', app, { text });
      },
      drag: unsupported, selectText: unsupported, setValue: unsupported, performSecondaryAction: unsupported,
    };
    emit('Linux native app APIs: getAXState({disableDiffing?,compact?,maxNodes?,maxDepth?}), getScreenshot({maxWidth?,maxHeight?,maxBytes?,scale?,format?,quality?}), getAXStateAndScreenshot() with both option sets, click([x,y], {mouseButton?,clickCount?}), pressKey(key), typeText(text), scroll([x,y], direction, pages?), paste(text). AX state is compact and unchanged compact projections are suppressed by default; pass disableDiffing:true for a fresh compact tree or compact:false for full backend node metadata. Screenshot APIs bring the selected window forward and emit images themselves; getAXState() remains passive. Click/scroll coordinates are window-relative in the reported screenshot coordinate_width/coordinate_height space; screenshots may be downscaled. Accessibility bounds are screen coordinates and must not be passed directly to click/scroll; display scaling can differ. Native window_context is retained for geometry inspection. Element-index actions, drag, rich paste, selectText, setValue, and secondary actions are unsupported. Input uses the Linux backend and may require OS permissions.');
    await target.getAXState();
    return target;
  };
  return cua;
}
