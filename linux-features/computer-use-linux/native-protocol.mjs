export const maxBridgeMessageBytes = 8 * 1024 * 1024;

const parameters = {
  list_apps: [],
  get_app_state: ['include_screenshot', 'max_nodes', 'max_depth', 'max_width', 'max_height', 'max_bytes', 'scale', 'format', 'quality'],
  screenshot: ['max_width', 'max_height', 'max_bytes', 'scale', 'format', 'quality'],
  click: ['x', 'y', 'button', 'click_count', 'relative'],
  scroll: ['x', 'y', 'direction', 'pages', 'relative'],
  press_key: ['key'],
  type_text: ['text'],
};

function validateParameters(params) {
  const integer = (name, minimum, maximum) => {
    if (params[name] !== undefined && (!Number.isInteger(params[name]) || params[name] < minimum || params[name] > maximum)) {
      throw new Error(`Invalid native ${name} parameter`);
    }
  };
  if (params.include_screenshot !== undefined && typeof params.include_screenshot !== 'boolean') throw new Error('Invalid native include_screenshot parameter');
  integer('max_nodes', 1, 2000);
  integer('max_depth', 0, 64);
  integer('max_width', 1, 4096);
  integer('max_height', 1, 4096);
  integer('max_bytes', 1024, 4 * 1024 * 1024);
  integer('quality', 1, 95);
  if (params.scale !== undefined && (typeof params.scale !== 'number' || !Number.isFinite(params.scale) || params.scale <= 0 || params.scale > 1)) throw new Error('Invalid native scale parameter');
  if (params.format !== undefined && !['png', 'jpeg'].includes(params.format)) throw new Error('Invalid native format parameter');
}

export function validateNativeRequest(input) {
  const { method, app, params = {} } = input ?? {};
  if (!Object.hasOwn(parameters, method)) throw new Error('This native Linux Computer Use operation is not supported');
  if (!params || typeof params !== 'object' || Array.isArray(params) || Object.keys(params).some(key => !parameters[method].includes(key))) throw new Error('Unsupported native operation parameter');
  validateParameters(params);
  if (method === 'screenshot' && app === undefined) throw new Error('A non-empty native app id is required');
  if (app !== undefined) {
    if (typeof app !== 'string' || !app.trim()) throw new Error('A non-empty native app id is required');
    if (app.startsWith('linux-window:')) {
      const id = app.slice('linux-window:'.length);
      if (!/^\d+$/.test(id) || BigInt(id) > 18446744073709551615n) throw new Error('Invalid native window id');
    }
  }
  return { method, app, params };
}

export function nativeTarget(app) {
  if (app === undefined) return {};
  if (app.startsWith('linux-window:')) {
    const id = app.slice('linux-window:'.length);
    return { window_id: JSON.rawJSON(BigInt(id).toString()) };
  }
  return { app_id: app };
}
