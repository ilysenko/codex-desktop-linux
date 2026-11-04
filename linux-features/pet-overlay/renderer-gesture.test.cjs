"use strict";
const assert = require("node:assert/strict");
const fs = require("node:fs");
const vm = require("node:vm");
const test = require("node:test");
const { applyPetOverlayGestureRendererPatch } = require("./patch.js");
const fixture = fs.readFileSync(require.resolve("./fixtures/native-renderer-gesture.js"), "utf8");
const scenario = require("./fixtures/renderer-gesture.cjs");

test("real renderer callbacks do not open a conversation when Wayland screen coordinates stay fixed during a drag", async () => {
  const k = scenario(); k.down(); await k.up();
  assert.equal(k.calls.length, 1);
  assert.equal(k.calls[0][0], k.messages[0].payload.codexPetOverlayGestureId);
  assert.equal(k.clicks.length, 0);
  assert.deepEqual(k.messages.map(m => m.type), ["avatar-overlay-drag-start"]);
});

test("an ordinary native mascot click waits for the acknowledgement and runs once", async () => {
  let release;
  const k = scenario({ complete: () => new Promise(resolve => { release = resolve; }) });
  k.down(); const done = k.up();
  assert.equal(k.clicks.length, 0);
  release(false); await done; assert.equal(k.clicks.length, 1);
});

for (const response of ["rejected", "malformed", "cancelled"]) test(`a ${response} native release cannot run the click action`, async () => {
  const k = scenario({ complete: async () => { if (response === "rejected") throw Error("bridge unavailable"); return response === "malformed" ? null : false; } });
  k.down(); await k.up(response !== "cancelled");
  assert.equal(k.clicks.length, 0);
  assert.equal(k.warnings.length, response === "cancelled" ? 0 : 1);
});

test("late completion of a previous gesture leaves the new renderer gesture intact", async () => {
  let reject;
  const k = scenario({ complete: () => new Promise((_resolve, fail) => { reject = fail; }) });
  k.down(); const old = k.up(); k.down(); const current = k.context.rA.current;
  reject(Error("stale gesture")); await old;
  assert.equal(k.context.rA.current, current);
  assert.notEqual(k.messages[0].payload.codexPetOverlayGestureId, current.codexPetOverlayGestureId);
  assert.equal(k.clicks.length, 0);
  assert.deepEqual(k.messages.map(m => m.type), ["avatar-overlay-drag-start", "avatar-overlay-drag-start"]);
});

test("other compositor paths keep synchronous click and release handling", async () => {
  const k = scenario({ native: false }); k.down(); const done = k.up();
  assert.equal(k.calls.length, 0);
  assert.equal(k.clicks.length, 1);
  assert.deepEqual(k.messages.map(m => m.type), ["avatar-overlay-drag-start", "avatar-overlay-drag-end"]);
  await done;
});

test("other compositor paths retain the release-only move before ending the gesture", async () => {
  const k = scenario({ native: false }); k.down();
  k.event.screenX += 30; k.event.clientX += 30;
  await k.up();
  assert.equal(k.calls.length, 0);
  assert.equal(k.clicks.length, 0);
  assert.deepEqual(k.messages.map(m => m.type), ["avatar-overlay-drag-start", "avatar-overlay-drag-move", "avatar-overlay-drag-end"]);
});

test("already moving fallback retains its end sample without adding a synthetic move", async () => {
  const k = scenario({ complete: async () => false }); k.down();
  k.context.rA.current.hasMoved = true;
  k.event.screenX = 230; k.event.clientX = 204;
  await k.up();
  assert.deepEqual({ ...k.calls[0][2] }, { pointerScreenX: 230, pointerScreenY: 100,
    shouldMove: false, pointerWindowX: 204, pointerWindowY: 74 });
  assert.equal(k.clicks.length, 0);
  assert.deepEqual(k.messages.map(m => m.type), ["avatar-overlay-drag-start"]);
});

test("gesture patch accepts renamed identifiers and rejects missing or ambiguous anchors", () => {
  const renamed = fixture.replace(/\b(?:rU|eC|rA|G|tW)\b/g, id => `$${id}`);
  const patchedRenamed = applyPetOverlayGestureRendererPatch(renamed);
  assert.doesNotThrow(() => new vm.Script(patchedRenamed));
  assert.match(patchedRenamed, /\$tW\.appServices\.avatarOverlay,/);
  assert.match(patchedRenamed, /s\.codexPetOverlayGestureId==null&&\$G\.O1\.dispatchMessage\("avatar-overlay-drag-end",/);
  for (const anchor of ["beganOnQuickChatBar:", "let{hasMoved:", "avatar-overlay-drag-start", ".setQuickChatStashed(null)"])
    assert.throws(() => applyPetOverlayGestureRendererPatch(fixture.replaceAll(anchor, "drifted")));
  assert.throws(() => applyPetOverlayGestureRendererPatch(fixture + fixture));
});
