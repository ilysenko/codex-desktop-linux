"use strict";
const assert = require("node:assert/strict");
const test = require("node:test");
const { prepareRemoteConnectionsVisibility } = require("./remote-connections-visibility.js");
const { fixtureSources, snapshots } = require("./visibility.test-helpers.js");

test("native grammar and harmless code spaces retain the same qualified cohort", () => {
  assert.equal(prepareRemoteConnectionsVisibility(snapshots()).alreadyApplied, false);
  const sources = fixtureSources();
  sources["async/state-0.js"] = sources["async/state-0.js"]
    .replace('if(n.isLoading)return"loading";', 'if(n.isLoading)\treturn"loading";')
    .replace(';let h=', '; let h=')
    .replace('var r=', 'var\t r=');
  assert.equal(prepareRemoteConnectionsVisibility(snapshots(sources)).alreadyApplied, false);
});

test("opaque literal whitespace is data, not code trivia", () => {
  const sources = fixtureSources();
  sources["async/state-0.js"] = sources["async/state-0.js"].replace('return"loading"', 'return"load ing"');
  assert.throws(() => prepareRemoteConnectionsVisibility(snapshots(sources)), /changed state owner grammar/);
});

test("a code line terminator after return cannot erase an ASI behavior change", () => {
  const sources = fixtureSources();
  sources["async/state-0.js"] = sources["async/state-0.js"].replace('return"loading"', 'return\n"loading"');
  assert.throws(() => prepareRemoteConnectionsVisibility(snapshots(sources)), /changed state owner grammar/);
});

test("a fused keyword and identifier is not native token spacing", () => {
  const sources = fixtureSources();
  sources["async/state-0.js"] = sources["async/state-0.js"].replace('typeof i', 'typeofi');
  assert.throws(() => prepareRemoteConnectionsVisibility(snapshots(sources)), /changed state owner grammar/);
});
