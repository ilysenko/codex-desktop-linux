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
  assert.equal(owner.partition.bindings.options, "s");
  assert.equal(owner.call.unit, "n");
}

test("current activity snapshot proves native expression, partition, loop and complete caller ranges", () => {
  const owner = inspectActivityPartition(fixture);
  assertRanges(fixture, owner);
  assert.equal(owner.expression.source, owner.nativeExpression.source);
  assert.ok(owner.nativeExpression.source.includes('"async"===i.delivery&&null!=i.searchItemId&&s?.has(i.searchItemId)===!0'));
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
  const outsideLoop = fixture.replace('l.push(n),n===f||a&&h>=0&&t>h||function', 'l.push(n)};{let n={},t=0;void function');
  for (const source of [
    null, "const unrelated=true;", fixture + fixture, `const decoy=\`${fixture}\`;`, outsideLoop,
    fixture.replace("plainAsyncMessageIds:s}", "unknownAsync:s}"),
    fixture.replace("s?.has(i.searchItemId)", "wrong?.has(i.searchItemId)"),
    fixture.replace("}(n,t<h,s)", "}(n,t<h,wrong)"),
    fixture.replace("}(n,t<h,s)", "}(n,t<wrong,s)"),
    fixture.replace("mcpServerStatuses:a", "mcpServerStatuses:wrong"),
    fixture.replace("server:e.invocation.server", "server:wrong.invocation.server"),
    fixture.replace('"not-sent"===i.deliveryStatus', '"queued"===i.deliveryStatus'),
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
    "async function(e,t,{",
    "async/*gap*/function(e,t,{",
    "async\tfunction(e,t,{",
    "async /* gap */ function(e,t,{",
    "async function\n(e,t,{",
    "async/*gap*/function\n(e,t,{",
    "function*(e,t,{",
    "async function*(e,t,{",
    "new function(e,t,{",
  ]) {
    const source = fixture.replace("function(e,t,{", header);
    assert.notEqual(source, fixture);
    assert.doesNotThrow(() => new Script(source), header);
    assert.equal(inspectActivityPartition(source).ok, false, header);
  }
  const called = fixture.replace("}(n,t<h,s)", "}.call(null,n,t<h,s)");
  const sequence = fixture.replace("||function(e,t,{", "||(0,function(e,t,{")
    .replace("}(n,t<h,s)", "})(n,t<h,s)");
  for (const source of [called, sequence]) {
    assert.doesNotThrow(() => new Script(source));
    assert.equal(inspectActivityPartition(source).ok, false);
  }
  const ordinary = fixture.replace("||function(e,t,{", "|| /* ordinary gap\n */ function(e,t,{");
  assert.doesNotThrow(() => new Script(ordinary));
  assertRanges(ordinary, inspectActivityPartition(ordinary));
});

test("activity snapshot proves native result collections and rejects marker-string decoys", () => {
  const original = inspectActivityPartition(fixture);
  assert.equal(fixture.slice(original.result.start, original.result.end), original.result.source);
  assert.equal(fixture.slice(original.routing.start, original.routing.end), original.routing.source);
  assert.deepEqual(original.result.bindings, { collapsible: "i", expanded: "l", persistent: "r", preToggle: "m", workedFor: "p" });
  const missing = fixture.replace("collapsibleUnits:", "missingCollapsible:").replace("persistentUnits:", "missingPersistent:");
  const decoy = missing.slice(0, original.loop.start) + 'const note="collapsibleUnits:persistentUnits:";' + missing.slice(original.loop.start);
  for (const source of [missing, decoy, fixture.replace("persistentUnits:r", "persistentUnits:i"),
    fixture.replace("?r.push(n):i.push(n)", "?i.push(n):r.push(n)")]) {
    assert.notEqual(source, fixture);
    assert.doesNotThrow(() => new (require("node:vm").Script)(source));
    assert.equal(inspectActivityPartition(source).ok, false);
  }
});

test("current activity partition binds keep-first-reply and in-progress options to its loop", () => {
  for (const source of [
    fixture.replace("f=n&&h<0?", "f=wrong&&h<0?"),
    fixture.replace("n===f||a&&h>=0&&t>h||", "n===wrong||a&&h>=0&&t>h||"),
    fixture.replace("n===f||a&&h>=0&&t>h||", "n===f||wrong&&h>=0&&t>h||"),
    fixture.replace("...s}={})", "...wrong}={})"),
  ]) {
    assert.notEqual(source, fixture);
    assert.equal(inspectActivityPartition(source).ok, false);
  }
});
