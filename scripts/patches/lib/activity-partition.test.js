"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const { inspectActivityPartition } = require("./activity-partition.js");
const { findWebviewAssetsContaining } = require("./assets.js");

const fixture = fs.readFileSync(path.join(__dirname, "fixtures/current-activity-partition.js"), "utf8");

function assertRanges(source, owner) {
  assert.equal(owner.ok, true, owner.reason);
  assert.equal(source.slice(owner.expression.start, owner.expression.end), owner.expression.source);
  assert.equal(source.slice(owner.nativeExpression.start, owner.nativeExpression.end), owner.nativeExpression.source);
  assert.equal(source.slice(owner.call.start, owner.call.end), owner.call.source);
  assert.ok(owner.partition.start < owner.loop.start);
  assert.ok(owner.loop.start < owner.classifier.start && owner.classifier.end < owner.loop.end);
  assert.ok(owner.loop.end < owner.partition.end);
  assert.equal(source[owner.classifier.end - 1], "}");
  assert.equal(owner.names.plainAsync, "s");
  assert.equal(owner.partition.bindings.plainAsync, "i");
  assert.equal(owner.call.unit, "x");
}

test("current activity snapshot proves native expression, partition, loop and complete caller ranges", () => {
  const owner = inspectActivityPartition(fixture);
  assertRanges(fixture, owner);
  assert.equal(owner.expression.source, owner.nativeExpression.source);
  assert.ok(owner.nativeExpression.source.includes('"async"===l.delivery&&null!=l.searchItemId&&s?.has(l.searchItemId)===!0'));
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
  const outsideLoop = fixture.replace('r.push(x),n&&g>=0&&t>g||function', 'r.push(x)};{let x={},t=0;void function');
  for (const source of [
    null, "const unrelated=true;", fixture + fixture, `const decoy=\`${fixture}\`;`, outsideLoop,
    fixture.replace("plainAsyncMessageIds:s,renderMcpApps:i", "renderMcpApps:i"),
    fixture.replace("s?.has(l.searchItemId)", "wrong?.has(l.searchItemId)"),
    fixture.replace("plainAsyncMessageIds:i,renderMcpApps:l})", "plainAsyncMessageIds:wrong,renderMcpApps:l})"),
    fixture.replace("hasFollowingFinalAnswer:t<g", "hasFollowingFinalAnswer:t<wrong"),
    fixture.replace("mcpServerStatuses:a", "mcpServerStatuses:wrong"),
    fixture.replace("server:e.invocation.server", "server:wrong.invocation.server"),
    fixture.replace('"not-sent"===l.deliveryStatus', '"queued"===l.deliveryStatus'),
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
  const { Script } = require("node:vm");
  for (const header of [
    "async function({unit:",
    "async/*gap*/function({unit:",
    "async\tfunction({unit:",
    "async /* gap */ function({unit:",
    "async function\n({unit:",
    "async/*gap*/function\n({unit:",
    "function*({unit:",
    "async function*({unit:",
    "new function({unit:",
  ]) {
    const source = fixture.replace("function({unit:", header);
    assert.notEqual(source, fixture);
    assert.doesNotThrow(() => new Script(source), header);
    assert.equal(inspectActivityPartition(source).ok, false, header);
  }
  const called = fixture.replace("}({unit:x,", "}.call(null,{unit:x,");
  const sequence = fixture.replace("||function({unit:", "||(0,function({unit:")
    .replace("}({unit:x,", "})({unit:x,");
  for (const source of [called, sequence]) {
    assert.doesNotThrow(() => new Script(source));
    assert.equal(inspectActivityPartition(source).ok, false);
  }
  const ordinary = fixture.replace("||function({unit:", "|| /* ordinary gap\n */ function({unit:");
  assert.doesNotThrow(() => new Script(ordinary));
  assertRanges(ordinary, inspectActivityPartition(ordinary));
});
