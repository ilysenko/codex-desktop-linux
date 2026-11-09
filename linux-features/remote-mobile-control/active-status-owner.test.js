"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");
const data = require("./active-status-contracts.json");
const { prepareActiveIndicatorSource } = require("./active-status-owner.js");
const { createIndicatorHarness } = require("./active-status-harness.js");

const PRESENTATION = Object.freeze({
  active: { label: "Subscribed: active", style: "bg-chart-green" },
  follower: { label: "Subscribed: follower", style: "bg-chart-purple" },
  inactive: { label: "Subscribed: idle", style: "bg-chart-yellow" },
  "needs-resume": { label: "Needs resume", style: "bg-chart-red" },
  "read-only": { label: "Read-only snapshot", style: "bg-chart-orange" },
});

function patchedHarness(initialStates = {}) {
  const prepared = prepareActiveIndicatorSource(data.indicator);
  return createIndicatorHarness({ indicatorSource: prepared.patchedSource, initialStates });
}

function expectedClassification(state) {
  if (state.streamRole?.role === "follower") return "follower";
  if (state.threadRuntimeStatus?.type === "active" || state.latestTurnStatus === "inProgress") return "active";
  if (state.streamRole == null) return state.resumeState === "needs_resume" ? "needs-resume" : "read-only";
  return "inactive";
}

function assertPresentation(harness, frame, state, className) {
  const expected = PRESENTATION[state];
  assert.equal(frame.output.type, harness.Tooltip);
  assert.equal(frame.output.props.content, expected.label);
  const outer = frame.output.props.children;
  assert.equal(outer.type, "span");
  assert.equal(outer.props["aria-label"], expected.label);
  assert.equal(outer.props.className, ["flex size-3 items-center justify-center", className].filter(Boolean).join(" "));
  assert.equal(outer.props.children.type, "span");
  assert.equal(outer.props.children.props.className, "block size-2 rounded-full " + expected.style);
  assert.deepEqual(frame.memoSizes, [13]);
}

function assertSelectorReads(frame, conversationId) {
  assert.deepEqual(frame.hooks.map(row => row.atom), ["nX", "hf", "F9", "VY"]);
  assert.deepEqual(frame.hooks.map(row => row.conversationId), Array(4).fill(conversationId));
}

test("the finite indicator source repeats canonically and restores its exact native source", () => {
  const first = prepareActiveIndicatorSource(data.indicator);
  assert.equal(first.state, "native");
  assert.equal(first.nativeSource, data.indicator);
  assert.equal(Buffer.byteLength(first.patchedSource) - Buffer.byteLength(data.indicator), 39);
  const repeated = prepareActiveIndicatorSource(first.patchedSource);
  assert.equal(repeated.state, "patched");
  assert.equal(repeated.patchedSource, first.patchedSource);
  assert.equal(repeated.nativeSource, data.indicator);
});

test("all 600 native, null and future-valued status combinations keep the expected presentation", () => {
  const harness = patchedHarness();
  const latestStatuses = [undefined, null, "inProgress", "completed", "failed", "future-status"];
  const resumes = [undefined, null, "needs_resume", "resumed"];
  const roles = [undefined, null, { role: "follower" }, { role: "leader" }, { role: "future-role" }];
  const runtimes = [undefined, null, { type: "active" }, { type: "idle" }, { type: "future-runtime" }];
  let cases = 0;
  for (const latestTurnStatus of latestStatuses) {
    for (const resumeState of resumes) {
      for (const streamRole of roles) {
        for (const threadRuntimeStatus of runtimes) {
          const state = { latestTurnStatus, resumeState, streamRole, threadRuntimeStatus };
          harness.setState("selected-thread", state);
          const frame = harness.render("selected-thread", "custom-indicator");
          assertPresentation(harness, frame, expectedClassification(state), "custom-indicator");
          assertSelectorReads(frame, "selected-thread");
          cases++;
        }
      }
    }
  }
  assert.equal(cases, 600);
  assert.deepEqual(harness.effects, { stateWrites: [], preferences: [], requests: [] });
});

test("mobile-started active runtime is presented before a stream role is assigned", () => {
  const state = { latestTurnStatus: "completed", resumeState: "needs_resume", streamRole: null, threadRuntimeStatus: { type: "active" } };
  const native = createIndicatorHarness({ indicatorSource: data.indicator, initialStates: { thread: state } });
  const patched = patchedHarness({ thread: state });
  assertPresentation(native, native.render("thread"), "needs-resume");
  const frame = patched.render("thread");
  assertPresentation(patched, frame, "active");
  assertSelectorReads(frame, "thread");
});

test("follower precedence avoids reading the active runtime classifier branch", () => {
  let roleReads = 0, runtimeTypeReads = 0;
  const streamRole = { get role() { roleReads++; return "follower"; } };
  const threadRuntimeStatus = { get type() { runtimeTypeReads++; throw Error("follower runtime branch must stay deferred"); } };
  const harness = patchedHarness({ thread: { streamRole, threadRuntimeStatus, latestTurnStatus: "inProgress", resumeState: "needs_resume" } });
  const frame = harness.render("thread");
  assertPresentation(harness, frame, "follower");
  assertSelectorReads(frame, "thread");
  assert.equal(roleReads, 1);
  assert.equal(runtimeTypeReads, 0);
});

test("compiler memo reuse preserves labels, styles and supplied class names across state updates", () => {
  const harness = patchedHarness({ thread: { streamRole: null, resumeState: "resumed" } });
  const first = harness.render("thread", "first-class");
  assertPresentation(harness, first, "read-only", "first-class");
  assert.equal(first.jsxCalls.length, 3);
  assert.equal(first.classNameCalls.length, 2);
  const second = harness.render("thread", "first-class");
  assert.equal(second.output, first.output);
  assert.equal(second.jsxCalls.length, 0);
  assert.equal(second.classNameCalls.length, 0);
  assertSelectorReads(second, "thread");
  const renamed = harness.render("thread", "second-class");
  assertPresentation(harness, renamed, "read-only", "second-class");
  assert.notEqual(renamed.output, second.output);
  assert.equal(renamed.output.props.children.props.children, second.output.props.children.props.children);
  assert.equal(renamed.classNameCalls.length, 1);
  harness.setState("thread", { streamRole: null, threadRuntimeStatus: { type: "active" }, resumeState: "resumed" });
  const active = harness.render("thread", "second-class");
  assertPresentation(harness, active, "active", "second-class");
  assertSelectorReads(active, "thread");
  assert.equal(active.jsxCalls.length, 3);
});

test("terminal, recovery, cleared-input and resume transitions follow the selected runtime state", () => {
  const harness = patchedHarness();
  const steps = [
    [{ latestTurnStatus: "inProgress", resumeState: "needs_resume", streamRole: undefined }, "active"],
    [{ latestTurnStatus: "completed", resumeState: "needs_resume", streamRole: null, threadRuntimeStatus: { type: "active" } }, "active"],
    [{ latestTurnStatus: "completed", resumeState: "needs_resume", streamRole: null, threadRuntimeStatus: { type: "idle" } }, "needs-resume"],
    [{ latestTurnStatus: "completed", resumeState: "resumed", streamRole: null, threadRuntimeStatus: { type: "idle" } }, "read-only"],
    [{ latestTurnStatus: "completed", resumeState: "resumed", streamRole: { role: "leader" }, threadRuntimeStatus: { type: "idle" } }, "inactive"],
    [{ latestTurnStatus: "inProgress", resumeState: "needs_resume", streamRole: { role: "follower" }, threadRuntimeStatus: { type: "active" } }, "follower"],
    [{ latestTurnStatus: "failed", resumeState: "resumed", streamRole: { role: "leader" }, threadRuntimeStatus: { type: "errored" } }, "inactive"],
    [{ latestTurnStatus: undefined, resumeState: "resumed", streamRole: undefined, threadRuntimeStatus: { type: "active" } }, "active"],
    [{ latestTurnStatus: null, resumeState: "resumed", streamRole: undefined, threadRuntimeStatus: { type: "notLoaded" } }, "read-only"],
  ];
  for (const [state, expected] of steps) {
    harness.setState("thread", state);
    const frame = harness.render("thread");
    assertPresentation(harness, frame, expected);
    assertSelectorReads(frame, "thread");
  }
  assert.deepEqual(harness.effects, { stateWrites: [], preferences: [], requests: [] });
});

test("unrelated conversation updates preserve selected output and each render reads its supplied key", () => {
  const harness = patchedHarness({
    selected: { streamRole: null, latestTurnStatus: "inProgress" },
    unrelated: { streamRole: { role: "follower" }, threadRuntimeStatus: { type: "active" } },
  });
  const selected = harness.render("selected", "selected-class");
  assertPresentation(harness, selected, "active", "selected-class");
  harness.setState("unrelated", { streamRole: null, resumeState: "needs_resume" });
  const selectedAgain = harness.render("selected", "selected-class");
  assert.equal(selectedAgain.output, selected.output);
  assertSelectorReads(selectedAgain, "selected");
  const other = harness.render("unrelated", "other-class");
  assertPresentation(harness, other, "needs-resume", "other-class");
  assertSelectorReads(other, "unrelated");
  const restored = harness.render("selected", "selected-class");
  assertPresentation(harness, restored, "active", "selected-class");
  assertSelectorReads(restored, "selected");
});

test("a separately supplied host-store scope with the same conversation ID stays independent", () => {
  const selectedStore = patchedHarness({ sameId: { streamRole: null, resumeState: "resumed" } });
  const otherStore = patchedHarness({ sameId: { streamRole: null, latestTurnStatus: "inProgress" } });
  const selected = selectedStore.render("sameId");
  assertPresentation(selectedStore, selected, "read-only");
  otherStore.setState("sameId", { streamRole: { role: "follower" }, threadRuntimeStatus: { type: "active" } });
  const selectedAgain = selectedStore.render("sameId");
  assert.equal(selectedAgain.output, selected.output);
  assertSelectorReads(selectedAgain, "sameId");
  assert.equal(otherStore.hooks.length, 0);
  assertPresentation(otherStore, otherStore.render("sameId"), "follower");
  assert.deepEqual(selectedStore.effects, { stateWrites: [], preferences: [], requests: [] });
});
