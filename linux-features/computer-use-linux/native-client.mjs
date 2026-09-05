// Installed after upstream setupCUA; browser ownership remains upstream.
export function installLinuxComputerUse(cua) {
  const runtime = globalThis.nodeRepl;
  if (typeof runtime?.rpc !== 'function') throw new Error('Linux Computer Use requires trusted nodeRepl RPC');
  const call = (method, app, params = {}) => runtime.rpc('sky', { method, ...(app === undefined ? {} : { app }), params });
  const emit = (value, options) => { if (options?.emit !== false) runtime.write(value); return value; };
  const browserState = cua.getState?.bind(cua);
  cua.listApps = async (options = {}) => emit(await call('list_apps'), options);
  cua.getState = async (options = {}) => {
    const state = browserState ? await browserState({ emit: false }) : { browsers: [] };
    return emit({ ...state, apps: await cua.listApps({ emit: false }) }, options);
  };
  cua.getApp = async (app) => {
    if (typeof app !== 'string' || !app.trim()) throw new Error('getApp requires a non-empty app id');
    const unsupported = async () => { throw new Error('This native Linux Computer Use operation is not supported'); };
    const state = (screenshot) => call('get_app_state', app, { include_screenshot: screenshot });
    const screenshotMetadata = (result) => result.screenshot ? {
      width: result.screenshot.width, height: result.screenshot.height,
      coordinate_width: result.screenshot.coordinate_width,
      coordinate_height: result.screenshot.coordinate_height,
    } : undefined;
    const axText = (result) => JSON.stringify({ accessibility_tree: result.accessibility_tree, window_context: result.window_context, coordinates: { accessibility_bounds: 'screen', input: 'window-relative screenshot capture coordinates', guidance: 'Do not pass accessibility bounds directly to click or scroll; display scaling can differ. Use screenshot coordinate_width and coordinate_height.' }, accessibility_error: result.accessibility_error, window_error: result.window_error, screenshot_error: result.screenshot_error, screenshot: screenshotMetadata(result) });
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
      getAXState: async (options = {}) => emit(axText(await state(false)), options),
      getScreenshot: async (options = {}) => screenshot(await state(true), options),
      getAXStateAndScreenshot: async (options = {}) => {
        const result = await state(true);
        return { state: emit(axText(result), options), ...(result.screenshot ? { screenshot: await screenshot(result, options) } : {}) };
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
    emit('Linux native app APIs: getAXState(), getScreenshot(), getAXStateAndScreenshot(), click([x,y], {mouseButton?,clickCount?}), pressKey(key), typeText(text), scroll([x,y], direction, pages?), paste(text). Click/scroll coordinates are window-relative in the reported screenshot coordinate_width/coordinate_height space; screenshots may be downscaled. Accessibility bounds are screen coordinates and must not be passed directly to click/scroll; display scaling can differ. Native window_context is retained for geometry inspection. Element-index actions, drag, rich paste, selectText, setValue, and secondary actions are unsupported. Input uses the Linux backend and may require OS permissions.');
    await target.getAXState();
    return target;
  };
  return cua;
}
