"use strict";
const assert = require("node:assert/strict");
const test = require("node:test");

test("native launcher retains browser and enables only the selected surfaces", async () => {
  const { linuxNativeEnvironment } = await import("./native-launch.mjs");
  const browserOnly = linuxNativeEnvironment({ browser: true, computer: false }, "official browser banner");
  assert.deepEqual(browserOnly, { NODE_REPL_JS_BANNER: "official browser banner" });
  for (const browser of [true, false]) {
    const env = linuxNativeEnvironment({ browser, computer: true }, "unused");
    const services = JSON.parse(env.NODE_REPL_TRUSTED_SERVICES);
    assert.equal(services.browser, browser ? "@oai/browser-desktop/service" : undefined);
    assert.match(services.sky, /\/native-service\.mjs$/);
    let options, installed = false;
    const run = new (Object.getPrototypeOf(async function() {}).constructor)("load", "cua",
      env.NODE_REPL_JS_BANNER.replaceAll("import(", "load("));
    await run(async name => name === "@oai/cua/tinyskyAlt"
      ? { setupCUA: async value => { options = value; } }
      : { installLinuxComputerUse: async () => { installed = true; } }, {});
    assert.deepEqual(options, { browser, computer: false });
    assert.equal(installed, true);
  }
});
