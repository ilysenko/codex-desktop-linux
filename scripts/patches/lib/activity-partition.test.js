"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const { Script } = require("node:vm");
const { inspectActivityPartition } = require("./activity-partition.js");
const { findWebviewAssetsContaining } = require("./assets.js");

const fixture = fs.readFileSync(path.join(__dirname, "fixtures/current-activity-partition.js"), "utf8");
const invocation = "({unit:g,hasFollowingFinalAnswer:t<u,keepMcpAppEntriesPersistent:a,mcpServerStatuses:i,renderMcpApps:s})";

function assertRanges(source, owner) {
  assert.equal(owner.ok, true, owner.reason);
  assert.equal(source.slice(owner.expression.start, owner.expression.end), owner.expression.source);
  assert.equal(source.slice(owner.nativeExpression.start, owner.nativeExpression.end), owner.nativeExpression.source);
  assert.equal(source.slice(owner.call.start, owner.call.end), owner.call.source);
  assert.ok(owner.partition.start < owner.loop.start);
  assert.ok(owner.loop.start < owner.classifier.start && owner.classifier.end < owner.loop.end);
  assert.ok(owner.loop.end < owner.partition.end);
  assert.equal(source[owner.classifier.end - 1], "}");
  assert.equal(owner.names.render, "i");
  assert.equal(owner.partition.bindings.render, "s");
  assert.equal(owner.call.unit, "g");
}

test("current activity snapshot proves native expression, partition, loop and explicit caller ranges", () => {
  const owner = inspectActivityPartition(fixture);
  assertRanges(fixture, owner);
  assert.equal(owner.expression.source, owner.nativeExpression.source);
  assert.ok(owner.nativeExpression.source.includes('n&&i&&"mcp-tool-call"===s.type'));
  assert.ok(owner.nativeExpression.source.includes('"accepted"===s.steeringStatus&&null==s.questionReplies'));
  assert.equal(inspectActivityPartition(fixture).nativeExpression.source, owner.nativeExpression.source);
});

test("activity snapshot leaves surrounding expression policy to its consumers", () => {
  const original = inspectActivityPartition(fixture);
  const expression = `false||(${original.nativeExpression.source})`;
  const source = fixture.slice(0, original.expression.start) + expression + fixture.slice(original.expression.end);
  const owner = inspectActivityPartition(source);
  assertRanges(source, owner);
  assert.equal(owner.expression.source, expression);
  assert.equal(owner.nativeExpression.source, original.nativeExpression.source);
});

test("activity snapshot refuses retired, quoted, duplicated, changed and disconnected native roles", () => {
  const outsideLoop = fixture.replace('r.push(g),n&&u>=0&&t>u||function', 'r.push(g)};{let g={},t=0;void function');
  for (const source of [
    null, "const unrelated=true;", fixture + fixture, `const decoy=\`${fixture}\`;`, outsideLoop,
    fixture.replace("renderMcpApps:i})", "unknownRendering:i})"),
    fixture.replace('n&&i&&"mcp-tool-call"', 'n&&wrong&&"mcp-tool-call"'),
    fixture.replace("mcpServerStatuses:i,renderMcpApps:s})", "mcpServerStatuses:wrong,renderMcpApps:s})"),
    fixture.replace("hasFollowingFinalAnswer:t<u,", "hasFollowingFinalAnswer:t<wrong,"),
    fixture.replace("mcpServerStatuses:a", "mcpServerStatuses:wrong"),
    fixture.replace("server:e.invocation.server", "server:wrong.invocation.server"),
    fixture.replace('"not-sent"===s.deliveryStatus', '"queued"===s.deliveryStatus'),
    fixture.replace("null==s.questionReplies", "null==wrong.questionReplies"),
    fixture.replace("!s.isHistoricalSteering", "!wrong.isHistoricalSteering"),
  ]) {
    assert.notEqual(source, fixture);
    assert.equal(inspectActivityPartition(source).ok, false);
  }
});

test("latest signed activity resource contains the exact current fixture and source ranges", {
  skip: !process.env.CODEX_SIGNED_EXTRACTED_APP,
}, () => {
  const root = process.env.CODEX_SIGNED_EXTRACTED_APP;
  const names = findWebviewAssetsContaining(root, ["collapsibleUnits:", "persistentUnits:", "keepMcpAppEntriesPersistent:"]);
  assert.equal(names.length, 1);
  const source = fs.readFileSync(path.join(root, "webview/assets", names[0]), "utf8");
  const partition = fixture.slice("const partition=".length).trim().slice(0, -1);
  assert.ok(source.includes(partition));
  assertRanges(source, inspectActivityPartition(source));
});

test("activity predicate requires the current ordinary function token and direct invocation", () => {
  for (const header of [
    "async function({unit:e,", "async/*gap*/function({unit:e,", "async\tfunction({unit:e,",
    "async /* gap */ function({unit:e,", "async function\n({unit:e,", "async/*gap*/function\n({unit:e,",
    "function*({unit:e,", "async function*({unit:e,", "new function({unit:e,",
  ]) {
    const source = fixture.replace("function({unit:e,", header);
    assert.notEqual(source, fixture);
    assert.doesNotThrow(() => new Script(source), header);
    assert.equal(inspectActivityPartition(source).ok, false, header);
  }
  const called = fixture.replace("}" + invocation, "}.call(null," + invocation.slice(1));
  const sequence = fixture.replace("||function({unit:e,", "||(0,function({unit:e,")
    .replace("}" + invocation, "})" + invocation);
  for (const source of [called, sequence]) {
    assert.doesNotThrow(() => new Script(source));
    assert.equal(inspectActivityPartition(source).ok, false);
  }
  const ordinary = fixture.replace("||function({unit:e,", "|| /* ordinary gap\n */ function({unit:e,");
  assert.doesNotThrow(() => new Script(ordinary));
  assertRanges(ordinary, inspectActivityPartition(ordinary));
});

test("activity snapshot proves native result collections and rejects marker-string decoys", () => {
  const original = inspectActivityPartition(fixture);
  assert.equal(fixture.slice(original.result.start, original.result.end), original.result.source);
  assert.equal(fixture.slice(original.routing.start, original.routing.end), original.routing.source);
  assert.deepEqual(original.result.bindings, { collapsible: "l", expanded: "r", persistent: "o", preToggle: "c", workedFor: "d" });
  const missing = fixture.replace("collapsibleUnits:", "missingCollapsible:").replace("persistentUnits:", "missingPersistent:");
  const decoy = missing.slice(0, original.loop.start) + 'const note="collapsibleUnits:persistentUnits:";' + missing.slice(original.loop.start);
  for (const source of [missing, decoy, fixture.replace("persistentUnits:o", "persistentUnits:l"),
    fixture.replace("?o.push(g):l.push(g)", "?l.push(g):o.push(g)")]) {
    assert.notEqual(source, fixture);
    assert.doesNotThrow(() => new Script(source));
    assert.equal(inspectActivityPartition(source).ok, false);
  }
});

test("current activity partition binds progress, MCP rendering and every explicit caller option", () => {
  for (const source of [
    fixture.replace("n&&u>=0&&t>u||", "wrong&&u>=0&&t>u||"),
    fixture.replace("unit:g,hasFollowingFinalAnswer:", "unit:wrong,hasFollowingFinalAnswer:"),
    fixture.replace("keepMcpAppEntriesPersistent:a,mcpServerStatuses:i", "keepMcpAppEntriesPersistent:wrong,mcpServerStatuses:i"),
    fixture.replace("mcpServerStatuses:i,renderMcpApps:s})", "mcpServerStatuses:i,renderMcpApps:wrong})"),
  ]) {
    assert.notEqual(source, fixture);
    assert.equal(inspectActivityPartition(source).ok, false);
  }
});
