"use strict";

const { setTimeout: delay } = require("node:timers/promises");

// Upstream already publishes the browser's validated ChatGPT request profile
// to accessInputs. Its background catalog fetch otherwise omits that profile
// and inherits the headless Electron host's headers. Keep both history paths
// on the same profile without changing authentication or workspace routing.
async function requestWithBrowserProfile(hostId, options, { readPrincipal, readInputs, fetch }, timeoutMs = 10_000) {
  const signal = AbortSignal.any([options.signal, AbortSignal.timeout(timeoutMs)]);
  for (;;) {
    signal.throwIfAborted();
    const principal = readPrincipal();
    if (!principal || hostId !== `chatgpt:${principal.accountId}:${principal.userId}`) {
      throw new DOMException("Authenticated principal changed", "AbortError");
    }
    const inputs = readInputs({ kind: "chatgpt", ...principal });
    if (inputs) {
      return fetch({
        ...options,
        expectedPrincipal: principal,
        requestProfile: inputs.profile,
        signal: AbortSignal.any([options.signal, inputs.signal]),
      });
    }
    // The renderer publishes its profile shortly after connecting. Wait for
    // it instead of issuing a request with the wrong profile and entering the
    // catalog's five-minute failure backoff. Abort on disconnect/sign-out.
    await delay(50, undefined, { signal });
  }
}

module.exports = { requestWithBrowserProfile };
